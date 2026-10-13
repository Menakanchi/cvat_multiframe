// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Modal from 'antd/lib/modal';
import InputNumber from 'antd/lib/input-number';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Paragraph from 'antd/lib/typography/Paragraph';
import Row from 'antd/lib/grid/row';
import Col from 'antd/lib/grid/col';
import Alert from 'antd/lib/alert';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import { validateFrameRange, getDefaultFrameRange } from './multiframe-utils';

function MultiframeModal(): JSX.Element {
    const dispatch = useDispatch();
    const {
        visible,
        jobInstance,
        currentFrame,
    } = useSelector((state: CombinedState) => ({
        visible: state.annotation.multiframe.visible,
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
    }), shallowEqual);

    const jobStartFrame = jobInstance?.startFrame ?? 0;
    const jobStopFrame = jobInstance?.stopFrame ?? 0;

    const [startFrameInput, setStartFrameInput] = useState<number | null>(jobStartFrame);
    const [endFrameInput, setEndFrameInput] = useState<number | null>(jobStopFrame);

    // Initialize or reset input range whenever modal opens
    useEffect(() => {
        if (visible) {
            const [defStart, defEnd] = getDefaultFrameRange(currentFrame, jobStartFrame, jobStopFrame);
            setStartFrameInput(defStart);
            setEndFrameInput(defEnd);
        }
    }, [visible, currentFrame, jobStartFrame, jobStopFrame]);

    const validation = validateFrameRange(startFrameInput, endFrameInput, jobStartFrame, jobStopFrame);

    const onCancel = useCallback(() => {
        dispatch(switchShowMultiframeModal(false));
    }, [dispatch]);

    const onApply = useCallback(() => {
        if (!validation.isValid) {
            return;
        }
        // Milestone B1: Modal shell and validation only.
        // Applies validated range non-destructively without mutating annotations or moving the player frame.
        dispatch(switchShowMultiframeModal(false));
    }, [validation.isValid, dispatch]);

    return (
        <Modal
            className='cvat-multiframe-modal'
            title='Multi-Frame Verification'
            open={visible}
            onCancel={onCancel}
            destroyOnClose
            width={520}
            footer={[
                <Button key='cancel' onClick={onCancel} className='cvat-multiframe-cancel-btn'>
                    Cancel
                </Button>,
                <Button
                    key='apply'
                    type='primary'
                    disabled={!validation.isValid}
                    onClick={onApply}
                    className='cvat-multiframe-apply-btn'
                >
                    Apply
                </Button>,
            ]}
        >
            <Paragraph type='secondary'>
                Specify an inclusive frame range for multi-frame object verification and landmark inspection.
            </Paragraph>
            <div style={{ marginBottom: 16 }}>
                <Text strong>Job Frame Bounds: </Text>
                <Text code>{`[${jobStartFrame} .. ${jobStopFrame}]`}</Text>
                <span style={{ marginLeft: 16 }}>
                    <Text strong>Current Frame: </Text>
                    <Text code>{`#${currentFrame}`}</Text>
                </span>
            </div>

            <Row gutter={16} align='middle'>
                <Col span={12}>
                    <div>
                        <Text>Start Frame:</Text>
                    </div>
                    <InputNumber
                        className='cvat-multiframe-start-input'
                        style={{ width: '100%', marginTop: 4 }}
                        value={startFrameInput}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(value: number | null) => {
                            setStartFrameInput(value);
                        }}
                    />
                </Col>
                <Col span={12}>
                    <div>
                        <Text>End Frame:</Text>
                    </div>
                    <InputNumber
                        className='cvat-multiframe-end-input'
                        style={{ width: '100%', marginTop: 4 }}
                        value={endFrameInput}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(value: number | null) => {
                            setEndFrameInput(value);
                        }}
                    />
                </Col>
            </Row>

            {!validation.isValid && validation.error && (
                <Alert
                    type='error'
                    showIcon
                    message={validation.error}
                    style={{ marginTop: 16 }}
                    className='cvat-multiframe-error-alert'
                />
            )}
        </Modal>
    );
}

export default React.memo(MultiframeModal);
