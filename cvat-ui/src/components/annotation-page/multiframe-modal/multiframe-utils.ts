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
        let endIdx = Math.min(validFrameNumbers.length - 1, startIdx + maxFrames - 1);
        if (endIdx - startIdx + 1 < maxFrames && startIdx > 0) {
            startIdx = Math.max(0, endIdx - maxFrames + 1);
        }
        return [validFrameNumbers[startIdx], validFrameNumbers[endIdx]];
    }

    const clampedCurrent = Math.max(jobStartFrame, Math.min(jobStopFrame, currentFrame));
    const half = Math.floor(maxFrames / 2);
    let start = Math.max(jobStartFrame, clampedCurrent - half);
    let end = Math.min(jobStopFrame, start + maxFrames - 1);
    if (end - start + 1 < maxFrames && start > jobStartFrame) {
        start = Math.max(jobStartFrame, end - maxFrames + 1);
    }
    return [start, end];
}

export function getTotalBatches(
    rangeStart: number,
    rangeEnd: number,
    batchSize = 16,
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
    batchSize = 16,
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
        return { status: 'NO_SELECTION', targetState: null, targetElementState: null, matchedClientID: null };
    }

    // Constraint 6: Standalone shapes are never matched across frames
    if (selectedState.objectType !== 'track') {
        return { status: 'NO_IDENTITY', targetState: null, targetElementState: null, matchedClientID: null };
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
            return { xtl: minX, ytl: minY, xbr: maxX, ybr: maxY };
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
        return { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) };
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
        return { x: 0, y: 0, width: imageWidth, height: imageHeight };
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
        return { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) };
    }

    const targetAspect = imageWidth / imageHeight;
    // Bound width between 20px and full frame width
    let width = Math.min(Math.max(20, vp.width), imageWidth);
    let height = width / targetAspect;

    if (height > imageHeight) {
        height = imageHeight;
        width = height * targetAspect;
    }

    let x = Math.max(0, Math.min(vp.x, imageWidth - width));
    let y = Math.max(0, Math.min(vp.y, imageHeight - height));

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

    return clampViewport({ x: newX, y: newY, width: newWidth, height: newHeight }, imageWidth, imageHeight);
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
        const clientID = state.clientID;
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
    const { fitWidth, fitHeight, offsetX, offsetY } = layout;

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
    batchSize: number = 16,
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
    batchSize: number = 16,
): MultiframeViewState {
    const computedBatch = Math.floor((nextFrame - currentState.rangeStart) / batchSize);
    return {
        ...currentState,
        zoomedFrame: nextFrame,
        batchIndex: computedBatch >= 0 ? computedBatch : currentState.batchIndex,
    };
}
