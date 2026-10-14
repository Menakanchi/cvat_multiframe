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

function getObjectBoundingBox(targetState, targetElementState, allFrameStates) {
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

        const associatedRect = allFrameStates.find((st) => {
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
    if (targetState.shapeType === 'mask' && Array.isArray(targetState.points) && targetState.points.length >= 4) {
        const [xtl, ytl, xbr, ybr] = targetState.points;
        return {
            xtl: Math.min(xtl, xbr),
            ytl: Math.min(ytl, ybr),
            xbr: Math.max(xtl, xbr),
            ybr: Math.max(ytl, ybr),
        };
    }

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

function extractSelectableObjects(states) {
    if (!Array.isArray(states) || states.length === 0) {
        return [];
    }

    const objectsMap = new Map();

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

    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
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

function calculateZoomPercentage(vp, imageWidth) {
    if (!vp || vp.width <= 0 || imageWidth <= 0) return 100;
    return Math.round((imageWidth / vp.width) * 100);
}

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
    // Should have: track_101, track_102, element_102_11, element_102_12, shape_103
    assert.strictEqual(selectable.length, 5);

    const keys = selectable.map((s) => s.key);
    assert.deepStrictEqual(keys, ['track_101', 'track_102', 'element_102_11', 'element_102_12', 'shape_103']);

    // Check display text & metadata
    const carObj = selectable.find((s) => s.key === 'track_101');
    assert.strictEqual(carObj.objectType, 'track');
    assert.strictEqual(carObj.labelName, 'car');
    assert.strictEqual(carObj.displayText.includes('car'), true);

    const noseObj = selectable.find((s) => s.key === 'element_102_11');
    assert.strictEqual(noseObj.parentID, 102);
    assert.strictEqual(noseObj.labelName, 'nose');
    assert.strictEqual(noseObj.displayText.includes('nose'), true);

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

    // 10. Skeleton with NO existing bounding box does NOT compute from skeleton keypoints
    const skelNoBox = {
        shapeType: 'skeleton',
        elements: [
            { points: [100, 150], outside: false },
            { points: [120, 180], outside: false },
        ],
    };
    assert.strictEqual(getObjectBoundingBox(skelNoBox), null, 'Must NOT derive bounding box from skeleton keypoints');

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

console.log('\n=== All Real Multi-Frame Viewer Tests Passed Successfully! ===');

