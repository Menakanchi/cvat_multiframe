// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useCallback, useMemo, useEffect, useState, useRef,
} from 'react';
import { createPortal } from 'react-dom';
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
import {
    CloseOutlined,
    LeftOutlined,
    RightOutlined,
    SaveOutlined,
    AppstoreOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';
import {
    changeFrameAsync,
    saveAnnotationsAsync,
} from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import { clamp } from 'utils/math';
import { ANNOTATIONS_BULK_CHANGED_EVENT } from 'components/annotation-page/annotation-deletion/annotation-deletion-panel';
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
} from './multiframe-utils';
import MultiframeTile from './multiframe-tile';
import { MULTIFRAME_SIDEBAR_CONTROLS_ID } from './multiframe-sidebar-tab';

const DEFAULT_BATCH_SIZE = 10;

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

    // Container in the right tools sidebar that receives the controls (rendered in the same commit)
    const [controlsTarget, setControlsTarget] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setControlsTarget(document.getElementById(MULTIFRAME_SIDEBAR_CONTROLS_ID));
    }, []);

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

    // Incremented to make tiles reload their frame annotations (after a bulk deletion / its undo / redo)
    const [tilesRefreshToken, setTilesRefreshToken] = useState<number>(0);

    // Reload annotations when the Delete Annotations panel changed them
    useEffect(() => {
        const onAnnotationsChanged = async (): Promise<void> => {
            setTilesRefreshToken((value) => value + 1);
            try {
                const states = jobInstance ? await jobInstance.annotations.get(currentFrame, true, []) : [];
                setAllJobStates(Array.isArray(states) ? states.filter((st: any) => st && !st.removed) : []);
            } catch (_e) {
                setAllJobStates([]);
            }
        };
        window.addEventListener(ANNOTATIONS_BULK_CHANGED_EVENT, onAnnotationsChanged);
        return () => window.removeEventListener(ANNOTATIONS_BULK_CHANGED_EVENT, onAnnotationsChanged);
    }, [jobInstance, currentFrame]);

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

    // Controls are shown in the Multi-Frame tab of the right tools sidebar (React portal)
    const controls = (
        <div className='cvat-multiframe-controls-panel'>
            <div className='cvat-multiframe-controls-section'>
                <Text strong className='cvat-multiframe-controls-title'>Frames</Text>
                <div className='cvat-multiframe-range-group'>
                    <Text>Range</Text>
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
                </div>
                <div className='cvat-multiframe-range-group'>
                    <Text>Count</Text>
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
                    <Button
                        size='small'
                        disabled={!validation.isValid || !hasValidFrames}
                        onClick={onUpdateRange}
                        className='cvat-multiframe-apply-range-btn'
                    >
                        Apply Range
                    </Button>
                </div>
                {!validation.isValid && validation.error && (
                    <Alert
                        type='error'
                        showIcon
                        message={validation.error}
                        className='cvat-multiframe-error-alert'
                    />
                )}
            </div>

            <div className='cvat-multiframe-controls-section'>
                <Text strong className='cvat-multiframe-controls-title'>Batch</Text>
                <Text className='cvat-multiframe-batch-indicator'>
                    {batchIndicator}
                </Text>
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
            </div>

            <div className='cvat-multiframe-controls-section cvat-multiframe-object-group'>
                <Text strong className='cvat-multiframe-controls-title'>Object</Text>
                <div className='cvat-multiframe-range-group'>
                    <Text>Type</Text>
                    <Select
                        size='small'
                        value={selectedLabelFilter}
                        onChange={(val: string) => applyObjectFilter(selectTypeFilter(val))}
                        style={{ flex: 1 }}
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
                </div>
                <div className='cvat-multiframe-range-group'>
                    <Text>ID</Text>
                    <Input
                        size='small'
                        placeholder='ID, track_N, id:N'
                        value={inputObjectID}
                        onChange={(e) => applyObjectFilter(enterIDFilter(e.target.value))}
                        allowClear
                        style={{ flex: 1 }}
                        className={`cvat-multiframe-object-id-input ${
                            objectFilter.mode === 'id' ? 'cvat-multiframe-filter-active' : ''}`}
                    />
                    <Button
                        size='small'
                        onClick={() => applyObjectFilter(EMPTY_OBJECT_FILTER)}
                        disabled={objectFilter.mode === 'none'}
                        className='cvat-multiframe-clear-id-btn'
                        title='Clear the active filter'
                    >
                        Clear
                    </Button>
                </div>
                <div className='cvat-multiframe-range-group'>
                    <Tag
                        color={FILTER_MODE_COLORS[objectFilter.mode]}
                        className='cvat-multiframe-filter-mode-tag'
                    >
                        {describeObjectFilter(objectFilter)}
                    </Tag>
                    {Boolean(inputObjectID.trim()) && (
                        <Tag
                            color={idResolution.status === 'VALID' ? 'success' : 'error'}
                            className='cvat-multiframe-id-status-tag'
                            title={idResolution.message}
                        >
                            {idResolution.message}
                        </Tag>
                    )}
                </div>
                <div className='cvat-multiframe-range-group'>
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
            </div>

            <div className='cvat-multiframe-controls-section cvat-multiframe-exit-group'>
                {zoomedFrame !== null && (
                    <Button
                        size='small'
                        type='primary'
                        ghost
                        icon={<AppstoreOutlined />}
                        onClick={() => handleResetLayout()}
                        className='cvat-multiframe-restore-grid-top-btn'
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
    );

    return (
        <div className={`cvat-multiframe-workspace-view ${zoomedFrame !== null ? 'cvat-multiframe-workspace-has-zoomed' : ''}`}>
            {controlsTarget ? createPortal(controls, controlsTarget) : controls}

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
                    className={`cvat-multiframe-grid ${zoomedFrame !== null ? 'cvat-multiframe-grid-has-zoomed' : ''}`}
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
                        } else if (isAnyZoomed) {
                            // The zoomed frame fills the workspace: other tiles stay mounted but hidden
                            tileStyle = { display: 'none' };
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
        </div>
    );
}

export default React.memo(MultiframeWorkspaceView);
