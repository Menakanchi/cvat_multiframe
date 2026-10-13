// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export interface FrameRangeValidation {
    isValid: boolean;
    error: string | null;
}

export function validateFrameRange(
    startFrame: number | null | undefined,
    endFrame: number | null | undefined,
    jobStartFrame: number,
    jobStopFrame: number,
): FrameRangeValidation {
    if (startFrame === null || startFrame === undefined || !Number.isInteger(startFrame)) {
        return { isValid: false, error: 'Start frame must be a valid integer' };
    }
    if (endFrame === null || endFrame === undefined || !Number.isInteger(endFrame)) {
        return { isValid: false, error: 'End frame must be a valid integer' };
    }
    if (startFrame < jobStartFrame) {
        return {
            isValid: false,
            error: `Start frame (${startFrame}) cannot be less than job start frame (${jobStartFrame})`,
        };
    }
    if (endFrame > jobStopFrame) {
        return {
            isValid: false,
            error: `End frame (${endFrame}) cannot exceed job stop frame (${jobStopFrame})`,
        };
    }
    if (startFrame > endFrame) {
        return {
            isValid: false,
            error: `Start frame (${startFrame}) cannot be greater than end frame (${endFrame})`,
        };
    }
    return { isValid: true, error: null };
}

export function getDefaultFrameRange(
    currentFrame: number,
    jobStartFrame: number,
    jobStopFrame: number,
): [number, number] {
    const clampedCurrent = Math.max(jobStartFrame, Math.min(jobStopFrame, currentFrame));
    const start = Math.max(jobStartFrame, clampedCurrent - 4);
    const end = Math.min(jobStopFrame, Math.max(start, clampedCurrent + 5));
    return [start, end];
}
