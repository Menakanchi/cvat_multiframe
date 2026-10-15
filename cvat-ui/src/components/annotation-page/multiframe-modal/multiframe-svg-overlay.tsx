// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useMemo, useState, useRef, useEffect, useCallback,
} from 'react';
import {
    Viewport, BBox, resolveSkeletonWrappingBox,
} from './multiframe-utils';

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
    onAutoFollow?(objectCenterX: number, objectCenterY: number): void;
}

interface DragState {
    parentState: any;
    elementState: any;
    initialPoint: [number, number];
    currentPoint: [number, number];
    startClientPt?: { x: number; y: number };
    startScale?: { x: number; y: number };
}

interface DragShapeState {
    shapeState: any;
    handleType: 'move' | 'tl' | 'tr' | 'br' | 'bl';
    initialPoints: [number, number, number, number];
    startSvgPt: { x: number; y: number };
    currentPoints: [number, number, number, number];
    startClientPt?: { x: number; y: number };
    startScale?: { x: number; y: number };
}

interface DragSkeletonState {
    parentState: any;
    startSvgPt: { x: number; y: number };
    initialElementsPoints: Array<{ clientID: number; points: [number, number] }>;
    currentOffset: [number, number];
    initialOuterBox: { xtl: number; ytl: number; xbr: number; ybr: number };
    startClientPt?: { x: number; y: number };
    startScale?: { x: number; y: number };
}

export interface SkeletonEdge {
    from: number;
    to: number;
    fromNode?: string;
    toNode?: string;
}

export interface SkeletonNodeInfo {
    nodeId: string;
    labelId?: number;
    labelName?: string;
    elementId?: number;
    index: number;
}

export function parseSkeletonTemplate(label: any): {
    edges: SkeletonEdge[];
    nodes: SkeletonNodeInfo[];
} {
    const edges: SkeletonEdge[] = [];
    const nodes: SkeletonNodeInfo[] = [];

    if (!label) return { edges, nodes };

    const svgSource = label.structure?.svg || label.svg || label.template;
    if (!svgSource) return { edges, nodes };

    // Case 1: svgSource is a DOM element (SVGSVGElement / Element in browser)
    if (typeof svgSource === 'object' && svgSource !== null && typeof svgSource.querySelectorAll === 'function') {
        try {
            const circleElements = Array.from(svgSource.querySelectorAll('circle')) as Element[];
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

            const lineElements = Array.from(svgSource.querySelectorAll('line')) as Element[];
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
        } catch (_e) {
            // fallback below
        }
    }

    // Case 2: String or fallback via innerHTML / outerHTML
    if (edges.length === 0 && nodes.length === 0) {
        let svgString = '';
        if (typeof svgSource === 'string') {
            svgString = svgSource;
        } else if (typeof svgSource === 'object' && svgSource !== null) {
            svgString = svgSource.innerHTML || svgSource.outerHTML || '';
        }

        if (svgString) {
            if (typeof DOMParser !== 'undefined') {
                try {
                    const parser = new DOMParser();
                    const wrapped = svgString.includes('<svg') ? svgString : `<svg>${svgString}</svg>`;
                    const doc = parser.parseFromString(wrapped, 'image/svg+xml');
                    const circleElements = Array.from(doc.querySelectorAll('circle'));
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

                    const lineElements = Array.from(doc.querySelectorAll('line'));
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
                } catch (_e) {
                    // ignore
                }
            }

            // Regex fallback if DOMParser was unavailable or returned no elements
            if (nodes.length === 0 && edges.length === 0) {
                const circleRegex = /<circle\b([^>]*)\/?>/gi;
                let cMatch = circleRegex.exec(svgString);
                let cIdx = 0;
                while (cMatch !== null) {
                    const attrs = cMatch[1];
                    const nodeIdMatch = /data-node-id=["']?(\d+)["']?/i.exec(attrs);
                    const labelIdMatch = /data-label-id=["']?(\d+)["']?/i.exec(attrs);
                    const labelNameMatch = /data-label-name=["']([^"']+)["']/i.exec(attrs);
                    const elementIdMatch = /data-element-id=["']?(\d+)["']?/i.exec(attrs);

                    nodes.push({
                        nodeId: nodeIdMatch ? nodeIdMatch[1] : String(cIdx + 1),
                        labelId: labelIdMatch ? Number(labelIdMatch[1]) : undefined,
                        labelName: labelNameMatch ? labelNameMatch[1] : undefined,
                        elementId: elementIdMatch ? Number(elementIdMatch[1]) : undefined,
                        index: cIdx++,
                    });
                    cMatch = circleRegex.exec(svgString);
                }

                const lineRegex = /<line\b([^>]*)\/?>/gi;
                let lMatch = lineRegex.exec(svgString);
                while (lMatch !== null) {
                    const attrs = lMatch[1];
                    const fromMatch = /data-node-from=["']?(\d+)["']?/i.exec(attrs);
                    const toMatch = /data-node-to=["']?(\d+)["']?/i.exec(attrs);
                    if (fromMatch && toMatch) {
                        edges.push({
                            from: Number(fromMatch[1]),
                            to: Number(toMatch[1]),
                            fromNode: fromMatch[1],
                            toNode: toMatch[1],
                        });
                    }
                    lMatch = lineRegex.exec(svgString);
                }
            }
        }
    }

    // Enrich nodes with sublabels if available
    const sublabels = label.structure?.sublabels || label.sublabels;
    if (Array.isArray(sublabels) && sublabels.length > 0) {
        nodes.forEach((node) => {
            const sub = (node.elementId !== undefined && sublabels[node.elementId - 1]) ||
                (node.index < sublabels.length && sublabels[node.index]);
            if (sub) {
                /* eslint-disable no-param-reassign */
                if (node.labelId === undefined && sub.id !== undefined) {
                    node.labelId = Number(sub.id);
                }
                if (!node.labelName && sub.name) {
                    node.labelName = sub.name;
                }
                /* eslint-enable no-param-reassign */
            }
        });
    }

    // Map edge.from and edge.to to sublabelId if node has labelId
    // (ensuring backwards compatibility with sublabel ID lookups)
    const nodeToLabelIdMap = new Map<string, number>();
    nodes.forEach((node) => {
        if (node.labelId !== undefined) {
            nodeToLabelIdMap.set(node.nodeId, node.labelId);
        }
    });

    edges.forEach((edge) => {
        /* eslint-disable no-param-reassign */
        if (edge.fromNode && nodeToLabelIdMap.has(edge.fromNode)) {
            edge.from = nodeToLabelIdMap.get(edge.fromNode)!;
        }
        if (edge.toNode && nodeToLabelIdMap.has(edge.toNode)) {
            edge.to = nodeToLabelIdMap.get(edge.toNode)!;
        }
        /* eslint-enable no-param-reassign */
    });

    return { edges, nodes };
}

export function parseSkeletonEdges(label: any): SkeletonEdge[] {
    return parseSkeletonTemplate(label).edges;
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
        onAutoFollow,
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

    // Cache parsed template per skeleton label
    const skeletonTemplatesCache = useMemo(() => {
        const cache: Record<string, { edges: SkeletonEdge[]; nodes: SkeletonNodeInfo[] }> = {};
        for (const state of states) {
            if (state.shapeType === 'skeleton' && state.label) {
                const key = String(state.label.id ?? state.label.name ?? state.clientID);
                if (!(key in cache)) {
                    cache[key] = parseSkeletonTemplate(state.label);
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
        const svg = svgRef.current;
        const rect = svg?.getBoundingClientRect();
        const startScaleX = (rect && rect.width > 0) ? (viewport?.width || width) / rect.width : 1;
        const startScaleY = (rect && rect.height > 0) ? (viewport?.height || height) / rect.height : 1;

        setDragState({
            parentState,
            elementState,
            initialPoint: [initialX, initialY],
            currentPoint: [initialX, initialY],
            startClientPt: { x: e.clientX, y: e.clientY },
            startScale: { x: startScaleX, y: startScaleY },
        });
    }, [viewport, width, height]);

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
        const rect = svg.getBoundingClientRect();
        const startScaleX = rect.width > 0 ? (viewport?.width || width) / rect.width : 1;
        const startScaleY = rect.height > 0 ? (viewport?.height || height) / rect.height : 1;

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
            startClientPt: { x: e.clientX, y: e.clientY },
            startScale: { x: startScaleX, y: startScaleY },
            currentPoints: [...initialPoints],
        });
    }, [viewport, width, height]);

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
        const rect = svg.getBoundingClientRect();
        const startScaleX = rect.width > 0 ? (viewport?.width || width) / rect.width : 1;
        const startScaleY = rect.height > 0 ? (viewport?.height || height) / rect.height : 1;

        const initialElementsPoints = skeletonState.elements
            .filter((el: any) => !el.outside && Array.isArray(el.points) && el.points.length >= 2)
            .map((el: any) => ({
                clientID: el.clientID,
                points: [el.points[0], el.points[1]] as [number, number],
            }));

        setDragSkeletonState({
            parentState: skeletonState,
            startSvgPt: { x: svgPt.x, y: svgPt.y },
            startClientPt: { x: e.clientX, y: e.clientY },
            startScale: { x: startScaleX, y: startScaleY },
            initialElementsPoints,
            currentOffset: [0, 0],
            initialOuterBox: { ...outerBox },
        });
    }, [onEditSkeleton, viewport, width, height]);

    useEffect(() => {
        if (!dragState && !dragShapeState && !dragSkeletonState) return undefined;

        const onMouseMove = (e: MouseEvent): void => {
            if (!svgRef.current) return;
            const svg = svgRef.current;

            // Handle landmark dragging
            if (dragStateRef.current) {
                const currentDrag = dragStateRef.current;
                let clampedX: number;
                let clampedY: number;

                if (currentDrag.startClientPt && currentDrag.startScale) {
                    const dx = (e.clientX - currentDrag.startClientPt.x) * currentDrag.startScale.x;
                    const dy = (e.clientY - currentDrag.startClientPt.y) * currentDrag.startScale.y;
                    clampedX = Math.round(Math.max(0, Math.min(width, currentDrag.initialPoint[0] + dx)));
                    clampedY = Math.round(Math.max(0, Math.min(height, currentDrag.initialPoint[1] + dy)));
                } else {
                    const ctm = svg.getScreenCTM();
                    if (!ctm) return;
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgPt = pt.matrixTransform(ctm.inverse());
                    clampedX = Math.round(Math.max(0, Math.min(width, svgPt.x)));
                    clampedY = Math.round(Math.max(0, Math.min(height, svgPt.y)));
                }

                setDragState((prev) => (prev ? {
                    ...prev,
                    currentPoint: [clampedX, clampedY],
                } : null));

                if (onAutoFollow) {
                    if (Array.isArray(currentDrag.parentState?.elements)) {
                        let minX = clampedX;
                        let maxX = clampedX;
                        let minY = clampedY;
                        let maxY = clampedY;
                        for (const el of currentDrag.parentState.elements) {
                            const isOtherVisibleElement = el.clientID !== currentDrag.elementState?.clientID &&
                                !el.outside && Array.isArray(el.points) && el.points.length >= 2;
                            if (isOtherVisibleElement) {
                                minX = Math.min(minX, el.points[0]);
                                maxX = Math.max(maxX, el.points[0]);
                                minY = Math.min(minY, el.points[1]);
                                maxY = Math.max(maxY, el.points[1]);
                            }
                        }
                        onAutoFollow((minX + maxX) / 2, (minY + maxY) / 2);
                    } else {
                        onAutoFollow(clampedX, clampedY);
                    }
                }
            }

            // Handle shape moving/resizing
            if (dragShapeStateRef.current) {
                const currentDrag = dragShapeStateRef.current;
                let dx = 0;
                let dy = 0;

                if (currentDrag.startClientPt && currentDrag.startScale) {
                    dx = (e.clientX - currentDrag.startClientPt.x) * currentDrag.startScale.x;
                    dy = (e.clientY - currentDrag.startClientPt.y) * currentDrag.startScale.y;
                } else {
                    const ctm = svg.getScreenCTM();
                    if (!ctm) return;
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgPt = pt.matrixTransform(ctm.inverse());
                    dx = svgPt.x - currentDrag.startSvgPt.x;
                    dy = svgPt.y - currentDrag.startSvgPt.y;
                }

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

                if (onAutoFollow) {
                    onAutoFollow((xtl + xbr) / 2, (ytl + ybr) / 2);
                }
            }

            // Handle whole skeleton moving
            if (dragSkeletonStateRef.current) {
                const currentDrag = dragSkeletonStateRef.current;
                let dx = 0;
                let dy = 0;

                if (currentDrag.startClientPt && currentDrag.startScale) {
                    dx = (e.clientX - currentDrag.startClientPt.x) * currentDrag.startScale.x;
                    dy = (e.clientY - currentDrag.startClientPt.y) * currentDrag.startScale.y;
                } else {
                    const ctm = svg.getScreenCTM();
                    if (!ctm) return;
                    const pt = svg.createSVGPoint();
                    pt.x = e.clientX;
                    pt.y = e.clientY;
                    const svgPt = pt.matrixTransform(ctm.inverse());
                    dx = svgPt.x - currentDrag.startSvgPt.x;
                    dy = svgPt.y - currentDrag.startSvgPt.y;
                }

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

                if (onAutoFollow && currentDrag.initialOuterBox) {
                    const initCenterX = (currentDrag.initialOuterBox.xtl + currentDrag.initialOuterBox.xbr) / 2;
                    const initCenterY = (currentDrag.initialOuterBox.ytl + currentDrag.initialOuterBox.ybr) / 2;
                    onAutoFollow(initCenterX + clampedDx, initCenterY + clampedDy);
                }
            }
        };

        const onMouseUp = (): void => {
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
                const dist = Math.hypot(curXtl - initXtl, curYtl - initYtl) +
                    Math.hypot(curXbr - initXbr, curYbr - initYbr);
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
    }, [
        Boolean(dragState || dragShapeState || dragSkeletonState),
        width, height, onEditLandmark, onEditShape, onEditSkeleton, onSelectObject, onAutoFollow,
    ]);

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
                        (st.clientID === state.clientID || st.clientID === state.parentID ||
                            (st.group?.id && state.group?.id && st.group.id === state.group.id))
                    ));

                    // Outer box resolved using native CVAT Canvas logic (cvat-canvas canvasView.ts)
                    const outerBox = resolveSkeletonWrappingBox(state, states);

                    const isDraggingThisSkeleton = dragSkeletonState?.parentState?.clientID === state.clientID;
                    const [dragDx, dragDy] = isDraggingThisSkeleton ? dragSkeletonState.currentOffset : [0, 0];
                    let skeletonCursor = 'pointer';
                    if (onEditSkeleton) skeletonCursor = isDraggingThisSkeleton ? 'grabbing' : 'grab';

                    const firstVisibleElement = state.elements.find((el: any) => (
                        !el.outside && Array.isArray(el.points) && el.points.length >= 2
                    ));
                    let labelX = 10;
                    let labelY = 20;
                    if (outerBox) {
                        labelX = outerBox.xtl;
                        labelY = Math.max(12, outerBox.ytl - 6 * scaleFactor);
                    } else if (firstVisibleElement) {
                        [labelX] = firstVisibleElement.points;
                        labelY = Math.max(12, firstVisibleElement.points[1] - 12 * scaleFactor);
                    }
                    labelX += dragDx;
                    labelY += dragDy;

                    const boxX = outerBox ? outerBox.xtl + dragDx : 0;
                    const boxY = outerBox ? outerBox.ytl + dragDy : 0;
                    const boxW = outerBox ? Math.max(0, outerBox.xbr - outerBox.xtl) : 0;
                    const boxH = outerBox ? Math.max(0, outerBox.ybr - outerBox.ytl) : 0;

                    const labelKey = String(state.label?.id ?? state.label?.name ?? state.clientID);
                    const template = skeletonTemplatesCache[labelKey] || parseSkeletonTemplate(state.label);
                    const { edges } = template;
                    const { nodes } = template;

                    // Build mapping from nodeId, sublabelId, and sublabelName to element in state.elements
                    const nodeToElement = new Map<string, any>();
                    const sublabelIdToElement = new Map<number, any>();
                    const sublabelNameToElement = new Map<string, any>();

                    for (const el of state.elements) {
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
                        } else if (node.elementId !== undefined && state.elements[node.elementId - 1]) {
                            matchedEl = state.elements[node.elementId - 1];
                        } else if (node.index < state.elements.length) {
                            matchedEl = state.elements[node.index];
                        }
                        if (matchedEl) {
                            nodeToElement.set(node.nodeId, matchedEl);
                        }
                    });

                    // Fallback: If any element has data-node-id or clientID or by index
                    for (let i = 0; i < state.elements.length; i++) {
                        const el = state.elements[i];
                        const elNodeId = el['data-node-id'] ?? el.nodeID ?? el.nodeId ?? String(i + 1);
                        if (!nodeToElement.has(String(elNodeId))) {
                            nodeToElement.set(String(elNodeId), el);
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
                                        cursor: skeletonCursor,
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
                                const fromEl = (edge.fromNode && nodeToElement.get(edge.fromNode)) ||
                                    sublabelIdToElement.get(edge.from) ||
                                    nodeToElement.get(String(edge.from));
                                const toEl = (edge.toNode && nodeToElement.get(edge.toNode)) ||
                                    sublabelIdToElement.get(edge.to) ||
                                    nodeToElement.get(String(edge.to));

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

                                const isEdgeOccluded = (isSkeletonMatched && isOccluded) ||
                                    fromEl.occluded || toEl.occluded || state.occluded;

                                return (
                                    <line
                                        key={`edge_${idx}`}
                                        x1={x1}
                                        y1={y1}
                                        x2={x2}
                                        y2={y2}
                                        stroke={isSkeletonMatched ? '#00f0ff' : (state.color || '#ffffff')}
                                        strokeWidth={isSkeletonMatched ? 2 : 1.5}
                                        vectorEffect='non-scaling-stroke'
                                        strokeOpacity={isSkeletonMatched ? 0.9 : 0.65}
                                        strokeDasharray={isEdgeOccluded ? '3,3' : undefined}
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
                                let landmarkCursor = onEditLandmark ? 'grab' : 'pointer';
                                if (isBeingDragged) landmarkCursor = 'grabbing';
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
                                                cursor: landmarkCursor,
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
                    const isSkeletonDrag = !isBeingDragged && Boolean(dragSkeletonState && (
                        state.clientID === dragSkeletonState.parentState.clientID ||
                        state.parentID === dragSkeletonState.parentState.clientID ||
                        (state.group?.id && dragSkeletonState.parentState.group?.id &&
                            state.group.id === dragSkeletonState.parentState.group.id)
                    ));
                    const [skelDx, skelDy] = isSkeletonDrag && dragSkeletonState ?
                        dragSkeletonState.currentOffset : [0, 0];
                    let [xtl, ytl, xbr, ybr] = isBeingDragged ? dragShapeState.currentPoints : state.points;
                    if (isSkeletonDrag) {
                        xtl += skelDx;
                        ytl += skelDy;
                        xbr += skelDx;
                        ybr += skelDy;
                    }
                    const isMatched = state.clientID === matchedClientID ||
                        (typeof matchedRectClientID === 'number' && state.clientID === matchedRectClientID) ||
                        (typeof matchedSkeletonClientID === 'number' && (
                            state.parentID === matchedSkeletonClientID ||
                            (state.group?.id && states.some((st: any) => (
                                st.clientID === matchedSkeletonClientID && st.group?.id === state.group.id
                            )))
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
