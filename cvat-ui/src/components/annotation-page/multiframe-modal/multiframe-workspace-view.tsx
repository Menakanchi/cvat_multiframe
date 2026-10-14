// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useMemo, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Tag from 'antd/lib/tag';
import InputNumber from 'antd/lib/input-number';
import Alert from 'antd/lib/alert';
import Spin from 'antd/lib/spin';
import Select from 'antd/lib/select';
import Checkbox from 'antd/lib/checkbox';
import { CloseOutlined, LeftOutlined, RightOutlined, SaveOutlined, AppstoreOutlined } from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { switchShowMultiframeModal, changeFrameAsync, saveAnnotationsAsync } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import CanvasLayout from 'components/annotation-page/canvas/grid-layout/canvas-layout';
import BrushTools from 'components/annotation-page/canvas/views/canvas2d/brush-tools';
import {
    validateFrameRange,
    getBatchFrames,
    getTotalBatches,
    extractSelectableObjects,
    SelectableObject,
} from './multiframe-utils';
import MultiframeTile from './multiframe-tile';

const DEFAULT_BATCH_SIZE = 10;

interface Props {
    onClose(): void;
    initialStartFrame?: number;
    initialEndFrame?: number;
    initialFrameCount?: number;
}

function MultiframeWorkspaceView(props: Props): JSX.Element {
    const { onClose, initialStartFrame, initialEndFrame, initialFrameCount } = props;
    const dispatch = useDispatch();

    const {
        jobInstance,
        currentFrame,
        activatedStateID,
        activatedElementID,
        activeFrameStates,
        frameNumbers,
        isSaving,
    } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        currentFrame: state.annotation.player.frame.number,
        activatedStateID: state.annotation.annotations.activatedStateID,
        activatedElementID: state.annotation.annotations.activatedElementID,
        activeFrameStates: state.annotation.annotations.states,
        frameNumbers: state.annotation.job.frameNumbers,
        isSaving: state.annotation.annotations.saving.uploading,
    }), shallowEqual);

    const hasValidFrames = Array.isArray(frameNumbers) && frameNumbers.length > 0;
    const jobStartFrame = hasValidFrames ?
        frameNumbers[0] : (jobInstance?.startFrame ?? 0);
    const jobStopFrame = hasValidFrames ?
        frameNumbers[frameNumbers.length - 1] : (jobInstance?.stopFrame ?? 0);

    const [rangeStart, setRangeStart] = useState<number>(initialStartFrame ?? jobStartFrame);
    const [rangeEnd, setRangeEnd] = useState<number>(initialEndFrame ?? jobStopFrame);
    const [batchSize, setBatchSize] = useState<number>(
        typeof initialFrameCount === 'number' ? clamp(initialFrameCount, 1, 10) : DEFAULT_BATCH_SIZE,
    );
    const [batchIndex, setBatchIndex] = useState<number>(0);

    const [inputStart, setInputStart] = useState<number | null>(initialStartFrame ?? jobStartFrame);
    const [inputEnd, setInputEnd] = useState<number | null>(initialEndFrame ?? jobStopFrame);

    // Object Selector & Auto-Zoom State
    const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
    const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('all');
    const [autoZoomEnabled, setAutoZoomEnabled] = useState<boolean>(true);
    const [autoFollowEnabled, setAutoFollowEnabled] = useState<boolean>(true);
    const [focusModeEnabled, setFocusModeEnabled] = useState<boolean>(true);
    const [allJobStates, setAllJobStates] = useState<any[]>([]);
    const [initialFetchDone, setInitialFetchDone] = useState<boolean>(false);
    const [zoomedFrame, setZoomedFrame] = useState<number | null>(null);

    // Fetch initial annotations for job
    useEffect(() => {
        let isCancelled = false;
        async function fetchInitialAnnotations(): Promise<void> {
            try {
                if (jobInstance) {
                    const states = await jobInstance.annotations.get(currentFrame, true, []);
                    if (!isCancelled && Array.isArray(states)) {
                        setAllJobStates(states);
                    }
                }
            } catch (_e) {
                // Ignore gracefully
            } finally {
                if (!isCancelled) {
                    setInitialFetchDone(true);
                }
            }
        }
        fetchInitialAnnotations();
        return () => {
            isCancelled = true;
        };
    }, [jobInstance, currentFrame]);

    // Handle frame states reported by tiles as batches load
    const handleFrameStatesLoaded = useCallback((_frame: number, loadedStates: any[]) => {
        if (Array.isArray(loadedStates) && loadedStates.length > 0) {
            setAllJobStates((prev) => {
                const existingClientIDs = new Set(prev.map((s: any) => s.clientID));
                const newStates = loadedStates.filter((s: any) => !existingClientIDs.has(s.clientID));
                if (newStates.length === 0) return prev;
                return [...prev, ...newStates];
            });
        }
    }, []);

    // Extract deduplicated selectable objects across known states
    const selectableObjects = useMemo<SelectableObject[]>(() => {
        const merged = [...allJobStates];
        if (Array.isArray(activeFrameStates)) {
            const existingIDs = new Set(merged.map((s: any) => s.clientID));
            for (const st of activeFrameStates) {
                if (!existingIDs.has(st.clientID)) {
                    merged.push(st);
                }
            }
        }
        return extractSelectableObjects(merged);
    }, [allJobStates, activeFrameStates]);

    // Available shape types for filtering
    const availableTypes = useMemo(() => {
        const types = new Set<string>();
        for (const obj of selectableObjects) {
            if (obj.shapeType) {
                types.add(obj.shapeType);
            }
        }
        return Array.from(types).sort();
    }, [selectableObjects]);

    // Objects filtered by the selected shape type
    const filteredSelectableObjects = useMemo(() => {
        if (selectedTypeFilter === 'all') {
            return selectableObjects;
        }
        return selectableObjects.filter((obj) => obj.shapeType === selectedTypeFilter);
    }, [selectableObjects, selectedTypeFilter]);

    // Clear selection if selected object is removed / no longer exists
    useEffect(() => {
        if (initialFetchDone && selectedObjectKey) {
            const exists = selectableObjects.some((o) => o.key === selectedObjectKey);
            if (!exists) {
                setSelectedObjectKey(null);
            }
        }
    }, [initialFetchDone, selectedObjectKey, selectableObjects]);

    // Initialize selection from active canvas selection if not yet chosen
    useEffect(() => {
        if (selectedObjectKey === null && (activatedStateID || activatedElementID)) {
            let match = null;
            if (activatedStateID) {
                match = selectableObjects.find((o) => o.clientID === activatedStateID);
            }
            if (!match && activatedElementID) {
                match = selectableObjects.find((o) => {
                    const st = o.sourceState;
                    return st && Array.isArray(st.elements) && st.elements.some((el: any) => el.clientID === activatedElementID);
                });
            }
            if (match) {
                setSelectedObjectKey(match.key);
            }
        }
    }, [activatedStateID, activatedElementID, selectableObjects, selectedObjectKey]);

    // Resolve the active selected object instance
    const selectedObject = useMemo(() => {
        if (!selectedObjectKey) return null;
        const matched = selectableObjects.find((o) => o.key === selectedObjectKey);
        if (!matched) return null;
        return matched.sourceState;
    }, [selectedObjectKey, selectableObjects]);

    useEffect(() => {
        if (typeof initialStartFrame === 'number') {
            setRangeStart(initialStartFrame);
            setInputStart(initialStartFrame);
        } else if (hasValidFrames) {
            setRangeStart(jobStartFrame);
            setInputStart(jobStartFrame);
        }
        if (typeof initialEndFrame === 'number') {
            setRangeEnd(initialEndFrame);
            setInputEnd(initialEndFrame);
        } else if (hasValidFrames) {
            setRangeEnd(jobStopFrame);
            setInputEnd(jobStopFrame);
        }
        if (typeof initialFrameCount === 'number') {
            setBatchSize(clamp(initialFrameCount, 1, 10));
        }
        setBatchIndex(0);
    }, [initialStartFrame, initialEndFrame, initialFrameCount, hasValidFrames, jobStartFrame, jobStopFrame]);

    // Reset batch index to 0 whenever the selected range or batch size changes
    useEffect(() => {
        setBatchIndex(0);
    }, [rangeStart, rangeEnd, batchSize]);

    const validation = validateFrameRange(inputStart, inputEnd, jobStartFrame, jobStopFrame, frameNumbers);
    const totalBatches = getTotalBatches(rangeStart, rangeEnd, batchSize, frameNumbers);
    const batchFrames = getBatchFrames(batchIndex, rangeStart, rangeEnd, batchSize, frameNumbers);

    const onUpdateRange = useCallback(() => {
        if (validation.isValid && hasValidFrames && inputStart !== null && inputEnd !== null) {
            setRangeStart(inputStart);
            setRangeEnd(inputEnd);
            setBatchIndex(0);
        }
    }, [validation.isValid, hasValidFrames, inputStart, inputEnd]);

    const onPrevBatch = useCallback(() => {
        setBatchIndex((idx) => Math.max(0, idx - 1));
    }, []);

    const onNextBatch = useCallback(() => {
        setBatchIndex((idx) => Math.min(Math.max(0, totalBatches - 1), idx + 1));
    }, [totalBatches]);

    const handleNavigateToFrame = useCallback((frame: number) => {
        dispatch(changeFrameAsync(frame));
    }, [dispatch]);

    const handleZoomFrame = useCallback((frame: number) => {
        setZoomedFrame(frame);
        dispatch(changeFrameAsync(frame));
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 50);
    }, [dispatch]);

    const handleReturnToGrid = useCallback(() => {
        setZoomedFrame(null);
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 50);
    }, []);

    // Sync zoomedFrame with currentFrame if navigation occurs inside full-screen view
    useEffect(() => {
        if (zoomedFrame !== null && currentFrame !== zoomedFrame) {
            setZoomedFrame(currentFrame);
            const computedBatch = Math.floor((currentFrame - rangeStart) / batchSize);
            if (computedBatch >= 0 && computedBatch < totalBatches && computedBatch !== batchIndex) {
                setBatchIndex(computedBatch);
            }
        }
    }, [currentFrame, zoomedFrame, rangeStart, totalBatches, batchIndex, batchSize]);

    // Escape key returns to Multi-Frame grid
    useEffect(() => {
        if (zoomedFrame === null) return undefined;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                handleReturnToGrid();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [zoomedFrame, handleReturnToGrid]);

    const handleTileSelectObject = useCallback((targetState: any) => {
        if (!targetState) return;
        const targetKey = targetState.objectType === 'track' ? `track_${targetState.clientID}` : `shape_${targetState.clientID}`;
        setSelectedObjectKey(targetKey);
        if (targetState.shapeType && selectedTypeFilter !== 'all' && targetState.shapeType !== selectedTypeFilter) {
            setSelectedTypeFilter(targetState.shapeType);
        }
    }, [selectedTypeFilter]);

    const batchStartFrame = batchFrames.length > 0 ? batchFrames[0] : (hasValidFrames ? rangeStart : '-');
    const batchEndFrame = batchFrames.length > 0 ? batchFrames[batchFrames.length - 1] : (hasValidFrames ? rangeEnd : '-');

    return (
        <div className={`cvat-multiframe-workspace-view ${zoomedFrame !== null ? 'cvat-multiframe-workspace-fullscreen' : ''}`}>
            {zoomedFrame !== null ? (
                <div className='cvat-multiframe-fullscreen-container'>
                    {/* Full-Screen Top Banner */}
                    <div className='cvat-multiframe-fullscreen-banner'>
                        <div className='cvat-multiframe-fullscreen-banner-left'>
                            <Button
                                type='primary'
                                icon={<AppstoreOutlined />}
                                onClick={handleReturnToGrid}
                                className='cvat-multiframe-return-btn'
                            >
                                Return to Multi-Frame
                            </Button>
                            <Text strong className='cvat-multiframe-fullscreen-title'>
                                {`Frame #${zoomedFrame} — Full-Size Annotation View`}
                            </Text>
                            <Tag color='geekblue' className='cvat-multiframe-badge'>
                                {`Batch ${batchIndex + 1}/${totalBatches}`}
                            </Tag>
                            <Tag className='cvat-multiframe-badge'>
                                {`Range: [${rangeStart} .. ${rangeEnd}]`}
                            </Tag>
                            {selectedObject && (
                                <Tag color='cyan' className='cvat-multiframe-badge'>
                                    {`Object: ${selectableObjects.find((o) => o.key === selectedObjectKey)?.displayText || 'Selected'}`}
                                </Tag>
                            )}
                        </div>
                        <div className='cvat-multiframe-fullscreen-banner-right'>
                            <Button
                                size='small'
                                icon={<LeftOutlined />}
                                disabled={batchFrames.indexOf(zoomedFrame) <= 0}
                                onClick={() => {
                                    const idx = batchFrames.indexOf(zoomedFrame);
                                    if (idx > 0) {
                                        const prevF = batchFrames[idx - 1];
                                        handleZoomFrame(prevF);
                                    }
                                }}
                                style={{ marginRight: 6 }}
                                title='Previous frame in batch'
                            >
                                Prev Frame
                            </Button>
                            <Button
                                size='small'
                                icon={<RightOutlined />}
                                disabled={batchFrames.indexOf(zoomedFrame) >= batchFrames.length - 1}
                                onClick={() => {
                                    const idx = batchFrames.indexOf(zoomedFrame);
                                    if (idx >= 0 && idx < batchFrames.length - 1) {
                                        const nextF = batchFrames[idx + 1];
                                        handleZoomFrame(nextF);
                                    }
                                }}
                                style={{ marginRight: 12 }}
                                title='Next frame in batch'
                            >
                                Next Frame
                            </Button>
                            <Button
                                type='primary'
                                size='small'
                                icon={<SaveOutlined />}
                                loading={isSaving}
                                disabled={isSaving}
                                onClick={() => dispatch(saveAnnotationsAsync())}
                                className='cvat-multiframe-save-btn'
                                style={{ marginRight: 8, background: '#1890ff', borderColor: '#1890ff' }}
                            >
                                {isSaving ? 'Saving...' : 'Save'}
                            </Button>
                            <Button
                                type='default'
                                danger
                                size='small'
                                icon={<CloseOutlined />}
                                onClick={onClose}
                                title='Exit Multi-Frame'
                            >
                                Exit Multi-Frame
                            </Button>
                        </div>
                    </div>
                    {/* CVAT Native Canvas Layout */}
                    <div className='cvat-multiframe-fullscreen-canvas-wrapper'>
                        <CanvasLayout />
                        <BrushTools />
                    </div>
                </div>
            ) : (
                <>
                    {/* Header Controls Bar */}
                    <div className='cvat-multiframe-controls-bar'>
                {/* Left: Range and Navigation */}
                <div className='cvat-multiframe-range-group'>
                    <Text strong>Range:</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 85 }}
                        value={inputStart}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setInputStart(val)}
                        placeholder='Start'
                    />
                    <Text>to</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 85 }}
                        value={inputEnd}
                        min={jobStartFrame}
                        max={jobStopFrame}
                        precision={0}
                        onChange={(val: number | null) => setInputEnd(val)}
                        placeholder='End'
                    />
                    <Button
                        size='small'
                        disabled={!validation.isValid || !hasValidFrames}
                        onClick={onUpdateRange}
                        className='cvat-multiframe-apply-range-btn'
                    >
                        Apply Range
                    </Button>
                    <Text strong style={{ marginLeft: 6 }}>Count:</Text>
                    <InputNumber
                        size='small'
                        style={{ width: 60 }}
                        value={batchSize}
                        min={1}
                        max={10}
                        precision={0}
                        onChange={(val: number | null) => {
                            if (typeof val === 'number') {
                                setBatchSize(clamp(val, 1, 10));
                            }
                        }}
                        placeholder='Count'
                        className='cvat-multiframe-count-quick-input'
                    />
                </div>

                {/* Center: Batch Navigation */}
                <div className='cvat-multiframe-batch-group'>
                    <Button
                        size='small'
                        icon={<LeftOutlined />}
                        onClick={onPrevBatch}
                        disabled={batchIndex === 0}
                        className='cvat-multiframe-prev-batch-btn'
                    >
                        Prev Batch
                    </Button>
                    <Text strong className='cvat-multiframe-batch-indicator'>
                        {`Batch ${totalBatches === 0 ? 0 : batchIndex + 1} of ${Math.max(1, totalBatches)} (Frames #${batchStartFrame} - #${batchEndFrame})`}
                    </Text>
                    <Button
                        size='small'
                        icon={<RightOutlined />}
                        onClick={onNextBatch}
                        disabled={totalBatches === 0 || batchIndex >= totalBatches - 1}
                        className='cvat-multiframe-next-batch-btn'
                    >
                        Next Batch
                    </Button>
                </div>

                {/* Object Selector & Auto-Zoom Controls */}
                <div className='cvat-multiframe-object-group'>
                    <Text strong>Type:</Text>
                    <Select
                        size='small'
                        value={selectedTypeFilter}
                        onChange={(val: string) => {
                            setSelectedTypeFilter(val);
                            if (val !== 'all' && selectedObjectKey) {
                                const currentObj = selectableObjects.find((o) => o.key === selectedObjectKey);
                                if (currentObj && currentObj.shapeType !== val) {
                                    setSelectedObjectKey(null);
                                }
                            }
                        }}
                        style={{ width: 110 }}
                        className='cvat-multiframe-type-select'
                    >
                        <Select.Option value='all'>All Types</Select.Option>
                        {availableTypes.map((type) => (
                            <Select.Option key={type} value={type}>
                                {type.charAt(0).toUpperCase() + type.slice(1)}
                            </Select.Option>
                        ))}
                    </Select>

                    <Text strong>Object:</Text>
                    <Select
                        size='small'
                        showSearch
                        placeholder='Select by ID or label...'
                        value={selectedObjectKey}
                        onChange={(val: string | null) => setSelectedObjectKey(val || null)}
                        allowClear
                        filterOption={(input, option) => {
                            const children = String(option?.children || '').toLowerCase();
                            return children.includes(input.toLowerCase());
                        }}
                        style={{ minWidth: 200, maxWidth: 320 }}
                        className='cvat-multiframe-object-select'
                        disabled={filteredSelectableObjects.length === 0}
                    >
                        {filteredSelectableObjects.map((obj) => (
                            <Select.Option key={obj.key} value={obj.key}>
                                {obj.displayText}
                            </Select.Option>
                        ))}
                    </Select>
                    <Checkbox
                        checked={autoZoomEnabled}
                        onChange={(e) => setAutoZoomEnabled(e.target.checked)}
                        className='cvat-multiframe-autozoom-checkbox'
                    >
                        Auto-Zoom
                    </Checkbox>
                    <Checkbox
                        checked={autoFollowEnabled}
                        onChange={(e) => setAutoFollowEnabled(e.target.checked)}
                        className='cvat-multiframe-autofollow-checkbox'
                    >
                        Auto-Follow
                    </Checkbox>
                    <Checkbox
                        checked={focusModeEnabled}
                        onChange={(e) => setFocusModeEnabled(e.target.checked)}
                        className='cvat-multiframe-focus-mode-checkbox'
                    >
                        Focus Mode
                    </Checkbox>
                </div>

                {/* Right: Save and Exit buttons */}
                <div className='cvat-multiframe-exit-group'>
                    <Button
                        type='primary'
                        size='small'
                        icon={<SaveOutlined />}
                        loading={isSaving}
                        disabled={isSaving}
                        onClick={() => dispatch(saveAnnotationsAsync())}
                        className='cvat-multiframe-save-btn'
                        style={{ marginRight: 8, background: '#1890ff', borderColor: '#1890ff' }}
                    >
                        {isSaving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                        type='primary'
                        danger
                        size='small'
                        icon={<CloseOutlined />}
                        onClick={onClose}
                        className='cvat-multiframe-exit-btn'
                    >
                        Exit Multi-Frame
                    </Button>
                </div>
            </div>

            {/* Validation warning if custom range is invalid */}
            {!validation.isValid && validation.error && (
                <Alert
                    type='error'
                    showIcon
                    message={validation.error}
                    style={{ marginBottom: 10 }}
                    className='cvat-multiframe-error-alert'
                />
            )}

            {/* Multi-Frame Grid of Tiles or Loading State */}
            {!hasValidFrames ? (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Spin size='large' />
                    <div style={{ marginTop: 16 }}>
                        <Text type='secondary'>Loading job frame numbers...</Text>
                    </div>
                </div>
            ) : batchFrames.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', width: '100%' }}>
                    <Text type='secondary'>No valid frames found in range [{rangeStart} .. {rangeEnd}].</Text>
                </div>
            ) : (
                <div
                    className={`cvat-multiframe-grid ${focusModeEnabled ? 'cvat-multiframe-grid-focus-mode' : ''}`}
                    style={{
                        gridTemplateColumns: batchFrames.length < 4 ? `repeat(${Math.max(1, batchFrames.length)}, 1fr)` : undefined,
                    }}
                >
                    {batchFrames.map((frame) => (
                        <MultiframeTile
                            key={`frame_tile_${frame}`}
                            frameNumber={frame}
                            jobInstance={jobInstance}
                            isActiveFrame={frame === currentFrame}
                            selectedObject={selectedObject}
                            autoZoomEnabled={autoZoomEnabled}
                            autoFollowEnabled={autoFollowEnabled}
                            onNavigateToFrame={handleNavigateToFrame}
                            onZoomFrame={handleZoomFrame}
                            onFrameStatesLoaded={handleFrameStatesLoaded}
                            onSelectObject={handleTileSelectObject}
                        />
                    ))}
                </div>
            )}
                </>
            )}
        </div>
    );
}

export default React.memo(MultiframeWorkspaceView);
