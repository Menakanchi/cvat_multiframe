// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Multi-Frame Modal Shell and Shortcut Verification (Milestone B1)', () => {
    const taskName = 'Multi-Frame Modal Test Task';
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

    it('TC 1: Alt+M opens the multi-frame modal', () => {
        cy.get('body').type('{alt}m');
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-modal .ant-modal-title').should('contain', 'Multi-Frame Verification');
    });

    it('TC 2: Escape closes the modal', () => {
        cy.get('body').type('{esc}');
        cy.get('.cvat-multiframe-modal').should('not.exist');
    });

    it('TC 3: Visible toolbar button opens the same modal', () => {
        cy.get('.cvat-player-multiframe-icon').should('be.visible').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');
    });

    it('TC 4: Cancel button closes the modal', () => {
        cy.get('.cvat-multiframe-cancel-btn').click();
        cy.get('.cvat-multiframe-modal').should('not.exist');
    });

    it('TC 5: Input focus suppresses the Alt+M shortcut', () => {
        cy.get('.cvat-player-frame-selector input').focus();
        cy.get('.cvat-player-frame-selector input').type('{alt}m');
        cy.get('.cvat-multiframe-modal').should('not.exist');
        cy.get('.cvat-player-frame-selector input').blur();
    });

    it('TC 6: Start and End frame range validation', () => {
        cy.get('.cvat-player-multiframe-icon').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');

        // Verify inputs exist
        cy.get('.cvat-multiframe-start-input input').should('exist');
        cy.get('.cvat-multiframe-end-input input').should('exist');

        // Test Start > End rejection
        cy.get('.cvat-multiframe-start-input input').clear().type('50');
        cy.get('.cvat-multiframe-end-input input').clear().type('10');
        cy.get('.cvat-multiframe-error-alert').should('be.visible');
        cy.get('.cvat-multiframe-apply-btn').should('be.disabled');

        // Restore valid range
        cy.get('.cvat-multiframe-start-input input').clear().type('0');
        cy.get('.cvat-multiframe-end-input input').clear().type('0');
        cy.get('.cvat-multiframe-error-alert').should('not.exist');
        cy.get('.cvat-multiframe-apply-btn').should('not.be.disabled');

        cy.get('.cvat-multiframe-cancel-btn').click();
        cy.get('.cvat-multiframe-modal').should('not.exist');
    });

    it('TC 7: Opening and closing the modal does not mark annotations unsaved or mutate state', () => {
        // Save button should remain disabled (no unsaved changes)
        cy.get('.cvat-save-annotations-button').should('be.disabled');

        // Open and close via trigger
        cy.get('.cvat-player-multiframe-icon').click();
        cy.get('.cvat-multiframe-modal').should('be.visible');
        cy.get('.cvat-multiframe-cancel-btn').click();
        cy.get('.cvat-multiframe-modal').should('not.exist');

        // Verify save button is still disabled
        cy.get('.cvat-save-annotations-button').should('be.disabled');
    });
});
