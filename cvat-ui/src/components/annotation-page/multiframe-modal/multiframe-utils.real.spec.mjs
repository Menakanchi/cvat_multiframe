// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/**
 * Tests for the ACTUAL implementation in multiframe-utils.ts (no copied functions).
 *
 * Run from the repository root:
 *   node cvat-ui/src/components/annotation-page/multiframe-modal/multiframe-utils.real.spec.mjs
 *
 * The TypeScript source is converted with Node's built-in `module.stripTypeScriptTypes`
 * (Node >= 22.13) or, if unavailable, with the `typescript` package from the repository.
 * The converted module is written to the OS temp directory (nothing is written to the repository).
 *
 * The job/ObjectState mock below reproduces the cvat-core semantics used by the deletion code:
 *  - ObjectState.delete(frame, force) removes the WHOLE object (all frames) and records 1 undo step
 *  - setting outside on a track frame creates a keyframe and records 1 undo step
 *    (for a Skeleton: one step for all landmarks)
 *  - setting keyframe records 1 undo step (2 for a Skeleton, see cvat-core skeleton-track.ts)
 *  - locked objects are not changed unless forced
 *  - history keeps at most 32 undo steps
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'multiframe-utils.ts');

async function loadUtils() {
    const source = fs.readFileSync(sourcePath, 'utf8');
    let code = null;
    if (typeof nodeModule.stripTypeScriptTypes === 'function') {
        code = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' });
    } else {
        const require = createRequire(import.meta.url);
        const ts = require('typescript');
        code = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        }).outputText;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-utils-'));
    const outFile = path.join(dir, 'multiframe-utils.mjs');
    fs.writeFileSync(outFile, code);
    try {
        return await import(pathToFileURL(outFile).href);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const U = await loadUtils();

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
}

// ---------------------------------------------------------------------------
// Minimal cvat-core-like job mock
// ---------------------------------------------------------------------------

const MAX_HISTORY = 32;

function createJob({ stopFrame = 30 } = {}) {
    const objects = [];
    const undo = [];
    const redo = [];
    let nextClientID = 1;

    function record(action, frame, undoFn, redoFn) {
        undo.push({ action, frame, undo: undoFn, redo: redoFn });
        while (undo.length > MAX_HISTORY) undo.shift();
        redo.length = 0;
    }

    function trackPosition(obj, frame) {
        const frames = Object.keys(obj.shapes).map(Number).sort((a, b) => a - b);
        const prev = frames.filter((f) => f <= frame).pop();
        if (prev === undefined) return null;
        const next = frames.find((f) => f > frame);
        const left = obj.shapes[prev];
        let points = [...left.points];
        // cvat-core interpolates towards the next keyframe even if it is outside (track.ts getPosition)
        if (next !== undefined && prev !== frame) {
            const right = obj.shapes[next];
            const t = (frame - prev) / (next - prev);
            points = left.points.map((v, i) => v + (right.points[i] - v) * t);
        }
        return {
            points,
            outside: left.outside,
            keyframe: prev === frame,
            keyframes: {
                first: frames[0],
                prev: frames.filter((f) => f < frame).pop() ?? null,
                next: next ?? null,
                last: frames[frames.length - 1],
            },
        };
    }

    function makeState(obj, frame) {
        let pending = {};
        const isSkeleton = obj.shapeType === 'skeleton';
        if (obj.objectType === 'shape') {
            if (obj.frame !== frame) return null;
            const state = {
                clientID: obj.clientID,
                serverID: obj.serverID,
                objectType: 'shape',
                shapeType: obj.shapeType,
                label: { name: obj.label },
                lock: obj.lock,
                outside: false,
                keyframe: true,
                parentID: null,
                group: obj.group,
                removed: false,
                points: [...obj.points],
                elements: (obj.elements || []).map((el) => ({ ...el, parentID: obj.clientID })),
                async delete(f, force = false) {
                    if (obj.lock && !force) return false;
                    obj.removed = true;
                    record('Removed object', f, () => { obj.removed = false; }, () => { obj.removed = true; });
                    return true;
                },
            };
            return state;
        }

        const pos = trackPosition(obj, frame);
        if (!pos) return null;
        const state = {
            clientID: obj.clientID,
            serverID: obj.serverID,
            objectType: 'track',
            shapeType: obj.shapeType,
            label: { name: obj.label },
            lock: obj.lock,
            parentID: null,
            removed: false,
            points: pos.points,
            keyframes: pos.keyframes,
            elements: isSkeleton ? [{ clientID: obj.clientID + 1000, parentID: obj.clientID }] : [],
            get outside() { return pending.outside ?? pos.outside; },
            set outside(value) { pending.outside = value; },
            get keyframe() { return pending.keyframe ?? pos.keyframe; },
            set keyframe(value) { pending.keyframe = value; },
            async delete(f, force = false) {
                if (obj.lock && !force) return false;
                obj.removed = true;
                record('Removed object', f, () => { obj.removed = false; }, () => { obj.removed = true; });
                return true;
            },
            async save() {
                if (obj.lock) return makeState(obj, frame);
                if (pending.keyframe === true && !pos.keyframe) {
                    const before = obj.shapes[frame];
                    const after = { points: [...pos.points], outside: pos.outside };
                    obj.shapes[frame] = after;
                    const steps = isSkeleton ? 2 : 1;
                    for (let i = 0; i < steps; i++) {
                        record('Changed keyframe', frame,
                            () => { if (before) obj.shapes[frame] = before; else delete obj.shapes[frame]; },
                            () => { obj.shapes[frame] = after; });
                    }
                }
                if (typeof pending.outside === 'boolean') {
                    const before = obj.shapes[frame];
                    const after = { points: [...pos.points], outside: pending.outside };
                    obj.shapes[frame] = after;
                    record('Changed outside', frame,
                        () => { if (before) obj.shapes[frame] = before; else delete obj.shapes[frame]; },
                        () => { obj.shapes[frame] = after; });
                }
                pending = {};
                return makeState(obj, frame);
            },
        };
        return state;
    }

    const job = {
        stopFrame,
        objects,
        addShape(props) {
            const obj = {
                clientID: nextClientID++, serverID: null, objectType: 'shape', lock: false, removed: false,
                points: [0, 0, 10, 10], label: 'car', ...props,
            };
            objects.push(obj);
            return obj;
        },
        addTrack(props) {
            const obj = {
                clientID: nextClientID++, serverID: null, objectType: 'track', lock: false, removed: false,
                label: 'person', ...props,
            };
            objects.push(obj);
            return obj;
        },
        visible(obj, frame) {
            if (obj.removed) return false;
            const state = makeState(obj, frame);
            return Boolean(state && !state.outside);
        },
        position(obj, frame) {
            return trackPosition(obj, frame);
        },
        annotations: {
            async get(frame) {
                return objects.filter((o) => !o.removed).map((o) => makeState(o, frame)).filter(Boolean);
            },
        },
        actions: {
            async get() {
                return {
                    undo: undo.map((a) => [a.action, a.frame]),
                    redo: redo.map((a) => [a.action, a.frame]),
                };
            },
            async undo(count = 1) {
                for (let i = 0; i < count; i++) {
                    const a = undo.pop();
                    if (!a) break;
                    a.undo();
                    redo.push(a);
                }
            },
            async redo(count = 1) {
                for (let i = 0; i < count; i++) {
                    const a = redo.pop();
                    if (!a) break;
                    a.redo();
                    undo.push(a);
                }
            },
            async addUnrelatedChange(frame) {
                record('Changed label', frame, () => {}, () => {});
            },
        },
    };
    return job;
}

function snapshot(job, frames) {
    return job.objects.map((o) => ({
        clientID: o.clientID,
        removed: o.removed,
        visible: frames.map((f) => job.visible(o, f)),
        points: o.objectType === 'track' ? frames.map((f) => job.position(o, f)?.points ?? null) : o.points,
    }));
}

const ALL_FRAMES = Array.from({ length: 31 }, (_, i) => i);

console.log('=== Multi-Frame utils: actual implementation tests ===');

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

await test('Zoom: uses actual frame aspect ratio (4:3, 16:9, portrait)', () => {
    const fit43 = U.calculateExpandedFitDimensions(1200, 650, 1024, 768);
    assert.equal(fit43.isValid, true);
    assert.ok(Math.abs(fit43.width / fit43.height - 4 / 3) < 0.01);
    assert.ok(fit43.width <= 1200 && fit43.height <= 650);
    assert.equal(fit43.height, 650);

    const fit169 = U.calculateExpandedFitDimensions(1200, 650, 1920, 1080);
    assert.ok(Math.abs(fit169.width / fit169.height - 16 / 9) < 0.01);
    assert.ok(fit169.width <= 1200 && fit169.height <= 650);

    const portrait = U.calculateExpandedFitDimensions(1200, 650, 1080, 1920);
    assert.ok(Math.abs(portrait.width / portrait.height - 1080 / 1920) < 0.01);
    assert.equal(portrait.height, 650);
});

await test('Zoom: border chrome keeps the image area aspect ratio and fits the container', () => {
    const fit = U.calculateExpandedFitDimensions(1000, 500, 1600, 900, 5);
    assert.equal(fit.isValid, true);
    const inner = { w: fit.width - 5, h: fit.height - 5 };
    assert.ok(Math.abs(inner.w / inner.h - 16 / 9) < 0.01);
    assert.ok(fit.width <= 1000 && fit.height <= 500);
});

await test('Zoom: zero or invalid sizes are reported as invalid (no forced size)', () => {
    for (const args of [[0, 0, 1920, 1080], [800, 0, 1920, 1080], [800, 600, 0, 1080],
        [3, 3, 100, 100, 5], [NaN, 600, 1920, 1080], [800, 600, 1920, Infinity]]) {
        const fit = U.calculateExpandedFitDimensions(...args);
        assert.deepEqual(fit, { isValid: false, width: 0, height: 0 }, `args ${JSON.stringify(args)}`);
    }
});

// ---------------------------------------------------------------------------
// Object ID
// ---------------------------------------------------------------------------

await test('Object ID: strict parsing', () => {
    for (const bad of ['12abc', '10.7', '1e1', '-3', 'abc', '1 2', '#', 'track_', 'id:', '0x10']) {
        assert.equal(U.parseObjectIDInput(bad).status, 'INVALID', bad);
    }
    assert.equal(U.parseObjectIDInput('').status, 'EMPTY');
    assert.equal(U.parseObjectIDInput('   ').status, 'EMPTY');
    assert.deepEqual(U.parseObjectIDInput(' #12 '), { status: 'OK', id: 12, scope: 'any', objectType: null });
    assert.deepEqual(U.parseObjectIDInput('track_7'), { status: 'OK', id: 7, scope: 'client', objectType: 'track' });
    assert.deepEqual(U.parseObjectIDInput('Shape_7'), { status: 'OK', id: 7, scope: 'client', objectType: 'shape' });
    assert.deepEqual(U.parseObjectIDInput('id:42'), { status: 'OK', id: 42, scope: 'server', objectType: null });
});

const skeleton = {
    clientID: 10, serverID: 5, objectType: 'track', shapeType: 'skeleton', parentID: null, label: { name: 'mattrai' },
    elements: [{ clientID: 11, serverID: 1011, parentID: 10 }, { clientID: 12, serverID: 1012, parentID: 10 }],
};
const rect = {
    clientID: 5, serverID: 77, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'car' },
};
const removedPoly = {
    clientID: 30, serverID: 300, objectType: 'shape', shapeType: 'polygon', parentID: null, removed: true,
};
const states = [skeleton, rect, removedPoly];

await test('Object ID: ambiguous client/server IDs are detected', () => {
    const res = U.resolveObjectByIDAndType('5', 'all', states);
    assert.equal(res.status, 'AMBIGUOUS');
    assert.equal(res.matchedObject, null);
    assert.equal(res.candidates.length, 2);
});

await test('Object ID: ambiguity resolved by label (object type) filter or explicit prefix', () => {
    assert.equal(U.resolveObjectByIDAndType('5', 'car', states).resolvedID, 5);
    assert.equal(U.resolveObjectByIDAndType('5', 'mattrai', states).resolvedID, 10);
    assert.equal(U.resolveObjectByIDAndType('5', 'mattrai', states).message, 'track_10 (server ID 5) [mattrai, Skeleton]');
    assert.equal(U.resolveObjectByIDAndType('shape_5', 'all', states).resolvedID, 5);
    assert.equal(U.resolveObjectByIDAndType('id:5', 'all', states).resolvedID, 10);
    assert.equal(U.resolveObjectByIDAndType('track_5', 'all', states).status, 'NOT_FOUND');
});

await test('Object ID: Skeleton landmark IDs resolve to the parent Skeleton', () => {
    for (const input of ['11', 'id:1012', '#12']) {
        const res = U.resolveObjectByIDAndType(input, 'all', states);
        assert.equal(res.status, 'VALID', input);
        assert.equal(res.resolvedID, 10);
        assert.equal(res.isSkeleton, true);
        assert.equal(res.matchedKey, 'track_10');
    }
    // flattened child states also resolve to the parent
    const flat = [...states, { clientID: 11, serverID: 1011, parentID: 10, shapeType: 'points' }];
    assert.equal(U.resolveObjectByIDAndType('11', 'mattrai', flat).resolvedID, 10);
});

await test('Object ID: label mismatch, not found, invalid and removed objects', () => {
    const mismatch = U.resolveObjectByIDAndType('10', 'matphai', states);
    assert.equal(mismatch.status, 'LABEL_MISMATCH');
    assert.equal(mismatch.message, 'ID 10 is mattrai, but the type filter is matphai');
    // shape type names are not object types
    assert.equal(U.resolveObjectByIDAndType('10', 'skeleton', states).status, 'LABEL_MISMATCH');
    assert.equal(U.resolveObjectByIDAndType('999', 'all', states).status, 'NOT_FOUND');
    assert.equal(U.resolveObjectByIDAndType('12abc', 'all', states).status, 'INVALID');
    assert.equal(U.resolveObjectByIDAndType('30', 'all', states).status, 'NOT_FOUND');
    assert.equal(U.getObjectInputKey(skeleton), 'track_10');
    assert.equal(U.getObjectInputKey(rect), 'shape_5');
});

// ---------------------------------------------------------------------------
// Object filter modes (Type mode and ID mode are mutually exclusive, read-only)
// ---------------------------------------------------------------------------

await test('Filter modes: Type mode and ID mode are mutually exclusive', () => {
    assert.deepEqual(U.EMPTY_OBJECT_FILTER, { mode: 'none', label: 'all', idInput: '' });

    const typeMode = U.selectTypeFilter('mattrai');
    assert.deepEqual(typeMode, { mode: 'type', label: 'mattrai', idInput: '' });

    // switching to ID mode resets the type
    const idMode = U.enterIDFilter('track_10');
    assert.deepEqual(idMode, { mode: 'id', label: 'all', idInput: 'track_10' });

    // switching back to Type mode clears the ID
    assert.deepEqual(U.selectTypeFilter('matphai'), { mode: 'type', label: 'matphai', idInput: '' });

    // never both: every reachable state has at most one active filter
    for (const st of [typeMode, idMode, U.selectTypeFilter('a'), U.enterIDFilter('12')]) {
        assert.ok(!(st.label !== 'all' && st.idInput !== ''), JSON.stringify(st));
    }
});

await test('Filter modes: "All Types" and an empty ID clear the filter', () => {
    assert.deepEqual(U.selectTypeFilter('all'), U.EMPTY_OBJECT_FILTER);
    assert.deepEqual(U.selectTypeFilter(''), U.EMPTY_OBJECT_FILTER);
    assert.deepEqual(U.selectTypeFilter(null), U.EMPTY_OBJECT_FILTER);
    assert.deepEqual(U.enterIDFilter(''), U.EMPTY_OBJECT_FILTER);
    assert.deepEqual(U.enterIDFilter('   '), U.EMPTY_OBJECT_FILTER);
    // the raw text is kept while typing in ID mode
    assert.equal(U.enterIDFilter(' 12').idInput, ' 12');
    // returned objects are fresh copies (no shared mutable state)
    assert.notEqual(U.selectTypeFilter('all'), U.EMPTY_OBJECT_FILTER);
});

const frameA = [
    {
        clientID: 1, objectType: 'track', shapeType: 'skeleton', parentID: null, label: { name: 'mattrai' },
        elements: [{ clientID: 2, parentID: 1, label: { id: 71, name: 'eye-corner' } }],
    },
    { clientID: 2, objectType: 'track', shapeType: 'points', parentID: 1, label: { name: 'mattrai' } },
    {
        clientID: 3, objectType: 'track', shapeType: 'skeleton', parentID: null, label: { name: 'matphai' },
        elements: [],
    },
    {
        clientID: 4, objectType: 'track', shapeType: 'skeleton', parentID: null, label: { name: 'mattrai' },
        outside: true, elements: [],
    },
    { clientID: 5, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'a' } },
    {
        clientID: 6, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'mattrai' },
        removed: true,
    },
];

await test('Type mode: shows only visible top-level objects of the type, landmarks stay in their Skeleton', () => {
    assert.deepEqual(U.getTypeFilterMatches(frameA, 'mattrai').map((s) => s.clientID), [1]);
    assert.deepEqual(U.getTypeFilterMatches(frameA, 'matphai').map((s) => s.clientID), [3]);
    assert.deepEqual(U.getTypeFilterMatches(frameA, 'a').map((s) => s.clientID), [5]);
    // a frame without objects of the type reports no matches (shown as "None"), nothing is created
    assert.deepEqual(U.getTypeFilterMatches(frameA, 'unknown'), []);
    assert.deepEqual(U.getTypeFilterMatches(frameA, 'all'), []);
    assert.deepEqual(U.getTypeFilterMatches(null, 'mattrai'), []);
});

await test('Type mode zoom: the view fits the union of all objects of the type on the frame', () => {
    const states = [
        { clientID: 1, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'eye' },
            points: [100, 200, 150, 260] },
        { clientID: 2, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'eye' },
            points: [400, 210, 460, 250] },
        { clientID: 3, objectType: 'shape', shapeType: 'rectangle', parentID: null, label: { name: 'mouth' },
            points: [900, 900, 1000, 1000] },
    ];
    const before = JSON.stringify(states);
    const matches = U.getTypeFilterMatches(states, 'eye');
    const union = U.getTypeFilterBoundingBox(matches, states);
    assert.deepEqual(union, { xtl: 100, ytl: 200, xbr: 460, ybr: 260 });

    // the auto-zoom viewport contains every matched object and keeps the image aspect ratio
    const vp = U.calculateAutoZoomViewport(union, 1920, 1080);
    assert.ok(vp.x <= 100 && vp.y <= 200 && vp.x + vp.width >= 460 && vp.y + vp.height >= 260);
    assert.ok(vp.width < 1920, 'the view is zoomed in');
    assert.ok(Math.abs(vp.width / vp.height - 1920 / 1080) < 0.01, 'aspect ratio preserved');

    // the object of another type is not part of the zoom target
    assert.ok(union.xbr < 900);
    // view only: annotation coordinates are unchanged
    assert.equal(JSON.stringify(states), before);
});

await test('Type mode zoom: frames without objects of the type keep the full view', () => {
    assert.equal(U.getTypeFilterBoundingBox([], []), null);
    assert.equal(U.getTypeFilterBoundingBox(null, []), null);
    // an object without measurable geometry is skipped
    assert.equal(U.getTypeFilterBoundingBox([{ clientID: 9, shapeType: 'polygon', points: [] }], []), null);
});

await test('ID mode: CVAT identity is used, equal server IDs on other objects are not matched', () => {
    const track = {
        clientID: 1, serverID: 900, objectType: 'track', shapeType: 'skeleton', parentID: null,
    };
    // another frame: a different object that happens to share the server ID
    const otherFrame = [{ clientID: 44, serverID: 900, objectType: 'shape', shapeType: 'skeleton', parentID: null }];
    assert.equal(U.resolveCrossFrameIdentity(track, otherFrame).status, 'ABSENT_ON_FRAME');
    assert.equal(U.resolveCrossFrameIdentity(track, frameA).status, 'MATCHED');
    assert.equal(U.resolveCrossFrameIdentity(track, frameA).matchedClientID, 1);
    // an outside track is reported as absent, not shown
    assert.equal(U.resolveCrossFrameIdentity({ ...track, clientID: 4 }, frameA).status, 'ABSENT_ON_FRAME');
});

await test('ID mode: a landmark is matched only inside its own parent Skeleton', () => {
    const landmark = { clientID: 2, objectType: 'track', parentID: 1, label: { id: 71 } };
    const res = U.resolveCrossFrameIdentity(landmark, frameA);
    assert.equal(res.status, 'MATCHED');
    assert.equal(res.targetState.clientID, 1);
    // the same sublabel inside a different Skeleton is never used
    const otherSkeletonOnly = [{
        clientID: 9, objectType: 'track', shapeType: 'skeleton', parentID: null,
        elements: [{ clientID: 10, parentID: 9, label: { id: 71 } }],
    }];
    assert.equal(U.resolveCrossFrameIdentity(landmark, otherSkeletonOnly).status, 'SKELETON_ABSENT');
});

await test('ID mode: a shape is shown on its own frame and never linked to other frames', () => {
    const shape = { clientID: 5, objectType: 'shape', shapeType: 'rectangle', parentID: null };
    const own = U.resolveCrossFrameIdentity(shape, frameA);
    assert.equal(own.status, 'MATCHED');
    assert.equal(own.matchedClientID, 5);
    const elsewhere = [{ clientID: 50, serverID: 5, objectType: 'shape', shapeType: 'rectangle', parentID: null }];
    assert.equal(U.resolveCrossFrameIdentity(shape, elsewhere).status, 'NO_IDENTITY');
    // a removed shape is not shown
    const removed = { clientID: 6, objectType: 'shape', shapeType: 'rectangle', parentID: null };
    assert.equal(U.resolveCrossFrameIdentity(removed, frameA).status, 'NO_IDENTITY');
});

await test('Filtering is read-only: annotation states are never modified', () => {
    const before = JSON.stringify(frameA);
    U.getTypeFilterMatches(frameA, 'mattrai');
    U.resolveCrossFrameIdentity(frameA[0], frameA);
    U.resolveCrossFrameIdentity({ clientID: 2, objectType: 'track', parentID: 1, label: { id: 71 } }, frameA);
    U.resolveObjectByIDAndType('track_1', 'all', frameA);
    assert.equal(JSON.stringify(frameA), before);
});

await test('Deletion in ID mode ignores the type, in Type mode ignores IDs', async () => {
    const job = createJob();
    const left = job.addShape({ frame: 3, shapeType: 'skeleton', label: 'mattrai' });
    const right = job.addShape({ frame: 3, shapeType: 'skeleton', label: 'matphai' });
    const idFilter = U.enterIDFilter(`shape_${right.clientID}`);
    const resolved = U.resolveObjectByIDAndType(idFilter.idInput, 'all', await job.annotations.get(3));
    const idPlan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 1, endFrame: 5, stopFrame: 30,
        targetLabel: idFilter.label, targetClientID: resolved.resolvedID,
    });
    assert.deepEqual(idPlan.targets.map((t) => t.clientID), [right.clientID]);

    const typeFilter = U.selectTypeFilter('mattrai');
    const typePlan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 1, endFrame: 5, stopFrame: 30, targetLabel: typeFilter.label,
    });
    assert.deepEqual(typePlan.targets.map((t) => t.clientID), [left.clientID]);
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

await test('Deletion: only matching shapes inside the inclusive range; locked skipped', async () => {
    const job = createJob();
    const r5 = job.addShape({ frame: 5, shapeType: 'rectangle' });
    const r6 = job.addShape({ frame: 6, shapeType: 'rectangle' });
    const r7 = job.addShape({ frame: 7, shapeType: 'rectangle' });
    const r4 = job.addShape({ frame: 4, shapeType: 'rectangle' });
    const poly = job.addShape({ frame: 5, shapeType: 'polygon', label: 'bus' });
    const locked = job.addShape({ frame: 6, shapeType: 'rectangle', lock: true });

    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 5, endFrame: 6, stopFrame: 30, targetLabel: 'car',
    });
    assert.equal(plan.isValid, true);
    assert.deepEqual(plan.targets.map((t) => t.clientID), [r5.clientID, r6.clientID]);
    assert.deepEqual(plan.skippedLocked.map((s) => s.key), [`shape_${locked.clientID}`]);
    assert.equal(plan.totalHistorySteps, 2);

    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.deletedObjects, 2);
    assert.equal(result.historySteps, 2);
    assert.deepEqual(result.affectedFrames, [5, 6]);
    assert.equal(r5.removed, true);
    assert.equal(r6.removed, true);
    for (const kept of [r7, r4, poly, locked]) assert.equal(kept.removed, false);
});

await test('Deletion: a track visible outside the range is hidden ONLY inside the range', async () => {
    const job = createJob();
    const track = job.addTrack({
        shapeType: 'rectangle',
        shapes: { 0: { points: [0, 0, 10, 10], outside: false }, 10: { points: [100, 0, 110, 10], outside: false } },
    });
    const before = snapshot(job, ALL_FRAMES);

    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 3, endFrame: 6, stopFrame: 30, targetLabel: 'all',
    });
    assert.equal(plan.targets.length, 1);
    assert.equal(plan.targets[0].mode, 'hide-track-range');
    assert.equal(plan.targets[0].freezeFrame, 7);
    assert.equal(plan.totalHistorySteps, 2); // keyframe at 7 + outside at 3

    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.hiddenTracks, 1);
    assert.equal(result.deletedObjects, 0);
    assert.equal(result.historySteps, 2);
    assert.equal(track.removed, false, 'track identity is kept');
    for (const f of ALL_FRAMES) {
        const expectedVisible = f < 3 || f > 6;
        assert.equal(job.visible(track, f), expectedVisible, `frame ${f}`);
    }
    // geometry outside the range is unchanged
    const after = snapshot(job, ALL_FRAMES)[0];
    for (const f of ALL_FRAMES.filter((v) => v < 3 || v > 6)) {
        after.points[f].forEach((value, idx) => {
            assert.ok(Math.abs(value - before[0].points[f][idx]) < 1e-9, `points on frame ${f}`);
        });
    }

    // native undo of exactly the recorded steps restores everything
    await job.actions.undo(result.historySteps);
    assert.deepEqual(snapshot(job, ALL_FRAMES), before);
    await job.actions.redo(result.historySteps);
    assert.equal(job.visible(track, 4), false);
    assert.equal(job.visible(track, 8), true);
});

await test('Deletion: keyframes inside the range are hidden too (no reappearing track)', async () => {
    const job = createJob();
    const track = job.addTrack({
        shapeType: 'rectangle',
        shapes: {
            0: { points: [0, 0, 1, 1], outside: false },
            4: { points: [4, 0, 5, 1], outside: false },
            6: { points: [6, 0, 7, 1], outside: false },
            20: { points: [20, 0, 21, 1], outside: false },
        },
    });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 2, endFrame: 8, stopFrame: 30, targetLabel: 'person',
    });
    assert.equal(plan.targets[0].historySteps, 4); // freeze 9 + outside at 2, 4, 6
    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.historySteps, plan.totalHistorySteps);
    for (let f = 2; f <= 8; f++) assert.equal(job.visible(track, f), false, `frame ${f}`);
    for (const f of [0, 1, 9, 15, 20, 30]) assert.equal(job.visible(track, f), true, `frame ${f}`);
});

await test('Deletion: polygon tracks report frames whose non-linear interpolation may shift', async () => {
    const job = createJob();
    job.addTrack({
        shapeType: 'polygon',
        shapes: {
            0: { points: [0, 0, 5, 0, 5, 5], outside: false },
            20: { points: [10, 0, 15, 0, 15, 5], outside: false },
            30: { points: [10, 0, 15, 0, 15, 5], outside: false },
        },
    });
    job.addTrack({
        shapeType: 'rectangle',
        shapes: { 0: { points: [0, 0, 1, 1], outside: false }, 20: { points: [5, 0, 6, 1], outside: false } },
    });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 5, endFrame: 8, stopFrame: 30, targetLabel: 'all',
    });
    const polygon = plan.targets.find((t) => t.shapeType === 'polygon');
    const rectangle = plan.targets.find((t) => t.shapeType === 'rectangle');
    assert.deepEqual(polygon.interpolationWarning, [[1, 4], [10, 19]]);
    assert.equal(rectangle.interpolationWarning, null, 'linear interpolation keeps geometry exactly');
});

await test('Deletion: a track visible only inside the range is deleted as one object', async () => {
    const job = createJob();
    const track = job.addTrack({
        shapeType: 'rectangle',
        shapes: { 5: { points: [0, 0, 1, 1], outside: false }, 9: { points: [0, 0, 1, 1], outside: true } },
    });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 4, endFrame: 10, stopFrame: 30, targetLabel: 'all',
    });
    assert.equal(plan.targets[0].mode, 'delete-track');
    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.deletedObjects, 1);
    assert.equal(track.removed, true);
    await job.actions.undo(result.historySteps);
    assert.equal(track.removed, false);
});

await test('Deletion: locked tracks and outside states are not targeted', async () => {
    const job = createJob();
    const lockedTrack = job.addTrack({
        shapeType: 'rectangle', lock: true, shapes: { 0: { points: [0, 0, 1, 1], outside: false } },
    });
    const outsideTrack = job.addTrack({
        shapeType: 'rectangle',
        shapes: { 0: { points: [0, 0, 1, 1], outside: false }, 3: { points: [0, 0, 1, 1], outside: true },
            12: { points: [0, 0, 1, 1], outside: false } },
    });
    const before = snapshot(job, ALL_FRAMES);
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 5, endFrame: 8, stopFrame: 30, targetLabel: 'all',
    });
    assert.equal(plan.targets.length, 0);
    assert.equal(plan.isValid, false);
    assert.equal(plan.skippedLocked[0].key, `track_${lockedTrack.clientID}`);
    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(snapshot(job, ALL_FRAMES), before);
    assert.equal(outsideTrack.removed, false);
});

await test('Deletion: Skeleton by landmark ID deletes the whole Skeleton, never group-sharing objects', async () => {
    const job = createJob();
    const sk = job.addShape({
        frame: 5, shapeType: 'skeleton', group: { id: 9 },
        elements: [{ clientID: 501, serverID: 9001 }, { clientID: 502, serverID: 9002 }],
    });
    const groupRect = job.addShape({ frame: 5, shapeType: 'rectangle', group: { id: 9 } });
    const frameStates = await job.annotations.get(5);
    const resolved = U.resolveObjectByIDAndType('id:9002', 'all', frameStates);
    assert.equal(resolved.status, 'VALID');
    assert.equal(resolved.resolvedID, sk.clientID);

    const plan = await U.planAnnotationDeletion({
        jobInstance: job,
        startFrame: 5,
        endFrame: 5,
        stopFrame: 30,
        targetLabel: 'all',
        targetClientID: resolved.resolvedID,
    });
    assert.deepEqual(plan.targets.map((t) => t.clientID), [sk.clientID]);
    await U.executeAnnotationDeletion(job, plan);
    assert.equal(sk.removed, true);
    assert.equal(groupRect.removed, false);
});

await test('Deletion: Skeleton track hidden in range uses 2 steps for the keyframe freeze', async () => {
    const job = createJob();
    const skTrack = job.addTrack({
        shapeType: 'skeleton', label: 'mattrai', shapes: { 0: { points: [0, 0], outside: false } },
    });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 10, endFrame: 12, stopFrame: 30, targetLabel: 'mattrai',
    });
    assert.equal(plan.targets[0].mode, 'hide-track-range');
    assert.equal(plan.totalHistorySteps, 3);
    const before = snapshot(job, ALL_FRAMES);
    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.historySteps, 3);
    assert.equal(job.visible(skTrack, 11), false);
    assert.equal(job.visible(skTrack, 13), true);
    await job.actions.undo(result.historySteps);
    assert.deepEqual(snapshot(job, ALL_FRAMES), before);
});

await test('Deletion: refuses plans that cannot be fully undone (CVAT keeps 32 steps)', async () => {
    const job = createJob();
    for (let f = 0; f <= 20; f++) {
        job.addShape({ frame: f, shapeType: 'rectangle' });
        job.addShape({ frame: f, shapeType: 'rectangle' });
    }
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 0, endFrame: 20, stopFrame: 30, targetLabel: 'car',
    });
    assert.equal(plan.totalHistorySteps, 42);
    assert.equal(plan.exceedsHistoryLimit, true);
    assert.equal(plan.isValid, false);
    const result = await U.executeAnnotationDeletion(job, plan);
    assert.equal(result.deletedObjects, 0);
    assert.ok(job.objects.every((o) => !o.removed));
});

await test('Deletion: the label filter targets only objects of that object type', async () => {
    const job = createJob();
    const left = job.addShape({ frame: 3, shapeType: 'skeleton', label: 'mattrai' });
    const right = job.addShape({ frame: 3, shapeType: 'skeleton', label: 'matphai' });
    const box = job.addShape({ frame: 3, shapeType: 'rectangle', label: 'a' });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 1, endFrame: 5, stopFrame: 30, targetLabel: 'mattrai',
    });
    assert.deepEqual(plan.targets.map((t) => t.clientID), [left.clientID]);
    assert.equal(plan.targetLabel, 'mattrai');
    await U.executeAnnotationDeletion(job, plan);
    assert.equal(left.removed, true);
    assert.equal(right.removed, false);
    assert.equal(box.removed, false);
    const byShapeType = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 1, endFrame: 5, stopFrame: 30, targetLabel: 'skeleton',
    });
    assert.equal(byShapeType.targets.length, 0, 'shape type names are not object types');
});

await test('Deletion: invalid ranges are rejected', async () => {
    const job = createJob();
    const base = { jobInstance: job, stopFrame: 30, targetLabel: 'all' };
    assert.equal((await U.planAnnotationDeletion({ ...base, startFrame: 6, endFrame: 5 })).isValid, false);
    assert.equal((await U.planAnnotationDeletion({ ...base, startFrame: 1.5, endFrame: 5 })).isValid, false);
    assert.equal((await U.planAnnotationDeletion({ ...base, startFrame: 1, endFrame: 31 })).isValid, false);
    const noJob = await U.planAnnotationDeletion({ ...base, jobInstance: null, startFrame: 1, endFrame: 2 });
    assert.equal(noJob.isValid, false);
});

await test('Undo/Redo batch: allowed only while the deletion steps are on top of the history', async () => {
    const job = createJob();
    job.addShape({ frame: 1, shapeType: 'rectangle' });
    job.addShape({ frame: 2, shapeType: 'rectangle' });
    const plan = await U.planAnnotationDeletion({
        jobInstance: job, startFrame: 1, endFrame: 2, stopFrame: 30, targetLabel: 'all',
    });
    const result = await U.executeAnnotationDeletion(job, plan);
    const h1 = await job.actions.get();
    const entries = h1.undo.slice(-result.historySteps);
    assert.equal(U.canUndoDeletionBatch(h1, entries, result.historySteps), true);
    assert.equal(U.canRedoDeletionBatch(h1, entries, result.historySteps), false);

    await job.actions.undo(result.historySteps);
    const h2 = await job.actions.get();
    assert.equal(U.canUndoDeletionBatch(h2, entries, result.historySteps), false);
    assert.equal(U.canRedoDeletionBatch(h2, entries, result.historySteps), true);

    await job.actions.redo(result.historySteps);
    await job.actions.addUnrelatedChange(3);
    const h3 = await job.actions.get();
    assert.equal(U.canUndoDeletionBatch(h3, entries, result.historySteps), false, 'blocked after other changes');
});

await test('Multi-Frame range: at most 10 frames, centered default, bounded editing and window shift', async () => {
    const frames = Array.from({ length: 31 }, (_, i) => i); // 0..30
    assert.equal(U.MAX_MULTIFRAME_FRAMES, 10);

    // default: 10 frames around the current frame
    assert.deepEqual(U.getDefaultFrameRange(15, 0, 30, frames, U.MAX_MULTIFRAME_FRAMES), [10, 19]);
    assert.deepEqual(U.getDefaultFrameRange(0, 0, 30, frames, U.MAX_MULTIFRAME_FRAMES), [0, 9]);
    assert.deepEqual(U.getDefaultFrameRange(30, 0, 30, frames, U.MAX_MULTIFRAME_FRAMES), [21, 30]);

    // more than 10 frames is invalid
    assert.equal(U.validateMultiframeRange(0, 9, 0, 30, frames).isValid, true);
    assert.equal(U.validateMultiframeRange(0, 15, 0, 30, frames).isValid, false);

    // the edited bound is kept, the other one follows
    assert.deepEqual(U.limitFrameRange(0, 15, 'end', frames), [6, 15]);
    assert.deepEqual(U.limitFrameRange(0, 15, 'start', frames), [0, 9]);
    assert.deepEqual(U.limitFrameRange(3, 8, 'start', frames), [3, 8]);

    // sparse job frames: limits count job frames, not frame numbers
    const sparse = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    assert.deepEqual(U.limitFrameRange(0, 55, 'start', sparse), [0, 45]);
    assert.equal(U.validateMultiframeRange(0, 45, 0, 55, sparse).isValid, true);

    // Prev / Next move the window by its own size, clamped to the job
    assert.deepEqual(U.shiftFrameWindow(10, 19, 1, frames), [20, 29]);
    assert.deepEqual(U.shiftFrameWindow(20, 29, 1, frames), [21, 30], 'window size is kept at the job end');
    assert.equal(U.shiftFrameWindow(21, 30, 1, frames), null);
    assert.deepEqual(U.shiftFrameWindow(10, 19, -1, frames), [0, 9]);
    assert.deepEqual(U.shiftFrameWindow(5, 14, -1, frames), [0, 9], 'window size is kept at the job start');
    assert.equal(U.shiftFrameWindow(0, 9, -1, frames), null);
});

await test('Multi-Frame setup: window of N frames from a start frame', async () => {
    const frames = Array.from({ length: 31 }, (_, i) => i); // 0..30
    assert.equal(U.MIN_MULTIFRAME_FRAMES, 2);
    assert.deepEqual(U.getFrameWindow(5, 10, frames), [5, 14]);
    assert.deepEqual(U.getFrameWindow(5, 2, frames), [5, 6]);
    assert.deepEqual(U.getFrameWindow(28, 10, frames), [21, 30], 'start moves back near the job end');
    const sparse = [0, 5, 10, 15, 20];
    assert.deepEqual(U.getFrameWindow(7, 2, sparse), [10, 15], 'start snaps to the next job frame');
    assert.deepEqual(U.getFrameWindow(0, 10, sparse), [0, 20], 'never more frames than the job has');
});

console.log(`\n=== ${passed} actual-implementation tests passed ===`);
