# Group A — Final Discovery Review and Consolidation Report

**Date:** 2026-10-13  
**Target Feature:** Multi-Frame Annotation & Object Verification for 2D Facial Landmarks  
**Active Branch:** `feature/multiframe-annotation`  
**Base Commit:** `3605eccb0`  
**Status:** Consolidated Discovery Baseline & Architecture Readiness Review  

---

## 1. Inventory of Existing Reports and Missing Deliverables

A comprehensive audit of the local discovery directory (`docs/multiframe-discovery/`) was performed to establish the evidence baseline:

| Report File | Title / Domain | Status | Key Discoveries & Content |
| :--- | :--- | :--- | :--- |
| *(None on disk)* | **A1 — Environment Baseline & Repository Inspection** | **Missing from disk** | The initial baseline audit was reported directly in conversation during session initialization rather than persisted to a standalone markdown file. Key baseline facts established: CVAT `2.76.1 alpha.0`, clean working tree on `develop`, React + Redux frontend, Yarn workspaces, local Docker stack on port 8080. |
| [`A2-annotation-ui.md`](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A2-annotation-ui.md) | **A2 — CVAT Annotation UI & Frame Rendering Architecture** | **Committed (`f833525d3`)** | Identified standard workspace components, canvas layout, `cvat-canvas` integration, `FrameDecoder` chunking, and candidate modal mount points in `annotation-page.tsx`. |
| [`A3-identity-resolution.md`](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A3-identity-resolution.md) | **A3.1 — Annotation Data Model & Cross-Frame Identity Discovery** | **Committed (`f833525d3`)** | Discovered track vs. shape distinction, `clientID` vs. `serverID`, `SkeletonTrack` composite element structures, and in-memory read-only retrieval via `job.annotations.get(F, true)`. |
| [`A3.2-identity-validation.md`](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A3.2-identity-validation.md) | **A3.2 — Validate Skeleton Landmark Identity & Read-Only Highlighting** | **Committed (`f833525d3`)** | Validated that `canvasInstance.highlight()` activates interactive resizing/dragging (unsafe for reference frames). Formulated non-interactive SVG overlay approach with `pointer-events: none`. Verified deterministic composite key: $\langle \text{Parent Track clientID},\ \text{Sublabel ID} \rangle$. |
| [`A4-multiframe-architecture.md`](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A4-multiframe-architecture.md) | **A4 — Multi-Frame Annotation & Object Verification Architecture** | **Committed (`0aabc9934`)** | Architectural blueprint for modal UI, 10-frame grid layout, batching, pure identity resolution state machine, proposed file modifications, and Milestone 1 test cases. |
| [`A5-state-and-persistence.md`](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A5-state-and-persistence.md) | **A5 — CVAT State Management & Annotation Persistence Investigation** | **Committed (`3605eccb0`)** | Traced complete editing lifecycle (`updateAnnotationsAsync` $\to$ `objectState.save` $\to$ history $\to$ hash diff). Discovered critical `ImageBitmap` ownership rule in `FrameDecoder` (callers must never call `close()`). Verified shortcut suppression boundaries in `mousetrap-react.tsx`. |

> [!NOTE]
> **Audit Conclusion on Deliverables:** No attempts were made to invent or retroactively synthesize the missing `A1` markdown file. The baseline facts from `A1` are thoroughly corroborated and verified in the subsequent reports `A2` through `A5`.

---

## 2. Consolidated Understanding of Current CVAT Architecture

Through systematic code tracing in `cvat-core`, `cvat-canvas`, `cvat-ui`, and `cvat-data`, the following architectural facts are verified:

### 2.1 State Management & Separation of Concerns
1. **Redux Store (`cvat-ui`):**
   - Manages UI session state: `player.frame.number` (active frame index), `annotations.activatedStateID` (active object client ID), `annotations.activatedElementID` (active child landmark client ID), and temporary `annotations.states` arrays for the active frame.
   - Does **not** store historical frame annotations or all-frame track trajectories.
2. **In-Memory Domain Collection (`cvat-core`):**
   - `AnnotationsCollection` maintains the complete, authoritative collection of all tracks (`collection.tracks`) and shapes (`collection.shapes[frame]`) for the loaded job.
   - `job.annotations.get(F, true)` executes synchronously against in-memory arrays. It does **not** trigger network requests, dispatch Redux actions, touch undo/redo history, or alter player position.
3. **Video Decoding Engine (`cvat-data`):**
   - `FrameDecoder` decompresses video chunks (typically 36 frames per MP4 chunk) in background web workers.
   - Decompressed frames are stored as `ImageBitmap` objects in an internal LRU cache (`decodedChunks[chunkIndex][frame]`).

### 2.2 Object Identity and Representation Across Frames
1. **Tracks (`ObjectType.TRACK`):**
   - Retain an invariant, session-scoped `clientID` allocated at construction time via `injection.nextClientID()`.
   - Calling `track.get(F)` evaluates position and attributes for frame $F$ while preserving `state.clientID = this.clientID`.
2. **Composite Skeletons (`SkeletonTrack`):**
   - Contains a fixed array of child `Track` instances (`this.elements`), one for each landmark sublabel defined in `label.structure.sublabels`.
   - Child elements maintain their own invariant `clientID`, a reference `parentID = parentSkeleton.clientID`, and their sublabel primary key `label.id`.
   - Skeletons are sorted deterministically by `sublabel.id`.
   - **Matching Contract:** A landmark element on frame $F_1$ is resolved on frame $F_2$ by finding the parent skeleton where `state.clientID === selected.parentID`, then finding the element where `el.label.id === selected.label.id`.
3. **Standalone Shapes (`ObjectType.SHAPE`):**
   - Exist strictly on a single frame (`shape.frame`). Standalone points or shapes across different frames have zero identity linkage. Calling `shape.get(otherFrame)` throws a `ScriptingError`.
   - Standalone shapes **cannot** be matched across frames.
4. **`clientID` vs. `serverID` Lifecycle:**
   - `clientID` is the authoritative, immutable in-memory spine within a browser session.
   - `serverID` is `null` for newly created, unsaved annotations, and becomes populated only after saving to PostgreSQL.
   - Saving strips `clientID` from JSON payloads, sends the diff, and calls `updateFromServerResponse()` upon server return, updating `_serverId` while keeping `clientID` identical.

### 2.3 Landmark Visibility States
- **Normal / Visible:** Coordinates populated, `outside = false`, `occluded = false`.
- **Occluded:** Landmark is physically obscured (e.g. hair, sunglasses) but retains coordinates. Marked `occluded = true`.
- **Outside / Absent:** Landmark is out of frame or has not been annotated on that frame. Marked `outside = true`. Coordinates must not be rendered.

### 2.4 Editing and Persistence Lifecycle
- Modifying a landmark vertex on canvas emits `canvas.edited`.
- `CanvasWrapper` handles the event and dispatches `updateAnnotationsAsync([state])`.
- `state.save()` calls `SkeletonTrack.save()`, updating `shapes[frame].points`, recording the action in `AnnotationHistory.undo`, and updating `AnnotationsSaver.hash`.
- For skeleton elements (`parentID !== null`), `updateAnnotationsAsync` dispatches `fetchAnnotationsAsync()` to refresh parent bounding boxes.
- `job.annotations.hasUnsavedChanges()` returns `true` via hash comparison.
- Saving is manual by default (`autoSave = false`). Navigating away with unsaved changes triggers `beforeunload` route blocking.

### 2.5 Critical Resource Ownership Findings
- `FrameDecoder` in `cvat-data` **owns** the `ImageBitmap` objects returned by `frameData.data()`.
- `FrameDecoder` automatically calls `bitmap.close()` when evicting chunks from its LRU cache.
- **Callers must NEVER call `ImageBitmap.close()` directly.** Doing so destroys the shared cached buffer, causing the main CVAT player to crash with a detached bitmap exception.

### 2.6 Keyboard Shortcut Suppression Boundaries
- `Mousetrap.prototype.stopCallback` in `mousetrap-react.tsx` unconditionally suppresses shortcuts when focused on `INPUT`, `SELECT`, and `TEXTAREA` elements.
- It also suppresses all shortcuts whenever any `.ant-modal` element is visible (except specific modal-closing sequences).
- Elements with `contenteditable="true"` are not checked by `stopCallback`, but all CVAT annotation input fields use standard Ant Design inputs.

---

## 3. Recommended Multi-Frame Feature Architecture

Based on the verified architectural foundation, the recommended feature design consists of:

### 3.1 Modal Window & Grid UI
* **Activation:** `Alt+M` shortcut registered via `mousetrap-react.tsx` in `player-navigation.tsx`, plus a top-bar button. Automatically suppressed while typing.
* **Modal Mounting:** Mounted in `annotation-page.tsx` as a sibling to `SearchFramesModal`.
* **Controls:** Start Frame and End Frame inputs, clamped to $[\text{job.startFrame}, \text{job.stopFrame}]$.
* **Batching:** Displays at most 10 frames simultaneously. Larger ranges are navigated in batches of up to 10 frames with Next/Previous batch buttons and a batch slider.
* **Active vs. Reference Distinction:**
  * Active Frame ($F = \text{currentFrame}$): Highlighted with a green border and `[Active Editable Frame #F]` badge.
  * Reference Frames ($F \ne \text{currentFrame}$): 1px subtle border and `[Reference Frame #F (Read-Only)]` badge.
  * Double-clicking any reference frame header switches the active player frame (`changeFrameAsync(targetFrame)`).

### 3.2 Read-Only Reference Frame Rendering
* **No `CanvasView.highlight()`:** The interactive canvas highlight API is strictly prohibited on reference frames to prevent accidental edit modes, dragging, resizing, or Redux event pollution.
* **Two-Layer Surface:**
  1. Base Layer: HTML5 `<canvas>` rendering the decoded frame bitmap via `ctx.drawImage()`. Callers do not call `bitmap.close()`.
  2. Overlay Layer: Pure declarative SVG overlay with `pointer-events: none` and `viewBox="0 0 W H"`. Points map 1:1 with natural image pixel coordinates without scaling math.

### 3.3 Deterministic Identity Resolver
* A pure, side-effect-free function:
  ```ts
  resolveCrossFrameIdentity(selectedState, targetFrameStates)
  ```
* **Matching Rules:**
  1. If `selectedState.objectType !== 'track'` $\to$ Return `NO_IDENTITY`. Display warning badge.
  2. If `selectedState.parentID !== null` (Skeleton Element):
     - Find parent skeleton track on target frame where `state.clientID === selected.parentID`. If absent or outside $\to$ Return `SKELETON_ABSENT`.
     - Find child element where `el.label.id === selected.label.id`. If absent or outside $\to$ Return `ABSENT_ON_FRAME`.
     - Otherwise $\to$ Return `MATCHED` (with `isOccluded` flag).
  3. If top-level track $\to$ Match by `state.clientID === selected.clientID`.
* **Visual Highlighting:**
  - `MATCHED`: Pulsing cyan ring (`stroke-dasharray="4 2"`) over the landmark.
  - `ABSENT_ON_FRAME`: No point rendered; red HUD badge `[Absent on Frame #F]`.
  - `isOccluded`: Dashed cyan ring with `[Occluded]` badge.
  - Multi-face scenes are completely disambiguated by parent `clientID`.

---

## 4. Confirmed Constraints and Non-Goals

| Category | Constraint / Non-Goal | Architectural Enforcement |
| :--- | :--- | :--- |
| **No Auto-Annotation** | Do NOT automatically create annotations on other frames | Read-only in-memory queries; no call to `createAnnotationsAsync` |
| **No Coordinate Copying** | Do NOT copy coordinates from active frame to reference frames | Reference overlays display only geometry queried for that specific frame |
| **No Tracking / Prediction** | Do NOT predict or interpolate missing landmark coordinates | If `outside === true`, no coordinates are rendered; HUD badge displays absence |
| **No Cross-Matching Shapes** | Standalone shapes (`ObjectType.SHAPE`) must NEVER be matched | Resolver explicitly checks `objectType === 'track'`; shapes return `NO_IDENTITY` |
| **No Data Mutation** | Querying frames must NOT mark annotations as dirty or unsaved | `job.annotations.get(F, true)` reads in-memory arrays without modifying `collection.export()` |
| **No Bitmap Detachment** | Do NOT call `ImageBitmap.close()` | Tile paints to canvas context and releases JS reference; `FrameDecoder` owns lifecycle |
| **No Canvas Activation** | Do NOT call `canvasInstance.highlight()` on reference frames | Pure SVG overlay with `pointer-events: none` eliminates all mouse listeners |

---

## 5. Unresolved Technical Risks & Required Runtime Tests

### 5.1 Unresolved Technical Risks
1. **Decoder Cache Eviction Across Wide Ranges (Medium Risk):**
   - In `FrameDecoder`, `cachedChunksLimit` defaults to 2 blocks. If an annotator specifies a 10-frame range that spans across 3 different chunks, `FrameDecoder.cleanup()` will evict earlier chunks to decode later ones.
   - *Mitigation:* In Milestone 2, decode frames in sequential ascending order.
2. **Network Bandwidth on 4K Video Datasets (Low/Medium Risk):**
   - High-resolution uncached video could introduce initial decoding latency when loading 10 frames simultaneously.
   - *Mitigation:* Individual skeleton loaders on each tile to provide progressive visual feedback.
3. **Custom Skeleton Bone Schemas (Low Risk):**
   - Skeletons with complex SVG bone linkages in `label.structure.svg`.
   - *Mitigation:* Prioritize vertex landmark circles first; skeleton edges can be rendered as an aesthetic enhancement without impacting landmark verification.

### 5.2 Required Runtime Tests (To be executed during implementation)
*Note: These tests are design requirements for the implementation phase and have NOT been executed yet.*

* **Runtime Test R1 (Decoder Cache Integrity):**
  - Open player on Frame 5 $\to$ Open Multi-Frame modal for Frames 0–9 $\to$ Close modal $\to$ Play video in main player.
  - *Pass Criteria:* Video plays smoothly without detached bitmap exceptions or canvas errors.
* **Runtime Test R2 (Unsaved Track Resolution):**
  - Draw new skeleton on Frame 0 $\to$ Move landmark on Frame 3 $\to$ Do NOT save $\to$ Select landmark and open `Alt+M`.
  - *Pass Criteria:* Landmark is highlighted in cyan across frames; `hasUnsavedChanges()` remains true; no save action dispatched.
* **Runtime Test R3 (Input Immunity):**
  - Focus frame input or attribute text box $\to$ Press `Alt+M`.
  - *Pass Criteria:* Modal does not open; text typing is uninterrupted.
* **Runtime Test R4 (Reference Frame Immutability):**
  - Click, drag, and double-click reference frame SVG overlay.
  - *Pass Criteria:* Zero coordinate changes, zero undo stack additions, zero Redux selection mutations.

---

## 6. Implementation Acceptance Criteria

The feature implementation must satisfy the following verifiable criteria:

1. **Shortcut & Modal Lifecycle:**
   - Pressing `Alt+M` opens the modal within $<200\text{ ms}$.
   - Pressing `Esc` or clicking Cancel closes the modal and destroys modal DOM.
   - Pressing `Alt+M` while typing in any input element does not open the modal.
2. **Frame Range & Batching:**
   - Start Frame and End Frame inputs are clamped to $[\text{job.startFrame}, \text{job.stopFrame}]$.
   - No more than 10 frames are visible simultaneously.
   - Ranges $>10$ frames support batch pagination (`Batch X of Y`).
3. **Active vs. Reference Isolation:**
   - Active frame tile displays a green border and reflects the current player frame.
   - Double-clicking any reference frame header navigates the main player to that frame.
   - Reference frames render with `pointer-events: none` and cannot be edited.
4. **Identity & Highlighting:**
   - Selecting a landmark on the active frame highlights its counterpart with a pulsing cyan ring on reference frames containing that skeleton.
   - Absent landmarks render no circle and display `[Absent on Frame #F]`.
   - Occluded landmarks render with dashed cyan circles and `[Occluded]`.
   - Standalone shapes display `[Standalone shape — no cross-frame track]` and never match across frames.
   - Skeletons of different persons (multiple faces) are never confused.
5. **Data & State Preservation:**
   - Zero coordinate copying, zero auto-annotation, zero data mutation on other frames.
   - `job.annotations.hasUnsavedChanges()` is not modified by opening the modal or viewing frames.
   - Decoded `ImageBitmap` buffers are never manually closed by the feature.

---

## 7. Recommendation and Next Steps

### Go/No-Go Recommendation: **GO FOR IMPLEMENTATION**
* **Rationale:**
  1. All critical architectural assumptions from earlier phases have been source-verified against `cvat-core`, `cvat-canvas`, `cvat-ui`, and `cvat-data`.
  2. The high-risk assumption regarding `ImageBitmap.close()` was successfully caught and corrected prior to writing any code, preventing a critical decoder cache corruption bug.
  3. The identity resolution contract ($\langle \text{Parent Track clientID},\ \text{Sublabel ID} \rangle$) is proven deterministic, supporting both saved and unsaved tracks.
  4. The read-only reference frame overlay approach guarantees zero accidental coordinate mutations.

### Next Steps:
* **Plan Confirmation:** The exact task sequence for the implementation phase must be confirmed against the user's original project plan before proceeding.
* **Suggested Starting Point:** Milestone 1 (Shortcut Registration & Modal Shell) as defined in [A4 §9](file:///C:/Users/Menf/cvat/docs/multiframe-discovery/A4-multiframe-architecture.md#milestone-1-shortcut-registration--modal-shell-zero-risk-baseline).
