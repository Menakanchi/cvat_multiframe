// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React from 'react';
import Layout from 'antd/lib/layout';

import CanvasLayout from 'components/annotation-page/canvas/grid-layout/canvas-layout';
import ControlsSideBarContainer from 'containers/annotation-page/standard-workspace/controls-side-bar/controls-side-bar';
import CanvasContextMenuContainer from 'containers/annotation-page/canvas/canvas-context-menu';
import ObjectsListContainer from 'containers/annotation-page/standard-workspace/objects-side-bar/objects-list';
import ObjectSideBarComponent from 'components/annotation-page/standard-workspace/objects-side-bar/objects-side-bar';
import CanvasPointContextMenuComponent from 'components/annotation-page/canvas/views/canvas2d/canvas-point-context-menu';
import IssueAggregatorComponent from 'components/annotation-page/review/issues-aggregator';
import RemoveConfirmComponent from 'components/annotation-page/standard-workspace/remove-confirm';
import PropagateConfirmComponent from 'components/annotation-page/standard-workspace/propagate-confirm';
import BrushTools from 'components/annotation-page/canvas/views/canvas2d/brush-tools';
import MultiframeWorkspaceView from 'components/annotation-page/multiframe-modal/multiframe-workspace-view';
import AnnotationToolsSidebar from 'components/annotation-page/annotation-tools-sidebar/annotation-tools-sidebar';
import { useDispatch, useSelector } from 'react-redux';
import { CombinedState } from 'reducers';
import { activateMultiframeWorkspace } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';

export default function StandardWorkspaceComponent(): JSX.Element {
    const dispatch = useDispatch();
    const { multiframeActive, startFrame, endFrame, frameCount } = useSelector((state: CombinedState) => ({
        multiframeActive: state.annotation.multiframe.active,
        startFrame: state.annotation.multiframe.startFrame,
        endFrame: state.annotation.multiframe.endFrame,
        frameCount: state.annotation.multiframe.frameCount,
    }), shallowEqual);

    return (
        <Layout hasSider className='cvat-standard-workspace'>
            <ControlsSideBarContainer />
            {multiframeActive ? (
                <MultiframeWorkspaceView
                    onClose={() => dispatch(activateMultiframeWorkspace(false))}
                    initialStartFrame={startFrame ?? undefined}
                    initialEndFrame={endFrame ?? undefined}
                    initialFrameCount={frameCount ?? undefined}
                />
            ) : (
                <>
                    <CanvasLayout />
                    <BrushTools />
                </>
            )}
            <AnnotationToolsSidebar />
            <ObjectSideBarComponent objectsList={<ObjectsListContainer />} />
            <PropagateConfirmComponent />
            <CanvasContextMenuContainer />
            <CanvasPointContextMenuComponent />
            <IssueAggregatorComponent />
            <RemoveConfirmComponent />
        </Layout>
    );
}
