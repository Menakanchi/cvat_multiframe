// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CombinedState } from 'reducers';
import Tag from 'antd/lib/tag';
import Spin from 'antd/lib/spin';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import { FullscreenOutlined, FullscreenExitOutlined, AppstoreOutlined } from '@ant-design/icons';

import { activateObject, updateAnnotationsAsync } from 'actions/annotation-actions';
import {
    resolveCrossFrameIdentity,
    getObjectBoundingBox,
    resolveSkeletonWrappingBox,
    calculateAutoZoomViewport,
    zoomViewportAtPoint,
    calculateResizeZoomViewport,
    panViewport,
    centerViewportOnObject,
    calculateZoomPercentage,
    calculateContainedDimensions,
    ContainedLayout,
    Viewport,
} from './multiframe-utils';
import MultiframeSvgOverlay from './multiframe-svg-overlay';

interface Props {
    frameNumber: number;
    jobInstance: any;
    isActiveFrame: boolean;
    selectedObject: any | null;
    autoZoomEnabled?: boolean;
    autoFollowEnabled?: boolean;
    isExpanded?: boolean;
    isFullyExpanded?: boolean;
    isZoomedInPlace?: boolean;
    hasCustomLayout?: boolean;
    expansionProgress?: number;
    expandedStyle?: React.CSSProperties;
    otherTileStyle?: React.CSSProperties;
    tileStyle?: React.CSSProperties;
    canResize?: boolean;
    isEditable?: boolean;
    onStartExpand?(frame: number, e: React.MouseEvent, tileEl: HTMLElement): void;
    onRestoreGrid?(): void;
    onResetLayout?(frame: number): void;
    onNavigateToFrame(frame: number): void;
    onZoomFrame?(frame: number): void;
    onFrameStatesLoaded?(frameNumber: number, states: any[]): void;
    onSelectObject?(state: any, elementState?: any): void;
    /** Reports the actual displayed (render) size of the frame, used by the zoom-in-place fit */
    onRenderSizeChange?(frameNumber: number, width: number, height: number): void;
    /** Changing this value reloads the frame annotations (e.g. after deletion, undo or redo) */
    refreshToken?: number;
}

function MultiframeTile(props: Props): JSX.Element {
    const {
        frameNumber,
        jobInstance,
        isActiveFrame,
        selectedObject,
        autoZoomEnabled = true,
        autoFollowEnabled = true,
        isExpanded = false,
        isFullyExpanded = false,
        isZoomedInPlace = false,
        hasCustomLayout = false,
        expansionProgress = 0,
        expandedStyle,
        otherTileStyle,
        tileStyle,
        canResize = true,
        isEditable = true,
        onStartExpand,
        onRestoreGrid,
        onResetLayout,
        onNavigateToFrame,
        onZoomFrame,
        onFrameStatesLoaded,
        onSelectObject,
        onRenderSizeChange,
        refreshToken = 0,
    } = props;

    const dispatch = useDispatch();

    const tileRootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const canvasWrapRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const imageDataRef = useRef<ImageBitmap | Blob | null>(null);

    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [frameStates, setFrameStates] = useState<any[]>([]);
    const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

    const activeFrameStates = useSelector((state: CombinedState) => (
        isActiveFrame ? state.annotation.annotations.states : null
    ));

    // Synchronize frameStates with Redux active annotations state for the active frame (undo/redo, updates)
    useEffect(() => {
        if (isActiveFrame && Array.isArray(activeFrameStates) && activeFrameStates.length > 0) {
            setFrameStates(activeFrameStates);
        }
    }, [isActiveFrame, activeFrameStates]);

    // Independent per-tile manual viewport state (Task B)
    const [manualViewport, setManualViewport] = useState<Viewport | null>(null);
    const [isPanning, setIsPanning] = useState<boolean>(false);
    const panStartRef = useRef<{ clientX: number; clientY: number; startViewport: Viewport } | null>(null);
    const [isResizing, setIsResizing] = useState<boolean>(false);
    const resizeStartRef = useRef<{ clientX: number; clientY: number; startViewport: Viewport } | null>(null);

    useEffect(() => {
        let isCancelled = false;
        setLoading(true);
        setError(null);

        async function loadFrameAndAnnotations(): Promise<void> {
            try {
                if (!jobInstance) {
                    throw new Error('No job instance available');
                }

                // 1. Fetch real frame data from CVAT FrameProvider
                const frameData = await jobInstance.frames.get(frameNumber);
                if (isCancelled) return;

                // 2. Fetch decoded bitmap via CVAT FrameDecoder cache
                const { imageData, renderWidth: fRenderWidth, renderHeight: fRenderHeight } = await frameData.data();
                if (isCancelled) return;

                imageDataRef.current = imageData;
                const width = (imageData as any)?.naturalWidth ||
                    (imageData as any)?.width ||
                    fRenderWidth ||
                    frameData.width ||
                    1920;
                const height = (imageData as any)?.naturalHeight ||
                    (imageData as any)?.height ||
                    fRenderHeight ||
                    frameData.height ||
                    1080;
                setDimensions({ width, height });

                // 3. Fetch actual frame annotations in-memory from AnnotationsCollection
                const states = await jobInstance.annotations.get(frameNumber, true, []);
                if (isCancelled) return;
                setFrameStates(states);
                if (onFrameStatesLoaded) {
                    onFrameStatesLoaded(frameNumber, states);
                }
            } catch (err: any) {
                if (!isCancelled) {
                    setError(err?.message || 'Failed to load frame');
                }
            } finally {
                if (!isCancelled) {
                    setLoading(false);
                }
            }
        }

        loadFrameAndAnnotations();

        return () => {
            isCancelled = true;
        };
    }, [frameNumber, jobInstance, refreshToken]);

    // Reset manual viewport when selected object, auto-zoom, or auto-follow toggle changes
    useEffect(() => {
        setManualViewport(null);
    }, [selectedObject, autoZoomEnabled, autoFollowEnabled]);

    // 4. Pure identity resolution
    const matchResult = useMemo(
        () => resolveCrossFrameIdentity(selectedObject, frameStates),
        [selectedObject, frameStates],
    );

    // Compute associated rectangle clientID for the matched object (if any)
    const matchedRectClientID = useMemo<number | null>(() => {
        if (matchResult.status !== 'MATCHED' || !matchResult.targetState) return null;
        if (matchResult.targetState.shapeType === 'rectangle') {
            return matchResult.targetState.clientID;
        }
        const targetClientID = matchResult.targetState.clientID;
        const targetGroupID = matchResult.targetState.group?.id;
        const associatedRect = frameStates.find((st: any) => {
            if (!st || st.outside || st.shapeType !== 'rectangle') return false;
            if (typeof targetClientID === 'number' && st.clientID === targetClientID) return true;
            if (typeof targetClientID === 'number' && st.parentID === targetClientID) return true;
            if (typeof matchResult.targetState.parentID === 'number' && st.clientID === matchResult.targetState.parentID) return true;
            if (typeof targetGroupID === 'number' && targetGroupID > 0 && st.group?.id === targetGroupID) return true;
            return false;
        });
        return associatedRect ? associatedRect.clientID : null;
    }, [matchResult, frameStates]);

    const matchedSkeletonClientID = useMemo<number | null>(() => {
        if (matchResult.status !== 'MATCHED' || !matchResult.targetState) return null;
        if (matchResult.targetState.shapeType === 'skeleton') {
            return matchResult.targetState.clientID;
        }
        if (typeof matchResult.targetState.parentID === 'number') {
            return matchResult.targetState.parentID;
        }
        const targetGroupID = matchResult.targetState.group?.id;
        if (typeof targetGroupID === 'number' && targetGroupID > 0) {
            const groupedSkeleton = frameStates.find((st: any) => (
                st && !st.outside && st.shapeType === 'skeleton' && st.group?.id === targetGroupID
            ));
            if (groupedSkeleton) return groupedSkeleton.clientID;
        }
        return null;
    }, [matchResult, frameStates]);

    const hasSelection = Boolean(selectedObject);

    // 5. Per-frame auto-zoom / auto-follow viewport calculation
    const targetViewport = useMemo<Viewport>(() => {
        if (
            !selectedObject ||
            matchResult.status !== 'MATCHED' ||
            dimensions.width <= 0 ||
            dimensions.height <= 0
        ) {
            return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
        }

        const bbox = getObjectBoundingBox(matchResult.targetState, matchResult.targetElementState, frameStates);
        if (!bbox) {
            return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
        }

        if (autoZoomEnabled) {
            return calculateAutoZoomViewport(bbox, dimensions.width, dimensions.height);
        }

        if (autoFollowEnabled) {
            return centerViewportOnObject(
                { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
                bbox,
                dimensions.width,
                dimensions.height,
            );
        }

        return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
    }, [autoZoomEnabled, autoFollowEnabled, selectedObject, matchResult, dimensions, frameStates]);

    // Automatically pan manualViewport to follow the matched object when autoFollowEnabled is true
    useEffect(() => {
        if (!autoFollowEnabled || !manualViewport || matchResult.status !== 'MATCHED' || dimensions.width <= 0 || dimensions.height <= 0) {
            return;
        }
        const bbox = getObjectBoundingBox(matchResult.targetState, matchResult.targetElementState, frameStates);
        if (!bbox) return;

        const centeredVp = centerViewportOnObject(manualViewport, bbox, dimensions.width, dimensions.height);
        if (centeredVp.x !== manualViewport.x || centeredVp.y !== manualViewport.y) {
            setManualViewport(centeredVp);
        }
    }, [autoFollowEnabled, frameStates, matchResult, dimensions]);

    // Effective Viewport: Manual zoom/pan overrides targetViewport until reset
    const effectiveViewport = useMemo<Viewport>(() => {
        if (manualViewport) {
            return manualViewport;
        }
        return targetViewport;
    }, [manualViewport, targetViewport]);

    const renderWidth = targetViewport.width > 0 ? (
        effectiveViewport.width > 0 ? effectiveViewport.width : targetViewport.width
    ) : dimensions.width;
    const renderHeight = targetViewport.height > 0 ? (
        effectiveViewport.height > 0 ? effectiveViewport.height : targetViewport.height
    ) : dimensions.height;

    const zoomPct = calculateZoomPercentage(effectiveViewport, dimensions.width);

    // Report the actual displayed frame size so an expanded tile can keep the real aspect ratio
    useEffect(() => {
        if (onRenderSizeChange && renderWidth > 0 && renderHeight > 0) {
            onRenderSizeChange(frameNumber, renderWidth, renderHeight);
        }
    }, [onRenderSizeChange, frameNumber, renderWidth, renderHeight]);

    // Measure available container size for letterbox containment
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);
            if (width > 0 && height > 0) {
                setContainerSize((prev) => (
                    prev.width === width && prev.height === height ? prev : { width, height }
                ));
            }
        };

        updateSize();

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                updateSize();
            });
            ro.observe(el);
            return () => {
                ro.disconnect();
            };
        }

        window.addEventListener('resize', updateSize);
        return () => {
            window.removeEventListener('resize', updateSize);
        };
    }, []);

    // Proportional containment calculation (object-fit: contain)
    const containedLayout = useMemo<ContainedLayout>(() => {
        if (containerSize.width > 0 && containerSize.height > 0 && renderWidth > 0 && renderHeight > 0) {
            return calculateContainedDimensions(
                containerSize.width,
                containerSize.height,
                renderWidth,
                renderHeight,
            );
        }
        return {
            fitWidth: renderWidth,
            fitHeight: renderHeight,
            offsetX: 0,
            offsetY: 0,
            letterboxType: 'none',
            scale: 1,
        };
    }, [containerSize, renderWidth, renderHeight]);

    // 6. Viewport canvas painting (centers and zooms onto target instance with native sharpness)
    useEffect(() => {
        const canvas = canvasRef.current;
        const imageData = imageDataRef.current;
        if (!canvas || !imageData || dimensions.width === 0 || dimensions.height === 0) return;

        canvas.width = renderWidth;
        canvas.height = renderHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, renderWidth, renderHeight);

        const imgWidth = (imageData as any).naturalWidth || (imageData as any).width || dimensions.width;
        const imgHeight = (imageData as any).naturalHeight || (imageData as any).height || dimensions.height;
        const scaleX = dimensions.width > 0 ? imgWidth / dimensions.width : 1;
        const scaleY = dimensions.height > 0 ? imgHeight / dimensions.height : 1;

        const sx = Math.max(0, Math.min(imgWidth, effectiveViewport.x * scaleX));
        const sy = Math.max(0, Math.min(imgHeight, effectiveViewport.y * scaleY));
        const sWidth = Math.max(1, Math.min(imgWidth - sx, effectiveViewport.width * scaleX));
        const sHeight = Math.max(1, Math.min(imgHeight - sy, effectiveViewport.height * scaleY));

        if (imageData instanceof ImageBitmap) {
            ctx.drawImage(
                imageData,
                sx,
                sy,
                sWidth,
                sHeight,
                0,
                0,
                renderWidth,
                renderHeight,
            );
        } else if (imageData instanceof Blob) {
            const img = new Image();
            img.onload = () => {
                if (canvasRef.current) {
                    const cCtx = canvasRef.current.getContext('2d');
                    const bWidth = img.naturalWidth || img.width || dimensions.width;
                    const bHeight = img.naturalHeight || img.height || dimensions.height;
                    const bScaleX = dimensions.width > 0 ? bWidth / dimensions.width : 1;
                    const bScaleY = dimensions.height > 0 ? bHeight / dimensions.height : 1;
                    const bSx = Math.max(0, Math.min(bWidth, effectiveViewport.x * bScaleX));
                    const bSy = Math.max(0, Math.min(bHeight, effectiveViewport.y * bScaleY));
                    const bSWidth = Math.max(1, Math.min(bWidth - bSx, effectiveViewport.width * bScaleX));
                    const bSHeight = Math.max(1, Math.min(bHeight - bSy, effectiveViewport.height * bScaleY));
                    cCtx?.drawImage(
                        img,
                        bSx,
                        bSy,
                        bSWidth,
                        bSHeight,
                        0,
                        0,
                        renderWidth,
                        renderHeight,
                    );
                }
            };
            img.src = URL.createObjectURL(imageData);
        }
    }, [effectiveViewport, renderWidth, renderHeight, dimensions, loading]);

    // Wheel zoom centered at mouse pointer (Task B)
    useEffect(() => {
        const wrap = canvasWrapRef.current;
        if (!wrap) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const rect = wrap.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || dimensions.width <= 0 || dimensions.height <= 0) return;

            const rx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const ry = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

            const focalX = effectiveViewport.x + rx * effectiveViewport.width;
            const focalY = effectiveViewport.y + ry * effectiveViewport.height;

            const factor = e.deltaY < 0 ? 0.8 : 1.25;
            const newVp = zoomViewportAtPoint(
                effectiveViewport,
                factor,
                focalX,
                focalY,
                dimensions.width,
                dimensions.height,
            );
            setManualViewport(newVp);
        };

        wrap.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            wrap.removeEventListener('wheel', onWheel);
        };
    }, [effectiveViewport, dimensions]);

    // Canvas panning handlers (Task B)
    const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
        if (!isActiveFrame) {
            onNavigateToFrame(frameNumber);
        }
        if (e.button !== 0 && e.button !== 1) return;
        setIsPanning(true);
        panStartRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            startViewport: effectiveViewport,
        };
    }, [isActiveFrame, onNavigateToFrame, frameNumber, effectiveViewport]);

    useEffect(() => {
        if (!isPanning) return;

        const onMouseMove = (e: MouseEvent) => {
            if (!panStartRef.current || !canvasWrapRef.current) return;
            const dx = e.clientX - panStartRef.current.clientX;
            const dy = e.clientY - panStartRef.current.clientY;

            const rect = canvasWrapRef.current.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const scaleX = panStartRef.current.startViewport.width / rect.width;
            const scaleY = panStartRef.current.startViewport.height / rect.height;

            const imageDeltaX = -dx * scaleX;
            const imageDeltaY = -dy * scaleY;

            const newVp = panViewport(
                panStartRef.current.startViewport,
                imageDeltaX,
                imageDeltaY,
                dimensions.width,
                dimensions.height,
            );
            setManualViewport(newVp);
        };

        const onMouseUp = () => {
            setIsPanning(false);
            panStartRef.current = null;
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [isPanning, dimensions]);

    // Zoom Buttons Handlers (Task B)
    const handleZoomIn = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (dimensions.width <= 0 || dimensions.height <= 0) return;
        const centerX = effectiveViewport.x + effectiveViewport.width / 2;
        const centerY = effectiveViewport.y + effectiveViewport.height / 2;
        const newVp = zoomViewportAtPoint(effectiveViewport, 0.8, centerX, centerY, dimensions.width, dimensions.height);
        setManualViewport(newVp);
    }, [effectiveViewport, dimensions]);

    const handleZoomOut = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (dimensions.width <= 0 || dimensions.height <= 0) return;
        const centerX = effectiveViewport.x + effectiveViewport.width / 2;
        const centerY = effectiveViewport.y + effectiveViewport.height / 2;
        const newVp = zoomViewportAtPoint(effectiveViewport, 1.25, centerX, centerY, dimensions.width, dimensions.height);
        setManualViewport(newVp);
    }, [effectiveViewport, dimensions]);

    const handleZoomReset = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setManualViewport(null);
    }, []);

    // Drag-to-resize / drag-to-expand handler
    const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button !== 0) return;

        if (onStartExpand && tileRootRef.current) {
            onStartExpand(frameNumber, e, tileRootRef.current);
            return;
        }

        if (dimensions.width <= 0 || dimensions.height <= 0) return;

        setIsResizing(true);
        resizeStartRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            startViewport: { ...effectiveViewport },
        };
    }, [onStartExpand, frameNumber, dimensions, effectiveViewport]);

    useEffect(() => {
        if (!isResizing) return;

        const originalCursor = document.body.style.cursor;
        const originalUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'nwse-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (e: MouseEvent) => {
            if (!resizeStartRef.current) return;
            const dx = e.clientX - resizeStartRef.current.clientX;
            const dy = e.clientY - resizeStartRef.current.clientY;

            const newVp = calculateResizeZoomViewport(
                resizeStartRef.current.startViewport,
                dx,
                dy,
                dimensions.width,
                dimensions.height,
            );
            setManualViewport(newVp);
        };

        const onMouseUp = () => {
            setIsResizing(false);
            resizeStartRef.current = null;
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        return () => {
            document.body.style.cursor = originalCursor;
            document.body.style.userSelect = originalUserSelect;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [isResizing, dimensions]);

    // Auto-Follow: Smoothly pan viewport to follow the object center during live dragging
    const handleAutoFollow = useCallback((objCenterX: number, objCenterY: number) => {
        if (!autoFollowEnabled || dimensions.width <= 0 || dimensions.height <= 0) return;

        const currentVp = effectiveViewport;
        const vpW = currentVp.width > 0 ? currentVp.width : dimensions.width;
        const vpH = currentVp.height > 0 ? currentVp.height : dimensions.height;

        const targetX = objCenterX - vpW / 2;
        const targetY = objCenterY - vpH / 2;

        const clampedX = Math.max(0, Math.min(dimensions.width - vpW, Math.round(targetX)));
        const clampedY = Math.max(0, Math.min(dimensions.height - vpH, Math.round(targetY)));

        if (Math.abs(clampedX - currentVp.x) >= 1 || Math.abs(clampedY - currentVp.y) >= 1) {
            setManualViewport({
                x: clampedX,
                y: clampedY,
                width: vpW,
                height: vpH,
            });
        }
    }, [autoFollowEnabled, dimensions, effectiveViewport]);

    // Direct Annotation Editing Handler (Task A)
    const handleEditLandmark = useCallback((
        parentState: any,
        elementState: any,
        newPoints: [number, number],
    ) => {
        // 1. Update elementState points directly
        elementState.points = [newPoints[0], newPoints[1]];

        // 2. Optimistically update local tile frameStates
        setFrameStates((prevStates) => {
            const nextStates = prevStates.map((st) => {
                if (st.clientID === parentState.clientID && Array.isArray(st.elements)) {
                    return {
                        ...st,
                        elements: st.elements.map((el: any) => {
                            if (el.clientID === elementState.clientID) {
                                return { ...el, points: [newPoints[0], newPoints[1]] };
                            }
                            return el;
                        }),
                    };
                }
                if (st.clientID === elementState.clientID) {
                    return { ...st, points: [newPoints[0], newPoints[1]] };
                }
                return st;
            });
            if (onFrameStatesLoaded) {
                onFrameStatesLoaded(frameNumber, nextStates);
            }
            return nextStates;
        });

        // 3. Dispatch to CVAT's core annotation pipeline immediately
        // Each individual landmark edit remains independently undoable in native CVAT history
        dispatch(activateObject(parentState.clientID, elementState.clientID, null));
        dispatch(updateAnnotationsAsync([elementState]));
    }, [dispatch, frameNumber, onFrameStatesLoaded]);

    const handleEditShape = useCallback((
        shapeState: any,
        newPoints: number[],
    ) => {
        // 1. Update shapeState points directly
        shapeState.points = [...newPoints];

        // 2. Optimistically update local tile frameStates
        setFrameStates((prevStates) => {
            const nextStates = prevStates.map((st) => {
                if (st.clientID === shapeState.clientID) {
                    return { ...st, points: [...newPoints] };
                }
                return st;
            });
            if (onFrameStatesLoaded) {
                onFrameStatesLoaded(frameNumber, nextStates);
            }
            return nextStates;
        });

        // 3. Dispatch to CVAT's core annotation pipeline immediately
        dispatch(activateObject(shapeState.clientID, null, null));
        dispatch(updateAnnotationsAsync([shapeState]));
    }, [dispatch, frameNumber, onFrameStatesLoaded]);

    const handleEditSkeleton = useCallback((
        parentState: any,
        dx: number,
        dy: number,
    ) => {
        if (!isActiveFrame || !parentState || !Array.isArray(parentState.elements)) return;

        // Resolve current outer bounding box before translating
        const currentOuterBox = resolveSkeletonWrappingBox(parentState, frameStates);
        const newOuterBox = currentOuterBox ? {
            xtl: Math.round(currentOuterBox.xtl + dx),
            ytl: Math.round(currentOuterBox.ytl + dy),
            xbr: Math.round(currentOuterBox.xbr + dx),
            ybr: Math.round(currentOuterBox.ybr + dy),
        } : null;

        // 1. Compute and update each element's points
        const elementTargetPoints = new Map<number, [number, number]>();
        for (const el of parentState.elements) {
            if (Array.isArray(el.points) && el.points.length >= 2) {
                const newX = Math.round(el.points[0] + dx);
                const newY = Math.round(el.points[1] + dy);
                elementTargetPoints.set(el.clientID, [newX, newY]);
                el.points = [newX, newY];
            }
        }

        // Also check if there is an associated rectangle in this frame
        const associatedRect = frameStates.find((st: any) => (
            st && !st.outside && st.shapeType === 'rectangle' &&
            (st.clientID === parentState.clientID || st.clientID === parentState.parentID || parentState.parentID === st.clientID ||
             (st.group?.id && parentState.group?.id && st.group.id === parentState.group.id))
        ));

        let newRectPoints: [number, number, number, number] | null = null;
        if (associatedRect && Array.isArray(associatedRect.points) && associatedRect.points.length === 4) {
            newRectPoints = [
                Math.round(associatedRect.points[0] + dx),
                Math.round(associatedRect.points[1] + dy),
                Math.round(associatedRect.points[2] + dx),
                Math.round(associatedRect.points[3] + dy),
            ];
            associatedRect.points = [...newRectPoints];
            if (newOuterBox) {
                associatedRect.wrappingRect = { ...newOuterBox };
                associatedRect.boundingBox = { ...newOuterBox };
            }
        }

        // Ensure parentState has updated wrappingRect & boundingBox using the exact same translation offset
        if (newOuterBox) {
            parentState.wrappingRect = { ...newOuterBox };
            parentState.boundingBox = { ...newOuterBox };
        }

        // 2. Set all skeleton points on parentState if setter is supported, or flatten points
        try {
            const allPoints: number[] = [];
            for (const el of parentState.elements) {
                if (Array.isArray(el.points) && el.points.length >= 2) {
                    allPoints.push(el.points[0], el.points[1]);
                }
            }
            if (allPoints.length > 0 && Array.isArray(parentState.points) && parentState.points.length === allPoints.length) {
                parentState.points = allPoints;
            } else if (newOuterBox && Array.isArray(parentState.points) && parentState.points.length === 4) {
                parentState.points = [newOuterBox.xtl, newOuterBox.ytl, newOuterBox.xbr, newOuterBox.ybr];
            }
        } catch (_e) {
            // ignore if points setter expects specific format
        }

        // 3. Optimistically update local tile frameStates using the precomputed target points (no duplicate offset)
        setFrameStates((prevStates) => {
            const nextStates = prevStates.map((st) => {
                if (st.clientID === parentState.clientID && Array.isArray(st.elements)) {
                    return {
                        ...st,
                        wrappingRect: newOuterBox ? { ...newOuterBox } : st.wrappingRect,
                        boundingBox: newOuterBox ? { ...newOuterBox } : st.boundingBox,
                        points: (newOuterBox && Array.isArray(st.points) && st.points.length === 4) ?
                            [newOuterBox.xtl, newOuterBox.ytl, newOuterBox.xbr, newOuterBox.ybr] : st.points,
                        elements: st.elements.map((el: any) => {
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
                if (associatedRect && st.clientID === associatedRect.clientID && newRectPoints) {
                    return {
                        ...st,
                        wrappingRect: newOuterBox ? { ...newOuterBox } : st.wrappingRect,
                        boundingBox: newOuterBox ? { ...newOuterBox } : st.boundingBox,
                        points: [...newRectPoints],
                    };
                }
                return st;
            });
            if (onFrameStatesLoaded) {
                onFrameStatesLoaded(frameNumber, nextStates);
            }
            return nextStates;
        });

        // 4. Dispatch to CVAT's core annotation pipeline immediately.
        // In native CVAT (SkeletonShape.save), saving the parent skeleton wraps all landmark updates
        // in a single history transaction (this.history.beginTransaction), ensuring the entire drag
        // is recorded as exactly ONE undoable operation.
        dispatch(activateObject(parentState.clientID, null, null));
        const statesToSave = associatedRect ? [parentState, associatedRect] : [parentState];
        dispatch(updateAnnotationsAsync(statesToSave, Boolean(associatedRect)));
    }, [dispatch, frameNumber, frameStates, isActiveFrame, onFrameStatesLoaded]);

    const handleSelectObject = useCallback((state: any, elementState?: any) => {
        if (!isActiveFrame) {
            onNavigateToFrame(frameNumber);
        }
        if (elementState) {
            dispatch(activateObject(state.clientID, elementState.clientID, null));
        } else {
            dispatch(activateObject(state.clientID, null, null));
        }
        if (onSelectObject) {
            onSelectObject(state, elementState);
        }
    }, [dispatch, frameNumber, isActiveFrame, onNavigateToFrame, onSelectObject]);

    const isTileZoomed = manualViewport !== null || (autoZoomEnabled && dimensions.width > 0 && targetViewport.width < dimensions.width);

    return (
        <div
            ref={tileRootRef}
            className={`cvat-multiframe-tile ${isActiveFrame ? 'cvat-multiframe-tile-active' : ''} ${isTileZoomed ? 'cvat-multiframe-tile-zoomed' : ''} ${isResizing ? 'cvat-multiframe-tile-resizing' : ''} ${isExpanded ? 'cvat-multiframe-tile-expanded' : ''} ${isFullyExpanded ? 'cvat-multiframe-tile-fully-expanded' : ''} ${isZoomedInPlace ? 'cvat-multiframe-tile-zoomed-in-place' : ''}`}
            style={{
                ...tileStyle,
                ...expandedStyle,
                ...otherTileStyle,
            }}
            onClick={() => {
                if (!isActiveFrame) {
                    onNavigateToFrame(frameNumber);
                }
            }}
            onDoubleClick={() => {
                if (onZoomFrame) {
                    onZoomFrame(frameNumber);
                } else if (!isActiveFrame) {
                    onNavigateToFrame(frameNumber);
                }
            }}
        >
            {/* Tile Surface (takes full tile space, preserving aspect ratio) */}
            <div
                ref={contentRef}
                className='cvat-multiframe-tile-content'
            >
                {loading && (
                    <div className='cvat-multiframe-tile-loading'>
                        <Spin size='default' />
                    </div>
                )}
                {error && (
                    <div className='cvat-multiframe-tile-error'>
                        <Alert type='error' message={error} showIcon banner />
                    </div>
                )}
                <div
                    ref={canvasWrapRef}
                    className='cvat-multiframe-tile-canvas-wrap'
                    style={{
                        display: loading || error ? 'none' : 'block',
                        width: containerSize.width > 0 && containedLayout.fitWidth > 0 ?
                            `${containedLayout.fitWidth}px` : undefined,
                        height: containerSize.height > 0 && containedLayout.fitHeight > 0 ?
                            `${containedLayout.fitHeight}px` : undefined,
                        maxWidth: '100%',
                        maxHeight: '100%',
                        aspectRatio: renderWidth > 0 && renderHeight > 0 ?
                            `${renderWidth} / ${renderHeight}` : undefined,
                        position: 'relative',
                        cursor: isPanning ? 'grabbing' : 'grab',
                    }}
                    onMouseDown={handleCanvasMouseDown}
                >
                    <canvas ref={canvasRef} className='cvat-multiframe-canvas' />
                    {dimensions.width > 0 && dimensions.height > 0 && (
                        <MultiframeSvgOverlay
                            width={dimensions.width}
                            height={dimensions.height}
                            viewport={effectiveViewport}
                            states={frameStates}
                            matchedClientID={matchResult.matchedClientID}
                            matchedRectClientID={matchedRectClientID}
                            matchedSkeletonClientID={matchedSkeletonClientID}
                            hasSelection={hasSelection}
                            isOccluded={matchResult.isOccluded}
                            onSelectObject={handleSelectObject}
                            onEditLandmark={isActiveFrame && isEditable ? handleEditLandmark : undefined}
                            onEditShape={isActiveFrame && isEditable ? handleEditShape : undefined}
                            onEditSkeleton={isActiveFrame && isEditable ? handleEditSkeleton : undefined}
                            onAutoFollow={isActiveFrame ? handleAutoFollow : undefined}
                        />
                    )}
                </div>

                {/* Compact Floating Controls Overlay on top of the image */}
                <div
                    className='cvat-multiframe-tile-header cvat-multiframe-tile-overlay-controls'
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className='cvat-multiframe-tile-header-left'>
                        <Text strong className='cvat-multiframe-tile-frame-num'>
                            {`#${frameNumber}`}
                        </Text>
                        {isActiveFrame ? (
                            <Tag color='success' className='cvat-multiframe-badge'>
                                ACTIVE
                            </Tag>
                        ) : (
                            <Tag className='cvat-multiframe-badge'>REF</Tag>
                        )}
                    </div>

                    {/* Per-Tile Frame Zoom Control */}
                    <div className='cvat-multiframe-tile-header-center'>
                        <Button
                            size='small'
                            type='primary'
                            ghost
                            className={`cvat-multiframe-zoom-btn ${isZoomedInPlace ? 'cvat-multiframe-zoom-out-btn' : ''}`}
                            icon={isZoomedInPlace ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onZoomFrame) {
                                    onZoomFrame(frameNumber);
                                }
                            }}
                            title={isZoomedInPlace ? 'Restore frame to normal grid size' : 'Zoom frame in place within workspace'}
                        >
                            {isZoomedInPlace ? 'Zoom Out' : 'Zoom'}
                        </Button>
                        <span className='cvat-multiframe-zoom-pct'>
                            {`${zoomPct}%`}
                        </span>
                        {manualViewport !== null && (
                            <Button
                                size='small'
                                type='link'
                                className='cvat-multiframe-zoom-reset-btn'
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleZoomReset(e);
                                }}
                                title='Reset View'
                            >
                                Reset
                            </Button>
                        )}
                        {(isZoomedInPlace || hasCustomLayout || (isExpanded && onRestoreGrid)) && (
                            <Button
                                size='small'
                                type='primary'
                                ghost
                                className='cvat-multiframe-restore-grid-btn'
                                icon={<AppstoreOutlined />}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (onResetLayout) {
                                        onResetLayout(frameNumber);
                                    } else if (onRestoreGrid) {
                                        onRestoreGrid();
                                    } else if (onZoomFrame) {
                                        onZoomFrame(frameNumber);
                                    }
                                }}
                                title='Restore original grid layout'
                            >
                                {isZoomedInPlace ? 'Zoom Out' : 'Restore Grid'}
                            </Button>
                        )}
                    </div>

                    <div className='cvat-multiframe-tile-header-right'>
                        {selectedObject && (
                            <>
                                {matchResult.status === 'MATCHED' && (
                                    <>
                                        <Tag color={matchResult.isOccluded ? 'warning' : 'cyan'}>
                                            {matchResult.isOccluded ? 'Occluded' : 'Matched'}
                                        </Tag>
                                        {(manualViewport !== null || (autoZoomEnabled && targetViewport.width < dimensions.width)) && (
                                            <Tag color='geekblue' className='cvat-multiframe-badge'>
                                                Zoomed
                                            </Tag>
                                        )}
                                    </>
                                )}
                                {matchResult.status === 'ABSENT_ON_FRAME' && (
                                    <Tag color='error'>Absent</Tag>
                                )}
                                {matchResult.status === 'SKELETON_ABSENT' && (
                                    <Tag color='error'>Skeleton Absent</Tag>
                                )}
                                {matchResult.status === 'NO_IDENTITY' && (
                                    <Tag color='default'>No Link</Tag>
                                )}
                            </>
                        )}
                        {!isActiveFrame && (
                            <Button
                                type='link'
                                size='small'
                                className='cvat-multiframe-jump-btn'
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onNavigateToFrame(frameNumber);
                                }}
                            >
                                Jump
                            </Button>
                        )}
                    </div>
                </div>

                {/* Drag-to-resize / drag-to-expand handle at bottom-right corner of tile */}
                {!loading && !error && canResize && (
                    <div
                        className={`cvat-multiframe-tile-resize-handle ${isResizing ? 'cvat-multiframe-tile-resizing' : ''}`}
                        onMouseDown={handleResizeMouseDown}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={isExpanded ? 'Drag corner inward to restore grid or outward to expand' : 'Drag to expand frame across workspace'}
                    >
                        <svg viewBox='0 0 10 10' className='cvat-multiframe-resize-icon'>
                            <line x1='8' y1='2' x2='2' y2='8' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
                            <line x1='9' y1='5' x2='5' y2='9' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
                            <line x1='9' y1='8' x2='8' y2='9' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
                        </svg>
                    </div>
                )}
            </div>
        </div>
    );
}

export default React.memo(MultiframeTile);
