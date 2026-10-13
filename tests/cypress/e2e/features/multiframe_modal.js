// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Real Multi-Frame Annotation Viewer & Landmark Verification', () => {
    const taskName = 'Real Multi-Frame Viewer Test Task';
    const serverFiles = ['images/image_1.jpg'];
    let taskId = null;
    let jobId = null;

    before(() => {
        cy.visit('/auth/login');
        cy.login();
        cy.headlessCreateTask({
            labels: [{ name: 'face_point', attributes: [], type: 'points' }],
            name: taskName,
            project_id: null,
            source_storage: { location: 'local' },
            target_storage: { location: 'local' },
        }, {
            server_files: serverFiles,
            image_quality: 70,
            use_zip_chunks: true,
            use_cache: true,
            sorting_method: 'lexicographical',
        }).then((response) => {
            taskId = response.taskID;
            jobId = response.jobID;
            cy.openJob(jobId);
        });
    });

    after(() => {
        if (taskId) {
            cy.goToTaskList();
            cy.deleteTask(taskName, taskId);
        }
    });

    it('TC 1: Alt+M opens the real multi-frame viewer', () => {
        cy.get('body').type('{alt}m');
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-modal .ant-modal-title').should('contain', 'Multi-Frame Landmark Verification');
        cy.get('.cvat-multiframe-grid').should('be.visible');
        cy.get('.cvat-multiframe-tile').should('have.length.at.least', 1);
        cy.get('.cvat-multiframe-tile-active').should('exist');
    });

    it('TC 2: Escape closes the viewer', () => {
        cy.get('body').type('{esc}');
        cy.get('.cvat-multiframe-modal').should('not.exist');
    });

    it('TC 3: Visible toolbar button opens the same viewer', () => {
        cy.get('.cvat-player-multiframe-icon').should('be.visible').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-grid').should('be.visible');
    });

    it('TC 4: Close button closes the viewer', () => {
        cy.get('.cvat-multiframe-close-btn').click();
        cy.get('.cvat-multiframe-modal').should('not.exist');
    });

    it('TC 5: Input focus suppresses the Alt+M shortcut', () => {
        cy.get('.cvat-player-frame-selector input').focus();
        cy.get('.cvat-player-frame-selector input').type('{alt}m');
        cy.get('.cvat-multiframe-modal').should('not.exist');
        cy.get('.cvat-player-frame-selector input').blur();
    });

    it('TC 6: Displays real frame canvas tiles (up to 10) and SVG overlays', () => {
        cy.get('.cvat-player-multiframe-icon').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-tile').should('have.length.at.most', 10);
        cy.get('.cvat-multiframe-tile .cvat-multiframe-canvas').should('exist');
        cy.get('.cvat-multiframe-tile .cvat-multiframe-svg-overlay').should('exist');
        cy.get('.cvat-multiframe-close-btn').click();
    });

    it('TC 7: Opening and closing the viewer does not mark annotations unsaved or mutate state', () => {
        cy.get('.cvat-save-annotations-button').should('be.disabled');

        cy.get('.cvat-player-multiframe-icon').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-close-btn').click();
        cy.get('.cvat-multiframe-modal').should('not.exist');

        cy.get('.cvat-save-annotations-button').should('be.disabled');
    });
});
