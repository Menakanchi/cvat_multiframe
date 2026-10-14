// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'antd/lib/modal';
import InputNumber from 'antd/lib/input-number';
import Text from 'antd/lib/typography/Text';
import { Row, Col } from 'antd/lib/grid';
import Slider from 'antd/lib/slider';
import Alert from 'antd/lib/alert';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal, activateMultiframeWorkspace } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import { clamp } from 'utils/math';
import {
    validateFrameRange,
    getDefaultFrameRange,
} from './multiframe-utils';

interface Props {
    onConfirm?(startFrame: number, endFrame: number): void;
}

function MultiframeConfigModal(props: Props): JSX.Element {
    const { onConfirm } = props;
    const dispatch = useDispatch();

    const {
        visible,
        jobInstance,
        currentFrame,
        frameNumbers,
    } = useSelector((state: CombinedState) => ({
        visible: state.annotation.multiframe.visible,
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        frameNumbers: state.annotation.job.frameNumbers,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ?
        frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ?
        frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [startFrame, setStartFrame] = useState<number>(jobStartFrame);
    const [endFrame, setEndFrame] = useState<number>(jobStopFrame);

    useEffect(() => {
        if (visible && hasValidFrames) {
            const [defStart, defEnd] = getDefaultFrameRange(
                currentFrame,
                jobStartFrame,
                jobStopFrame,
                frameNumbers,
            );
            setStartFrame(defStart);
            setEndFrame(defEnd);
        }
    }, [visible, currentFrame, jobStartFrame, jobStopFrame, frameNumbers, hasValidFrames]);

    const validation = validateFrameRange(startFrame, endFrame, jobStartFrame, jobStopFrame, frameNumbers);

    const onCancel = useCallback(() => {
        dispatch(switchShowMultiframeModal(false));
    }, [dispatch]);

    const onOk = useCallback(() => {
        if (validation.isValid && hasValidFrames) {
            dispatch(switchShowMultiframeModal(false));
            dispatch(activateMultiframeWorkspace(true, startFrame, endFrame));
            if (onConfirm) {
                onConfirm(startFrame, endFrame);
            }
        }
    }, [dispatch, validation.isValid, hasValidFrames, startFrame, endFrame, onConfirm]);

    return (
        <Modal
            className='cvat-multiframe-config-modal'
            title='Multi-Frame Verification Setup'
            open={visible}
            okType='primary'
            okText='Yes'
            cancelText='Cancel'
            onOk={onOk}
            onCancel={onCancel}
            destroyOnClose
            okButtonProps={{ disabled: !validation.isValid || !hasValidFrames }}
        >
            <div className='cvat-multiframe-config-content'>
                {!hasValidFrames ? (
                    <Row style={{ marginBottom: 16 }}>
                        <Col span={24}>
                            <Alert
                                type='warning'
                                showIcon
                                message='Job frame numbers are unavailable or loading. Please wait.'
                            />
                        </Col>
                    </Row>
                ) : (
                    <>
                        <Row style={{ marginBottom: 16 }}>
                            <Col span={24}>
                                <Text>
                                    Specify the inclusive frame range to display in the central workspace:
                                </Text>
                            </Col>
                        </Row>

                        <Row gutter={16} align='middle' style={{ marginBottom: 16 }}>
                            <Col span={6}>
                                <Text strong>Start frame:</Text>
                            </Col>
                            <Col span={6}>
                                <InputNumber
                                    size='small'
                                    min={jobStartFrame}
                                    max={jobStopFrame}
                                    value={startFrame}
                                    precision={0}
                                    onChange={(val: number | null) => {
                                        if (typeof val === 'number') {
                                            setStartFrame(val);
                                        }
                                    }}
                                />
                            </Col>
                            <Col span={6}>
                                <Text strong>End frame:</Text>
                            </Col>
                            <Col span={6}>
                                <InputNumber
                                    size='small'
                                    min={jobStartFrame}
                                    max={jobStopFrame}
                                    value={endFrame}
                                    precision={0}
                                    onChange={(val: number | null) => {
                                        if (typeof val === 'number') {
                                            setEndFrame(val);
                                        }
                                    }}
                                />
                            </Col>
                        </Row>

                        <Row style={{ marginBottom: 16 }}>
                            <Col span={24}>
                                <Slider
                                    range
                                    min={jobStartFrame}
                                    max={jobStopFrame}
                                    value={[
                                        clamp(startFrame, jobStartFrame, jobStopFrame),
                                        clamp(endFrame, jobStartFrame, jobStopFrame),
                                    ]}
                                    onChange={([val1, val2]: number[]) => {
                                        setStartFrame(val1);
                                        setEndFrame(val2);
                                    }}
                                />
                            </Col>
                        </Row>
                    </>
                )}

                {!validation.isValid && validation.error && (
                    <Row>
                        <Col span={24}>
                            <Alert
                                type='error'
                                showIcon
                                message={validation.error}
                            />
                        </Col>
                    </Row>
                )}
            </div>
        </Modal>
    );
}

export default React.memo(MultiframeConfigModal);
