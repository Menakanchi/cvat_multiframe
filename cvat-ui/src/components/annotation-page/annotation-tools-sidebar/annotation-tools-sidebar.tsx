// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, {
    useCallback, useEffect, useRef, useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Tabs from 'antd/lib/tabs';
import { ToolOutlined } from '@ant-design/icons';

import { CombinedState } from 'reducers';
import { collapseSidebar, switchShowMultiframeModal } from 'actions/annotation-actions';
import { shallowEqual } from 'utils/redux';
import MultiframeSidebarTab from 'components/annotation-page/multiframe-modal/multiframe-sidebar-tab';
import AnnotationDeletionPanel from 'components/annotation-page/annotation-deletion/annotation-deletion-panel';

type ToolsTab = 'multiframe' | 'delete';

const SIDEBAR_WIDTH = 360;
// Matches the width transition in styles.scss
const SIDEBAR_TRANSITION_MS = 200;

/** Right sidebar with the Multi-Frame and Delete tools, shown / hidden with a pull-out tab */
function AnnotationToolsSidebar(): JSX.Element {
    const dispatch = useDispatch();
    const { objectsSidebarCollapsed, openMultiframeRequested } = useSelector((state: CombinedState) => ({
        objectsSidebarCollapsed: state.annotation.sidebarCollapsed,
        // set by the Multi-Frame button of the controls sidebar and its shortcut
        openMultiframeRequested: state.annotation.multiframe.visible,
    }), shallowEqual);

    const [collapsed, setCollapsed] = useState<boolean>(true);
    const [activeTab, setActiveTab] = useState<ToolsTab>('multiframe');

    const setSidebarCollapsed = useCallback((value: boolean) => {
        // Only one right sidebar is open at a time: opening this one closes the objects sidebar
        if (!value && !objectsSidebarCollapsed) {
            dispatch(collapseSidebar());
        }
        setCollapsed(value);
        // let the canvas / Multi-Frame grid fit the new workspace width
        setTimeout(() => window.dispatchEvent(new Event('resize')), SIDEBAR_TRANSITION_MS + 50);
    }, [objectsSidebarCollapsed, dispatch]);

    // ... and opening the objects sidebar closes this one
    const prevObjectsSidebarCollapsed = useRef<boolean>(objectsSidebarCollapsed);
    useEffect(() => {
        if (prevObjectsSidebarCollapsed.current && !objectsSidebarCollapsed) {
            setCollapsed(true);
        }
        prevObjectsSidebarCollapsed.current = objectsSidebarCollapsed;
    }, [objectsSidebarCollapsed]);

    // The Multi-Frame button / shortcut opens this sidebar on the Multi-Frame tab
    useEffect(() => {
        if (openMultiframeRequested) {
            setActiveTab('multiframe');
            setSidebarCollapsed(false);
            dispatch(switchShowMultiframeModal(false));
        }
    }, [openMultiframeRequested]);

    return (
        <div
            className={`cvat-annotation-tools-sidebar ${collapsed ? 'cvat-annotation-tools-sidebar-collapsed' : ''}`}
            style={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
        >
            {/* Pull-out tab to show / hide the sidebar, like the objects sidebar collapser */}
            {/* eslint-disable-next-line */}
            <span
                className='cvat-annotation-tools-sider'
                onClick={() => setSidebarCollapsed(!collapsed)}
                title={collapsed ? 'Show Multi-Frame / Delete tools' : 'Hide Multi-Frame / Delete tools'}
            >
                <ToolOutlined />
            </span>

            {/* Always rendered (hidden when collapsed) so the Multi-Frame controls always have their container */}
            <div className='cvat-annotation-tools-sidebar-content' style={{ width: SIDEBAR_WIDTH }}>
                <Tabs
                    type='card'
                    activeKey={activeTab}
                    onChange={(key: string) => setActiveTab(key as ToolsTab)}
                    className='cvat-annotation-tools-sidebar-tabs'
                    items={[{
                        key: 'multiframe',
                        label: 'Multi-Frame',
                        forceRender: true,
                        children: <MultiframeSidebarTab />,
                    }, {
                        key: 'delete',
                        label: 'Delete',
                        forceRender: true,
                        children: <AnnotationDeletionPanel active={!collapsed && activeTab === 'delete'} />,
                    }]}
                />
            </div>
        </div>
    );
}

export default React.memo(AnnotationToolsSidebar);
