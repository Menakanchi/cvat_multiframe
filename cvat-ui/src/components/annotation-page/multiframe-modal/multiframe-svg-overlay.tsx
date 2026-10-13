// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useMemo } from 'react';

interface Props {
    width: number;
    height: number;
    states: any[];
    matchedClientID: number | null;
    isOccluded?: boolean;
}

interface SkeletonEdge {
    from: number;
    to: number;
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
        states,
        matchedClientID,
        isOccluded,
    } = props;

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

    return (
        <svg
            className='cvat-multiframe-svg-overlay'
            viewBox={`0 0 ${width} ${height}`}
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
                                const [x1, y1] = fromEl.points || [];
                                const [x2, y2] = toEl.points || [];
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
                                        strokeOpacity={0.65}
                                    />
                                );
                            })}

                            {/* Render landmark elements */}
                            {state.elements.map((el: any) => {
                                if (el.outside || !Array.isArray(el.points) || el.points.length < 2) {
                                    return null;
                                }
                                const [x, y] = el.points;
                                const isMatched = el.clientID === matchedClientID;

                                if (isMatched) {
                                    return (
                                        <g key={`el_${el.clientID}`}>
                                            {/* Pulsing cyan highlight ring */}
                                            <circle
                                                cx={x}
                                                cy={y}
                                                r={10}
                                                fill='none'
                                                stroke='#00f0ff'
                                                strokeWidth={2.5}
                                                strokeDasharray={isOccluded ? '3,3' : undefined}
                                                className='cvat-multiframe-pulsing-highlight'
                                            />
                                            {/* Landmark center dot */}
                                            <circle
                                                cx={x}
                                                cy={y}
                                                r={3.5}
                                                fill='#00f0ff'
                                                stroke='#ffffff'
                                                strokeWidth={1}
                                            />
                                            {/* Landmark name label */}
                                            <text
                                                x={x + 8}
                                                y={y - 8}
                                                fill='#00f0ff'
                                                fontSize={11}
                                                fontWeight={700}
                                                style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}
                                            >
                                                {el.label?.name}
                                                {isOccluded ? ' (Occluded)' : ''}
                                            </text>
                                        </g>
                                    );
                                }

                                return (
                                    <circle
                                        key={`el_${el.clientID}`}
                                        cx={x}
                                        cy={y}
                                        r={3}
                                        fill={el.color || state.color || '#52c41a'}
                                        stroke='#ffffff'
                                        strokeWidth={1}
                                        opacity={0.85}
                                    />
                                );
                            })}
                        </g>
                    );
                }

                // 2. Standalone Points or Points Tracks
                if (state.shapeType === 'points' && Array.isArray(state.points)) {
                    const isMatched = state.clientID === matchedClientID;
                    const circles: JSX.Element[] = [];
                    for (let i = 0; i < state.points.length; i += 2) {
                        const x = state.points[i];
                        const y = state.points[i + 1];
                        if (isMatched) {
                            circles.push(
                                <g key={`pts_${state.clientID}_${i}`}>
                                    <circle
                                        cx={x}
                                        cy={y}
                                        r={10}
                                        fill='none'
                                        stroke='#00f0ff'
                                        strokeWidth={2.5}
                                        strokeDasharray={isOccluded ? '3,3' : undefined}
                                        className='cvat-multiframe-pulsing-highlight'
                                    />
                                    <circle cx={x} cy={y} r={3.5} fill='#00f0ff' stroke='#fff' strokeWidth={1} />
                                    <text
                                        x={x + 8}
                                        y={y - 8}
                                        fill='#00f0ff'
                                        fontSize={11}
                                        fontWeight={700}
                                        style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}
                                    >
                                        {state.label?.name}
                                    </text>
                                </g>,
                            );
                        } else {
                            circles.push(
                                <circle
                                    key={`pts_${state.clientID}_${i}`}
                                    cx={x}
                                    cy={y}
                                    r={3}
                                    fill={state.color || '#1890ff'}
                                    stroke='#ffffff'
                                    strokeWidth={1}
                                    opacity={0.85}
                                />,
                            );
                        }
                    }
                    return <g key={`points_${state.clientID}`}>{circles}</g>;
                }

                // 3. Rectangles
                if (state.shapeType === 'rectangle' && Array.isArray(state.points) && state.points.length === 4) {
                    const [xtl, ytl, xbr, ybr] = state.points;
                    const isMatched = state.clientID === matchedClientID;
                    return (
                        <rect
                            key={`rect_${state.clientID}`}
                            x={xtl}
                            y={ytl}
                            width={Math.max(0, xbr - xtl)}
                            height={Math.max(0, ybr - ytl)}
                            fill='none'
                            stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                            strokeWidth={isMatched ? 2.5 : 1.5}
                            strokeDasharray={isOccluded ? '4,4' : undefined}
                            opacity={0.8}
                        />
                    );
                }

                // 4. Polygons
                if (state.shapeType === 'polygon' && Array.isArray(state.points)) {
                    const pointsStr = state.points.reduce((acc: string, val: number, idx: number) => (
                        `${acc}${idx % 2 === 0 ? ' ' : ','}${val}`
                    ), '').trim();
                    const isMatched = state.clientID === matchedClientID;
                    return (
                        <polygon
                            key={`poly_${state.clientID}`}
                            points={pointsStr}
                            fill='none'
                            stroke={isMatched ? '#00f0ff' : (state.color || '#1890ff')}
                            strokeWidth={isMatched ? 2.5 : 1.5}
                            opacity={0.8}
                        />
                    );
                }

                return null;
            })}
        </svg>
    );
}

export default React.memo(MultiframeSvgOverlay);
