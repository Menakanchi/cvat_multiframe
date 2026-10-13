# A5 — CVAT State Management and Annotation Persistence Investigation

**Date:** 2026-10-13  
**Target Feature:** Multi-Frame Annotation & Object Verification for 2D Facial Landmarks  
**Active Branch:** `feature/multiframe-annotation`  
**Base Commit:** `0aabc9934`  
**Status:** Complete Investigation & Source-Verified Blueprint  

---

## 1. Investigation Scope and Methodology

This investigation examines the interaction between CVAT's Redux state management, in-memory annotation lifecycle (`cvat-core`), video decoding cache (`cvat-data`), and backend persistence mechanisms.

### Key Questions Investigated
1. **Redux vs. In-Memory State:** What is the authoritative source of truth for active player frames, object activation, and annotation geometry?
2. **Editing Lifecycle:** How do user modifications (dragging landmark vertices or modifying attributes) propagate through Redux, `cvat-canvas`, `cvat-core`, undo/redo stacks, and the backend?
3. **Persistence Tracking:** How does CVAT track dirty/unsaved changes, serialize objects, and reconcile `clientID` with database `serverID` upon save?
4. **Decoded Frame Ownership:** Does `frameData.data()` return an image resource owned by the caller or an internally cached reference managed by `FrameDecoder`? Can callers call `ImageBitmap.close()`?
5. **Shortcut Suppression Bounds:** Does `mousetrap-react.tsx` suppress shortcuts only on standard inputs (`INPUT`, `SELECT`, `TEXTAREA`) or across modals and other editable structures?

### Methodology
Every conclusion in this report is derived from direct source code inspection of:
- `cvat-ui/src/reducers/annotation-reducer.ts`
- `cvat-ui/src/actions/annotation-actions.ts`
- `cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx`
- `cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx`
- `cvat-ui/src/utils/mousetrap-react.tsx`
- `cvat-core/src/annotations-saver.ts`
- `cvat-core/src/annotations-collection.ts`
- `cvat-core/src/object-state.ts`
- `cvat-core/src/frames.ts`
- `cvat-data/src/ts/cvat-data.ts`

---

## 2. State Ownership and Data-Flow Diagram

In CVAT's frontend architecture, state is divided into three distinct layers:
1. **Redux Store (`cvat-ui`):** Manages UI session state, active controls, current player frame index, active object ID (`activatedStateID`), and temporary arrays of `ObjectState` for the current frame view.
2. **Core Domain Cache (`cvat-core`):** Maintains the full in-memory job session (`Job.annotations`), containing `AnnotationsCollection` (all tracks and shapes across the entire job), `AnnotationHistory` (undo/redo), and `AnnotationsSaver` (pending save tracking).
3. **Decoding Cache (`cvat-data`):** Manages raw compressed video chunks, WebAssembly/worker decoders, and decoded `ImageBitmap` LRU caches (`FrameDecoder`).

```mermaid
flowchart TD
    subgraph UI ["Layer 1: CVAT UI (React + Redux)"]
        UserDrag["User Drags Landmark Point"]
        CanvasView["CanvasView (cvat-canvas)\nEmits 'canvas.edited'"]
        CanvasWrapper["CanvasWrapper Component\nonCanvasEditDone()"]
        ReduxThunk["updateAnnotationsAsync(states)"]
        ReduxStore["Redux Annotation State\n- player.frame.number\n- activatedStateID\n- activatedElementID\n- states[]"]
    end

    subgraph Core ["Layer 2: CVAT Core (cvat-core Domain Model)"]
        ObjectStateWrapper["ObjectState.save()\nDelegates to __internal.save()"]
        SkeletonTrackModel["SkeletonTrack.save(frame, data)\nMutates this.elements[idx].shapes[frame]"]
        HistoryModel["AnnotationHistory.do()\nAppends action to undo stack"]
        SaverModel["AnnotationsSaver\n_getHash() differs from saved hash"]
    end

    subgraph Data ["Layer 3: CVAT Data (cvat-data Frame Decoder)"]
        FrameProvider["FrameDecoder (cvat-data)\nLRU Cache: decodedChunks[chunkIndex]"]
        ImageBitmapRef["ImageBitmap Reference (Owned by FrameDecoder)"]
    end

    subgraph Backend ["Layer 4: Backend (Django REST API + PostgreSQL)"]
        ServerAPI["PATCH /api/jobs/{id}/annotations\nPayload: SerializedCollection (IDs stripped)"]
        DB["PostgreSQL / SQLite Database\nGenerates permanent primary keys"]
    end

    UserDrag --> CanvasView
    CanvasView --> CanvasWrapper
    CanvasWrapper --> ReduxThunk
    ReduxThunk --> ObjectStateWrapper
    ObjectStateWrapper --> SkeletonTrackModel
    SkeletonTrackModel --> HistoryModel
    SkeletonTrackModel --> SaverModel
    ReduxThunk -->|If parentID !== null| ReduxStore

    SaverModel -.->|saveAnnotationsAsync()| ServerAPI
    ServerAPI --> DB
    DB --> ServerAPI
    ServerAPI -.->|updateFromServerResponse()| SkeletonTrackModel

    FrameProvider --> ImageBitmapRef
    ImageBitmapRef -.->|Shared Read-Only Ref| CanvasWrapper
```

---

## 3. Annotation Editing Lifecycle: Landmark Modification Trace

When an annotator selects and modifies a facial landmark vertex on the active canvas, the system executes the following deterministic 7-step sequence:

### Step 1: User Interaction on Canvas
* In [`cvat-canvas/src/typescript/canvasView.ts#L3939-L4000`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvasView.ts#L3939-L4000), mouse events on the landmark circle trigger dragging/resizing.
* When the drag completes, `canvasView` updates the SVG coordinates and dispatches the DOM event:
  ```ts
  this.canvas.dispatchEvent(new CustomEvent('canvas.edited', {
      detail: { state: elementState, points: [newX, newY], rotation: 0 },
  }));
  ```

### Step 2: Canvas Wrapper Event Interception
* In [`cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx#L927-L943`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx#L927-L943), `onCanvasEditDone` intercepts `canvas.edited`:
  ```ts
  state.points = points;
  onUpdateAnnotations([state]); // Dispatches updateAnnotationsAsync([state])
  ```

### Step 3: Redux Action & Core Delegation
* In [`cvat-ui/src/actions/annotation-actions.ts#L1269-L1311`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts#L1269-L1311), `updateAnnotationsAsync` executes:
  ```ts
  const promises = statesToSave.map((objectState) => objectState.save());
  let states = await Promise.all(promises);
  ```
* In [`cvat-core/src/object-state.ts#L564-L573`](file:///C:/Users/Menf/cvat/cvat-core/src/object-state.ts#L564-L573), `objectState.save()` calls `this.__internal.save(this.frame, this)`.
* For a landmark element, this invokes `SkeletonTrack.prototype.save(frame, data)` ([`cvat-core/src/annotations-objects/skeleton-track.ts#L263-L379`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/skeleton-track.ts#L263-L379)).

### Step 4: In-Memory Mutation & History Recording
* `SkeletonTrack.save` maps each affected child landmark track in `this.elements`.
* The child `Track` updates its shape dictionary: `element.shapes[frame].points = fittedPoints`.
* Undo/redo recording: `this.history.do(HistoryActions.CHANGED_POINTS, undoCallback, redoCallback, [clientID], frame)` pushes the previous and new coordinate arrays to `AnnotationHistory.undo`.
* Timestamps are updated: `element.updated = Date.now(); this.updated = Date.now();`.

### Step 5: Redux Re-synchronization for Composite Skeletons
* In [`cvat-ui/src/actions/annotation-actions.ts#L1296-L1301`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts#L1296-L1301):
  ```ts
  const needToUpdateAll = states
      .some((state) => state.shapeType === ShapeType.MASK || state.parentID !== null);
  if (needToUpdateAll) {
      dispatch(fetchAnnotationsAsync());
      return;
  }
  ```
* Because a facial landmark is a child element (`state.parentID !== null`), `needToUpdateAll` evaluates to `true`.
* `fetchAnnotationsAsync()` dispatches, querying `job.annotations.get(currentFrame)` to rebuild `state.annotations.states` so the parent skeleton's wrapping bounding box and all sibling elements reflect updated geometry.

### Step 6: Marking Pending Persistence
* In [`cvat-core/src/annotations-saver.ts#L570-L572`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-saver.ts#L570-L572):
  `hasUnsavedChanges()` compares `this._getHash()` against `this.hash`.
  Because `collection.export()` now reflects the new point coordinates, the hashes differ, and `job.annotations.hasUnsavedChanges()` returns `true`.
* The "Save" button in the top bar activates (changes color and enables click).

### Step 7: Saving to Server & Server Response Reconciliation
* When the user clicks "Save" or auto-save triggers, `saveAnnotationsAsync()` calls `jobInstance.annotations.save()`.
* `AnnotationsSaver.save()` serializes the collection, strips `clientID`, and sends the diff to `PATCH /api/jobs/{id}/annotations`.
* The backend returns saved models with database primary keys.
* `_updateSavedObjects()` updates `this._serverId` on the tracks while preserving the existing `clientID`.

---

## 4. Saving, Persistence, and Dirty-State Tracking

### 4.1 Manual vs. Automatic Saving
* **Manual Saving:**
  - Triggered via top bar button or keyboard shortcut (`Ctrl+S`).
  - Implemented in [`cvat-ui/src/actions/annotation-actions.ts#L1141-L1215`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts#L1141-L1215) (`saveAnnotationsAsync`).
* **Automatic Saving:**
  - Configured in [`cvat-ui/src/reducers/settings-reducer.ts#L32-L33`](file:///C:/Users/Menf/cvat/cvat-ui/src/reducers/settings-reducer.ts#L32-L33).
  - Default: `autoSave = false`, `autoSaveInterval = 15 * 60 * 1000` (15 minutes).
  - When enabled by the user in Settings, `top-bar.tsx#L300` registers `window.setInterval(this.autoSave, autoSaveInterval)`.
* **Conclusion:** Saving is strictly manual by default unless explicitly activated in user settings.

### 4.2 How Pending Changes Are Tracked
* Tracked via `AnnotationsSaver` in [`cvat-core/src/annotations-saver.ts#L570-L572`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-saver.ts#L570-L572):
  ```ts
  hasUnsavedChanges(): boolean {
      return this._getHash() !== this.hash;
  }
  ```
  `_getHash()` serializes `this.initialObjects` and the current collection using a normalized JSON serializer whitelist (`JSON_SERIALIZER_KEYS`) with sorted attributes and keyframes.

### 4.3 Navigating Away with Unsaved Changes
* Handled in [`cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx#L310-L325`](file:///C:/Users/Menf/cvat/cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx#L310-L325):
  - React Router block hook checks `jobInstance.annotations.hasUnsavedChanges()`.
  - Browser `beforeunload` event is registered.
  - If unsaved changes exist, navigation is blocked with a confirmation dialog: *"You have unsaved changes, please confirm leaving this page."*

### 4.4 Non-Mutating Nature of Frame Queries
* Calling `job.annotations.get(F, true)` executes `AnnotationsCollection.get(F)`.
* `AnnotationsCollection.get` only reads `this.tracks`, `this.shapes[F]`, and `this.tags[F]`.
* It does **not** modify `collection.export()`, does **not** touch `AnnotationsSaver.hash`, and does **not** call `this.history.do()`.
* **Confirmed Fact:** Reading annotations for other frames will **never** mark annotations as unsaved, trigger auto-save, or mutate annotation data.

---

## 5. `clientID` vs. `serverID` Lifecycle Matrix

| Stage | `clientID` Behavior | `serverID` Behavior | Notes |
| :--- | :--- | :--- | :--- |
| **Object Created in Session** | Assigned sequentially by `injection.nextClientID()` | `null` (or `undefined`) | ClientID is the unique in-memory key across all frames |
| **Modifying Landmarks** | Preserved without change | Preserved (`null` if unsaved, integer if saved) | Coordinate updates do not touch ID properties |
| **Preparing Save Payload** | Extracted into temporary `indexes` array; stripped from JSON payload | Maintained in payload for updated objects; stripped for created objects | Backend schema does not store `clientID` |
| **Server Response Received** | Preserved without change | Database integer PK assigned to `this._serverId` via `updateFromServerResponse` | Tracks retain invariant `clientID` before and after save |
| **Browser Refresh / Reload** | Regenerated sequentially from 1 based on loaded object order | Loaded from database integer PK | ClientID is session-scoped; serverID is database-scoped |

---

## 6. Resource Ownership & Read-Only Access Findings

### 6.1 `ImageBitmap` Ownership in `cvat-data`
Investigation of [`cvat-data/src/ts/cvat-data.ts#L84-L235`](file:///C:/Users/Menf/cvat/cvat-data/src/ts/cvat-data.ts#L84-L235) and [`cvat-core/src/frames.ts#L474-L621`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts#L474-L621) revealed a critical resource ownership contract:

```ts
// Inside FrameDecoder (cvat-data.ts)
frame(frameNumber: number): ImageBitmap | Blob | null {
    const chunkIndex = this.getChunkIndex(frameNumber);
    if (chunkIndex in this.decodedChunks) {
        return this.decodedChunks[chunkIndex][frameNumber]; // Returns cached reference
    }
    return null;
}
```

```ts
// Inside FrameDecoder.cleanup (cvat-data.ts)
for (const frame of Object.keys(this.decodedChunks[lastChunk])) {
    const data = this.decodedChunks[lastChunk][frame];
    if (data instanceof ImageBitmap) {
        data.close(); // FrameDecoder closes bitmaps upon LRU cache eviction
    }
}
```

**CRITICAL FINDING & CORRECTION TO A4:**
* When `frameData.data()` resolves with `{ imageData }`, `imageData` is an `ImageBitmap` returned directly from `FrameDecoder.decodedChunks`.
* **The `ImageBitmap` is owned by `FrameDecoder`, NOT by the caller.**
* `FrameDecoder` manages its own cache eviction and explicitly calls `data.close()` when chunks are evicted.
* **Correction:** Callers (such as our proposed Multi-Frame tile component) **MUST NEVER CALL `ImageBitmap.close()`**. Calling `close()` would close the shared cached bitmap inside `FrameDecoder`. If the main player subsequently attempts to display that frame, it would throw a `DOMException: The ImageBitmap is detached` or render a blank canvas!
* **Correct Practice:** The tile component should simply paint the bitmap to its local `<canvas>` via `ctx.drawImage(imageData, 0, 0)` and discard its local JavaScript reference, leaving buffer lifecycle management entirely to `FrameDecoder`.

### 6.2 Shortcut Suppression Scope in `mousetrap-react.tsx`
Inspection of [`cvat-ui/src/utils/mousetrap-react.tsx#L64-L92`](file:///C:/Users/Menf/cvat/cvat-ui/src/utils/mousetrap-react.tsx#L64-L92):
* **Element Types Suppressed:**
  - `element.tagName === 'INPUT'`
  - `element.tagName === 'SELECT'`
  - `element.tagName === 'TEXTAREA'`
* **Modal Overlay Suppression:**
  - If any `.ant-modal` element has `style.display !== 'none'`, all shortcuts are blocked except explicit modal closing sequences (`SWITCH_SHORTCUTS`, `SWITCH_SETTINGS`).
* **Uncovered Edge Cases:**
  - Elements with `contenteditable="true"` are **not** explicitly checked in `stopCallback`. If CVAT ever introduces a rich-text `contenteditable` container outside of `INPUT`/`TEXTAREA`, Mousetrap would not suppress shortcuts on it.
  - However, all CVAT annotation inputs (attribute editors, frame inputs, search boxes, label selectors) use standard Ant Design components that render `<input>`, `<select>`, or `<textarea>`.
  - Inside our `MultiframeModal`, the `.ant-modal` rule will automatically suppress background shortcuts while the modal is displayed.

---

## 7. Exact Source Files and Symbols Inspected

| File Path | Relevant Symbols & Line Ranges | Verified Architectural Role |
| :--- | :--- | :--- |
| [`cvat-ui/src/reducers/annotation-reducer.ts`](file:///C:/Users/Menf/cvat/cvat-ui/src/reducers/annotation-reducer.ts) | `updateActivatedStateID` (`#L33-L36`), `initialState` (`#L115-L165`), `CHANGE_FRAME_SUCCESS` (`#L387-L440`), `ACTIVATE_OBJECT` (`#L696-L721`) | Redux state shape, frame switching, and object activation |
| [`cvat-ui/src/actions/annotation-actions.ts`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts) | `activateObject` (`#L642-L664`), `saveAnnotationsAsync` (`#L1141-L1215`), `updateAnnotationsAsync` (`#L1269-L1311`) | Action dispatches for object updates, activation, and server persistence |
| [`cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx) | `onCanvasEditDone` (`#L927-L943`), `onUpdateAnnotations` (`#L325-L327`) | Event listener bridging canvas DOM edit events to Redux actions |
| [`cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx) | `autoSave` (`#L300`, `#L718-L725`), `beforeUnloadCallback` (`#L310-L325`) | Auto-save timer lifecycle and route navigation protection |
| [`cvat-ui/src/utils/mousetrap-react.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/utils/mousetrap-react.tsx) | `Mousetrap.prototype.stopCallback` (`#L64-L92`) | Global shortcut suppression for inputs and open modal dialogs |
| [`cvat-core/src/annotations-saver.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-saver.ts) | `hasUnsavedChanges` (`#L570-L572`), `save` (`#L385-L450`), `_extractClientIDs` (`#L358-L375`), `_updateSavedObjects` (`#L339-L356`) | Dirty hash comparison, serialization, and server ID reconciliation |
| [`cvat-core/src/annotations-collection.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-collection.ts) | `AnnotationsCollection.get` (`#L407-L448`) | In-memory frame queries with verified zero-mutation guarantees |
| [`cvat-core/src/frames.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts) | `frameDataCache` (`#L19-L41`), `getFrame` (`#L899-L995`), `FrameData.data()` (`#L458-L550`) | Job frame metadata caching and decoder invocation |
| [`cvat-data/src/ts/cvat-data.ts`](file:///C:/Users/Menf/cvat/cvat-data/src/ts/cvat-data.ts) | `FrameDecoder` (`#L84-L127`), `cleanup` (`#L137-L157`), `frame` (`#L228-L235`), `startDecode` (`#L267-L335`) | Internal `decodedChunks` cache management and bitmap ownership |

---

## 8. Confirmed Facts versus Assumptions

| Item | Initial Assumption | Source-Verified Fact |
| :--- | :--- | :--- |
| **`ImageBitmap` Disposal** | Caller should call `bitmap.close()` when tile unmounts | **WRONG (Risk):** `ImageBitmap` is owned by `FrameDecoder.decodedChunks`. Calling `close()` corrupts the decoder cache and breaks the main player. Callers must NOT close it. |
| **Frame Annotation Query Safety** | `job.annotations.get(F)` might affect undo stack or dirty state | **CONFIRMED:** `job.annotations.get(F, true)` is strictly read-only; it does not touch history, dirty hashes, or player state. |
| **Unsaved Tracks in Resolver** | Unsaved tracks might lack reliable identity before saving | **CONFIRMED:** Unsaved tracks possess fully stable `clientID` and `label.id` in memory; resolution works identically before and after save. |
| **Shortcut Suppression Scope** | Suppresses all editable elements | **CONFIRMED WITH NUANCE:** Suppresses `INPUT`, `SELECT`, `TEXTAREA` and any open `.ant-modal`. Does not check `contenteditable`. |
| **Auto-Save Behavior** | CVAT might automatically save in the background | **CONFIRMED:** Auto-save is disabled by default (`autoSave = false`); saving is strictly manual unless explicitly enabled by user. |

---

## 9. Risks and Implications for the Multi-Frame Feature

1. **Decoder Cache Contamination (High Severity if violated):**
   * *Risk:* If a developer invokes `bitmap.close()` in `MultiframeTile.componentWillUnmount` to "clean up memory", CVAT's player will fail with `The ImageBitmap is detached` when playing frames.
   * *Mitigation:* Explicit coding rule: `MultiframeTile` only passes `ImageBitmap` to `ctx.drawImage()` and never calls `.close()`.
2. **Concurrent Decoding Cache Thrashing (Medium Severity):**
   * *Risk:* If the 10-frame range spans across more chunks than `FrameDecoder.cachedChunksLimit` (typically 2 chunks), `FrameDecoder.cleanup()` will evict earlier chunks to decode later ones, leading to re-decoding when the user navigates.
   * *Mitigation:* In Milestone 2, load frames in sequential ascending order within the 10-frame batch.
3. **Active Selection Desynchronization on Landmark Update (Low Severity):**
   * *Risk:* When modifying a landmark element, `updateAnnotationsAsync` dispatches `fetchAnnotationsAsync()`. If the modal is open, will it cause a race condition?
   * *Mitigation:* The modal observes `activatedStateID` and `activatedElementID` via Redux `useSelector`, automatically receiving fresh state when `fetchAnnotationsAsync()` finishes.

---

## 10. Suggested Runtime Tests & Acceptance Criteria

### Test 1: Decoder Cache Non-Corruption Test
* **Objective:** Verify that loading 10 frames in the verification modal does not corrupt `FrameDecoder`'s cache.
* **Procedure:**
  1. Open CVAT player on Frame 5.
  2. Press `Alt+M` to open Multi-Frame modal covering Frames 0 to 9.
  3. Wait for all 10 tiles to render.
  4. Close modal (`Esc`).
  5. Play video forward through Frames 0 to 9 in main CVAT player.
* **Acceptance Criteria:** Main player plays smoothly without canvas errors, detached bitmap exceptions, or missing frames.

### Test 2: Unsaved Landmark Verification Test
* **Objective:** Verify that newly drawn, unsaved skeleton landmarks resolve across frames.
* **Procedure:**
  1. Draw a new `SkeletonTrack` on Frame 0.
  2. Advance to Frame 3 and adjust the `nose_tip` landmark.
  3. Do NOT save (Save button remains unsaved/active).
  4. Select `nose_tip` on Frame 3 and press `Alt+M`.
* **Acceptance Criteria:** `nose_tip` on Frame 0 is highlighted in cyan; `hasUnsavedChanges()` remains true; no save action is dispatched.

### Test 3: Input Element Shortcut Immunity Test
* **Objective:** Verify `Alt+M` is never fired while typing.
* **Procedure:**
  1. Focus the frame input box, task search box, or attribute text field.
  2. Press `Alt+M`.
* **Acceptance Criteria:** The modal does NOT open; character entry functions normally.
