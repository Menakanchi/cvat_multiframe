// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Viewport, parseBBox, resolveSkeletonWrappingBox } from './multiframe-utils';

interface Props {
    width: number;
    height: number;
    viewport?: Viewport;
    states: any[];
    matchedClientID: number | null;
    matchedRectClientID?: number | null;
    matchedSkeletonClientID?: number | null;
    hasSelection?: boolean;
    isOccluded?: boolean;
    activeClientID?: number | null;
    activeElementID?: number | null;
    onSelectObject?(state: any, elementState?: any): void;
    onEditLandmark?(parentState: any, elementState: any, newPoints: [number, number]): void;
    onEditShape?(shapeState: any, newPoints: number[]): void;
    onEditSkeleton?(parentState: any, dx: number, dy: number): void;
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

interface DragShapeState {
    shapeState: any;
    handleType: 'move' | 'tl' | 'tr' | 'br' | 'bl';
    initialPoints: [number, number, number, number];
    startSvgPt: { x: number; y: number };
    currentPoints: [number, number, number, number];
}

interface DragSkeletonState {
    parentState: any;
    startSvgPt: { x: number; y: number };
    initialElementsPoints: Array<{ clientID: number; points: [number, number] }>;
    currentOffset: [number, number];
    initialOuterBox: { xtl: number; ytl: number; xbr: number; ybr: number };
}

function parseSkeletonEdges(label: any): SkeletonEdge[] {
    const edges: SkeletonEdge[] = [];
    if (!label?.structure?.svg) {
        return edges;
    }

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(label.structure.svg, 'image/svg+xml');

        // Build mapping from data-node-id to data-label-id (or data-element-id)
        const nodeToLabelMap: Record<number, number> = {};
        const circles = doc.querySelectorAll('circle');
        circles.forEach((circle) => {
            const nodeId = Number(circle.getAttribute('data-node-id'));
            const labelId = Number(circle.getAttribute('data-label-id'));
            if (Number.isInteger(nodeId) && Number.isInteger(labelId)) {
                nodeToLabelMap[nodeId] = labelId;
            }
        });

        const lineElements = doc.querySelectorAll('line[data-type="edge"]');
        lineElements.forEach((line) => {
            const from = Number(line.getAttribute('data-node-from'));
            const to = Number(line.getAttribute('data-node-to'));
            if (Number.isInteger(from) && Number.isInteger(to)) {
                const mappedFrom = nodeToLabelMap[from] ?? from;
                const mappedTo = nodeToLabelMap[to] ?? to;
                edges.push({ from: mappedFrom, to: mappedTo });
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
        matchedRectClientID,
        matchedSkeletonClientID,
        hasSelection = false,
        isOccluded,
        activeClientID,
        activeElementID,
        onSelectObject,
        onEditLandmark,
        onEditShape,
        onEditSkeleton,
    } = props;

    const svgRef = useRef<SVGSVGElement | null>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);
    const dragStateRef = useRef<DragState | null>(null);
    dragStateRef.current = dragState;

    const [dragShapeState, setDragShapeState] = useState<DragShapeState | null>(null);
    const dragShapeStateRef = useRef<DragShapeState | null>(null);
    dragShapeStateRef.current = dragShapeState;

    const [dragSkeletonState, setDragSkeletonState] = useState<DragSkeletonState | null>(null);
    const dragSkeletonStateRef = useRef<DragSkeletonState | null>(null);
    dragSkeletonStateRef.current = dragSkeletonState;

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

    const handleShapeMouseDown = useCallback((
        e: React.MouseEvent,
        shapeState: any,
        handleType: 'move' | 'tl' | 'tr' | 'br' | 'bl',
    ) => {
        e.stopPropagation();
        e.preventDefault();
        if (!svgRef.current || !Array.isArray(shapeState.points) || shapeState.points.length !== 4) return;
        const svg = svgRef.current;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const svgPt = pt.matrixTransform(ctm.inverse());

        const initialPoints: [number, number, number, number] = [
            shapeState.points[0],
            shapeState.points[1],
            shapeState.points[2],
            shapeState.points[3],
        ];

        setDragShapeState({
            shapeState,
            handleType,
            initialPoints,
            startSvgPt: { x: svgPt.x, y: svgPt.y },
            currentPoints: [...initialPoints],
        });
    }, []);

    const handleSkeletonMouseDown = useCallback((
        e: React.MouseEvent,
        skeletonState: any,
        outerBox: BBox,
    ) => {
        if (!onEditSkeleton) return;
        e.stopPropagation();
        e.preventDefault();
        if (!svgRef.current || !Array.isArray(skeletonState.elements)) return;
        const svg = svgRef.current;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const svgPt = pt.matrixTransform(ctm.inverse());

        const initialElementsPoints = skeletonState.elements
            .filter((el: any) => !el.outside && Array.isArray(el.points) && el.points.length >= 2)
            .map((el: any) => ({
                clientID: el.clientID,
                points: [el.points[0], el.points[1]] as [number, number],
            }));

        setDragSkeletonState({
            parentState: skeletonState,
            startSvgPt: { x: svgPt.x, y: svgPt.y },
            initialElementsPoints,
            currentOffset: [0, 0],
            initialOuterBox: { ...outerBox },
        });
    }, [onEditSkeleton]);

    useEffect(() => {
        if (!dragState && !dragShapeState && !dragSkeletonState) return;

        const onMouseMove = (e: MouseEvent) => {
            if (!svgRef.current) return;
            const svg = svgRef.current;
            const ctm = svg.getScreenCTM();
            if (!ctm) return;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgPt = pt.matrixTransform(ctm.inverse());

            // Handle landmark dragging
            if (dragStateRef.current) {
                const clampedX = Math.round(Math.max(0, Math.min(width, svgPt.x)));
                const clampedY = Math.round(Math.max(0, Math.min(height, svgPt.y)));

                setDragState((prev) => (prev ? {
                    ...prev,
                    currentPoint: [clampedX, clampedY],
                } : null));
            }

            // Handle shape moving/resizing
            if (dragShapeStateRef.current) {
                const currentDrag = dragShapeStateRef.current;
                const dx = svgPt.x - currentDrag.startSvgPt.x;
                const dy = svgPt.y - currentDrag.startSvgPt.y;
                let [xtl, ytl, xbr, ybr] = currentDrag.initialPoints;

                if (currentDrag.handleType === 'move') {
                    const w = xbr - xtl;
                    const h = ybr - ytl;
                    let newXtl = xtl + dx;
                    let newYtl = ytl + dy;
                    newXtl = Math.max(0, Math.min(width - w, newXtl));
                    newYtl = Math.max(0, Math.min(height - h, newYtl));
                    xtl = Math.round(newXtl);
                    ytl = Math.round(newYtl);
                    xbr = Math.round(newXtl + w);
                    ybr = Math.round(newYtl + h);
                } else if (currentDrag.handleType === 'tl') {
                    xtl = Math.round(Math.max(0, Math.min(xbr - 5, xtl + dx)));
                    ytl = Math.round(Math.max(0, Math.min(ybr - 5, ytl + dy)));
                } else if (currentDrag.handleType === 'tr') {
                    xbr = Math.round(Math.max(xtl + 5, Math.min(width, xbr + dx)));
                    ytl = Math.round(Math.max(0, Math.min(ybr - 5, ytl + dy)));
                } else if (currentDrag.handleType === 'br') {
                    xbr = Math.round(Math.max(xtl + 5, Math.min(width, xbr + dx)));
                    ybr = Math.round(Math.max(ytl + 5, Math.min(height, ybr + dy)));
                } else if (currentDrag.handleType === 'bl') {
                    xtl = Math.round(Math.max(0, Math.min(xbr - 5, xtl + dx)));
                    ybr = Math.round(Math.max(ytl + 5, Math.min(height, ybr + dy)));
                }

                setDragShapeState((prev) => (prev ? {
                    ...prev,
                    currentPoints: [xtl, ytl, xbr, ybr],
                } : null));
            }

            // Handle whole skeleton moving
            if (dragSkeletonStateRef.current) {
                const currentDrag = dragSkeletonStateRef.current;
                const dx = svgPt.x - currentDrag.startSvgPt.x;
                const dy = svgPt.y - currentDrag.startSvgPt.y;

                let minDx = -Infinity;
                let maxDx = Infinity;
                let minDy = -Infinity;
                let maxDy = Infinity;

                if (currentDrag.initialElementsPoints.length > 0) {
                    const minX = Math.min(...currentDrag.initialElementsPoints.map((p) => p.points[0]));
                    const maxX = Math.max(...currentDrag.initialElementsPoints.map((p) => p.points[0]));
                    const minY = Math.min(...currentDrag.initialElementsPoints.map((p) => p.points[1]));
                    const maxY = Math.max(...currentDrag.initialElementsPoints.map((p) => p.points[1]));

                    minDx = -minX;
                    maxDx = width - maxX;
                    minDy = -minY;
                    maxDy = height - maxY;
                }

                const clampedDx = Math.round(Math.max(minDx, Math.min(maxDx, dx)));
                const clampedDy = Math.round(Math.max(minDy, Math.min(maxDy, dy)));

                setDragSkeletonState((prev) => (prev ? {
                    ...prev,
                    currentOffset: [clampedDx, clampedDy],
                } : null));
            }
        };

        const onMouseUp = () => {
            const currentLandmarkDrag = dragStateRef.current;
            if (currentLandmarkDrag) {
                const [initX, initY] = currentLandmarkDrag.initialPoint;
                const [curX, curY] = currentLandmarkDrag.currentPoint;
                const dist = Math.hypot(curX - initX, curY - initY);
                if (dist > 0.5 && onEditLandmark) {
                    onEditLandmark(currentLandmarkDrag.parentState, currentLandmarkDrag.elementState, [curX, curY]);
                }
                if (onSelectObject) {
                    onSelectObject(currentLandmarkDrag.parentState, currentLandmarkDrag.elementState);
                }
                setDragState(null);
            }

            const currentShapeDrag = dragShapeStateRef.current;
            if (currentShapeDrag) {
                const [initXtl, initYtl, initXbr, initYbr] = currentShapeDrag.initialPoints;
                const [curXtl, curYtl, curXbr, curYbr] = currentShapeDrag.currentPoints;
                const dist = Math.hypot(curXtl - initXtl, curYtl - initYtl) + Math.hypot(curXbr - initXbr, curYbr - initYbr);
                if (dist > 0.5 && onEditShape) {
                    onEditShape(currentShapeDrag.shapeState, [curXtl, curYtl, curXbr, curYbr]);
                }
                if (onSelectObject) {
                    onSelectObject(currentShapeDrag.shapeState);
                }
                setDragShapeState(null);
            }

            const currentSkeletonDrag = dragSkeletonStateRef.current;
            if (currentSkeletonDrag) {
                const [dx, dy] = currentSkeletonDrag.currentOffset;
                const dist = Math.hypot(dx, dy);
                if (dist > 0.5 && onEditSkeleton) {
                    onEditSkeleton(currentSkeletonDrag.parentState, dx, dy);
                }
                if (onSelectObject) {
                    onSelectObject(currentSkeletonDrag.parentState);
                }
                setDragSkeletonState(null);
            }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [Boolean(dragState || dragShapeState || dragSkeletonState), width, height, onEditLandmark, onEditShape, onEditSkeleton, onSelectObject]);

    return (
        <svg
            ref={svgRef}
            className='cvat-multiframe-svg-overlay'
            viewBox={`${vpX} ${vpY} ${vpW} ${vpH}`}
            preserveAspectRatio='none'
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
                    const isSkeletonMatched = state.clientID === matchedSkeletonClientID ||
                        state.clientID === matchedClientID ||
                        state.clientID === activeClientID;

                    if (hasSelection && !isSkeletonMatched) {
                        return null;
                    }

                    // Check if there is a separate rectangle in states associated with this skeleton
                    const separateRect = states.find((st: any) => (
                        st && !st.outside && st.shapeType === 'rectangle' &&
                        (st.clientID === state.clientID || st.clientID === state.parentID || state.parentID === st.clientID ||
                         (st.group?.id && state.group?.id && st.group.id === state.group.id))
                    ));

                    // Outer box resolved using native CVAT Canvas logic (cvat-canvas canvasView.ts)
                    const outerBox = resolveSkeletonWrappingBox(state, states);

                    const isDraggingThisSkeleton = dragSkeletonState?.parentState?.clientID === state.clientID;
                    const [dragDx, dragDy] = isDraggingThisSkeleton ? dragSkeletonState.currentOffset : [0, 0];

                    const firstVisibleElement = state.elements.find((el: any) => !el.outside && Array.isArray(el.points) && el.points.length >= 2);
                    const labelX = (outerBox ? outerBox.xtl : (firstVisibleElement ? firstVisibleElement.points[0] : 10)) + dragDx;
                    const labelY = (outerBox ? Math.max(12, outerBox.ytl - 6 * scaleFactor) : (firstVisibleElement ? Math.max(12, firstVisibleElement.points[1] - 12 * scaleFactor) : 20)) + dragDy;

                    const boxX = outerBox ? outerBox.xtl + dragDx : 0;
                    const boxY = outerBox ? outerBox.ytl + dragDy : 0;
                    const boxW = outerBox ? Math.max(0, outerBox.xbr - outerBox.xtl) : 0;
                    const boxH = outerBox ? Math.max(0, outerBox.ybr - outerBox.ytl) : 0;

                    const edges = skeletonEdgesCache[state.label?.id] || [];
                    const elementBySublabelId: Record<number, any> = {};
                    for (const el of state.elements) {
                        if (el.label?.id) {
                            elementBySublabelId[el.label.id] = el;
                        }
                    }

                    return (
                        <g key={`skeleton_${state.clientID}`}>
                            {/* Render outer bounding box if available and not handled by separate rectangle */}
                            {!separateRect && outerBox && (
                                <rect
                                    key={`skeleton_box_${state.clientID}`}
                                    x={boxX}
                                    y={boxY}
                                    width={boxW}
                                    height={boxH}
                                    fill={isSkeletonMatched ? 'rgba(0, 240, 255, 0.08)' : 'rgba(24, 144, 255, 0.04)'}
                                    stroke={isSkeletonMatched ? '#00f0ff' : (state.color || '#1890ff')}
                                    strokeWidth={isSkeletonMatched ? 2.5 : 1.5}
                                    vectorEffect='non-scaling-stroke'
                                    strokeDasharray={(isSkeletonMatched && isOccluded) || state.occluded ? '4,4' : undefined}
                                    opacity={0.85}
                                    style={{
                                        pointerEvents: 'all',
                                        cursor: onEditSkeleton ? (isDraggingThisSkeleton ? 'grabbing' : 'grab') : 'pointer',
                                    }}
                                    onMouseDown={(e) => {
                                        if (onEditSkeleton) {
                                            handleSkeletonMouseDown(e, state, outerBox);
                                        }
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onSelectObject) {
                                            onSelectObject(state);
                                        }
                                    }}
                                />
                            )}

                            {/* Render skeleton object label and ID badge */}
                            <text
                                x={labelX}
                                y={labelY}
                                fill={isSkeletonMatched ? '#00f0ff' : (state.color || '#1890ff')}
                                fontSize={Math.max(9, Math.round(11 * scaleFactor))}
                                fontWeight={700}
                                style={{
                                    pointerEvents: 'none',
                                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.95))',
                                    userSelect: 'none',
                                    textTransform: 'uppercase',
                                }}
                            >
                                {`${state.label?.name || 'Skeleton'} #${state.clientID}`}
                            </text>

                            {/* Render skeleton bones (edges) */}
                            {edges.map((edge, idx) => {
                                const fromEl = elementBySublabelId[edge.from];
                                const toEl = elementBySublabelId[edge.to];
                                if (!fromEl || !toEl || fromEl.outside || toEl.outside) {
                                    return null;
                                }

                                let [x1, y1] = fromEl.points || [];
                                let [x2, y2] = toEl.points || [];

                                if (isDraggingThisSkeleton) {
                                    x1 += dragDx;
                                    y1 += dragDy;
                                    x2 += dragDx;
                                    y2 += dragDy;
                                } else {
                                    // Live dynamic stretching during individual landmark drag
                                    if (dragState && dragState.elementState.clientID === fromEl.clientID) {
                                        [x1, y1] = dragState.currentPoint;
                                    }
                                    if (dragState && dragState.elementState.clientID === toEl.clientID) {
                                        [x2, y2] = dragState.currentPoint;
                                    }
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
                                        stroke={isSkeletonMatched ? '#00f0ff' : '#ffffff'}
                                        strokeWidth={isSkeletonMatched ? 2 : 1.5}
                                        vectorEffect='non-scaling-stroke'
                                        strokeOpacity={isSkeletonMatched ? 0.9 : 0.65}
                                        style={{ pointerEvents: 'none' }}
                                    />
                                );
                            })}

                            {/* Render landmark elements */}
                            {state.elements.map((el: any) => {
                                if (el.outside || !Array.isArray(el.points) || el.points.length < 2) {
                                    return null;
                                }

                                const isBeingDragged = dragState?.elementState?.clientID === el.clientID;
                                let [x, y] = isBeingDragged ? dragState.currentPoint : el.points;
                                if (isDraggingThisSkeleton) {
                                    x += dragDx;
                                    y += dragDy;
                                }
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
                                                cursor: isBeingDragged ? 'grabbing' : (onEditLandmark ? 'grab' : 'pointer'),
                                            }}
                                            onMouseDown={(e) => {
                                                if (onEditLandmark) {
                                                    handleLandmarkMouseDown(e, state, el, x, y);
                                                }
                                            }}
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
                    if (hasSelection && !isMatched) {
                        return null;
                    }

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
                    const isBeingDragged = dragShapeState?.shapeState?.clientID === state.clientID;
                    const [xtl, ytl, xbr, ybr] = isBeingDragged ? dragShapeState.currentPoints : state.points;
                    const isMatched = state.clientID === matchedClientID ||
                        (typeof matchedRectClientID === 'number' && state.clientID === matchedRectClientID) ||
                        (typeof matchedSkeletonClientID === 'number' && (
                            state.parentID === matchedSkeletonClientID ||
                            (state.group?.id && states.some((st: any) => st.clientID === matchedSkeletonClientID && st.group?.id === state.group.id))
                        )) ||
                        state.clientID === activeClientID;

                    // When an object is selected, hide bounding boxes of all other objects
                    if (hasSelection && !isMatched) {
                        return null;
                    }

                    const rectWidth = Math.max(0, xbr - xtl);
                    const rectHeight = Math.max(0, ybr - ytl);
                    const cx = xtl + rectWidth / 2;
                    const cy = ytl + rectHeight / 2;
                    const transform = state.rotation ? `rotate(${state.rotation} ${cx} ${cy})` : undefined;
                    const handleSize = Math.max(6, 10 * scaleFactor);
                    const halfH = handleSize / 2;

                    return (
                        <g key={`rect_group_${state.clientID}`}>
                            <rect
                                key={`rect_${state.clientID}`}
                                x={xtl}
                                y={ytl}
                                width={rectWidth}
                                height={rectHeight}
                                transform={transform}
                                fill='transparent'
                                stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                                strokeWidth={isMatched ? 2.5 : 1.5}
                                vectorEffect='non-scaling-stroke'
                                strokeDasharray={(isMatched && isOccluded) || state.occluded ? '4,4' : undefined}
                                opacity={0.8}
                                style={{
                                    pointerEvents: 'all',
                                    cursor: isBeingDragged ? 'grabbing' : 'move',
                                }}
                                onMouseDown={(e) => handleShapeMouseDown(e, state, 'move')}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (onSelectObject) {
                                        onSelectObject(state);
                                    }
                                }}
                            />
                            {/* When active or matched, render resize corner handles */}
                            {isMatched && (
                                <>
                                    {/* Top-Left handle */}
                                    <rect
                                        x={xtl - halfH}
                                        y={ytl - halfH}
                                        width={handleSize}
                                        height={handleSize}
                                        fill='#00f0ff'
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        vectorEffect='non-scaling-stroke'
                                        style={{ pointerEvents: 'all', cursor: 'nwse-resize' }}
                                        onMouseDown={(e) => handleShapeMouseDown(e, state, 'tl')}
                                    />
                                    {/* Top-Right handle */}
                                    <rect
                                        x={xbr - halfH}
                                        y={ytl - halfH}
                                        width={handleSize}
                                        height={handleSize}
                                        fill='#00f0ff'
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        vectorEffect='non-scaling-stroke'
                                        style={{ pointerEvents: 'all', cursor: 'nesw-resize' }}
                                        onMouseDown={(e) => handleShapeMouseDown(e, state, 'tr')}
                                    />
                                    {/* Bottom-Right handle */}
                                    <rect
                                        x={xbr - halfH}
                                        y={ybr - halfH}
                                        width={handleSize}
                                        height={handleSize}
                                        fill='#00f0ff'
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        vectorEffect='non-scaling-stroke'
                                        style={{ pointerEvents: 'all', cursor: 'nwse-resize' }}
                                        onMouseDown={(e) => handleShapeMouseDown(e, state, 'br')}
                                    />
                                    {/* Bottom-Left handle */}
                                    <rect
                                        x={xtl - halfH}
                                        y={ybr - halfH}
                                        width={handleSize}
                                        height={handleSize}
                                        fill='#00f0ff'
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        vectorEffect='non-scaling-stroke'
                                        style={{ pointerEvents: 'all', cursor: 'nesw-resize' }}
                                        onMouseDown={(e) => handleShapeMouseDown(e, state, 'bl')}
                                    />
                                </>
                            )}
                        </g>
                    );
                }

                // 4. Polygons
                if (state.shapeType === 'polygon' && Array.isArray(state.points)) {
                    const pointsStr = state.points.reduce((acc: string, val: number, idx: number) => (
                        `${acc}${idx % 2 === 0 ? ' ' : ','}${val}`
                    ), '').trim();
                    const isMatched = state.clientID === matchedClientID ||
                        (typeof matchedRectClientID === 'number' && state.clientID === matchedRectClientID) ||
                        state.clientID === activeClientID;

                    // When an object is selected, hide other polygons
                    if (hasSelection && !isMatched) {
                        return null;
                    }

                    return (
                        <polygon
                            key={`poly_${state.clientID}`}
                            points={pointsStr}
                            fill='transparent'
                            stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                            strokeWidth={isMatched ? 2.5 : 1.5}
                            vectorEffect='non-scaling-stroke'
                            strokeDasharray={(isMatched && isOccluded) || state.occluded ? '4,4' : undefined}
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
