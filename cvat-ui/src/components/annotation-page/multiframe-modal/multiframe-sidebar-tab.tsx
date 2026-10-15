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
    getDefaultFrameRange,
    getFrameWindow,
    MIN_MULTIFRAME_FRAMES,
    MAX_MULTIFRAME_FRAMES,
} from './multiframe-utils';

/** DOM node inside the sidebar tab where the Multi-Frame workspace renders its controls (React portal) */
export const MULTIFRAME_SIDEBAR_CONTROLS_ID = 'cvat-multiframe-sidebar-controls';

/**
 * Multi-Frame tab of the annotation tools sidebar.
 * Inactive: the setup form (number of frames and start frame) that opens the Multi-Frame workspace.
 * Active: the container that receives the workspace controls.
 */
function MultiframeSidebarTab(): JSX.Element {
    const dispatch = useDispatch();
    const {
        multiframeActive,
        currentFrame,
        frameNumbers,
    } = useSelector((state: CombinedState) => ({
        multiframeActive: state.annotation.multiframe.active,
        currentFrame: state.annotation.player.frame.number,
        frameNumbers: state.annotation.job.frameNumbers,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const validFrames: number[] = hasValidFrames ? frameNumbers : [];
    const jobStartFrame = hasValidFrames ? frameNumbers[0] : 0;
    const jobStopFrame = hasValidFrames ? frameNumbers[frameNumbers.length - 1] : 0;

    const [frameCount, setFrameCount] = useState<number>(MAX_MULTIFRAME_FRAMES);
    const [startFrame, setStartFrame] = useState<number>(jobStartFrame);

    // The window always holds frameCount job frames: the end frame follows the start frame
    const [windowStart, windowEnd] = getFrameWindow(startFrame, frameCount, validFrames);
    // The last start frame that still leaves frameCount frames
    const [maxStartFrame] = getFrameWindow(jobStopFrame, frameCount, validFrames);

    // Default: the window around the current frame, whenever the setup form is shown again
    useEffect(() => {
        if (!multiframeActive && hasValidFrames) {
            const [defStart] = getDefaultFrameRange(
                currentFrame, jobStartFrame, jobStopFrame, frameNumbers, frameCount,
            );
            setStartFrame(defStart);
        }
    }, [multiframeActive, hasValidFrames, jobStartFrame, jobStopFrame, frameNumbers]);

    const onChangeStart = useCallback((value: number) => {
        // snap to a job frame and keep a full window
        setStartFrame(getFrameWindow(value, frameCount, validFrames)[0]);
    }, [frameCount, validFrames]);

    const onChangeCount = useCallback((value: number) => {
        const count = clamp(Math.round(value), MIN_MULTIFRAME_FRAMES, MAX_MULTIFRAME_FRAMES);
        setFrameCount(count);
        setStartFrame((prev) => getFrameWindow(prev, count, validFrames)[0]);
    }, [validFrames]);

    const onOpen = useCallback(() => {
        if (hasValidFrames) {
            dispatch(activateMultiframeWorkspace(true, windowStart, windowEnd, frameCount));
        }
    }, [dispatch, hasValidFrames, windowStart, windowEnd, frameCount]);

    if (multiframeActive) {
        return <div id={MULTIFRAME_SIDEBAR_CONTROLS_ID} className='cvat-multiframe-sidebar-controls' />;
    }

    if (!hasValidFrames) {
        return (
            <div className='cvat-multiframe-setup-form'>
                <Alert type='warning' showIcon message='Job frame numbers are unavailable or loading. Please wait.' />
            </div>
        );
    }

    return (
        <div className='cvat-multiframe-setup-form'>
            <div className='cvat-multiframe-sidebar-row'>
                <Text strong>{`Number of frames (${MIN_MULTIFRAME_FRAMES}-${MAX_MULTIFRAME_FRAMES})`}</Text>
                <InputNumber
                    size='small'
                    min={MIN_MULTIFRAME_FRAMES}
                    max={MAX_MULTIFRAME_FRAMES}
                    value={frameCount}
                    precision={0}
                    onChange={(val: number | null) => {
                        if (typeof val === 'number') onChangeCount(val);
                    }}
                    className='cvat-multiframe-count-input'
                />
            </div>
            <Slider
                min={MIN_MULTIFRAME_FRAMES}
                max={MAX_MULTIFRAME_FRAMES}
                value={frameCount}
                onChange={(val: number) => onChangeCount(val)}
                className='cvat-multiframe-count-slider'
            />

            <div className='cvat-multiframe-sidebar-row'>
                <Text strong>Start frame</Text>
                <InputNumber
                    size='small'
                    min={jobStartFrame}
                    max={maxStartFrame}
                    value={windowStart}
                    precision={0}
                    onChange={(val: number | null) => {
                        if (typeof val === 'number') onChangeStart(val);
                    }}
                    className='cvat-multiframe-setup-start-input'
                />
                <Button size='small' onClick={() => onChangeStart(currentFrame)} title='Start at the current frame'>
                    Current
                </Button>
            </div>
            <Slider
                min={jobStartFrame}
                max={Math.max(jobStartFrame, maxStartFrame)}
                value={windowStart}
                onChange={(val: number) => onChangeStart(val)}
                className='cvat-multiframe-start-slider'
            />

            <Text type='secondary' className='cvat-multiframe-setup-window'>
                {`Frames #${windowStart} - #${windowEnd}`}
            </Text>

            <Button
                type='primary'
                icon={<AppstoreOutlined />}
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
