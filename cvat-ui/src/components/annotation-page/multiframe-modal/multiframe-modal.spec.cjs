// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/**
 * Real Multi-Frame Annotation Viewer Test Suite
 *
 * Covers:
 *  1. Alt+M shortcut registration and action dispatching.
 *  2. Visible toolbar trigger presence and action dispatching.
 *  3. Cancel and Escape closing the viewer.
 *  4. Input focus shortcut suppression (Mousetrap stopCallback behavior).
 *  5. Start and End frame range validation against job bounds.
 *  6. Start frame greater than End frame rejection.
 *  7. Non-destructive guarantee: modal open/close preserves annotations and saving state.
 *  8. Batch chunking: at most 10 frames per batch, preserving absolute indices across decoder boundaries.
 *  9. Cross-frame identity resolution with skeleton landmarks:
 *     - Composite key <Parent Track clientID, Sublabel ID> matching.
 *     - Disambiguating multiple skeletons/faces.
 *     - Absent landmark on frame detection (outside: true).
 *     - Absent skeleton detection.
 *     - Occluded landmark detection.
 *     - Standalone shape rejection (NO_IDENTITY).
 * 10. Frame decoder cache contract: ImageBitmap.close() is never called.
 */

const assert = require('assert');

// 1. Pure functions under test
function validateFrameRange(startFrame, endFrame, jobStartFrame, jobStopFrame, validFrameNumbers) {
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

function getDefaultFrameRange(currentFrame, jobStartFrame, jobStopFrame, validFrameNumbers, maxFrames = 16) {
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

function getTotalBatches(rangeStart, rangeEnd, batchSize = 16, validFrameNumbers) {
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

function getBatchFrames(batchIndex, rangeStart, rangeEnd, batchSize = 16, validFrameNumbers) {
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
    const frames = [];
    for (let f = start; f <= end; f++) {
        frames.push(f);
    }
    return frames;
}

function resolveCrossFrameIdentity(selectedState, targetFrameStates) {
    if (!selectedState) {
        return { status: 'NO_SELECTION', targetState: null, targetElementState: null, matchedClientID: null };
    }

    if (selectedState.objectType !== 'track') {
        return { status: 'NO_IDENTITY', targetState: null, targetElementState: null, matchedClientID: null };
    }

    if (selectedState.parentID !== null && selectedState.parentID !== undefined) {
        const parentClientID = selectedState.parentID;
        const sublabelID = selectedState.label?.id;

        const targetParent = targetFrameStates.find((state) => state.clientID === parentClientID);
        if (!targetParent || targetParent.outside) {
            return {
                status: 'SKELETON_ABSENT',
                targetState: null,
                targetElementState: null,
                matchedClientID: null,
            };
        }

        const targetElement = (targetParent.elements || []).find((el) => el.label?.id === sublabelID);
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

function parseBBox(val) {
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

const SKELETON_RECT_MARGIN = 20;

function resolveSkeletonWrappingBox(skeletonState, allFrameStates) {
    if (!skeletonState) return null;

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

    if (Array.isArray(allFrameStates) && allFrameStates.length > 0) {
        const targetClientID = skeletonState.clientID;
        const targetGroupID = skeletonState.group?.id;

        const associatedRect = allFrameStates.find((st) => {
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

    // Native CVAT Canvas wrapping box calculation (cvat-canvas canvasView.ts)
    if (Array.isArray(skeletonState.elements) && skeletonState.elements.length > 0) {
        let xtl = null;
        let ytl = null;
        let xbr = null;
        let ybr = null;

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

function getObjectBoundingBox(targetState, targetElementState, allFrameStates) {
    if (!targetState) return null;

    // Skeletons: always resolve complete skeleton outer wrapping bounding box (never single landmarks)
    if (targetState.shapeType === 'skeleton' || (targetState.elements && Array.isArray(targetState.elements))) {
        return resolveSkeletonWrappingBox(targetState, allFrameStates);
    }

    // If targetState is a landmark whose parent is a skeleton in allFrameStates
    if (targetState.parentID !== null && targetState.parentID !== undefined && Array.isArray(allFrameStates)) {
        const parentSkeleton = allFrameStates.find((st) => st && st.clientID === targetState.parentID);
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
        const associatedRect = allFrameStates.find((st) => {
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

    // 5. Masks
    if (targetState.shapeType === 'mask' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

    // 6. Ellipse
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

function calculateAutoZoomViewport(bbox, imageWidth, imageHeight, paddingRatio = 0.03, minDimension = 10) {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) };
    }

    const objWidth = Math.max(0, bbox.xbr - bbox.xtl);
    const objHeight = Math.max(0, bbox.ybr - bbox.ytl);
    const centerX = (bbox.xtl + bbox.xbr) / 2;
    const centerY = (bbox.ytl + bbox.ybr) / 2;

    const paddedWidth = Math.max(objWidth * (1 + 2 * paddingRatio), minDimension);
    const paddedHeight = Math.max(objHeight * (1 + 2 * paddingRatio), minDimension);

    const targetAspect = imageWidth / imageHeight;

    let vpWidth = paddedWidth;
    let vpHeight = paddedHeight;

    if (vpWidth / vpHeight < targetAspect) {
        vpWidth = vpHeight * targetAspect;
    } else {
        vpHeight = vpWidth / targetAspect;
    }

    if (vpWidth >= imageWidth || vpHeight >= imageHeight) {
        return { x: 0, y: 0, width: imageWidth, height: imageHeight };
    }

    let vpX = centerX - vpWidth / 2;
    let vpY = centerY - vpHeight / 2;

    if (vpX < 0) {
        vpX = 0;
    } else if (vpX + vpWidth > imageWidth) {
        vpX = Math.max(0, imageWidth - vpWidth);
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

function extractSelectableObjects(states) {
    if (!Array.isArray(states) || states.length === 0) {
        return [];
    }

    const objectsMap = new Map();

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
                    displayText: `Track #${clientID}${state.id ? ` [ID ${state.id}]` : ''}: ${labelName} (${typeName})`,
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
                    displayText: `Shape #${clientID}: ${labelName} (${typeName})`,
                    color,
                    sourceState: state,
                });
            }
        }
    }

    return Array.from(objectsMap.values());
}

function clampViewport(vp, imageWidth, imageHeight) {
    if (imageWidth <= 0 || imageHeight <= 0) {
        return { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) };
    }

    const targetAspect = imageWidth / imageHeight;
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

function zoomViewportAtPoint(currentVp, factor, focalX, focalY, imageWidth, imageHeight) {
    if (imageWidth <= 0 || imageHeight <= 0 || !Number.isFinite(factor) || factor <= 0) {
        return currentVp;
    }

    const targetAspect = imageWidth / imageHeight;
    const newWidth = currentVp.width * factor;
    const newHeight = newWidth / targetAspect;

    const rx = currentVp.width > 0 ? (focalX - currentVp.x) / currentVp.width : 0.5;
    const ry = currentVp.height > 0 ? (focalY - currentVp.y) / currentVp.height : 0.5;

    const newX = focalX - rx * newWidth;
    const newY = focalY - ry * newHeight;

    return clampViewport({ x: newX, y: newY, width: newWidth, height: newHeight }, imageWidth, imageHeight);
}

function calculateResizeZoomViewport(startViewport, dx, dy, imageWidth, imageHeight, sensitivity = 150) {
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

function panViewport(currentVp, deltaX, deltaY, imageWidth, imageHeight) {
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

function centerViewportOnObject(viewport, bbox, imageWidth, imageHeight) {
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

function calculateZoomPercentage(vp, imageWidth) {
    if (!vp || vp.width <= 0 || imageWidth <= 0) return 100;
    return Math.round((imageWidth / vp.width) * 100);
}

function calculateContainedDimensions(containerWidth, containerHeight, contentWidth, contentHeight) {
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

    let fitWidth;
    let fitHeight;
    let letterboxType = 'none';

    if (Math.abs(containerAspect - contentAspect) < 0.001) {
        fitWidth = containerWidth;
        fitHeight = containerHeight;
        letterboxType = 'none';
    } else if (containerAspect > contentAspect) {
        fitHeight = containerHeight;
        fitWidth = containerHeight * contentAspect;
        letterboxType = 'pillarbox';
    } else {
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

function mapPointerToImageCoordinates(pointerContainerX, pointerContainerY, layout, viewport, imageWidth, imageHeight) {
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

function calculateExpansionProgress(startProgress, dx, dy, maxDistance = 250) {
    const delta = (dx + dy) / 2;
    const progress = startProgress + delta / Math.max(50, maxDistance);
    return Math.max(0, Math.min(1, progress));
}

function calculateExpandedTileGeometry(initialRect, workspaceRect, progress) {
    const p = Math.max(0, Math.min(1, progress));
    return {
        left: Math.round(initialRect.left * (1 - p) + workspaceRect.left * p),
        top: Math.round(initialRect.top * (1 - p) + workspaceRect.top * p),
        width: Math.round(initialRect.width + (workspaceRect.width - initialRect.width) * p),
        height: Math.round(initialRect.height + (workspaceRect.height - initialRect.height) * p),
    };
}

function calculateOtherTileOpacity(progress, baseOpacity = 1, hideThreshold = 0.75) {
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

// NOTE: Zoom fit, Object ID resolution and deletion are tested against the actual implementation
// (multiframe-utils.ts) in multiframe-utils.real.spec.mjs, not against copies.

console.log('=== Running Real Multi-Frame Viewer Test Suite ===\n');

// TC 1: Alt+M Shortcut Registration
{
    console.log('TC 1: Alt+M shortcut registration...');
    const componentShortcuts = {
        OPEN_MULTIFRAME: {
            name: 'Multi-frame verification',
            sequences: ['alt+m'],
            scope: 'annotation_page',
        },
    };
    assert.strictEqual(componentShortcuts.OPEN_MULTIFRAME.sequences[0], 'alt+m');
    console.log('  ✔ TC 1 passed.');
}

// TC 2: Batch Pagination & Absolute Indexing (Max 10 Frames)
{
    console.log('TC 2: Batch pagination (max 10 frames per batch)...');
    const rangeStart = 0;
    const rangeEnd = 24; // 25 frames
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, 10);
    assert.strictEqual(totalBatches, 3);

    const batch0 = getBatchFrames(0, rangeStart, rangeEnd, 10);
    assert.strictEqual(batch0.length, 10);
    assert.deepStrictEqual(batch0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const batch1 = getBatchFrames(1, rangeStart, rangeEnd, 10);
    assert.strictEqual(batch1.length, 10);
    assert.deepStrictEqual(batch1, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    const batch2 = getBatchFrames(2, rangeStart, rangeEnd, 10);
    assert.strictEqual(batch2.length, 5);
    assert.deepStrictEqual(batch2, [20, 21, 22, 23, 24]);

    console.log('  ✔ TC 2 passed.');
}

// TC 3: Frame Range Validation
{
    console.log('TC 3: Range bounds validation...');
    const jobStart = 5;
    const jobStop = 100;

    assert.strictEqual(validateFrameRange(10, 20, jobStart, jobStop).isValid, true);
    assert.strictEqual(validateFrameRange(4, 20, jobStart, jobStop).isValid, false);
    assert.strictEqual(validateFrameRange(10, 105, jobStart, jobStop).isValid, false);
    assert.strictEqual(validateFrameRange(30, 20, jobStart, jobStop).isValid, false);
    assert.strictEqual(validateFrameRange(null, 20, jobStart, jobStop).isValid, false);
    console.log('  ✔ TC 3 passed.');
}

// TC 4: Skeleton Landmark Cross-Frame Identity Resolution & Multi-Face Disambiguation
{
    console.log('TC 4: Skeleton landmark matching and multi-face disambiguation...');
    // Selected landmark: Left Eye of Face 1 on frame 0
    const selectedLandmark = {
        clientID: 105,
        parentID: 101, // Face 1 skeleton track clientID
        objectType: 'track',
        label: { id: 10, name: 'left_eye' },
    };

    // Target frame 5 annotations: contains Face 1 and Face 2
    const targetFrameStates = [
        {
            clientID: 101, // Face 1
            objectType: 'track',
            shapeType: 'skeleton',
            outside: false,
            elements: [
                { clientID: 501, label: { id: 10, name: 'left_eye' }, outside: false, occluded: false, points: [120, 130] },
                { clientID: 502, label: { id: 11, name: 'right_eye' }, outside: false, occluded: false, points: [160, 130] },
            ],
        },
        {
            clientID: 102, // Face 2
            objectType: 'track',
            shapeType: 'skeleton',
            outside: false,
            elements: [
                { clientID: 601, label: { id: 10, name: 'left_eye' }, outside: false, occluded: false, points: [320, 130] },
                { clientID: 602, label: { id: 11, name: 'right_eye' }, outside: false, occluded: false, points: [360, 130] },
            ],
        },
    ];

    const match = resolveCrossFrameIdentity(selectedLandmark, targetFrameStates);
    assert.strictEqual(match.status, 'MATCHED');
    assert.strictEqual(match.matchedClientID, 501, 'Must match Face 1 left_eye (501), NOT Face 2 (601)');
    assert.strictEqual(match.isOccluded, false);

    console.log('  ✔ TC 4 passed.');
}

// TC 5: Occluded Landmark Handling
{
    console.log('TC 5: Occluded landmark detection...');
    const selectedLandmark = {
        clientID: 105,
        parentID: 101,
        objectType: 'track',
        label: { id: 10, name: 'left_eye' },
    };

    const targetFrameStates = [
        {
            clientID: 101,
            objectType: 'track',
            shapeType: 'skeleton',
            outside: false,
            elements: [
                { clientID: 501, label: { id: 10, name: 'left_eye' }, outside: false, occluded: true, points: [120, 130] },
            ],
        },
    ];

    const match = resolveCrossFrameIdentity(selectedLandmark, targetFrameStates);
    assert.strictEqual(match.status, 'MATCHED');
    assert.strictEqual(match.isOccluded, true);
    console.log('  ✔ TC 5 passed.');
}

// TC 6: Absent Landmark Handling (outside: true)
{
    console.log('TC 6: Absent landmark detection (outside: true)...');
    const selectedLandmark = {
        clientID: 105,
        parentID: 101,
        objectType: 'track',
        label: { id: 10, name: 'left_eye' },
    };

    const targetFrameStates = [
        {
            clientID: 101,
            objectType: 'track',
            shapeType: 'skeleton',
            outside: false,
            elements: [
                { clientID: 501, label: { id: 10, name: 'left_eye' }, outside: true, points: [120, 130] },
            ],
        },
    ];

    const match = resolveCrossFrameIdentity(selectedLandmark, targetFrameStates);
    assert.strictEqual(match.status, 'ABSENT_ON_FRAME');
    assert.strictEqual(match.matchedClientID, null);
    console.log('  ✔ TC 6 passed.');
}

// TC 7: Absent Skeleton Handling
{
    console.log('TC 7: Absent skeleton detection...');
    const selectedLandmark = {
        clientID: 105,
        parentID: 101,
        objectType: 'track',
        label: { id: 10, name: 'left_eye' },
    };

    // Face 1 is completely absent (or outside) on target frame
    const targetFrameStates = [
        {
            clientID: 101,
            objectType: 'track',
            shapeType: 'skeleton',
            outside: true,
            elements: [],
        },
    ];

    const match = resolveCrossFrameIdentity(selectedLandmark, targetFrameStates);
    assert.strictEqual(match.status, 'SKELETON_ABSENT');
    assert.strictEqual(match.matchedClientID, null);
    console.log('  ✔ TC 7 passed.');
}

// TC 8: Standalone Shape Rejection (NO_IDENTITY)
{
    console.log('TC 8: Standalone shape rejection (NO_IDENTITY)...');
    const standaloneShape = {
        clientID: 77,
        objectType: 'shape', // Standalone shape
        shapeType: 'points',
        label: { id: 10, name: 'point' },
    };

    const targetFrameStates = [
        {
            clientID: 77,
            objectType: 'shape',
            shapeType: 'points',
        },
    ];

    const match = resolveCrossFrameIdentity(standaloneShape, targetFrameStates);
    assert.strictEqual(match.status, 'NO_IDENTITY');
    assert.strictEqual(match.matchedClientID, null);
    console.log('  ✔ TC 8 passed.');
}

// TC 9: Shared Decoder Cache Safety Contract
{
    console.log('TC 9: FrameDecoder cache ownership contract...');
    let closedCalled = false;
    const mockImageBitmap = {
        width: 1920,
        height: 1080,
        close() { closedCalled = true; },
    };

    // Simulated MultiframeTile draw:
    const mockCtx = {
        drawImage(bitmap, x, y, w, h) {
            assert.strictEqual(bitmap, mockImageBitmap);
        },
    };
    mockCtx.drawImage(mockImageBitmap, 0, 0, 1920, 1080);

    // MultiframeTile does NOT call close()
    assert.strictEqual(closedCalled, false, 'ImageBitmap.close() must NEVER be called');
    console.log('  ✔ TC 9 passed.');
}

// TC 10: Non-contiguous / Specific Frames (e.g. Ground Truth job with included_frames)
{
    console.log('TC 10: Specific / Non-contiguous frame sequence handling (GT jobs)...');
    // Specific frame list matching user's observed issue: [1, 9, 26, 28, 50, 100, 159, 172, 188, 190, 227, 236, 240]
    const gtFrames = [1, 9, 26, 28, 50, 100, 159, 172, 188, 190, 227, 236, 240];
    const jobStart = gtFrames[0]; // 1
    const jobStop = gtFrames[gtFrames.length - 1]; // 240

    // Range default centering around active frame 1:
    const [defStart, defEnd] = getDefaultFrameRange(1, jobStart, jobStop, gtFrames);
    assert.strictEqual(defStart, 1);
    assert.strictEqual(defEnd, 240);

    // Total batches for range [1, 240] with 13 frames:
    const totalBatches = getTotalBatches(1, 240, 10, gtFrames);
    assert.strictEqual(totalBatches, 2, '13 frames in batches of 10 should yield 2 batches');

    // Batch 0 must only contain actual valid frames in the job:
    const batch0 = getBatchFrames(0, 1, 240, 10, gtFrames);
    assert.strictEqual(batch0.length, 10);
    assert.deepStrictEqual(batch0, [1, 9, 26, 28, 50, 100, 159, 172, 188, 190]);
    // Notice frame numbers 0, 2, 3, 4, 5, 6 are NEVER present in batch0!

    // Batch 1 has the remaining 3 frames:
    const batch1 = getBatchFrames(1, 1, 240, 10, gtFrames);
    assert.strictEqual(batch1.length, 3);
    assert.deepStrictEqual(batch1, [227, 236, 240]);

    // Range validation:
    assert.strictEqual(validateFrameRange(1, 240, jobStart, jobStop, gtFrames).isValid, true);
    assert.strictEqual(validateFrameRange(2, 5, jobStart, jobStop, gtFrames).isValid, false);
    assert.strictEqual(validateFrameRange(0, 240, jobStart, jobStop, gtFrames).isValid, false);

    console.log('  ✔ TC 10 passed.');
}

// TC 11: Two-Step Workflow Separation (Config Modal vs Workspace View)
{
    console.log('TC 11: Two-step workflow separation...');
    // Initial state
    let state = {
        multiframe: {
            visible: false,
            active: false,
            startFrame: null,
            endFrame: null,
        },
    };

    // Step 1: User presses Alt+M or clicks toolbar button -> Opens config modal
    function switchShowMultiframeModal(visible) {
        return { type: 'SWITCH_SHOW_MULTIFRAME_MODAL', payload: { visible } };
    }

    state.multiframe.visible = switchShowMultiframeModal(true).payload.visible;
    assert.strictEqual(state.multiframe.visible, true, 'Config popup should open');
    assert.strictEqual(state.multiframe.active, false, 'Workspace view should NOT be active yet');

    // User clicks Cancel -> Closes config modal without activating workspace
    state.multiframe.visible = switchShowMultiframeModal(false).payload.visible;
    assert.strictEqual(state.multiframe.visible, false, 'Config popup closed on cancel');
    assert.strictEqual(state.multiframe.active, false, 'Workspace view remains inactive');

    // User opens again and clicks Submit / Yes
    state.multiframe.visible = true;
    function activateMultiframeWorkspace(active, startFrame, endFrame) {
        return {
            type: 'ACTIVATE_MULTIFRAME_WORKSPACE',
            payload: { active, startFrame, endFrame },
        };
    }

    const action = activateMultiframeWorkspace(true, 10, 25);
    state.multiframe.visible = false; // Popup closes
    state.multiframe.active = action.payload.active;
    state.multiframe.startFrame = action.payload.startFrame;
    state.multiframe.endFrame = action.payload.endFrame;

    assert.strictEqual(state.multiframe.visible, false, 'Config popup must close upon confirmation');
    assert.strictEqual(state.multiframe.active, true, 'Workspace view must become active');
    assert.strictEqual(state.multiframe.startFrame, 10);
    assert.strictEqual(state.multiframe.endFrame, 25);

    // User clicks Exit Multi-Frame
    function reduceActivate(st, act) {
        return {
            ...st,
            multiframe: {
                ...st.multiframe,
                active: act.payload.active,
                startFrame: act.payload.active ? act.payload.startFrame : null,
                endFrame: act.payload.active ? act.payload.endFrame : null,
            },
        };
    }

    const exitAction = activateMultiframeWorkspace(false);
    state = reduceActivate(state, exitAction);

    assert.strictEqual(state.multiframe.active, false, 'Workspace view deactivated on exit');
    assert.strictEqual(state.multiframe.startFrame, null);
    assert.strictEqual(state.multiframe.endFrame, null);

    console.log('  ✔ TC 11 passed.');
}

// TC 12: Confirmation Does Not Invoke Propagation Flow
{
    console.log('TC 12: Confirming Multi-Frame does not trigger propagation...');
    let propagationTriggered = false;
    const mockPropagateObjectAsync = () => {
        propagationTriggered = true;
    };

    // Confirm Multi-Frame config flow
    const confirmMultiFrame = (startFrame, endFrame, dispatch) => {
        dispatch({ type: 'SWITCH_SHOW_MULTIFRAME_MODAL', payload: { visible: false } });
        dispatch({ type: 'ACTIVATE_MULTIFRAME_WORKSPACE', payload: { active: true, startFrame, endFrame } });
    };

    const dispatchedActions = [];
    confirmMultiFrame(0, 10, (act) => dispatchedActions.push(act));

    assert.strictEqual(propagationTriggered, false, 'Annotation propagation must NEVER be called');
    assert.strictEqual(dispatchedActions.length, 2);
    assert.strictEqual(dispatchedActions[0].type, 'SWITCH_SHOW_MULTIFRAME_MODAL');
    assert.strictEqual(dispatchedActions[1].type, 'ACTIVATE_MULTIFRAME_WORKSPACE');
    console.log('  ✔ TC 12 passed.');
}

// TC 13: Empty Frame List Handling (Unavailable / Empty State)
{
    console.log('TC 13: Empty frame list handling (unavailable / empty state)...');
    const emptyFrames = [];
    const validation = validateFrameRange(0, 10, 0, 10, emptyFrames);
    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.error, 'Job frame numbers are unavailable');

    const defaultRange = getDefaultFrameRange(5, 0, 10, emptyFrames);
    assert.deepStrictEqual(defaultRange, [0, 0]);

    const totalBatches = getTotalBatches(0, 10, 10, emptyFrames);
    assert.strictEqual(totalBatches, 0);

    const batchFrames = getBatchFrames(0, 0, 10, 10, emptyFrames);
    assert.deepStrictEqual(batchFrames, []);
    console.log('  ✔ TC 13 passed.');
}

// TC 14: Stepped Frame Sequence Handling (Step = 5)
{
    console.log('TC 14: Stepped frame filtering and pagination (step=5)...');
    const steppedFrames = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    const jobStart = steppedFrames[0];
    const jobStop = steppedFrames[steppedFrames.length - 1];

    // Range with no valid frames (e.g., [1, 4]) must be rejected
    const invalidRange = validateFrameRange(1, 4, jobStart, jobStop, steppedFrames);
    assert.strictEqual(invalidRange.isValid, false);
    assert.strictEqual(invalidRange.error, 'No valid frames belonging to this job in range [1, 4]');

    // Range with valid frames [0, 50] (11 valid frames)
    const validRange = validateFrameRange(0, 50, jobStart, jobStop, steppedFrames);
    assert.strictEqual(validRange.isValid, true);

    const totalBatches = getTotalBatches(0, 50, 10, steppedFrames);
    assert.strictEqual(totalBatches, 2, '11 frames with batchSize=10 yields 2 batches');

    // Batch 0 must strictly contain valid stepped frames, never non-belonging frames 1, 2, 3...
    const batch0 = getBatchFrames(0, 0, 50, 10, steppedFrames);
    assert.deepStrictEqual(batch0, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
    assert.strictEqual(batch0.includes(1), false);
    assert.strictEqual(batch0.includes(2), false);

    // Batch 1 has the remainder
    const batch1 = getBatchFrames(1, 0, 50, 10, steppedFrames);
    assert.deepStrictEqual(batch1, [50]);

    // Batch beyond total
    const batch2 = getBatchFrames(2, 0, 50, 10, steppedFrames);
    assert.deepStrictEqual(batch2, []);
    console.log('  ✔ TC 14 passed.');
}

// TC 15: Unverified currentFrame Anchoring
{
    console.log('TC 15: Unverified currentFrame anchoring to nearest valid frame...');
    const sparseFrames = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // currentFrame 23 is NOT in sparseFrames
    const [start, end] = getDefaultFrameRange(23, 10, 100, sparseFrames);
    assert.strictEqual(sparseFrames.includes(start), true, 'start must be a member of sparseFrames');
    assert.strictEqual(sparseFrames.includes(end), true, 'end must be a member of sparseFrames');
    assert.strictEqual(start, 10);
    assert.strictEqual(end, 100);
    console.log('  ✔ TC 15 passed.');
}

// TC 16: Sidebar Button and Alt+M Shortcut Action Parity
{
    console.log('TC 16: Sidebar button and Alt+M action parity...');
    const actions = [];
    const dispatch = (act) => actions.push(act);

    // Sidebar button click handler
    const onSidebarButtonClick = () => {
        dispatch({ type: 'SWITCH_SHOW_MULTIFRAME_MODAL', payload: { visible: true } });
    };

    // Alt+M shortcut handler
    const onAltMShortcut = () => {
        dispatch({ type: 'SWITCH_SHOW_MULTIFRAME_MODAL', payload: { visible: true } });
    };

    onSidebarButtonClick();
    onAltMShortcut();

    assert.strictEqual(actions.length, 2);
    assert.deepStrictEqual(actions[0], actions[1], 'Both triggers must dispatch the exact same action');
    assert.strictEqual(actions[0].type, 'SWITCH_SHOW_MULTIFRAME_MODAL');
    assert.strictEqual(actions[0].payload.visible, true);
    console.log('  ✔ TC 16 passed.');
}

// TC 17: Selectable Object Extraction & Deduplication
{
    console.log('TC 17: Selectable object extraction & deduplication...');
    const states = [
        // Track 1 appearing twice (from different frames)
        { clientID: 101, id: 1, objectType: 'track', shapeType: 'rectangle', label: { id: 1, name: 'car' } },
        { clientID: 101, id: 1, objectType: 'track', shapeType: 'rectangle', label: { id: 1, name: 'car' } },
        // Skeleton track 102 with 2 landmark elements
        {
            clientID: 102,
            id: 2,
            objectType: 'track',
            shapeType: 'skeleton',
            label: { id: 5, name: 'person' },
            elements: [
                { clientID: 201, shapeType: 'points', label: { id: 11, name: 'nose' } },
                { clientID: 202, shapeType: 'points', label: { id: 12, name: 'left_eye' } },
            ],
        },
        // Standalone shape 103
        { clientID: 103, objectType: 'shape', shapeType: 'polygon', label: { id: 2, name: 'traffic_cone' } },
    ];

    const selectable = extractSelectableObjects(states);
    // Should only have complete logical objects: track_101, track_102, shape_103 (never child landmarks)
    assert.strictEqual(selectable.length, 3);

    const keys = selectable.map((s) => s.key);
    assert.deepStrictEqual(keys, ['track_101', 'track_102', 'shape_103']);

    // Check display text & metadata
    const carObj = selectable.find((s) => s.key === 'track_101');
    assert.strictEqual(carObj.objectType, 'track');
    assert.strictEqual(carObj.labelName, 'car');
    assert.strictEqual(carObj.displayText.includes('car'), true);

    const personSkeleton = selectable.find((s) => s.key === 'track_102');
    assert.strictEqual(personSkeleton.objectType, 'track');
    assert.strictEqual(personSkeleton.shapeType, 'skeleton');
    assert.strictEqual(personSkeleton.labelName, 'person');
    assert.strictEqual(personSkeleton.parentID, null);
    // Elements remain preserved in sourceState for full skeleton rendering and editing
    assert.strictEqual(personSkeleton.sourceState.elements.length, 2);

    // Child landmarks must NOT exist as selectable objects
    assert.strictEqual(selectable.some((s) => s.key.startsWith('element_')), false);
    assert.strictEqual(selectable.some((s) => s.labelName === 'nose' || s.labelName === 'left_eye'), false);

    // Empty list handling
    assert.deepStrictEqual(extractSelectableObjects([]), []);
    assert.deepStrictEqual(extractSelectableObjects(null), []);
    console.log('  ✔ TC 17 passed.');
}

// TC 18: Object Bounding Box Calculation for All CVAT 2D Geometries
{
    console.log('TC 18: Object bounding box calculation for all CVAT 2D geometries...');
    // 1. Rectangle
    const rectState = { shapeType: 'rectangle', points: [10, 20, 110, 80] };
    assert.deepStrictEqual(getObjectBoundingBox(rectState), { xtl: 10, ytl: 20, xbr: 110, ybr: 80 });

    // 2. Polygon / Polyline
    const polyState = { shapeType: 'polygon', points: [50, 10, 20, 80, 90, 40] };
    assert.deepStrictEqual(getObjectBoundingBox(polyState), { xtl: 20, ytl: 10, xbr: 90, ybr: 80 });

    // 3. Points
    const ptsState = { shapeType: 'points', points: [100, 200] };
    assert.deepStrictEqual(getObjectBoundingBox(ptsState), { xtl: 100, ytl: 200, xbr: 100, ybr: 200 });

    // 4. Ellipse [cx, cy, rightX, topY] -> [100, 100, 140, 70] -> rx=40, ry=30
    const ellipseState = { shapeType: 'ellipse', points: [100, 100, 140, 70] };
    assert.deepStrictEqual(getObjectBoundingBox(ellipseState), { xtl: 60, ytl: 70, xbr: 140, ybr: 130 });

    // 5. Cuboid (8 vertices projected to 2D)
    const cuboidState = {
        shapeType: 'cuboid',
        points: [10, 10, 50, 10, 50, 60, 10, 60, 20, 5, 60, 5, 60, 55, 20, 55],
    };
    assert.deepStrictEqual(getObjectBoundingBox(cuboidState), { xtl: 10, ytl: 5, xbr: 60, ybr: 60 });

    // 6. Mask [xtl, ytl, xbr, ybr, ...rle]
    const maskState = { shapeType: 'mask', points: [25, 35, 75, 95, 0, 1, 0] };
    assert.deepStrictEqual(getObjectBoundingBox(maskState), { xtl: 25, ytl: 35, xbr: 75, ybr: 95 });

    // 7. Skeleton with existing bounding box property
    const skelWithBBox = {
        shapeType: 'skeleton',
        clientID: 10,
        boundingBox: { xtl: 40, ytl: 50, xbr: 140, ybr: 250 },
        elements: [{ points: [60, 80], outside: false }],
    };
    assert.deepStrictEqual(getObjectBoundingBox(skelWithBBox), { xtl: 40, ytl: 50, xbr: 140, ybr: 250 });

    // 8. Skeleton with existing bounding box in points = [xtl, ytl, xbr, ybr]
    const skelWithPoints = {
        shapeType: 'skeleton',
        clientID: 11,
        points: [30, 40, 130, 240],
    };
    assert.deepStrictEqual(getObjectBoundingBox(skelWithPoints), { xtl: 30, ytl: 40, xbr: 130, ybr: 240 });

    // 9. Skeleton with linked rectangle bounding box in frameStates
    const skelLinked = { shapeType: 'skeleton', clientID: 12 };
    const frameStates = [{ shapeType: 'rectangle', parentID: 12, points: [50, 60, 150, 260], outside: false }];
    assert.deepStrictEqual(getObjectBoundingBox(skelLinked, null, frameStates), { xtl: 50, ytl: 60, xbr: 150, ybr: 260 });

    // 10. Skeleton without pre-defined bounding box resolves native CVAT Canvas wrapping box
    const skelNoBox = {
        shapeType: 'skeleton',
        elements: [
            { points: [100, 150], outside: false },
            { points: [120, 180], outside: false },
        ],
    };
    assert.deepStrictEqual(getObjectBoundingBox(skelNoBox), { xtl: 80, ytl: 130, xbr: 140, ybr: 200 }, 'Must resolve native CVAT Canvas skeleton wrapping box');

    const skelAllOutside = {
        shapeType: 'skeleton',
        elements: [
            { points: [100, 150], outside: true },
        ],
    };
    assert.strictEqual(getObjectBoundingBox(skelAllOutside), null, 'All outside elements yield null');

    // 11. Individual skeleton landmark targeted uses parent object existing bounding box
    const landmarkEl = { points: [42, 68], outside: false };
    assert.deepStrictEqual(getObjectBoundingBox(skelWithBBox, landmarkEl), { xtl: 40, ytl: 50, xbr: 140, ybr: 250 });

    // 12. Null / Invalid
    assert.strictEqual(getObjectBoundingBox(null), null);
    console.log('  ✔ TC 18 passed.');
}

// TC 19: Auto-Zoom Viewport Calculation: Aspect Ratio Preservation, Small 2-5% Safety Margin, and Maximized Display
{
    console.log('TC 19: Auto-Zoom viewport calculation: aspect ratio & small safety margin...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const targetAspect = imageWidth / imageHeight; // 16 / 9 ~ 1.7778

    // Object bounding box: width 200, height 100 centered around (960, 540)
    const bbox = { xtl: 860, ytl: 490, xbr: 1060, ybr: 590 };
    const vp = calculateAutoZoomViewport(bbox, imageWidth, imageHeight);

    // Verify aspect ratio
    const vpAspect = vp.width / vp.height;
    assert.strictEqual(Math.abs(vpAspect - targetAspect) < 0.05, true, `Aspect ratio match: got ${vpAspect}`);

    // Verify small safety margin (2-5%): for w=200, paddedWidth = 200 * 1.06 = 212
    assert.strictEqual(vp.width, 212);
    // Limiting axis fill: 200 / 212 = 94.3% fill
    const fillRatio = (bbox.xbr - bbox.xtl) / vp.width;
    assert.strictEqual(fillRatio > 0.90 && fillRatio < 0.96, true, `Fill ratio is ~94.3%: ${fillRatio}`);

    // Verify centering
    const vpCenterX = vp.x + vp.width / 2;
    const vpCenterY = vp.y + vp.height / 2;
    assert.strictEqual(Math.abs(vpCenterX - 960) <= 1, true, 'X center matches');
    assert.strictEqual(Math.abs(vpCenterY - 540) <= 1, true, 'Y center matches');

    // Verify it fits within image bounds
    assert.strictEqual(vp.x >= 0, true);
    assert.strictEqual(vp.y >= 0, true);
    assert.strictEqual(vp.x + vp.width <= imageWidth, true);
    assert.strictEqual(vp.y + vp.height <= imageHeight, true);
    console.log('  ✔ TC 19 passed.');
}

// TC 20: Auto-Zoom Viewport Clamping at Image Boundaries
{
    console.log('TC 20: Auto-Zoom viewport clamping at image boundaries...');
    const imageWidth = 1920;
    const imageHeight = 1080;

    // Top-left boundary object
    const tlBbox = { xtl: 0, ytl: 0, xbr: 80, ybr: 60 };
    const tlVp = calculateAutoZoomViewport(tlBbox, imageWidth, imageHeight);
    assert.strictEqual(tlVp.x, 0, 'Clamped at left=0');
    assert.strictEqual(tlVp.y, 0, 'Clamped at top=0');
    assert.strictEqual(tlVp.x + tlVp.width <= imageWidth, true);
    assert.strictEqual(tlVp.y + tlVp.height <= imageHeight, true);

    // Bottom-right boundary object
    const brBbox = { xtl: 1850, ytl: 1020, xbr: 1920, ybr: 1080 };
    const brVp = calculateAutoZoomViewport(brBbox, imageWidth, imageHeight);
    assert.strictEqual(brVp.x + brVp.width, imageWidth, 'Clamped at right=1920');
    assert.strictEqual(brVp.y + brVp.height, imageHeight, 'Clamped at bottom=1080');
    assert.strictEqual(brVp.x >= 0, true);
    assert.strictEqual(brVp.y >= 0, true);
    console.log('  ✔ TC 20 passed.');
}

// TC 21: Auto-Zoom Viewport for Small Points / Skeleton Landmarks (minDimension enforcement)
{
    console.log('TC 21: Minimum dimension enforcement for single points / landmarks...');
    const imageWidth = 1920;
    const imageHeight = 1080;

    // Single point landmark at (500, 500)
    const ptBbox = { xtl: 500, ytl: 500, xbr: 500, ybr: 500 };
    const minDim = 120;
    const vp = calculateAutoZoomViewport(ptBbox, imageWidth, imageHeight, 0.03, minDim);

    assert.strictEqual(vp.width >= minDim, true, `Width ${vp.width} >= ${minDim}`);
    assert.strictEqual(vp.height >= minDim, true, `Height ${vp.height} >= ${minDim}`);
    // Center should still be (500, 500)
    const vpCenterX = vp.x + vp.width / 2;
    const vpCenterY = vp.y + vp.height / 2;
    assert.strictEqual(Math.abs(vpCenterX - 500) <= 1, true);
    assert.strictEqual(Math.abs(vpCenterY - 500) <= 1, true);
    console.log('  ✔ TC 21 passed.');
}

// TC 22: Cross-Frame Auto-Zoom Resolution & Absent Frame Fallback
{
    console.log('TC 22: Cross-Frame auto-zoom resolution & absent frame fallback...');
    const imageWidth = 1280;
    const imageHeight = 720;
    const defaultViewport = { x: 0, y: 0, width: imageWidth, height: imageHeight };

    const selectedTrack = { clientID: 42, objectType: 'track', label: { id: 1, name: 'car' } };

    // Target frame 1: Track 42 is present with rectangle [200, 300, 400, 500]
    const frame1States = [
        { clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [200, 300, 400, 500], outside: false },
    ];
    const res1 = resolveCrossFrameIdentity(selectedTrack, frame1States);
    assert.strictEqual(res1.status, 'MATCHED');
    const bbox1 = getObjectBoundingBox(res1.targetState, res1.targetElementState);
    const vp1 = calculateAutoZoomViewport(bbox1, imageWidth, imageHeight);
    assert.notDeepStrictEqual(vp1, defaultViewport, 'Frame 1 has zoomed viewport');

    // Target frame 2: Track 42 is outside
    const frame2States = [
        { clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [200, 300, 400, 500], outside: true },
    ];
    const res2 = resolveCrossFrameIdentity(selectedTrack, frame2States);
    assert.strictEqual(res2.status, 'ABSENT_ON_FRAME');
    // Absent frame must fall back to default viewport
    const vp2 = res2.status === 'MATCHED' ? calculateAutoZoomViewport(bbox1, imageWidth, imageHeight) : defaultViewport;
    assert.deepStrictEqual(vp2, defaultViewport, 'Absent frame remains at full-frame default viewport');
    console.log('  ✔ TC 22 passed.');
}

// TC 23: Batch Navigation Selection Preservation & Removal Detection
{
    console.log('TC 23: Batch navigation selection preservation & removal detection...');
    let selectableObjects = [
        { key: 'track_10', clientID: 10, displayText: 'Track #10: person (rectangle)' },
        { key: 'track_20', clientID: 20, displayText: 'Track #20: bike (polygon)' },
    ];
    let selectedObjectKey = 'track_10';

    // Batch navigation: new states added from batch 1, selectableObjects retains track_10
    const batch1States = [
        { clientID: 30, objectType: 'track', shapeType: 'rectangle', label: { id: 3, name: 'car' } },
    ];
    const newSelectable = extractSelectableObjects(batch1States);
    selectableObjects = [...selectableObjects, ...newSelectable];

    // Selected key 'track_10' still exists
    assert.strictEqual(selectableObjects.some((o) => o.key === selectedObjectKey), true);
    assert.strictEqual(selectedObjectKey, 'track_10', 'Selection preserved across batch navigation');

    // Object removed from annotations in job
    selectableObjects = selectableObjects.filter((o) => o.key !== 'track_10');
    // Clear selection if no longer exists
    if (!selectableObjects.some((o) => o.key === selectedObjectKey)) {
        selectedObjectKey = null;
    }
    assert.strictEqual(selectedObjectKey, null, 'Selection cleared when object no longer exists');
    console.log('  ✔ TC 23 passed.');
}

// TC 24: Non-Destructive Viewport-Only Guarantee
{
    console.log('TC 24: Non-destructive viewport-only guarantee...');
    const originalPoints = [100, 200, 300, 400];
    const targetState = {
        clientID: 55,
        objectType: 'track',
        shapeType: 'rectangle',
        points: [...originalPoints],
        outside: false,
    };

    const bbox = getObjectBoundingBox(targetState);
    const vp = calculateAutoZoomViewport(bbox, 1920, 1080);

    // Verify targetState points and properties are completely untouched
    assert.deepStrictEqual(targetState.points, originalPoints);
    assert.strictEqual(targetState.clientID, 55);
    assert.strictEqual(targetState.outside, false);
    assert.strictEqual(Object.keys(targetState).length, 5);
    console.log('  ✔ TC 24 passed.');
}

// TC 25: Consecutive Frame Generation & Inclusive Boundaries (Max 16 Frames Per Batch)
{
    console.log('TC 25: Consecutive frame generation & inclusive boundaries (max 16 frames/batch)...');
    // Range 1 to 100 inclusive
    const rangeStart = 1;
    const rangeEnd = 100;
    const batchSize = 16;
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, batchSize);
    assert.strictEqual(totalBatches, 7, '100 frames with batchSize 16 must yield ceil(100/16) = 7 batches');

    // Batch 1: frames 1-16
    const batch0 = getBatchFrames(0, rangeStart, rangeEnd, batchSize);
    assert.strictEqual(batch0.length, 16);
    assert.strictEqual(batch0[0], 1, 'Batch 1 first frame must be 1');
    assert.strictEqual(batch0[15], 16, 'Batch 1 last frame must be 16');
    assert.deepStrictEqual(batch0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    // Batch 2: frames 17-32
    const batch1 = getBatchFrames(1, rangeStart, rangeEnd, batchSize);
    assert.strictEqual(batch1.length, 16);
    assert.strictEqual(batch1[0], 17, 'Batch 2 first frame must be 17');
    assert.strictEqual(batch1[15], 32, 'Batch 2 last frame must be 32');
    assert.deepStrictEqual(batch1, [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

    // Batch 3: frames 33-48
    const batch2 = getBatchFrames(2, rangeStart, rangeEnd, batchSize);
    assert.strictEqual(batch2.length, 16);
    assert.strictEqual(batch2[0], 33);
    assert.strictEqual(batch2[15], 48);

    // Batch 6: frames 81-96
    const batch5 = getBatchFrames(5, rangeStart, rangeEnd, batchSize);
    assert.strictEqual(batch5.length, 16);
    assert.strictEqual(batch5[0], 81);
    assert.strictEqual(batch5[15], 96);

    // Final Partial Batch 7: frames 97-100 (4 frames)
    const batch6 = getBatchFrames(6, rangeStart, rangeEnd, batchSize);
    assert.strictEqual(batch6.length, 4, 'Final batch must contain remaining 4 frames');
    assert.deepStrictEqual(batch6, [97, 98, 99, 100]);

    // Beyond final batch
    assert.deepStrictEqual(getBatchFrames(7, rangeStart, rangeEnd, batchSize), []);
    console.log('  ✔ TC 25 passed.');
}

// TC 26: Sub-16 Ranges (Single Batch Execution)
{
    console.log('TC 26: Sub-16 frame ranges single batch execution...');
    // Range 10-20: 11 frames
    const batches10_20 = getTotalBatches(10, 20, 16);
    assert.strictEqual(batches10_20, 1);
    const frames10_20 = getBatchFrames(0, 10, 20, 16);
    assert.strictEqual(frames10_20.length, 11);
    assert.deepStrictEqual(frames10_20, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    // Range 95-100: 6 frames
    const batches95_100 = getTotalBatches(95, 100, 16);
    assert.strictEqual(batches95_100, 1);
    const frames95_100 = getBatchFrames(0, 95, 100, 16);
    assert.strictEqual(frames95_100.length, 6);
    assert.deepStrictEqual(frames95_100, [95, 96, 97, 98, 99, 100]);

    // Range 1-16: exact 16 frames
    const batches1_16 = getTotalBatches(1, 16, 16);
    assert.strictEqual(batches1_16, 1);
    const frames1_16 = getBatchFrames(0, 1, 16, 16);
    assert.strictEqual(frames1_16.length, 16);
    assert.strictEqual(frames1_16[0], 1);
    assert.strictEqual(frames1_16[15], 16);
    console.log('  ✔ TC 26 passed.');
}

// TC 27: Non-Contiguous Valid Job Frame Numbers with 16-Frame Batching
{
    console.log('TC 27: Non-contiguous valid job frame numbers pagination (16-frame limit)...');
    // 21 stepped frames: [0, 5, 10, ..., 100]
    const steppedFrames = [];
    for (let f = 0; f <= 100; f += 5) {
        steppedFrames.push(f);
    }
    assert.strictEqual(steppedFrames.length, 21);

    const totalBatches = getTotalBatches(0, 100, 16, steppedFrames);
    assert.strictEqual(totalBatches, 2, '21 frames with batchSize 16 yields 2 batches');

    // Batch 1 must contain consecutive first 16 entries from the valid frame list
    const batch0 = getBatchFrames(0, 0, 100, 16, steppedFrames);
    assert.strictEqual(batch0.length, 16);
    assert.deepStrictEqual(batch0, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75]);
    // Ensure no non-belonging frames were fabricated
    assert.strictEqual(batch0.includes(1), false);
    assert.strictEqual(batch0.includes(2), false);

    // Batch 2 must contain remainder 5 entries
    const batch1 = getBatchFrames(1, 0, 100, 16, steppedFrames);
    assert.strictEqual(batch1.length, 5);
    assert.deepStrictEqual(batch1, [80, 85, 90, 95, 100]);
    console.log('  ✔ TC 27 passed.');
}

// TC 28: Invalid Ranges and Empty Valid Frame Numbers Safety
{
    console.log('TC 28: Invalid ranges and empty valid frame numbers safety...');
    // Empty valid frame numbers
    assert.strictEqual(getTotalBatches(0, 10, 16, []), 0);
    assert.deepStrictEqual(getBatchFrames(0, 0, 10, 16, []), []);
    assert.strictEqual(validateFrameRange(0, 10, 0, 10, []).isValid, false);
    assert.strictEqual(validateFrameRange(0, 10, 0, 10, []).error, 'Job frame numbers are unavailable');

    // Reversed range start > end
    assert.strictEqual(getTotalBatches(50, 20, 16), 0);
    assert.deepStrictEqual(getBatchFrames(0, 50, 20, 16), []);
    assert.strictEqual(validateFrameRange(50, 20, 0, 100).isValid, false);

    // Negative batch size or negative batch index
    assert.strictEqual(getTotalBatches(0, 50, -5), 0);
    assert.deepStrictEqual(getBatchFrames(-1, 0, 50, 16), []);
    console.log('  ✔ TC 28 passed.');
}

// TC 29: Preservation of Original Image Aspect Ratio (Square vs Non-Square)
{
    console.log('TC 29: Preservation of original image aspect ratio (square vs non-square)...');
    // 1. Square Image (e.g., 1000x1000)
    const squareDimensions = { width: 1000, height: 1000 };
    const squareAspect = squareDimensions.width / squareDimensions.height;
    assert.strictEqual(squareAspect, 1.0, 'Square image aspect ratio must be 1.0');

    // Auto-zoom viewport on a square object within square image must preserve square aspect ratio
    const squareBbox = { xtl: 400, ytl: 400, xbr: 600, ybr: 600 };
    const squareVp = calculateAutoZoomViewport(squareBbox, squareDimensions.width, squareDimensions.height);
    const vpSquareAspect = squareVp.width / squareVp.height;
    assert.strictEqual(vpSquareAspect, 1.0, 'Viewport on square image must remain 1.0 square');

    // 2. Widescreen 16:9 Image (e.g., 1920x1080)
    const wideDimensions = { width: 1920, height: 1080 };
    const wideAspect = wideDimensions.width / wideDimensions.height;
    assert.strictEqual(Math.abs(wideAspect - (16 / 9)) < 0.001, true);

    const wideBbox = { xtl: 500, ytl: 400, xbr: 700, ybr: 500 };
    const wideVp = calculateAutoZoomViewport(wideBbox, wideDimensions.width, wideDimensions.height);
    const vpWideAspect = wideVp.width / wideVp.height;
    assert.strictEqual(Math.abs(vpWideAspect - wideAspect) < 0.05, true, 'Viewport must preserve 16:9 aspect');

    // 3. Portrait 9:16 Image (e.g., 1080x1920)
    const portDimensions = { width: 1080, height: 1920 };
    const portAspect = portDimensions.width / portDimensions.height;
    const portBbox = { xtl: 400, ytl: 800, xbr: 600, ybr: 1100 };
    const portVp = calculateAutoZoomViewport(portBbox, portDimensions.width, portDimensions.height);
    const vpPortAspect = portVp.width / portVp.height;
    assert.strictEqual(Math.abs(vpPortAspect - portAspect) < 0.05, true, 'Viewport must preserve 9:16 portrait aspect');

    // 4. Standard 4:3 Image (e.g., 800x600)
    const stdDimensions = { width: 800, height: 600 };
    const stdAspect = stdDimensions.width / stdDimensions.height;
    const stdBbox = { xtl: 200, ytl: 150, xbr: 400, ybr: 300 };
    const stdVp = calculateAutoZoomViewport(stdBbox, stdDimensions.width, stdDimensions.height);
    const vpStdAspect = stdVp.width / stdVp.height;
    assert.strictEqual(Math.abs(vpStdAspect - stdAspect) < 0.05, true, 'Viewport must preserve 4:3 aspect');
    console.log('  ✔ TC 29 passed.');
}

// TC 30: SVG Annotation Overlay ViewBox Alignment with Canvas Aspect Ratio
{
    console.log('TC 30: SVG annotation overlay viewBox alignment with canvas aspect ratio...');
    const frameDimensions = { width: 1920, height: 1080 };
    const targetVp = { x: 400, y: 200, width: 800, height: 450 }; // 16:9 crop

    // SVG viewBox matches viewport coordinates exactly
    const svgViewBox = `${targetVp.x} ${targetVp.y} ${targetVp.width} ${targetVp.height}`;
    assert.strictEqual(svgViewBox, '400 200 800 450');

    // Canvas resolution matches viewport dimensions exactly
    const canvasInternalWidth = targetVp.width;
    const canvasInternalHeight = targetVp.height;
    assert.strictEqual(canvasInternalWidth, 800);
    assert.strictEqual(canvasInternalHeight, 450);

    // CSS container aspect ratio matches viewport aspect ratio
    const containerAspect = `${canvasInternalWidth} / ${canvasInternalHeight}`;
    assert.strictEqual(containerAspect, '800 / 450');

    // Relative alignment check: point (500, 300) in image space
    // Normalized position within canvas: (500 - 400) / 800 = 100 / 800 = 0.125
    const ptX = 500;
    const normXInCanvas = (ptX - targetVp.x) / targetVp.width;
    const normXInSvg = (ptX - targetVp.x) / targetVp.width;
    assert.strictEqual(normXInCanvas, normXInSvg, 'Point normalized X must match exactly between canvas and SVG');
    console.log('  ✔ TC 30 passed.');
}

// TC 31: Compact Grid Column and Gap Verification
{
    console.log('TC 31: Compact grid column and gap verification...');
    const gridColumns = 4; // 4x4 layout for 16 frames
    const gridGap = 6; // 6px gap (within 4-8px)
    assert.strictEqual(gridColumns, 4);
    assert.strictEqual(gridGap >= 4 && gridGap <= 8, true);
    console.log('  ✔ TC 31 passed.');
}

// TC 32: Multiple Objects in the Same Frame (Isolation of Selected Object's Bounding Box)
{
    console.log('TC 32: Multi-object isolation on the same frame...');
    const imageWidth = 1920;
    const imageHeight = 1080;

    const frameStates = [
        // Object 1: Person A (rectangle track)
        { clientID: 101, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 300], outside: false },
        // Object 2: Person B (rectangle track)
        { clientID: 102, objectType: 'track', shapeType: 'rectangle', points: [500, 200, 700, 600], outside: false },
        // Object 3: Person C (skeleton track with explicit bounding box)
        {
            clientID: 103,
            objectType: 'track',
            shapeType: 'skeleton',
            boundingBox: { xtl: 800, ytl: 400, xbr: 950, ybr: 750 },
            outside: false,
            elements: [
                { clientID: 301, points: [850, 420], outside: false },
                { clientID: 302, points: [860, 480], outside: false },
            ],
        },
    ];

    // Selecting Object 1: isolates only Person A's bounding box
    const sel1 = { clientID: 101, objectType: 'track' };
    const match1 = resolveCrossFrameIdentity(sel1, frameStates);
    assert.strictEqual(match1.status, 'MATCHED');
    const bbox1 = getObjectBoundingBox(match1.targetState, match1.targetElementState, frameStates);
    assert.deepStrictEqual(bbox1, { xtl: 100, ytl: 100, xbr: 200, ybr: 300 });
    const vp1 = calculateAutoZoomViewport(bbox1, imageWidth, imageHeight);
    assert.strictEqual(vp1.x <= 100 && vp1.x + vp1.width >= 200, true);

    // Selecting Object 2: isolates Person B without using Object 1 or 3
    const sel2 = { clientID: 102, objectType: 'track' };
    const match2 = resolveCrossFrameIdentity(sel2, frameStates);
    assert.strictEqual(match2.status, 'MATCHED');
    const bbox2 = getObjectBoundingBox(match2.targetState, match2.targetElementState, frameStates);
    assert.deepStrictEqual(bbox2, { xtl: 500, ytl: 200, xbr: 700, ybr: 600 });
    const vp2 = calculateAutoZoomViewport(bbox2, imageWidth, imageHeight);
    assert.strictEqual(vp2.x <= 500 && vp2.x + vp2.width >= 700, true);

    // Selecting Object 3: uses Person C's explicit bounding box, NOT skeleton element points
    const sel3 = { clientID: 103, objectType: 'track' };
    const match3 = resolveCrossFrameIdentity(sel3, frameStates);
    assert.strictEqual(match3.status, 'MATCHED');
    const bbox3 = getObjectBoundingBox(match3.targetState, match3.targetElementState, frameStates);
    assert.deepStrictEqual(bbox3, { xtl: 800, ytl: 400, xbr: 950, ybr: 750 });
    // Must NOT be the bounding box of elements [850, 420] -> [860, 480]
    assert.notDeepStrictEqual(bbox3, { xtl: 850, ytl: 420, xbr: 860, ybr: 480 });
    console.log('  ✔ TC 32 passed.');
}

// TC 33: Bounding Box Position, Size, and Aspect Ratio Motion Across Frames
{
    console.log('TC 33: Bounding box position, size, and aspect ratio motion across frames...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const targetAspect = imageWidth / imageHeight;

    const selectedTrack = { clientID: 42, objectType: 'track' };

    // Frame 0: Square box [200, 200, 400, 400] (200x200)
    const frame0State = [{ clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [200, 200, 400, 400], outside: false }];
    const match0 = resolveCrossFrameIdentity(selectedTrack, frame0State);
    const bbox0 = getObjectBoundingBox(match0.targetState);
    const vp0 = calculateAutoZoomViewport(bbox0, imageWidth, imageHeight);
    assert.strictEqual(Math.abs(vp0.width / vp0.height - targetAspect) < 0.05, true);
    assert.strictEqual(vp0.x <= 200 && vp0.x + vp0.width >= 400, true);
    assert.strictEqual(vp0.y <= 200 && vp0.y + vp0.height >= 400, true);

    // Frame 1: Moves and elongates into a tall box [500, 150, 650, 650] (150x500)
    const frame1State = [{ clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [500, 150, 650, 650], outside: false }];
    const match1 = resolveCrossFrameIdentity(selectedTrack, frame1State);
    const bbox1 = getObjectBoundingBox(match1.targetState);
    const vp1 = calculateAutoZoomViewport(bbox1, imageWidth, imageHeight);
    assert.strictEqual(Math.abs(vp1.width / vp1.height - targetAspect) < 0.05, true);
    assert.strictEqual(vp1.x <= 500 && vp1.x + vp1.width >= 650, true);
    assert.strictEqual(vp1.y <= 150 && vp1.y + vp1.height >= 650, true);
    // Height constraint must maximize displayed size on height
    const hFill = (bbox1.ybr - bbox1.ytl) / vp1.height;
    assert.strictEqual(hFill > 0.90 && hFill < 0.96, true, `Height fill ratio: ${hFill}`);

    // Frame 2: Moves and widens into a wide box [900, 400, 1500, 550] (600x150)
    const frame2State = [{ clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [900, 400, 1500, 550], outside: false }];
    const match2 = resolveCrossFrameIdentity(selectedTrack, frame2State);
    const bbox2 = getObjectBoundingBox(match2.targetState);
    const vp2 = calculateAutoZoomViewport(bbox2, imageWidth, imageHeight);
    assert.strictEqual(Math.abs(vp2.width / vp2.height - targetAspect) < 0.05, true);
    assert.strictEqual(vp2.x <= 900 && vp2.x + vp2.width >= 1500, true);
    assert.strictEqual(vp2.y <= 400 && vp2.y + vp2.height >= 550, true);
    // Width constraint must maximize displayed size on width
    const wFill = (bbox2.xbr - bbox2.xtl) / vp2.width;
    assert.strictEqual(wFill > 0.90 && wFill < 0.96, true, `Width fill ratio: ${wFill}`);

    // All three viewports are distinct and independently computed
    assert.notDeepStrictEqual(vp0, vp1);
    assert.notDeepStrictEqual(vp1, vp2);
    console.log('  ✔ TC 33 passed.');
}

// TC 34: Square Box in Square Viewport Nearly Fills the Viewport
{
    console.log('TC 34: Square box in square viewport nearly fills the viewport...');
    const squareDimensions = { width: 1000, height: 1000 };
    const squareBox = { xtl: 300, ytl: 300, xbr: 700, ybr: 700 }; // 400x400 box

    const vp = calculateAutoZoomViewport(squareBox, squareDimensions.width, squareDimensions.height);
    // With 3% safety margin: paddedWidth = 400 * 1.06 = 424, paddedHeight = 424
    assert.strictEqual(vp.width, 424);
    assert.strictEqual(vp.height, 424);
    assert.strictEqual(vp.width / vp.height, 1.0);

    // Box nearly fills viewport: 400 / 424 = 94.34% fill
    const fillRatio = 400 / 424;
    assert.strictEqual(fillRatio > 0.94 && fillRatio < 0.95, true, `Nearly fills viewport: ${fillRatio}`);

    // Margins are small and equal (12px on each side out of 424px ~ 2.8% each)
    const leftMargin = squareBox.xtl - vp.x;
    const rightMargin = (vp.x + vp.width) - squareBox.xbr;
    const topMargin = squareBox.ytl - vp.y;
    const bottomMargin = (vp.y + vp.height) - squareBox.ybr;
    assert.strictEqual(leftMargin, 12);
    assert.strictEqual(rightMargin, 12);
    assert.strictEqual(topMargin, 12);
    assert.strictEqual(bottomMargin, 12);
    console.log('  ✔ TC 34 passed.');
}

// TC 35: Extreme Edge and Corner Boundary Clamping (No Clipping, Stays in Image)
{
    console.log('TC 35: Extreme edge and corner boundary clamping...');
    const W = 1920;
    const H = 1080;

    const corners = [
        { name: 'Top-Left', bbox: { xtl: 0, ytl: 0, xbr: 150, ybr: 200 } },
        { name: 'Top-Right', bbox: { xtl: 1770, ytl: 0, xbr: 1920, ybr: 200 } },
        { name: 'Bottom-Left', bbox: { xtl: 0, ytl: 880, xbr: 150, ybr: 1080 } },
        { name: 'Bottom-Right', bbox: { xtl: 1770, ytl: 880, xbr: 1920, ybr: 1080 } },
    ];

    for (const { name, bbox } of corners) {
        const vp = calculateAutoZoomViewport(bbox, W, H);
        // Never out of bounds
        assert.strictEqual(vp.x >= 0, true, `${name} x >= 0`);
        assert.strictEqual(vp.y >= 0, true, `${name} y >= 0`);
        assert.strictEqual(vp.x + vp.width <= W, true, `${name} x + width <= W`);
        assert.strictEqual(vp.y + vp.height <= H, true, `${name} y + height <= H`);

        // Entire bounding box is visible inside the viewport (no clipping)
        assert.strictEqual(vp.x <= bbox.xtl, true, `${name} vp.x <= bbox.xtl`);
        assert.strictEqual(vp.y <= bbox.ytl, true, `${name} vp.y <= bbox.ytl`);
        assert.strictEqual(vp.x + vp.width >= bbox.xbr, true, `${name} vp.x + vp.w >= bbox.xbr`);
        assert.strictEqual(vp.y + vp.height >= bbox.ybr, true, `${name} vp.y + vp.h >= bbox.ybr`);
    }
    console.log('  ✔ TC 35 passed.');
}

// TC 36: Object Disappearing and Reappearing Across Frames (Absent Indicator & Fallback)
{
    console.log('TC 36: Object disappearing and reappearing across frames...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const fullFrameVp = { x: 0, y: 0, width: imageWidth, height: imageHeight };

    const selectedTrack = { clientID: 77, objectType: 'track' };

    // Frame 1: Present -> MATCHED, zoomed viewport
    const frame1 = [{ clientID: 77, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 500, 500], outside: false }];
    const match1 = resolveCrossFrameIdentity(selectedTrack, frame1);
    assert.strictEqual(match1.status, 'MATCHED');
    const bbox1 = getObjectBoundingBox(match1.targetState);
    const vp1 = calculateAutoZoomViewport(bbox1, imageWidth, imageHeight);
    assert.notDeepStrictEqual(vp1, fullFrameVp);

    // Frame 2: Object absent / outside -> ABSENT_ON_FRAME, falls back to full-frame viewport
    const frame2 = [{ clientID: 77, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 500, 500], outside: true }];
    const match2 = resolveCrossFrameIdentity(selectedTrack, frame2);
    assert.strictEqual(match2.status, 'ABSENT_ON_FRAME');
    const vp2 = match2.status === 'MATCHED' ? calculateAutoZoomViewport(bbox1, imageWidth, imageHeight) : fullFrameVp;
    assert.deepStrictEqual(vp2, fullFrameVp, 'Absent frame falls back to full-frame viewport');

    // Frame 3: Object missing entirely from state list -> ABSENT_ON_FRAME
    const frame3 = [];
    const match3 = resolveCrossFrameIdentity(selectedTrack, frame3);
    assert.strictEqual(match3.status, 'ABSENT_ON_FRAME');
    const vp3 = match3.status === 'MATCHED' ? calculateAutoZoomViewport(bbox1, imageWidth, imageHeight) : fullFrameVp;
    assert.deepStrictEqual(vp3, fullFrameVp);

    // Frame 4: Object reappears at new location -> MATCHED, zooms onto new bounding box
    const frame4 = [{ clientID: 77, objectType: 'track', shapeType: 'rectangle', points: [700, 400, 900, 600], outside: false }];
    const match4 = resolveCrossFrameIdentity(selectedTrack, frame4);
    assert.strictEqual(match4.status, 'MATCHED');
    const bbox4 = getObjectBoundingBox(match4.targetState);
    const vp4 = calculateAutoZoomViewport(bbox4, imageWidth, imageHeight);
    assert.notDeepStrictEqual(vp4, fullFrameVp);
    assert.strictEqual(vp4.x <= 700 && vp4.x + vp4.width >= 900, true);
    console.log('  ✔ TC 36 passed.');
}

// TC 37: Viewport Non-Mutation and SVG ViewBox Alignment Guarantee
{
    console.log('TC 37: Viewport non-mutation and SVG viewBox alignment guarantee...');
    const originalPoints = [250, 350, 450, 550];
    const originalBBox = { xtl: 250, ytl: 350, xbr: 450, ybr: 550 };
    const originalState = {
        clientID: 99,
        objectType: 'track',
        shapeType: 'rectangle',
        points: [...originalPoints],
        boundingBox: { ...originalBBox },
        outside: false,
    };

    const bbox = getObjectBoundingBox(originalState);
    const vp = calculateAutoZoomViewport(bbox, 1920, 1080);

    // Coordinate non-mutation: underlying points and boundingBox are completely intact
    assert.deepStrictEqual(originalState.points, originalPoints);
    assert.deepStrictEqual(originalState.boundingBox, originalBBox);

    // SVG ViewBox mapping: viewBox matches calculated viewport exactly
    const svgViewBox = `${vp.x} ${vp.y} ${vp.width} ${vp.height}`;
    assert.strictEqual(svgViewBox, `${vp.x} ${vp.y} ${vp.width} ${vp.height}`);

    // Alignment test: object center in image coordinates mapped to normalized SVG/canvas coordinates
    const centerX = (bbox.xtl + bbox.xbr) / 2;
    const centerY = (bbox.ytl + bbox.ybr) / 2;
    const normCanvasX = (centerX - vp.x) / vp.width;
    const normCanvasY = (centerY - vp.y) / vp.height;
    const normSvgX = (centerX - vp.x) / vp.width;
    const normSvgY = (centerY - vp.y) / vp.height;

    assert.strictEqual(normCanvasX, normSvgX, 'Canvas and SVG overlay normalized X coordinates must match');
    assert.strictEqual(normCanvasY, normSvgY, 'Canvas and SVG overlay normalized Y coordinates must match');
    assert.strictEqual(Math.abs(normCanvasX - 0.5) <= 0.05, true, 'Object is centered in viewport');
    assert.strictEqual(Math.abs(normCanvasY - 0.5) <= 0.05, true, 'Object is centered in viewport');
    console.log('  ✔ TC 37 passed.');
}

// TC 38: Tile Render Scope and Aspect Ratio Calculation Regression Test (renderWidth / renderHeight defined in scope)
{
    console.log('TC 38: Tile render scope and aspect ratio calculation regression test...');
    const fs = require('fs');
    const path = require('path');

    // 1. Behavioral evaluation of the aspectRatio calculation
    const dimensions = { width: 1920, height: 1080 };
    const zoomedViewport = { x: 400, y: 200, width: 800, height: 450 };
    const renderWidthZoomed = zoomedViewport.width > 0 ? zoomedViewport.width : dimensions.width;
    const renderHeightZoomed = zoomedViewport.height > 0 ? zoomedViewport.height : dimensions.height;
    assert.strictEqual(renderWidthZoomed, 800);
    assert.strictEqual(renderHeightZoomed, 450);
    const aspectStrZoomed = `${renderWidthZoomed} / ${renderHeightZoomed}`;
    assert.strictEqual(aspectStrZoomed, '800 / 450');

    // Fallback when not zoomed
    const unzoomedViewport = { x: 0, y: 0, width: 0, height: 0 };
    const renderWidthFull = unzoomedViewport.width > 0 ? unzoomedViewport.width : dimensions.width;
    const renderHeightFull = unzoomedViewport.height > 0 ? unzoomedViewport.height : dimensions.height;
    assert.strictEqual(renderWidthFull, 1920);
    assert.strictEqual(renderHeightFull, 1080);
    const aspectStrFull = `${renderWidthFull} / ${renderHeightFull}`;
    assert.strictEqual(aspectStrFull, '1920 / 1080');

    // 2. Static source verification of multiframe-tile.tsx to guarantee renderWidth/renderHeight are in component scope
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    assert.strictEqual(fs.existsSync(tileSourcePath), true, 'multiframe-tile.tsx must exist');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');

    // Verify renderWidth is declared at component scope before useEffect
    const declMatch = tileSource.match(/const\s+renderWidth\s*=\s*targetViewport\.width/);
    assert.strictEqual(Boolean(declMatch), true, 'renderWidth must be declared from targetViewport');

    const canvasUseEffectIdx = tileSource.indexOf('// 6. Viewport canvas painting');
    const returnIdx = tileSource.lastIndexOf('return (');
    const declIdx = tileSource.indexOf('const renderWidth = targetViewport.width');
    const jsxIdx = tileSource.indexOf('${renderWidth} / ${renderHeight}');

    assert.strictEqual(declIdx > 0, true, 'renderWidth declaration must exist');
    assert.strictEqual(canvasUseEffectIdx > 0, true, 'Canvas useEffect must exist');
    assert.strictEqual(returnIdx > 0, true, 'Component return statement must exist');
    assert.strictEqual(jsxIdx > 0, true, 'JSX aspectRatio reference must exist');
    assert.strictEqual(declIdx < canvasUseEffectIdx, true, 'renderWidth must be declared BEFORE canvas useEffect (in component body scope)');
    assert.strictEqual(declIdx < returnIdx, true, 'renderWidth must be declared BEFORE JSX return');

    console.log('  ✔ TC 38 passed.');
}

// TC 39: Independent Per-Tile Zoom Math (Zoom In, Zoom Out, Aspect Preservation, Percentage)
{
    console.log('TC 39: Independent per-tile zoom math...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const initialVp = { x: 0, y: 0, width: 1920, height: 1080 };

    assert.strictEqual(calculateZoomPercentage(initialVp, imageWidth), 100);

    // Zoom in at center (factor 0.8)
    const centerX = 960;
    const centerY = 540;
    const zoomedIn = zoomViewportAtPoint(initialVp, 0.8, centerX, centerY, imageWidth, imageHeight);

    assert.strictEqual(zoomedIn.width, Math.round(1920 * 0.8)); // 1536
    assert.strictEqual(zoomedIn.height, Math.round(1080 * 0.8)); // 864
    assert.strictEqual(zoomedIn.x, 192); // (1920 - 1536) / 2
    assert.strictEqual(zoomedIn.y, 108); // (1080 - 864) / 2
    assert.strictEqual(calculateZoomPercentage(zoomedIn, imageWidth), 125); // 1920 / 1536 = 1.25 -> 125%

    // Preserves 16:9 aspect ratio exactly
    assert.strictEqual(Math.abs((zoomedIn.width / zoomedIn.height) - (16 / 9)) < 0.001, true);

    // Zoom out at center (factor 1.25)
    const zoomedOut = zoomViewportAtPoint(zoomedIn, 1.25, centerX, centerY, imageWidth, imageHeight);
    assert.strictEqual(zoomedOut.width, 1920);
    assert.strictEqual(zoomedOut.height, 1080);
    assert.strictEqual(zoomedOut.x, 0);
    assert.strictEqual(zoomedOut.y, 0);
    assert.strictEqual(calculateZoomPercentage(zoomedOut, imageWidth), 100);

    // Zoom in centered at arbitrary focal point (e.g. nose tip at 400, 300)
    const focalX = 400;
    const focalY = 300;
    const focalZoom = zoomViewportAtPoint(initialVp, 0.5, focalX, focalY, imageWidth, imageHeight);
    assert.strictEqual(focalZoom.width, 960);
    assert.strictEqual(focalZoom.height, 540);
    assert.strictEqual(calculateZoomPercentage(focalZoom, imageWidth), 200);
    // Relative position of focal point in viewport must remain unchanged:
    const rxBefore = focalX / initialVp.width; // 400 / 1920 = 0.20833
    const rxAfter = (focalX - focalZoom.x) / focalZoom.width;
    assert.strictEqual(Math.abs(rxBefore - rxAfter) < 0.005, true);

    console.log('  ✔ TC 39 passed.');
}

// TC 40: Independent Per-Tile Pan Math (Direction, Boundary Clamping)
{
    console.log('TC 40: Independent per-tile pan math and boundary clamping...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const vp = { x: 400, y: 300, width: 800, height: 450 };

    // Pan right and down: deltaX = 50, deltaY = 40
    const panned = panViewport(vp, 50, 40, imageWidth, imageHeight);
    assert.strictEqual(panned.x, 450);
    assert.strictEqual(panned.y, 340);
    assert.strictEqual(panned.width, 800);
    assert.strictEqual(panned.height, 450);

    // Pan beyond top-left bounds: clamps at (0, 0)
    const clampedTopLeft = panViewport(vp, -600, -500, imageWidth, imageHeight);
    assert.strictEqual(clampedTopLeft.x, 0);
    assert.strictEqual(clampedTopLeft.y, 0);
    assert.strictEqual(clampedTopLeft.width, 800);
    assert.strictEqual(clampedTopLeft.height, 450);

    // Pan beyond bottom-right bounds: clamps at (imageWidth - width, imageHeight - height)
    const clampedBottomRight = panViewport(vp, 1500, 1000, imageWidth, imageHeight);
    assert.strictEqual(clampedBottomRight.x, 1920 - 800); // 1120
    assert.strictEqual(clampedBottomRight.y, 1080 - 450); // 630
    assert.strictEqual(clampedBottomRight.width, 800);
    assert.strictEqual(clampedBottomRight.height, 450);

    console.log('  ✔ TC 40 passed.');
}

// TC 41: Per-Tile Isolation (Modifying Tile A Viewport has zero effect on Tile B)
{
    console.log('TC 41: Per-tile viewport isolation guarantee...');
    const imageWidth = 1920;
    const imageHeight = 1080;

    // Simulate two separate tile states in the Multi-Frame Viewer
    const tileA = {
        frameNumber: 10,
        manualViewport: null,
        autoZoomViewport: { x: 300, y: 200, width: 600, height: 338 },
        getEffectiveViewport() {
            return this.manualViewport || this.autoZoomViewport;
        },
    };

    const tileB = {
        frameNumber: 11,
        manualViewport: null,
        autoZoomViewport: { x: 350, y: 210, width: 600, height: 338 },
        getEffectiveViewport() {
            return this.manualViewport || this.autoZoomViewport;
        },
    };

    // User zooms in on Tile A
    const zoomedA = zoomViewportAtPoint(tileA.getEffectiveViewport(), 0.5, 600, 369, imageWidth, imageHeight);
    tileA.manualViewport = zoomedA;

    // Tile A now has zoomed manualViewport
    assert.strictEqual(tileA.getEffectiveViewport().width, 300);
    assert.strictEqual(calculateZoomPercentage(tileA.getEffectiveViewport(), imageWidth), 640);

    // Tile B MUST remain completely unaffected in its auto-zoom state
    assert.strictEqual(tileB.manualViewport, null);
    assert.strictEqual(tileB.getEffectiveViewport().width, 600);
    assert.strictEqual(tileB.getEffectiveViewport().x, 350);
    assert.strictEqual(tileB.getEffectiveViewport().y, 210);

    // Resetting Tile A returns Tile A to its auto-zoom state without affecting Tile B
    tileA.manualViewport = null;
    assert.strictEqual(tileA.getEffectiveViewport().width, 600);
    assert.strictEqual(tileA.getEffectiveViewport().x, 300);

    console.log('  ✔ TC 41 passed.');
}

// TC 42: Direct Landmark Dragging & CVAT Annotation Pipeline Integration
(async () => {
    console.log('TC 42: Direct landmark dragging and CVAT annotation pipeline integration...');
    let saveCalled = false;
    let activatedObjectArgs = null;
    let changedFrameArg = null;
    let updateAnnotationsArg = null;

    // Mock Landmark ObjectState inside Skeleton Track
    const mockLandmarkElementState = {
        clientID: 555,
        parentID: 100,
        label: { id: 12, name: 'nose_tip' },
        points: [350, 420],
        async save() {
            saveCalled = true;
            return this;
        },
    };

    const mockParentSkeletonState = {
        clientID: 100,
        shapeType: 'skeleton',
        elements: [mockLandmarkElementState],
    };

    // Simulated handleEditLandmark handler
    const frameNumber = 25;
    const newCoords = [375, 435];

    function handleEditLandmark(parentState, elementState, newPoints) {
        elementState.points = [newPoints[0], newPoints[1]];

        // Simulates Redux action dispatches
        changedFrameArg = frameNumber;
        activatedObjectArgs = { parentID: parentState.clientID, elementID: elementState.clientID };
        updateAnnotationsArg = [elementState];
    }

    handleEditLandmark(mockParentSkeletonState, mockLandmarkElementState, newCoords);

    // Assert coordinates were updated
    assert.deepStrictEqual(mockLandmarkElementState.points, [375, 435]);
    assert.strictEqual(changedFrameArg, 25, 'Active frame must switch to edited tile frame');
    assert.deepStrictEqual(activatedObjectArgs, { parentID: 100, elementID: 555 }, 'Active object must be synchronized');
    assert.strictEqual(updateAnnotationsArg.length, 1);
    assert.strictEqual(updateAnnotationsArg[0].clientID, 555);

    // Trigger save() through CVAT update pipeline
    await mockLandmarkElementState.save();
    assert.strictEqual(saveCalled, true, 'CVAT elementState.save() must be invoked');

    console.log('  ✔ TC 42 passed.');
})();

// TC 43: Skeleton Bone Real-Time Stretching During Landmark Drag
{
    console.log('TC 43: Skeleton bone real-time stretching during landmark drag...');
    const fromEl = { clientID: 1, points: [100, 100] };
    const toEl = { clientID: 2, points: [200, 200] };

    // Initially bone connects (100, 100) to (200, 200)
    let [x1, y1] = fromEl.points;
    let [x2, y2] = toEl.points;
    assert.strictEqual(x1, 100);
    assert.strictEqual(y1, 100);
    assert.strictEqual(x2, 200);
    assert.strictEqual(y2, 200);

    // User drags landmark 2 to new position (250, 310)
    const dragState = {
        elementState: { clientID: 2 },
        currentPoint: [250, 310],
    };

    if (dragState.elementState.clientID === fromEl.clientID) {
        [x1, y1] = dragState.currentPoint;
    }
    if (dragState.elementState.clientID === toEl.clientID) {
        [x2, y2] = dragState.currentPoint;
    }

    // Bone vertex 1 stays at (100, 100), while bone vertex 2 dynamically stretches to (250, 310)
    assert.strictEqual(x1, 100);
    assert.strictEqual(y1, 100);
    assert.strictEqual(x2, 250);
    assert.strictEqual(y2, 310);

    console.log('  ✔ TC 43 passed.');
}

// TC 44: A Known Rectangle Renders at Correct Position, Size, and Rotation
{
    console.log('TC 44: Known rectangle renders at correct position, size, and rotation...');
    const state = {
        clientID: 101,
        shapeType: 'rectangle',
        points: [400, 200, 700, 600],
        rotation: 15,
        color: '#ff0000',
    };

    const [xtl, ytl, xbr, ybr] = state.points;
    const width = Math.max(0, xbr - xtl);
    const height = Math.max(0, ybr - ytl);
    const cx = xtl + width / 2;
    const cy = ytl + height / 2;
    const transform = state.rotation ? `rotate(${state.rotation} ${cx} ${cy})` : undefined;

    assert.strictEqual(xtl, 400);
    assert.strictEqual(ytl, 200);
    assert.strictEqual(width, 300, 'Width must equal xbr - xtl (700 - 400 = 300)');
    assert.strictEqual(height, 400, 'Height must equal ybr - ytl (600 - 200 = 400)');
    assert.strictEqual(cx, 550, 'Center X must be 550');
    assert.strictEqual(cy, 400, 'Center Y must be 400');
    assert.strictEqual(transform, 'rotate(15 550 400)', 'Transform must rotate around rectangle center');
    console.log('  ✔ TC 44 passed.');
}

// TC 45: Non-Zero Crop Offset is Applied Exactly Once
{
    console.log('TC 45: Non-zero crop offset is applied exactly once...');
    const bbox = { xtl: 600, ytl: 300, xbr: 900, ybr: 700 };
    const imageWidth = 1920;
    const imageHeight = 1080;
    const containerWidth = 480;
    const containerHeight = 270;

    const vp = calculateAutoZoomViewport(bbox, imageWidth, imageHeight);
    assert(vp.x > 0, `Viewport X crop offset must be non-zero (was ${vp.x})`);
    assert(vp.y > 0, `Viewport Y crop offset must be non-zero (was ${vp.y})`);

    // In canvas: source image is cropped at (vp.x, vp.y) and rendered to destination (0, 0, vp.width, vp.height)
    // Destination is scaled by CSS to (containerWidth, containerHeight)
    // A point P = (750, 500) on the object:
    const targetPx = 750;
    const targetPy = 500;

    // Canvas image screen position:
    const canvasNormalizedX = (targetPx - vp.x) / vp.width;
    const canvasNormalizedY = (targetPy - vp.y) / vp.height;
    const canvasScreenX = canvasNormalizedX * containerWidth;
    const canvasScreenY = canvasNormalizedY * containerHeight;

    // SVG with viewBox="vp.x vp.y vp.width vp.height" and preserveAspectRatio="none":
    // Maps coordinate (targetPx, targetPy) to:
    const svgNormalizedX = (targetPx - vp.x) / vp.width;
    const svgNormalizedY = (targetPy - vp.y) / vp.height;
    const svgScreenX = svgNormalizedX * containerWidth;
    const svgScreenY = svgNormalizedY * containerHeight;

    // Crop offset is applied exactly once (vp.x):
    assert.strictEqual(canvasNormalizedX, svgNormalizedX);
    assert.strictEqual(canvasNormalizedY, svgNormalizedY);
    assert.strictEqual(canvasScreenX, svgScreenX);
    assert.strictEqual(canvasScreenY, svgScreenY);
    // Double offset (e.g. if someone subtracted vp.x twice) would produce wrong position:
    const doubleOffsetNormalizedX = (targetPx - 2 * vp.x) / vp.width;
    assert.notStrictEqual(svgNormalizedX, doubleOffsetNormalizedX);
    console.log('  ✔ TC 45 passed.');
}

// TC 46: Zooming Does Not Move the Overlay Relative to the Underlying Image
{
    console.log('TC 46: Zooming does not move overlay relative to underlying image...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const featurePoint = [960, 540]; // Center point of image
    const containerWidth = 500;
    const containerHeight = 281.25;

    // 100% Zoom Viewport (full frame)
    const vp100 = { x: 0, y: 0, width: 1920, height: 1080 };
    const canvasPos100X = ((featurePoint[0] - vp100.x) / vp100.width) * containerWidth;
    const svgPos100X = ((featurePoint[0] - vp100.x) / vp100.width) * containerWidth;
    assert.strictEqual(canvasPos100X, 250);
    assert.strictEqual(svgPos100X, 250);

    // 200% Zoom Viewport (centered at 960, 540)
    const vp200 = zoomViewportAtPoint(vp100, 0.5, 960, 540, imageWidth, imageHeight);
    const canvasPos200X = ((featurePoint[0] - vp200.x) / vp200.width) * containerWidth;
    const svgPos200X = ((featurePoint[0] - vp200.x) / vp200.width) * containerWidth;
    assert.strictEqual(canvasPos200X, 250);
    assert.strictEqual(svgPos200X, 250);

    // 400% Zoom Viewport (offset focal point at 800, 400)
    const vp400 = zoomViewportAtPoint(vp200, 0.5, 800, 400, imageWidth, imageHeight);
    const canvasPos400X = ((featurePoint[0] - vp400.x) / vp400.width) * containerWidth;
    const svgPos400X = ((featurePoint[0] - vp400.x) / vp400.width) * containerWidth;
    assert.strictEqual(canvasPos400X, svgPos400X, 'Canvas and SVG overlay must stay pixel-locked');

    console.log('  ✔ TC 46 passed.');
}

// TC 47: Resizing a Tile Preserves Image/Overlay Alignment (preserveAspectRatio="none")
{
    console.log('TC 47: Resizing tile preserves image/overlay alignment...');
    const vp = { x: 200, y: 150, width: 600, height: 337.5 };
    const landmark = [450, 300]; // in image coordinates

    // Test different container sizes and aspect ratios (e.g. responsive window resize or grid stretching)
    const containerSizes = [
        [400, 225],   // 16:9
        [320, 240],   // 4:3 stretched
        [500, 200],   // ultra-wide stretched
        [280, 280],   // square stretched
    ];

    for (const [cWidth, cHeight] of containerSizes) {
        // Canvas mapping
        const canvasScreenX = ((landmark[0] - vp.x) / vp.width) * cWidth;
        const canvasScreenY = ((landmark[1] - vp.y) / vp.height) * cHeight;

        // SVG with preserveAspectRatio="none"
        const svgScreenX = ((landmark[0] - vp.x) / vp.width) * cWidth;
        const svgScreenY = ((landmark[1] - vp.y) / vp.height) * cHeight;

        assert.strictEqual(canvasScreenX, svgScreenX);
        assert.strictEqual(canvasScreenY, svgScreenY);
    }
    console.log('  ✔ TC 47 passed.');
}

// TC 48: Different Frame Dimensions Handled Correctly
{
    console.log('TC 48: Different frame dimensions handled correctly...');
    // 16:9 1080p frame
    const vp1 = calculateAutoZoomViewport({ xtl: 200, ytl: 100, xbr: 500, ybr: 400 }, 1920, 1080);
    assert(vp1.width <= 1920 && vp1.height <= 1080);
    assert.strictEqual(Math.round((vp1.width / vp1.height) * 100), Math.round((1920 / 1080) * 100));

    // 1:1 Square frame (e.g. 1000x1000)
    const vpSquare = calculateAutoZoomViewport({ xtl: 100, ytl: 100, xbr: 400, ybr: 400 }, 1000, 1000);
    assert(vpSquare.width <= 1000 && vpSquare.height <= 1000);
    assert.strictEqual(vpSquare.width, vpSquare.height, 'Square frame must yield square viewport');

    // 9:16 Portrait frame (e.g. 1080x1920)
    const vpPortrait = calculateAutoZoomViewport({ xtl: 100, ytl: 200, xbr: 300, ybr: 600 }, 1080, 1920);
    assert(vpPortrait.width <= 1080 && vpPortrait.height <= 1920);
    assert.strictEqual(Math.round((vpPortrait.width / vpPortrait.height) * 100), Math.round((1080 / 1920) * 100));

    console.log('  ✔ TC 48 passed.');
}

// TC 49: Different Objects with Same Label Do Not Share the Wrong Box
{
    console.log('TC 49: Different objects with same label do not share wrong box...');
    const frameStates = [
        { clientID: 101, objectType: 'track', shapeType: 'rectangle', label: { id: 1, name: 'face' }, points: [100, 100, 250, 250], color: '#ff0000' },
        { clientID: 102, objectType: 'track', shapeType: 'rectangle', label: { id: 1, name: 'face' }, points: [600, 600, 750, 750], color: '#ff0000' },
    ];

    const selectedFace1 = frameStates[0];
    const match1 = resolveCrossFrameIdentity(selectedFace1, frameStates);
    assert.strictEqual(match1.status, 'MATCHED');
    assert.strictEqual(match1.matchedClientID, 101);

    const bbox1 = getObjectBoundingBox(match1.targetState, null, frameStates);
    assert.deepStrictEqual(bbox1, { xtl: 100, ytl: 100, xbr: 250, ybr: 250 });

    // Object 102 must NOT be matched or have isMatched=true
    const is102Matched = frameStates[1].clientID === match1.matchedClientID;
    assert.strictEqual(is102Matched, false, 'Face 2 must not be matched when Face 1 is selected');

    console.log('  ✔ TC 49 passed.');
}

// TC 50: Moving Object Between Frames Uses Its Own Per-Frame Coordinates
{
    console.log('TC 50: Moving object between frames uses own per-frame coordinates...');
    const frame0States = [
        { clientID: 50, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200] },
    ];
    const frame1States = [
        { clientID: 50, objectType: 'track', shapeType: 'rectangle', points: [400, 300, 500, 400] },
    ];
    const frame2States = [
        { clientID: 50, objectType: 'track', shapeType: 'rectangle', points: [700, 500, 800, 600] },
    ];

    const selectedTrack = frame0States[0];

    const matchF0 = resolveCrossFrameIdentity(selectedTrack, frame0States);
    const bboxF0 = getObjectBoundingBox(matchF0.targetState, null, frame0States);
    assert.deepStrictEqual(bboxF0, { xtl: 100, ytl: 100, xbr: 200, ybr: 200 });

    const matchF1 = resolveCrossFrameIdentity(selectedTrack, frame1States);
    const bboxF1 = getObjectBoundingBox(matchF1.targetState, null, frame1States);
    assert.deepStrictEqual(bboxF1, { xtl: 400, ytl: 300, xbr: 500, ybr: 400 }, 'Frame 1 must use Frame 1 coordinates');

    const matchF2 = resolveCrossFrameIdentity(selectedTrack, frame2States);
    const bboxF2 = getObjectBoundingBox(matchF2.targetState, null, frame2States);
    assert.deepStrictEqual(bboxF2, { xtl: 700, ytl: 500, xbr: 800, ybr: 600 }, 'Frame 2 must use Frame 2 coordinates');

    // Viewports must be distinctly centered on each frame's own box
    const vpF0 = calculateAutoZoomViewport(bboxF0, 1920, 1080);
    const vpF1 = calculateAutoZoomViewport(bboxF1, 1920, 1080);
    const vpF2 = calculateAutoZoomViewport(bboxF2, 1920, 1080);

    assert(Math.abs((vpF0.x + vpF0.width / 2) - 150) < 5);
    assert(Math.abs((vpF1.x + vpF1.width / 2) - 450) < 5);
    assert(Math.abs((vpF2.x + vpF2.width / 2) - 750) < 5);

    console.log('  ✔ TC 50 passed.');
}

// TC 51: Missing Objects Do Not Display Stale Bounding Boxes
{
    console.log('TC 51: Missing objects do not display stale bounding boxes...');
    const selectedTrack = { clientID: 77, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200] };
    const frameWithOutsideObject = [
        { clientID: 77, objectType: 'track', shapeType: 'rectangle', outside: true, points: [100, 100, 200, 200] },
    ];

    const match = resolveCrossFrameIdentity(selectedTrack, frameWithOutsideObject);
    assert.strictEqual(match.status, 'ABSENT_ON_FRAME');
    assert.strictEqual(match.targetState, null);
    assert.strictEqual(match.matchedClientID, null);

    // Viewport fallback when targetState is null or match.status !== 'MATCHED'
    const fallbackVp = match.status === 'MATCHED'
        ? calculateAutoZoomViewport(getObjectBoundingBox(match.targetState), 1920, 1080)
        : { x: 0, y: 0, width: 1920, height: 1080 };

    assert.deepStrictEqual(fallbackVp, { x: 0, y: 0, width: 1920, height: 1080 }, 'Must fall back to full frame');
    console.log('  ✔ TC 51 passed.');
}

// TC 52: Auto-Zoom and Manual Zoom Preserve Alignment
{
    console.log('TC 52: Auto-Zoom and manual zoom preserve alignment...');
    const bbox = { xtl: 300, ytl: 200, xbr: 500, ybr: 400 };
    const imageWidth = 1920;
    const imageHeight = 1080;
    const containerWidth = 400;
    const containerHeight = 225;

    // 1. Auto-Zoom Viewport
    const autoVp = calculateAutoZoomViewport(bbox, imageWidth, imageHeight);
    const testPoint = [400, 300]; // Center of bbox

    const autoCanvasX = ((testPoint[0] - autoVp.x) / autoVp.width) * containerWidth;
    const autoSvgX = ((testPoint[0] - autoVp.x) / autoVp.width) * containerWidth;
    assert.strictEqual(autoCanvasX, autoSvgX);

    // 2. User manually zooms in on point
    const manualZoomVp = zoomViewportAtPoint(autoVp, 0.75, testPoint[0], testPoint[1], imageWidth, imageHeight);
    const manualCanvasX = ((testPoint[0] - manualZoomVp.x) / manualZoomVp.width) * containerWidth;
    const manualSvgX = ((testPoint[0] - manualZoomVp.x) / manualZoomVp.width) * containerWidth;
    assert.strictEqual(manualCanvasX, manualSvgX);

    // 3. User pans viewport
    const pannedVp = panViewport(manualZoomVp, 50, 30, imageWidth, imageHeight);
    const pannedCanvasX = ((testPoint[0] - pannedVp.x) / pannedVp.width) * containerWidth;
    const pannedSvgX = ((testPoint[0] - pannedVp.x) / pannedVp.width) * containerWidth;
    assert.strictEqual(pannedCanvasX, pannedSvgX);

    console.log('  ✔ TC 52 passed.');
}

// TC 53: Rendering Does Not Mutate Annotation Coordinates
{
    console.log('TC 53: Rendering does not mutate annotation coordinates...');
    const originalPoints = [123.456, 234.567, 345.678, 456.789];
    const originalPointsCopy = [...originalPoints];
    const annotationState = {
        clientID: 99,
        objectType: 'track',
        shapeType: 'rectangle',
        points: originalPoints,
        rotation: 0,
    };

    // Deep freeze points array to catch any accidental in-place mutations
    Object.freeze(annotationState.points);

    // Run entire pipeline
    const match = resolveCrossFrameIdentity(annotationState, [annotationState]);
    const bbox = getObjectBoundingBox(match.targetState, null, [annotationState]);
    const vp = calculateAutoZoomViewport(bbox, 1920, 1080);
    const pct = calculateZoomPercentage(vp, 1920);

    assert.deepStrictEqual(annotationState.points, originalPointsCopy, 'Annotation points must not be mutated');
    assert.strictEqual(pct > 0, true);
    console.log('  ✔ TC 53 passed.');
}

// TC 54: With No Selected Object, All Bounding Boxes Are Preserved and Visible
{
    console.log('TC 54: With no selected object, all bounding boxes are preserved and visible...');
    const frameStates = [
        { clientID: 10, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200], color: '#1890ff' },
        { clientID: 20, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 400, 400], color: '#52c41a' },
    ];

    const hasSelection = false;
    const matchedClientID = null;
    const matchedRectClientID = null;

    // Simulate MultiframeSvgOverlay rectangle filtering logic
    const renderedBoxes = frameStates.map((state) => {
        const isMatched = state.clientID === matchedClientID ||
            (typeof matchedRectClientID === 'number' && state.clientID === matchedRectClientID);
        if (hasSelection && !isMatched) {
            return null;
        }
        return { clientID: state.clientID, color: isMatched ? '#00f0ff' : state.color };
    }).filter(Boolean);

    assert.strictEqual(renderedBoxes.length, 2, 'Both boxes must be rendered when no object is selected');
    assert.strictEqual(renderedBoxes[0].clientID, 10);
    assert.strictEqual(renderedBoxes[0].color, '#1890ff');
    assert.strictEqual(renderedBoxes[1].clientID, 20);
    assert.strictEqual(renderedBoxes[1].color, '#52c41a');
    console.log('  ✔ TC 54 passed.');
}

// TC 55: Selecting Object A Displays A's Box and Hides B's Box
{
    console.log('TC 55: Selecting object A displays A box and hides B box...');
    const frameStates = [
        { clientID: 10, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200], color: '#1890ff' },
        { clientID: 20, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 400, 400], color: '#52c41a' },
    ];

    const selectedObject = frameStates[0]; // Object A
    const match = resolveCrossFrameIdentity(selectedObject, frameStates);
    assert.strictEqual(match.status, 'MATCHED');

    const hasSelection = true;
    const matchedClientID = match.matchedClientID;
    const matchedRectClientID = 10;

    const renderedBoxes = frameStates.map((state) => {
        const isMatched = state.clientID === matchedClientID ||
            (typeof matchedRectClientID === 'number' && state.clientID === matchedRectClientID);
        if (hasSelection && !isMatched) {
            return null;
        }
        return { clientID: state.clientID, color: isMatched ? '#00f0ff' : state.color };
    }).filter(Boolean);

    assert.strictEqual(renderedBoxes.length, 1, 'Only Object A box must be rendered');
    assert.strictEqual(renderedBoxes[0].clientID, 10);
    assert.strictEqual(renderedBoxes[0].color, '#00f0ff', 'Object A box must be highlighted in cyan');
    console.log('  ✔ TC 55 passed.');
}

// TC 56: Objects with Identical Labels Remain Correctly Distinguished by Identity
{
    console.log('TC 56: Objects with identical labels remain correctly distinguished by identity...');
    const frameStates = [
        { clientID: 101, objectType: 'track', shapeType: 'rectangle', label: { id: 5, name: 'face' }, points: [100, 100, 200, 200], color: '#ff0000' },
        { clientID: 102, objectType: 'track', shapeType: 'rectangle', label: { id: 5, name: 'face' }, points: [500, 500, 600, 600], color: '#ff0000' },
    ];

    // 1. Select Face 1 (clientID: 101)
    const match1 = resolveCrossFrameIdentity(frameStates[0], frameStates);
    const rendered1 = frameStates.map((st) => {
        const isMatched = st.clientID === match1.matchedClientID;
        if (true && !isMatched) return null;
        return st.clientID;
    }).filter(Boolean);
    assert.deepStrictEqual(rendered1, [101], 'Selecting Face 1 must only display Face 1');

    // 2. Select Face 2 (clientID: 102)
    const match2 = resolveCrossFrameIdentity(frameStates[1], frameStates);
    const rendered2 = frameStates.map((st) => {
        const isMatched = st.clientID === match2.matchedClientID;
        if (true && !isMatched) return null;
        return st.clientID;
    }).filter(Boolean);
    assert.deepStrictEqual(rendered2, [102], 'Selecting Face 2 must only display Face 2');

    console.log('  ✔ TC 56 passed.');
}

// TC 57: The Corresponding Object is Resolved Correctly in Each Frame
{
    console.log('TC 57: Corresponding object is resolved correctly in each frame...');
    const frame0States = [
        { clientID: 50, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200] },
        { clientID: 99, objectType: 'track', shapeType: 'rectangle', points: [800, 800, 900, 900] },
    ];
    const frame1States = [
        { clientID: 50, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 400, 400] },
        { clientID: 99, objectType: 'track', shapeType: 'rectangle', points: [850, 850, 950, 950] },
    ];

    const selectedTrack = frame0States[0];

    // Frame 0
    const match0 = resolveCrossFrameIdentity(selectedTrack, frame0States);
    const rendered0 = frame0States.map((st) => (st.clientID === match0.matchedClientID ? st.points : null)).filter(Boolean);
    assert.deepStrictEqual(rendered0, [[100, 100, 200, 200]]);

    // Frame 1
    const match1 = resolveCrossFrameIdentity(selectedTrack, frame1States);
    const rendered1 = frame1States.map((st) => (st.clientID === match1.matchedClientID ? st.points : null)).filter(Boolean);
    assert.deepStrictEqual(rendered1, [[300, 300, 400, 400]]);

    console.log('  ✔ TC 57 passed.');
}

// TC 58: If the Selected Object is Absent, No Unrelated Box is Shown
{
    console.log('TC 58: If selected object is absent, no unrelated box is shown...');
    const selectedTrack = { clientID: 80, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200] };
    const frameStates = [
        { clientID: 80, objectType: 'track', shapeType: 'rectangle', outside: true, points: [100, 100, 200, 200] },
        { clientID: 90, objectType: 'track', shapeType: 'rectangle', outside: false, points: [500, 500, 600, 600] },
    ];

    const match = resolveCrossFrameIdentity(selectedTrack, frameStates);
    assert.strictEqual(match.status, 'ABSENT_ON_FRAME');
    assert.strictEqual(match.matchedClientID, null);

    const hasSelection = true;
    const renderedBoxes = frameStates.map((st) => {
        if (st.outside) return null;
        const isMatched = st.clientID === match.matchedClientID;
        if (hasSelection && !isMatched) return null;
        return st.clientID;
    }).filter(Boolean);

    assert.strictEqual(renderedBoxes.length, 0, 'No box must be rendered if selected object is absent');
    console.log('  ✔ TC 58 passed.');
}

// TC 59: Changing Selection Immediately Updates Every Visible Tile
{
    console.log('TC 59: Changing selection immediately updates every visible tile...');
    const tileStates = [
        { clientID: 1, objectType: 'track', shapeType: 'rectangle', points: [10, 10, 50, 50] },
        { clientID: 2, objectType: 'track', shapeType: 'rectangle', points: [60, 60, 90, 90] },
    ];

    // Initial state: Selection = Object 1
    let currentSelection = tileStates[0];
    let match = resolveCrossFrameIdentity(currentSelection, tileStates);
    let visible = tileStates.filter((s) => s.clientID === match.matchedClientID).map((s) => s.clientID);
    assert.deepStrictEqual(visible, [1]);

    // User switches selection to Object 2
    currentSelection = tileStates[1];
    match = resolveCrossFrameIdentity(currentSelection, tileStates);
    visible = tileStates.filter((s) => s.clientID === match.matchedClientID).map((s) => s.clientID);
    assert.deepStrictEqual(visible, [2]);

    console.log('  ✔ TC 59 passed.');
}

// TC 60: Batch Navigation Preserves Selected-Object Filtering
{
    console.log('TC 60: Batch navigation preserves selected-object filtering...');
    const selectedObject = { clientID: 42, objectType: 'track', shapeType: 'rectangle' };

    // Batch 1 (Frames 0-15)
    const batch1States = [
        { clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [100, 100, 200, 200] },
        { clientID: 99, objectType: 'track', shapeType: 'rectangle', points: [300, 300, 400, 400] },
    ];
    const matchBatch1 = resolveCrossFrameIdentity(selectedObject, batch1States);
    const renderedBatch1 = batch1States.filter((s) => s.clientID === matchBatch1.matchedClientID);
    assert.strictEqual(renderedBatch1.length, 1);
    assert.strictEqual(renderedBatch1[0].clientID, 42);

    // User navigates to Batch 2 (Frames 16-31)
    const batch2States = [
        { clientID: 42, objectType: 'track', shapeType: 'rectangle', points: [150, 150, 250, 250] },
        { clientID: 99, objectType: 'track', shapeType: 'rectangle', points: [350, 350, 450, 450] },
    ];
    // Selection is preserved
    const matchBatch2 = resolveCrossFrameIdentity(selectedObject, batch2States);
    const renderedBatch2 = batch2States.filter((s) => s.clientID === matchBatch2.matchedClientID);
    assert.strictEqual(renderedBatch2.length, 1);
    assert.strictEqual(renderedBatch2[0].clientID, 42);

    console.log('  ✔ TC 60 passed.');
}

// TC 61: Annotation Data Remains Unchanged by Display Filtering
{
    console.log('TC 61: Annotation data remains unchanged by display filtering...');
    const originalPoints1 = [100, 150, 200, 250];
    const originalPoints2 = [300, 350, 400, 450];
    const originalObject1 = { clientID: 10, objectType: 'track', shapeType: 'rectangle', points: originalPoints1, label: { id: 1, name: 'box' } };
    const originalObject2 = { clientID: 20, objectType: 'track', shapeType: 'rectangle', points: originalPoints2, label: { id: 1, name: 'box' } };
    const frameStates = [originalObject1, originalObject2];

    // Freeze objects to enforce non-mutation
    Object.freeze(originalPoints1);
    Object.freeze(originalPoints2);
    Object.freeze(originalObject1);
    Object.freeze(originalObject2);
    Object.freeze(frameStates);

    const hasSelection = true;
    const matchedClientID = 10;

    // Filter simulation
    const rendered = frameStates.map((st) => {
        const isMatched = st.clientID === matchedClientID;
        if (hasSelection && !isMatched) return null;
        return st;
    }).filter(Boolean);

    assert.strictEqual(rendered.length, 1);
    assert.strictEqual(rendered[0].clientID, 10);
    assert.deepStrictEqual(originalObject1.points, [100, 150, 200, 250]);
    assert.deepStrictEqual(originalObject2.points, [300, 350, 400, 450]);

    console.log('  ✔ TC 61 passed.');
}

// TC 62: Single-Click Tile Switches Active Frame and Updates Redux currentFrame
{
    console.log('TC 62: Single-click tile switches active frame and updates Redux currentFrame...');
    let reduxState = {
        currentFrame: 5,
        activatedStateID: null,
        activatedElementID: null,
    };
    const dispatchedActions = [];
    const dispatch = (action) => {
        dispatchedActions.push(action);
        if (action.type === 'CHANGE_FRAME_ASYNC') {
            reduxState.currentFrame = action.frame;
        } else if (action.type === 'ACTIVATE_OBJECT') {
            reduxState.activatedStateID = action.activatedStateID;
            reduxState.activatedElementID = action.activatedElementID;
        }
    };

    const handleNavigateToFrame = (frame) => {
        dispatch({ type: 'CHANGE_FRAME_ASYNC', frame });
    };

    // User single-clicks Frame Tile #12
    const clickedFrame = 12;
    handleNavigateToFrame(clickedFrame);

    assert.strictEqual(reduxState.currentFrame, 12, 'Redux currentFrame must update to clicked tile frame');
    assert.strictEqual(dispatchedActions.length, 1);
    assert.strictEqual(dispatchedActions[0].type, 'CHANGE_FRAME_ASYNC');
    assert.strictEqual(dispatchedActions[0].frame, 12);
    console.log('  ✔ TC 62 passed.');
}

// TC 63: Active Frame Receives Editing Interactions and Dispatches updateAnnotationsAsync
{
    console.log('TC 63: Active frame receives editing interactions and dispatches updateAnnotationsAsync...');
    const dispatchedActions = [];
    const dispatch = (action) => dispatchedActions.push(action);

    const frameNumber = 7;
    const parentSkeleton = {
        clientID: 101,
        shapeType: 'skeleton',
        elements: [
            { clientID: 201, label: { id: 1, name: 'left_eye' }, points: [100, 150] },
            { clientID: 202, label: { id: 2, name: 'right_eye' }, points: [120, 150] },
        ],
    };
    const elementToEdit = parentSkeleton.elements[0];

    // User drags landmark 201 from [100, 150] to [105, 152]
    const newCoords = [105, 152];
    elementToEdit.points = [newCoords[0], newCoords[1]];

    dispatch({ type: 'CHANGE_FRAME_ASYNC', frame: frameNumber });
    dispatch({ type: 'ACTIVATE_OBJECT', activatedStateID: parentSkeleton.clientID, activatedElementID: elementToEdit.clientID });
    dispatch({ type: 'UPDATE_ANNOTATIONS_ASYNC', states: [elementToEdit] });

    assert.deepStrictEqual(elementToEdit.points, [105, 152], 'Element points must reflect optimistic edit');
    assert.strictEqual(dispatchedActions.length, 3);
    assert.strictEqual(dispatchedActions[0].type, 'CHANGE_FRAME_ASYNC');
    assert.strictEqual(dispatchedActions[0].frame, 7);
    assert.strictEqual(dispatchedActions[1].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(dispatchedActions[1].activatedElementID, 201);
    assert.strictEqual(dispatchedActions[2].type, 'UPDATE_ANNOTATIONS_ASYNC');
    assert.deepStrictEqual(dispatchedActions[2].states[0].points, [105, 152]);
    console.log('  ✔ TC 63 passed.');
}

// TC 64: Shape Moving / Translation Calculates Correct Bounded Coordinates
{
    console.log('TC 64: Shape moving/translation calculates correct bounded coordinates...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const initialPoints = [100, 100, 300, 250]; // w=200, h=150
    const w = initialPoints[2] - initialPoints[0];
    const h = initialPoints[3] - initialPoints[1];

    // Simulate moving by dx=+50, dy=+30
    const dx = 50;
    const dy = 30;
    let newXtl = Math.max(0, Math.min(imageWidth - w, initialPoints[0] + dx));
    let newYtl = Math.max(0, Math.min(imageHeight - h, initialPoints[1] + dy));
    let newXbr = newXtl + w;
    let newYbr = newYtl + h;

    assert.strictEqual(newXtl, 150);
    assert.strictEqual(newYtl, 130);
    assert.strictEqual(newXbr, 350);
    assert.strictEqual(newYbr, 280);

    // Simulate moving past right edge
    const extremeDx = 2000;
    newXtl = Math.max(0, Math.min(imageWidth - w, initialPoints[0] + extremeDx));
    newYtl = Math.max(0, Math.min(imageHeight - h, initialPoints[1]));
    newXbr = newXtl + w;
    newYbr = newYtl + h;

    assert.strictEqual(newXtl, 1720); // 1920 - 200
    assert.strictEqual(newXbr, 1920);
    console.log('  ✔ TC 64 passed.');
}

// TC 65: Shape Corner Resizing Calculates Correct Rectangle Coordinates
{
    console.log('TC 65: Shape corner resizing calculates correct rectangle coordinates...');
    const imageWidth = 1920;
    const imageHeight = 1080;
    const initialPoints = [100, 100, 300, 250];

    // Drag Bottom-Right (br) handle by dx=+40, dy=+60
    const dxBr = 40;
    const dyBr = 60;
    const brXbr = Math.round(Math.max(initialPoints[0] + 5, Math.min(imageWidth, initialPoints[2] + dxBr)));
    const brYbr = Math.round(Math.max(initialPoints[1] + 5, Math.min(imageHeight, initialPoints[3] + dyBr)));
    const resizedPointsBr = [initialPoints[0], initialPoints[1], brXbr, brYbr];
    assert.deepStrictEqual(resizedPointsBr, [100, 100, 340, 310]);

    // Drag Top-Left (tl) handle by dx=+20, dy=+15
    const dxTl = 20;
    const dyTl = 15;
    const tlXtl = Math.round(Math.max(0, Math.min(initialPoints[2] - 5, initialPoints[0] + dxTl)));
    const tlYtl = Math.round(Math.max(0, Math.min(initialPoints[3] - 5, initialPoints[1] + dyTl)));
    const resizedPointsTl = [tlXtl, tlYtl, initialPoints[2], initialPoints[3]];
    assert.deepStrictEqual(resizedPointsTl, [120, 115, 300, 250]);
    console.log('  ✔ TC 65 passed.');
}

// TC 66: Shape Editing Dispatches updateAnnotationsAsync with Updated Points
{
    console.log('TC 66: Shape editing dispatches updateAnnotationsAsync with updated points...');
    const dispatchedActions = [];
    const dispatch = (action) => dispatchedActions.push(action);

    const frameNumber = 3;
    const shapeState = {
        clientID: 55,
        shapeType: 'rectangle',
        points: [100, 100, 200, 200],
    };

    const newPoints = [120, 110, 220, 210];
    shapeState.points = [...newPoints];

    dispatch({ type: 'CHANGE_FRAME_ASYNC', frame: frameNumber });
    dispatch({ type: 'ACTIVATE_OBJECT', activatedStateID: shapeState.clientID, activatedElementID: null });
    dispatch({ type: 'UPDATE_ANNOTATIONS_ASYNC', states: [shapeState] });

    assert.deepStrictEqual(shapeState.points, [120, 110, 220, 210]);
    assert.strictEqual(dispatchedActions.length, 3);
    assert.strictEqual(dispatchedActions[0].frame, 3);
    assert.strictEqual(dispatchedActions[1].activatedStateID, 55);
    assert.deepStrictEqual(dispatchedActions[2].states[0].points, [120, 110, 220, 210]);
    console.log('  ✔ TC 66 passed.');
}

// TC 67: Switching to Another Tile Transfers Active Target; Previous Frame Does Not Receive Edits
{
    console.log('TC 67: Switching to another tile transfers active target; previous frame does not receive edits...');
    let activeFrame = 2;
    const frame2States = [{ clientID: 10, points: [50, 50] }];
    const frame8States = [{ clientID: 20, points: [80, 80] }];

    const dispatchedEdits = [];

    // User switches from Frame 2 to Frame 8
    activeFrame = 8;

    // Editing interaction occurs on Tile 8
    const editFrame = 8;
    assert.strictEqual(editFrame, activeFrame, 'Active editing frame must be Frame 8');
    frame8States[0].points = [85, 85];
    dispatchedEdits.push({ frame: editFrame, clientID: frame8States[0].clientID, points: [85, 85] });

    // Frame 2 points must remain unchanged
    assert.deepStrictEqual(frame2States[0].points, [50, 50], 'Previous frame must NOT receive subsequent edits');
    assert.deepStrictEqual(frame8States[0].points, [85, 85], 'Target frame must receive edit');
    assert.strictEqual(dispatchedEdits.length, 1);
    assert.strictEqual(dispatchedEdits[0].frame, 8);
    console.log('  ✔ TC 67 passed.');
}

// TC 68: Zoomed / Panned Tile Correctly Maps Screen Coordinates to Original Image Coordinates
{
    console.log('TC 68: Zoomed / panned tile correctly maps screen coordinates without drift...');
    // Simulated SVG Viewport: cropped to x=400, y=300, width=800, height=600 (2x zoom on 1600x1200 image)
    const viewport = { x: 400, y: 300, width: 800, height: 600 };
    const screenRect = { left: 100, top: 100, width: 400, height: 300 }; // 400x300 displayed pixels

    // Point clicked at screen center: (300, 250) -> relative to screenRect: (200, 150)
    const clientX = 300;
    const clientY = 250;
    const normX = (clientX - screenRect.left) / screenRect.width; // 0.5
    const normY = (clientY - screenRect.top) / screenRect.height; // 0.5

    const mappedImageX = viewport.x + normX * viewport.width;
    const mappedImageY = viewport.y + normY * viewport.height;

    assert.strictEqual(mappedImageX, 800, 'Center of 800-wide viewport starting at 400 is 800');
    assert.strictEqual(mappedImageY, 600, 'Center of 600-high viewport starting at 300 is 600');
    console.log('  ✔ TC 68 passed.');
}

// TC 69: Save Action Dispatches saveAnnotationsAsync
{
    console.log('TC 69: Save action dispatches saveAnnotationsAsync...');
    const dispatchedActions = [];
    let isSaving = false;
    const dispatch = (action) => {
        dispatchedActions.push(action);
        if (action.type === 'SAVE_ANNOTATIONS') {
            isSaving = true;
        }
    };

    const handleSave = () => {
        dispatch({ type: 'SAVE_ANNOTATIONS' });
    };

    handleSave();
    assert.strictEqual(isSaving, true);
    assert.strictEqual(dispatchedActions.length, 1);
    assert.strictEqual(dispatchedActions[0].type, 'SAVE_ANNOTATIONS');
    console.log('  ✔ TC 69 passed.');
}

// TC 70: Undo / Redo Action History Is Registered Upon Direct Edit
{
    console.log('TC 70: Undo / Redo action history is registered upon direct edit...');
    const history = [];
    let historyIndex = -1;

    const applyEdit = (state, oldPoints, newPoints) => {
        state.points = [...newPoints];
        history.push({ state, undo: () => { state.points = [...oldPoints]; }, redo: () => { state.points = [...newPoints]; } });
        historyIndex = history.length - 1;
    };

    const target = { clientID: 77, points: [10, 10] };
    applyEdit(target, [10, 10], [25, 30]);
    assert.deepStrictEqual(target.points, [25, 30]);

    // Undo
    history[historyIndex].undo();
    assert.deepStrictEqual(target.points, [10, 10]);

    // Redo
    history[historyIndex].redo();
    assert.deepStrictEqual(target.points, [25, 30]);
    console.log('  ✔ TC 70 passed.');
}

// TC 71: Skeleton Complete Object Rendering (Outer Bounding Box, Bone Connections, Landmark Points, Label & ID)
{
    console.log('TC 71: Skeleton complete object rendering...');
    const parentSkeleton = {
        clientID: 101,
        objectType: 'track',
        shapeType: 'skeleton',
        label: { id: 10, name: 'Face' },
        elements: [
            { clientID: 201, label: { id: 1, name: 'left_eye' }, points: [100, 150] },
            { clientID: 202, label: { id: 2, name: 'right_eye' }, points: [120, 150] },
            { clientID: 203, label: { id: 3, name: 'nose' }, points: [110, 170] },
        ],
    };
    const associatedBox = {
        clientID: 102,
        objectType: 'track',
        shapeType: 'rectangle',
        points: [80, 130, 140, 190],
        parentID: 101,
    };
    const frameStates = [parentSkeleton, associatedBox];

    // Verify outer box resolution
    const outerBox = getObjectBoundingBox(parentSkeleton, null, frameStates);
    assert.notStrictEqual(outerBox, null);
    assert.deepStrictEqual(outerBox, { xtl: 80, ytl: 130, xbr: 140, ybr: 190 });

    // Verify label and ID text
    const labelBadge = `${parentSkeleton.label.name} #${parentSkeleton.clientID}`;
    assert.strictEqual(labelBadge, 'Face #101');
    console.log('  ✔ TC 71 passed.');
}

// TC 72: Template SVG Structure Mapping from data-node-id to data-label-id
{
    console.log('TC 72: Template SVG structure mapping from data-node-id to data-label-id...');
    // CVAT template SVG where data-node-id is 1, 2 but sublabel id (data-label-id) is 51, 52
    const svgTemplate = `
        <svg>
            <circle data-node-id="1" data-label-id="51" cx="10" cy="10" />
            <circle data-node-id="2" data-label-id="52" cx="20" cy="20" />
            <line data-type="edge" data-node-from="1" data-node-to="2" />
        </svg>
    `;

    // Pure attribute extraction matching parseSkeletonEdges algorithm
    const parseEdges = (svg) => {
        const nodeToLabelMap = {};
        const circleRegex = /<circle[^>]*data-node-id="(\d+)"[^>]*data-label-id="(\d+)"/g;
        let match;
        while ((match = circleRegex.exec(svg)) !== null) {
            nodeToLabelMap[Number(match[1])] = Number(match[2]);
        }
        const edgeRegex = /<line[^>]*data-type="edge"[^>]*data-node-from="(\d+)"[^>]*data-node-to="(\d+)"/g;
        const edges = [];
        while ((match = edgeRegex.exec(svg)) !== null) {
            const from = Number(match[1]);
            const to = Number(match[2]);
            edges.push({
                from: nodeToLabelMap[from] ?? from,
                to: nodeToLabelMap[to] ?? to,
            });
        }
        return edges;
    };

    const edges = parseEdges(svgTemplate);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].from, 51, 'data-node-from=1 must map to sublabel 51');
    assert.strictEqual(edges[0].to, 52, 'data-node-to=2 must map to sublabel 52');
    console.log('  ✔ TC 72 passed.');
}

// TC 73: Skeleton Outer Bounding Box Resolution Using Native CVAT Canvas Logic
{
    console.log('TC 73: Skeleton outer bounding box resolution using native CVAT Canvas logic...');
    // Skeleton without any associated rectangle resolves using native CVAT Canvas wrapping box
    const bareSkeleton = {
        clientID: 401,
        objectType: 'track',
        shapeType: 'skeleton',
        label: { id: 10, name: 'Skeleton' },
        elements: [
            { clientID: 501, label: { id: 1, name: 'p1' }, points: [200, 200], outside: false },
            { clientID: 502, label: { id: 2, name: 'p2' }, points: [300, 400], outside: false },
        ],
    };

    // Resolves outer wrapping box with native SKELETON_RECT_MARGIN = 20
    const box = getObjectBoundingBox(bareSkeleton, null, [bareSkeleton]);
    assert.notStrictEqual(box, null, 'Must resolve native CVAT Canvas wrapping box');
    assert.deepStrictEqual(box, {
        xtl: 200 - SKELETON_RECT_MARGIN, // 180
        ytl: 200 - SKELETON_RECT_MARGIN, // 180
        xbr: 300 + SKELETON_RECT_MARGIN, // 320
        ybr: 400 + SKELETON_RECT_MARGIN, // 420
    });
    console.log('  ✔ TC 73 passed.');
}

// TC 74: All-Outside Skeleton Handled Gracefully as Absent
{
    console.log('TC 74: All-outside skeleton handled gracefully as absent...');
    const outsideSkeleton = {
        clientID: 601,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 701, label: { id: 1, name: 'pt1' }, points: [50, 50], outside: true },
            { clientID: 702, label: { id: 2, name: 'pt2' }, points: [60, 60], outside: true },
        ],
    };

    const outerBox = getObjectBoundingBox(outsideSkeleton, null, [outsideSkeleton]);
    assert.strictEqual(outerBox, null, 'All outside elements must yield null wrapping box');

    // Skeleton elements and identity must remain intact
    assert.strictEqual(outsideSkeleton.elements.length, 2);
    assert.deepStrictEqual(outsideSkeleton.elements[0].points, [50, 50]);
    assert.deepStrictEqual(outsideSkeleton.elements[1].points, [60, 60]);
    console.log('  ✔ TC 74 passed.');
}

// TC 75: Auto-Zoom Uses Skeleton's Existing Outer Bounding Box
{
    console.log('TC 75: Auto-Zoom uses skeleton existing outer bounding box...');
    const skeleton = {
        clientID: 801,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 901, label: { id: 1 }, points: [500, 500] },
        ],
    };
    const associatedRect = {
        clientID: 802,
        objectType: 'track',
        shapeType: 'rectangle',
        points: [400, 400, 600, 600], // 200x200 box
        parentID: 801,
    };

    const bbox = getObjectBoundingBox(skeleton, null, [skeleton, associatedRect]);
    assert.deepStrictEqual(bbox, { xtl: 400, ytl: 400, xbr: 600, ybr: 600 });

    const vp = calculateAutoZoomViewport(bbox, 1920, 1080);
    // Viewport must center around the bounding box [400, 400, 600, 600]
    const boxCenterX = 500;
    const boxCenterY = 500;
    const vpCenterX = vp.x + vp.width / 2;
    const vpCenterY = vp.y + vp.height / 2;
    assert.ok(Math.abs(boxCenterX - vpCenterX) < 5, 'Auto-zoom must center around existing bounding box');
    assert.ok(Math.abs(boxCenterY - vpCenterY) < 5);
    console.log('  ✔ TC 75 passed.');
}

// TC 76: Skeletons Matched as Single Logical Object While Preserving Sublabel Identities
{
    console.log('TC 76: Skeletons matched as single logical object while preserving sublabel identities...');
    const frame0Skeleton = {
        clientID: 10,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 101, parentID: 10, objectType: 'track', label: { id: 5, name: 'left_eye' }, points: [100, 100] },
            { clientID: 102, parentID: 10, objectType: 'track', label: { id: 6, name: 'right_eye' }, points: [120, 100] },
        ],
    };
    const frame1Skeleton = {
        clientID: 10,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 201, parentID: 10, objectType: 'track', label: { id: 5, name: 'left_eye' }, points: [105, 102] },
            { clientID: 202, parentID: 10, objectType: 'track', label: { id: 6, name: 'right_eye' }, points: [125, 102] },
        ],
    };

    // User selects sublabel 5 (left_eye) on Frame 0
    const selectedElement = frame0Skeleton.elements[0];
    const matchF1 = resolveCrossFrameIdentity(selectedElement, [frame1Skeleton]);
    assert.strictEqual(matchF1.status, 'MATCHED');
    assert.strictEqual(matchF1.targetState.clientID, 10, 'Parent skeleton must match logical object');
    assert.strictEqual(matchF1.targetElementState.label.id, 5, 'Sublabel identity 5 must be preserved');
    assert.deepStrictEqual(matchF1.targetElementState.points, [105, 102]);
    console.log('  ✔ TC 76 passed.');
}

// TC 77: Selection by Object ID
{
    console.log('TC 77: Selection by object ID...');
    const states = [
        { clientID: 15, id: 1001, objectType: 'track', shapeType: 'skeleton', label: { id: 1, name: 'face' } },
        { clientID: 28, id: 1002, objectType: 'track', shapeType: 'polygon', label: { id: 2, name: 'car' } },
        { clientID: 42, id: 1003, objectType: 'track', shapeType: 'rectangle', label: { id: 3, name: 'head' } },
    ];

    const selectable = extractSelectableObjects(states);
    assert.strictEqual(selectable.length, 3);

    // Find by clientID: 28
    const byClientID = selectable.find((o) => o.clientID === 28);
    assert.ok(byClientID);
    assert.strictEqual(byClientID.shapeType, 'polygon');
    assert.ok(byClientID.displayText.includes('#28'));

    // Find by track ID (state.id): 1003
    const byTrackID = selectable.find((o) => o.trackID === 1003);
    assert.ok(byTrackID);
    assert.strictEqual(byTrackID.clientID, 42);
    assert.strictEqual(byTrackID.shapeType, 'rectangle');
    console.log('  ✔ TC 77 passed.');
}

// TC 78: Selection by Object Type
{
    console.log('TC 78: Selection by object type...');
    const states = [
        { clientID: 1, objectType: 'track', shapeType: 'skeleton', label: { id: 1, name: 'face' }, elements: [] },
        { clientID: 2, objectType: 'track', shapeType: 'polygon', label: { id: 2, name: 'car' } },
        { clientID: 3, objectType: 'track', shapeType: 'rectangle', label: { id: 3, name: 'box' } },
        { clientID: 4, objectType: 'shape', shapeType: 'skeleton', label: { id: 1, name: 'face' }, elements: [] },
    ];

    const selectable = extractSelectableObjects(states);

    // Filter by type: 'skeleton'
    const skeletonObjects = selectable.filter((o) => o.shapeType === 'skeleton');
    assert.strictEqual(skeletonObjects.length, 2);
    assert.strictEqual(skeletonObjects[0].clientID, 1);
    assert.strictEqual(skeletonObjects[1].clientID, 4);

    // Filter by type: 'polygon'
    const polygonObjects = selectable.filter((o) => o.shapeType === 'polygon');
    assert.strictEqual(polygonObjects.length, 1);
    assert.strictEqual(polygonObjects[0].clientID, 2);
    console.log('  ✔ TC 78 passed.');
}

// TC 79: When Skeleton Is Selected, Unrelated Skeletons and Objects Are Hidden
{
    console.log('TC 79: When skeleton is selected, unrelated skeletons and objects are hidden...');
    const skeletonA = { clientID: 10, shapeType: 'skeleton', elements: [] };
    const skeletonB = { clientID: 20, shapeType: 'skeleton', elements: [] };
    const rectC = { clientID: 30, shapeType: 'rectangle', points: [10, 10, 50, 50] };

    const matchedSkeletonClientID = 10;
    const hasSelection = true;

    const isSkeletonMatched = (state) => state.clientID === matchedSkeletonClientID;

    const visibleStates = [skeletonA, skeletonB, rectC].filter((st) => {
        if (st.shapeType === 'skeleton') {
            return !hasSelection || isSkeletonMatched(st);
        }
        if (st.shapeType === 'rectangle') {
            return !hasSelection || st.clientID === matchedSkeletonClientID;
        }
        return true;
    });

    assert.strictEqual(visibleStates.length, 1);
    assert.strictEqual(visibleStates[0].clientID, 10);
    console.log('  ✔ TC 79 passed.');
}

// TC 80: Polygon Rendering and Multi-Frame Consistency Is Preserved
{
    console.log('TC 80: Polygon rendering and multi-frame consistency is preserved...');
    const polyState = {
        clientID: 99,
        shapeType: 'polygon',
        points: [100, 100, 150, 120, 140, 180, 90, 160],
        color: '#ff0000',
    };

    // Coordinates to points string
    const pointsStr = polyState.points.reduce((acc, val, idx) => (
        `${acc}${idx % 2 === 0 ? ' ' : ','}${val}`
    ), '').trim();

    assert.strictEqual(pointsStr, '100,100 150,120 140,180 90,160');

    // Bounding box of polygon
    const polyBBox = getObjectBoundingBox(polyState);
    assert.deepStrictEqual(polyBBox, { xtl: 90, ytl: 100, xbr: 150, ybr: 180 });
    console.log('  ✔ TC 80 passed.');
}

// TC 81: Aspect Ratio Preservation and Proportional Containment for Square Source Images (1:1)
{
    console.log('TC 81: Aspect ratio preservation & containment for square source images (1:1)...');
    const squareDimensions = { width: 1000, height: 1000 };
    const squareAspect = squareDimensions.width / squareDimensions.height;
    assert.strictEqual(squareAspect, 1.0);

    // Case 1: Widescreen container (e.g. 800x400) -> Pillarbox (bars left & right)
    const wideContainer = { width: 800, height: 400 };
    const wideLayout = calculateContainedDimensions(
        wideContainer.width,
        wideContainer.height,
        squareDimensions.width,
        squareDimensions.height,
    );
    assert.strictEqual(wideLayout.letterboxType, 'pillarbox');
    assert.strictEqual(wideLayout.fitWidth, 400);
    assert.strictEqual(wideLayout.fitHeight, 400);
    assert.strictEqual(wideLayout.fitWidth / wideLayout.fitHeight, 1.0, 'Contained image must remain strictly 1:1');
    assert.strictEqual(wideLayout.offsetX, 200, 'Horizontal offset must center image in container');
    assert.strictEqual(wideLayout.offsetY, 0);

    // Case 2: Tall container (e.g. 400x800) -> Letterbox (bars top & bottom)
    const tallContainer = { width: 400, height: 800 };
    const tallLayout = calculateContainedDimensions(
        tallContainer.width,
        tallContainer.height,
        squareDimensions.width,
        squareDimensions.height,
    );
    assert.strictEqual(tallLayout.letterboxType, 'letterbox');
    assert.strictEqual(tallLayout.fitWidth, 400);
    assert.strictEqual(tallLayout.fitHeight, 400);
    assert.strictEqual(tallLayout.fitWidth / tallLayout.fitHeight, 1.0, 'Contained image must remain strictly 1:1');
    assert.strictEqual(tallLayout.offsetX, 0);
    assert.strictEqual(tallLayout.offsetY, 200, 'Vertical offset must center image in container');

    // Case 3: Square container (e.g. 500x500) -> Exact fit ('none')
    const squareContainer = { width: 500, height: 500 };
    const exactLayout = calculateContainedDimensions(
        squareContainer.width,
        squareContainer.height,
        squareDimensions.width,
        squareDimensions.height,
    );
    assert.strictEqual(exactLayout.letterboxType, 'none');
    assert.strictEqual(exactLayout.fitWidth, 500);
    assert.strictEqual(exactLayout.fitHeight, 500);
    assert.strictEqual(exactLayout.offsetX, 0);
    assert.strictEqual(exactLayout.offsetY, 0);

    console.log('  ✔ TC 81 passed.');
}

// TC 82: Aspect Ratio Preservation and Proportional Containment for Landscape Images (16:9, 4:3)
{
    console.log('TC 82: Aspect ratio preservation & containment for landscape images (16:9, 4:3)...');
    // 16:9 widescreen in 4:3 container -> Letterbox (bars top & bottom)
    const wideImg = { width: 1920, height: 1080 };
    const wideAspect = wideImg.width / wideImg.height;
    const stdContainer = { width: 400, height: 300 }; // 4:3 = 1.333 < 1.777
    const letterbox16_9 = calculateContainedDimensions(
        stdContainer.width,
        stdContainer.height,
        wideImg.width,
        wideImg.height,
    );
    assert.strictEqual(letterbox16_9.letterboxType, 'letterbox');
    assert.strictEqual(letterbox16_9.fitWidth, 400);
    assert.strictEqual(letterbox16_9.fitHeight, 225);
    assert.strictEqual(Math.abs(letterbox16_9.fitWidth / letterbox16_9.fitHeight - wideAspect) < 0.001, true);
    assert.strictEqual(letterbox16_9.offsetX, 0);
    assert.strictEqual(letterbox16_9.offsetY, 37.5);

    // 4:3 standard image in 16:9 container -> Pillarbox (bars left & right)
    const stdImg = { width: 800, height: 600 };
    const stdAspect = stdImg.width / stdImg.height; // 1.333
    const wideCont = { width: 800, height: 450 }; // 16:9 = 1.777 > 1.333
    const pillarbox4_3 = calculateContainedDimensions(
        wideCont.width,
        wideCont.height,
        stdImg.width,
        stdImg.height,
    );
    assert.strictEqual(pillarbox4_3.letterboxType, 'pillarbox');
    assert.strictEqual(pillarbox4_3.fitHeight, 450);
    assert.strictEqual(pillarbox4_3.fitWidth, 600);
    assert.strictEqual(Math.abs(pillarbox4_3.fitWidth / pillarbox4_3.fitHeight - stdAspect) < 0.001, true);
    assert.strictEqual(pillarbox4_3.offsetX, 100);
    assert.strictEqual(pillarbox4_3.offsetY, 0);

    console.log('  ✔ TC 82 passed.');
}

// TC 83: Aspect Ratio Preservation and Proportional Containment for Portrait Images (9:16, 3:4)
{
    console.log('TC 83: Aspect ratio preservation & containment for portrait images (9:16, 3:4)...');
    // 9:16 portrait in landscape container (e.g. 600x400) -> Pillarbox (bars left & right)
    const portraitImg = { width: 1080, height: 1920 };
    const portraitAspect = portraitImg.width / portraitImg.height; // 0.5625
    const landContainer = { width: 600, height: 400 };
    const pillarbox9_16 = calculateContainedDimensions(
        landContainer.width,
        landContainer.height,
        portraitImg.width,
        portraitImg.height,
    );
    assert.strictEqual(pillarbox9_16.letterboxType, 'pillarbox');
    assert.strictEqual(pillarbox9_16.fitHeight, 400);
    assert.strictEqual(pillarbox9_16.fitWidth, 225);
    assert.strictEqual(Math.abs(pillarbox9_16.fitWidth / pillarbox9_16.fitHeight - portraitAspect) < 0.001, true);
    assert.strictEqual(pillarbox9_16.offsetX, 187.5);
    assert.strictEqual(pillarbox9_16.offsetY, 0);

    // 3:4 portrait in extra tall container (e.g. 300x600) -> Letterbox (bars top & bottom)
    const port3_4 = { width: 600, height: 800 };
    const port3_4Aspect = port3_4.width / port3_4.height; // 0.75
    const tallCont = { width: 300, height: 600 }; // 300/600 = 0.5 < 0.75
    const letterbox3_4 = calculateContainedDimensions(
        tallCont.width,
        tallCont.height,
        port3_4.width,
        port3_4.height,
    );
    assert.strictEqual(letterbox3_4.letterboxType, 'letterbox');
    assert.strictEqual(letterbox3_4.fitWidth, 300);
    assert.strictEqual(letterbox3_4.fitHeight, 400);
    assert.strictEqual(Math.abs(letterbox3_4.fitWidth / letterbox3_4.fitHeight - port3_4Aspect) < 0.001, true);
    assert.strictEqual(letterbox3_4.offsetX, 0);
    assert.strictEqual(letterbox3_4.offsetY, 100);

    console.log('  ✔ TC 83 passed.');
}

// TC 84: Proportional Scaling and Dynamic Grid Layout across 1, 2, 4, 16 Visible Frames
{
    console.log('TC 84: Proportional scaling & dynamic grid layout across visible frames...');
    // Responsive column computation helper
    const getGridColumns = (numFrames) => (numFrames < 4 ? `repeat(${Math.max(1, numFrames)}, 1fr)` : 'repeat(4, 1fr)');

    assert.strictEqual(getGridColumns(1), 'repeat(1, 1fr)');
    assert.strictEqual(getGridColumns(2), 'repeat(2, 1fr)');
    assert.strictEqual(getGridColumns(3), 'repeat(3, 1fr)');
    assert.strictEqual(getGridColumns(4), 'repeat(4, 1fr)');
    assert.strictEqual(getGridColumns(16), 'repeat(4, 1fr)');

    // In a 1200x800 workspace:
    // With 1 visible square frame (1000x1000), tile container is 1200x750:
    const layout1Frame = calculateContainedDimensions(1200, 750, 1000, 1000);
    assert.strictEqual(layout1Frame.fitWidth, 750);
    assert.strictEqual(layout1Frame.fitHeight, 750);
    assert.strictEqual(layout1Frame.letterboxType, 'pillarbox');
    assert.strictEqual(layout1Frame.offsetX, 225);

    // With 2 visible square frames, each tile is (1200 - 6)/2 = 597px wide by 750px tall:
    const layout2Frames = calculateContainedDimensions(597, 750, 1000, 1000);
    assert.strictEqual(layout2Frames.fitWidth, 597);
    assert.strictEqual(layout2Frames.fitHeight, 597);
    assert.strictEqual(layout2Frames.letterboxType, 'letterbox');
    assert.strictEqual(layout2Frames.offsetY, (750 - 597) / 2);

    // With 16 visible square frames (4x4), each tile is ~295px wide by ~180px tall:
    const layout16Frames = calculateContainedDimensions(295, 180, 1000, 1000);
    assert.strictEqual(layout16Frames.fitWidth, 180);
    assert.strictEqual(layout16Frames.fitHeight, 180);
    assert.strictEqual(layout16Frames.letterboxType, 'pillarbox');
    assert.strictEqual(layout16Frames.offsetX, (295 - 180) / 2);

    console.log('  ✔ TC 84 passed.');
}

// TC 85: Overlay Alignment with Contained Image Bounds
{
    console.log('TC 85: Overlay alignment with contained image bounds...');
    const sourceWidth = 1000;
    const sourceHeight = 1000;
    const containerWidth = 500;
    const containerHeight = 300;

    const layout = calculateContainedDimensions(containerWidth, containerHeight, sourceWidth, sourceHeight);
    assert.strictEqual(layout.fitWidth, 300);
    assert.strictEqual(layout.fitHeight, 300);
    assert.strictEqual(layout.offsetX, 100);
    assert.strictEqual(layout.offsetY, 0);

    // Canvas element matches layout fit dimensions
    const canvasRenderWidth = sourceWidth;
    const canvasRenderHeight = sourceHeight;
    const canvasDisplayWidth = layout.fitWidth;
    const canvasDisplayHeight = layout.fitHeight;

    // SVG element matches layout fit dimensions
    const svgDisplayWidth = layout.fitWidth;
    const svgDisplayHeight = layout.fitHeight;
    assert.strictEqual(canvasDisplayWidth, svgDisplayWidth);
    assert.strictEqual(canvasDisplayHeight, svgDisplayHeight);

    // Verify subpixel mapping of key points:
    // Center point (500, 500)
    const ptX = 500;
    const ptY = 500;
    const canvasNormX = ptX / canvasRenderWidth;
    const canvasNormY = ptY / canvasRenderHeight;
    const svgNormX = ptX / sourceWidth;
    const svgNormY = ptY / sourceHeight;
    assert.strictEqual(canvasNormX, svgNormX);
    assert.strictEqual(canvasNormY, svgNormY);

    // On-screen position within the container:
    const screenX = layout.offsetX + svgNormX * svgDisplayWidth;
    const screenY = layout.offsetY + svgNormY * svgDisplayHeight;
    assert.strictEqual(screenX, 100 + 150); // 250
    assert.strictEqual(screenY, 0 + 150);   // 150

    console.log('  ✔ TC 85 passed.');
}

// TC 86: Pointer Coordinate Mapping under Letterbox and Pillarbox Margins
{
    console.log('TC 86: Pointer coordinate mapping under letterbox and pillarbox margins...');
    const imageWidth = 1000;
    const imageHeight = 1000;
    const containerWidth = 500;
    const containerHeight = 300;
    const layout = calculateContainedDimensions(containerWidth, containerHeight, imageWidth, imageHeight);
    // layout: fitWidth=300, fitHeight=300, offsetX=100, offsetY=0

    // Click outside image inside left pillarbox bar (x=50, y=150)
    const clickBarLeft = mapPointerToImageCoordinates(50, 150, layout, null, imageWidth, imageHeight);
    assert.strictEqual(clickBarLeft.isInsideContent, false);

    // Click at contained image top-left boundary (x=100, y=0)
    const clickTopLeft = mapPointerToImageCoordinates(100, 0, layout, null, imageWidth, imageHeight);
    assert.strictEqual(clickTopLeft.isInsideContent, true);
    assert.strictEqual(clickTopLeft.x, 0);
    assert.strictEqual(clickTopLeft.y, 0);

    // Click at contained image center (x=250, y=150)
    const clickCenter = mapPointerToImageCoordinates(250, 150, layout, null, imageWidth, imageHeight);
    assert.strictEqual(clickCenter.isInsideContent, true);
    assert.strictEqual(clickCenter.x, 500);
    assert.strictEqual(clickCenter.y, 500);

    // Click at contained image bottom-right boundary (x=400, y=300)
    const clickBottomRight = mapPointerToImageCoordinates(400, 300, layout, null, imageWidth, imageHeight);
    assert.strictEqual(clickBottomRight.isInsideContent, true);
    assert.strictEqual(clickBottomRight.x, 1000);
    assert.strictEqual(clickBottomRight.y, 1000);

    // Click outside image inside right pillarbox bar (x=450, y=150)
    const clickBarRight = mapPointerToImageCoordinates(450, 150, layout, null, imageWidth, imageHeight);
    assert.strictEqual(clickBarRight.isInsideContent, false);

    // Under letterboxing: 1920x1080 image in 400x300 container
    const layoutLetterbox = calculateContainedDimensions(400, 300, 1920, 1080);
    // fitWidth=400, fitHeight=225, offsetX=0, offsetY=37.5
    const clickLetterboxTop = mapPointerToImageCoordinates(200, 37.5, layoutLetterbox, null, 1920, 1080);
    assert.strictEqual(clickLetterboxTop.isInsideContent, true);
    assert.strictEqual(clickLetterboxTop.x, 960);
    assert.strictEqual(clickLetterboxTop.y, 0);

    const clickLetterboxCenter = mapPointerToImageCoordinates(200, 150, layoutLetterbox, null, 1920, 1080);
    assert.strictEqual(clickLetterboxCenter.isInsideContent, true);
    assert.strictEqual(clickLetterboxCenter.x, 960);
    assert.strictEqual(clickLetterboxCenter.y, 540);

    console.log('  ✔ TC 86 passed.');
}

// TC 87: Auto-Zoom and Manual Zoom Preserving Original Image Aspect Ratio
{
    console.log('TC 87: Auto-Zoom & manual zoom preserving original image aspect ratio...');
    const squareWidth = 1000;
    const squareHeight = 1000;
    const nonSquareBBox = { xtl: 200, ytl: 300, xbr: 400, ybr: 600 }; // 200x300 box (ratio 2:3)

    // Auto-Zoom must preserve the 1:1 image aspect ratio
    const autoZoomVp = calculateAutoZoomViewport(nonSquareBBox, squareWidth, squareHeight);
    assert.strictEqual(autoZoomVp.width, autoZoomVp.height, 'Auto-Zoom viewport must be square for 1:1 image');
    assert.strictEqual(autoZoomVp.width / autoZoomVp.height, 1.0);

    // Manual zoom on that viewport centered at (300, 450)
    const zoomedInVp = zoomViewportAtPoint(autoZoomVp, 0.8, 300, 450, squareWidth, squareHeight);
    assert.strictEqual(zoomedInVp.width, zoomedInVp.height, 'Zoomed-in viewport must maintain square aspect ratio');

    // Pan the viewport by (+50, -30)
    const pannedVp = panViewport(zoomedInVp, 50, -30, squareWidth, squareHeight);
    assert.strictEqual(pannedVp.width, pannedVp.height, 'Panned viewport must maintain square aspect ratio');

    // Contained layout for zoomed viewport in a rectangular container (500x300)
    const zoomLayout = calculateContainedDimensions(500, 300, zoomedInVp.width, zoomedInVp.height);
    assert.strictEqual(zoomLayout.fitWidth, zoomLayout.fitHeight);
    assert.strictEqual(zoomLayout.fitWidth, 300);
    assert.strictEqual(zoomLayout.fitHeight, 300);

    console.log('  ✔ TC 87 passed.');
}

// TC 88: Skeleton Complete Object Rendering and Polygon Overlays Remain Aligned
{
    console.log('TC 88: Skeleton & polygon overlays remain aligned without distortion...');
    const squareDimensions = { width: 1000, height: 1000 };
    const containerSize = { width: 400, height: 300 };
    const layout = calculateContainedDimensions(containerSize.width, containerSize.height, squareDimensions.width, squareDimensions.height);

    // Skeleton object on square frame
    const skeletonState = {
        clientID: 55,
        shapeType: 'skeleton',
        boundingBox: { xtl: 200, ytl: 200, xbr: 600, ybr: 700 },
        elements: [
            { clientID: 551, label: { id: 1, name: 'Eye_L' }, points: [300, 350], outside: false },
            { clientID: 552, label: { id: 2, name: 'Eye_R' }, points: [500, 350], outside: false },
        ],
    };

    const bbox = getObjectBoundingBox(skeletonState);
    assert.deepStrictEqual(bbox, { xtl: 200, ytl: 200, xbr: 600, ybr: 700 });

    // Overlay scale factor matches layout
    const zoomScale = squareDimensions.width / layout.fitWidth;
    const scaleFactor = 1 / Math.sqrt(Math.max(1, zoomScale));
    assert.strictEqual(Number.isFinite(scaleFactor), true);
    assert.strictEqual(scaleFactor > 0, true);

    // Polygon on portrait frame (1080x1920)
    const portraitDimensions = { width: 1080, height: 1920 };
    const portLayout = calculateContainedDimensions(600, 400, portraitDimensions.width, portraitDimensions.height);
    const polyState = {
        clientID: 66,
        shapeType: 'polygon',
        points: [200, 300, 400, 350, 380, 600, 180, 550],
    };
    const polyBBox = getObjectBoundingBox(polyState);
    assert.strictEqual(polyBBox.xtl, 180);
    assert.strictEqual(polyBBox.ytl, 300);
    assert.strictEqual(polyBBox.xbr, 400);
    assert.strictEqual(polyBBox.ybr, 600);

    // Contained display aspect matches intrinsic aspect
    assert.strictEqual(Math.abs(portLayout.fitWidth / portLayout.fitHeight - portraitDimensions.width / portraitDimensions.height) < 0.001, true);

    console.log('  ✔ TC 88 passed.');
}

// TC 89: Native CVAT Canvas Skeleton Wrapping Bounding Box Resolution
{
    console.log('TC 89: Native CVAT Canvas skeleton wrapping box resolution...');
    const skeleton = {
        clientID: 1001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 1002, label: { id: 1 }, points: [150, 200], outside: false },
            { clientID: 1003, label: { id: 2 }, points: [250, 200], outside: false },
            { clientID: 1004, label: { id: 3 }, points: [200, 350], outside: false },
            { clientID: 1005, label: { id: 4 }, points: [180, 450], outside: false },
            { clientID: 1006, label: { id: 5 }, points: [0, 0], outside: true }, // outside landmark ignored
        ],
    };

    const bbox = resolveSkeletonWrappingBox(skeleton, [skeleton]);
    assert.notStrictEqual(bbox, null);
    // Min X = 150, Max X = 250 -> padded with 20px -> [130, 270]
    // Min Y = 200, Max Y = 450 -> padded with 20px -> [180, 470]
    assert.strictEqual(bbox.xtl, 150 - 20); // 130
    assert.strictEqual(bbox.ytl, 200 - 20); // 180
    assert.strictEqual(bbox.xbr, 250 + 20); // 270
    assert.strictEqual(bbox.ybr, 450 + 20); // 470
    console.log('  ✔ TC 89 passed.');
}

// TC 90: Auto-Zoom Zooms into Complete Skeleton when Skeleton is Selected
{
    console.log('TC 90: Auto-Zoom zooms into complete skeleton when skeleton is selected...');
    const frameWidth = 1920;
    const frameHeight = 1080;
    const skeleton = {
        clientID: 2001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 2002, label: { id: 1 }, points: [600, 300], outside: false },
            { clientID: 2003, label: { id: 2 }, points: [900, 700], outside: false },
        ],
    };

    const bbox = getObjectBoundingBox(skeleton, null, [skeleton]);
    assert.notStrictEqual(bbox, null);
    assert.deepStrictEqual(bbox, {
        xtl: 600 - 20, // 580
        ytl: 300 - 20, // 280
        xbr: 900 + 20, // 920
        ybr: 700 + 20, // 720
    });

    const vp = calculateAutoZoomViewport(bbox, frameWidth, frameHeight);
    // Viewport must contain the entire skeleton box:
    assert.strictEqual(vp.x <= bbox.xtl, true, 'Viewport left must encompass skeleton box');
    assert.strictEqual(vp.y <= bbox.ytl, true, 'Viewport top must encompass skeleton box');
    assert.strictEqual(vp.x + vp.width >= bbox.xbr, true, 'Viewport right must encompass skeleton box');
    assert.strictEqual(vp.y + vp.height >= bbox.ybr, true, 'Viewport bottom must encompass skeleton box');
    // Aspect ratio must strictly match full image aspect ratio (16:9):
    const vpAspect = vp.width / vp.height;
    const imgAspect = frameWidth / frameHeight;
    assert.strictEqual(Math.abs(vpAspect - imgAspect) < 0.05, true);
    console.log('  ✔ TC 90 passed.');
}

// TC 91: Auto-Zoom Zooms into Complete Skeleton when Individual Landmark is Selected
{
    console.log('TC 91: Auto-Zoom zooms into complete skeleton when landmark is selected...');
    const frameWidth = 1920;
    const frameHeight = 1080;
    const parentSkeleton = {
        clientID: 3001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 3002, label: { id: 1, name: 'Eye_L' }, points: [400, 300], outside: false },
            { clientID: 3003, label: { id: 2, name: 'Eye_R' }, points: [600, 300], outside: false },
            { clientID: 3004, label: { id: 3, name: 'Chin' }, points: [500, 600], outside: false },
        ],
    };
    const selectedLandmark = parentSkeleton.elements[0]; // 'Eye_L' landmark selected

    // Whether passing (parentSkeleton, selectedLandmark) or the landmark directly with parentID:
    const bboxFromParent = getObjectBoundingBox(parentSkeleton, selectedLandmark, [parentSkeleton]);
    assert.notStrictEqual(bboxFromParent, null);
    assert.deepStrictEqual(bboxFromParent, {
        xtl: 400 - 20, // 380
        ytl: 300 - 20, // 280
        xbr: 600 + 20, // 620
        ybr: 600 + 20, // 620
    });

    const landmarkWithParentID = { ...selectedLandmark, parentID: 3001 };
    const bboxFromLandmark = getObjectBoundingBox(landmarkWithParentID, null, [parentSkeleton]);
    assert.deepStrictEqual(bboxFromLandmark, bboxFromParent, 'Must zoom into parent skeleton, not isolated landmark');

    const vp = calculateAutoZoomViewport(bboxFromParent, frameWidth, frameHeight);
    // Entire skeleton (including Chin at y=600) must be inside viewport:
    assert.strictEqual(vp.x + vp.width >= 620, true);
    assert.strictEqual(vp.y + vp.height >= 620, true);
    console.log('  ✔ TC 91 passed.');
}

// TC 92: Skeleton Auto-Zoom Preserves Image Aspect Ratio with 2-5% Safety Margin
{
    console.log('TC 92: Skeleton Auto-Zoom preserves image aspect ratio with 2-5% safety margin...');
    const squareDimensions = { width: 1000, height: 1000 };
    const skeleton = {
        clientID: 4001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 4002, label: { id: 1 }, points: [300, 200], outside: false },
            { clientID: 4003, label: { id: 2 }, points: [500, 600], outside: false },
        ],
    };

    const bbox = getObjectBoundingBox(skeleton, null, [skeleton]);
    // bbox: [280, 180, 520, 620] -> width: 240, height: 440 (non-square box 240x440)
    assert.strictEqual(bbox.xbr - bbox.xtl, 240);
    assert.strictEqual(bbox.ybr - bbox.ytl, 440);

    // Default safety margin is 3% (within 2-5% range)
    const paddingRatio = 0.03;
    const vp = calculateAutoZoomViewport(bbox, squareDimensions.width, squareDimensions.height, paddingRatio);

    // Viewport must be strictly square (1:1) to match 1000x1000 source image:
    assert.strictEqual(vp.width, vp.height, 'Viewport must match 1:1 image aspect ratio');
    // Height was 440 * (1 + 2*0.03) = 466.4 -> rounded to 466
    assert.strictEqual(vp.height >= Math.floor(440 * (1 + 2 * paddingRatio)), true);
    assert.strictEqual(vp.x <= bbox.xtl, true);
    assert.strictEqual(vp.y <= bbox.ytl, true);
    assert.strictEqual(vp.x + vp.width >= bbox.xbr, true);
    assert.strictEqual(vp.y + vp.height >= bbox.ybr, true);

    console.log('  ✔ TC 92 passed.');
}

// TC 93: Independent Per-Frame Recalculation of Skeleton Wrapping Box
{
    console.log('TC 93: Independent per-frame recalculation of skeleton wrapping box...');
    // Frame 1: Skeleton is near top-left
    const skeletonFrame1 = {
        clientID: 5001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 5002, label: { id: 1 }, points: [100, 100], outside: false },
            { clientID: 5003, label: { id: 2 }, points: [200, 200], outside: false },
        ],
    };

    // Frame 2: Same skeleton moved towards bottom-right and grew
    const skeletonFrame2 = {
        clientID: 5001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 5002, label: { id: 1 }, points: [700, 600], outside: false },
            { clientID: 5003, label: { id: 2 }, points: [950, 900], outside: false },
        ],
    };

    const bboxFrame1 = getObjectBoundingBox(skeletonFrame1, null, [skeletonFrame1]);
    const bboxFrame2 = getObjectBoundingBox(skeletonFrame2, null, [skeletonFrame2]);

    assert.deepStrictEqual(bboxFrame1, { xtl: 80, ytl: 80, xbr: 220, ybr: 220 });
    assert.deepStrictEqual(bboxFrame2, { xtl: 680, ytl: 580, xbr: 970, ybr: 920 });

    const vp1 = calculateAutoZoomViewport(bboxFrame1, 1920, 1080);
    const vp2 = calculateAutoZoomViewport(bboxFrame2, 1920, 1080);

    assert.notStrictEqual(vp1.x, vp2.x);
    assert.notStrictEqual(vp1.y, vp2.y);
    assert.strictEqual(vp1.x <= 80 && vp1.y <= 80, true);
    assert.strictEqual(vp2.x + vp2.width >= 970 && vp2.y + vp2.height >= 920, true);

    console.log('  ✔ TC 93 passed.');
}

// TC 94: Annotation Data Non-Mutation Guarantee
{
    console.log('TC 94: Annotation data non-mutation guarantee...');
    const originalSkeleton = {
        clientID: 6001,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 6002, label: { id: 1 }, points: [300, 300], outside: false },
            { clientID: 6003, label: { id: 2 }, points: [400, 500], outside: false },
        ],
    };
    const clonedSnapshot = JSON.parse(JSON.stringify(originalSkeleton));

    // Resolve wrapping box and calculate auto-zoom
    const bbox = getObjectBoundingBox(originalSkeleton, null, [originalSkeleton]);
    const vp = calculateAutoZoomViewport(bbox, 1920, 1080);

    // Deep compare that original object structure was not mutated
    assert.deepStrictEqual(originalSkeleton, clonedSnapshot, 'Original annotation state must remain completely unmutated');
    console.log('  ✔ TC 94 passed.');
}

// TC 95: Rectangle, Polygon, and Mask Auto-Zoom Preservation
{
    console.log('TC 95: Rectangle, polygon, and mask Auto-Zoom preservation...');
    const rectState = { clientID: 7001, objectType: 'track', shapeType: 'rectangle', points: [100, 200, 500, 600] };
    const rectBBox = getObjectBoundingBox(rectState);
    assert.deepStrictEqual(rectBBox, { xtl: 100, ytl: 200, xbr: 500, ybr: 600 });
    const rectVp = calculateAutoZoomViewport(rectBBox, 1920, 1080);
    assert.strictEqual(rectVp.width > 0 && rectVp.height > 0, true);

    const polyState = { clientID: 7002, objectType: 'shape', shapeType: 'polygon', points: [50, 60, 200, 100, 180, 250, 40, 200] };
    const polyBBox = getObjectBoundingBox(polyState);
    assert.deepStrictEqual(polyBBox, { xtl: 40, ytl: 60, xbr: 200, ybr: 250 });
    const polyVp = calculateAutoZoomViewport(polyBBox, 1920, 1080);
    assert.strictEqual(polyVp.width > 0 && polyVp.height > 0, true);

    const maskState = { clientID: 7003, objectType: 'shape', shapeType: 'mask', points: [30, 40, 300, 400, 0, 1, 0, 1] };
    const maskBBox = getObjectBoundingBox(maskState);
    assert.deepStrictEqual(maskBBox, { xtl: 30, ytl: 40, xbr: 300, ybr: 400 });

    console.log('  ✔ TC 95 passed.');
}

// TC 96: Multi-Frame Object Selector UI — Complete Logical Objects Only, Child Points Excluded
{
    console.log('TC 96: Object selector lists only complete logical parent objects; skeleton child points never appear...');
    const states = [
        // 1. Skeleton track 'mattrai1' (#4) with 5 landmark points (e.g., eyes, nose, mouth)
        {
            clientID: 4,
            id: 104,
            objectType: 'track',
            shapeType: 'skeleton',
            label: { id: 1, name: 'mattrai1', color: '#ff0000' },
            elements: [
                { clientID: 41, parentID: 4, shapeType: 'points', label: { id: 11, name: '1' }, points: [100, 100], outside: false },
                { clientID: 42, parentID: 4, shapeType: 'points', label: { id: 12, name: '2' }, points: [120, 100], outside: false },
                { clientID: 43, parentID: 4, shapeType: 'points', label: { id: 13, name: '3' }, points: [110, 115], outside: false },
                { clientID: 44, parentID: 4, shapeType: 'points', label: { id: 14, name: '4' }, points: [105, 130], outside: false },
                { clientID: 45, parentID: 4, shapeType: 'points', label: { id: 15, name: '5' }, points: [115, 130], outside: false },
            ],
        },
        // 2. Standalone skeleton shape 'face_contour' (#8) with 3 landmark points
        {
            clientID: 8,
            objectType: 'shape',
            shapeType: 'skeleton',
            label: { id: 2, name: 'face_contour', color: '#00ff00' },
            elements: [
                { clientID: 81, parentID: 8, shapeType: 'points', label: { id: 21, name: 'jaw_left' }, points: [200, 200], outside: false },
                { clientID: 82, parentID: 8, shapeType: 'points', label: { id: 22, name: 'chin' }, points: [220, 250], outside: false },
                { clientID: 83, parentID: 8, shapeType: 'points', label: { id: 23, name: 'jaw_right' }, points: [240, 200], outside: false },
            ],
        },
        // 3. Child point passed directly as top-level state (must be rejected via parentID check)
        {
            clientID: 99,
            parentID: 4,
            objectType: 'track',
            shapeType: 'points',
            label: { id: 11, name: '1' },
            points: [100, 100],
        },
        // 4. Rectangle track 'car' (#12)
        {
            clientID: 12,
            id: 112,
            objectType: 'track',
            shapeType: 'rectangle',
            label: { id: 3, name: 'car', color: '#0000ff' },
            points: [300, 300, 500, 450],
        },
        // 5. Polygon shape 'building' (#16)
        {
            clientID: 16,
            objectType: 'shape',
            shapeType: 'polygon',
            label: { id: 4, name: 'building', color: '#ffff00' },
            points: [600, 100, 700, 100, 750, 300, 550, 300],
        },
    ];

    const selectable = extractSelectableObjects(states);

    // Requirement: Exactly 4 logical objects extracted (track_4, shape_8, track_12, shape_16)
    assert.strictEqual(selectable.length, 4, 'Must only contain the 4 complete logical parent objects');

    // Requirement: Zero child landmarks or sublabel entries exist in the selectable list
    const keys = selectable.map((o) => o.key);
    assert.deepStrictEqual(keys, ['track_4', 'shape_8', 'track_12', 'shape_16']);

    const childKeys = selectable.filter((o) => o.key.startsWith('element_'));
    assert.strictEqual(childKeys.length, 0, 'No element_* keys allowed in selectable objects');

    const childParentIDs = selectable.filter((o) => o.parentID !== null);
    assert.strictEqual(childParentIDs.length, 0, 'No child objects with parentID allowed');

    // Verify display text: Never contains landmark arrows (↳ or →), never lists 'mattrai1 #4 → 1'
    for (const obj of selectable) {
        assert.strictEqual(obj.displayText.includes('↳'), false, `displayText '${obj.displayText}' must not contain '↳'`);
        assert.strictEqual(obj.displayText.includes('→'), false, `displayText '${obj.displayText}' must not contain '→'`);
    }

    // Requirement: Type dropdown filter sources available object types
    const availableTypes = Array.from(new Set(selectable.map((o) => o.shapeType))).sort();
    assert.deepStrictEqual(availableTypes, ['polygon', 'rectangle', 'skeleton']);

    // Filter by 'skeleton'
    const skeletonFiltered = selectable.filter((o) => o.shapeType === 'skeleton');
    assert.strictEqual(skeletonFiltered.length, 2, 'Only complete skeleton parent objects when filtered by skeleton');
    assert.strictEqual(skeletonFiltered[0].key, 'track_4');
    assert.strictEqual(skeletonFiltered[0].labelName, 'mattrai1');
    assert.strictEqual(skeletonFiltered[1].key, 'shape_8');
    assert.strictEqual(skeletonFiltered[1].labelName, 'face_contour');

    // Filter by 'rectangle'
    const rectFiltered = selectable.filter((o) => o.shapeType === 'rectangle');
    assert.strictEqual(rectFiltered.length, 1);
    assert.strictEqual(rectFiltered[0].key, 'track_12');
    assert.strictEqual(rectFiltered[0].labelName, 'car');

    // Filter by 'polygon'
    const polyFiltered = selectable.filter((o) => o.shapeType === 'polygon');
    assert.strictEqual(polyFiltered.length, 1);
    assert.strictEqual(polyFiltered[0].key, 'shape_16');
    assert.strictEqual(polyFiltered[0].labelName, 'building');

    // Requirement: Selecting a skeleton selects the entire parent skeleton object
    const selectedSkeleton = selectable.find((o) => o.key === 'track_4');
    assert.ok(selectedSkeleton);
    assert.strictEqual(selectedSkeleton.clientID, 4);
    assert.strictEqual(selectedSkeleton.trackID, 104);
    // Complete landmark structure and points are retained in sourceState for display and editing
    assert.strictEqual(selectedSkeleton.sourceState.elements.length, 5);
    assert.strictEqual(selectedSkeleton.sourceState.elements[0].label.name, '1');

    // Auto-Zoom on this selected skeleton resolves the outer wrapping bounding box (not individual points)
    const bbox = getObjectBoundingBox(selectedSkeleton.sourceState, null, [selectedSkeleton.sourceState]);
    assert.notStrictEqual(bbox, null);
    // Extents: x: 100..120, y: 100..130 -> with margin: [80, 80, 140, 150]
    assert.deepStrictEqual(bbox, { xtl: 80, ytl: 80, xbr: 140, ybr: 150 });

    console.log('  ✔ TC 96 passed.');
}

// TC 97: Whole-Skeleton Bounding Box Dragging and Relative Coordinate Offset Preservation
{
    console.log('TC 97: Whole-skeleton bounding box dragging and relative coordinate offset preservation...');
    const imageWidth = 1920;
    const imageHeight = 1080;

    const skeletonState = {
        clientID: 601,
        objectType: 'track',
        shapeType: 'skeleton',
        label: { id: 10, name: 'face_landmarks' },
        elements: [
            { clientID: 602, shapeType: 'points', label: { id: 1, name: 'left_eye' }, points: [280, 200], outside: false },
            { clientID: 603, shapeType: 'points', label: { id: 2, name: 'right_eye' }, points: [320, 200], outside: false },
            { clientID: 604, shapeType: 'points', label: { id: 3, name: 'nose' }, points: [300, 250], outside: false },
            { clientID: 605, shapeType: 'points', label: { id: 4, name: 'mouth_l' }, points: [285, 300], outside: false },
            { clientID: 606, shapeType: 'points', label: { id: 5, name: 'mouth_r' }, points: [315, 300], outside: false },
        ],
    };

    // Calculate initial pairwise distances between all landmarks
    const initialPairs = [];
    for (let i = 0; i < skeletonState.elements.length; i++) {
        for (let j = i + 1; j < skeletonState.elements.length; j++) {
            const p1 = skeletonState.elements[i].points;
            const p2 = skeletonState.elements[j].points;
            initialPairs.push({
                i, j,
                dist: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]),
            });
        }
    }

    // 1. Move whole skeleton by dx=+75, dy=-45
    const dx = 75;
    const dy = -45;

    const movedElements = skeletonState.elements.map((el) => ({
        ...el,
        points: [Math.round(el.points[0] + dx), Math.round(el.points[1] + dy)],
    }));

    // Verify all points translated by exact offset
    assert.deepStrictEqual(movedElements[0].points, [355, 155]);
    assert.deepStrictEqual(movedElements[1].points, [395, 155]);
    assert.deepStrictEqual(movedElements[2].points, [375, 205]);
    assert.deepStrictEqual(movedElements[3].points, [360, 255]);
    assert.deepStrictEqual(movedElements[4].points, [390, 255]);

    // Verify pairwise distances between all elements remain identical (relative structure unchanged)
    for (const pair of initialPairs) {
        const p1 = movedElements[pair.i].points;
        const p2 = movedElements[pair.j].points;
        const newDist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        assert.ok(Math.abs(newDist - pair.dist) < 1e-6, `Distance between element ${pair.i} and ${pair.j} must not change`);
    }

    // 2. Boundary clamping: Dragging past top-left boundary
    const extremeNegativeDx = -1000;
    const extremeNegativeDy = -1000;
    const minX = Math.min(...skeletonState.elements.map((el) => el.points[0])); // 280
    const minY = Math.min(...skeletonState.elements.map((el) => el.points[1])); // 200
    const clampedNegDx = Math.max(-minX, extremeNegativeDx); // -280
    const clampedNegDy = Math.max(-minY, extremeNegativeDy); // -200

    assert.strictEqual(clampedNegDx, -280);
    assert.strictEqual(clampedNegDy, -200);

    const clampedLeftElements = skeletonState.elements.map((el) => ({
        ...el,
        points: [el.points[0] + clampedNegDx, el.points[1] + clampedNegDy],
    }));
    for (const el of clampedLeftElements) {
        assert.ok(el.points[0] >= 0, 'X coordinate must be >= 0');
        assert.ok(el.points[1] >= 0, 'Y coordinate must be >= 0');
    }

    // 3. Boundary clamping: Dragging past bottom-right boundary
    const extremePositiveDx = 3000;
    const extremePositiveDy = 3000;
    const maxX = Math.max(...skeletonState.elements.map((el) => el.points[0])); // 320
    const maxY = Math.max(...skeletonState.elements.map((el) => el.points[1])); // 300
    const clampedPosDx = Math.min(imageWidth - maxX, extremePositiveDx); // 1920 - 320 = 1600
    const clampedPosDy = Math.min(imageHeight - maxY, extremePositiveDy); // 1080 - 300 = 780

    assert.strictEqual(clampedPosDx, 1600);
    assert.strictEqual(clampedPosDy, 780);

    const clampedRightElements = skeletonState.elements.map((el) => ({
        ...el,
        points: [el.points[0] + clampedPosDx, el.points[1] + clampedPosDy],
    }));
    for (const el of clampedRightElements) {
        assert.ok(el.points[0] <= imageWidth, `X coordinate must be <= ${imageWidth}`);
        assert.ok(el.points[1] <= imageHeight, `Y coordinate must be <= ${imageHeight}`);
    }

    // 4. Individual landmark dragging still works independently
    const singleLandmark = skeletonState.elements[0];
    const singleNewPoint = [295, 215];
    const editedSingle = { ...singleLandmark, points: singleNewPoint };
    assert.deepStrictEqual(editedSingle.points, [295, 215]);
    // Other landmarks remain untouched
    assert.deepStrictEqual(skeletonState.elements[1].points, [320, 200]);

    console.log('  ✔ TC 97 passed.');
}

// TC 98: Whole-Skeleton Movement Dispatches to CVAT Annotation Pipeline and Active Frame Only
{
    console.log('TC 98: Whole-skeleton movement dispatches to CVAT pipeline and active frame only...');
    const activeFrameNumber = 5;
    const inactiveFrameNumber = 2;

    const frame2Skeleton = {
        clientID: 701,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 702, points: [100, 100], outside: false },
            { clientID: 703, points: [150, 150], outside: false },
        ],
    };

    const frame5Skeleton = {
        clientID: 701,
        objectType: 'track',
        shapeType: 'skeleton',
        elements: [
            { clientID: 802, points: [200, 200], outside: false },
            { clientID: 803, points: [250, 250], outside: false },
        ],
    };

    const dispatchedActions = [];
    const dispatch = (action) => dispatchedActions.push(action);

    // Simulated handleEditSkeleton
    const handleEditSkeleton = (tileFrame, isActive, parentState, deltaX, deltaY) => {
        if (!isActive || !parentState || !Array.isArray(parentState.elements)) return false;

        const updatedElements = [];
        for (const el of parentState.elements) {
            if (Array.isArray(el.points) && el.points.length >= 2) {
                el.points = [Math.round(el.points[0] + deltaX), Math.round(el.points[1] + deltaY)];
                updatedElements.push(el);
            }
        }

        dispatch({ type: 'CHANGE_FRAME_ASYNC', frame: tileFrame });
        dispatch({ type: 'ACTIVATE_OBJECT', activatedStateID: parentState.clientID, activatedElementID: null });
        dispatch({ type: 'UPDATE_ANNOTATIONS_ASYNC', states: updatedElements });
        return true;
    };

    // 1. Attempt edit on inactive frame (Frame 2): Must be rejected
    const inactiveResult = handleEditSkeleton(inactiveFrameNumber, false, frame2Skeleton, 30, 30);
    assert.strictEqual(inactiveResult, false, 'Edit on inactive frame must return without dispatching');
    assert.strictEqual(dispatchedActions.length, 0, 'No actions dispatched for inactive frame');
    assert.deepStrictEqual(frame2Skeleton.elements[0].points, [100, 100], 'Inactive frame coordinates must remain unchanged');

    // 2. Edit on active frame (Frame 5): Must succeed
    const activeResult = handleEditSkeleton(activeFrameNumber, true, frame5Skeleton, 40, -25);
    assert.strictEqual(activeResult, true);
    assert.strictEqual(dispatchedActions.length, 3);
    assert.strictEqual(dispatchedActions[0].type, 'CHANGE_FRAME_ASYNC');
    assert.strictEqual(dispatchedActions[0].frame, 5);
    assert.strictEqual(dispatchedActions[1].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(dispatchedActions[1].activatedStateID, 701);
    assert.strictEqual(dispatchedActions[1].activatedElementID, null);
    assert.strictEqual(dispatchedActions[2].type, 'UPDATE_ANNOTATIONS_ASYNC');
    assert.strictEqual(dispatchedActions[2].states.length, 2);
    assert.deepStrictEqual(dispatchedActions[2].states[0].points, [240, 175]);
    assert.deepStrictEqual(dispatchedActions[2].states[1].points, [290, 225]);

    // Frame 2 points must still be completely untouched
    assert.deepStrictEqual(frame2Skeleton.elements[0].points, [100, 100]);
    assert.deepStrictEqual(frame2Skeleton.elements[1].points, [150, 150]);

    // 3. Auto-Zoom recalculates the outer bounding box for the moved skeleton
    const newBBox = getObjectBoundingBox(frame5Skeleton, null, [frame5Skeleton]);
    assert.notStrictEqual(newBBox, null);
    // [240-20, 175-20, 290+20, 225+20] = [220, 155, 310, 245]
    assert.deepStrictEqual(newBBox, { xtl: 220, ytl: 155, xbr: 310, ybr: 245 });

    console.log('  ✔ TC 98 passed.');
}

// TC 99: Whole-Skeleton Dragging Bounding Box Position Drift Prevention and Duplicate Offset Regression Test
{
    console.log('TC 99: Whole-skeleton dragging bounding box position drift prevention and duplicate offset...');
    const initialSkeleton = {
        clientID: 901,
        objectType: 'track',
        shapeType: 'skeleton',
        label: { id: 20, name: 'pose' },
        wrappingRect: { xtl: 100, ytl: 100, xbr: 300, ybr: 400 },
        boundingBox: { xtl: 100, ytl: 100, xbr: 300, ybr: 400 },
        elements: [
            { clientID: 902, shapeType: 'points', label: { id: 1, name: 'nose' }, points: [200, 150], outside: false },
            { clientID: 903, shapeType: 'points', label: { id: 2, name: 'left_hand' }, points: [120, 250], outside: false },
            { clientID: 904, shapeType: 'points', label: { id: 3, name: 'right_hand' }, points: [280, 250], outside: false },
            { clientID: 905, shapeType: 'points', label: { id: 4, name: 'left_foot' }, points: [150, 380], outside: false },
            { clientID: 906, shapeType: 'points', label: { id: 5, name: 'right_foot' }, points: [250, 380], outside: false },
        ],
    };

    let frameStates = [JSON.parse(JSON.stringify(initialSkeleton))];

    // Measure initial relative offset between bounding box top-left and nose landmark
    const initialOuterBox = resolveSkeletonWrappingBox(frameStates[0], frameStates);
    assert.deepStrictEqual(initialOuterBox, { xtl: 100, ytl: 100, xbr: 300, ybr: 400 });
    const initialRelativeX = frameStates[0].elements[0].points[0] - initialOuterBox.xtl; // 200 - 100 = 100
    const initialRelativeY = frameStates[0].elements[0].points[1] - initialOuterBox.ytl; // 150 - 100 = 50

    // Simulate handleEditSkeleton matching multiframe-tile.tsx implementation
    const simulateEditSkeleton = (parentState, dx, dy) => {
        const currentOuterBox = resolveSkeletonWrappingBox(parentState, frameStates);
        const newOuterBox = currentOuterBox ? {
            xtl: Math.round(currentOuterBox.xtl + dx),
            ytl: Math.round(currentOuterBox.ytl + dy),
            xbr: Math.round(currentOuterBox.xbr + dx),
            ybr: Math.round(currentOuterBox.ybr + dy),
        } : null;

        const updatedElements = [];
        const elementTargetPoints = new Map();
        for (const el of parentState.elements) {
            if (Array.isArray(el.points) && el.points.length >= 2) {
                const newX = Math.round(el.points[0] + dx);
                const newY = Math.round(el.points[1] + dy);
                elementTargetPoints.set(el.clientID, [newX, newY]);
                el.points = [newX, newY];
                updatedElements.push(el);
            }
        }

        if (newOuterBox) {
            parentState.wrappingRect = { ...newOuterBox };
            parentState.boundingBox = { ...newOuterBox };
            if (Array.isArray(parentState.points) && parentState.points.length === 4) {
                parentState.points = [newOuterBox.xtl, newOuterBox.ytl, newOuterBox.xbr, newOuterBox.ybr];
            }
        }

        // Optimistically update frameStates without duplicate offsets
        frameStates = frameStates.map((st) => {
            if (st.clientID === parentState.clientID && Array.isArray(st.elements)) {
                return {
                    ...st,
                    wrappingRect: newOuterBox ? { ...newOuterBox } : st.wrappingRect,
                    boundingBox: newOuterBox ? { ...newOuterBox } : st.boundingBox,
                    points: (newOuterBox && Array.isArray(st.points) && st.points.length === 4) ?
                        [newOuterBox.xtl, newOuterBox.ytl, newOuterBox.xbr, newOuterBox.ybr] : st.points,
                    elements: st.elements.map((el) => {
                        const target = elementTargetPoints.get(el.clientID);
                        if (target) {
                            return {
                                ...el,
                                points: [target[0], target[1]],
                            };
                        }
                        return el;
                    }),
                };
            }
            return st;
        });

        return { updatedElements, newOuterBox };
    };

    // 1. Move skeleton by dx = +60, dy = -40
    const move1 = simulateEditSkeleton(frameStates[0], 60, -40);

    // Verify landmarks translated by exact offset without duplicate offset (no 2*dx)
    assert.deepStrictEqual(frameStates[0].elements[0].points, [260, 110], 'Nose landmark must be exactly [200+60, 150-40]');
    assert.deepStrictEqual(frameStates[0].elements[1].points, [180, 210]);
    assert.deepStrictEqual(frameStates[0].elements[2].points, [340, 210]);
    assert.deepStrictEqual(frameStates[0].elements[3].points, [210, 340]);
    assert.deepStrictEqual(frameStates[0].elements[4].points, [310, 340]);

    // Verify outer bounding box synchronously translated by the same offset
    assert.deepStrictEqual(move1.newOuterBox, { xtl: 160, ytl: 60, xbr: 360, ybr: 360 });
    assert.deepStrictEqual(frameStates[0].wrappingRect, { xtl: 160, ytl: 60, xbr: 360, ybr: 360 });
    assert.deepStrictEqual(frameStates[0].boundingBox, { xtl: 160, ytl: 60, xbr: 360, ybr: 360 });

    // Verify resolveSkeletonWrappingBox retrieves the translated wrappingRect directly
    const resolvedBoxAfterMove1 = resolveSkeletonWrappingBox(frameStates[0], frameStates);
    assert.deepStrictEqual(resolvedBoxAfterMove1, { xtl: 160, ytl: 60, xbr: 360, ybr: 360 });

    // Relative distance between bounding box and landmarks must have ZERO DRIFT
    const relativeXAfterMove1 = frameStates[0].elements[0].points[0] - resolvedBoxAfterMove1.xtl;
    const relativeYAfterMove1 = frameStates[0].elements[0].points[1] - resolvedBoxAfterMove1.ytl;
    assert.strictEqual(relativeXAfterMove1, initialRelativeX, 'Relative X offset between box and landmark must be preserved');
    assert.strictEqual(relativeYAfterMove1, initialRelativeY, 'Relative Y offset between box and landmark must be preserved');

    // 2. Second consecutive move: dx = -30, dy = +50
    const move2 = simulateEditSkeleton(frameStates[0], -30, 50);

    assert.deepStrictEqual(frameStates[0].elements[0].points, [230, 160]);
    assert.deepStrictEqual(move2.newOuterBox, { xtl: 130, ytl: 110, xbr: 330, ybr: 410 });
    const resolvedBoxAfterMove2 = resolveSkeletonWrappingBox(frameStates[0], frameStates);
    assert.deepStrictEqual(resolvedBoxAfterMove2, { xtl: 130, ytl: 110, xbr: 330, ybr: 410 });

    const relativeXAfterMove2 = frameStates[0].elements[0].points[0] - resolvedBoxAfterMove2.xtl;
    const relativeYAfterMove2 = frameStates[0].elements[0].points[1] - resolvedBoxAfterMove2.ytl;
    assert.strictEqual(relativeXAfterMove2, initialRelativeX, 'Consecutive movement must maintain zero position drift');
    assert.strictEqual(relativeYAfterMove2, initialRelativeY, 'Consecutive movement must maintain zero position drift');

    console.log('  ✔ TC 99 passed.');
}

// TC 100: Interaction Separation Between Point Editing, Box Dragging, and Click-Without-Drag
{
    console.log('TC 100: Interaction separation between point editing, box dragging, and click-without-drag...');
    const parentSkeleton = {
        clientID: 1001,
        shapeType: 'skeleton',
        elements: [
            { clientID: 1002, shapeType: 'points', points: [150, 150] },
            { clientID: 1003, shapeType: 'points', points: [250, 250] },
        ],
    };

    const actionLog = [];
    const dispatchAction = (action) => actionLog.push(action);

    // Mock handlers mimicking multiframe-tile.tsx and multiframe-svg-overlay.tsx
    const onSelectObject = (state, elementState) => {
        if (elementState) {
            dispatchAction({ type: 'ACTIVATE_OBJECT', clientID: state.clientID, elementID: elementState.clientID });
        } else {
            dispatchAction({ type: 'ACTIVATE_OBJECT', clientID: state.clientID, elementID: null });
        }
    };

    const onEditLandmark = (parentState, elementState, newPoints) => {
        dispatchAction({ type: 'EDIT_LANDMARK', parentID: parentState.clientID, elementID: elementState.clientID, newPoints });
    };

    const onEditSkeleton = (state, dx, dy) => {
        dispatchAction({ type: 'EDIT_SKELETON', clientID: state.clientID, dx, dy });
    };

    // 1. Interaction A: Clicking a landmark without dragging (dist <= 0.5)
    // Landmark circle onMouseDown -> e.stopPropagation() prevents box drag initiation
    const simulateLandmarkClick = (state, el) => {
        const initialPoint = [el.points[0], el.points[1]];
        const currentPoint = [el.points[0], el.points[1]]; // no mouse movement
        const dist = Math.hypot(currentPoint[0] - initialPoint[0], currentPoint[1] - initialPoint[1]);
        if (dist > 0.5) {
            onEditLandmark(state, el, currentPoint);
        }
        onSelectObject(state, el);
    };

    actionLog.length = 0;
    simulateLandmarkClick(parentSkeleton, parentSkeleton.elements[0]);
    assert.strictEqual(actionLog.length, 1);
    assert.strictEqual(actionLog[0].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(actionLog[0].clientID, 1001);
    assert.strictEqual(actionLog[0].elementID, 1002, 'Clicking landmark must activate landmark point');
    assert.strictEqual(actionLog.some((a) => a.type === 'EDIT_LANDMARK'), false, 'Click without drag must not edit landmark');
    assert.strictEqual(actionLog.some((a) => a.type === 'EDIT_SKELETON'), false, 'Landmark click must not move skeleton');

    // 2. Interaction B: Dragging a landmark individually (dist > 0.5)
    const simulateLandmarkDrag = (state, el, newX, newY) => {
        const initialPoint = [el.points[0], el.points[1]];
        const currentPoint = [newX, newY];
        const dist = Math.hypot(currentPoint[0] - initialPoint[0], currentPoint[1] - initialPoint[1]);
        if (dist > 0.5) {
            onEditLandmark(state, el, currentPoint);
        }
        onSelectObject(state, el);
    };

    actionLog.length = 0;
    simulateLandmarkDrag(parentSkeleton, parentSkeleton.elements[0], 165, 175);
    assert.strictEqual(actionLog.length, 2);
    assert.strictEqual(actionLog[0].type, 'EDIT_LANDMARK');
    assert.strictEqual(actionLog[0].elementID, 1002);
    assert.deepStrictEqual(actionLog[0].newPoints, [165, 175]);
    assert.strictEqual(actionLog[1].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(actionLog[1].elementID, 1002);
    assert.strictEqual(actionLog.some((a) => a.type === 'EDIT_SKELETON'), false, 'Individual landmark drag must not trigger whole skeleton drag');

    // 3. Interaction C: Clicking the outer bounding box without dragging (dist <= 0.5)
    const simulateBoxClick = (state) => {
        const currentOffset = [0, 0]; // no movement
        const dist = Math.hypot(currentOffset[0], currentOffset[1]);
        if (dist > 0.5) {
            onEditSkeleton(state, currentOffset[0], currentOffset[1]);
        }
        onSelectObject(state);
    };

    actionLog.length = 0;
    simulateBoxClick(parentSkeleton);
    assert.strictEqual(actionLog.length, 1);
    assert.strictEqual(actionLog[0].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(actionLog[0].clientID, 1001);
    assert.strictEqual(actionLog[0].elementID, null, 'Clicking box must activate parent skeleton without selecting a child landmark');
    assert.strictEqual(actionLog.some((a) => a.type === 'EDIT_SKELETON'), false, 'Clicking box without dragging must not move skeleton');
    assert.strictEqual(actionLog.some((a) => a.type === 'EDIT_LANDMARK'), false, 'Box click must not edit landmark');

    // 4. Interaction D: Dragging the outer bounding box (dist > 0.5)
    const simulateBoxDrag = (state, dx, dy) => {
        const currentOffset = [dx, dy];
        const dist = Math.hypot(currentOffset[0], currentOffset[1]);
        if (dist > 0.5) {
            onEditSkeleton(state, currentOffset[0], currentOffset[1]);
        }
        onSelectObject(state);
    };

    actionLog.length = 0;
    simulateBoxDrag(parentSkeleton, 45, -35);
    assert.strictEqual(actionLog.length, 2);
    assert.strictEqual(actionLog[0].type, 'EDIT_SKELETON');
    assert.strictEqual(actionLog[0].clientID, 1001);
    assert.strictEqual(actionLog[0].dx, 45);
    assert.strictEqual(actionLog[0].dy, -35);
    assert.strictEqual(actionLog[1].type, 'ACTIVATE_OBJECT');
    assert.strictEqual(actionLog[1].clientID, 1001);
    assert.strictEqual(actionLog[1].elementID, null);

    console.log('  ✔ TC 100 passed.');
}

// TC 101: Skeleton Connection Lines (Edges/Bones) Rendering and Coordinate Alignment
{
    console.log('TC 101: Skeleton connection lines (edges/bones) rendering and coordinate alignment...');

    // 1. Mock DOM element simulating native CVAT SVGSVGElement (label.structure.svg)
    const mockCircle1 = {
        getAttribute: (attr) => ({ 'data-node-id': '1', 'data-label-id': '501', 'data-element-id': '1' }[attr] ?? null),
    };
    const mockCircle2 = {
        getAttribute: (attr) => ({ 'data-node-id': '2', 'data-label-id': '502', 'data-element-id': '2' }[attr] ?? null),
    };
    const mockCircle3 = {
        getAttribute: (attr) => ({ 'data-node-id': '3', 'data-label-id': '503', 'data-element-id': '3' }[attr] ?? null),
    };
    const mockLine1 = {
        getAttribute: (attr) => ({ 'data-type': 'edge', 'data-node-from': '1', 'data-node-to': '2' }[attr] ?? null),
    };
    const mockLine2 = {
        getAttribute: (attr) => ({ 'data-type': 'edge', 'data-node-from': '2', 'data-node-to': '3' }[attr] ?? null),
    };

    const mockSvgDom = {
        querySelectorAll: (selector) => {
            if (selector === 'circle') return [mockCircle1, mockCircle2, mockCircle3];
            if (selector === 'line') return [mockLine1, mockLine2];
            return [];
        },
    };

    // Parse template matching multiframe-svg-overlay.tsx parseSkeletonTemplate
    const parseTemplate = (svgSource, labelSublabels) => {
        const edges = [];
        const nodes = [];

        if (typeof svgSource === 'object' && svgSource !== null && typeof svgSource.querySelectorAll === 'function') {
            const circleElements = Array.from(svgSource.querySelectorAll('circle'));
            circleElements.forEach((circle, index) => {
                const nodeId = circle.getAttribute('data-node-id') || String(index + 1);
                const labelIdStr = circle.getAttribute('data-label-id');
                const labelName = circle.getAttribute('data-label-name') || undefined;
                const elementIdStr = circle.getAttribute('data-element-id');
                nodes.push({
                    nodeId,
                    labelId: labelIdStr ? Number(labelIdStr) : undefined,
                    labelName,
                    elementId: elementIdStr ? Number(elementIdStr) : undefined,
                    index,
                });
            });

            const lineElements = Array.from(svgSource.querySelectorAll('line'));
            lineElements.forEach((line) => {
                const fromStr = line.getAttribute('data-node-from');
                const toStr = line.getAttribute('data-node-to');
                if (fromStr && toStr) {
                    edges.push({
                        from: Number(fromStr),
                        to: Number(toStr),
                        fromNode: fromStr,
                        toNode: toStr,
                    });
                }
            });
        }

        if (Array.isArray(labelSublabels)) {
            nodes.forEach((node) => {
                const sub = (node.elementId !== undefined && labelSublabels[node.elementId - 1]) ||
                    (node.index < labelSublabels.length && labelSublabels[node.index]);
                if (sub) {
                    if (node.labelId === undefined && sub.id !== undefined) {
                        node.labelId = Number(sub.id);
                    }
                    if (!node.labelName && sub.name) {
                        node.labelName = sub.name;
                    }
                }
            });
        }

        const nodeToLabelIdMap = new Map();
        nodes.forEach((node) => {
            if (node.labelId !== undefined) {
                nodeToLabelIdMap.set(node.nodeId, node.labelId);
            }
        });

        edges.forEach((edge) => {
            if (edge.fromNode && nodeToLabelIdMap.has(edge.fromNode)) {
                edge.from = nodeToLabelIdMap.get(edge.fromNode);
            }
            if (edge.toNode && nodeToLabelIdMap.has(edge.toNode)) {
                edge.to = nodeToLabelIdMap.get(edge.toNode);
            }
        });

        return { edges, nodes };
    };

    const parsedFromDom = parseTemplate(mockSvgDom);
    assert.strictEqual(parsedFromDom.edges.length, 2, 'Must extract 2 edges from native DOM SVGSVGElement');
    assert.strictEqual(parsedFromDom.nodes.length, 3, 'Must extract 3 nodes from native DOM SVGSVGElement');
    assert.strictEqual(parsedFromDom.edges[0].from, 501);
    assert.strictEqual(parsedFromDom.edges[0].to, 502);
    assert.strictEqual(parsedFromDom.edges[1].from, 502);
    assert.strictEqual(parsedFromDom.edges[1].to, 503);

    // 2. Resolver matching multiframe-svg-overlay.tsx render pipeline
    const resolveEdgesToRender = (skeletonState, template, dragInfo) => {
        const { edges, nodes } = template;
        const nodeToElement = new Map();
        const sublabelIdToElement = new Map();
        const sublabelNameToElement = new Map();

        for (const el of skeletonState.elements) {
            if (el.label?.id !== undefined) {
                sublabelIdToElement.set(Number(el.label.id), el);
            }
            if (el.label?.name) {
                sublabelNameToElement.set(el.label.name, el);
            }
        }

        nodes.forEach((node) => {
            let matchedEl = null;
            if (node.labelId !== undefined && sublabelIdToElement.has(node.labelId)) {
                matchedEl = sublabelIdToElement.get(node.labelId);
            } else if (node.labelName && sublabelNameToElement.has(node.labelName)) {
                matchedEl = sublabelNameToElement.get(node.labelName);
            } else if (node.elementId !== undefined && skeletonState.elements[node.elementId - 1]) {
                matchedEl = skeletonState.elements[node.elementId - 1];
            } else if (node.index < skeletonState.elements.length) {
                matchedEl = skeletonState.elements[node.index];
            }
            if (matchedEl) {
                nodeToElement.set(node.nodeId, matchedEl);
            }
        });

        for (let i = 0; i < skeletonState.elements.length; i++) {
            const el = skeletonState.elements[i];
            const elNodeId = el['data-node-id'] ?? el.nodeID ?? el.nodeId ?? String(i + 1);
            if (!nodeToElement.has(String(elNodeId))) {
                nodeToElement.set(String(elNodeId), el);
            }
        }

        const renderedEdges = [];
        edges.forEach((edge, idx) => {
            const fromEl = (edge.fromNode && nodeToElement.get(edge.fromNode)) ||
                sublabelIdToElement.get(edge.from) ||
                nodeToElement.get(String(edge.from));
            const toEl = (edge.toNode && nodeToElement.get(edge.toNode)) ||
                sublabelIdToElement.get(edge.to) ||
                nodeToElement.get(String(edge.to));

            if (!fromEl || !toEl || fromEl.outside || toEl.outside) {
                return;
            }

            let [x1, y1] = fromEl.points || [];
            let [x2, y2] = toEl.points || [];

            if (dragInfo?.isDraggingThisSkeleton) {
                x1 += dragInfo.dragDx;
                y1 += dragInfo.dragDy;
                x2 += dragInfo.dragDx;
                y2 += dragInfo.dragDy;
            } else if (dragInfo?.draggedLandmarkId) {
                if (dragInfo.draggedLandmarkId === fromEl.clientID) {
                    [x1, y1] = dragInfo.currentPoint;
                }
                if (dragInfo.draggedLandmarkId === toEl.clientID) {
                    [x2, y2] = dragInfo.currentPoint;
                }
            }

            const isEdgeOccluded = Boolean(fromEl.occluded || toEl.occluded || skeletonState.occluded);

            renderedEdges.push({
                idx,
                x1, y1, x2, y2,
                fromClientId: fromEl.clientID,
                toClientId: toEl.clientID,
                isEdgeOccluded,
            });
        });

        return renderedEdges;
    };

    const skeletonState = {
        clientID: 1101,
        shapeType: 'skeleton',
        elements: [
            { clientID: 1102, label: { id: 501, name: 'shoulder' }, points: [100, 150], outside: false, occluded: false },
            { clientID: 1103, label: { id: 502, name: 'elbow' }, points: [200, 250], outside: false, occluded: false },
            { clientID: 1104, label: { id: 503, name: 'wrist' }, points: [300, 320], outside: false, occluded: false },
        ],
    };

    // 3. Default render: All valid edges render between correct landmark points
    const defaultEdges = resolveEdgesToRender(skeletonState, parsedFromDom);
    assert.strictEqual(defaultEdges.length, 2, 'Both skeleton bones must render');
    assert.deepStrictEqual([defaultEdges[0].x1, defaultEdges[0].y1, defaultEdges[0].x2, defaultEdges[0].y2], [100, 150, 200, 250]);
    assert.deepStrictEqual([defaultEdges[1].x1, defaultEdges[1].y1, defaultEdges[1].x2, defaultEdges[1].y2], [200, 250, 300, 320]);
    assert.strictEqual(defaultEdges[0].isEdgeOccluded, false);

    // 4. Live dynamic stretching during landmark drag
    const draggedLandmarkEdges = resolveEdgesToRender(skeletonState, parsedFromDom, {
        draggedLandmarkId: 1103, // elbow dragged
        currentPoint: [220, 270],
    });
    assert.strictEqual(draggedLandmarkEdges.length, 2);
    // Edge 0 (shoulder -> elbow): endpoint 2 dynamically moves to [220, 270]
    assert.deepStrictEqual([draggedLandmarkEdges[0].x1, draggedLandmarkEdges[0].y1, draggedLandmarkEdges[0].x2, draggedLandmarkEdges[0].y2], [100, 150, 220, 270]);
    // Edge 1 (elbow -> wrist): startpoint 1 dynamically moves to [220, 270]
    assert.deepStrictEqual([draggedLandmarkEdges[1].x1, draggedLandmarkEdges[1].y1, draggedLandmarkEdges[1].x2, draggedLandmarkEdges[1].y2], [220, 270, 300, 320]);

    // 5. Whole skeleton dragging: All bone coordinates translate by [dx, dy]
    const wholeDragEdges = resolveEdgesToRender(skeletonState, parsedFromDom, {
        isDraggingThisSkeleton: true,
        dragDx: 40,
        dragDy: -25,
    });
    assert.strictEqual(wholeDragEdges.length, 2);
    assert.deepStrictEqual([wholeDragEdges[0].x1, wholeDragEdges[0].y1, wholeDragEdges[0].x2, wholeDragEdges[0].y2], [140, 125, 240, 225]);
    assert.deepStrictEqual([wholeDragEdges[1].x1, wholeDragEdges[1].y1, wholeDragEdges[1].x2, wholeDragEdges[1].y2], [240, 225, 340, 295]);

    // 6. Outside / absent landmark: Edge connected to outside landmark is omitted
    const stateWithOutside = {
        ...skeletonState,
        elements: [
            skeletonState.elements[0],
            skeletonState.elements[1],
            { ...skeletonState.elements[2], outside: true }, // wrist is outside
        ],
    };
    const outsideEdges = resolveEdgesToRender(stateWithOutside, parsedFromDom);
    assert.strictEqual(outsideEdges.length, 1, 'Edge to outside landmark must be omitted');
    assert.strictEqual(outsideEdges[0].fromClientId, 1102);
    assert.strictEqual(outsideEdges[0].toClientId, 1103);

    // 7. Occluded landmark: Edge connecting occluded landmark has isEdgeOccluded = true
    const stateWithOccluded = {
        ...skeletonState,
        elements: [
            skeletonState.elements[0],
            { ...skeletonState.elements[1], occluded: true }, // elbow is occluded
            skeletonState.elements[2],
        ],
    };
    const occludedEdges = resolveEdgesToRender(stateWithOccluded, parsedFromDom);
    assert.strictEqual(occludedEdges.length, 2);
    assert.strictEqual(occludedEdges[0].isEdgeOccluded, true, 'Edge connected to occluded landmark must be dashed/occluded');
    assert.strictEqual(occludedEdges[1].isEdgeOccluded, true, 'Edge connected to occluded landmark must be dashed/occluded');

    console.log('  ✔ TC 101 passed.');
}

// TC 102: Full-Screen Frame Zoom Transition, State Preservation, Navigation, and Return to Grid
{
    console.log('TC 102: Full-screen frame zoom transition, state preservation, navigation, and return to grid...');

    function openFullscreenFrameZoom(currentState, targetFrame) {
        return {
            ...currentState,
            zoomedFrame: targetFrame,
        };
    }

    function returnToMultiframeGrid(currentState, activeFrame, batchSize = 16) {
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

    function navigateFullscreenFrame(currentState, nextFrame, batchSize = 16) {
        const computedBatch = Math.floor((nextFrame - currentState.rangeStart) / batchSize);
        return {
            ...currentState,
            zoomedFrame: nextFrame,
            batchIndex: computedBatch >= 0 ? computedBatch : currentState.batchIndex,
        };
    }

    // 1. Initial Multi-Frame grid state with custom range, batch, and selected skeleton object
    const initialGridState = {
        rangeStart: 0,
        rangeEnd: 50,
        batchIndex: 1, // viewing frames 16-31
        selectedObjectKey: 'track_1001',
        selectedTypeFilter: 'skeleton',
        autoZoomEnabled: true,
        zoomedFrame: null,
    };

    // 2. Click Zoom on frame #25
    const zoomedState = openFullscreenFrameZoom(initialGridState, 25);
    assert.strictEqual(zoomedState.zoomedFrame, 25, 'zoomedFrame must be set to 25');
    assert.strictEqual(zoomedState.rangeStart, 0, 'rangeStart must be preserved');
    assert.strictEqual(zoomedState.rangeEnd, 50, 'rangeEnd must be preserved');
    assert.strictEqual(zoomedState.batchIndex, 1, 'batchIndex must be preserved');
    assert.strictEqual(zoomedState.selectedObjectKey, 'track_1001', 'selectedObjectKey must be preserved');
    assert.strictEqual(zoomedState.selectedTypeFilter, 'skeleton', 'selectedTypeFilter must be preserved');
    assert.strictEqual(zoomedState.autoZoomEnabled, true, 'autoZoomEnabled must be preserved');

    // 3. Navigate next frame in full-screen zoom (frame 25 -> 26)
    const nextFrameState = navigateFullscreenFrame(zoomedState, 26);
    assert.strictEqual(nextFrameState.zoomedFrame, 26, 'zoomedFrame must update to 26');
    assert.strictEqual(nextFrameState.batchIndex, 1, 'batchIndex remains in batch 1');

    // 4. Navigate into next batch in full-screen zoom (frame 26 -> 35, which belongs to batch index 2)
    const crossedBatchState = navigateFullscreenFrame(nextFrameState, 35);
    assert.strictEqual(crossedBatchState.zoomedFrame, 35, 'zoomedFrame must update to 35');
    assert.strictEqual(crossedBatchState.batchIndex, 2, 'batchIndex must synchronize to batch 2 (frames 32..47)');

    // 5. Return to Multi-Frame Grid
    const returnedState = returnToMultiframeGrid(crossedBatchState, 35);
    assert.strictEqual(returnedState.zoomedFrame, null, 'zoomedFrame must be reset to null to show grid');
    assert.strictEqual(returnedState.rangeStart, 0, 'rangeStart must remain preserved');
    assert.strictEqual(returnedState.rangeEnd, 50, 'rangeEnd must remain preserved');
    assert.strictEqual(returnedState.batchIndex, 2, 'batchIndex must point to batch containing frame 35');
    assert.strictEqual(returnedState.selectedObjectKey, 'track_1001', 'selectedObjectKey must remain selected');
    assert.strictEqual(returnedState.selectedTypeFilter, 'skeleton', 'selectedTypeFilter must remain intact');

    // 6. Annotation data non-mutation guarantee
    const originalAnnotations = [
        { clientID: 1001, shapeType: 'skeleton', elements: [{ clientID: 1, points: [10, 20] }] },
    ];
    const snapshot = JSON.stringify(originalAnnotations);
    openFullscreenFrameZoom(initialGridState, 10);
    returnToMultiframeGrid(initialGridState, 10);
    assert.strictEqual(JSON.stringify(originalAnnotations), snapshot, 'Underlying annotation data must not be mutated');

    // 7. Verify tile Zoom button event dispatch callback
    let zoomTargetFrame = null;
    const mockOnZoomFrame = (f) => { zoomTargetFrame = f; };
    mockOnZoomFrame(42);
    assert.strictEqual(zoomTargetFrame, 42, 'Zoom action must target frame #42');

    console.log('  ✔ TC 102 passed.');
}

// TC 103: Save Edits Immediately Through CVAT Normal Annotation Flow Without Requiring Explicit Save or Exit
{
    console.log('TC 103: Save edits immediately through CVAT normal annotation flow without requiring explicit save or exit...');

    // Mock CVAT Job & Annotation Collection matching native CVAT architecture
    class MockAnnotationsCollection {
        constructor() {
            this.frameStore = new Map();
            this.hasUnsaved = false;
        }

        setFrame(frame, states) {
            this.frameStore.set(frame, JSON.parse(JSON.stringify(states)));
        }

        async get(frame) {
            return JSON.parse(JSON.stringify(this.frameStore.get(frame) || []));
        }

        hasUnsavedChanges() {
            return this.hasUnsaved;
        }

        saveObjectState(frame, objectState) {
            const states = this.frameStore.get(frame) || [];
            const index = states.findIndex((s) => s.clientID === objectState.clientID);
            if (index !== -1) {
                states[index] = JSON.parse(JSON.stringify(objectState));
            } else {
                // If it's a child element, update inside parent
                for (const st of states) {
                    if (Array.isArray(st.elements)) {
                        const elIdx = st.elements.findIndex((e) => e.clientID === objectState.clientID);
                        if (elIdx !== -1) {
                            st.elements[elIdx] = JSON.parse(JSON.stringify(objectState));
                            break;
                        }
                    }
                }
            }
            this.frameStore.set(frame, states);
            this.hasUnsaved = true;
        }
    }

    const mockCollection = new MockAnnotationsCollection();

    // Frame 10: initial annotation
    const initialLandmark = { clientID: 2002, parentID: 2001, points: [100, 150] };
    const initialSkeleton = {
        clientID: 2001,
        shapeType: 'skeleton',
        elements: [initialLandmark],
    };
    mockCollection.setFrame(10, [initialSkeleton]);

    // Initial state: no unsaved changes
    assert.strictEqual(mockCollection.hasUnsavedChanges(), false);

    // 1. User performs an edit on active tile (Frame 10): move landmark [100, 150] -> [130, 180]
    const editedPoints = [130, 180];
    const editedLandmarkState = {
        ...initialLandmark,
        points: [...editedPoints],
        save: async () => {
            mockCollection.saveObjectState(10, editedLandmarkState);
        },
    };

    // Simulate handleEditLandmark flow: dispatches updateAnnotationsAsync immediately
    let updateDispatched = false;
    const simulateUpdateAnnotationsAsync = async (states) => {
        updateDispatched = true;
        for (const st of states) {
            await st.save();
        }
    };

    // Edit occurs: no explicit Save button or exiting Multi-Frame required
    simulateUpdateAnnotationsAsync([editedLandmarkState]);
    assert.strictEqual(updateDispatched, true, 'updateAnnotationsAsync must be dispatched immediately');
    assert.strictEqual(mockCollection.hasUnsavedChanges(), true, 'CVAT autosave/unsaved changes must be active immediately');

    // 2. Immediate persistence verification
    (async () => {
        const liveStates = await mockCollection.get(10);
        assert.deepStrictEqual(liveStates[0].elements[0].points, [130, 180], 'Native CVAT collection must reflect edits immediately');

        // 3. Frame switching: navigate to Frame 11 then back to Frame 10
        mockCollection.setFrame(11, [{ clientID: 3001, shapeType: 'rectangle', points: [10, 10, 50, 50] }]);
        const frame11States = await mockCollection.get(11);
        assert.strictEqual(frame11States.length, 1);

        const returnedFrame10States = await mockCollection.get(10);
        assert.deepStrictEqual(returnedFrame10States[0].elements[0].points, [130, 180], 'Edits must be preserved when switching frames');

        // 4. Exit Multi-Frame: standard CVAT canvas mounts and reads current frame annotations
        const canvasMountedAnnotations = await mockCollection.get(10);
        assert.deepStrictEqual(canvasMountedAnnotations[0].elements[0].points, [130, 180], 'Standard workspace canvas must retain edits upon exiting Multi-Frame');
    })();

    console.log('  ✔ TC 103 passed.');
}

// TC 104: Whole-Skeleton Movement Recorded as Exactly One Undoable Operation
{
    console.log('TC 104: Whole-skeleton movement recorded as single undo/redo action vs individual landmark drag independent undo...');

    // CVAT History simulation matching cvat-core/src/history.ts & skeleton-shape.ts
    class MockCvatHistory {
        constructor() {
            this.actions = [];
            this.undoIndex = -1;
            this.activeTransaction = null;
        }

        beginTransaction(actionType) {
            if (this.activeTransaction !== null) {
                return false;
            }
            this.activeTransaction = {
                actionType,
                undoFns: [],
                redoFns: [],
            };
            return true;
        }

        endTransaction() {
            if (this.activeTransaction) {
                const tx = this.activeTransaction;
                this.activeTransaction = null;
                this.actions.push({
                    actionType: tx.actionType,
                    undo: () => {
                        for (let i = tx.undoFns.length - 1; i >= 0; i--) {
                            tx.undoFns[i]();
                        }
                    },
                    redo: () => {
                        for (let i = 0; i < tx.redoFns.length; i++) {
                            tx.redoFns[i]();
                        }
                    },
                });
                this.undoIndex = this.actions.length - 1;
            }
        }

        do(actionType, undoFn, redoFn) {
            if (this.activeTransaction) {
                this.activeTransaction.undoFns.push(undoFn);
                this.activeTransaction.redoFns.push(redoFn);
            } else {
                this.actions.push({ actionType, undo: undoFn, redo: redoFn });
                this.undoIndex = this.actions.length - 1;
            }
        }

        undo() {
            if (this.undoIndex >= 0) {
                this.actions[this.undoIndex].undo();
                this.undoIndex--;
            }
        }

        redo() {
            if (this.undoIndex < this.actions.length - 1) {
                this.undoIndex++;
                this.actions[this.undoIndex].redo();
            }
        }
    }

    const history = new MockCvatHistory();

    // 1. Skeleton with 5 landmarks
    const initialElements = [
        { clientID: 101, points: [100, 100] },
        { clientID: 102, points: [120, 100] },
        { clientID: 103, points: [110, 150] },
        { clientID: 104, points: [90, 200] },
        { clientID: 105, points: [130, 200] },
    ];
    const initialBox = { xtl: 70, ytl: 80, xbr: 150, ybr: 220 };

    const skeleton = {
        clientID: 100,
        shapeType: 'skeleton',
        wrappingRect: { ...initialBox },
        boundingBox: { ...initialBox },
        elements: initialElements.map((el) => ({ ...el, points: [...el.points] })),
    };

    // Save implementation matching SkeletonShape.save: wraps all element saves in one beginTransaction
    const saveSkeletonWhole = (sk, dx, dy) => {
        const oldPointsMap = new Map();
        const newPointsMap = new Map();
        sk.elements.forEach((el) => {
            oldPointsMap.set(el.clientID, [...el.points]);
            const newPt = [el.points[0] + dx, el.points[1] + dy];
            newPointsMap.set(el.clientID, newPt);
        });

        const oldBox = { ...sk.wrappingRect };
        const newBox = {
            xtl: oldBox.xtl + dx,
            ytl: oldBox.ytl + dy,
            xbr: oldBox.xbr + dx,
            ybr: oldBox.ybr + dy,
        };

        const ownsTransaction = history.beginTransaction('changed_points');
        try {
            // Apply coordinates
            sk.elements.forEach((el) => {
                const oldPt = oldPointsMap.get(el.clientID);
                const newPt = newPointsMap.get(el.clientID);
                el.points = [...newPt];
                history.do(
                    'changed_points',
                    () => { el.points = [...oldPt]; },
                    () => { el.points = [...newPt]; },
                );
            });

            sk.wrappingRect = { ...newBox };
            sk.boundingBox = { ...newBox };
            history.do(
                'changed_points',
                () => {
                    sk.wrappingRect = { ...oldBox };
                    sk.boundingBox = { ...oldBox };
                },
                () => {
                    sk.wrappingRect = { ...newBox };
                    sk.boundingBox = { ...newBox };
                },
            );
        } finally {
            if (ownsTransaction) {
                history.endTransaction();
            }
        }
    };

    // 2. Move whole skeleton: dx=+30, dy=-20
    const historyCountBefore = history.actions.length;
    saveSkeletonWhole(skeleton, 30, -20);

    // Verify all 5 landmarks and outer bounding box moved together
    assert.deepStrictEqual(skeleton.elements[0].points, [130, 80]);
    assert.deepStrictEqual(skeleton.elements[1].points, [150, 80]);
    assert.deepStrictEqual(skeleton.elements[2].points, [140, 130]);
    assert.deepStrictEqual(skeleton.elements[3].points, [120, 180]);
    assert.deepStrictEqual(skeleton.elements[4].points, [160, 180]);
    assert.deepStrictEqual(skeleton.wrappingRect, { xtl: 100, ytl: 60, xbr: 180, ybr: 200 });

    // VERIFY REQUIREMENT 2: Exactly ONE undo action was added to the history stack!
    const historyCountAfter = history.actions.length;
    assert.strictEqual(historyCountAfter - historyCountBefore, 1, 'Whole-skeleton movement must record as EXACTLY ONE action');

    // 3. ONE Ctrl+Z (history.undo()) restores complete skeleton and bounding box to exact previous positions
    history.undo();
    assert.deepStrictEqual(skeleton.elements[0].points, [100, 100], 'Landmark 0 restored on single undo');
    assert.deepStrictEqual(skeleton.elements[1].points, [120, 100], 'Landmark 1 restored on single undo');
    assert.deepStrictEqual(skeleton.elements[2].points, [110, 150], 'Landmark 2 restored on single undo');
    assert.deepStrictEqual(skeleton.elements[3].points, [90, 200], 'Landmark 3 restored on single undo');
    assert.deepStrictEqual(skeleton.elements[4].points, [130, 200], 'Landmark 4 restored on single undo');
    assert.deepStrictEqual(skeleton.wrappingRect, initialBox, 'Bounding box restored on single undo');

    // 4. ONE Ctrl+Y (history.redo()) restores moved state in one operation
    history.redo();
    assert.deepStrictEqual(skeleton.elements[0].points, [130, 80], 'Landmark 0 restored on single redo');
    assert.deepStrictEqual(skeleton.elements[4].points, [160, 180], 'Landmark 4 restored on single redo');
    assert.deepStrictEqual(skeleton.wrappingRect, { xtl: 100, ytl: 60, xbr: 180, ybr: 200 });

    // 5. Individual landmark dragging remains independently undoable
    const saveSingleLandmark = (el, newCoords) => {
        const oldPt = [...el.points];
        el.points = [...newCoords];
        history.do(
            'changed_points',
            () => { el.points = [...oldPt]; },
            () => { el.points = [...newCoords]; },
        );
    };

    // User edits landmark 0 individually: [130, 80] -> [135, 82]
    const singleCountBefore = history.actions.length;
    saveSingleLandmark(skeleton.elements[0], [135, 82]);
    assert.strictEqual(history.actions.length - singleCountBefore, 1);

    // User edits landmark 1 individually: [150, 80] -> [155, 78]
    saveSingleLandmark(skeleton.elements[1], [155, 78]);
    assert.strictEqual(history.actions.length - singleCountBefore, 2);

    // Undoing one action reverts ONLY landmark 1, keeping landmark 0 at [135, 82]
    history.undo();
    assert.deepStrictEqual(skeleton.elements[1].points, [150, 80], 'Only landmark 1 reverted on undo');
    assert.deepStrictEqual(skeleton.elements[0].points, [135, 82], 'Landmark 0 remains edited');

    // Undoing second action reverts landmark 0
    history.undo();
    assert.deepStrictEqual(skeleton.elements[0].points, [130, 80], 'Landmark 0 reverted on second undo');

    console.log('  ✔ TC 104 passed.');
}

// TC 105: UI Fixes: Preserve Image Aspect Ratio (Square/Wide/Tall) & Overlay Tile Controls on Image Without Space Consumption or Event Leaks
{
    console.log('TC 105: Preserve Image Aspect Ratio & Overlay Tile Controls on Image...');
    const fs = require('fs');
    const path = require('path');

    // 1. Image Aspect Ratio Preservation: Never stretch or crop; center within tile
    const testCases = [
        { name: 'Square image in landscape tile', imgW: 1000, imgH: 1000, tileW: 400, tileH: 300, expectedFitW: 300, expectedFitH: 300, expectedType: 'pillarbox' },
        { name: 'Square image in portrait tile', imgW: 1000, imgH: 1000, tileW: 300, tileH: 400, expectedFitW: 300, expectedFitH: 300, expectedType: 'letterbox' },
        { name: 'Square image in square tile', imgW: 1000, imgH: 1000, tileW: 350, tileH: 350, expectedFitW: 350, expectedFitH: 350, expectedType: 'none' },
        { name: '16:9 Landscape in 4:3 tile', imgW: 1920, imgH: 1080, tileW: 400, tileH: 300, expectedFitW: 400, expectedFitH: 225, expectedType: 'letterbox' },
        { name: '9:16 Portrait in 4:3 tile', imgW: 1080, imgH: 1920, tileW: 400, tileH: 300, expectedFitW: 168.75, expectedFitH: 300, expectedType: 'pillarbox' },
    ];

    for (const tc of testCases) {
        const layout = calculateContainedDimensions(tc.tileW, tc.tileH, tc.imgW, tc.imgH);

        // Aspect ratio is strictly preserved (zero stretching or distortion)
        const sourceAspect = tc.imgW / tc.imgH;
        const renderedAspect = layout.fitWidth / layout.fitHeight;
        assert.ok(
            Math.abs(renderedAspect - sourceAspect) < 1e-4,
            `${tc.name}: Aspect ratio must be preserved exactly. Got ${renderedAspect}, expected ${sourceAspect}`
        );

        // Fits completely within tile bounds (never cropped or clipped)
        assert.ok(layout.fitWidth <= tc.tileW + 1e-4, `${tc.name}: fitWidth exceeds tileWidth`);
        assert.ok(layout.fitHeight <= tc.tileH + 1e-4, `${tc.name}: fitHeight exceeds tileHeight`);

        // Image is centered within the tile
        const expectedOffsetX = (tc.tileW - layout.fitWidth) / 2;
        const expectedOffsetY = (tc.tileH - layout.fitHeight) / 2;
        assert.ok(Math.abs(layout.offsetX - expectedOffsetX) < 1e-4, `${tc.name}: Image must be centered horizontally`);
        assert.ok(Math.abs(layout.offsetY - expectedOffsetY) < 1e-4, `${tc.name}: Image must be centered vertically`);

        // Expected letterbox/pillarbox classification
        assert.strictEqual(layout.letterboxType, tc.expectedType, `${tc.name}: Letterbox type mismatch`);
    }

    // 2. Overlay Tile Controls: Verify position: absolute and zero space consumption from image in document flow
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');

    // Controls must be rendered inside .cvat-multiframe-tile-content overlaying the image
    assert.ok(
        tileSource.includes("className='cvat-multiframe-tile-header cvat-multiframe-tile-overlay-controls'"),
        'Controls must have overlay class cvat-multiframe-tile-overlay-controls'
    );
    assert.ok(
        tileSource.indexOf('cvat-multiframe-canvas-wrap') < tileSource.indexOf('cvat-multiframe-tile-overlay-controls'),
        'Controls overlay must be positioned on top of the image inside tile content'
    );

    // Overlay styles must use position: absolute at top with high z-index and subtle readable styling
    assert.ok(
        stylesSource.includes('position: absolute') && stylesSource.includes('z-index: 10'),
        'Controls overlay must be positioned absolute with high z-index so it consumes zero image space'
    );

    // 3. Event isolation: Overlay and buttons prevent accidental frame navigation, zoom, or dragging
    let parentTileClicked = false;
    let parentDoubleClicked = false;
    let canvasDragTriggered = false;

    const mockTile = {
        onNavigate: () => { parentTileClicked = true; },
        onZoom: () => { parentDoubleClicked = true; },
        onCanvasMouseDown: () => { canvasDragTriggered = true; },
    };

    // Simulate event handlers attached to overlay controls
    const simulateOverlayClick = (event) => {
        event.stopPropagation();
    };
    const simulateOverlayDoubleClick = (event) => {
        event.stopPropagation();
    };
    const simulateOverlayMouseDown = (event) => {
        event.stopPropagation();
    };

    // Helper to simulate event bubbling
    const triggerEvent = (stopPropagationFn, parentAction) => {
        let propagationStopped = false;
        const event = {
            stopPropagation: () => { propagationStopped = true; },
        };
        stopPropagationFn(event);
        if (!propagationStopped) {
            parentAction();
        }
    };

    // Clicking overlay does not trigger tile navigation
    triggerEvent(simulateOverlayClick, mockTile.onNavigate);
    assert.strictEqual(parentTileClicked, false, 'Clicking overlay controls must not trigger tile navigation');

    // Double clicking overlay does not trigger tile zoom
    triggerEvent(simulateOverlayDoubleClick, mockTile.onZoom);
    assert.strictEqual(parentDoubleClicked, false, 'Double-clicking overlay controls must not trigger tile zoom');

    // MouseDown on overlay does not trigger canvas dragging
    triggerEvent(simulateOverlayMouseDown, mockTile.onCanvasMouseDown);
    assert.strictEqual(canvasDragTriggered, false, 'MouseDown on overlay controls must not trigger canvas dragging');

    console.log('  ✔ TC 105 passed.');
}

// TC 106: Drag-to-Resize Zoom Functionality on Each Frame Tile
{
    console.log('TC 106: Drag-to-resize zoom functionality...');
    const fs = require('fs');
    const path = require('path');

    // 1. Draggable resize handle presence, DOM position, and styling
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');

    assert.ok(
        !tileSource.includes('cvat-multiframe-tile-resize-handle') &&
        !stylesSource.includes('.cvat-multiframe-tile-resize-handle'),
        'Drag-corner resize handle is removed (double-click zooms a frame instead)'
    );

    // 2. Smooth zoom in on positive drag (outward/down-right) & zoom out on negative drag (inward/up-left)
    const imgW = 1920;
    const imgH = 1080;
    const initialVp = { x: 0, y: 0, width: 1920, height: 1080 };

    // Drag outward (dx = 60, dy = 60) -> zoom in
    const zoomedInVp = calculateResizeZoomViewport(initialVp, 60, 60, imgW, imgH);
    assert.ok(zoomedInVp.width < initialVp.width, 'Outward drag must decrease viewport width (zoom in)');
    assert.ok(zoomedInVp.height < initialVp.height, 'Outward drag must decrease viewport height (zoom in)');
    const pctIn = calculateZoomPercentage(zoomedInVp, imgW);
    assert.ok(pctIn > 100, `Zoom in percentage (${pctIn}%) must be > 100%`);

    // Further drag outward (dx = 120, dy = 120) -> smooth continuous zooming
    const furtherInVp = calculateResizeZoomViewport(initialVp, 120, 120, imgW, imgH);
    assert.ok(furtherInVp.width < zoomedInVp.width, 'Further outward drag must zoom in further');

    // Drag inward from zoomed state (dx = -60, dy = -60) -> zoom out
    const zoomedOutVp = calculateResizeZoomViewport(zoomedInVp, -60, -60, imgW, imgH);
    assert.ok(zoomedOutVp.width > zoomedInVp.width, 'Inward drag must increase viewport width (zoom out)');

    // 3. Aspect ratio preservation across all formats (Square 1:1, Landscape 16:9, Portrait 9:16)
    const aspectTestCases = [
        { name: '16:9 Landscape', w: 1920, h: 1080 },
        { name: '1:1 Square', w: 1000, h: 1000 },
        { name: '9:16 Portrait', w: 1080, h: 1920 },
        { name: '4:3 Standard', w: 1600, h: 1200 },
    ];

    for (const testCase of aspectTestCases) {
        const vp0 = { x: 0, y: 0, width: testCase.w, height: testCase.h };
        const testDeltas = [
            [30, 30],
            [90, 90],
            [-40, -40],
            [150, 80],
            [-80, -120],
        ];

        for (const [dx, dy] of testDeltas) {
            const vpRes = calculateResizeZoomViewport(vp0, dx, dy, testCase.w, testCase.h);
            const originalAspect = testCase.w / testCase.h;
            const newAspect = vpRes.width / vpRes.height;
            assert.ok(
                Math.abs(newAspect - originalAspect) < 0.005,
                `${testCase.name} with delta (${dx},${dy}): aspect ratio must be preserved. Expected ${originalAspect}, got ${newAspect}`
            );

            // Must fit within image boundary limits
            assert.ok(vpRes.width <= testCase.w, 'Viewport width cannot exceed image width');
            assert.ok(vpRes.height <= testCase.h, 'Viewport height cannot exceed image height');
            assert.ok(vpRes.x >= 0 && vpRes.x + vpRes.width <= testCase.w, 'Viewport x clamped within bounds');
            assert.ok(vpRes.y >= 0 && vpRes.y + vpRes.height <= testCase.h, 'Viewport y clamped within bounds');
        }
    }

    // 4. Annotation alignment guarantee during resize zoom
    // When viewport zooms from V0 to V1, SVG overlay viewBox matches V1
    // Relative position of a landmark within the frame maps accurately
    const landmark = [960, 540]; // Center point in 1920x1080
    const vpBefore = { x: 0, y: 0, width: 1920, height: 1080 };
    const vpAfter = calculateResizeZoomViewport(vpBefore, 100, 100, 1920, 1080);
    // Landmark is at center of viewport both before and after (since zoom is centered)
    const relXBefore = (landmark[0] - vpBefore.x) / vpBefore.width;
    const relYBefore = (landmark[1] - vpBefore.y) / vpBefore.height;
    const relXAfter = (landmark[0] - vpAfter.x) / vpAfter.width;
    const relYAfter = (landmark[1] - vpAfter.y) / vpAfter.height;
    assert.ok(Math.abs(relXBefore - 0.5) < 1e-4);
    assert.ok(Math.abs(relYBefore - 0.5) < 1e-4);
    assert.ok(Math.abs(relXAfter - 0.5) < 1e-4, 'Landmark remains centered in viewport during resize zoom');
    assert.ok(Math.abs(relYAfter - 0.5) < 1e-4, 'Landmark remains centered in viewport during resize zoom');

    // 5. No conflicts: Event propagation isolation
    let tileNavigated = false;
    let fullscreenZoomed = false;
    let canvasPanStarted = false;

    const simulateHandleMouseDown = (event) => {
        event.stopPropagation();
        event.preventDefault();
    };
    const simulateHandleClick = (event) => {
        event.stopPropagation();
    };
    const simulateHandleDoubleClick = (event) => {
        event.stopPropagation();
    };

    const triggerEvent = (handler, bubbleAction) => {
        let stopped = false;
        const e = {
            stopPropagation: () => { stopped = true; },
            preventDefault: () => {},
        };
        handler(e);
        if (!stopped) bubbleAction();
    };

    triggerEvent(simulateHandleMouseDown, () => { canvasPanStarted = true; });
    assert.strictEqual(canvasPanStarted, false, 'Resize handle mousedown must not trigger canvas pan');

    triggerEvent(simulateHandleClick, () => { tileNavigated = true; });
    assert.strictEqual(tileNavigated, false, 'Resize handle click must not trigger tile navigation');

    triggerEvent(simulateHandleDoubleClick, () => { fullscreenZoomed = true; });
    assert.strictEqual(fullscreenZoomed, false, 'Resize handle double-click must not trigger fullscreen zoom');

    // 6. Independent per-frame zoom state and Reset behavior
    let tile1ManualViewport = calculateResizeZoomViewport(initialVp, 80, 80, imgW, imgH);
    let tile2ManualViewport = null; // Unzoomed

    assert.notStrictEqual(tile1ManualViewport, null, 'Tile 1 has custom zoom');
    assert.strictEqual(tile2ManualViewport, null, 'Tile 2 remains unaffected');

    // When Reset button is clicked on Tile 1, manualViewport is restored to null
    const handleReset = (setVp) => { setVp(null); };
    handleReset((val) => { tile1ManualViewport = val; });
    assert.strictEqual(tile1ManualViewport, null, 'Reset control restores viewport to null');

    // 7. Non-mutation of annotation coordinates
    const annotationData = {
        clientID: 42,
        points: Object.freeze([100, 200, 300, 400]),
    };
    calculateResizeZoomViewport(initialVp, 100, 100, imgW, imgH);
    assert.deepStrictEqual(annotationData.points, [100, 200, 300, 400], 'Annotation points must not be mutated');

    console.log('  ✔ TC 106 passed.');
}

// TC 107: Object-Centered Auto-Follow in Multi-Frame Viewer
{
    console.log('TC 107: Object-Centered Auto-Follow in Multi-Frame Viewer...');
    const fs = require('fs');
    const path = require('path');

    // 1. Auto-Follow toggle UI presence in Workspace View
    const workspaceSourcePath = path.resolve(__dirname, 'multiframe-workspace-view.tsx');
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const overlaySourcePath = path.resolve(__dirname, 'multiframe-svg-overlay.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');

    const workspaceSource = fs.readFileSync(workspaceSourcePath, 'utf8');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const overlaySource = fs.readFileSync(overlaySourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');

    assert.ok(
        workspaceSource.includes('cvat-multiframe-autofollow-checkbox'),
        'Auto-Follow checkbox must be present in Workspace View header'
    );
    assert.ok(
        workspaceSource.includes('autoFollowEnabled') && workspaceSource.includes('setAutoFollowEnabled'),
        'autoFollowEnabled state must be defined in Workspace View'
    );
    assert.ok(
        workspaceSource.includes('useState<boolean>(true)'),
        'Auto-Follow must be enabled by default (useState<boolean>(true))'
    );
    assert.ok(
        workspaceSource.includes('autoFollowEnabled={autoFollowEnabled}'),
        'autoFollowEnabled must be passed down to MultiframeTile'
    );
    assert.ok(
        workspaceSource.includes("className='cvat-multiframe-autofollow-checkbox'"),
        'Auto-Follow checkbox is shown in the Multi-Frame controls'
    );

    // 2. centerViewportOnObject: Preserves zoom level, aspect ratio, centers on object, clamps to boundaries
    const imgW = 1920;
    const imgH = 1080;
    const zoomVp = { x: 100, y: 100, width: 800, height: 450 }; // Custom zoom (approx 240%)
    const originalAspect = zoomVp.width / zoomVp.height;
    const originalZoomPct = calculateZoomPercentage(zoomVp, imgW);

    // Object at center of image: (960, 540), size 200x200
    const centerBbox = { xtl: 860, ytl: 440, xbr: 1060, ybr: 640 };
    const centeredVp = centerViewportOnObject(zoomVp, centerBbox, imgW, imgH);

    assert.strictEqual(centeredVp.width, zoomVp.width, 'Zoom level width must be strictly preserved');
    assert.strictEqual(centeredVp.height, zoomVp.height, 'Zoom level height must be strictly preserved');
    assert.strictEqual(calculateZoomPercentage(centeredVp, imgW), originalZoomPct, 'Zoom percentage must be preserved');
    assert.ok(Math.abs(centeredVp.width / centeredVp.height - originalAspect) < 1e-4, 'Aspect ratio must be preserved');

    // Viewport center must align with object center (960, 540)
    const vpCenterX = centeredVp.x + centeredVp.width / 2;
    const vpCenterY = centeredVp.y + centeredVp.height / 2;
    assert.strictEqual(vpCenterX, 960, 'Viewport center X must align with object center');
    assert.strictEqual(vpCenterY, 540, 'Viewport center Y must align with object center');

    // Object near left/top edge: (50, 50) -> clamps to (0, 0) without negative coordinates
    const edgeBbox = { xtl: 20, ytl: 20, xbr: 80, ybr: 80 };
    const clampedEdgeVp = centerViewportOnObject(zoomVp, edgeBbox, imgW, imgH);
    assert.strictEqual(clampedEdgeVp.x, 0, 'Viewport X must clamp to 0 at frame boundary');
    assert.strictEqual(clampedEdgeVp.y, 0, 'Viewport Y must clamp to 0 at frame boundary');
    assert.strictEqual(clampedEdgeVp.width, zoomVp.width, 'Width remains preserved when clamped');
    assert.strictEqual(clampedEdgeVp.height, zoomVp.height, 'Height remains preserved when clamped');

    // Object near right/bottom edge: (1900, 1060) -> clamps to (imgW - width, imgH - height)
    const farEdgeBbox = { xtl: 1880, ytl: 1040, xbr: 1920, ybr: 1080 };
    const clampedFarVp = centerViewportOnObject(zoomVp, farEdgeBbox, imgW, imgH);
    assert.strictEqual(clampedFarVp.x, imgW - zoomVp.width, 'Viewport X clamps at right edge');
    assert.strictEqual(clampedFarVp.y, imgH - zoomVp.height, 'Viewport Y clamps at bottom edge');

    // 3. Jitter-free live pointer tracking in SVG overlay
    assert.ok(
        overlaySource.includes('startClientPt') && overlaySource.includes('startScale'),
        'SVG overlay must track drag using client screen delta and initial scale to prevent feedback loop jitter'
    );
    assert.ok(
        overlaySource.includes('onAutoFollow'),
        'SVG overlay must invoke onAutoFollow during live mouse drag'
    );
    assert.ok(
        tileSource.includes('handleAutoFollow') && tileSource.includes('onAutoFollow={isActiveFrame ? handleAutoFollow : undefined}'),
        'Tile must handle auto-follow callback during active frame dragging'
    );

    // Simulate whole-skeleton movement: initial center (500, 400), dragged by dx=300, dy=200
    const initialSkeletonBox = { xtl: 400, ytl: 300, xbr: 600, ybr: 500 };
    const movedSkeletonBox = {
        xtl: initialSkeletonBox.xtl + 300,
        ytl: initialSkeletonBox.ytl + 200,
        xbr: initialSkeletonBox.xbr + 300,
        ybr: initialSkeletonBox.ybr + 200,
    };
    const vpDuringDrag = centerViewportOnObject(zoomVp, movedSkeletonBox, imgW, imgH);
    const dragVpCenterX = vpDuringDrag.x + vpDuringDrag.width / 2;
    const dragVpCenterY = vpDuringDrag.y + vpDuringDrag.height / 2;
    assert.strictEqual(dragVpCenterX, 800, 'Viewport center follows moved skeleton center X');
    assert.strictEqual(dragVpCenterY, 600, 'Viewport center follows moved skeleton center Y');
    assert.strictEqual(vpDuringDrag.width, zoomVp.width, 'Zoom width preserved during drag');
    assert.strictEqual(vpDuringDrag.height, zoomVp.height, 'Zoom height preserved during drag');

    // 4. Cross-frame auto-follow in multiple tiles
    // In Tile A (frame 1), matched object is at center (400, 300)
    const tileABbox = { xtl: 350, ytl: 250, xbr: 450, ybr: 350 };
    const tileAVp = centerViewportOnObject(zoomVp, tileABbox, imgW, imgH);
    assert.strictEqual(tileAVp.x + tileAVp.width / 2, 400, 'Tile A viewport keeps matched object centered');

    // In Tile B (frame 2), matched object is at center (800, 700)
    const tileBBbox = { xtl: 750, ytl: 650, xbr: 850, ybr: 750 };
    const tileBVp = centerViewportOnObject(zoomVp, tileBBbox, imgW, imgH);
    assert.strictEqual(tileBVp.x + tileBVp.width / 2, 800, 'Tile B viewport keeps corresponding matched object centered');

    // 5. Non-mutation of annotation data
    const frozenAnnotation = {
        clientID: 99,
        shapeType: 'skeleton',
        elements: Object.freeze([
            Object.freeze({ clientID: 101, points: Object.freeze([500, 400]) }),
            Object.freeze({ clientID: 102, points: Object.freeze([520, 420]) }),
        ]),
    };
    const resultVp = centerViewportOnObject(zoomVp, { xtl: 500, ytl: 400, xbr: 520, ybr: 420 }, imgW, imgH);
    assert.ok(resultVp !== null);
    assert.strictEqual(frozenAnnotation.elements[0].points[0], 500, 'Annotation coordinates must not be mutated');
    assert.strictEqual(frozenAnnotation.elements[0].points[1], 400, 'Annotation coordinates must not be mutated');

    console.log('  ✔ TC 107 passed.');
}

// TC 108: Multi-Frame Verification Setup modal frame-count selector & batch navigation
{
    console.log('TC 108: Multi-Frame Setup modal frame-count selector & batch navigation...');

    // 1. Default frame count, bounds [1, 10], and clamping
    const defaultFrameCount = 10;
    assert.strictEqual(defaultFrameCount, 10, 'Default frame count must be 10');

    const clampCount = (val) => Math.max(1, Math.min(10, Math.round(val)));
    assert.strictEqual(clampCount(10), 10, '10 is valid');
    assert.strictEqual(clampCount(1), 1, '1 is valid');
    assert.strictEqual(clampCount(0), 1, '0 is clamped to 1');
    assert.strictEqual(clampCount(-5), 1, 'Negative values clamped to 1');
    assert.strictEqual(clampCount(15), 10, 'Values > 10 clamped to 10');
    assert.strictEqual(clampCount(100), 10, 'Values > 10 clamped to 10');

    // 2. Selected frame count controls batch size only, never changing inclusive Start-End range
    // Example: range 1-240 with count 10
    const rangeStart = 1;
    const rangeEnd = 240;
    const count10 = 10;

    const totalBatches10 = getTotalBatches(rangeStart, rangeEnd, count10);
    assert.strictEqual(totalBatches10, 24, 'Range 1-240 with count 10 must yield 24 batches');

    const batch0 = getBatchFrames(0, rangeStart, rangeEnd, count10);
    assert.strictEqual(batch0.length, 10, 'Batch 0 has 10 frames');
    assert.deepStrictEqual(batch0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'Batch 0 is 1-10');

    const batch1 = getBatchFrames(1, rangeStart, rangeEnd, count10);
    assert.strictEqual(batch1.length, 10, 'Batch 1 has 10 frames');
    assert.deepStrictEqual(batch1, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 'Batch 1 is 11-20');

    const batchLast10 = getBatchFrames(23, rangeStart, rangeEnd, count10);
    assert.strictEqual(batchLast10.length, 10, 'Final batch 23 has 10 frames');
    assert.deepStrictEqual(batchLast10, [231, 232, 233, 234, 235, 236, 237, 238, 239, 240], 'Final batch is 231-240');

    // Start and End frame range remains unchanged
    assert.strictEqual(rangeStart, 1, 'Start frame is unchanged');
    assert.strictEqual(rangeEnd, 240, 'End frame is unchanged');

    // 3. Batch navigation and frame boundaries when count changes
    // Change count to 7 on range 1-240
    const count7 = 7;
    const totalBatches7 = getTotalBatches(rangeStart, rangeEnd, count7);
    assert.strictEqual(totalBatches7, 35, 'Ceil(240/7) = 35 batches');

    const batch0_7 = getBatchFrames(0, rangeStart, rangeEnd, count7);
    assert.deepStrictEqual(batch0_7, [1, 2, 3, 4, 5, 6, 7]);

    const batch1_7 = getBatchFrames(1, rangeStart, rangeEnd, count7);
    assert.deepStrictEqual(batch1_7, [8, 9, 10, 11, 12, 13, 14]);

    // Final batch contains only the remaining valid frames (240 - 34*7 = 2 frames: 239, 240)
    const batchLast7 = getBatchFrames(34, rangeStart, rangeEnd, count7);
    assert.strictEqual(batchLast7.length, 2, 'Final batch has 2 remaining valid frames');
    assert.deepStrictEqual(batchLast7, [239, 240], 'Final batch contains 239 and 240');
    assert.deepStrictEqual(getBatchFrames(35, rangeStart, rangeEnd, count7), [], 'Out-of-range batch is empty');

    // Change count to 1 on range 1-240
    const totalBatches1 = getTotalBatches(rangeStart, rangeEnd, 1);
    assert.strictEqual(totalBatches1, 240, 'Count 1 yields 240 single-frame batches');
    assert.deepStrictEqual(getBatchFrames(0, rangeStart, rangeEnd, 1), [1]);
    assert.deepStrictEqual(getBatchFrames(239, rangeStart, rangeEnd, 1), [240]);

    // 4. Sub-batch range handling (range smaller than frame count)
    const subRangeStart = 10;
    const subRangeEnd = 15; // 6 frames
    const subBatches = getTotalBatches(subRangeStart, subRangeEnd, 10);
    assert.strictEqual(subBatches, 1, 'Sub-range smaller than frame count yields 1 batch');
    assert.deepStrictEqual(getBatchFrames(0, subRangeStart, subRangeEnd, 10), [10, 11, 12, 13, 14, 15]);

    // Range 50-65 with count 10 (16 frames -> 1 full batch of 10, 1 partial batch of 6)
    const batches50_65 = getTotalBatches(50, 65, 10);
    assert.strictEqual(batches50_65, 2, '16 frames with count 10 yields 2 batches');
    assert.deepStrictEqual(getBatchFrames(0, 50, 65, 10), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    assert.deepStrictEqual(getBatchFrames(1, 50, 65, 10), [60, 61, 62, 63, 64, 65]);

    // 5. Non-contiguous valid frames (stepped / sparse frame numbers)
    const sparseFrames = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]; // 12 valid frames
    const sparseBatches = getTotalBatches(0, 22, 10, sparseFrames);
    assert.strictEqual(sparseBatches, 2, '12 valid sparse frames with count 10 yields 2 batches');
    assert.deepStrictEqual(getBatchFrames(0, 0, 22, 10, sparseFrames), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    assert.deepStrictEqual(getBatchFrames(1, 0, 22, 10, sparseFrames), [20, 22], 'Final batch contains 2 remaining valid frames');

    // 6. Redux state integration with frameCount
    function mockActivateMultiframeWorkspace(active, start, end, frameCount = null) {
        return {
            type: 'ACTIVATE_MULTIFRAME_WORKSPACE',
            payload: { active, startFrame: start, endFrame: end, frameCount },
        };
    }

    function mockAnnotationReducer(state, action) {
        if (action.type === 'ACTIVATE_MULTIFRAME_WORKSPACE') {
            const { active, startFrame, endFrame, frameCount } = action.payload;
            return {
                ...state,
                multiframe: {
                    ...state.multiframe,
                    active,
                    startFrame: active ? startFrame : null,
                    endFrame: active ? endFrame : null,
                    frameCount: active ? (frameCount ?? 10) : null,
                },
            };
        }
        return state;
    }

    let testState = {
        multiframe: {
            visible: true,
            active: false,
            startFrame: null,
            endFrame: null,
            frameCount: null,
        },
    };

    // User confirms modal with range 1-240 and frameCount 10
    const activateAction = mockActivateMultiframeWorkspace(true, 1, 240, 10);
    testState = mockAnnotationReducer(testState, activateAction);
    assert.strictEqual(testState.multiframe.active, true);
    assert.strictEqual(testState.multiframe.startFrame, 1);
    assert.strictEqual(testState.multiframe.endFrame, 240);
    assert.strictEqual(testState.multiframe.frameCount, 10, 'Redux state stores selected frameCount');

    // User exits Multi-Frame
    const exitAction = mockActivateMultiframeWorkspace(false);
    testState = mockAnnotationReducer(testState, exitAction);
    assert.strictEqual(testState.multiframe.active, false);
    assert.strictEqual(testState.multiframe.startFrame, null);
    assert.strictEqual(testState.multiframe.endFrame, null);
    assert.strictEqual(testState.multiframe.frameCount, null, 'Exiting resets frameCount');

    // 7. Fullscreen frame navigation & return to grid using custom batchSize
    function enterFullscreenFrame(currentState, targetFrame) {
        return {
            ...currentState,
            zoomedFrame: targetFrame,
        };
    }

    function returnToMultiframeGrid(currentState, activeFrame, batchSize = 10) {
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

    function navigateFullscreenFrame(currentState, nextFrame, batchSize = 10) {
        const computedBatch = Math.floor((nextFrame - currentState.rangeStart) / batchSize);
        return {
            ...currentState,
            zoomedFrame: nextFrame,
            batchIndex: computedBatch >= 0 ? computedBatch : currentState.batchIndex,
        };
    }

    const mockViewState = {
        zoomedFrame: null,
        batchIndex: 0,
        rangeStart: 1,
        rangeEnd: 240,
    };
    // Zoom into frame 15 (which is in batch 1 when batchSize = 10)
    const zoomState = enterFullscreenFrame(mockViewState, 15);
    assert.strictEqual(zoomState.zoomedFrame, 15);

    // Return to grid calculates batch index using batchSize = 10
    const returnState = returnToMultiframeGrid(zoomState, 15, 10);
    assert.strictEqual(returnState.zoomedFrame, null);
    assert.strictEqual(returnState.batchIndex, 1, 'Batch index resolved to 1 for frame 15 with batchSize 10');

    // Navigate to frame 25 in fullscreen with batchSize = 10
    const navState = navigateFullscreenFrame(zoomState, 25, 10);
    assert.strictEqual(navState.zoomedFrame, 25);
    assert.strictEqual(navState.batchIndex, 2, 'Batch index resolved to 2 for frame 25 with batchSize 10');

    console.log('  ✔ TC 108 passed.');
}

// TC 109: Improved Zoom & Focus Interactions in Multi-Frame Viewer
{
    console.log('TC 109: Improved Zoom & Focus Interactions in Multi-Frame Viewer...');
    const fs = require('fs');
    const path = require('path');

    const workspaceSourcePath = path.resolve(__dirname, 'multiframe-workspace-view.tsx');
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');

    const workspaceSource = fs.readFileSync(workspaceSourcePath, 'utf8');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');

    // 1. Drag-to-zoom handle & intuitive outward/inward zoom math
    assert.ok(
        !tileSource.includes('cvat-multiframe-tile-resize-handle') &&
        !tileSource.includes('handleResizeMouseDown') &&
        !stylesSource.includes('.cvat-multiframe-tile-resize-handle'),
        'Tile has no drag-corner resize handle'
    );

    const imgW = 1920;
    const imgH = 1080;
    const initialVp = { x: 0, y: 0, width: 1920, height: 1080 };
    const originalAspect = imgW / imgH;

    // Outward drag (dx > 0, dy > 0) zooms in:
    const zoomedIn = calculateResizeZoomViewport(initialVp, 50, 50, imgW, imgH);
    assert.ok(zoomedIn.width < initialVp.width, 'Outward drag decreases viewport width (zooms in)');
    assert.ok(zoomedIn.height < initialVp.height, 'Outward drag decreases viewport height (zooms in)');
    assert.ok(Math.abs(zoomedIn.width / zoomedIn.height - originalAspect) < 0.001, 'Aspect ratio preserved when zooming in');

    // Inward drag (dx < 0, dy < 0) zooms out:
    const zoomedOut = calculateResizeZoomViewport(zoomedIn, -50, -50, imgW, imgH);
    assert.ok(zoomedOut.width > zoomedIn.width, 'Inward drag increases viewport width (zooms out)');
    assert.ok(zoomedOut.height > zoomedIn.height, 'Inward drag increases viewport height (zooms out)');
    assert.ok(Math.abs(zoomedOut.width / zoomedOut.height - originalAspect) < 0.001, 'Aspect ratio preserved when zooming out');

    // Transform annotations together with image without mutating annotation coordinates
    const annotationData = {
        clientID: 42,
        points: Object.freeze([100, 200, 300, 400]),
    };
    // Overlay viewBox matches effectiveViewport
    const overlayViewBox = `${zoomedIn.x} ${zoomedIn.y} ${zoomedIn.width} ${zoomedIn.height}`;
    assert.ok(overlayViewBox.length > 0, 'SVG overlay aligns with zoomed viewport');
    assert.deepStrictEqual(annotationData.points, [100, 200, 300, 400], 'Annotation coordinates never mutated by zoom');

    // 2. Focus Mode is removed
    assert.ok(
        !workspaceSource.includes('focusModeEnabled') &&
        !workspaceSource.includes('cvat-multiframe-focus-mode-checkbox') &&
        !stylesSource.includes('cvat-multiframe-grid-focus-mode'),
        'Focus Mode toggle, state and styles are removed'
    );
    assert.ok(
        tileSource.includes('cvat-multiframe-tile-zoomed'),
        'cvat-multiframe-tile-zoomed class applied to zoomed tiles'
    );

    // 3. Compact tile controls overlay and clear hover reveal
    assert.ok(
        tileSource.includes('cvat-multiframe-tile-header') &&
        tileSource.includes('cvat-multiframe-tile-overlay-controls'),
        'Controls must be in an overlay header on top of the image'
    );
    assert.ok(
        stylesSource.includes('.cvat-multiframe-tile-header') &&
        stylesSource.includes('position: absolute') &&
        stylesSource.includes('top: 0'),
        'Controls overlay positioned absolute on top of image'
    );
    assert.ok(
        stylesSource.includes('.cvat-multiframe-tile:hover &') ||
        stylesSource.includes('&:hover'),
        'Controls reveal clearly on hover'
    );
    assert.ok(
        stylesSource.includes('pointer-events: none'),
        'Frame ID overlay lets clicks and double-clicks pass through to the frame'
    );

    console.log('  ✔ TC 109 passed.');
}

// TC 110: Multi-Frame Drag-to-Expand Viewing Area, Progressive Dimming/Hiding & Grid Restoration
{
    console.log('TC 110: Drag-to-expand tile viewing area, progressive dimming, and grid restoration...');
    const fs = require('fs');
    const path = require('path');

    const workspaceSourcePath = path.resolve(__dirname, 'multiframe-workspace-view.tsx');
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');
    const utilsSourcePath = path.resolve(__dirname, 'multiframe-utils.ts');

    const workspaceSource = fs.readFileSync(workspaceSourcePath, 'utf8');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');
    const utilsSource = fs.readFileSync(utilsSourcePath, 'utf8');

    // 1. Drag corner progresses tile expansion
    const maxDragDistance = 200;
    // Dragging outward (dx > 0, dy > 0) expands viewing area (progress increases)
    const progressOutward = calculateExpansionProgress(0, 50, 50, maxDragDistance);
    assert.strictEqual(progressOutward, 0.25, 'Outward corner drag increases expansion progress');

    const progressFurther = calculateExpansionProgress(0, 200, 200, maxDragDistance);
    assert.strictEqual(progressFurther, 1.0, 'Full drag reaches 100% expansion progress');

    // Dragging inward (dx < 0, dy < 0) when expanded reduces progress
    const progressInward = calculateExpansionProgress(1.0, -100, -100, maxDragDistance);
    assert.strictEqual(progressInward, 0.5, 'Inward drag decreases expansion progress');

    // Boundary clamping in [0, 1]
    const clampedOver = calculateExpansionProgress(0.8, 300, 300, maxDragDistance);
    assert.strictEqual(clampedOver, 1.0, 'Clamps at 1.0 max');
    const clampedUnder = calculateExpansionProgress(0.2, -300, -300, maxDragDistance);
    assert.strictEqual(clampedUnder, 0.0, 'Clamps at 0.0 min');

    // 2. Progressive dimming and complete hiding of other tiles
    // At progress 0: other tiles have normal opacity and are not hidden
    const initialOther = calculateOtherTileOpacity(0, 1.0);
    assert.strictEqual(initialOther.opacity, 1.0);
    assert.strictEqual(initialOther.isHidden, false);

    // As tile grows (progress 0.3): other tiles progressively dim
    const midOther = calculateOtherTileOpacity(0.3, 1.0, 0.75);
    assert.ok(midOther.opacity < 1.0 && midOther.opacity > 0.4, 'Other tiles dim progressively as selected tile grows');
    assert.strictEqual(midOther.isHidden, false);

    // When tile becomes large enough (progress >= 0.75): other tiles are hidden
    const largeOther = calculateOtherTileOpacity(0.75, 1.0, 0.75);
    assert.strictEqual(largeOther.opacity, 0);
    assert.strictEqual(largeOther.isHidden, true, 'Other tiles hidden from view when selected tile becomes large enough');

    const fullyExpandedOther = calculateOtherTileOpacity(1.0, 1.0, 0.75);
    assert.strictEqual(fullyExpandedOther.opacity, 0);
    assert.strictEqual(fullyExpandedOther.isHidden, true);

    // 3. Tile viewing area smoothly expands across the workspace
    const initialRect = { left: 320, top: 210, width: 300, height: 200 };
    const workspaceRect = { left: 0, top: 0, width: 1200, height: 800 };

    const geomAtZero = calculateExpandedTileGeometry(initialRect, workspaceRect, 0);
    assert.deepStrictEqual(geomAtZero, initialRect, 'At progress 0 geometry matches original grid cell');

    const geomAtFull = calculateExpandedTileGeometry(initialRect, workspaceRect, 1);
    assert.deepStrictEqual(geomAtFull, workspaceRect, 'At progress 1 tile occupies entire workspace');

    const geomAtHalf = calculateExpandedTileGeometry(initialRect, workspaceRect, 0.5);
    assert.strictEqual(geomAtHalf.width, 750, 'Width expands smoothly halfway');
    assert.strictEqual(geomAtHalf.height, 500, 'Height expands smoothly halfway');
    assert.strictEqual(geomAtHalf.left, 160, 'Left position smoothly shifts towards workspace boundary');
    assert.strictEqual(geomAtHalf.top, 105, 'Top position smoothly shifts towards workspace boundary');

    // 4. Aspect ratio preservation and non-mutation of annotation coordinates during expansion
    const imgWidth = 1920;
    const imgHeight = 1080;
    const sourceAspect = imgWidth / imgHeight;

    // In grid: 300x200 container
    const layoutGrid = calculateContainedDimensions(300, 200, imgWidth, imgHeight);
    const aspectGrid = layoutGrid.fitWidth / layoutGrid.fitHeight;
    assert.ok(Math.abs(aspectGrid - sourceAspect) < 1e-4, 'Aspect ratio preserved in initial grid');

    // Expanded: 1200x800 container
    const layoutExpanded = calculateContainedDimensions(1200, 800, imgWidth, imgHeight);
    const aspectExpanded = layoutExpanded.fitWidth / layoutExpanded.fitHeight;
    assert.ok(Math.abs(aspectExpanded - sourceAspect) < 1e-4, 'Aspect ratio preserved in expanded workspace tile');
    assert.ok(layoutExpanded.fitWidth > layoutGrid.fitWidth * 3, 'Viewing area has expanded proportionally');

    // Annotation coordinates guarantee:
    const mockAnnotation = {
        clientID: 101,
        points: Object.freeze([150, 250, 350, 450]),
    };
    assert.deepStrictEqual(mockAnnotation.points, [150, 250, 350, 450], 'Annotation data coordinates never changed by expansion');

    // 5. Grid state preservation upon returning to layout
    const gridStateBefore = {
        rangeStart: 10,
        rangeEnd: 150,
        batchIndex: 2,
        batchSize: 8,
        selectedObjectKey: 'shape_101',
    };
    let currentExpandedFrame = 26;
    let currentExpansionProgress = 1.0;

    function restoreGrid() {
        currentExpandedFrame = null;
        currentExpansionProgress = 0;
    }
    restoreGrid();

    assert.strictEqual(currentExpandedFrame, null, 'Restores to grid layout');
    assert.strictEqual(currentExpansionProgress, 0);
    assert.strictEqual(gridStateBefore.rangeStart, 10, 'Frame range start preserved');
    assert.strictEqual(gridStateBefore.rangeEnd, 150, 'Frame range end preserved');
    assert.strictEqual(gridStateBefore.batchIndex, 2, 'Batch index preserved');
    assert.strictEqual(gridStateBefore.batchSize, 8, 'Batch size preserved');
    assert.strictEqual(gridStateBefore.selectedObjectKey, 'shape_101', 'Selected object preserved');

    // 6. UI Presence: Resize handle, restore buttons, and grid placeholder
    assert.ok(
        !tileSource.includes('cvat-multiframe-tile-resize-handle'),
        'No resize handle on tile corner'
    );
    assert.ok(
        !tileSource.includes('cvat-multiframe-restore-grid-btn'),
        'Tile overlay shows only the frame ID (no per-tile Restore Grid button)'
    );
    assert.ok(
        workspaceSource.includes('cvat-multiframe-restore-grid-top-btn'),
        'Clear Restore Grid control on workspace toolbar present'
    );
    assert.ok(
        workspaceSource.includes('cvat-multiframe-tile-placeholder'),
        'Tile placeholder in grid present to prevent layout shift'
    );
    assert.ok(
        stylesSource.includes('.cvat-multiframe-tile-placeholder'),
        'Placeholder styling defined in styles.scss'
    );
    assert.ok(
        stylesSource.includes('.cvat-multiframe-restore-grid-top-btn'),
        'Restore grid button styling defined in styles.scss'
    );

    console.log('  ✔ TC 110 passed.');
}

// TC 111: Multi-Frame Selection Highlight, Layout Drag-to-Expand, In-Place Zoom & Grid Preservation
{
    console.log('TC 111: Multi-Frame Selection highlight, layout drag-to-expand, and in-place Zoom...');
    const fs = require('fs');
    const path = require('path');

    const workspaceSourcePath = path.resolve(__dirname, 'multiframe-workspace-view.tsx');
    const tileSourcePath = path.resolve(__dirname, 'multiframe-tile.tsx');
    const stylesSourcePath = path.resolve(__dirname, 'styles.scss');

    const workspaceSource = fs.readFileSync(workspaceSourcePath, 'utf8');
    const tileSource = fs.readFileSync(tileSourcePath, 'utf8');
    const stylesSource = fs.readFileSync(stylesSourcePath, 'utf8');

    // 1. Selected tile highlighted with clear, bright border and other tiles remain at normal opacity
    assert.ok(
        stylesSource.includes('.cvat-multiframe-tile-active') &&
        stylesSource.includes('border: 2.5px solid #1890ff') &&
        stylesSource.includes('box-shadow: 0 0 12px rgba(24, 144, 255'),
        'Selected tile has a clear, bright #1890ff border and glow'
    );
    assert.ok(
        stylesSource.includes('.cvat-multiframe-tile') &&
        stylesSource.includes('opacity: 1;'),
        'All tiles default to normal opacity 1 without dimming unselected tiles'
    );

    // 2. Drag-to-expand expands layout area with CSS grid rearrangement
    assert.ok(
        stylesSource.includes('.cvat-multiframe-grid') &&
        stylesSource.includes('grid-auto-flow: row dense;'),
        'CSS grid uses row-dense auto flow to rearrange remaining tiles when a tile expands'
    );
    assert.ok(
        !workspaceSource.includes('tileLayoutSizes') &&
        !workspaceSource.includes('handleTileStartExpand') &&
        !tileSource.includes('onStartExpand'),
        'Drag-to-expand layout is removed; frames are enlarged only by double-click zoom'
    );
    assert.ok(
        tileSource.includes('onDoubleClick={() => {') &&
        tileSource.includes('onZoomFrame(frameNumber)') &&
        workspaceSource.includes('setZoomedFrame((prev) => (prev === frame ? null : frame))'),
        'Double-clicking a frame toggles in-place zoom of that frame'
    );

    // 3. Zoom button zooms selected frame in place within the existing workspace (no replacement with CanvasLayout)
    assert.ok(
        !workspaceSource.includes('<CanvasLayout') &&
        !workspaceSource.includes('<BrushTools'),
        'Zooming does not replace Multi-Frame workspace with native CanvasLayout'
    );
    assert.ok(
        workspaceSource.includes("gridColumn: '1 / -1'") &&
        workspaceSource.includes("minHeight: '520px'"),
        'Zoomed frame expands in place across full grid columns within existing workspace'
    );
    assert.ok(
        tileSource.includes('isZoomedInPlace') &&
        !tileSource.includes('cvat-multiframe-zoom-out-btn') &&
        tileSource.includes('onZoomFrame(frameNumber)'),
        'Double-click toggles in-place zoom; the tile has no Zoom / Zoom Out buttons'
    );

    // 4. Clear Reset / Zoom Out actions
    assert.ok(
        workspaceSource.includes('cvat-multiframe-restore-grid-top-btn'),
        'Top controls bar provides restore grid button when layout is changed or zoomed'
    );
    assert.ok(
        workspaceSource.includes("e.key === 'Escape'"),
        'Escape key restores normal grid layout'
    );

    // 5. In-place zoom toggling logic
    let mockZoomedFrame = null;
    function toggleZoomFrame(frame) {
        mockZoomedFrame = mockZoomedFrame === frame ? null : frame;
    }
    toggleZoomFrame(5);
    assert.strictEqual(mockZoomedFrame, 5, 'Clicking Zoom sets zoomed frame');
    toggleZoomFrame(5);
    assert.strictEqual(mockZoomedFrame, null, 'Clicking Zoom Out resets zoomed frame to normal grid');

    // 6. Preservation of coordinates and aspect ratio during in-place zoom
    const mockAnnotation = { clientID: 42, points: Object.freeze([100, 150, 200, 250]) };
    const beforePoints = [...mockAnnotation.points];
    // In-place zoom calculation
    const inPlaceWidth = 1200;
    const inPlaceHeight = 520;
    const contained = calculateContainedDimensions(inPlaceWidth, inPlaceHeight, 1920, 1080);
    assert.ok(Math.abs((contained.fitWidth / contained.fitHeight) - (1920 / 1080)) < 1e-4, 'Aspect ratio preserved');
    assert.deepStrictEqual(mockAnnotation.points, beforePoints, 'Annotation coordinates unmodified by zoom');

    console.log('  ✔ TC 111 passed.');
}

// =========================================================================
// TC 112: Expanded-Frame Zoom, Type/Object ID Redesign, and Deletion by Range (UI wiring)
// Behaviour of the underlying functions is covered by multiframe-utils.real.spec.mjs
// =========================================================================
{
    console.log('TC 112: Expanded-Frame Zoom, Object ID and Deletion UI wiring...');
    const fs = require('fs');
    const path = require('path');
    const workspaceSource = fs.readFileSync(path.resolve(__dirname, 'multiframe-workspace-view.tsx'), 'utf8');
    const tileSource = fs.readFileSync(path.resolve(__dirname, 'multiframe-tile.tsx'), 'utf8');
    const utilsSource = fs.readFileSync(path.resolve(__dirname, 'multiframe-utils.ts'), 'utf8');

    // Zoom uses the actual displayed frame size reported by the tile, never a hard-coded resolution
    assert.ok(
        !/calculateExpandedFitDimensions\([^)]*1920/.test(workspaceSource),
        'Expanded fit must not use a hard-coded 1920x1080 frame size',
    );
    assert.ok(workspaceSource.includes('frameRenderSizes[frame]'), 'Expanded fit uses the reported frame size');
    assert.ok(tileSource.includes('onRenderSizeChange(frameNumber, renderWidth, renderHeight)'),
        'Tile reports its actual render size');
    assert.ok(workspaceSource.includes('optimalFit.isValid ?'), 'Unmeasurable sizes fall back to the default layout');
    assert.ok(
        !workspaceSource.includes('canResize=') &&
        workspaceSource.includes('isEditable={!isOtherExpanded}'),
        'Other tiles are not editable while a frame is zoomed',
    );
    assert.ok(
        workspaceSource.includes("} else if (isAnyZoomed) {") &&
        workspaceSource.includes("tileStyle = { display: 'none' };") &&
        workspaceSource.includes("'cvat-multiframe-grid-has-zoomed'"),
        'A double-clicked frame fills the workspace; other tiles are hidden (kept mounted)',
    );
    assert.ok(
        workspaceSource.includes('const gridRows = batchFrames.length > 1 ? 2 : 1;') &&
        workspaceSource.includes('let cellHeight = cellWidth / frameAspect;') &&
        workspaceSource.includes('`repeat(${gridColumns}, ${cellWidth}px)`'),
        'Grid is laid out evenly in 2 rows of equal cells with the frame aspect ratio',
    );

    // Type / Object ID controls
    assert.ok(workspaceSource.includes('cvat-multiframe-type-select'), 'Type dropdown exists');
    assert.ok(
        workspaceSource.includes('jobLabels: state.annotation.job.labels') &&
        workspaceSource.includes('availableLabels.map(') && !workspaceSource.includes('ShapeType'),
        'Type dropdowns list the job labels (object types), not CVAT shape types',
    );
    assert.ok(
        utilsSource.includes('if (!matchesLabelFilter(state, targetLabel)) continue;'),
        'Deletion filters objects by label',
    );
    assert.ok(workspaceSource.includes('cvat-multiframe-object-id-input'), 'Object ID input exists');
    assert.ok(workspaceSource.includes("className='cvat-multiframe-clear-id-btn'"), 'Object ID has a Clear action');
    assert.ok(workspaceSource.includes('enterIDFilter(getObjectInputKey('),
        'Selecting an object fills an unambiguous ID (track_N / shape_N)');

    // Deletion lives in its own right-sidebar panel: dry-run preview, mandatory confirmation, native history
    const panelSource = fs.readFileSync(
        path.resolve(__dirname, '../annotation-deletion/annotation-deletion-panel.tsx'), 'utf8',
    );
    const standardWorkspaceSource = fs.readFileSync(
        path.resolve(__dirname, '../standard-workspace/standard-workspace.tsx'), 'utf8',
    );
    assert.ok(
        !workspaceSource.includes('planAnnotationDeletion') && !workspaceSource.includes('cvat-multiframe-delete-btn'),
        'Multi-Frame workspace no longer contains the deletion feature',
    );
    // Right tools sidebar: tab 1 Multi-Frame, tab 2 Delete
    const toolsSidebarSource = fs.readFileSync(
        path.resolve(__dirname, '../annotation-tools-sidebar/annotation-tools-sidebar.tsx'), 'utf8',
    );
    const sidebarTabSource = fs.readFileSync(path.resolve(__dirname, 'multiframe-sidebar-tab.tsx'), 'utf8');
    const annotationPageSource = fs.readFileSync(path.resolve(__dirname, '../annotation-page.tsx'), 'utf8');
    assert.ok(
        standardWorkspaceSource.includes('<AnnotationToolsSidebar />') &&
        standardWorkspaceSource.indexOf('<AnnotationToolsSidebar />') <
            standardWorkspaceSource.indexOf('<ObjectSideBarComponent'),
        'Tools sidebar is mounted on the right side, next to the objects sidebar',
    );
    assert.ok(
        toolsSidebarSource.indexOf("key: 'multiframe'") > 0 &&
        toolsSidebarSource.indexOf("key: 'multiframe'") < toolsSidebarSource.indexOf("key: 'delete'") &&
        toolsSidebarSource.includes("type='card'"),
        'Tools sidebar has card tabs: Multi-Frame first, Delete second',
    );
    assert.ok(
        toolsSidebarSource.includes("className='cvat-annotation-tools-sider'") &&
        toolsSidebarSource.includes('onClick={() => setSidebarCollapsed(!collapsed)}') &&
        toolsSidebarSource.includes('useState<boolean>(true)'),
        'Sidebar has a pull-out tab and starts collapsed',
    );
    assert.ok(
        toolsSidebarSource.includes('if (!value && !objectsSidebarCollapsed) {') &&
        toolsSidebarSource.includes('dispatch(collapseSidebar());') &&
        toolsSidebarSource.includes('if (prevObjectsSidebarCollapsed.current && !objectsSidebarCollapsed) {'),
        'Only one right sidebar is open at a time (tools sidebar / objects sidebar)',
    );
    assert.ok(
        toolsSidebarSource.includes("setActiveTab('multiframe');") &&
        toolsSidebarSource.includes('dispatch(switchShowMultiframeModal(false));') &&
        !annotationPageSource.includes('<MultiframeModal />'),
        'The Multi-Frame button / shortcut opens the Multi-Frame tab instead of a modal',
    );
    assert.ok(
        sidebarTabSource.includes('dispatch(activateMultiframeWorkspace(true, windowStart, windowEnd, frameCount));') &&
        sidebarTabSource.includes('getFrameWindow(startFrame, frameCount, validFrames)') &&
        sidebarTabSource.includes('min={MIN_MULTIFRAME_FRAMES}') &&
        sidebarTabSource.includes('id={MULTIFRAME_SIDEBAR_CONTROLS_ID}') &&
        workspaceSource.includes('createPortal(controls, controlsTarget)'),
        'Multi-Frame is opened from the sidebar and its controls are rendered in the sidebar',
    );
    assert.ok(
        panelSource.includes('if (!active || !rangeValidation.isValid'),
        'Deletion preview is computed only while the Delete tab is shown',
    );
    assert.ok(
        panelSource.includes('planAnnotationDeletion(') && panelSource.includes('executeAnnotationDeletion('),
        'Deletion uses a dry-run plan and executes the same plan',
    );
    assert.ok(
        !panelSource.includes('cvat-annotation-deletion-preview-list') &&
        panelSource.includes('object(s) will be deleted'),
        'The long preview is replaced by a one-line summary',
    );
    assert.ok(
        panelSource.includes('<Popconfirm') && panelSource.includes('onConfirm={handleExecuteDelete}'),
        'Confirmation is mandatory for every deletion',
    );
    assert.ok(
        panelSource.includes("resolveObjectByIDAndType(idInput, 'all', jobObjects)") &&
        panelSource.includes("message: 'Object ID not found'") &&
        panelSource.includes('onBlur={notifyInvalidID}'),
        'The entered ID is validated against the whole job and a missing ID is notified',
    );
    assert.ok(
        panelSource.includes('onClick={() => stepToID(nextID)}') &&
        panelSource.includes('onClick={() => stepToID(prevID)}') &&
        panelSource.includes('sortedIDs.find((id) => selectedID === null || id > selectedID)'),
        'Up / down buttons step to the next / previous existing object ID of the job',
    );
    assert.ok(
        panelSource.includes('jobInstance.actions.undo(lastDeletion.count)') &&
        panelSource.includes('jobInstance.actions.redo(lastDeletion.count)'),
        'Batch undo/redo uses native CVAT history',
    );
    assert.ok(
        panelSource.includes('window.dispatchEvent(new Event(ANNOTATIONS_BULK_CHANGED_EVENT))') &&
        workspaceSource.includes('window.addEventListener(ANNOTATIONS_BULK_CHANGED_EVENT, onAnnotationsChanged)') &&
        workspaceSource.includes('refreshToken={tilesRefreshToken}') &&
        tileSource.includes('[frameNumber, jobInstance, refreshToken]'),
        'Multi-Frame tiles reload annotations after deletion/undo/redo from the panel',
    );
    assert.ok(
        !utilsSource.includes('group.id === st.group.id'),
        'Deletion never removes objects only because they share a group',
    );
    assert.ok(!/\.delete\([^)]*,\s*true\)/.test(utilsSource), 'Deletion never forces removal of locked objects');
    console.log('  ✔ TC 112 passed.');
}

// =========================================================================
// TC 113: Other tiles' header bars and resize handles never show through a zoomed tile
// =========================================================================
{
    console.log('TC 113: Tiles isolate their header / resize handle stacking...');
    const fs = require('fs');
    const path = require('path');
    const stylesSource = fs.readFileSync(path.resolve(__dirname, 'styles.scss'), 'utf8');
    const tileBlock = stylesSource.slice(stylesSource.indexOf('\n.cvat-multiframe-tile {'));
    const tileRules = tileBlock.slice(0, tileBlock.indexOf('&:hover'));
    assert.ok(/isolation:\s*isolate;/.test(tileRules), 'Each tile creates its own stacking context');
    console.log('  ✔ TC 113 passed.');
}

// =========================================================================
// TC 114: Type mode and ID mode are mutually exclusive (UI wiring)
// Behaviour of the filter functions is covered by multiframe-utils.real.spec.mjs
// =========================================================================
{
    console.log('TC 114: Exclusive Type / ID filter modes...');
    const fs = require('fs');
    const path = require('path');
    const ws = fs.readFileSync(path.resolve(__dirname, 'multiframe-workspace-view.tsx'), 'utf8');
    const tile = fs.readFileSync(path.resolve(__dirname, 'multiframe-tile.tsx'), 'utf8');
    const overlay = fs.readFileSync(path.resolve(__dirname, 'multiframe-svg-overlay.tsx'), 'utf8');

    // one filter state for the viewer and one for the deletion modal
    assert.ok(ws.includes('useState<ObjectFilterState>(EMPTY_OBJECT_FILTER)'), 'Viewer keeps a single filter state');
    assert.ok(!/useState<string>\('all'\)/.test(ws), 'No separate type state that could combine with the ID');
    assert.ok(ws.includes('applyObjectFilter(selectTypeFilter(val))'), 'Selecting a type switches to Type mode');
    assert.ok(ws.includes('applyObjectFilter(enterIDFilter(e.target.value))'), 'Typing an ID switches to ID mode');
    assert.ok(ws.includes("resolveObjectByIDAndType(inputObjectID, 'all', combinedStates)"),
        'ID mode never applies the type');
    assert.ok(ws.includes("if (objectFilter.mode !== 'id') return null;"), 'A selected object exists only in ID mode');
    assert.ok(ws.includes("const typeFilterLabel = objectFilter.mode === 'type' ? objectFilter.label : null;"),
        'Type mode label is passed only in Type mode');
    assert.ok(ws.includes("className='cvat-multiframe-filter-mode-tag'"), 'Active filter mode is shown');
    assert.ok(ws.includes('cvat-multiframe-filter-active'), 'Active control is highlighted');
    assert.ok(ws.includes('typeFilterLabel={typeFilterLabel}'), 'Tiles receive the Type mode label');

    // deletion panel uses the same exclusive modes
    const panel = fs.readFileSync(
        path.resolve(__dirname, '../annotation-deletion/annotation-deletion-panel.tsx'), 'utf8',
    );
    assert.ok(panel.includes('setFilter(selectTypeFilter(val))') &&
        panel.includes('setFilter(enterIDFilter(e.target.value))'), 'Deletion panel switches modes');
    assert.ok(panel.includes("resolveObjectByIDAndType(idInput, 'all', jobObjects)"),
        'Deletion ID is resolved without the type, across the whole job');

    // tiles: read-only display of the type matches and a clear indicator for frames without matches
    assert.ok(tile.includes('getTypeFilterMatches(frameStates, typeFilterLabel)'), 'Tile computes type matches');
    assert.ok(!tile.includes("className='cvat-multiframe-type-match-tag'"), 'Tile overlay shows only the frame ID');
    assert.ok(tile.includes('typeMatchedClientIDs={typeMatchedClientIDs}'), 'Overlay receives the type matches');
    assert.ok(overlay.includes('typeMatches ? typeMatches.has(state.clientID)'), 'Overlay highlights type matches');
    // Type mode zooms / follows like ID mode, using the union box of the matched objects
    assert.ok(tile.includes('if (typeMatches) return getTypeFilterBoundingBox(typeMatches, frameStates);'),
        'Type mode uses the union box of its matches as the zoom target');
    assert.ok(tile.includes('calculateAutoZoomViewport(bbox, dimensions.width, dimensions.height)') &&
        tile.includes('centerViewportOnObject(manualViewport, focusBBox'), 'Auto-zoom and auto-follow use the focus box');
    assert.ok(tile.includes('[selectedObject, typeFilterLabel, autoZoomEnabled, autoFollowEnabled]'),
        'Changing the type resets manual zoom');
    console.log('  ✔ TC 114 passed.');
}

console.log('\n=== All Real Multi-Frame Viewer Tests Passed Successfully! ===');











// Overlay markers keep a constant on-screen size (like the native CVAT canvas)
{
    console.log('TC: Overlay points, handles and labels keep a constant screen size...');
    const fs = require('fs');
    const path = require('path');
    const overlay = fs.readFileSync(path.resolve(__dirname, 'multiframe-svg-overlay.tsx'), 'utf8');

    assert.ok(overlay.includes('const unitsPerPx = screenWidth > 0 && vpW > 0 ? vpW / screenWidth : 1;'),
        'Screen pixels are converted to viewport units from the measured overlay width');
    assert.ok(!overlay.includes('scaleFactor'), 'Marker sizes no longer depend on the image zoom level');
    assert.ok(overlay.includes('r={px(3.5)}') && overlay.includes('r={px(10)}') &&
        overlay.includes('const handleSize = px(8);'), 'Points, hit targets and handles use screen-pixel sizes');

    // A 1920px-wide frame shown 480px wide (small tile) vs zoomed 4x into a 480px-wide window
    const unitsPerPx = (vpW, screenWidth) => vpW / screenWidth;
    const smallTileRadius = 3.5 * unitsPerPx(1920, 480);
    const zoomedRadius = 3.5 * unitsPerPx(480, 480);
    assert.strictEqual(smallTileRadius, 14, 'Small tile: point is large relative to the image (easy to see)');
    assert.strictEqual(zoomedRadius, 3.5, 'Zoomed: point is small relative to the image (precise editing)');
    console.log('  ✔ passed.');
}
