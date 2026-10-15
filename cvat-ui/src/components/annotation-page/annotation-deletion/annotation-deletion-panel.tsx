// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, {
    useCallback, useEffect, useMemo, useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Input from 'antd/lib/input';
import InputNumber from 'antd/lib/input-number';
import Alert from 'antd/lib/alert';
import Select from 'antd/lib/select';
import Popconfirm from 'antd/lib/popconfirm';
import notification from 'antd/lib/notification';
import {
    DeleteOutlined,
    UndoOutlined,
    RedoOutlined,
    UpOutlined,
    DownOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { fetchAnnotationsAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    validateFrameRange,
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
    HistorySnapshot,
} from 'components/annotation-page/multiframe-modal/multiframe-utils';

/** Fired on window after a bulk deletion / its undo / redo, so other views (Multi-Frame) reload annotations */
export const ANNOTATIONS_BULK_CHANGED_EVENT = 'cvat-annotations-bulk-changed';

/** Top-level objects of the whole job (every frame), so any Object ID of the job can be validated */
async function collectJobObjects(jobInstance: any, frames: number[]): Promise<any[]> {
    const merged = new Map<number, any>();
    for (const frame of frames) {
        const states = await jobInstance.annotations.get(frame, true, []);
        for (const state of (Array.isArray(states) ? states : [])) {
            if (state && !state.removed && !merged.has(state.clientID)) merged.set(state.clientID, state);
        }
    }
    return Array.from(merged.values());
}

function isTopLevel(state: any): boolean {
    return state?.parentID === null || state?.parentID === undefined;
}

interface Props {
    /** The panel is visible: objects and the deletion plan are computed only while it is shown */
    active: boolean;
}

function AnnotationDeletionPanel(props: Props): JSX.Element {
    const { active } = props;
    const dispatch = useDispatch();
    const {
        jobInstance,
        currentFrame,
        frameNumbers,
        jobLabels,
        reduxHistory,
        multiframeActive,
        multiframeStart,
        multiframeEnd,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        frameNumbers: state.annotation.job.frameNumbers,
        jobLabels: state.annotation.job.labels,
        reduxHistory: state.annotation.annotations.history,
        multiframeActive: state.annotation.multiframe.active,
        multiframeStart: state.annotation.multiframe.startFrame,
        multiframeEnd: state.annotation.multiframe.endFrame,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ? frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ? frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [startFrame, setStartFrame] = useState<number | null>(null);
    const [endFrame, setEndFrame] = useState<number | null>(null);
    // Deletion filter: Type mode or ID mode, never both
    const [filter, setFilter] = useState<ObjectFilterState>(EMPTY_OBJECT_FILTER);
    const [jobObjects, setJobObjects] = useState<any[]>([]);
    const [deletionPlan, setDeletionPlan] = useState<DeletionPlan | null>(null);
    const [isPlanning, setIsPlanning] = useState<boolean>(false);
    const [isDeleting, setIsDeleting] = useState<boolean>(false);
    // Incremented to recompute objects and plan after the annotations were changed by this panel
    const [planToken, setPlanToken] = useState<number>(0);
    const [lastDeletion, setLastDeletion] = useState<{
        entries: [string, number | null][];
        count: number;
        description: string;
        undone: boolean;
    } | null>(null);
    const [historySnapshot, setHistorySnapshot] = useState<HistorySnapshot | null>(null);

    const availableLabels: string[] = Array.from(new Set(
        (Array.isArray(jobLabels) ? jobLabels : [])
            .map((label: any) => label?.name)
            .filter((name: any) => typeof name === 'string' && name),
    ));

    // Default range when the panel is opened for the first time
    useEffect(() => {
        if (!active || startFrame !== null || endFrame !== null) return;
        if (multiframeActive && typeof multiframeStart === 'number' && typeof multiframeEnd === 'number') {
            setStartFrame(multiframeStart);
            setEndFrame(multiframeEnd);
        } else {
            setStartFrame(currentFrame);
            setEndFrame(currentFrame);
        }
    }, [active, startFrame, endFrame, multiframeActive, multiframeStart, multiframeEnd, currentFrame]);

    const rangeValidation = validateFrameRange(startFrame, endFrame, jobStartFrame, jobStopFrame, frameNumbers);
    const { idInput } = filter;
    const hasID = Boolean(idInput.trim());

    // Objects of the whole job, reloaded whenever the annotations change
    useEffect(() => {
        if (!active || !jobInstance || !hasValidFrames) return undefined;
        let cancelled = false;
        collectJobObjects(jobInstance, frameNumbers).then((objects) => {
            if (!cancelled) setJobObjects(objects);
        }).catch(() => {
            if (!cancelled) setJobObjects([]);
        });
        return () => {
            cancelled = true;
        };
    }, [active, jobInstance, hasValidFrames, frameNumbers, reduxHistory, planToken]);

    // The entered ID is validated against every object of the job
    const idResolution = useMemo(() => (
        hasID ? resolveObjectByIDAndType(idInput, 'all', jobObjects) : null
    ), [hasID, idInput, jobObjects]);
    const isIDValid = !hasID || idResolution?.status === 'VALID';

    // Existing top-level object IDs of the job, ascending, for the up / down stepper
    const objectsByID = useMemo(() => {
        const map = new Map<number, any>();
        for (const state of jobObjects) {
            if (isTopLevel(state)) map.set(state.clientID, state);
        }
        return map;
    }, [jobObjects]);
    const sortedIDs = useMemo(() => Array.from(objectsByID.keys()).sort((a, b) => a - b), [objectsByID]);
    const selectedID = idResolution?.status === 'VALID' ? idResolution.resolvedID : null;
    const nextID = sortedIDs.find((id) => selectedID === null || id > selectedID) ?? null;
    const prevID = [...sortedIDs].reverse().find((id) => selectedID === null || id < selectedID) ?? null;
    const stepToID = useCallback((id: number | null) => {
        if (id === null) return;
        setFilter(enterIDFilter(getObjectInputKey(objectsByID.get(id))));
    }, [objectsByID]);

    const notifyInvalidID = useCallback(() => {
        if (hasID && idResolution && idResolution.status !== 'VALID') {
            notification.warning({
                message: 'Object ID not found',
                description: idResolution.message || `No object with ID "${idInput.trim()}" in this job`,
            });
        }
    }, [hasID, idResolution, idInput]);

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

    // Dry run: the objects that will be deleted, recomputed whenever the parameters or the annotations change
    useEffect(() => {
        if (!active || !rangeValidation.isValid || startFrame === null || endFrame === null || !jobInstance ||
            !isIDValid) {
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
                    startFrame,
                    endFrame,
                    stopFrame: jobStopFrame,
                    targetLabel: filter.label,
                    targetClientID: hasID ? selectedID : null,
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
        active,
        rangeValidation.isValid,
        startFrame,
        endFrame,
        filter.label,
        hasID,
        isIDValid,
        selectedID,
        jobInstance,
        jobStopFrame,
        reduxHistory,
        planToken,
    ]);

    const notifyAnnotationsChanged = useCallback(async () => {
        dispatch(fetchAnnotationsAsync());
        window.dispatchEvent(new Event(ANNOTATIONS_BULK_CHANGED_EVENT));
        setPlanToken((value) => value + 1);
        setHistorySnapshot(await readHistory());
    }, [dispatch, readHistory]);

    const targetCount = deletionPlan?.targets.length ?? 0;
    const canExecuteDelete = Boolean(
        deletionPlan && deletionPlan.isValid && targetCount > 0 && !isPlanning && !isDeleting,
    );

    const handleExecuteDelete = useCallback(async () => {
        if (!deletionPlan || !deletionPlan.isValid) {
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
                description: `${result.deletedObjects + result.hiddenTracks} object(s) ` +
                    `in frames #${deletionPlan.startFrame}-#${deletionPlan.endFrame}`,
                undone: false,
            } : null);

            await notifyAnnotationsChanged();

            const hasProblems = result.errors.length > 0 || result.skippedLocked.length > 0;
            const notify = hasProblems ? notification.warning : notification.success;
            notify({
                message: hasProblems ? 'Deletion finished with warnings' : 'Annotations deleted',
                description: [
                    `${result.deletedObjects + result.hiddenTracks} object(s) deleted ` +
                    `in frames #${deletionPlan.startFrame}-#${deletionPlan.endFrame}.`,
                    result.skippedLocked.length ? `Skipped locked: ${result.skippedLocked.join(', ')}.` : '',
                    result.errors.length ? `Errors: ${result.errors.join('; ')}` : '',
                ].filter(Boolean).join(' '),
                duration: 4,
            });
        } catch (err: any) {
            notification.error({
                message: 'Delete Failed',
                description: err?.message || 'Could not complete deletion',
            });
        } finally {
            setIsDeleting(false);
        }
    }, [deletionPlan, readHistory, jobInstance, notifyAnnotationsChanged]);

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
        await notifyAnnotationsChanged();
    }, [lastDeletion, jobInstance, readHistory, notifyAnnotationsChanged]);

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
        await notifyAnnotationsChanged();
    }, [lastDeletion, jobInstance, readHistory, notifyAnnotationsChanged]);

    let summary = 'Enter a valid frame range';
    if (rangeValidation.isValid && !isIDValid) {
        summary = 'Enter an existing Object ID';
    } else if (isPlanning) {
        summary = 'Checking...';
    } else if (deletionPlan && deletionPlan.isValid) {
        summary = targetCount > 0 ?
            `${targetCount} object(s) will be deleted` :
            `Nothing to delete in frames #${deletionPlan.startFrame}-#${deletionPlan.endFrame}`;
    }

    return (
        <div className='cvat-annotation-deletion-content'>
            <div className='cvat-annotation-deletion-section'>
                <Text strong className='cvat-annotation-deletion-field-label'>
                    Frame Range (inclusive):
                </Text>
                <div className='cvat-annotation-deletion-row'>
                    <InputNumber
                        size='small'
                        style={{ width: 100 }}
                        value={startFrame}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setStartFrame(val)}
                        placeholder='Start'
                        disabled={isDeleting}
                        className='cvat-annotation-deletion-start-input'
                    />
                    <Text>to</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 100 }}
                        value={endFrame}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setEndFrame(val)}
                        placeholder='End'
                        disabled={isDeleting}
                        className='cvat-annotation-deletion-end-input'
                    />
                    <Button
                        size='small'
                        onClick={() => {
                            setStartFrame(currentFrame);
                            setEndFrame(currentFrame);
                        }}
                        disabled={isDeleting}
                        title='Use the current frame only'
                    >
                        Current
                    </Button>
                </div>
                {!rangeValidation.isValid && rangeValidation.error && (
                    <Alert type='error' showIcon message={rangeValidation.error} style={{ marginTop: 8 }} />
                )}
            </div>

            <div className='cvat-annotation-deletion-section'>
                <Text strong className='cvat-annotation-deletion-field-label'>
                    Object Type (label):
                </Text>
                <Select
                    size='small'
                    value={filter.label}
                    onChange={(val: string) => setFilter(selectTypeFilter(val))}
                    style={{ width: '100%' }}
                    className='cvat-annotation-deletion-type-select'
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

            <div className='cvat-annotation-deletion-section'>
                <Text strong className='cvat-annotation-deletion-field-label'>
                    Object ID (or choose a type):
                </Text>
                <div className='cvat-annotation-deletion-row'>
                    <Input
                        size='small'
                        placeholder='12, track_12, shape_12, id:12'
                        value={idInput}
                        onChange={(e) => setFilter(enterIDFilter(e.target.value))}
                        onBlur={notifyInvalidID}
                        onPressEnter={notifyInvalidID}
                        allowClear
                        status={isIDValid ? undefined : 'error'}
                        className='cvat-annotation-deletion-id-input'
                        disabled={isDeleting}
                    />
                    <Button
                        size='small'
                        icon={<DownOutlined />}
                        disabled={isDeleting || prevID === null}
                        onClick={() => stepToID(prevID)}
                        className='cvat-annotation-deletion-prev-id-btn'
                        title='Previous existing object ID'
                    />
                    <Button
                        size='small'
                        icon={<UpOutlined />}
                        disabled={isDeleting || nextID === null}
                        onClick={() => stepToID(nextID)}
                        className='cvat-annotation-deletion-next-id-btn'
                        title='Next existing object ID'
                    />
                </div>
                {hasID && idResolution && (
                    <Text
                        type={idResolution.status === 'VALID' ? 'secondary' : 'danger'}
                        className='cvat-annotation-deletion-id-status'
                    >
                        {idResolution.status === 'VALID' ? idResolution.message : `Not found: ${idResolution.message}`}
                    </Text>
                )}
            </div>

            <div className='cvat-annotation-deletion-section'>
                <Text strong className='cvat-annotation-deletion-summary'>{summary}</Text>
                {deletionPlan && deletionPlan.error && !isPlanning && (
                    <Alert
                        type={deletionPlan.exceedsHistoryLimit ? 'error' : 'info'}
                        showIcon
                        message={deletionPlan.error}
                        style={{ marginTop: 8 }}
                    />
                )}
            </div>

            <div className='cvat-annotation-deletion-actions'>
                <Popconfirm
                    title={`Delete ${targetCount} object(s) in frames #${startFrame}-#${endFrame}?`}
                    okText='Delete'
                    okButtonProps={{ danger: true }}
                    onConfirm={handleExecuteDelete}
                    disabled={!canExecuteDelete}
                >
                    <Button
                        type='primary'
                        danger
                        icon={<DeleteOutlined />}
                        loading={isDeleting}
                        disabled={!canExecuteDelete}
                        className='cvat-annotation-deletion-confirm-btn'
                    >
                        {targetCount > 0 ? `Delete ${targetCount} object(s)` : 'Delete'}
                    </Button>
                </Popconfirm>
                {lastDeletion && (
                    <Button
                        icon={lastDeletion.undone ? <RedoOutlined /> : <UndoOutlined />}
                        disabled={lastDeletion.undone ? !canRedoLastDeletion : !canUndoLastDeletion}
                        onClick={lastDeletion.undone ? handleRedoLastDeletion : handleUndoLastDeletion}
                        className='cvat-annotation-deletion-undo-btn'
                        title={`${lastDeletion.undone ? 'Redo' : 'Undo'} the last deletion as one step ` +
                            `(${lastDeletion.count} CVAT history steps): ${lastDeletion.description}`}
                    >
                        {lastDeletion.undone ? 'Redo deletion' : 'Undo deletion'}
                    </Button>
                )}
            </div>
        </div>
    );
}

export default React.memo(AnnotationDeletionPanel);
