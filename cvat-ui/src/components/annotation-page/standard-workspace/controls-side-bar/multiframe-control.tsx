// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { useDispatch } from 'react-redux';
import { AppstoreOutlined } from '@ant-design/icons';
import CVATTooltip from 'components/common/cvat-tooltip';
import { switchShowMultiframeModal } from 'actions/annotation-actions';

export interface Props {
    shortcut?: string;
    disabled?: boolean;
}

function MultiframeControl(props: Props): JSX.Element {
    const { shortcut, disabled } = props;
    const dispatch = useDispatch();

    const title = shortcut ? `Multi-frame verification [${shortcut}]` : 'Multi-frame verification [Alt+M]';

    return disabled ? (
        <AppstoreOutlined className='cvat-multiframe-control cvat-disabled-canvas-control' />
    ) : (
        <CVATTooltip title={title} placement='right'>
            <AppstoreOutlined
                className='cvat-multiframe-control'
                onClick={(): void => {
                    dispatch(switchShowMultiframeModal(true));
                }}
            />
        </CVATTooltip>
    );
}

Object.assign(MultiframeControl, { displayName: 'MultiframeControl' });
export default React.memo(MultiframeControl);
