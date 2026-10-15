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
    validFrameNumbers?: number[],
): FrameRangeValidation {
    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) {
            return { isValid: false, error: 'Job frame numbers are unavailable' };
        }
        if (startFrame === null || startFrame === undefined || !Number.isInteger(startFrame)) {
            return { isValid: false, error: 'Start frame must be a valid integer' };
        }
        if (endFrame === null || endFrame === undefined || !Number.isInteger(endFrame)) {
            return { isValid: false, error: 'End frame must be a valid integer' };
        }
        const minFrame = validFrameNumbers[0];
        const maxFrame = validFrameNumbers[validFrameNumbers.length - 1];
        if (startFrame < minFrame) {
            return {
                isValid: false,
                error: `Start frame (${startFrame}) cannot be less than job start frame (${minFrame})`,
            };
        }
        if (endFrame > maxFrame) {
            return {
                isValid: false,
                error: `End frame (${endFrame}) cannot exceed job stop frame (${maxFrame})`,
            };
        }
        if (startFrame > endFrame) {
            return {
                isValid: false,
                error: `Start frame (${startFrame}) cannot be greater than end frame (${endFrame})`,
            };
        }
        const hasValidInRequestedRange = validFrameNumbers.some(
            (fn) => fn >= startFrame && fn <= endFrame,
        );
        if (!hasValidInRequestedRange) {
            return {
                isValid: false,
                error: `No valid frames belonging to this job in range [${startFrame}, ${endFrame}]`,
            };
        }
        return { isValid: true, error: null };
    }

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
    validFrameNumbers?: number[],
    maxFrames = 16,
): [number, number] {
    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) {
            return [0, 0];
        }
        const currentIndex = validFrameNumbers.indexOf(currentFrame);
        const resolvedIdx = currentIndex !== -1 ? currentIndex : (() => {
            let closestIdx = 0;
            let minDiff = Infinity;
            for (let i = 0; i < validFrameNumbers.length; i++) {
                const diff = Math.abs(validFrameNumbers[i] - currentFrame);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIdx = i;
                }
            }
            return closestIdx;
        })();

        const half = Math.floor(maxFrames / 2);
        let startIdx = Math.max(0, resolvedIdx - half);
        const endIdx = Math.min(validFrameNumbers.length - 1, startIdx + maxFrames - 1);
        if (endIdx - startIdx + 1 < maxFrames && startIdx > 0) {
            startIdx = Math.max(0, endIdx - maxFrames + 1);
        }
        return [validFrameNumbers[startIdx], validFrameNumbers[endIdx]];
    }

    const clampedCurrent = Math.max(jobStartFrame, Math.min(jobStopFrame, currentFrame));
    const half = Math.floor(maxFrames / 2);
    let start = Math.max(jobStartFrame, clampedCurrent - half);
    const end = Math.min(jobStopFrame, start + maxFrames - 1);
    if (end - start + 1 < maxFrames && start > jobStartFrame) {
        start = Math.max(jobStartFrame, end - maxFrames + 1);
    }
    return [start, end];
}

/** The Multi-Frame workspace shows at most this many frames at once */
export const MAX_MULTIFRAME_FRAMES = 10;
/** The Multi-Frame setup lets the user choose at least this many frames */
export const MIN_MULTIFRAME_FRAMES = 2;

/**
 * Window of `count` job frames that starts at `startFrame` (snapped to the next job frame).
 * Near the end of the job the start moves back so that the window keeps `count` frames.
 */
export function getFrameWindow(startFrame: number, count: number, validFrameNumbers: number[]): [number, number] {
    const frames = [...validFrameNumbers].sort((a, b) => a - b);
    if (!frames.length) return [startFrame, startFrame];
    const size = Math.max(1, Math.min(frames.length, Math.round(count)));
    let startIdx = frames.findIndex((frame) => frame >= startFrame);
    if (startIdx === -1) startIdx = frames.length - 1;
    startIdx = Math.min(startIdx, frames.length - size);
    return [frames[startIdx], frames[startIdx + size - 1]];
}

/** Job frames inside the inclusive range, ascending */
export function getFramesInRange(startFrame: number, endFrame: number, validFrameNumbers: number[]): number[] {
    return validFrameNumbers.filter((frame) => frame >= startFrame && frame <= endFrame).sort((a, b) => a - b);
}

/**
 * Keeps an inclusive range within maxFrames job frames: the edited bound is kept
 * and the other bound is moved towards it.
 */
export function limitFrameRange(
    startFrame: number,
    endFrame: number,
    changed: 'start' | 'end',
    validFrameNumbers: number[],
    maxFrames = MAX_MULTIFRAME_FRAMES,
): [number, number] {
    const frames = [...validFrameNumbers].sort((a, b) => a - b);
    if (!frames.length || startFrame > endFrame || getFramesInRange(startFrame, endFrame, frames).length <= maxFrames) {
        return [startFrame, endFrame];
    }
    if (changed === 'start') {
        const startIdx = frames.findIndex((frame) => frame >= startFrame);
        return [startFrame, frames[Math.min(frames.length - 1, startIdx + maxFrames - 1)]];
    }
    let endIdx = frames.length - 1;
    while (endIdx > 0 && frames[endIdx] > endFrame) endIdx--;
    return [frames[Math.max(0, endIdx - maxFrames + 1)], endFrame];
}

/** validateFrameRange plus the Multi-Frame limit of maxFrames job frames */
export function validateMultiframeRange(
    startFrame: number | null | undefined,
    endFrame: number | null | undefined,
    jobStartFrame: number,
    jobStopFrame: number,
    validFrameNumbers: number[],
    maxFrames = MAX_MULTIFRAME_FRAMES,
): FrameRangeValidation {
    const validation = validateFrameRange(startFrame, endFrame, jobStartFrame, jobStopFrame, validFrameNumbers);
    if (!validation.isValid) return validation;
    const count = getFramesInRange(startFrame as number, endFrame as number, validFrameNumbers).length;
    if (count > maxFrames) {
        return { isValid: false, error: `At most ${maxFrames} frames can be shown (this range has ${count})` };
    }
    return validation;
}

/**
 * The next (+1) or previous (-1) window with the same number of job frames
 * (clamped to the job bounds), or null when there are no more frames in that direction.
 */
export function shiftFrameWindow(
    startFrame: number,
    endFrame: number,
    direction: 1 | -1,
    validFrameNumbers: number[],
): [number, number] | null {
    const frames = [...validFrameNumbers].sort((a, b) => a - b);
    const current = getFramesInRange(startFrame, endFrame, frames);
    if (!current.length) return null;
    const size = current.length;
    const startIdx = frames.indexOf(current[0]);
    const endIdx = frames.indexOf(current[current.length - 1]);
    // keep the window size: near the job bounds the window stops at the first / last frame
    if (direction === 1) {
        if (endIdx + 1 >= frames.length) return null;
        const newEndIdx = Math.min(frames.length - 1, endIdx + size);
        return [frames[Math.max(0, newEndIdx - size + 1)], frames[newEndIdx]];
    }
    if (startIdx - 1 < 0) return null;
    const newStartIdx = Math.max(0, startIdx - size);
    return [frames[newStartIdx], frames[Math.min(frames.length - 1, newStartIdx + size - 1)]];
}

export interface GridLayout {
    rows: number;
    columns: number;
    cellWidth: number;
    cellHeight: number;
}

/**
 * Even grid for `count` frames inside the container: tries every number of rows and keeps the one
 * with the largest cells (cells keep the frame aspect ratio), e.g. 2 frames on a wide screen -> 1 row,
 * 10 frames -> 2 rows of 5.
 */
export function calculateGridLayout(
    count: number,
    containerWidth: number,
    containerHeight: number,
    frameAspect: number,
    gap = 0,
): GridLayout {
    const empty = {
        rows: 1, columns: Math.max(1, count), cellWidth: 0, cellHeight: 0,
    };
    if (count <= 0 || containerWidth <= 0 || containerHeight <= 0 || !(frameAspect > 0)) return empty;

    // Full grids (every row complete) are preferred: an incomplete last row is used only when
    // its cells are clearly (more than 10%) larger, e.g. 7 frames -> 4 + 3 instead of a single row
    let bestFull = empty;
    let bestAny = empty;
    for (let rows = 1; rows <= count; rows++) {
        const columns = Math.ceil(count / rows);
        // skip layouts that leave a whole row empty
        if (Math.ceil(count / columns) === rows) {
            let cellWidth = (containerWidth - gap * (columns - 1)) / columns;
            let cellHeight = cellWidth / frameAspect;
            const maxCellHeight = (containerHeight - gap * (rows - 1)) / rows;
            if (cellHeight > maxCellHeight) {
                cellHeight = maxCellHeight;
                cellWidth = cellHeight * frameAspect;
            }
            cellWidth = Math.floor(cellWidth);
            cellHeight = Math.floor(cellHeight);
            const layout = {
                rows, columns, cellWidth, cellHeight,
            };
            if (cellWidth > 0 && cellHeight > 0) {
                if (cellWidth > bestAny.cellWidth) bestAny = layout;
                if (count % columns === 0 && cellWidth > bestFull.cellWidth) bestFull = layout;
            }
        }
    }
    const best = bestAny.cellWidth > bestFull.cellWidth * 1.1 ? bestAny : bestFull;
    return best;
}

export function getTotalBatches(
    rangeStart: number,
    rangeEnd: number,
    batchSize = 10,
    validFrameNumbers?: number[],
): number {
    if (batchSize <= 0) return 0;

    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) return 0;
        const framesInRange = validFrameNumbers.filter((f) => f >= rangeStart && f <= rangeEnd);
        if (framesInRange.length === 0) return 0;
        return Math.ceil(framesInRange.length / batchSize);
    }

    const totalFrames = rangeEnd - rangeStart + 1;
    if (totalFrames <= 0) return 0;
    return Math.ceil(totalFrames / batchSize);
}

export function getBatchFrames(
    batchIndex: number,
    rangeStart: number,
    rangeEnd: number,
    batchSize = 10,
    validFrameNumbers?: number[],
): number[] {
    if (batchIndex < 0 || batchSize <= 0) return [];

    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) return [];
        const framesInRange = validFrameNumbers
            .filter((f) => f >= rangeStart && f <= rangeEnd)
            .sort((a, b) => a - b);
        const startIdx = batchIndex * batchSize;
        if (startIdx >= framesInRange.length) return [];
        const endIdx = Math.min(framesInRange.length, startIdx + batchSize);
        return framesInRange.slice(startIdx, endIdx);
    }

    if (rangeStart > rangeEnd) return [];
    const totalFrames = rangeEnd - rangeStart + 1;
    const startIdx = batchIndex * batchSize;
    if (startIdx >= totalFrames) return [];

    const start = rangeStart + startIdx;
    const end = Math.min(rangeEnd, start + batchSize - 1);
    const frames: number[] = [];
    for (let f = start; f <= end; f++) {
        frames.push(f);
    }
    return frames;
}

export type ResolutionStatus =
    | 'MATCHED'
    | 'ABSENT_ON_FRAME'
    | 'SKELETON_ABSENT'
    | 'NO_IDENTITY'
    | 'NO_SELECTION';

export interface IdentityMatchResult {
    status: ResolutionStatus;
    targetState: any | null;
    targetElementState: any | null;
    matchedClientID: number | null;
    isOccluded?: boolean;
}

export function resolveCrossFrameIdentity(
    selectedState: any | null,
    targetFrameStates: any[],
): IdentityMatchResult {
    if (!selectedState) {
        return {
            status: 'NO_SELECTION', targetState: null, targetElementState: null, matchedClientID: null,
        };
    }

    // Constraint 6: Standalone shapes are never matched across frames.
    // A shape is only shown on its own frame, where the same CVAT object (clientID + objectType) exists.
    if (selectedState.objectType !== 'track') {
        const sameShape = selectedState.objectType === 'shape' &&
            (selectedState.parentID === null || selectedState.parentID === undefined) ?
            targetFrameStates.find((state) => (
                state && !state.removed && state.objectType === 'shape' && state.clientID === selectedState.clientID
            )) : null;
        if (sameShape) {
            return {
                status: 'MATCHED',
                targetState: sameShape,
                targetElementState: null,
                matchedClientID: sameShape.clientID,
                isOccluded: Boolean(sameShape.occluded),
            };
        }
        return {
            status: 'NO_IDENTITY', targetState: null, targetElementState: null, matchedClientID: null,
        };
    }

    // Case 1: Landmark element within a skeleton track (Composite Key: <Parent Track clientID, Sublabel ID>)
    if (selectedState.parentID !== null && selectedState.parentID !== undefined) {
        const parentClientID = selectedState.parentID;
        const sublabelID = selectedState.label?.id;

        // Disambiguate multi-face scenes by matching specific parent skeleton clientID
        const targetParent = targetFrameStates.find((state) => state.clientID === parentClientID);
        if (!targetParent || targetParent.outside) {
            return {
                status: 'SKELETON_ABSENT',
                targetState: null,
                targetElementState: null,
                matchedClientID: null,
            };
        }

        // Match specific facial landmark within that skeleton by sublabel ID
        const targetElement = (targetParent.elements || []).find((el: any) => el.label?.id === sublabelID);
        if (!targetElement || targetElement.outside) {
            return {
                status: 'ABSENT_ON_FRAME',
                targetState: targetParent,
                targetElementState: null,
                matchedClientID: null,
            };
        }

        return {
            status: 'MATCHED',
            targetState: targetParent,
            targetElementState: targetElement,
            matchedClientID: targetElement.clientID,
            isOccluded: Boolean(targetElement.occluded),
        };
    }

    // Case 2: Top-level Track (e.g. PointsTrack, RectangleTrack, SkeletonTrack)
    const matchedTrack = targetFrameStates.find((state) => state.clientID === selectedState.clientID);
    if (!matchedTrack || matchedTrack.outside) {
        return {
            status: 'ABSENT_ON_FRAME',
            targetState: null,
            targetElementState: null,
            matchedClientID: null,
        };
    }

    return {
        status: 'MATCHED',
        targetState: matchedTrack,
        targetElementState: null,
        matchedClientID: matchedTrack.clientID,
        isOccluded: Boolean(matchedTrack.occluded),
    };
}

export interface BBox {
    xtl: number;
    ytl: number;
    xbr: number;
    ybr: number;
}

export interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SelectableObject {
    key: string;
    clientID: number;
    parentID: number | null;
    trackID?: number;
    sublabelID?: number;
    labelID?: number;
    labelName: string;
    shapeType: string;
    objectType: string;
    displayText: string;
    color?: string;
    sourceState: any;
}

export function parseBBox(val: any): BBox | null {
    if (!val) return null;

    if (Array.isArray(val) && val.length >= 4) {
        const [x1, y1, x2, y2] = val;
        if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
            return {
                xtl: Math.min(x1, x2),
                ytl: Math.min(y1, y2),
                xbr: Math.max(x1, x2),
                ybr: Math.max(y1, y2),
            };
        }
    }

    if (typeof val === 'object') {
        if (
            Number.isFinite(val.xtl) &&
            Number.isFinite(val.ytl) &&
            Number.isFinite(val.xbr) &&
            Number.isFinite(val.ybr)
        ) {
            return {
                xtl: Math.min(val.xtl, val.xbr),
                ytl: Math.min(val.ytl, val.ybr),
                xbr: Math.max(val.xtl, val.xbr),
                ybr: Math.max(val.ytl, val.ybr),
            };
        }
        if (
            Number.isFinite(val.x) &&
            Number.isFinite(val.y) &&
            Number.isFinite(val.width) &&
            Number.isFinite(val.height)
        ) {
            return {
                xtl: val.x,
                ytl: val.y,
                xbr: val.x + val.width,
                ybr: val.y + val.height,
            };
        }
    }

    return null;
}

/**
 * Retrieves the object's existing bounding box from the CVAT annotation data.
 *
 * NOTE: For skeleton annotation tasks, the target bounding box is the object's
 * existing defined bounding box. We do NOT derive or synthesize a replacement
 * bounding box from skeleton keypoints or individual body landmarks.
 */
export const SKELETON_RECT_MARGIN = 20;

/**
 * Resolves a skeleton's outer wrapping bounding box using native CVAT Canvas logic.
 * Reuses the native CVAT Canvas logic (cvat-canvas/src/typescript/canvasView.ts lines 3890-4035):
 * 1. Checks for existing defined bounding box / wrappingRect on the skeleton.
 * 2. Checks for associated bounding box rectangle in the frame's annotation states.
 * 3. Otherwise computes the native CVAT Canvas wrapping bounding box from visible elements
 *    with standard SKELETON_RECT_MARGIN = 20 applied.
 * Recalculated independently per frame without modifying annotation data.
 */
export function resolveSkeletonWrappingBox(
    skeletonState: any,
    allFrameStates?: any[],
): BBox | null {
    if (!skeletonState) return null;

    // 1. Direct explicit bounding box / wrappingRect on skeletonState
    const directBox =
        parseBBox(skeletonState.wrappingRect) ||
        parseBBox(skeletonState.boundingBox) ||
        parseBBox(skeletonState.bbox) ||
        parseBBox(skeletonState.rect) ||
        parseBBox(skeletonState.box) ||
        parseBBox(skeletonState.bounds);
    if (directBox) {
        return directBox;
    }

    if (Array.isArray(skeletonState.points) && skeletonState.points.length === 4) {
        return parseBBox(skeletonState.points);
    }

    // 2. Look up associated bounding box rectangle in frame annotations
    if (Array.isArray(allFrameStates) && allFrameStates.length > 0) {
        const targetClientID = skeletonState.clientID;
        const targetGroupID = skeletonState.group?.id;

        const associatedRect = allFrameStates.find((st: any) => {
            if (!st || st.outside || st.shapeType !== 'rectangle') return false;
            if (typeof targetClientID === 'number' && st.clientID === targetClientID) return true;
            if (typeof targetClientID === 'number' && st.parentID === targetClientID) return true;
            if (typeof skeletonState.parentID === 'number' && st.clientID === skeletonState.parentID) return true;
            if (typeof targetGroupID === 'number' && targetGroupID > 0 && st.group?.id === targetGroupID) return true;
            return false;
        });

        if (associatedRect) {
            const rectBox =
                parseBBox(associatedRect.boundingBox) ||
                parseBBox(associatedRect.bbox) ||
                parseBBox(associatedRect.points);
            if (rectBox) {
                return rectBox;
            }
        }
    }

    // 3. Native CVAT Canvas wrapping box calculation (cvat-canvas canvasView.ts addSkeleton)
    if (Array.isArray(skeletonState.elements) && skeletonState.elements.length > 0) {
        let xtl: number | null = null;
        let ytl: number | null = null;
        let xbr: number | null = null;
        let ybr: number | null = null;

        for (const element of skeletonState.elements) {
            if (!element || element.outside) continue;
            const pts = element.points;
            if (Array.isArray(pts) && pts.length >= 2) {
                const cx = pts[0];
                const cy = pts[1];
                if (Number.isFinite(cx) && Number.isFinite(cy)) {
                    xtl = xtl === null ? cx : Math.min(xtl, cx);
                    ytl = ytl === null ? cy : Math.min(ytl, cy);
                    xbr = xbr === null ? cx : Math.max(xbr, cx);
                    ybr = ybr === null ? cy : Math.max(ybr, cy);
                }
            }
        }

        if (xtl !== null && ytl !== null && xbr !== null && ybr !== null) {
            return {
                xtl: Math.round(xtl - SKELETON_RECT_MARGIN),
                ytl: Math.round(ytl - SKELETON_RECT_MARGIN),
                xbr: Math.round(xbr + SKELETON_RECT_MARGIN),
                ybr: Math.round(ybr + SKELETON_RECT_MARGIN),
            };
        }
    }

    return null;
}

/**
 * Retrieves the object's bounding box from CVAT annotation data.
 * For skeletons and skeleton landmarks, reuses the native CVAT Canvas logic
 * to resolve the complete skeleton's outer wrapping bounding box (never zooming into a single landmark).
 * Keeps rectangle, polygon, and other geometry Auto-Zoom fully functional.
 */
export function getObjectBoundingBox(
    targetState: any,
    targetElementState?: any,
    allFrameStates?: any[],
): BBox | null {
    if (!targetState) return null;

    // Skeletons: always resolve complete skeleton outer wrapping bounding box
    if (targetState.shapeType === 'skeleton' || (targetState.elements && Array.isArray(targetState.elements))) {
        return resolveSkeletonWrappingBox(targetState, allFrameStates);
    }

    // If targetState is a landmark whose parent is a skeleton in allFrameStates, zoom into the complete skeleton
    if (targetState.parentID !== null && targetState.parentID !== undefined && Array.isArray(allFrameStates)) {
        const parentSkeleton = allFrameStates.find((st: any) => st && st.clientID === targetState.parentID);
        if (parentSkeleton && parentSkeleton.shapeType === 'skeleton') {
            return resolveSkeletonWrappingBox(parentSkeleton, allFrameStates);
        }
    }

    // 1. Direct explicit bounding box properties on targetState
    const directBox =
        parseBBox(targetState.boundingBox) ||
        parseBBox(targetState.bbox) ||
        parseBBox(targetState.rect) ||
        parseBBox(targetState.box) ||
        parseBBox(targetState.bounds);
    if (directBox) {
        return directBox;
    }

    // 2. Direct points if targetState is a rectangle
    if (targetState.shapeType === 'rectangle' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 3. Direct points if targetState has 4 bounding box coordinates
    if (
        targetState.objectType === 'track' &&
        Array.isArray(targetState.points) &&
        targetState.points.length === 4
    ) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 4. Look up associated bounding box rectangle in frame annotations (e.g. linked by group.id)
    if (Array.isArray(allFrameStates) && allFrameStates.length > 0) {
        const targetClientID = targetState.clientID;
        const targetGroupID = targetState.group?.id;

        const associatedRect = allFrameStates.find((st: any) => {
            if (!st || st.outside || st.shapeType !== 'rectangle') return false;
            if (typeof targetClientID === 'number' && st.clientID === targetClientID) return true;
            if (typeof targetClientID === 'number' && st.parentID === targetClientID) return true;
            if (typeof targetState.parentID === 'number' && st.clientID === targetState.parentID) return true;
            if (typeof targetGroupID === 'number' && targetGroupID > 0 && st.group?.id === targetGroupID) return true;
            return false;
        });

        if (associatedRect) {
            const rectBox =
                parseBBox(associatedRect.boundingBox) ||
                parseBBox(associatedRect.bbox) ||
                parseBBox(associatedRect.points);
            if (rectBox) {
                return rectBox;
            }
        }
    }

    // 5. Masks: [xtl, ytl, xbr, ybr, ...]
    if (targetState.shapeType === 'mask' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 6. Ellipse: [cx, cy, rightX, topY]
    if (targetState.shapeType === 'ellipse' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [cx, cy, rightX, topY] = targetState.points;
        const rx = Math.abs(rightX - cx);
        const ry = Math.abs(cy - topY);
        return {
            xtl: cx - rx,
            ytl: cy - ry,
            xbr: cx + rx,
            ybr: cy + ry,
        };
    }

    // 7. Standalone Polygons, Polylines, Points, Cuboids:
    if (Array.isArray(targetState.points) && targetState.points.length >= 2) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (let i = 0; i < targetState.points.length; i += 2) {
            const x = targetState.points[i];
            const y = targetState.points[i + 1];
            if (Number.isFinite(x) && Number.isFinite(y)) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }

        if (minX !== Infinity && minY !== Infinity) {
            return {
                xtl: minX, ytl: minY, xbr: maxX, ybr: maxY,
            };
        }
    }

    return null;
}

/**
 * Calculates a centered, aspect-ratio-matched viewport for auto-zooming onto an object's bounding box.
 * Maximizes the bounding box displayed size according to the viewport's constraints while preserving
 * the original source image aspect ratio without distortion and applying a small 2-5% safety margin.
 *
 * @param bbox Bounding box of the object in image pixels
 * @param imageWidth Full frame width in pixels
 * @param imageHeight Full frame height in pixels
 * @param paddingRatio Safety margin around the box (default 0.03 = 3%, within 2–5% range)
 * @param minDimension Minimum dimension baseline to prevent zero-size divisions (default 10)
 */
export function calculateAutoZoomViewport(
    bbox: BBox,
    imageWidth: number,
    imageHeight: number,
    paddingRatio = 0.03,
    minDimension = 10,
): Viewport {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return {
            x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight),
        };
    }

    const objWidth = Math.max(0, bbox.xbr - bbox.xtl);
    const objHeight = Math.max(0, bbox.ybr - bbox.ytl);
    const centerX = (bbox.xtl + bbox.xbr) / 2;
    const centerY = (bbox.ytl + bbox.ybr) / 2;

    // Apply safety margin (2–5%, default 3%) around the bounding box
    const paddedWidth = Math.max(objWidth * (1 + 2 * paddingRatio), minDimension);
    const paddedHeight = Math.max(objHeight * (1 + 2 * paddingRatio), minDimension);

    // Target aspect ratio matches the original image / tile canvas
    const targetAspect = imageWidth / imageHeight;

    let vpWidth = paddedWidth;
    let vpHeight = paddedHeight;

    if (vpWidth / vpHeight < targetAspect) {
        // Height is the limiting constraint; expand width to preserve aspect ratio
        vpWidth = vpHeight * targetAspect;
    } else {
        // Width is the limiting constraint; expand height to preserve aspect ratio
        vpHeight = vpWidth / targetAspect;
    }

    // Never exceed full frame dimensions
    if (vpWidth >= imageWidth || vpHeight >= imageHeight) {
        return {
            x: 0, y: 0, width: imageWidth, height: imageHeight,
        };
    }

    // Center the viewport on the object
    let vpX = centerX - vpWidth / 2;
    let vpY = centerY - vpHeight / 2;

    // Clamp within image bounds so the entire box remains visible without extending outside frame
    if (vpX < 0) {
        vpX = 0;
    } else if (vpX + vpWidth > imageWidth) {
        vpX = Math.max(0, imageWidth - vpWidth);
    }

    if (vpY < 0) {
        vpY = 0;
    } else if (vpY + vpHeight > imageHeight) {
        vpY = Math.max(0, imageHeight - vpHeight);
    }

    const roundedWidth = Math.min(Math.round(vpWidth), imageWidth);
    const roundedHeight = Math.min(Math.round(vpHeight), imageHeight);
    const roundedX = Math.max(0, Math.min(Math.round(vpX), imageWidth - roundedWidth));
    const roundedY = Math.max(0, Math.min(Math.round(vpY), imageHeight - roundedHeight));

    return {
        x: roundedX,
        y: roundedY,
        width: roundedWidth,
        height: roundedHeight,
    };
}

/**
 * Clamps a viewport within the frame boundaries while strictly preserving the image aspect ratio.
 */
export function clampViewport(vp: Viewport, imageWidth: number, imageHeight: number): Viewport {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return {
            x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight),
        };
    }

    const targetAspect = imageWidth / imageHeight;
    // Bound width between 20px and full frame width
    let width = Math.min(Math.max(20, vp.width), imageWidth);
    let height = width / targetAspect;

    if (height > imageHeight) {
        height = imageHeight;
        width = height * targetAspect;
    }

    const x = Math.max(0, Math.min(vp.x, imageWidth - width));
    const y = Math.max(0, Math.min(vp.y, imageHeight - height));

    const roundedWidth = Math.min(Math.round(width), imageWidth);
    const roundedHeight = Math.min(Math.round(height), imageHeight);
    const roundedX = Math.max(0, Math.min(Math.round(x), imageWidth - roundedWidth));
    const roundedY = Math.max(0, Math.min(Math.round(y), imageHeight - roundedHeight));

    return {
        x: roundedX,
        y: roundedY,
        width: roundedWidth,
        height: roundedHeight,
    };
}

/**
 * Zooms a viewport by a scale factor centered at a focal point (in image coordinates).
 * Factor < 1 zooms in (shrinks viewport), factor > 1 zooms out (expands viewport).
 */
export function zoomViewportAtPoint(
    currentVp: Viewport,
    factor: number,
    focalX: number,
    focalY: number,
    imageWidth: number,
    imageHeight: number,
): Viewport {
    if (imageWidth <= 0 || imageHeight <= 0 || !Number.isFinite(factor) || factor <= 0) {
        return currentVp;
    }

    const targetAspect = imageWidth / imageHeight;
    const newWidth = currentVp.width * factor;
    const newHeight = newWidth / targetAspect;

    // Maintain the relative position of the focal point in the viewport
    const rx = currentVp.width > 0 ? (focalX - currentVp.x) / currentVp.width : 0.5;
    const ry = currentVp.height > 0 ? (focalY - currentVp.y) / currentVp.height : 0.5;

    const newX = focalX - rx * newWidth;
    const newY = focalY - ry * newHeight;

    return clampViewport({
        x: newX, y: newY, width: newWidth, height: newHeight,
    }, imageWidth, imageHeight);
}

/**
 * Calculates a new viewport when dragging a tile's corner resize handle.
 * Outward/downward drag (positive delta) zooms in; inward/upward drag (negative delta) zooms out.
 * Preserves the original image aspect ratio and bounds within image limits.
 */
export function calculateResizeZoomViewport(
    startViewport: Viewport,
    dx: number,
    dy: number,
    imageWidth: number,
    imageHeight: number,
    sensitivity = 150,
): Viewport {
    if (imageWidth <= 0 || imageHeight <= 0 || !startViewport || startViewport.width <= 0) {
        return startViewport;
    }

    const delta = (dx + dy) / 2;
    const factor = Math.exp(-delta / Math.max(10, sensitivity));

    const centerX = startViewport.x + startViewport.width / 2;
    const centerY = startViewport.y + startViewport.height / 2;

    return zoomViewportAtPoint(
        startViewport,
        factor,
        centerX,
        centerY,
        imageWidth,
        imageHeight,
    );
}

/**
 * Shifts (pans) a viewport by deltaX and deltaY in image coordinates, clamping to boundaries.
 */
export function panViewport(
    currentVp: Viewport,
    deltaX: number,
    deltaY: number,
    imageWidth: number,
    imageHeight: number,
): Viewport {
    return clampViewport(
        {
            x: currentVp.x + deltaX,
            y: currentVp.y + deltaY,
            width: currentVp.width,
            height: currentVp.height,
        },
        imageWidth,
        imageHeight,
    );
}

/**
 * Pans a viewport to center on an object's bounding box while strictly preserving
 * the current zoom level (viewport width and height) and image aspect ratio.
 * Clamps coordinates so the viewport stays within image boundaries.
 */
export function centerViewportOnObject(
    viewport: Viewport,
    bbox: BBox,
    imageWidth: number,
    imageHeight: number,
): Viewport {
    if (!viewport || viewport.width <= 0 || viewport.height <= 0 || imageWidth <= 0 || imageHeight <= 0) {
        return viewport;
    }
    const objCenterX = (bbox.xtl + bbox.xbr) / 2;
    const objCenterY = (bbox.ytl + bbox.ybr) / 2;

    const vpW = Math.min(viewport.width, imageWidth);
    const vpH = Math.min(viewport.height, imageHeight);

    const targetX = objCenterX - vpW / 2;
    const targetY = objCenterY - vpH / 2;

    const clampedX = Math.max(0, Math.min(imageWidth - vpW, Math.round(targetX)));
    const clampedY = Math.max(0, Math.min(imageHeight - vpH, Math.round(targetY)));

    return {
        x: clampedX,
        y: clampedY,
        width: vpW,
        height: vpH,
    };
}

/**
 * Computes the readable zoom percentage for a given viewport relative to the full image width.
 */
export function calculateZoomPercentage(vp: Viewport, imageWidth: number): number {
    if (!vp || vp.width <= 0 || imageWidth <= 0) return 100;
    return Math.round((imageWidth / vp.width) * 100);
}

/**
 * Extracts and deduplicates selectable objects from an array of AnnotationStates.
 * Supports:
 *  - Tracks of all shape types (Skeleton, Rectangle, Polygon, etc.)
 *  - Standalone shapes of all shape types
 * Excludes individual child elements / landmarks so only complete logical objects appear in the Object selector.
 */
export function extractSelectableObjects(states: any[]): SelectableObject[] {
    if (!Array.isArray(states) || states.length === 0) {
        return [];
    }

    const objectsMap = new Map<string, SelectableObject>();

    for (const state of states) {
        if (!state) continue;

        // Skip child elements/landmarks - only complete parent objects should be selectable
        if (state.parentID !== undefined && state.parentID !== null) {
            continue;
        }

        const isTrack = state.objectType === 'track';
        const { clientID } = state;
        if (typeof clientID !== 'number') continue;

        const shapeType = state.shapeType || 'unknown';
        const labelName = state.label?.name || 'Object';
        const labelID = state.label?.id;
        const color = state.color || state.label?.color;

        if (isTrack) {
            const trackKey = `track_${clientID}`;
            if (!objectsMap.has(trackKey)) {
                const typeName = shapeType.charAt(0).toUpperCase() + shapeType.slice(1);
                objectsMap.set(trackKey, {
                    key: trackKey,
                    clientID,
                    parentID: null,
                    trackID: typeof state.id === 'number' ? state.id : clientID,
                    labelID,
                    labelName,
                    shapeType,
                    objectType: 'track',
                    displayText: `[#${clientID}${state.id ? ` / ID ${state.id}` : ''}] ${labelName} (${typeName} Track)`,
                    color,
                    sourceState: state,
                });
            }
        } else if (state.objectType === 'shape') {
            const shapeKey = `shape_${clientID}`;
            if (!objectsMap.has(shapeKey)) {
                const typeName = shapeType.charAt(0).toUpperCase() + shapeType.slice(1);
                objectsMap.set(shapeKey, {
                    key: shapeKey,
                    clientID,
                    parentID: null,
                    labelID,
                    labelName,
                    shapeType,
                    objectType: 'shape',
                    displayText: `[#${clientID}] ${labelName} (${typeName} Shape)`,
                    color,
                    sourceState: state,
                });
            }
        }
    }

    return Array.from(objectsMap.values());
}

export interface ContainedLayout {
    fitWidth: number;
    fitHeight: number;
    offsetX: number;
    offsetY: number;
    letterboxType: 'none' | 'letterbox' | 'pillarbox';
    scale: number;
}

/**
 * Calculates proportional containment (object-fit: contain) for content (image/viewport)
 * inside a container, computing fitted dimensions, centering offsets, and letterboxing type.
 *
 * @param containerWidth Available width of the container in pixels
 * @param containerHeight Available height of the container in pixels
 * @param contentWidth Intrinsic or rendered width of the content in pixels
 * @param contentHeight Intrinsic or rendered height of the content in pixels
 */
export function calculateContainedDimensions(
    containerWidth: number,
    containerHeight: number,
    contentWidth: number,
    contentHeight: number,
): ContainedLayout {
    if (containerWidth <= 0 || containerHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
        return {
            fitWidth: Math.max(0, containerWidth),
            fitHeight: Math.max(0, containerHeight),
            offsetX: 0,
            offsetY: 0,
            letterboxType: 'none',
            scale: 1,
        };
    }

    const containerAspect = containerWidth / containerHeight;
    const contentAspect = contentWidth / contentHeight;

    let fitWidth: number;
    let fitHeight: number;
    let letterboxType: 'none' | 'letterbox' | 'pillarbox' = 'none';

    if (Math.abs(containerAspect - contentAspect) < 0.001) {
        fitWidth = containerWidth;
        fitHeight = containerHeight;
        letterboxType = 'none';
    } else if (containerAspect > contentAspect) {
        // Container is wider than content -> Pillarboxing (vertical bars on left & right)
        fitHeight = containerHeight;
        fitWidth = containerHeight * contentAspect;
        letterboxType = 'pillarbox';
    } else {
        // Container is taller than content -> Letterboxing (horizontal bars on top & bottom)
        fitWidth = containerWidth;
        fitHeight = containerWidth / contentAspect;
        letterboxType = 'letterbox';
    }

    fitWidth = Math.min(containerWidth, Math.max(1, fitWidth));
    fitHeight = Math.min(containerHeight, Math.max(1, fitHeight));

    const offsetX = Math.max(0, (containerWidth - fitWidth) / 2);
    const offsetY = Math.max(0, (containerHeight - fitHeight) / 2);
    const scale = contentWidth > 0 ? fitWidth / contentWidth : 1;

    return {
        fitWidth,
        fitHeight,
        offsetX,
        offsetY,
        letterboxType,
        scale,
    };
}

/**
 * Maps a pointer event (clientX, clientY or container-relative x, y) to image coordinates,
 * taking into account the letterbox/pillarbox offset, scale, and active viewport crop.
 *
 * @param pointerContainerX X coordinate relative to container left edge
 * @param pointerContainerY Y coordinate relative to container top edge
 * @param layout ContainedLayout computed for the container and content
 * @param viewport Active viewport (or null for full frame)
 * @param imageWidth Full frame width
 * @param imageHeight Full frame height
 */
export function mapPointerToImageCoordinates(
    pointerContainerX: number,
    pointerContainerY: number,
    layout: ContainedLayout,
    viewport: Viewport | null,
    imageWidth: number,
    imageHeight: number,
): { x: number; y: number; isInsideContent: boolean } {
    const {
        fitWidth, fitHeight, offsetX, offsetY,
    } = layout;

    const isInsideContent =
        pointerContainerX >= offsetX &&
        pointerContainerX <= offsetX + fitWidth &&
        pointerContainerY >= offsetY &&
        pointerContainerY <= offsetY + fitHeight;

    const contentRelX = Math.max(0, Math.min(fitWidth, pointerContainerX - offsetX));
    const contentRelY = Math.max(0, Math.min(fitHeight, pointerContainerY - offsetY));

    const vpX = viewport?.x ?? 0;
    const vpY = viewport?.y ?? 0;
    const vpW = (viewport?.width && viewport.width > 0) ? viewport.width : imageWidth;
    const vpH = (viewport?.height && viewport.height > 0) ? viewport.height : imageHeight;

    const normX = fitWidth > 0 ? contentRelX / fitWidth : 0;
    const normY = fitHeight > 0 ? contentRelY / fitHeight : 0;

    const imageX = vpX + normX * vpW;
    const imageY = vpY + normY * vpH;

    return {
        x: Math.max(0, Math.min(imageWidth, imageX)),
        y: Math.max(0, Math.min(imageHeight, imageY)),
        isInsideContent,
    };
}

/**
 * State representation of the Multi-Frame view including full-screen frame zoom.
 */
export interface MultiframeViewState {
    rangeStart: number;
    rangeEnd: number;
    batchIndex: number;
    selectedObjectKey: string | null;
    selectedTypeFilter: string;
    autoZoomEnabled: boolean;
    zoomedFrame: number | null;
}

/**
 * Enters full-screen frame zoom for a given target frame.
 * Preserves the existing grid configuration, range, batch, and object selection.
 */
export function openFullscreenFrameZoom(
    currentState: MultiframeViewState,
    targetFrame: number,
): MultiframeViewState {
    return {
        ...currentState,
        zoomedFrame: targetFrame,
    };
}

/**
 * Exits full-screen frame zoom and returns to the Multi-Frame grid.
 * Restores the previous grid, frame range, selected object, and updates the batch index
 * if navigation occurred while in full-screen zoom.
 */
export function returnToMultiframeGrid(
    currentState: MultiframeViewState,
    activeFrame?: number,
    batchSize: number = 10,
): MultiframeViewState {
    let nextBatchIndex = currentState.batchIndex;
    if (typeof activeFrame === 'number') {
        const computedBatch = Math.floor((activeFrame - currentState.rangeStart) / batchSize);
        if (computedBatch >= 0) {
            nextBatchIndex = computedBatch;
        }
    }
    return {
        ...currentState,
        batchIndex: nextBatchIndex,
        zoomedFrame: null,
    };
}

/**
 * Navigates to a previous or next frame during full-screen zoom mode.
 */
export function navigateFullscreenFrame(
    currentState: MultiframeViewState,
    nextFrame: number,
    batchSize: number = 10,
): MultiframeViewState {
    const computedBatch = Math.floor((nextFrame - currentState.rangeStart) / batchSize);
    return {
        ...currentState,
        zoomedFrame: nextFrame,
        batchIndex: computedBatch >= 0 ? computedBatch : currentState.batchIndex,
    };
}

/**
 * Geometry rectangle of a tile or workspace area.
 */
export interface TileExpansionRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * Calculates expansion progress (0 to 1) when dragging the bottom-right corner of a tile.
 * - Outward drag (dx > 0, dy > 0) increases progress toward 1 (full workspace expansion).
 * - Inward drag (dx < 0, dy < 0) decreases progress toward 0 (original grid layout).
 */
export function calculateExpansionProgress(
    startProgress: number,
    dx: number,
    dy: number,
    maxDistance: number = 250,
): number {
    const delta = (dx + dy) / 2;
    const progress = startProgress + delta / Math.max(50, maxDistance);
    return Math.max(0, Math.min(1, progress));
}

/**
 * Calculates the interpolated geometry for an expanding tile between its initial grid cell
 * and the full workspace grid boundaries.
 */
export function calculateExpandedTileGeometry(
    initialRect: TileExpansionRect,
    workspaceRect: TileExpansionRect,
    progress: number,
): TileExpansionRect {
    const p = Math.max(0, Math.min(1, progress));
    return {
        left: Math.round(initialRect.left * (1 - p) + workspaceRect.left * p),
        top: Math.round(initialRect.top * (1 - p) + workspaceRect.top * p),
        width: Math.round(initialRect.width + (workspaceRect.width - initialRect.width) * p),
        height: Math.round(initialRect.height + (workspaceRect.height - initialRect.height) * p),
    };
}

/**
 * Calculates opacity and visibility for other tiles as the selected tile expands.
 * Progressively dims other tiles, and hides them completely when progress reaches hideThreshold.
 */
export function calculateOtherTileOpacity(
    progress: number,
    baseOpacity: number = 1,
    hideThreshold: number = 0.75,
): { opacity: number; isHidden: boolean } {
    const p = Math.max(0, Math.min(1, progress));
    if (p >= hideThreshold) {
        return { opacity: 0, isHidden: true };
    }
    const fadeRatio = 1 - (p / hideThreshold);
    return {
        opacity: Math.max(0, baseOpacity * fadeRatio),
        isHidden: false,
    };
}

// ---------------------------------------------------------------------------
// Expanded-frame (Zoom in place) fitting
// ---------------------------------------------------------------------------

export interface ExpandedFitResult {
    isValid: boolean;
    width: number;
    height: number;
}

/**
 * Calculates the outer size of an expanded (zoomed in place) tile so that its image area keeps the
 * displayed frame aspect ratio and fits inside the available grid area.
 * - contentWidth/contentHeight must be the actual displayed frame (or viewport) dimensions.
 * - chrome is the extra outer size of the tile (e.g. borders) added on both axes.
 * - Returns isValid=false (and zero size) when the container or the content is not measurable yet,
 *   so callers can fall back to the default layout instead of applying a wrong size.
 */
export function calculateExpandedFitDimensions(
    containerWidth: number,
    containerHeight: number,
    contentWidth: number,
    contentHeight: number,
    chrome = 0,
): ExpandedFitResult {
    const invalid = { isValid: false, width: 0, height: 0 };
    const values = [containerWidth, containerHeight, contentWidth, contentHeight, chrome];
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        return invalid;
    }

    const safeChrome = Math.max(0, chrome);
    const availWidth = Math.floor(containerWidth - safeChrome);
    const availHeight = Math.floor(containerHeight - safeChrome);
    if (availWidth <= 0 || availHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
        return invalid;
    }

    const aspect = contentWidth / contentHeight;
    let fitWidth = availWidth;
    let fitHeight = fitWidth / aspect;
    if (fitHeight > availHeight) {
        fitHeight = availHeight;
        fitWidth = fitHeight * aspect;
    }

    // Floor so that the result never exceeds the available area
    const width = Math.max(1, Math.floor(fitWidth));
    const height = Math.max(1, Math.floor(fitHeight));

    return {
        isValid: true,
        width: width + safeChrome,
        height: height + safeChrome,
    };
}

// ---------------------------------------------------------------------------
// Object ID parsing and resolution
// ---------------------------------------------------------------------------

export type ObjectIDScope = 'any' | 'client' | 'server';

export interface ParsedObjectID {
    status: 'EMPTY' | 'INVALID' | 'OK';
    id: number | null;
    scope: ObjectIDScope;
    objectType: 'shape' | 'track' | null;
}

// Linear-time: every quantified part is followed by a disjoint character class (\s vs [:#] vs \d)
// eslint-disable-next-line security/detect-unsafe-regex
const OBJECT_ID_PATTERN = /^#?\s*(?:(track|shape)_|(id|sid|server)\s*[:#]\s*)?(\d+)$/i;

/**
 * Strictly parses an Object ID entered by a user.
 * Accepted forms (whitespace around the value is ignored):
 *  - "12" or "#12": a client ID or a server ID (may be ambiguous)
 *  - "track_12" / "shape_12": a client ID of a track / shape (unambiguous)
 *  - "id:12" / "sid:12" / "server:12": a server ID (unambiguous)
 * Anything else ("12abc", "10.7", "1e1", "-3", "") is rejected.
 */
export function parseObjectIDInput(rawInput: string | number | null | undefined): ParsedObjectID {
    if (rawInput === null || rawInput === undefined) {
        return {
            status: 'EMPTY', id: null, scope: 'any', objectType: null,
        };
    }

    const input = String(rawInput).trim();
    if (!input) {
        return {
            status: 'EMPTY', id: null, scope: 'any', objectType: null,
        };
    }

    const match = OBJECT_ID_PATTERN.exec(input);
    if (!match) {
        return {
            status: 'INVALID', id: null, scope: 'any', objectType: null,
        };
    }

    const id = Number(match[3]);
    if (!Number.isSafeInteger(id)) {
        return {
            status: 'INVALID', id: null, scope: 'any', objectType: null,
        };
    }

    if (match[1]) {
        return {
            status: 'OK', id, scope: 'client', objectType: match[1].toLowerCase() as 'shape' | 'track',
        };
    }

    if (match[2]) {
        return {
            status: 'OK', id, scope: 'server', objectType: null,
        };
    }

    return {
        status: 'OK', id, scope: 'any', objectType: null,
    };
}

/** Returns an unambiguous input key for an object state, e.g. "track_12" */
export function getObjectInputKey(state: any): string {
    return state?.objectType === 'track' ? `track_${state.clientID}` : `shape_${state.clientID}`;
}

export type ObjectResolutionStatus = 'EMPTY' | 'INVALID' | 'VALID' | 'NOT_FOUND' | 'LABEL_MISMATCH' | 'AMBIGUOUS';

export interface ObjectResolutionResult {
    status: ObjectResolutionStatus;
    matchedObject: any | null;
    matchedKey: string | null;
    resolvedType: string | null;
    resolvedID: number | null;
    isSkeleton: boolean;
    candidates: any[];
    message: string;
}

function isValidState(state: any): boolean {
    return Boolean(state) && !state.removed;
}

function hasParent(state: any): boolean {
    return state?.parentID !== null && state?.parentID !== undefined;
}

function capitalize(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Label name of an object state (the object type shown to annotators, e.g. "mattrai") */
export function getStateLabelName(state: any): string {
    return typeof state?.label?.name === 'string' ? state.label.name : '';
}

/** 'all' (or empty) matches every object, otherwise the object label name must be equal */
export function matchesLabelFilter(state: any, labelFilter: string | null | undefined): boolean {
    return !labelFilter || labelFilter === 'all' || getStateLabelName(state) === labelFilter;
}

// ---------------------------------------------------------------------------
// Object filter: Type mode and ID mode are mutually exclusive (read-only, view only)
// ---------------------------------------------------------------------------

export type ObjectFilterMode = 'none' | 'type' | 'id';

export interface ObjectFilterState {
    mode: ObjectFilterMode;
    /** label name (object type) in Type mode, otherwise 'all' */
    label: string;
    /** raw Object ID input in ID mode, otherwise '' */
    idInput: string;
}

export const EMPTY_OBJECT_FILTER: ObjectFilterState = { mode: 'none', label: 'all', idInput: '' };

/** Selecting a type switches to Type mode and clears the Object ID. "All Types" clears the filter. */
export function selectTypeFilter(label: string | null | undefined): ObjectFilterState {
    if (!label || label === 'all') return { ...EMPTY_OBJECT_FILTER };
    return { mode: 'type', label, idInput: '' };
}

/** Entering an Object ID switches to ID mode and resets the type. An empty input clears the filter. */
export function enterIDFilter(idInput: string | null | undefined): ObjectFilterState {
    const value = typeof idInput === 'string' ? idInput : '';
    if (!value.trim()) return { ...EMPTY_OBJECT_FILTER };
    return { mode: 'id', label: 'all', idInput: value };
}

/**
 * Type mode: visible top-level objects of the given label on one frame.
 * Skeleton landmarks are never returned on their own, they are shown as part of their parent Skeleton.
 */
export function getTypeFilterMatches(frameStates: any[], label: string): any[] {
    if (!label || label === 'all' || !Array.isArray(frameStates)) return [];
    return frameStates.filter((state) => (
        state && !state.removed && !state.outside && !hasParent(state) && getStateLabelName(state) === label
    ));
}

/**
 * Type mode auto-zoom / auto-follow target: the union of the bounding boxes of all matched objects
 * on one frame (a Skeleton uses its complete wrapping box). Returns null when nothing can be measured.
 * View only: the states are never modified.
 */
export function getTypeFilterBoundingBox(matches: any[], allFrameStates?: any[]): BBox | null {
    if (!Array.isArray(matches) || matches.length === 0) return null;
    let union: BBox | null = null;
    for (const state of matches) {
        const bbox = getObjectBoundingBox(state, null, allFrameStates);
        if (bbox && [bbox.xtl, bbox.ytl, bbox.xbr, bbox.ybr].every(Number.isFinite)) {
            union = union ? {
                xtl: Math.min(union.xtl, bbox.xtl),
                ytl: Math.min(union.ytl, bbox.ytl),
                xbr: Math.max(union.xbr, bbox.xbr),
                ybr: Math.max(union.ybr, bbox.ybr),
            } : { ...bbox };
        }
    }
    return union;
}

/**
 * Resolves an entered Object ID to a single top-level annotation object.
 * - A Skeleton landmark ID always resolves to its parent Skeleton (landmarks are never independent objects).
 * - Plain numbers can match both client IDs and server IDs; if they identify different objects,
 *   the result is AMBIGUOUS and nothing is selected.
 * - The label filter (object type, e.g. "mattrai") narrows candidates before ambiguity is evaluated.
 */
export function resolveObjectByIDAndType(
    rawInputID: string | number | null | undefined,
    labelFilter: string,
    allStates: any[],
): ObjectResolutionResult {
    const base = {
        matchedObject: null,
        matchedKey: null,
        resolvedType: null,
        resolvedID: null,
        isSkeleton: false,
        candidates: [] as any[],
    };

    const parsed = parseObjectIDInput(rawInputID);
    if (parsed.status === 'EMPTY') {
        return { ...base, status: 'EMPTY', message: '' };
    }

    if (parsed.status === 'INVALID' || parsed.id === null) {
        return {
            ...base,
            status: 'INVALID',
            message: `Invalid ID "${String(rawInputID).trim()}". Use a number, track_N, shape_N or id:N`,
        };
    }

    const { id, scope, objectType } = parsed;
    const states = Array.isArray(allStates) ? allStates.filter(isValidState) : [];
    const topLevel = states.filter((state) => !hasParent(state));

    const matchesID = (state: any): boolean => {
        if (!state) return false;
        if (scope === 'client') return state.clientID === id;
        if (scope === 'server') return state.serverID === id || state.id === id;
        return state.clientID === id || state.serverID === id || state.id === id;
    };

    const findParent = (child: any): any | null => (
        topLevel.find((state) => state.clientID === child.parentID) || null
    );

    // Collect distinct top-level candidates (keyed by object type + client ID)
    const candidates = new Map<string, any>();
    const addCandidate = (state: any | null): void => {
        if (!state) return;
        if (objectType && state.objectType !== objectType) return;
        candidates.set(getObjectInputKey(state), state);
    };

    for (const state of topLevel) {
        if (matchesID(state)) {
            addCandidate(state);
        }

        if (Array.isArray(state.elements)) {
            if (state.elements.some((element: any) => matchesID(element))) {
                // landmark ID resolves to its complete parent skeleton
                addCandidate(state);
            }
        }
    }

    for (const state of states) {
        if (hasParent(state) && matchesID(state)) {
            addCandidate(findParent(state));
        }
    }

    const allCandidates = Array.from(candidates.values());
    if (allCandidates.length === 0) {
        return { ...base, status: 'NOT_FOUND', message: `Object ID ${id} not found` };
    }

    const typed = allCandidates.filter((state) => matchesLabelFilter(state, labelFilter));

    if (typed.length === 0) {
        const labels = Array.from(new Set(allCandidates.map((state) => getStateLabelName(state) || 'unknown')));
        const [first] = allCandidates;
        return {
            ...base,
            status: 'LABEL_MISMATCH',
            matchedKey: allCandidates.length === 1 ? getObjectInputKey(first) : null,
            resolvedType: allCandidates.length === 1 ? first.shapeType : null,
            resolvedID: allCandidates.length === 1 ? first.clientID : null,
            isSkeleton: allCandidates.length === 1 && first.shapeType === 'skeleton',
            candidates: allCandidates,
            message: `ID ${id} is ${labels.join('/')}, but the type filter is ${labelFilter}`,
        };
    }

    if (typed.length > 1) {
        return {
            ...base,
            status: 'AMBIGUOUS',
            candidates: typed,
            message: `ID ${id} is ambiguous: ${typed.map((state) => getObjectInputKey(state)).join(', ')}`,
        };
    }

    const [matched] = typed;
    const shapeType = matched.shapeType || 'unknown';
    const serverID = matched.serverID ?? matched.id;
    const labelName = getStateLabelName(matched);
    return {
        status: 'VALID',
        matchedObject: matched,
        matchedKey: getObjectInputKey(matched),
        resolvedType: shapeType,
        resolvedID: matched.clientID,
        isSkeleton: shapeType === 'skeleton',
        candidates: typed,
        message: `${getObjectInputKey(matched)}${typeof serverID === 'number' ? ` (server ID ${serverID})` : ''} ` +
            `[${labelName ? `${labelName}, ` : ''}${capitalize(shapeType)}]`,
    };
}

// ---------------------------------------------------------------------------
// Deletion by type / ID / inclusive frame range
// ---------------------------------------------------------------------------

/** CVAT keeps at most this many undo steps (cvat-core MAX_HISTORY_LENGTH) */
export const CVAT_MAX_HISTORY_LENGTH = 32;

export type DeletionMode = 'delete-shape' | 'delete-track' | 'hide-track-range';

export interface DeletionTarget {
    key: string;
    clientID: number;
    serverID: number | null;
    objectType: 'shape' | 'track';
    shapeType: string;
    label: string;
    mode: DeletionMode;
    /** Frames inside the range where the object is currently visible */
    frames: number[];
    /** Exact number of CVAT history (undo) steps this target will create */
    historySteps: number;
    /** hide-track-range only: the frame after the range must become a keyframe to keep its geometry */
    freezeFrame: number | null;
    /**
     * hide-track-range only, polygon / polyline / points tracks: frame spans OUTSIDE the range whose
     * interpolated geometry may shift slightly, because cvat-core interpolates these shapes non-linearly
     * and the operation adds keyframes next to them (same as setting outside manually in CVAT).
     */
    interpolationWarning: [number, number][] | null;
}

/** cvat-core PolyTrack-based tracks use non-linear (point matching) interpolation */
const NON_LINEAR_INTERPOLATION_TYPES = new Set(['polygon', 'polyline', 'points']);

export interface DeletionPlan {
    isValid: boolean;
    error: string | null;
    startFrame: number;
    endFrame: number;
    /** label name (object type) or 'all' */
    targetLabel: string;
    targetClientID: number | null;
    targets: DeletionTarget[];
    skippedLocked: { key: string; frames: number[] }[];
    totalHistorySteps: number;
    exceedsHistoryLimit: boolean;
}

export interface PlanDeletionParams {
    jobInstance: any;
    startFrame: number;
    endFrame: number;
    /** last frame of the job, used to check whether a track continues after the range */
    stopFrame: number;
    /** label name (object type, e.g. "mattrai") or 'all' */
    targetLabel: string;
    /** client ID of the resolved top-level object; null deletes every object matching targetLabel */
    targetClientID?: number | null;
}

async function getFrameStates(jobInstance: any, frame: number, cache?: Map<number, any[]>): Promise<any[]> {
    if (cache && cache.has(frame)) {
        return cache.get(frame) as any[];
    }
    const states = await jobInstance.annotations.get(frame, true, []);
    const result = Array.isArray(states) ? states : [];
    if (cache) {
        cache.set(frame, result);
    }
    return result;
}

async function getObjectStateOnFrame(
    jobInstance: any, frame: number, clientID: number, cache?: Map<number, any[]>,
): Promise<any | null> {
    const states = await getFrameStates(jobInstance, frame, cache);
    return states.find((state: any) => state && !state.removed && !hasParent(state) && state.clientID === clientID) ||
        null;
}

function isLocked(state: any): boolean {
    return Boolean(state?.lock);
}

/**
 * Builds a dry-run deletion plan. Nothing is modified.
 * Rules:
 *  - only top-level objects are targeted (a Skeleton is always handled as one object with its landmarks)
 *  - only states that are visible (not outside) inside [startFrame, endFrame] are targeted
 *  - locked objects are skipped and reported
 *  - a track that is visible outside the range is never deleted: it is hidden only inside the range
 */
export async function planAnnotationDeletion(params: PlanDeletionParams): Promise<DeletionPlan> {
    const {
        jobInstance, startFrame, endFrame, stopFrame, targetLabel,
    } = params;
    const targetClientID = typeof params.targetClientID === 'number' ? params.targetClientID : null;

    const plan: DeletionPlan = {
        isValid: false,
        error: null,
        startFrame,
        endFrame,
        targetLabel,
        targetClientID,
        targets: [],
        skippedLocked: [],
        totalHistorySteps: 0,
        exceedsHistoryLimit: false,
    };

    if (!jobInstance || !jobInstance.annotations || typeof jobInstance.annotations.get !== 'function') {
        return { ...plan, error: 'Job annotations are unavailable' };
    }

    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || !Number.isInteger(stopFrame)) {
        return { ...plan, error: 'Frame range must contain integer frames' };
    }

    if (startFrame > endFrame) {
        return { ...plan, error: 'Start frame cannot exceed end frame' };
    }

    if (endFrame > stopFrame) {
        return { ...plan, error: 'End frame exceeds the last job frame' };
    }

    const cache = new Map<number, any[]>();
    const found = new Map<string, { state: any; frames: number[]; hideOps: number; prevVisible: number | null }>();
    const locked = new Map<string, number[]>();

    for (let frame = startFrame; frame <= endFrame; frame++) {
        const states = await getFrameStates(jobInstance, frame, cache);
        for (const state of states) {
            if (!state || state.removed || hasParent(state)) continue;
            if (state.objectType !== 'shape' && state.objectType !== 'track') continue;
            if (!matchesLabelFilter(state, targetLabel)) continue;
            if (targetClientID !== null && state.clientID !== targetClientID) continue;
            if (state.outside) continue;

            const key = getObjectInputKey(state);
            if (isLocked(state)) {
                locked.set(key, [...(locked.get(key) || []), frame]);
                continue;
            }

            const entry = found.get(key) || {
                state, frames: [], hideOps: 0, prevVisible: null,
            };

            // A hide operation is needed on the first visible frame of each visible run and on every keyframe
            if (entry.prevVisible === null || entry.prevVisible !== frame - 1 || state.keyframe) {
                entry.hideOps += 1;
            }

            entry.frames.push(frame);
            entry.prevVisible = frame;
            found.set(key, entry);
        }
    }

    for (const [key, entry] of found.entries()) {
        const { state, frames } = entry;
        const isSkeleton = state.shapeType === 'skeleton';
        const target: DeletionTarget = {
            key,
            clientID: state.clientID,
            serverID: typeof (state.serverID ?? state.id) === 'number' ? (state.serverID ?? state.id) : null,
            objectType: state.objectType,
            shapeType: state.shapeType,
            label: state.label?.name || '',
            mode: 'delete-shape',
            frames,
            historySteps: 1,
            freezeFrame: null,
            interpolationWarning: null,
        };

        if (state.objectType === 'track') {
            const firstKeyframe = state.keyframes?.first;
            const visibleBefore = typeof firstKeyframe === 'number' ? firstKeyframe < startFrame : true;
            let visibleAfter = false;
            let afterIsKeyframe = false;
            if (endFrame < stopFrame) {
                const after = await getObjectStateOnFrame(jobInstance, endFrame + 1, state.clientID, cache);
                visibleAfter = Boolean(after && !after.outside);
                afterIsKeyframe = Boolean(after && after.keyframe);
            }

            if (!visibleBefore && !visibleAfter) {
                target.mode = 'delete-track';
                target.historySteps = 1;
            } else {
                target.mode = 'hide-track-range';
                const freezeNeeded = visibleAfter && !afterIsKeyframe;
                target.freezeFrame = freezeNeeded ? endFrame + 1 : null;
                // cvat-core: a skeleton keyframe change records two undo steps, other tracks one
                const keyframeSteps = isSkeleton ? 2 : 1;
                const freezeSteps = freezeNeeded ? keyframeSteps : 0;
                target.historySteps = freezeSteps + entry.hideOps;

                if (NON_LINEAR_INTERPOLATION_TYPES.has(state.shapeType)) {
                    const spans: [number, number][] = [];
                    const atStart = await getObjectStateOnFrame(jobInstance, startFrame, state.clientID, cache);
                    const prev = atStart?.keyframes?.prev;
                    if (atStart && !atStart.outside && !atStart.keyframe &&
                        typeof prev === 'number' && prev < startFrame - 1) {
                        spans.push([prev + 1, startFrame - 1]);
                    }
                    if (target.freezeFrame !== null) {
                        const after = await getObjectStateOnFrame(
                            jobInstance, target.freezeFrame, state.clientID, cache,
                        );
                        const next = after?.keyframes?.next;
                        if (typeof next === 'number' && next > target.freezeFrame + 1) {
                            spans.push([target.freezeFrame + 1, next - 1]);
                        }
                    }
                    target.interpolationWarning = spans.length ? spans : null;
                }
            }
        }

        plan.targets.push(target);
    }

    plan.targets.sort((a, b) => (a.frames[0] - b.frames[0]) || (a.clientID - b.clientID));
    plan.skippedLocked = Array.from(locked.entries()).map(([key, frames]) => ({ key, frames }));
    plan.totalHistorySteps = plan.targets.reduce((acc, target) => acc + target.historySteps, 0);
    plan.exceedsHistoryLimit = plan.totalHistorySteps > CVAT_MAX_HISTORY_LENGTH;
    plan.isValid = plan.targets.length > 0 && !plan.exceedsHistoryLimit;
    if (plan.targets.length === 0) {
        plan.error = 'No unlocked visible objects match the filters in this range';
    } else if (plan.exceedsHistoryLimit) {
        plan.error = `This deletion needs ${plan.totalHistorySteps} undo steps, but CVAT keeps only ` +
            `${CVAT_MAX_HISTORY_LENGTH}. Narrow the frame range, type or ID so it stays fully undoable.`;
    }

    return plan;
}

export interface DeletionResult {
    deletedObjects: number;
    hiddenTracks: number;
    affectedFrames: number[];
    skippedLocked: string[];
    errors: string[];
    historySteps: number;
}

/**
 * Executes a plan created by planAnnotationDeletion with native CVAT ObjectState operations,
 * so each change is recorded in CVAT history (Undo/Redo) and marked as unsaved.
 * Objects are re-read and re-checked (lock, outside) before every change.
 */
export async function executeAnnotationDeletion(
    jobInstance: any,
    plan: DeletionPlan,
): Promise<DeletionResult> {
    const result: DeletionResult = {
        deletedObjects: 0,
        hiddenTracks: 0,
        affectedFrames: [],
        skippedLocked: [],
        errors: [],
        historySteps: 0,
    };

    if (!plan || !plan.isValid) {
        result.errors.push(plan?.error || 'Deletion plan is not valid');
        return result;
    }

    const affected = new Set<number>();
    const { startFrame, endFrame } = plan;

    for (const target of plan.targets) {
        try {
            if (target.mode === 'delete-shape' || target.mode === 'delete-track') {
                const [frame] = target.frames;
                const state = await getObjectStateOnFrame(jobInstance, frame, target.clientID);
                if (!state) {
                    result.errors.push(`${target.key}: object not found on frame ${frame}`);
                    continue;
                }
                if (isLocked(state)) {
                    result.skippedLocked.push(target.key);
                    continue;
                }

                const removed = await state.delete(frame, false);
                if (removed) {
                    result.deletedObjects += 1;
                    result.historySteps += 1;
                    target.frames.forEach((value) => affected.add(value));
                } else {
                    result.errors.push(`${target.key}: CVAT refused to delete the object`);
                }
                continue;
            }

            // hide-track-range: keep the track identity, make it outside only inside [startFrame, endFrame]
            if (target.freezeFrame !== null) {
                const after = await getObjectStateOnFrame(jobInstance, target.freezeFrame, target.clientID);
                if (after && !after.outside && !after.keyframe && !isLocked(after)) {
                    after.keyframe = true;
                    await after.save();
                    result.historySteps += target.shapeType === 'skeleton' ? 2 : 1;
                }
            }

            let hiddenAny = false;
            let frame = startFrame;
            while (frame <= endFrame) {
                const state = await getObjectStateOnFrame(jobInstance, frame, target.clientID);
                if (!state) {
                    frame += 1;
                    continue;
                }

                if (isLocked(state)) {
                    result.skippedLocked.push(target.key);
                    break;
                }

                if (!state.outside) {
                    state.outside = true;
                    const saved = await state.save();
                    result.historySteps += 1;
                    hiddenAny = true;
                    affected.add(frame);
                    const next = saved?.keyframes?.next;
                    if (typeof next === 'number' && next > frame) {
                        for (let value = frame + 1; value < next && value <= endFrame; value++) {
                            affected.add(value);
                        }
                        frame = next;
                    } else {
                        // no later keyframe: the track stays outside until the end
                        for (let value = frame + 1; value <= endFrame; value++) {
                            affected.add(value);
                        }
                        break;
                    }
                } else {
                    const next = state.keyframes?.next;
                    frame = typeof next === 'number' && next > frame ? next : frame + 1;
                }
            }

            if (hiddenAny) {
                result.hiddenTracks += 1;
            }
        } catch (error: any) {
            result.errors.push(`${target.key}: ${error?.message || 'unknown error'}`);
        }
    }

    result.affectedFrames = Array.from(affected)
        .filter((frame) => frame >= startFrame && frame <= endFrame)
        .sort((a, b) => a - b);
    result.skippedLocked = Array.from(new Set(result.skippedLocked));
    return result;
}

export interface HistorySnapshot {
    undo: [string, number | null][];
    redo: [string, number | null][];
}

function sameEntries(a: [string, number | null][], b: [string, number | null][]): boolean {
    return a.length === b.length && a.every((entry, idx) => entry[0] === b[idx][0] && entry[1] === b[idx][1]);
}

/**
 * Checks whether the last `count` undo steps are still the steps recorded by a deletion
 * (i.e. nothing else was done after it), so the whole deletion can be undone at once.
 */
export function canUndoDeletionBatch(
    current: HistorySnapshot | null, recorded: [string, number | null][], count: number,
): boolean {
    if (!current || count <= 0 || recorded.length !== count) return false;
    if (current.undo.length < count) return false;
    return sameEntries(current.undo.slice(-count), recorded);
}

/** Checks whether the deletion batch was undone and can be redone at once. */
export function canRedoDeletionBatch(
    current: HistorySnapshot | null, recorded: [string, number | null][], count: number,
): boolean {
    if (!current || count <= 0 || recorded.length !== count) return false;
    if (current.redo.length < count) return false;
    // redo stack keeps the most recently undone action on top (reverse order)
    return sameEntries(current.redo.slice(-count).reverse(), recorded);
}
