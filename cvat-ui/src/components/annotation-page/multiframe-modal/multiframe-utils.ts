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
export function getObjectBoundingBox(
    targetState: any,
    targetElementState?: any,
    allFrameStates?: any[],
): BBox | null {
    if (!targetState) return null;

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

    // 3. Direct points if targetState is a skeleton or track with 4 bounding box coordinates
    if (
        (targetState.shapeType === 'skeleton' || targetState.objectType === 'track') &&
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

    // 4. Look up associated bounding box rectangle in frame annotations (e.g. skeleton linked with box)
    if (Array.isArray(allFrameStates) && allFrameStates.length > 0) {
        const targetClientID = targetState.clientID;
        const targetGroupID = targetState.group?.id;
        const targetTrackID = typeof targetState.id === 'number' ? targetState.id : undefined;

        const associatedRect = allFrameStates.find((st: any) => {
            if (!st || st.outside || st.shapeType !== 'rectangle') return false;
            if (typeof targetClientID === 'number' && st.clientID === targetClientID) return true;
            if (typeof targetClientID === 'number' && st.parentID === targetClientID) return true;
            if (typeof targetState.parentID === 'number' && st.clientID === targetState.parentID) return true;
            if (typeof targetGroupID === 'number' && targetGroupID > 0 && st.group?.id === targetGroupID) return true;
            if (typeof targetTrackID === 'number' && st.id === targetTrackID) return true;
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

    // 5. If targetState is a skeleton and has no defined bounding box, do NOT derive from skeleton landmarks
    if (targetState.shapeType === 'skeleton') {
        return null;
    }

    // 6. Other standalone geometry types (masks, ellipses, polygons, polylines, cuboids)
    // Mask: [xtl, ytl, xbr, ybr, ...]
    if (targetState.shapeType === 'mask' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // Ellipse: [cx, cy, rightX, topY]
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

    // Standalone Polygons, Polylines, Points, Cuboids (non-skeleton):
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

    return {
        x: Math.round(vpX),
        y: Math.round(vpY),
        width: Math.round(vpWidth),
        height: Math.round(vpHeight),
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

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
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
 * Computes the readable zoom percentage for a given viewport relative to the full image width.
 */
export function calculateZoomPercentage(vp: Viewport, imageWidth: number): number {
    if (!vp || vp.width <= 0 || imageWidth <= 0) return 100;
    return Math.round((imageWidth / vp.width) * 100);
}

/**
 * Extracts and deduplicates selectable objects from an array of AnnotationStates.
 * Supports:
 *  - Tracks of all shape types
 *  - Skeleton parent tracks and individual landmark elements
 *  - Standalone shapes (annotated on current frame)
 */
export function extractSelectableObjects(states: any[]): SelectableObject[] {
    if (!Array.isArray(states) || states.length === 0) {
        return [];
    }

    const objectsMap = new Map<string, SelectableObject>();

    for (const state of states) {
        if (!state) continue;

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
                objectsMap.set(trackKey, {
                    key: trackKey,
                    clientID,
                    parentID: null,
                    trackID: typeof state.id === 'number' ? state.id : clientID,
                    labelID,
                    labelName,
                    shapeType,
                    objectType: 'track',
                    displayText: `Track #${clientID}${state.id ? ` [ID ${state.id}]` : ''}: ${labelName} (${shapeType})`,
                    color,
                    sourceState: state,
                });
            }

            // If it's a skeleton track, also extract its landmark elements
            if (shapeType === 'skeleton' && Array.isArray(state.elements)) {
                for (const el of state.elements) {
                    const elSublabelID = el.label?.id;
                    const elSublabelName = el.label?.name || 'Landmark';
                    const elKey = `element_${clientID}_${elSublabelID}`;

                    if (!objectsMap.has(elKey)) {
                        objectsMap.set(elKey, {
                            key: elKey,
                            clientID: el.clientID,
                            parentID: clientID,
                            sublabelID: elSublabelID,
                            labelID: elSublabelID,
                            labelName: elSublabelName,
                            shapeType: el.shapeType || 'points',
                            objectType: 'track',
                            displayText: `  ↳ ${labelName} #${clientID} → ${elSublabelName}`,
                            color: el.color || color,
                            sourceState: el,
                        });
                    }
                }
            }
        } else if (state.objectType === 'shape') {
            const shapeKey = `shape_${clientID}`;
            if (!objectsMap.has(shapeKey)) {
                objectsMap.set(shapeKey, {
                    key: shapeKey,
                    clientID,
                    parentID: null,
                    labelID,
                    labelName,
                    shapeType,
                    objectType: 'shape',
                    displayText: `Shape #${clientID}: ${labelName} (${shapeType})`,
                    color,
                    sourceState: state,
                });
            }
        }
    }

    return Array.from(objectsMap.values());
}
