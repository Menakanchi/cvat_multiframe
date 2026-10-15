// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useCallback, useMemo, useEffect, useState, useRef,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Tag from 'antd/lib/tag';
import Input from 'antd/lib/input';
import InputNumber from 'antd/lib/input-number';
import Alert from 'antd/lib/alert';
import Spin from 'antd/lib/spin';
import Select from 'antd/lib/select';
import Checkbox from 'antd/lib/checkbox';
import Modal from 'antd/lib/modal';
import notification from 'antd/lib/notification';
import {
    CloseOutlined,
    LeftOutlined,
    RightOutlined,
    SaveOutlined,
    AppstoreOutlined,
    DeleteOutlined,
    UndoOutlined,
    RedoOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';
import {
    changeFrameAsync,
    saveAnnotationsAsync,
    fetchAnnotationsAsync,
} from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import { clamp } from 'utils/math';
import {
    validateFrameRange,
    getBatchFrames,
    getTotalBatches,
    extractSelectableObjects,
    SelectableObject,
    calculateExpandedFitDimensions,
    resolveObjectByIDAndType,
    getObjectInputKey,
    EMPTY_OBJECT_FILTER,
    ObjectFilterState,
    selectTypeFilter,
    enterIDFilter,
    planAnnotationDeletion,
    executeAnnotationDeletion,
    canUndoDeletionBatch,
    canRedoDeletionBatch,
    DeletionPlan,
    DeletionTarget,
    HistorySnapshot,
} from './multiframe-utils';
import MultiframeTile from './multiframe-tile';

const DEFAULT_BATCH_SIZE = 10;

function describeInterpolationWarnings(plan: DeletionPlan): string {
    return plan.targets
        .filter((target) => target.interpolationWarning)
        .map((target) => {
            const spans = (target.interpolationWarning || []).map(([from, to]) => `#${from}-#${to}`);
            return `${target.key}: frames ${spans.join(', ')}`;
        })
        .join('; ');
}

function describeDeletionTarget(target: DeletionTarget, plan: DeletionPlan): string {
    const serverID = target.serverID !== null ? ` (server ID ${target.serverID})` : '';
    const label = target.label ? ` "${target.label}"` : '';
    const prefix = `${target.key}${serverID} ${target.shapeType}${label}: `;
    if (target.mode === 'delete-shape') {
        return `${prefix}delete on frame #${target.frames[0]}`;
    }
    if (target.mode === 'delete-track') {
        return `${prefix}delete the whole track (it is visible only inside this range)`;
    }
    return `${prefix}hide only in frames #${plan.startFrame}-#${plan.endFrame} ` +
        `(visible on ${target.frames.length} frame(s)); frames outside the range are kept`;
}
const FILTER_MODE_COLORS: Record<ObjectFilterState['mode'], string> = {
    none: 'default',
    type: 'blue',
    id: 'purple',
};

function describeObjectFilter(filter: ObjectFilterState): string {
    if (filter.mode === 'type') return `Filter: Type = ${filter.label}`;
    if (filter.mode === 'id') return `Filter: ID = ${filter.idInput.trim()}`;
    return 'No filter';
}

// Outer border of a zoomed-in-place tile (2.5px on each side), see styles.scss
const ZOOMED_TILE_CHROME = 5;
// Grid padding (2px on each side), see styles.scss
const GRID_PADDING = 4;

interface Props {
    onClose(): void;
    initialStartFrame?: number;
    initialEndFrame?: number;
    initialFrameCount?: number;
}

function MultiframeWorkspaceView(props: Props): JSX.Element {
    const {
        onClose, initialStartFrame, initialEndFrame, initialFrameCount,
    } = props;
    const dispatch = useDispatch();

    const {
        jobInstance,
        currentFrame,
        activatedStateID,
        activatedElementID,
        activeFrameStates,
        frameNumbers,
        jobLabels,
        isSaving,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        activatedStateID: state.annotation.annotations.activatedStateID,
        activatedElementID: state.annotation.annotations.activatedElementID,
        activeFrameStates: state.annotation.annotations.states,
        frameNumbers: state.annotation.job.frameNumbers,
        jobLabels: state.annotation.job.labels,
        isSaving: state.annotation.annotations.saving.uploading,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ?
        frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ?
        frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [rangeStart, setRangeStart] = useState<number>(initialStartFrame ?? jobStartFrame);
    const [rangeEnd, setRangeEnd] = useState<number>(initialEndFrame ?? jobStopFrame);
    const [batchSize, setBatchSize] = useState<number>(
        typeof initialFrameCount === 'number' ? clamp(initialFrameCount, 1, 10) : DEFAULT_BATCH_SIZE,
    );
    const [batchIndex, setBatchIndex] = useState<number>(0);

    const [inputStart, setInputStart] = useState<number | null>(initialStartFrame ?? jobStartFrame);
    const [inputEnd, setInputEnd] = useState<number | null>(initialEndFrame ?? jobStopFrame);

    // Object Selector & Auto-Zoom State
    const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
    // Type mode and ID mode are mutually exclusive: only one of them is active at a time
    const [objectFilter, setObjectFilter] = useState<ObjectFilterState>(EMPTY_OBJECT_FILTER);
    const selectedLabelFilter = objectFilter.label;
    const inputObjectID = objectFilter.idInput;
    const applyObjectFilter = useCallback((next: ObjectFilterState) => {
        setObjectFilter(next);
        setSelectedObjectKey(next.mode === 'id' ? next.idInput.trim() : null);
    }, []);
    const [autoZoomEnabled, setAutoZoomEnabled] = useState<boolean>(true);
    const [autoFollowEnabled, setAutoFollowEnabled] = useState<boolean>(true);
    const [allJobStates, setAllJobStates] = useState<any[]>([]);
    const [initialFetchDone, setInitialFetchDone] = useState<boolean>(false);
    const [zoomedFrame, setZoomedFrame] = useState<number | null>(null);

    const gridRef = useRef<HTMLDivElement | null>(null);

    // Fetch initial annotations for job
    useEffect(() => {
        let isCancelled = false;
        async function fetchInitialAnnotations(): Promise<void> {
            try {
                if (jobInstance) {
                    const states = await jobInstance.annotations.get(currentFrame, true, []);
                    if (!isCancelled && Array.isArray(states)) {
                        setAllJobStates(states);
                    }
                }
            } catch (_e) {
                // Ignore gracefully
            } finally {
                if (!isCancelled) {
                    setInitialFetchDone(true);
                }
            }
        }
        fetchInitialAnnotations();
        return () => {
            isCancelled = true;
        };
    }, [jobInstance, currentFrame]);

    // Handle frame states reported by tiles as batches load
    const handleFrameStatesLoaded = useCallback((_frame: number, loadedStates: any[]) => {
        if (Array.isArray(loadedStates) && loadedStates.length > 0) {
            setAllJobStates((prev) => {
                const existingClientIDs = new Set(prev.map((s: any) => s.clientID));
                const newStates = loadedStates.filter((s: any) => !existingClientIDs.has(s.clientID));
                if (newStates.length === 0) return prev;
                return [...prev, ...newStates];
            });
        }
    }, []);

    // Combined states across fetched and active states
    const combinedStates = useMemo(() => {
        const merged = [...allJobStates];
        if (Array.isArray(activeFrameStates)) {
            const existingIDs = new Set(merged.map((s: any) => s.clientID));
            for (const st of activeFrameStates) {
                if (!existingIDs.has(st.clientID)) {
                    merged.push(st);
                }
            }
        }
        return merged;
    }, [allJobStates, activeFrameStates]);

    // Extract deduplicated selectable objects across known states
    const selectableObjects = useMemo<SelectableObject[]>(() => (
        extractSelectableObjects(combinedStates)
    ), [combinedStates]);

    // Object types for filtering: the job labels (e.g. "mattrai", "matphai").
    // Skeleton sublabels are not listed, landmarks always belong to their parent Skeleton.
    const availableLabels = useMemo<string[]>(() => {
        const names = new Set<string>();
        for (const label of (Array.isArray(jobLabels) ? jobLabels : [])) {
            if (label && typeof label.name === 'string' && label.name) names.add(label.name);
        }
        return Array.from(names);
    }, [jobLabels]);

    // ID mode: the Object ID is resolved on its own, the type is never combined with it
    const idResolution = useMemo(() => (
        resolveObjectByIDAndType(inputObjectID, 'all', combinedStates)
    ), [inputObjectID, combinedStates]);

    // Resolve the active selected object instance (ID mode only)
    const selectedObject = useMemo(() => {
        if (objectFilter.mode !== 'id') return null;
        if (idResolution.status === 'VALID' && idResolution.matchedObject) {
            return idResolution.matchedObject;
        }
        if (selectedObjectKey) {
            const matched = selectableObjects.find((o) => o.key === selectedObjectKey);
            if (matched) return matched.sourceState;
        }
        return null;
    }, [objectFilter.mode, idResolution, selectedObjectKey, selectableObjects]);

    // Type mode: label whose objects are shown in every visible frame
    const typeFilterLabel = objectFilter.mode === 'type' ? objectFilter.label : null;

    // Clear selection if selected object is removed / no longer exists
    useEffect(() => {
        if (initialFetchDone && selectedObjectKey) {
            const exists = selectableObjects.some((o) => o.key === selectedObjectKey);
            if (!exists) {
                setSelectedObjectKey(null);
            }
        }
    }, [initialFetchDone, selectedObjectKey, selectableObjects]);

    // Initialize ID mode from the active canvas selection when no filter is active (once per activation)
    const lastActivationRef = useRef<string>('');
    useEffect(() => {
        const activationKey = `${activatedStateID ?? ''}:${activatedElementID ?? ''}`;
        if (activationKey === lastActivationRef.current) return;
        if (!activatedStateID && !activatedElementID) {
            lastActivationRef.current = activationKey;
            return;
        }
        if (objectFilter.mode === 'none') {
            let match: any = null;
            if (activatedStateID) {
                match = combinedStates.find((o) => o.clientID === activatedStateID);
            }
            if (!match && activatedElementID) {
                match = combinedStates.find((o) => (
                    o && Array.isArray(o.elements) &&
                    o.elements.some((el: any) => el.clientID === activatedElementID)
                ));
            }
            if (match) {
                const { parentID } = match;
                if (parentID !== null && parentID !== undefined) {
                    const parent = combinedStates.find((o) => o.clientID === parentID);
                    if (parent) match = parent;
                }
                lastActivationRef.current = activationKey;
                applyObjectFilter(enterIDFilter(getObjectInputKey(match)));
            }
        } else {
            lastActivationRef.current = activationKey;
        }
    }, [activatedStateID, activatedElementID, combinedStates, objectFilter.mode, applyObjectFilter]);

    // Measure the visible grid area (without scrollbar and padding) for the expanded tile fit
    const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null);
    const setGridRef = useCallback((el: HTMLDivElement | null) => {
        gridRef.current = el;
        setGridElement(el);
    }, []);
    const [gridDimensions, setGridDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const measureGrid = useCallback((): void => {
        const el = gridRef.current;
        if (!el) return;
        const width = Math.max(0, Math.floor(el.clientWidth - GRID_PADDING));
        const height = Math.max(0, Math.floor(el.clientHeight - GRID_PADDING));
        setGridDimensions((prev) => (
            prev.width === width && prev.height === height ? prev : { width, height }
        ));
    }, []);
    useEffect(() => {
        const el = gridElement;
        if (!el) {
            setGridDimensions({ width: 0, height: 0 });
            return undefined;
        }
        measureGrid();
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(measureGrid);
            ro.observe(el);
            return () => ro.disconnect();
        }
        window.addEventListener('resize', measureGrid);
        return () => window.removeEventListener('resize', measureGrid);
    }, [gridElement, measureGrid]);

    // Actual displayed (render) size of each frame, reported by tiles
    const [frameRenderSizes, setFrameRenderSizes] = useState<Record<number, { width: number; height: number }>>({});
    const handleRenderSizeChange = useCallback((frame: number, width: number, height: number) => {
        setFrameRenderSizes((prev) => {
            const current = prev[frame];
            if (current && current.width === width && current.height === height) return prev;
            return { ...prev, [frame]: { width, height } };
        });
    }, []);

    // Incremented to make tiles reload their frame annotations (after deletion / undo / redo)
    const [tilesRefreshToken, setTilesRefreshToken] = useState<number>(0);

    // Delete Modal State & Handlers
    const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
    const [deleteStartFrame, setDeleteStartFrame] = useState<number | null>(null);
    const [deleteEndFrame, setDeleteEndFrame] = useState<number | null>(null);
    // Deletion filter: Type mode or ID mode, never both
    const [deleteFilter, setDeleteFilter] = useState<ObjectFilterState>(EMPTY_OBJECT_FILTER);
    const deleteLabel = deleteFilter.label;
    const deleteIDInput = deleteFilter.idInput;
    const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
    const [isDeleting, setIsDeleting] = useState<boolean>(false);
    const [deletionPlan, setDeletionPlan] = useState<DeletionPlan | null>(null);
    const [isPlanning, setIsPlanning] = useState<boolean>(false);
    const [lastDeletion, setLastDeletion] = useState<{
        entries: [string, number | null][];
        count: number;
        description: string;
        undone: boolean;
    } | null>(null);
    const [historySnapshot, setHistorySnapshot] = useState<HistorySnapshot | null>(null);
    const reduxHistory = useSelector((state: CombinedState) => state.annotation.annotations.history);

    const readHistory = useCallback(async (): Promise<HistorySnapshot | null> => {
        try {
            if (jobInstance?.actions && typeof jobInstance.actions.get === 'function') {
                return await jobInstance.actions.get();
            }
        } catch (_e) {
            // history is unavailable
        }
        return null;
    }, [jobInstance]);

    // Keep a local copy of CVAT history to enable/disable batch Undo/Redo of the last deletion
    useEffect(() => {
        let cancelled = false;
        if (lastDeletion) {
            readHistory().then((snapshot) => {
                if (!cancelled) setHistorySnapshot(snapshot);
            });
        }
        return () => {
            cancelled = true;
        };
    }, [lastDeletion, reduxHistory, readHistory]);

    const refreshAfterAnnotationChange = useCallback(async () => {
        dispatch(fetchAnnotationsAsync());
        setTilesRefreshToken((value) => value + 1);
        try {
            const states = jobInstance ? await jobInstance.annotations.get(currentFrame, true, []) : [];
            setAllJobStates(Array.isArray(states) ? states.filter((st: any) => st && !st.removed) : []);
        } catch (_e) {
            setAllJobStates([]);
        }
        setHistorySnapshot(await readHistory());
    }, [dispatch, jobInstance, currentFrame, readHistory]);

    const handleOpenDeleteModal = useCallback(() => {
        setDeleteStartFrame(rangeStart);
        setDeleteEndFrame(rangeEnd);
        setDeleteFilter(objectFilter);
        setConfirmDelete(false);
        setDeletionPlan(null);
        setShowDeleteModal(true);
    }, [rangeStart, rangeEnd, objectFilter]);

    const deleteValidation = validateFrameRange(
        deleteStartFrame,
        deleteEndFrame,
        jobStartFrame,
        jobStopFrame,
        frameNumbers,
    );

    const deleteIDResolution = useMemo(() => (
        resolveObjectByIDAndType(deleteIDInput, 'all', combinedStates)
    ), [deleteIDInput, combinedStates]);

    const hasDeleteID = Boolean(deleteIDInput.trim());
    const deleteIDIsUsable = !hasDeleteID || deleteIDResolution.status === 'VALID';

    // Dry-run preview: recomputed whenever the deletion parameters change
    useEffect(() => {
        setConfirmDelete(false);
        if (!showDeleteModal || !deleteValidation.isValid || !deleteIDIsUsable ||
            deleteStartFrame === null || deleteEndFrame === null || !jobInstance) {
            setDeletionPlan(null);
            setIsPlanning(false);
            return undefined;
        }

        let cancelled = false;
        setIsPlanning(true);
        const timer = setTimeout(async () => {
            try {
                const plan = await planAnnotationDeletion({
                    jobInstance,
                    startFrame: deleteStartFrame,
                    endFrame: deleteEndFrame,
                    stopFrame: jobStopFrame,
                    targetLabel: deleteLabel,
                    targetClientID: hasDeleteID ? deleteIDResolution.resolvedID : null,
                });
                if (!cancelled) setDeletionPlan(plan);
            } catch (_err: any) {
                if (!cancelled) setDeletionPlan(null);
            } finally {
                if (!cancelled) setIsPlanning(false);
            }
        }, 250);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [
        showDeleteModal,
        deleteValidation.isValid,
        deleteIDIsUsable,
        deleteStartFrame,
        deleteEndFrame,
        deleteLabel,
        hasDeleteID,
        deleteIDResolution.resolvedID,
        jobInstance,
        jobStopFrame,
        tilesRefreshToken,
    ]);

    const canExecuteDelete = Boolean(
        deletionPlan && deletionPlan.isValid && confirmDelete && !isPlanning && !isDeleting,
    );

    const handleExecuteDelete = useCallback(async () => {
        if (!deletionPlan || !deletionPlan.isValid || !confirmDelete) {
            return;
        }

        setIsDeleting(true);
        try {
            const before = await readHistory();
            const result = await executeAnnotationDeletion(jobInstance, deletionPlan);
            const after = await readHistory();

            // Verify the recorded undo steps so the deletion can be undone/redone as one batch
            let entries: [string, number | null][] = [];
            if (before && after && result.historySteps > 0 && after.undo.length >= result.historySteps) {
                const expectedLength = Math.min(before.undo.length + result.historySteps, after.undo.length);
                if (after.undo.length === expectedLength) {
                    entries = after.undo.slice(-result.historySteps);
                }
            }
            setLastDeletion(entries.length === result.historySteps && result.historySteps > 0 ? {
                entries,
                count: result.historySteps,
                description: `${result.deletedObjects} deleted, ${result.hiddenTracks} track(s) hidden ` +
                    `in frames #${deletionPlan.startFrame}-#${deletionPlan.endFrame}`,
                undone: false,
            } : null);

            await refreshAfterAnnotationChange();

            if (inputObjectID && deletionPlan.targetClientID !== null &&
                selectedObject && selectedObject.clientID === deletionPlan.targetClientID &&
                result.deletedObjects > 0) {
                applyObjectFilter(EMPTY_OBJECT_FILTER);
            }

            setShowDeleteModal(false);
            const hasProblems = result.errors.length > 0 || result.skippedLocked.length > 0;
            const notify = hasProblems ? notification.warning : notification.success;
            notify({
                message: hasProblems ? 'Deletion finished with warnings' : 'Annotations deleted',
                description: [
                    `${result.deletedObjects} object(s) deleted and ${result.hiddenTracks} track(s) hidden ` +
                    `in frames #${deletionPlan.startFrame}-#${deletionPlan.endFrame}.`,
                    result.skippedLocked.length ? `Skipped locked: ${result.skippedLocked.join(', ')}.` : '',
                    result.errors.length ? `Errors: ${result.errors.join('; ')}` : '',
                    'Use "Undo deletion" (or Ctrl+Z step by step) to revert, then save to persist.',
                ].filter(Boolean).join(' '),
                duration: 6,
            });
        } catch (err: any) {
            notification.error({
                message: 'Delete Failed',
                description: err?.message || 'Could not complete deletion',
            });
        } finally {
            setIsDeleting(false);
        }
    }, [
        deletionPlan,
        confirmDelete,
        readHistory,
        jobInstance,
        refreshAfterAnnotationChange,
        inputObjectID,
        selectedObject,
        applyObjectFilter,
    ]);

    const canUndoLastDeletion = Boolean(
        lastDeletion && !lastDeletion.undone &&
        canUndoDeletionBatch(historySnapshot, lastDeletion.entries, lastDeletion.count),
    );
    const canRedoLastDeletion = Boolean(
        lastDeletion && lastDeletion.undone &&
        canRedoDeletionBatch(historySnapshot, lastDeletion.entries, lastDeletion.count),
    );

    const handleUndoLastDeletion = useCallback(async () => {
        if (!lastDeletion || !jobInstance) return;
        const snapshot = await readHistory();
        if (!canUndoDeletionBatch(snapshot, lastDeletion.entries, lastDeletion.count)) {
            notification.warning({
                message: 'Cannot undo deletion as one step',
                description: 'Other changes were made after the deletion. Use Ctrl+Z step by step instead.',
            });
            setHistorySnapshot(snapshot);
            return;
        }
        await jobInstance.actions.undo(lastDeletion.count);
        setLastDeletion({ ...lastDeletion, undone: true });
        await refreshAfterAnnotationChange();
    }, [lastDeletion, jobInstance, readHistory, refreshAfterAnnotationChange]);

    const handleRedoLastDeletion = useCallback(async () => {
        if (!lastDeletion || !jobInstance) return;
        const snapshot = await readHistory();
        if (!canRedoDeletionBatch(snapshot, lastDeletion.entries, lastDeletion.count)) {
            notification.warning({
                message: 'Cannot redo deletion as one step',
                description: 'The history changed after the deletion was undone.',
            });
            setHistorySnapshot(snapshot);
            return;
        }
        await jobInstance.actions.redo(lastDeletion.count);
        setLastDeletion({ ...lastDeletion, undone: false });
        await refreshAfterAnnotationChange();
    }, [lastDeletion, jobInstance, readHistory, refreshAfterAnnotationChange]);

    useEffect(() => {
        if (typeof initialStartFrame === 'number') {
            setRangeStart(initialStartFrame);
            setInputStart(initialStartFrame);
        } else if (hasValidFrames) {
            setRangeStart(jobStartFrame);
            setInputStart(jobStartFrame);
        }
        if (typeof initialEndFrame === 'number') {
            setRangeEnd(initialEndFrame);
            setInputEnd(initialEndFrame);
        } else if (hasValidFrames) {
            setRangeEnd(jobStopFrame);
            setInputEnd(jobStopFrame);
        }
        if (typeof initialFrameCount === 'number') {
            setBatchSize(clamp(initialFrameCount, 1, 10));
        }
        setBatchIndex(0);
    }, [initialStartFrame, initialEndFrame, initialFrameCount, hasValidFrames, jobStartFrame, jobStopFrame]);

    // Reset batch index to 0 whenever the selected range or batch size changes
    useEffect(() => {
        setBatchIndex(0);
    }, [rangeStart, rangeEnd, batchSize]);

    const validation = validateFrameRange(inputStart, inputEnd, jobStartFrame, jobStopFrame, frameNumbers);
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, batchSize, frameNumbers);
    const batchFrames = getBatchFrames(batchIndex, rangeStart, rangeEnd, batchSize, frameNumbers);

    const onUpdateRange = useCallback(() => {
        if (validation.isValid && hasValidFrames && inputStart !== null && inputEnd !== null) {
            setRangeStart(inputStart);
            setRangeEnd(inputEnd);
            setBatchIndex(0);
        }
    }, [validation.isValid, hasValidFrames, inputStart, inputEnd]);

    const onPrevBatch = useCallback(() => {
        setBatchIndex((idx) => Math.max(0, idx - 1));
    }, []);

    const onNextBatch = useCallback(() => {
        setBatchIndex((idx) => Math.min(Math.max(0, totalBatches - 1), idx + 1));
    }, [totalBatches]);

    const handleNavigateToFrame = useCallback((frame: number) => {
        dispatch(changeFrameAsync(frame));
    }, [dispatch]);

    const handleZoomFrame = useCallback((frame: number) => {
        setZoomedFrame((prev) => (prev === frame ? null : frame));
        dispatch(changeFrameAsync(frame));
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 50);
    }, [dispatch]);

    const handleResetLayout = useCallback(() => {
        setZoomedFrame(null);
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 50);
    }, []);

    // Escape key restores the grid when a frame is zoomed in place
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape' && zoomedFrame !== null) {
                handleResetLayout();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [zoomedFrame, handleResetLayout]);

    // Restore grid if current batch frames no longer include the zoomed frame
    useEffect(() => {
        if (zoomedFrame !== null && !batchFrames.includes(zoomedFrame)) {
            handleResetLayout();
        }
    }, [batchFrames, zoomedFrame, handleResetLayout]);

    const handleTileSelectObject = useCallback((targetState: any) => {
        if (!targetState) return;
        const { parentID } = targetState;
        let parentObject = targetState;
        if (parentID !== null && parentID !== undefined) {
            const foundParent = combinedStates.find((st: any) => st.clientID === parentID);
            if (foundParent) {
                parentObject = foundParent;
            }
        }
        applyObjectFilter(enterIDFilter(getObjectInputKey(parentObject)));
    }, [combinedStates, applyObjectFilter]);

    let batchStartFrame: number | string = hasValidFrames ? rangeStart : '-';
    let batchEndFrame: number | string = hasValidFrames ? rangeEnd : '-';
    if (batchFrames.length > 0) {
        [batchStartFrame] = batchFrames;
        batchEndFrame = batchFrames[batchFrames.length - 1];
    }
    const batchIndicator = `Batch ${totalBatches === 0 ? 0 : batchIndex + 1} of ${Math.max(1, totalBatches)} ` +
        `(Frames #${batchStartFrame} - #${batchEndFrame})`;

    return (
        <div className={`cvat-multiframe-workspace-view ${zoomedFrame !== null ? 'cvat-multiframe-workspace-has-zoomed' : ''}`}>
            {/* Header Controls Bar */}
            <div className='cvat-multiframe-controls-bar'>
                {/* Left: Range and Navigation */}
                <div className='cvat-multiframe-range-group'>
                    <Text strong>Range:</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 85 }}
                        value={inputStart}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setInputStart(val)}
                        placeholder='Start'
                    />
                    <Text>to</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 85 }}
                        value={inputEnd}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setInputEnd(val)}
                        placeholder='End'
                    />
                    <Button
                        size='small'
                        disabled={!validation.isValid || !hasValidFrames}
                        onClick={onUpdateRange}
                        className='cvat-multiframe-apply-range-btn'
                    >
                        Apply Range
                    </Button>
                    <Text strong style={{ marginLeft: 6 }}>Count:</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 60 }}
                        value={batchSize}
                        min={1}
                        max={10}
                        precision={0}
                        onChange={(val: number | null) => {
                            if (typeof val === 'number') {
                                setBatchSize(clamp(val, 1, 10));
                            }
                        }}
                        placeholder='Count'
                        className='cvat-multiframe-count-quick-input'
                    />
                </div>

                {/* Center: Batch Navigation */}
                <div className='cvat-multiframe-batch-group'>
                    <Button
                        size='small'
                        icon={<LeftOutlined />}
                        onClick={onPrevBatch}
                        disabled={batchIndex === 0}
                        className='cvat-multiframe-prev-batch-btn'
                    >
                        Prev Batch
                    </Button>
                    <Text strong className='cvat-multiframe-batch-indicator'>
                        {batchIndicator}
                    </Text>
                    <Button
                        size='small'
                        icon={<RightOutlined />}
                        onClick={onNextBatch}
                        disabled={totalBatches === 0 || batchIndex >= totalBatches - 1}
                        className='cvat-multiframe-next-batch-btn'
                    >
                        Next Batch
                    </Button>
                </div>

                {/* Object Selector & Auto-Zoom Controls */}
                <div className='cvat-multiframe-object-group'>
                    <Text strong>Type:</Text>
                    <Select
                        size='small'
                        value={selectedLabelFilter}
                        onChange={(val: string) => applyObjectFilter(selectTypeFilter(val))}
                        style={{ width: 130 }}
                        className={`cvat-multiframe-type-select ${
                            objectFilter.mode === 'type' ? 'cvat-multiframe-filter-active' : ''}`}
                        showSearch
                    >
                        <Select.Option value='all'>All Types</Select.Option>
                        {availableLabels.map((name) => (
                            <Select.Option key={name} value={name}>
                                {name}
                            </Select.Option>
                        ))}
                    </Select>

                    <Text type='secondary'>or</Text>
                    <Text strong>Object ID:</Text>
                    <Input
                        size='small'
                        placeholder='ID, track_N, id:N'
                        value={inputObjectID}
                        onChange={(e) => applyObjectFilter(enterIDFilter(e.target.value))}
                        allowClear
                        style={{ width: 120 }}
                        className={`cvat-multiframe-object-id-input ${
                            objectFilter.mode === 'id' ? 'cvat-multiframe-filter-active' : ''}`}
                    />
                    <Tag
                        color={FILTER_MODE_COLORS[objectFilter.mode]}
                        className='cvat-multiframe-filter-mode-tag'
                    >
                        {describeObjectFilter(objectFilter)}
                    </Tag>
                    <Button
                        size='small'
                        onClick={() => applyObjectFilter(EMPTY_OBJECT_FILTER)}
                        disabled={objectFilter.mode === 'none'}
                        className='cvat-multiframe-clear-id-btn'
                        title='Clear the active filter'
                    >
                        Clear
                    </Button>
                    {Boolean(inputObjectID.trim()) && (
                        <Tag
                            color={idResolution.status === 'VALID' ? 'success' : 'error'}
                            className='cvat-multiframe-id-status-tag'
                            title={idResolution.message}
                        >
                            {idResolution.message}
                        </Tag>
                    )}

                    <Checkbox
                        checked={autoZoomEnabled}
                        onChange={(e) => setAutoZoomEnabled(e.target.checked)}
                        className='cvat-multiframe-autozoom-checkbox'
                    >
                        Auto-Zoom
                    </Checkbox>
                    <Checkbox
                        checked={autoFollowEnabled}
                        onChange={(e) => setAutoFollowEnabled(e.target.checked)}
                        className='cvat-multiframe-autofollow-checkbox'
                    >
                        Auto-Follow
                    </Checkbox>
                </div>

                {/* Right: Actions and Exit buttons */}
                <div className='cvat-multiframe-exit-group'>
                    <Button
                        type='primary'
                        danger
                        size='small'
                        icon={<DeleteOutlined />}
                        onClick={handleOpenDeleteModal}
                        className='cvat-multiframe-delete-btn'
                        style={{ marginRight: 8 }}
                        title='Delete annotations by shape type, object ID, and frame range'
                    >
                        Delete Annotations
                    </Button>
                    {lastDeletion && (
                        <Button
                            size='small'
                            icon={lastDeletion.undone ? <RedoOutlined /> : <UndoOutlined />}
                            disabled={lastDeletion.undone ? !canRedoLastDeletion : !canUndoLastDeletion}
                            onClick={lastDeletion.undone ? handleRedoLastDeletion : handleUndoLastDeletion}
                            className='cvat-multiframe-undo-deletion-btn'
                            style={{ marginRight: 8 }}
                            title={`${lastDeletion.undone ? 'Redo' : 'Undo'} the last deletion as one step ` +
                                `(${lastDeletion.count} CVAT history steps): ${lastDeletion.description}`}
                        >
                            {lastDeletion.undone ? 'Redo deletion' : 'Undo deletion'}
                        </Button>
                    )}
                    {zoomedFrame !== null && (
                        <Button
                            size='small'
                            type='primary'
                            ghost
                            icon={<AppstoreOutlined />}
                            onClick={() => handleResetLayout()}
                            className='cvat-multiframe-restore-grid-top-btn'
                            style={{ marginRight: 8 }}
                            title='Restore original grid layout'
                        >
                            Restore Grid
                        </Button>
                    )}
                    <Button
                        type='primary'
                        size='small'
                        icon={<SaveOutlined />}
                        loading={isSaving}
                        disabled={isSaving}
                        onClick={() => dispatch(saveAnnotationsAsync())}
                        className='cvat-multiframe-save-btn'
                        style={{ marginRight: 8, background: '#1890ff', borderColor: '#1890ff' }}
                    >
                        {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                        type='primary'
                        danger
                        size='small'
                        icon={<CloseOutlined />}
                        onClick={onClose}
                        className='cvat-multiframe-exit-btn'
                    >
                        Exit Multi-Frame
                    </Button>
                </div>
            </div>

            {/* Validation warning if custom range is invalid */}
            {!validation.isValid && validation.error && (
                <Alert
                    type='error'
                    showIcon
                    message={validation.error}
                    style={{ marginBottom: 10 }}
                    className='cvat-multiframe-error-alert'
                />
            )}

            {/* Multi-Frame Grid of Tiles or Loading State */}
            {!hasValidFrames && (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Spin size='large' />
                    <div style={{ marginTop: 16 }}>
                        <Text type='secondary'>Loading job frame numbers...</Text>
                    </div>
                </div>
            )}
            {hasValidFrames && batchFrames.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Text type='secondary'>No valid frames found in range [{rangeStart} .. {rangeEnd}].</Text>
                </div>
            )}
            {hasValidFrames && batchFrames.length > 0 && (
                <div
                    ref={setGridRef}
                    className='cvat-multiframe-grid'
                    style={{
                        position: 'relative',
                        gridTemplateColumns: batchFrames.length < 4 ?
                            `repeat(${Math.max(1, batchFrames.length)}, 1fr)` : undefined,
                    }}
                >
                    {batchFrames.map((frame) => {
                        const isThisZoomed = zoomedFrame === frame;
                        const isAnyZoomed = zoomedFrame !== null;
                        const isOtherExpanded = isAnyZoomed && zoomedFrame !== frame;

                        let tileStyle: React.CSSProperties | undefined;
                        if (isThisZoomed) {
                            const renderSize = frameRenderSizes[frame];
                            const optimalFit = calculateExpandedFitDimensions(
                                gridDimensions.width,
                                gridDimensions.height,
                                renderSize?.width ?? 0,
                                renderSize?.height ?? 0,
                                ZOOMED_TILE_CHROME,
                            );
                            tileStyle = optimalFit.isValid ? {
                                gridColumn: '1 / -1',
                                height: `${optimalFit.height}px`,
                                minHeight: 0,
                                width: `${optimalFit.width}px`,
                                maxWidth: '100%',
                                justifySelf: 'center',
                                zIndex: 10,
                            } : {
                                // Sizes are not measurable yet: keep the default full-row layout
                                gridColumn: '1 / -1',
                                minHeight: '520px',
                                zIndex: 10,
                            };
                        }

                        return (
                            <React.Fragment key={`frame_tile_wrapper_${frame}`}>
                                <div
                                    className='cvat-multiframe-tile-placeholder'
                                    style={{ display: 'none' }}
                                />
                                <MultiframeTile
                                    key={`frame_tile_${frame}`}
                                    frameNumber={frame}
                                    jobInstance={jobInstance}
                                    isActiveFrame={frame === currentFrame}
                                    selectedObject={selectedObject}
                                    typeFilterLabel={typeFilterLabel}
                                    autoZoomEnabled={autoZoomEnabled}
                                    autoFollowEnabled={autoFollowEnabled}
                                    isZoomedInPlace={isThisZoomed}
                                    tileStyle={tileStyle}
                                    isEditable={!isOtherExpanded}
                                    onNavigateToFrame={handleNavigateToFrame}
                                    onZoomFrame={handleZoomFrame}
                                    onFrameStatesLoaded={handleFrameStatesLoaded}
                                    onRenderSizeChange={handleRenderSizeChange}
                                    refreshToken={tilesRefreshToken}
                                    onSelectObject={handleTileSelectObject}
                                />
                            </React.Fragment>
                        );
                    })}
                </div>
            )}

            {/* Delete Annotations Modal */}
            <Modal
                title='Delete Annotations by Range'
                open={showDeleteModal}
                onCancel={() => !isDeleting && setShowDeleteModal(false)}
                maskClosable={!isDeleting}
                footer={[
                    <Button key='cancel' onClick={() => setShowDeleteModal(false)} disabled={isDeleting}>
                        Cancel
                    </Button>,
                    <Button
                        key='delete'
                        type='primary'
                        danger
                        loading={isDeleting}
                        disabled={!canExecuteDelete}
                        onClick={handleExecuteDelete}
                        className='cvat-multiframe-delete-confirm-btn'
                    >
                        {deletionPlan && deletionPlan.targets.length > 0 ?
                            `Delete ${deletionPlan.targets.length} object(s)` : 'Delete Annotations'}
                    </Button>,
                ]}
                className='cvat-multiframe-delete-modal'
                destroyOnClose
            >
                <div className='cvat-multiframe-delete-modal-content'>
                    <div style={{ marginBottom: 16 }}>
                        <Text strong style={{ display: 'block', marginBottom: 6 }}>
                            Frame Range (inclusive):
                        </Text>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <InputNumber
                                size='small'
                                style={{ width: 110 }}
                                value={deleteStartFrame}
                                min={jobStartFrame}
                                max={jobStopFrame}
                                precision={0}
                                onChange={(val: number | null) => setDeleteStartFrame(val)}
                                placeholder='Start frame'
                                disabled={isDeleting}
                            />
                            <Text>to</Text>
                            <InputNumber
                                size='small'
                                style={{ width: 110 }}
                                value={deleteEndFrame}
                                min={jobStartFrame}
                                max={jobStopFrame}
                                precision={0}
                                onChange={(val: number | null) => setDeleteEndFrame(val)}
                                placeholder='End frame'
                                disabled={isDeleting}
                            />
                        </div>
                        {!deleteValidation.isValid && deleteValidation.error && (
                            <Alert
                                type='error'
                                showIcon
                                message={deleteValidation.error}
                                style={{ marginTop: 8 }}
                            />
                        )}
                    </div>

                    <div style={{ marginBottom: 8 }}>
                        <Text strong>Filter by Type or by Object ID (not both): </Text>
                        <Tag
                            color={FILTER_MODE_COLORS[deleteFilter.mode]}
                            className='cvat-multiframe-delete-filter-mode-tag'
                        >
                            {deleteFilter.mode === 'none' ?
                                'All objects in the range' : describeObjectFilter(deleteFilter)}
                        </Tag>
                    </div>

                    <div style={{ marginBottom: 16 }}>
                        <Text strong style={{ display: 'block', marginBottom: 6 }}>
                            Object Type (label):
                        </Text>
                        <Select
                            size='small'
                            value={deleteLabel}
                            onChange={(val: string) => setDeleteFilter(selectTypeFilter(val))}
                            style={{ width: 180 }}
                            className='cvat-multiframe-delete-type-select'
                            disabled={isDeleting}
                            showSearch
                        >
                            <Select.Option value='all'>All Types</Select.Option>
                            {availableLabels.map((name) => (
                                <Select.Option key={name} value={name}>
                                    {name}
                                </Select.Option>
                            ))}
                        </Select>
                    </div>

                    <div style={{ marginBottom: 16 }}>
                        <Text strong style={{ display: 'block', marginBottom: 6 }}>
                            Object ID:
                        </Text>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Input
                                size='small'
                                placeholder='12, track_12, shape_12, id:12'
                                value={deleteIDInput}
                                onChange={(e) => setDeleteFilter(enterIDFilter(e.target.value))}
                                allowClear
                                style={{ width: 220 }}
                                className='cvat-multiframe-delete-id-input'
                                disabled={isDeleting}
                            />
                            {hasDeleteID && (
                                <Tag
                                    color={deleteIDResolution.status === 'VALID' ? 'success' : 'error'}
                                    title={deleteIDResolution.message}
                                >
                                    {deleteIDResolution.message}
                                </Tag>
                            )}
                        </div>
                        <Text type='secondary' style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                            Choosing a type clears the Object ID and entering an ID resets the type.
                            A Skeleton landmark ID targets its complete parent Skeleton.
                            Locked objects are never deleted.
                        </Text>
                    </div>

                    {/* Preview Card: actual targets from a dry run */}
                    <div className='cvat-multiframe-delete-preview-card'>
                        <Text strong style={{ color: '#faad14', display: 'block', marginBottom: 4 }}>
                            Deletion Preview:
                        </Text>
                        {isPlanning && <Spin size='small' />}
                        {!isPlanning && !deletionPlan && (
                            <Text type='secondary' style={{ fontSize: 12 }}>
                                Enter a valid frame range and filters to preview the affected objects.
                            </Text>
                        )}
                        {!isPlanning && deletionPlan && (
                            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                                <div>
                                    <Text strong>Affected Range: </Text>
                                    <span>
                                        {`Frames #${deletionPlan.startFrame} to #${deletionPlan.endFrame} `}
                                        {`(inclusive, ${deletionPlan.endFrame - deletionPlan.startFrame + 1} frames)`}
                                    </span>
                                </div>
                                <div>
                                    <Text strong>Objects: </Text>
                                    <span className='cvat-multiframe-delete-preview-count'>
                                        {deletionPlan.targets.length}
                                    </span>
                                    <Text strong style={{ marginLeft: 12 }}>Undo steps: </Text>
                                    <span>{`${deletionPlan.totalHistorySteps} / 32`}</span>
                                </div>
                                {deletionPlan.targets.length > 0 && (
                                    <ul className='cvat-multiframe-delete-preview-list'>
                                        {deletionPlan.targets.slice(0, 50).map((target) => (
                                            <li key={target.key}>{describeDeletionTarget(target, deletionPlan)}</li>
                                        ))}
                                        {deletionPlan.targets.length > 50 && (
                                            <li>{`... and ${deletionPlan.targets.length - 50} more`}</li>
                                        )}
                                    </ul>
                                )}
                                {deletionPlan.targets.some((target) => target.interpolationWarning) && (
                                    <Alert
                                        type='warning'
                                        showIcon
                                        className='cvat-multiframe-delete-interpolation-warning'
                                        style={{ marginTop: 8 }}
                                        message='Polygon / polyline / points tracks: nearby frames may shift slightly'
                                        description={describeInterpolationWarnings(deletionPlan)}
                                    />
                                )}
                                {deletionPlan.skippedLocked.length > 0 && (
                                    <div>
                                        <Text type='warning'>
                                            {'Skipped (locked): '}
                                            {deletionPlan.skippedLocked.map((item) => item.key).join(', ')}
                                        </Text>
                                    </div>
                                )}
                                {deletionPlan.error && (
                                    <Alert
                                        type={deletionPlan.exceedsHistoryLimit ? 'error' : 'info'}
                                        showIcon
                                        message={deletionPlan.error}
                                        style={{ marginTop: 8 }}
                                    />
                                )}
                            </div>
                        )}
                    </div>

                    {/* Mandatory confirmation for every deletion */}
                    {deletionPlan && deletionPlan.isValid && !isPlanning && (
                        <div style={{ marginTop: 16 }}>
                            <Alert
                                type='warning'
                                showIcon
                                message={`${deletionPlan.targets.length} object(s) will be changed. ` +
                                    'Annotations outside the frame range and locked objects are not affected.'}
                                style={{ marginBottom: 12 }}
                            />
                            <Checkbox
                                checked={confirmDelete}
                                onChange={(e) => setConfirmDelete(e.target.checked)}
                                className='cvat-multiframe-confirm-delete-checkbox'
                                disabled={isDeleting}
                            >
                                {'I reviewed the preview and want to delete these '}
                                {`${deletionPlan.targets.length} object(s)`}
                            </Checkbox>
                        </div>
                    )}
                </div>
            </Modal>
        </div>
    );
}

export default React.memo(MultiframeWorkspaceView);
