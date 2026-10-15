// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import InputNumber from 'antd/lib/input-number';
import Text from 'antd/lib/typography/Text';
import Slider from 'antd/lib/slider';
import Alert from 'antd/lib/alert';
import { AppstoreOutlined } from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { activateMultiframeWorkspace } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import { clamp } from 'utils/math';
import {
    validateMultiframeRange,
    getDefaultFrameRange,
    getFramesInRange,
    limitFrameRange,
    MAX_MULTIFRAME_FRAMES,
} from './multiframe-utils';

/** DOM node inside the sidebar tab where the Multi-Frame workspace renders its controls (React portal) */
export const MULTIFRAME_SIDEBAR_CONTROLS_ID = 'cvat-multiframe-sidebar-controls';

/**
 * Multi-Frame tab of the annotation tools sidebar.
 * Inactive: the setup form (frame range, at most MAX_MULTIFRAME_FRAMES frames) that opens the workspace.
 * Active: the container that receives the workspace controls.
 */
function MultiframeSidebarTab(): JSX.Element {
    const dispatch = useDispatch();
    const {
        multiframeActive,
        jobInstance,
        currentFrame,
        frameNumbers,
    } = useSelector((state: CombinedState) => ({
        multiframeActive: state.annotation.multiframe.active,
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        frameNumbers: state.annotation.job.frameNumbers,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ? frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ? frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [startFrame, setStartFrame] = useState<number>(jobStartFrame);
    const [endFrame, setEndFrame] = useState<number>(jobStopFrame);

    // Default: MAX_MULTIFRAME_FRAMES frames around the current frame, whenever the setup form is shown again
    useEffect(() => {
        if (!multiframeActive && hasValidFrames) {
            const [defStart, defEnd] = getDefaultFrameRange(
                currentFrame, jobStartFrame, jobStopFrame, frameNumbers, MAX_MULTIFRAME_FRAMES,
            );
            setStartFrame(defStart);
            setEndFrame(defEnd);
        }
    }, [multiframeActive, hasValidFrames, jobStartFrame, jobStopFrame, frameNumbers]);

    const validFrames: number[] = hasValidFrames ? frameNumbers : [];
    const validation = validateMultiframeRange(startFrame, endFrame, jobStartFrame, jobStopFrame, validFrames);
    const frameCount = getFramesInRange(startFrame, endFrame, validFrames).length;

    // Editing one bound moves the other one so that the range never exceeds MAX_MULTIFRAME_FRAMES frames
    const setRange = useCallback((start: number, end: number, changed: 'start' | 'end') => {
        const [limitedStart, limitedEnd] = limitFrameRange(start, end, changed, validFrames);
        setStartFrame(limitedStart);
        setEndFrame(limitedEnd);
    }, [validFrames]);

    const onOpen = useCallback(() => {
        if (validation.isValid && hasValidFrames) {
            dispatch(activateMultiframeWorkspace(true, startFrame, endFrame, frameCount));
        }
    }, [dispatch, validation.isValid, hasValidFrames, startFrame, endFrame, frameCount]);

    if (multiframeActive) {
        return <div id={MULTIFRAME_SIDEBAR_CONTROLS_ID} className='cvat-multiframe-sidebar-controls' />;
    }

    return (
        <div className='cvat-multiframe-setup-form'>
            {!hasValidFrames ? (
                <Alert type='warning' showIcon message='Job frame numbers are unavailable or loading. Please wait.' />
            ) : (
                <>
                    <Text className='cvat-multiframe-sidebar-hint'>
                        {`Frames to show (inclusive, at most ${MAX_MULTIFRAME_FRAMES}):`}
                    </Text>
                    <div className='cvat-multiframe-sidebar-row'>
                        <Text strong>Start</Text>
                        <InputNumber
                            size='small'
                            min={jobStartFrame}
                            max={jobStopFrame}
                            value={startFrame}
                            precision={0}
                            onChange={(val: number | null) => {
                                if (typeof val === 'number') setRange(val, endFrame, 'start');
                            }}
                            className='cvat-multiframe-setup-start-input'
                        />
                        <Text strong>End</Text>
                        <InputNumber
                            size='small'
                            min={jobStartFrame}
                            max={jobStopFrame}
                            value={endFrame}
                            precision={0}
                            onChange={(val: number | null) => {
                                if (typeof val === 'number') setRange(startFrame, val, 'end');
                            }}
                            className='cvat-multiframe-setup-end-input'
                        />
                    </div>
                    <Slider
                        range
                        min={jobStartFrame}
                        max={jobStopFrame}
                        value={[
                            clamp(startFrame, jobStartFrame, jobStopFrame),
                            clamp(endFrame, jobStartFrame, jobStopFrame),
                        ]}
                        onChange={([val1, val2]: number[]) => {
                            setRange(val1, val2, val1 !== startFrame ? 'start' : 'end');
                        }}
                    />
                    <Text type='secondary' className='cvat-multiframe-setup-count'>
                        {`${frameCount} frame(s) selected`}
                    </Text>
                </>
            )}

            {!validation.isValid && validation.error && (
                <Alert type='error' showIcon message={validation.error} style={{ marginTop: 8 }} />
            )}

            <Button
                type='primary'
                icon={<AppstoreOutlined />}
                disabled={!validation.isValid || !hasValidFrames}
                onClick={onOpen}
                className='cvat-multiframe-open-btn'
                style={{ marginTop: 12 }}
            >
                Open Multi-Frame
            </Button>
        </div>
    );
}

export default React.memo(MultiframeSidebarTab);
