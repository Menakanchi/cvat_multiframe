// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';

import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'antd/lib/modal';
import InputNumber from 'antd/lib/input-number';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Tag from 'antd/lib/tag';
import Alert from 'antd/lib/alert';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal, changeFrameAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import {
    validateFrameRange,
    getDefaultFrameRange,
    getBatchFrames,
    getTotalBatches,
} from './multiframe-utils';
import MultiframeTile from './multiframe-tile';

const BATCH_SIZE = 10;

function MultiframeModal(): JSX.Element {
    const dispatch = useDispatch();
    const {
        visible,
        jobInstance,
        currentFrame,
        activatedStateID,
        activatedElementID,
        activeFrameStates,
    } = useSelector((state: CombinedState) => ({
        visible: state.annotation.multiframe.visible,
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        activatedStateID: state.annotation.annotations.activatedStateID,
        activatedElementID: state.annotation.annotations.activatedElementID,
        activeFrameStates: state.annotation.annotations.states,
    }), shallowEqual);

    const jobStartFrame = jobInstance?.startFrame ?? 0;
    const jobStopFrame = jobInstance?.stopFrame ?? 0;

    const [rangeStart, setRangeStart] = useState<number>(jobStartFrame);
    const [rangeEnd, setRangeEnd] = useState<number>(jobStopFrame);
    const [batchIndex, setBatchIndex] = useState<number>(0);

    const [inputStart, setInputStart] = useState<number | null>(jobStartFrame);
    const [inputEnd, setInputEnd] = useState<number | null>(jobStopFrame);

    // Initialize or reset view range and batch index when modal opens
    useEffect(() => {
        if (visible) {
            const [defStart, defEnd] = getDefaultFrameRange(currentFrame, jobStartFrame, jobStopFrame);
            setRangeStart(defStart);
            setRangeEnd(defEnd);
            setInputStart(defStart);
            setInputEnd(defEnd);

            // Center initial batch on the active player frame
            const initialBatch = Math.floor(Math.max(0, currentFrame - defStart) / BATCH_SIZE);
            setBatchIndex(initialBatch);
        }
    }, [visible, currentFrame, jobStartFrame, jobStopFrame]);

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

    const validation = validateFrameRange(inputStart, inputEnd, jobStartFrame, jobStopFrame);
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, BATCH_SIZE);
    const batchFrames = getBatchFrames(batchIndex, rangeStart, rangeEnd, BATCH_SIZE);

    const onCancel = useCallback(() => {
        dispatch(switchShowMultiframeModal(false));
    }, [dispatch]);

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

    const batchStartFrame = rangeStart + batchIndex * BATCH_SIZE;
    const batchEndFrame = Math.min(rangeEnd, batchStartFrame + BATCH_SIZE - 1);

    return (
        <Modal
            className='cvat-multiframe-modal'
            title='Multi-Frame Landmark Verification'
            open={visible}
            onCancel={onCancel}
            destroyOnClose
            width='96vw'
            style={{ top: 20, maxWidth: 1650 }}
            footer={[
                <Button key='close' type='primary' onClick={onCancel} className='cvat-multiframe-close-btn'>
                    Close (Esc)
                </Button>,
            ]}
        >
            {/* Controls Bar */}
            <div className='cvat-multiframe-controls-bar'>
                {/* Range inputs */}
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

                {/* Batch Pagination */}
                <div className='cvat-multiframe-batch-group'>
                    <Button
                        size='small'
                        onClick={onPrevBatch}
                        disabled={batchIndex === 0}
                        className='cvat-multiframe-prev-batch-btn'
                    >
                        &lt; Prev Batch
                    </Button>
                    <Text strong className='cvat-multiframe-batch-indicator'>
                        {`Batch ${batchIndex + 1} of ${Math.max(1, totalBatches)} (Frames #${batchStartFrame} - #${batchEndFrame})`}
                    </Text>
                    <Button
                        size='small'
                        onClick={onNextBatch}
                        disabled={batchIndex >= totalBatches - 1}
                        className='cvat-multiframe-next-batch-btn'
                    >
                        Next Batch &gt;
                    </Button>
                </div>

                {/* Selected Target Landmark Info */}
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
                            No landmark selected (select on active canvas to highlight counterpart)
                        </Text>
                    )}
                </div>
            </div>

            {/* Inline validation error if user types invalid range */}
            {!validation.isValid && validation.error && (
                <Alert
                    type='error'
                    showIcon
                    message={validation.error}
                    style={{ marginBottom: 10 }}
                    className='cvat-multiframe-error-alert'
                />
            )}

            {/* Up to 10 Frame Tiles Grid */}
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
        </Modal>
    );
}

export default React.memo(MultiframeModal);
