// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import Tag from 'antd/lib/tag';
import Spin from 'antd/lib/spin';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';

import { changeFrameAsync, activateObject, updateAnnotationsAsync } from 'actions/annotation-actions';
import {
    resolveCrossFrameIdentity,
    getObjectBoundingBox,
    calculateAutoZoomViewport,
    zoomViewportAtPoint,
    panViewport,
    calculateZoomPercentage,
    Viewport,
} from './multiframe-utils';
import MultiframeSvgOverlay from './multiframe-svg-overlay';

interface Props {
    frameNumber: number;
    jobInstance: any;
    isActiveFrame: boolean;
    selectedObject: any | null;
    autoZoomEnabled?: boolean;
    onNavigateToFrame(frame: number): void;
    onFrameStatesLoaded?(frameNumber: number, states: any[]): void;
    onSelectObject?(state: any, elementState?: any): void;
}

function MultiframeTile(props: Props): JSX.Element {
    const {
        frameNumber,
        jobInstance,
        isActiveFrame,
        selectedObject,
        autoZoomEnabled = true,
        onNavigateToFrame,
        onFrameStatesLoaded,
        onSelectObject,
    } = props;

    const dispatch = useDispatch();

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const canvasWrapRef = useRef<HTMLDivElement | null>(null);
    const imageDataRef = useRef<ImageBitmap | Blob | null>(null);

    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [frameStates, setFrameStates] = useState<any[]>([]);
    const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

    // Independent per-tile manual viewport state (Task B)
    const [manualViewport, setManualViewport] = useState<Viewport | null>(null);
    const [isPanning, setIsPanning] = useState<boolean>(false);
    const panStartRef = useRef<{ clientX: number; clientY: number; startViewport: Viewport } | null>(null);

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
                const width = fRenderWidth || frameData.width || 1920;
                const height = fRenderHeight || frameData.height || 1080;
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
    }, [frameNumber, jobInstance]);

    // Reset manual viewport when selected object or auto-zoom toggle changes
    useEffect(() => {
        setManualViewport(null);
    }, [selectedObject, autoZoomEnabled]);

    // 4. Pure identity resolution
    const matchResult = useMemo(
        () => resolveCrossFrameIdentity(selectedObject, frameStates),
        [selectedObject, frameStates],
    );

    // 5. Per-frame auto-zoom viewport calculation
    const targetViewport = useMemo<Viewport>(() => {
        if (
            !autoZoomEnabled ||
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

        return calculateAutoZoomViewport(bbox, dimensions.width, dimensions.height);
    }, [autoZoomEnabled, selectedObject, matchResult, dimensions, frameStates]);

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
        if (imageData instanceof ImageBitmap) {
            ctx.drawImage(
                imageData,
                effectiveViewport.x,
                effectiveViewport.y,
                effectiveViewport.width,
                effectiveViewport.height,
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
                    cCtx?.drawImage(
                        img,
                        effectiveViewport.x,
                        effectiveViewport.y,
                        effectiveViewport.width,
                        effectiveViewport.height,
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
        if (e.button !== 0 && e.button !== 1) return;
        setIsPanning(true);
        panStartRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            startViewport: effectiveViewport,
        };
    }, [effectiveViewport]);

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
            return prevStates.map((st) => {
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
        });

        // 3. Dispatch to CVAT's core annotation pipeline
        dispatch(changeFrameAsync(frameNumber));
        dispatch(activateObject(parentState.clientID, elementState.clientID, null));
        dispatch(updateAnnotationsAsync([elementState]));

        if (onFrameStatesLoaded) {
            onFrameStatesLoaded(frameNumber, frameStates);
        }
    }, [dispatch, frameNumber, onFrameStatesLoaded, frameStates]);

    const handleSelectObject = useCallback((state: any, elementState?: any) => {
        dispatch(changeFrameAsync(frameNumber));
        if (elementState) {
            dispatch(activateObject(state.clientID, elementState.clientID, null));
        } else {
            dispatch(activateObject(state.clientID, null, null));
        }
        if (onSelectObject) {
            onSelectObject(state, elementState);
        }
    }, [dispatch, frameNumber, onSelectObject]);

    return (
        <div
            className={`cvat-multiframe-tile ${isActiveFrame ? 'cvat-multiframe-tile-active' : ''}`}
            onDoubleClick={() => {
                if (!isActiveFrame) {
                    onNavigateToFrame(frameNumber);
                }
            }}
        >
            {/* Tile Header Bar */}
            <div className='cvat-multiframe-tile-header'>
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

                {/* Per-Tile Zoom Controls (Task B) */}
                <div className='cvat-multiframe-tile-header-center'>
                    <Button
                        size='small'
                        type='text'
                        className='cvat-multiframe-zoom-btn'
                        onClick={handleZoomOut}
                        title='Zoom Out'
                    >
                        −
                    </Button>
                    <span className='cvat-multiframe-zoom-pct'>
                        {`${zoomPct}%`}
                    </span>
                    <Button
                        size='small'
                        type='text'
                        className='cvat-multiframe-zoom-btn'
                        onClick={handleZoomIn}
                        title='Zoom In'
                    >
                        +
                    </Button>
                    {manualViewport !== null && (
                        <Button
                            size='small'
                            type='link'
                            className='cvat-multiframe-zoom-reset-btn'
                            onClick={handleZoomReset}
                            title='Reset View'
                        >
                            Reset
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

            {/* Tile Surface */}
            <div
                className='cvat-multiframe-tile-content'
                style={{
                    aspectRatio: dimensions.width > 0 && dimensions.height > 0 ?
                        `${renderWidth} / ${renderHeight}` : '16 / 9',
                }}
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
                        width: '100%',
                        height: '100%',
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
                            isOccluded={matchResult.isOccluded}
                            onSelectObject={handleSelectObject}
                            onEditLandmark={handleEditLandmark}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

export default React.memo(MultiframeTile);
