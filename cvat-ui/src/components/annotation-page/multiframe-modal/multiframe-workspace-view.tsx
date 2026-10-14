// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useMemo, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Tag from 'antd/lib/tag';
import InputNumber from 'antd/lib/input-number';
import Alert from 'antd/lib/alert';
import Spin from 'antd/lib/spin';
import Select from 'antd/lib/select';
import Checkbox from 'antd/lib/checkbox';
import { CloseOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal, changeFrameAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    validateFrameRange,
    getBatchFrames,
    getTotalBatches,
    extractSelectableObjects,
    SelectableObject,
} from './multiframe-utils';
import MultiframeTile from './multiframe-tile';

const BATCH_SIZE = 10;

interface Props {
    onClose(): void;
    initialStartFrame?: number;
    initialEndFrame?: number;
}

function MultiframeWorkspaceView(props: Props): JSX.Element {
    const { onClose, initialStartFrame, initialEndFrame } = props;
    const dispatch = useDispatch();

    const {
        jobInstance,
        currentFrame,
        activatedStateID,
        activatedElementID,
        activeFrameStates,
        frameNumbers,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        activatedStateID: state.annotation.annotations.activatedStateID,
        activatedElementID: state.annotation.annotations.activatedElementID,
        activeFrameStates: state.annotation.annotations.states,
        frameNumbers: state.annotation.job.frameNumbers,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ?
        frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ?
        frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [rangeStart, setRangeStart] = useState<number>(initialStartFrame ?? jobStartFrame);
    const [rangeEnd, setRangeEnd] = useState<number>(initialEndFrame ?? jobStopFrame);
    const [batchIndex, setBatchIndex] = useState<number>(0);

    const [inputStart, setInputStart] = useState<number | null>(initialStartFrame ?? jobStartFrame);
    const [inputEnd, setInputEnd] = useState<number | null>(initialEndFrame ?? jobStopFrame);

    // Object Selector & Auto-Zoom State
    const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
    const [autoZoomEnabled, setAutoZoomEnabled] = useState<boolean>(true);
    const [allJobStates, setAllJobStates] = useState<any[]>([]);
    const [initialFetchDone, setInitialFetchDone] = useState<boolean>(false);

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

    // Extract deduplicated selectable objects across known states
    const selectableObjects = useMemo<SelectableObject[]>(() => {
        const merged = [...allJobStates];
        if (Array.isArray(activeFrameStates)) {
            const existingIDs = new Set(merged.map((s: any) => s.clientID));
            for (const st of activeFrameStates) {
                if (!existingIDs.has(st.clientID)) {
                    merged.push(st);
                }
            }
        }
        return extractSelectableObjects(merged);
    }, [allJobStates, activeFrameStates]);

    // Clear selection if selected object is removed / no longer exists
    useEffect(() => {
        if (initialFetchDone && selectedObjectKey) {
            const exists = selectableObjects.some((o) => o.key === selectedObjectKey);
            if (!exists) {
                setSelectedObjectKey(null);
            }
        }
    }, [initialFetchDone, selectedObjectKey, selectableObjects]);

    // Initialize selection from active canvas selection if not yet chosen
    useEffect(() => {
        if (selectedObjectKey === null && (activatedStateID || activatedElementID)) {
            if (activatedElementID) {
                const match = selectableObjects.find(
                    (o) => o.parentID === activatedStateID && o.clientID === activatedElementID,
                );
                if (match) {
                    setSelectedObjectKey(match.key);
                    return;
                }
            }
            if (activatedStateID) {
                const match = selectableObjects.find(
                    (o) => o.clientID === activatedStateID && o.parentID === null,
                );
                if (match) {
                    setSelectedObjectKey(match.key);
                }
            }
        }
    }, [activatedStateID, activatedElementID, selectableObjects, selectedObjectKey]);

    // Resolve the active selected object instance
    const selectedObject = useMemo(() => {
        if (!selectedObjectKey) return null;
        const matched = selectableObjects.find((o) => o.key === selectedObjectKey);
        if (!matched) return null;
        return matched.sourceState;
    }, [selectedObjectKey, selectableObjects]);

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
    }, [initialStartFrame, initialEndFrame, hasValidFrames, jobStartFrame, jobStopFrame]);

    // Initial batch index centered on current frame if verified
    useEffect(() => {
        const curStart = initialStartFrame ?? rangeStart;
        const curEnd = initialEndFrame ?? rangeEnd;
        if (hasValidFrames) {
            const framesInRange = frameNumbers.filter((f) => f >= curStart && f <= curEnd);
            const isCurrentVerified = frameNumbers.includes(currentFrame);
            const activeIdxInRange = isCurrentVerified ? framesInRange.indexOf(currentFrame) : -1;
            const initialBatch = activeIdxInRange !== -1 ?
                Math.floor(activeIdxInRange / BATCH_SIZE) : 0;
            setBatchIndex(initialBatch);
        } else {
            setBatchIndex(0);
        }
    }, [initialStartFrame, initialEndFrame, hasValidFrames, currentFrame]);

    const validation = validateFrameRange(inputStart, inputEnd, jobStartFrame, jobStopFrame, frameNumbers);
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, BATCH_SIZE, frameNumbers);
    const batchFrames = getBatchFrames(batchIndex, rangeStart, rangeEnd, BATCH_SIZE, frameNumbers);

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

    const batchStartFrame = batchFrames.length > 0 ? batchFrames[0] : (hasValidFrames ? rangeStart : '-');
    const batchEndFrame = batchFrames.length > 0 ? batchFrames[batchFrames.length - 1] : (hasValidFrames ? rangeEnd : '-');

    return (
        <div className='cvat-multiframe-workspace-view'>
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
                        {`Batch ${totalBatches === 0 ? 0 : batchIndex + 1} of ${Math.max(1, totalBatches)} (Frames #${batchStartFrame} - #${batchEndFrame})`}
                    </Text>
                    <Button
                        size='small'
                        icon={<RightOutlined />}
                        onClick={onNextBatch}
                        disabled={batchIndex >= totalBatches - 1}
                        className='cvat-multiframe-next-batch-btn'
                    >
                        Next Batch
                    </Button>
                </div>

                {/* Object Selector & Auto-Zoom Controls */}
                <div className='cvat-multiframe-object-group'>
                    <Text strong>Object:</Text>
                    <Select
                        size='small'
                        placeholder='Select object...'
                        value={selectedObjectKey}
                        onChange={(val: string | null) => setSelectedObjectKey(val || null)}
                        allowClear
                        style={{ minWidth: 200, maxWidth: 300 }}
                        className='cvat-multiframe-object-select'
                        disabled={selectableObjects.length === 0}
                    >
                        {selectableObjects.map((obj) => (
                            <Select.Option key={obj.key} value={obj.key}>
                                {obj.displayText}
                            </Select.Option>
                        ))}
                    </Select>
                    <Checkbox
                        checked={autoZoomEnabled}
                        onChange={(e) => setAutoZoomEnabled(e.target.checked)}
                        className='cvat-multiframe-autozoom-checkbox'
                    >
                        Auto-Zoom
                    </Checkbox>
                </div>

                {/* Right: Exit button */}
                <div className='cvat-multiframe-exit-group'>
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
            {!hasValidFrames ? (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Spin size='large' />
                    <div style={{ marginTop: 16 }}>
                        <Text type='secondary'>Loading job frame numbers...</Text>
                    </div>
                </div>
            ) : batchFrames.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Text type='secondary'>No valid frames found in range [{rangeStart} .. {rangeEnd}].</Text>
                </div>
            ) : (
                <div className='cvat-multiframe-grid'>
                    {batchFrames.map((frame) => (
                        <MultiframeTile
                            key={`frame_tile_${frame}`}
                            frameNumber={frame}
                            jobInstance={jobInstance}
                            isActiveFrame={frame === currentFrame}
                            selectedObject={selectedObject}
                            autoZoomEnabled={autoZoomEnabled}
                            onNavigateToFrame={handleNavigateToFrame}
                            onFrameStatesLoaded={handleFrameStatesLoaded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default React.memo(MultiframeWorkspaceView);
