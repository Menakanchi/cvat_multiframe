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
import { CloseOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal, changeFrameAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    validateFrameRange,
    getBatchFrames,
    getTotalBatches,
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

    const jobStartFrame = Array.isArray(frameNumbers) && frameNumbers.length > 0 ?
        frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = Array.isArray(frameNumbers) && frameNumbers.length > 0 ?
        frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [rangeStart, setRangeStart] = useState<number>(initialStartFrame ?? jobStartFrame);
    const [rangeEnd, setRangeEnd] = useState<number>(initialEndFrame ?? jobStopFrame);
    const [batchIndex, setBatchIndex] = useState<number>(0);

    const [inputStart, setInputStart] = useState<number | null>(initialStartFrame ?? jobStartFrame);
    const [inputEnd, setInputEnd] = useState<number | null>(initialEndFrame ?? jobStopFrame);

    useEffect(() => {
        if (typeof initialStartFrame === 'number') {
            setRangeStart(initialStartFrame);
            setInputStart(initialStartFrame);
        }
        if (typeof initialEndFrame === 'number') {
            setRangeEnd(initialEndFrame);
            setInputEnd(initialEndFrame);
        }
    }, [initialStartFrame, initialEndFrame]);

    // Initial batch index centered on current frame
    useEffect(() => {
        const curStart = initialStartFrame ?? rangeStart;
        const curEnd = initialEndFrame ?? rangeEnd;
        if (Array.isArray(frameNumbers) && frameNumbers.length > 0) {
            const framesInRange = frameNumbers.filter((f) => f >= curStart && f <= curEnd);
            const activeIdxInRange = framesInRange.indexOf(currentFrame);
            const initialBatch = activeIdxInRange !== -1 ?
                Math.floor(activeIdxInRange / BATCH_SIZE) : 0;
            setBatchIndex(initialBatch);
        } else {
            const initialBatch = Math.floor(Math.max(0, currentFrame - curStart) / BATCH_SIZE);
            setBatchIndex(initialBatch);
        }
    }, [initialStartFrame, initialEndFrame]);

    // Resolve the active landmark or track selected by the annotator on the main canvas
    const selectedObject = useMemo(() => {
        if (!activatedStateID && !activatedElementID) return null;
        if (!Array.isArray(activeFrameStates) || activeFrameStates.length === 0) return null;

        const parentState = activeFrameStates.find((s: any) => s.clientID === activatedStateID);
        if (!parentState) return null;

        if (activatedElementID && parentState.shapeType === 'skeleton' && Array.isArray(parentState.elements)) {
            const element = parentState.elements.find((el: any) => el.clientID === activatedElementID);
            if (element) {
                return element;
            }
        }
        return parentState;
    }, [activatedStateID, activatedElementID, activeFrameStates]);

    const validation = validateFrameRange(inputStart, inputEnd, jobStartFrame, jobStopFrame, frameNumbers);
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, BATCH_SIZE, frameNumbers);
    const batchFrames = getBatchFrames(batchIndex, rangeStart, rangeEnd, BATCH_SIZE, frameNumbers);

    const onUpdateRange = useCallback(() => {
        if (validation.isValid && inputStart !== null && inputEnd !== null) {
            setRangeStart(inputStart);
            setRangeEnd(inputEnd);
            setBatchIndex(0);
        }
    }, [validation.isValid, inputStart, inputEnd]);

    const onPrevBatch = useCallback(() => {
        setBatchIndex((idx) => Math.max(0, idx - 1));
    }, []);

    const onNextBatch = useCallback(() => {
        setBatchIndex((idx) => Math.min(totalBatches - 1, idx + 1));
    }, [totalBatches]);

    const handleNavigateToFrame = useCallback((frame: number) => {
        dispatch(changeFrameAsync(frame));
    }, [dispatch]);

    const batchStartFrame = batchFrames.length > 0 ? batchFrames[0] : rangeStart;
    const batchEndFrame = batchFrames.length > 0 ? batchFrames[batchFrames.length - 1] : rangeEnd;

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
                        disabled={!validation.isValid}
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
                        {`Batch ${batchIndex + 1} of ${Math.max(1, totalBatches)} (Frames #${batchStartFrame} - #${batchEndFrame})`}
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

                {/* Right: Target Landmark & Exit button */}
                <div className='cvat-multiframe-target-info'>
                    <Text strong>Target: </Text>
                    {selectedObject ? (
                        <Tag color='cyan'>
                            {selectedObject.parentID !== null && selectedObject.parentID !== undefined ? (
                                `Skeleton #${selectedObject.parentID} [${selectedObject.label?.name || 'Landmark'}]`
                            ) : (
                                `Track #${selectedObject.clientID} [${selectedObject.label?.name || 'Object'}]`
                            )}
                        </Tag>
                    ) : (
                        <Text type='secondary'>
                            No landmark selected
                        </Text>
                    )}
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

            {/* Multi-Frame Grid of Tiles */}
            <div className='cvat-multiframe-grid'>
                {batchFrames.map((frame) => (
                    <MultiframeTile
                        key={`frame_tile_${frame}`}
                        frameNumber={frame}
                        jobInstance={jobInstance}
                        isActiveFrame={frame === currentFrame}
                        selectedObject={selectedObject}
                        onNavigateToFrame={handleNavigateToFrame}
                    />
                ))}
            </div>
        </div>
    );
}

export default React.memo(MultiframeWorkspaceView);
