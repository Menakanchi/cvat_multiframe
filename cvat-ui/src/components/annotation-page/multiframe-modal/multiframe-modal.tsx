// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';

import React from 'react';
import MultiframeConfigModal from './multiframe-config-modal';

interface Props {
    onConfirm?(startFrame: number, endFrame: number, frameCount?: number): void;
}

function MultiframeModal(props: Props): JSX.Element {
    const { onConfirm } = props;
    return <MultiframeConfigModal onConfirm={onConfirm} />;
}

export default React.memo(MultiframeModal);
