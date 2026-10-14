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
): [number, number] {
    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) {
            return [0, 0];
        }
        const currentIndex = validFrameNumbers.indexOf(currentFrame);
        if (currentIndex !== -1) {
            const startIdx = Math.max(0, currentIndex - 4);
            const endIdx = Math.min(validFrameNumbers.length - 1, Math.max(startIdx, currentIndex + 5));
            return [validFrameNumbers[startIdx], validFrameNumbers[endIdx]];
        }
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < validFrameNumbers.length; i++) {
            const diff = Math.abs(validFrameNumbers[i] - currentFrame);
            if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
            }
        }
        const startIdx = Math.max(0, closestIdx - 4);
        const endIdx = Math.min(validFrameNumbers.length - 1, Math.max(startIdx, closestIdx + 5));
        return [validFrameNumbers[startIdx], validFrameNumbers[endIdx]];
    }
    const clampedCurrent = Math.max(jobStartFrame, Math.min(jobStopFrame, currentFrame));
    const start = Math.max(jobStartFrame, clampedCurrent - 4);
    const end = Math.min(jobStopFrame, Math.max(start, clampedCurrent + 5));
    return [start, end];
}

export function getTotalBatches(
    rangeStart: number,
    rangeEnd: number,
    batchSize = 10,
    validFrameNumbers?: number[],
): number {
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
    if (Array.isArray(validFrameNumbers)) {
        if (validFrameNumbers.length === 0) return [];
        const framesInRange = validFrameNumbers.filter((f) => f >= rangeStart && f <= rangeEnd);
        const startIdx = batchIndex * batchSize;
        const endIdx = Math.min(framesInRange.length, startIdx + batchSize);
        if (startIdx >= framesInRange.length) return [];
        return framesInRange.slice(startIdx, endIdx);
    }
    const start = rangeStart + batchIndex * batchSize;
    const end = Math.min(rangeEnd, start + batchSize - 1);
    if (start > end) return [];

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

/**
 * Calculates the axis-aligned bounding box (AABB) for any CVAT 2D object or skeleton landmark.
 * Supported geometry types:
 *  - 'rectangle': [xtl, ytl, xbr, ybr]
 *  - 'polygon': [x1, y1, x2, y2, ...]
 *  - 'polyline': [x1, y1, x2, y2, ...]
 *  - 'points': [x1, y1, x2, y2, ...]
 *  - 'ellipse': [cx, cy, rightX, topY] -> [cx - rx, cy - ry, cx + rx, cy + ry]
 *  - 'cuboid': [x1, y1, ..., x8, y8] (2D projection vertices)
 *  - 'mask': [xtl, ytl, xbr, ybr, ...rle]
 *  - skeleton element: single [x, y] landmark
 *  - skeleton track: union of all non-outside visible elements
 */
export function getObjectBoundingBox(targetState: any, targetElementState?: any): BBox | null {
    if (!targetState) return null;

    // 1. If an individual landmark element of a skeleton is targeted
    if (targetElementState && Array.isArray(targetElementState.points) && targetElementState.points.length >= 2) {
        const [x, y] = targetElementState.points;
        return { xtl: x, ytl: y, xbr: x, ybr: y };
    }

    // 2. Skeletons (whole track): compute bounding box across all visible elements
    if (targetState.shapeType === 'skeleton' && Array.isArray(targetState.elements)) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let hasValidElement = false;

        for (const el of targetState.elements) {
            if (!el.outside && Array.isArray(el.points) && el.points.length >= 2) {
                const [x, y] = el.points;
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                    hasValidElement = true;
                }
            }
        }

        if (hasValidElement) {
            return { xtl: minX, ytl: minY, xbr: maxX, ybr: maxY };
        }
        return null;
    }

    // 3. Rectangles: points = [xtl, ytl, xbr, ybr]
    if (targetState.shapeType === 'rectangle' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 4. Ellipses: points = [cx, cy, rightX, topY]
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

    // 5. Masks: points = [xtl, ytl, xbr, ybr, ...]
    if (targetState.shapeType === 'mask' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 6. Polygons, Polylines, Points, Cuboids: array of (x, y) coordinates
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
 * Calculates a centered, padded, aspect-ratio-matched viewport for auto-zooming onto an object.
 *
 * @param bbox Bounding box of the object in image pixels
 * @param imageWidth Full frame width in pixels
 * @param imageHeight Full frame height in pixels
 * @param paddingRatio Fractional padding around the object (default 0.25 = 25% padding)
 * @param minDimension Minimum width/height in pixels to avoid over-zooming on points (default 120)
 */
export function calculateAutoZoomViewport(
    bbox: BBox,
    imageWidth: number,
    imageHeight: number,
    paddingRatio = 0.25,
    minDimension = 120,
): Viewport {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) };
    }

    const objWidth = Math.max(0, bbox.xbr - bbox.xtl);
    const objHeight = Math.max(0, bbox.ybr - bbox.ytl);
    const centerX = (bbox.xtl + bbox.xbr) / 2;
    const centerY = (bbox.ytl + bbox.ybr) / 2;

    // Apply padding with a minimum baseline
    const paddedWidth = Math.max(
        objWidth + Math.max(objWidth * paddingRatio * 2, minDimension * 0.4),
        minDimension,
    );
    const paddedHeight = Math.max(
        objHeight + Math.max(objHeight * paddingRatio * 2, minDimension * 0.4),
        minDimension,
    );

    // Target aspect ratio (matches original frame / tile canvas)
    const targetAspect = imageWidth / imageHeight;

    let vpWidth = paddedWidth;
    let vpHeight = paddedHeight;

    if (vpWidth / vpHeight < targetAspect) {
        // Viewport is too tall; expand width to match aspect ratio
        vpWidth = vpHeight * targetAspect;
    } else {
        // Viewport is too wide; expand height to match aspect ratio
        vpHeight = vpWidth / targetAspect;
    }

    // Never exceed full frame dimensions
    if (vpWidth >= imageWidth || vpHeight >= imageHeight) {
        return { x: 0, y: 0, width: imageWidth, height: imageHeight };
    }

    // Center the viewport on the object
    let vpX = centerX - vpWidth / 2;
    let vpY = centerY - vpHeight / 2;

    // Clamp within image bounds
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
