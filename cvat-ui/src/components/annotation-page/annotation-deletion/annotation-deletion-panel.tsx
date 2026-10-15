// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, {
    useCallback, useEffect, useState,
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
import notification from 'antd/lib/notification';
import {
    DeleteOutlined,
    UndoOutlined,
    RedoOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { fetchAnnotationsAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    validateFrameRange,
    resolveObjectByIDAndType,
    ObjectResolutionResult,
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
} from 'components/annotation-page/multiframe-modal/multiframe-utils';

/** Fired on window after a bulk deletion / its undo / redo, so other views (Multi-Frame) reload annotations */
export const ANNOTATIONS_BULK_CHANGED_EVENT = 'cvat-annotations-bulk-changed';

const FILTER_MODE_COLORS: Record<ObjectFilterState['mode'], string> = {
    none: 'default',
    type: 'blue',
    id: 'purple',
};

function describeFilter(filter: ObjectFilterState): string {
    if (filter.mode === 'type') return `Type = ${filter.label}`;
    if (filter.mode === 'id') return `ID = ${filter.idInput.trim()}`;
    return 'All objects in the range';
}

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

/** Top-level states of every frame in the range, so an Object ID can be resolved wherever the object is */
async function collectRangeStates(jobInstance: any, frames: number[]): Promise<any[]> {
    const merged = new Map<number, any>();
    for (const frame of frames) {
        const states = await jobInstance.annotations.get(frame, true, []);
        for (const state of (Array.isArray(states) ? states : [])) {
            if (state && !merged.has(state.clientID)) merged.set(state.clientID, state);
        }
    }
    return Array.from(merged.values());
}

interface Props {
    /** The panel is visible: the dry-run preview is computed only while it is shown */
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
    const [idResolution, setIDResolution] = useState<ObjectResolutionResult | null>(null);
    const [deletionPlan, setDeletionPlan] = useState<DeletionPlan | null>(null);
    const [isPlanning, setIsPlanning] = useState<boolean>(false);
    const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
    const [isDeleting, setIsDeleting] = useState<boolean>(false);
    // Incremented to recompute the preview after the annotations were changed by this panel
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

    // Dry-run preview: recomputed whenever the deletion parameters or the annotations change
    useEffect(() => {
        setConfirmDelete(false);
        if (!active || !rangeValidation.isValid || startFrame === null || endFrame === null || !jobInstance) {
            setDeletionPlan(null);
            setIDResolution(null);
            setIsPlanning(false);
            return undefined;
        }

        let cancelled = false;
        setIsPlanning(true);
        const timer = setTimeout(async () => {
            try {
                let targetClientID: number | null = null;
                if (hasID) {
                    const frames = (hasValidFrames ? frameNumbers : [])
                        .filter((frame: number) => frame >= startFrame && frame <= endFrame);
                    const rangeStates = await collectRangeStates(jobInstance, frames);
                    const resolution = resolveObjectByIDAndType(idInput, 'all', rangeStates);
                    if (cancelled) return;
                    setIDResolution(resolution);
                    if (resolution.status !== 'VALID') {
                        setDeletionPlan(null);
                        return;
                    }
                    targetClientID = resolution.resolvedID;
                } else {
                    setIDResolution(null);
                }

                const plan = await planAnnotationDeletion({
                    jobInstance,
                    startFrame,
                    endFrame,
                    stopFrame: jobStopFrame,
                    targetLabel: filter.label,
                    targetClientID,
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
        idInput,
        hasID,
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

            await notifyAnnotationsChanged();

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
    }, [deletionPlan, confirmDelete, readHistory, jobInstance, notifyAnnotationsChanged]);

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
                <Text strong>Filter (Type or Object ID, not both): </Text>
                <Tag color={FILTER_MODE_COLORS[filter.mode]} className='cvat-annotation-deletion-filter-tag'>
                    {describeFilter(filter)}
                </Tag>
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
                    Object ID:
                </Text>
                <Input
                    size='small'
                    placeholder='12, track_12, shape_12, id:12'
                    value={idInput}
                    onChange={(e) => setFilter(enterIDFilter(e.target.value))}
                    allowClear
                    className='cvat-annotation-deletion-id-input'
                    disabled={isDeleting}
                />
                {hasID && idResolution && (
                    <Tag
                        color={idResolution.status === 'VALID' ? 'success' : 'error'}
                        title={idResolution.message}
                        className='cvat-annotation-deletion-id-status'
                    >
                        {idResolution.message}
                    </Tag>
                )}
            </div>

            {/* Preview: actual targets from a dry run */}
            <div className='cvat-annotation-deletion-preview-card'>
                <Text strong className='cvat-annotation-deletion-preview-title'>
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
                            <Text strong>Range: </Text>
                            <span>
                                {`#${deletionPlan.startFrame} - #${deletionPlan.endFrame} `}
                                {`(${deletionPlan.endFrame - deletionPlan.startFrame + 1} frames)`}
                            </span>
                        </div>
                        <div>
                            <Text strong>Objects: </Text>
                            <span className='cvat-annotation-deletion-preview-count'>
                                {deletionPlan.targets.length}
                            </span>
                            <Text strong style={{ marginLeft: 12 }}>Undo steps: </Text>
                            <span>{`${deletionPlan.totalHistorySteps} / 32`}</span>
                        </div>
                        {deletionPlan.targets.length > 0 && (
                            <ul className='cvat-annotation-deletion-preview-list'>
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
                <div className='cvat-annotation-deletion-section'>
                    <Alert
                        type='warning'
                        showIcon
                        message={`${deletionPlan.targets.length} object(s) will be changed. ` +
                            'Annotations outside the frame range and locked objects are not affected.'}
                        style={{ marginBottom: 8 }}
                    />
                    <Checkbox
                        checked={confirmDelete}
                        onChange={(e) => setConfirmDelete(e.target.checked)}
                        className='cvat-annotation-deletion-confirm-checkbox'
                        disabled={isDeleting}
                    >
                        {'I reviewed the preview and want to delete these '}
                        {`${deletionPlan.targets.length} object(s)`}
                    </Checkbox>
                </div>
            )}

            <div className='cvat-annotation-deletion-actions'>
                <Button
                    type='primary'
                    danger
                    icon={<DeleteOutlined />}
                    loading={isDeleting}
                    disabled={!canExecuteDelete}
                    onClick={handleExecuteDelete}
                    className='cvat-annotation-deletion-confirm-btn'
                >
                    {deletionPlan && deletionPlan.targets.length > 0 ?
                        `Delete ${deletionPlan.targets.length} object(s)` : 'Delete'}
                </Button>
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
