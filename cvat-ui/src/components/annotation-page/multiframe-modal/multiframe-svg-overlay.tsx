// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Viewport } from './multiframe-utils';

interface Props {
    width: number;
    height: number;
    viewport?: Viewport;
    states: any[];
    matchedClientID: number | null;
    isOccluded?: boolean;
    activeClientID?: number | null;
    activeElementID?: number | null;
    onSelectObject?(state: any, elementState?: any): void;
    onEditLandmark?(parentState: any, elementState: any, newPoints: [number, number]): void;
}

interface SkeletonEdge {
    from: number;
    to: number;
}

interface DragState {
    parentState: any;
    elementState: any;
    initialPoint: [number, number];
    currentPoint: [number, number];
}

function parseSkeletonEdges(label: any): SkeletonEdge[] {
    const edges: SkeletonEdge[] = [];
    if (!label?.structure?.svg) {
        return edges;
    }

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(label.structure.svg, 'image/svg+xml');
        const lineElements = doc.querySelectorAll('line[data-type="edge"]');
        lineElements.forEach((line) => {
            const from = Number(line.getAttribute('data-node-from'));
            const to = Number(line.getAttribute('data-node-to'));
            if (Number.isInteger(from) && Number.isInteger(to)) {
                edges.push({ from, to });
            }
        });
    } catch (_e) {
        // Fallback gracefully if svg parsing fails
    }

    return edges;
}

function MultiframeSvgOverlay(props: Props): JSX.Element {
    const {
        width,
        height,
        viewport,
        states,
        matchedClientID,
        isOccluded,
        activeClientID,
        activeElementID,
        onSelectObject,
        onEditLandmark,
    } = props;

    const svgRef = useRef<SVGSVGElement | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const dragStateRef = useRef<DragState | null>(null);
    dragStateRef.current = dragState;

    const vpX = viewport?.x ?? 0;
    const vpY = viewport?.y ?? 0;
    const vpW = (viewport?.width && viewport.width > 0) ? viewport.width : width;
    const vpH = (viewport?.height && viewport.height > 0) ? viewport.height : height;
    const zoomScale = (vpW > 0 && width > 0) ? Math.max(1, width / vpW) : 1;
    const scaleFactor = 1 / Math.sqrt(zoomScale);

    // Cache parsed edges per skeleton label id
    const skeletonEdgesCache = useMemo(() => {
        const cache: Record<number, SkeletonEdge[]> = {};
        for (const state of states) {
            if (state.shapeType === 'skeleton' && state.label?.id) {
                if (!(state.label.id in cache)) {
                    cache[state.label.id] = parseSkeletonEdges(state.label);
                }
            }
        }
        return cache;
    }, [states]);

    const handleLandmarkMouseDown = useCallback((
        e: React.MouseEvent,
        parentState: any,
        elementState: any,
        initialX: number,
        initialY: number,
    ) => {
        e.stopPropagation();
        e.preventDefault();
        setDragState({
            parentState,
            elementState,
            initialPoint: [initialX, initialY],
            currentPoint: [initialX, initialY],
        });
    }, []);

    useEffect(() => {
        if (!dragState) return;

        const onMouseMove = (e: MouseEvent) => {
            if (!svgRef.current || !dragStateRef.current) return;
            const svg = svgRef.current;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const ctm = svg.getScreenCTM();
            if (!ctm) return;
            const svgPt = pt.matrixTransform(ctm.inverse());
            const clampedX = Math.round(Math.max(0, Math.min(width, svgPt.x)));
            const clampedY = Math.round(Math.max(0, Math.min(height, svgPt.y)));

            setDragState((prev) => (prev ? {
                ...prev,
                currentPoint: [clampedX, clampedY],
            } : null));
        };

        const onMouseUp = () => {
            const currentDrag = dragStateRef.current;
            if (currentDrag) {
                const [initX, initY] = currentDrag.initialPoint;
                const [curX, curY] = currentDrag.currentPoint;
                const dist = Math.hypot(curX - initX, curY - initY);
                if (dist > 0.5 && onEditLandmark) {
                    onEditLandmark(currentDrag.parentState, currentDrag.elementState, [curX, curY]);
                }
                if (onSelectObject) {
                    onSelectObject(currentDrag.parentState, currentDrag.elementState);
                }
            }
            setDragState(null);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [dragState !== null, width, height, onEditLandmark, onSelectObject]);

    return (
        <svg
            ref={svgRef}
            className='cvat-multiframe-svg-overlay'
            viewBox={`${vpX} ${vpY} ${vpW} ${vpH}`}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
            }}
        >
            {states.map((state) => {
                if (state.outside) {
                    return null;
                }

                // 1. Skeletons and Landmark Elements
                if (state.shapeType === 'skeleton' && Array.isArray(state.elements)) {
                    const edges = skeletonEdgesCache[state.label?.id] || [];
                    const elementBySublabelId: Record<number, any> = {};
                    for (const el of state.elements) {
                        if (el.label?.id) {
                            elementBySublabelId[el.label.id] = el;
                        }
                    }

                    return (
                        <g key={`skeleton_${state.clientID}`}>
                            {/* Render skeleton bones (edges) */}
                            {edges.map((edge, idx) => {
                                const fromEl = elementBySublabelId[edge.from];
                                const toEl = elementBySublabelId[edge.to];
                                if (!fromEl || !toEl || fromEl.outside || toEl.outside) {
                                    return null;
                                }

                                let [x1, y1] = fromEl.points || [];
                                let [x2, y2] = toEl.points || [];

                                // Live dynamic stretching during drag
                                if (dragState && dragState.elementState.clientID === fromEl.clientID) {
                                    [x1, y1] = dragState.currentPoint;
                                }
                                if (dragState && dragState.elementState.clientID === toEl.clientID) {
                                    [x2, y2] = dragState.currentPoint;
                                }

                                if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
                                    return null;
                                }

                                return (
                                    <line
                                        key={`edge_${idx}`}
                                        x1={x1}
                                        y1={y1}
                                        x2={x2}
                                        y2={y2}
                                        stroke='#ffffff'
                                        strokeWidth={1.5}
                                        vectorEffect='non-scaling-stroke'
                                        strokeOpacity={0.65}
                                    />
                                );
                            })}

                            {/* Render landmark elements */}
                            {state.elements.map((el: any) => {
                                if (el.outside || !Array.isArray(el.points) || el.points.length < 2) {
                                    return null;
                                }

                                const isBeingDragged = dragState?.elementState?.clientID === el.clientID;
                                const [x, y] = isBeingDragged ? dragState.currentPoint : el.points;
                                const isMatched = el.clientID === matchedClientID || el.clientID === activeElementID;

                                return (
                                    <g key={`el_${el.clientID}`}>
                                        {/* Invisible enlarged hit target for easy clicking and dragging */}
                                        <circle
                                            cx={x}
                                            cy={y}
                                            r={Math.max(8, 16 * scaleFactor)}
                                            fill='transparent'
                                            style={{
                                                pointerEvents: 'all',
                                                cursor: isBeingDragged ? 'grabbing' : 'grab',
                                            }}
                                            onMouseDown={(e) => handleLandmarkMouseDown(e, state, el, x, y)}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (onSelectObject) {
                                                    onSelectObject(state, el);
                                                }
                                            }}
                                        />

                                        {isMatched ? (
                                            <>
                                                {/* Pulsing cyan highlight ring */}
                                                <circle
                                                    cx={x}
                                                    cy={y}
                                                    r={Math.max(4, 10 * scaleFactor)}
                                                    fill='none'
                                                    stroke='#00f0ff'
                                                    strokeWidth={2.5}
                                                    vectorEffect='non-scaling-stroke'
                                                    strokeDasharray={isOccluded ? '3,3' : undefined}
                                                    className='cvat-multiframe-pulsing-highlight'
                                                    style={{ pointerEvents: 'none' }}
                                                />
                                                {/* Landmark center dot */}
                                                <circle
                                                    cx={x}
                                                    cy={y}
                                                    r={Math.max(2, 3.5 * scaleFactor)}
                                                    fill='#00f0ff'
                                                    stroke='#ffffff'
                                                    strokeWidth={1}
                                                    vectorEffect='non-scaling-stroke'
                                                    style={{ pointerEvents: 'none' }}
                                                />
                                                {/* Landmark name label */}
                                                <text
                                                    x={x + 8 * scaleFactor}
                                                    y={y - 8 * scaleFactor}
                                                    fill='#00f0ff'
                                                    fontSize={Math.max(9, Math.round(11 * scaleFactor))}
                                                    fontWeight={700}
                                                    style={{
                                                        pointerEvents: 'none',
                                                        filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))',
                                                        userSelect: 'none',
                                                    }}
                                                >
                                                    {el.label?.name}
                                                    {isOccluded ? ' (Occluded)' : ''}
                                                </text>
                                            </>
                                        ) : (
                                            <circle
                                                cx={x}
                                                cy={y}
                                                r={Math.max(1.8, 3 * scaleFactor)}
                                                fill={el.color || state.color || '#52c41a'}
                                                stroke='#ffffff'
                                                strokeWidth={1}
                                                vectorEffect='non-scaling-stroke'
                                                opacity={0.85}
                                                style={{ pointerEvents: 'none' }}
                                            />
                                        )}
                                    </g>
                                );
                            })}
                        </g>
                    );
                }

                // 2. Standalone Points or Points Tracks
                if (state.shapeType === 'points' && Array.isArray(state.points)) {
                    const isMatched = state.clientID === matchedClientID || state.clientID === activeClientID;
                    const circles: JSX.Element[] = [];
                    for (let i = 0; i < state.points.length; i += 2) {
                        const isBeingDragged = dragState?.elementState?.clientID === state.clientID;
                        const [x, y] = isBeingDragged ? dragState.currentPoint : [state.points[i], state.points[i + 1]];

                        circles.push(
                            <g key={`pts_${state.clientID}_${i}`}>
                                <circle
                                    cx={x}
                                    cy={y}
                                    r={Math.max(8, 16 * scaleFactor)}
                                    fill='transparent'
                                    style={{
                                        pointerEvents: 'all',
                                        cursor: isBeingDragged ? 'grabbing' : 'grab',
                                    }}
                                    onMouseDown={(e) => handleLandmarkMouseDown(e, state, state, x, y)}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onSelectObject) {
                                            onSelectObject(state);
                                        }
                                    }}
                                />
                                {isMatched ? (
                                    <>
                                        <circle
                                            cx={x}
                                            cy={y}
                                            r={Math.max(4, 10 * scaleFactor)}
                                            fill='none'
                                            stroke='#00f0ff'
                                            strokeWidth={2.5}
                                            vectorEffect='non-scaling-stroke'
                                            strokeDasharray={isOccluded ? '3,3' : undefined}
                                            className='cvat-multiframe-pulsing-highlight'
                                            style={{ pointerEvents: 'none' }}
                                        />
                                        <circle
                                            cx={x}
                                            cy={y}
                                            r={Math.max(2, 3.5 * scaleFactor)}
                                            fill='#00f0ff'
                                            stroke='#fff'
                                            strokeWidth={1}
                                            vectorEffect='non-scaling-stroke'
                                            style={{ pointerEvents: 'none' }}
                                        />
                                        <text
                                            x={x + 8 * scaleFactor}
                                            y={y - 8 * scaleFactor}
                                            fill='#00f0ff'
                                            fontSize={Math.max(9, Math.round(11 * scaleFactor))}
                                            fontWeight={700}
                                            style={{
                                                pointerEvents: 'none',
                                                filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))',
                                                userSelect: 'none',
                                            }}
                                        >
                                            {state.label?.name}
                                        </text>
                                    </>
                                ) : (
                                    <circle
                                        cx={x}
                                        cy={y}
                                        r={Math.max(1.8, 3 * scaleFactor)}
                                        fill={state.color || '#1890ff'}
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        vectorEffect='non-scaling-stroke'
                                        opacity={0.85}
                                        style={{ pointerEvents: 'none' }}
                                    />
                                )}
                            </g>,
                        );
                    }
                    return <g key={`points_${state.clientID}`}>{circles}</g>;
                }

                // 3. Rectangles
                if (state.shapeType === 'rectangle' && Array.isArray(state.points) && state.points.length === 4) {
                    const [xtl, ytl, xbr, ybr] = state.points;
                    const isMatched = state.clientID === matchedClientID || state.clientID === activeClientID;
                    return (
                        <rect
                            key={`rect_${state.clientID}`}
                            x={xtl}
                            y={ytl}
                            width={Math.max(0, xbr - xtl)}
                            height={Math.max(0, ybr - ytl)}
                            fill='transparent'
                            stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                            strokeWidth={isMatched ? 2.5 : 1.5}
                            vectorEffect='non-scaling-stroke'
                            strokeDasharray={isOccluded ? '4,4' : undefined}
                            opacity={0.8}
                            style={{ pointerEvents: 'all', cursor: 'pointer' }}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onSelectObject) {
                                    onSelectObject(state);
                                }
                            }}
                        />
                    );
                }

                // 4. Polygons
                if (state.shapeType === 'polygon' && Array.isArray(state.points)) {
                    const pointsStr = state.points.reduce((acc: string, val: number, idx: number) => (
                        `${acc}${idx % 2 === 0 ? ' ' : ','}${val}`
                    ), '').trim();
                    const isMatched = state.clientID === matchedClientID || state.clientID === activeClientID;
                    return (
                        <polygon
                            key={`poly_${state.clientID}`}
                            points={pointsStr}
                            fill='transparent'
                            stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                            strokeWidth={isMatched ? 2.5 : 1.5}
                            vectorEffect='non-scaling-stroke'
                            opacity={0.8}
                            style={{ pointerEvents: 'all', cursor: 'pointer' }}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (onSelectObject) {
                                    onSelectObject(state);
                                }
                            }}
                        />
                    );
                }

                return null;
            })}
        </svg>
    );
}

export default React.memo(MultiframeSvgOverlay);
