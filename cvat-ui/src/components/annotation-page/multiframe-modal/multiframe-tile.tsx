// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState, useMemo } from 'react';
import Tag from 'antd/lib/tag';
import Spin from 'antd/lib/spin';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';

import {
    resolveCrossFrameIdentity,
    getObjectBoundingBox,
    calculateAutoZoomViewport,
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
    } = props;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imageDataRef = useRef<ImageBitmap | Blob | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [frameStates, setFrameStates] = useState<any[]>([]);
    const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

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
                const { imageData, renderWidth, renderHeight } = await frameData.data();
                if (isCancelled) return;

                imageDataRef.current = imageData;
                const width = renderWidth || frameData.width || 1920;
                const height = renderHeight || frameData.height || 1080;
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

        const bbox = getObjectBoundingBox(matchResult.targetState, matchResult.targetElementState);
        if (!bbox) {
            return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
        }

        return calculateAutoZoomViewport(bbox, dimensions.width, dimensions.height);
    }, [autoZoomEnabled, selectedObject, matchResult, dimensions]);

    // 6. Viewport canvas painting (centers and zooms onto target instance with native sharpness)
    useEffect(() => {
        const canvas = canvasRef.current;
        const imageData = imageDataRef.current;
        if (!canvas || !imageData || dimensions.width === 0 || dimensions.height === 0) return;

        const renderWidth = targetViewport.width > 0 ? targetViewport.width : dimensions.width;
        const renderHeight = targetViewport.height > 0 ? targetViewport.height : dimensions.height;

        canvas.width = renderWidth;
        canvas.height = renderHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, renderWidth, renderHeight);
        if (imageData instanceof ImageBitmap) {
            ctx.drawImage(
                imageData,
                targetViewport.x,
                targetViewport.y,
                targetViewport.width,
                targetViewport.height,
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
                        targetViewport.x,
                        targetViewport.y,
                        targetViewport.width,
                        targetViewport.height,
                        0,
                        0,
                        renderWidth,
                        renderHeight,
                    );
                }
            };
            img.src = URL.createObjectURL(imageData);
        }
    }, [targetViewport, dimensions, loading]);

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

                <div className='cvat-multiframe-tile-header-right'>
                    {selectedObject && (
                        <>
                            {matchResult.status === 'MATCHED' && (
                                <>
                                    <Tag color={matchResult.isOccluded ? 'warning' : 'cyan'}>
                                        {matchResult.isOccluded ? 'Occluded' : 'Matched'}
                                    </Tag>
                                    {autoZoomEnabled && targetViewport.width < dimensions.width && (
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
            <div className='cvat-multiframe-tile-content'>
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
                    className='cvat-multiframe-tile-canvas-wrap'
                    style={{ display: loading || error ? 'none' : 'block' }}
                >
                    <canvas ref={canvasRef} className='cvat-multiframe-canvas' />
                    {dimensions.width > 0 && dimensions.height > 0 && (
                        <MultiframeSvgOverlay
                            width={dimensions.width}
                            height={dimensions.height}
                            viewport={targetViewport}
                            states={frameStates}
                            matchedClientID={matchResult.matchedClientID}
                            isOccluded={matchResult.isOccluded}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

export default React.memo(MultiframeTile);
