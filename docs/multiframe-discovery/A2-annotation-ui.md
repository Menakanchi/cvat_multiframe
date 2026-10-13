# A2 — Discovery: CVAT Annotation UI and Frame Rendering Architecture

**Date:** 2026-10-13  
**Target Feature:** Multi-Frame Annotation & Object Verification for 2D Facial Landmarks  
**Active Branch:** `feature/multiframe-annotation`  
**Base Commit:** `0482c4793` (*Docs: describe server webhooks and updated webhook events (#11187)*)  
**Status:** Discovery and Architectural Baseline Complete  

---

## 1. Investigation Scope and Verified Repository State

### Scope
Perform a comprehensive static source-code discovery of CVAT Community Edition's Annotation UI, frame-rendering pipeline, object selection synchronization, and navigation mechanics to establish the architectural foundation for the upcoming feature: **"Multi-Frame Annotation & Object Verification for 2D Facial Landmarks"**.

### Feature Requirements Baseline
1. Pressing `Alt + M` in the Annotation workspace opens a dedicated verification popup/modal.
2. The UI allows selecting a Start Frame and End Frame (inclusive).
3. Up to 10 frames are displayed simultaneously.
4. If the selected range contains >10 frames, user navigates via batches of up to 10 frames.
5. Selecting an object on one displayed frame highlights corresponding objects on other displayed frames if a reliable identity association exists.
6. The feature is strictly for visual verification and manual editing; no automated coordinate copying, auto-annotation, auto-tracking, or cross-frame shape interpolation is permitted.
7. Active editable frame must be clearly differentiated from reference frames.
8. Unmatched objects must indicate unverified status without guessing.

### Verified Repository State
- **Workspace Location:** `C:\Users\Menf\cvat` (`Verified`)
- **Active Branch:** `feature/multiframe-annotation` (`Verified`)
- **Upstream / Remote Setup:** `origin` -> `https://github.com/cvat-ai/cvat`, `personal` -> `https://github.com/Menakanchi/cvat_multiframe` (`Verified`)
- **Working Tree:** Clean prior to report creation (`Verified`)
- **Application Engine:** CVAT 2.76.1 alpha.0 (`Verified`)

---

## 2. Annotation UI Component Hierarchy

The Annotation UI is structured in a clear container-component pattern across `cvat-ui`:

```
cvat-ui/src/containers/annotation-page/annotation-page.tsx (Redux Container)
 └── cvat-ui/src/components/annotation-page/annotation-page.tsx (Page Component)
      ├── Header: AnnotationTopBarContainer (containers/annotation-page/top-bar/top-bar.tsx)
      │    └── TopBarComponent (components/annotation-page/top-bar/top-bar.tsx)
      │         ├── LeftGroup (components/annotation-page/top-bar/left-group.tsx)
      │         │    └── PlayerButtons (components/annotation-page/top-bar/player-buttons.tsx)
      │         ├── PlayerNavigation (components/annotation-page/top-bar/player-navigation.tsx)
      │         └── RightGroup (components/annotation-page/top-bar/right-group.tsx)
      ├── Content: StandardWorkspaceComponent (components/annotation-page/standard-workspace/standard-workspace.tsx)
      │    ├── ControlsSideBarContainer (containers/.../controls-side-bar/controls-side-bar.tsx)
      │    ├── CanvasLayout (components/annotation-page/canvas/grid-layout/canvas-layout.tsx)
      │    │    └── CanvasWrapperComponent (components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx)
      │    │         └── cvat-canvas DOM mount (`canvasInstance.html()`)
      │    │              ├── CanvasModel (cvat-canvas/src/typescript/canvasModel.ts)
      │    │              ├── CanvasController (cvat-canvas/src/typescript/canvasController.ts)
      │    │              └── CanvasView (cvat-canvas/src/typescript/canvasView.ts)
      │    ├── BrushTools (components/annotation-page/canvas/views/canvas2d/brush-tools.tsx)
      │    └── ObjectSideBarComponent (components/.../objects-side-bar/objects-side-bar.tsx)
      │         └── ObjectsListContainer (containers/.../objects-side-bar/objects-list.tsx)
      │              └── ObjectItemContainer (containers/.../objects-side-bar/object-item.tsx)
      └── Floating Modals:
           ├── FiltersModalComponent (components/annotation-page/top-bar/filters-modal.tsx)
           ├── StatisticsModalComponent (components/annotation-page/top-bar/statistics-modal.tsx)
           └── SearchFramesModal (components/annotation-page/top-bar/search-modal.tsx)
```

### Key Component Findings
- **Annotation Page Container:** [`cvat-ui/src/containers/annotation-page/annotation-page.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/containers/annotation-page/annotation-page.tsx) connects URL query parameters (`tid`, `jid`, `frame`) to Redux, dispatches `getJobAsync`, `changeFrameAsync`, and unmounts with `closeJob` (`Verified`).
- **Standard Workspace:** [`cvat-ui/src/components/annotation-page/standard-workspace/standard-workspace.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/standard-workspace/standard-workspace.tsx) orchestrates the 2D layout: left controls sidebar, central `CanvasLayout`, right objects sidebar, and context menus (`Verified`).
- **Canvas Wrapper:** [`cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx) bridges React lifecycle to the imperative `cvat-canvas` library by mounting `canvasInstance.html()` directly into the `.cvat-canvas-container` DOM element (`Verified`).
- **Multi-View Grid Engine:** [`cvat-ui/src/components/annotation-page/canvas/grid-layout/canvas-layout.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/grid-layout/canvas-layout.tsx) uses `react-grid-layout` to support concurrent sub-views (`ViewType.CANVAS`, `ViewType.RELATED_IMAGE`, `ViewType.CANVAS_3D_*`) (`Verified`).

---

## 3. Frame Rendering and Decoding Flow

### 1. State Ownership
- The active frame index and frame data are stored in Redux under `state.annotation.player.frame`:
  ```ts
  state.annotation.player.frame: {
      number: number;           // Current frame index
      data: FrameData | null;   // Frame metadata and data accessor
      filename: string;         // Frame image/video filename
      relatedFiles: number;     // Context/related files count
      fetching: boolean;
      changeTime: number;
  }
  ```
  (`Verified` in [`cvat-ui/src/reducers/annotation-reducer.ts#L65-L75`](file:///C:/Users/Menf/cvat/cvat-ui/src/reducers/annotation-reducer.ts#L65-L75)).

### 2. Frame Change Execution
- Triggered by `changeFrameAsync(toFrame: number, fillBuffer?: boolean, frameStep?: number, forceUpdate?: boolean)` in [`cvat-ui/src/actions/annotation-actions.ts#L767-L864`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts#L767-L864):
  1. Validates boundary: `if (toFrame < job.startFrame || toFrame > job.stopFrame) throw Error(...)`.
  2. Guard check: `if (!isAbleToChangeFrame(toFrame) || statisticsVisible || propagateVisible) return;`.
  3. Frame fetch: `const data = await job.frames.get(toFrame, fillBuffer, frameStep);`.
  4. Annotations fetch: `const { states, history } = await fetchAnnotations(toFrame);`.
  5. Dispatches `CHANGE_FRAME_SUCCESS` with payload `{ number: toFrame, data, states, history }`.

### 3. Frame Data Decoding (`cvat-core` & `cvat-data`)
- `job.frames.get(frame)` routes to `getFrame()` in [`cvat-core/src/frames.ts#L899-L1001`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts#L899-L1001).
- Chunks (video or image archives) are retrieved from server via `serverProxy.frames.getChunk(...)`.
- The decoding engine is `FrameDecoder` in `cvat-data`. It decodes video frames or unzips archives into native browser `ImageBitmap` objects.
- `FrameData.prototype.data()` (`frames.ts#L458-L550`) returns:
  ```ts
  {
      renderWidth: number;
      renderHeight: number;
      imageData: ImageBitmap | Blob;
  }
  ```
- **Cache Memory Limits:** CVAT dynamically caps decoded chunk memory to **2 GB**:
  ```ts
  decodedBlocksCacheSize = Math.min(
      Math.floor((2048 * 1024 * 1024) / ((mean + stdDev) * 4 * chunkSize)) || 1,
      10
  );
  ```
  (`Verified` in [`cvat-core/src/frames.ts#L923-L926`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts#L923-L926)).

### 4. Canvas Ingestion
- In `CanvasWrapperComponent.updateCanvas()` ([`canvas-wrapper.tsx#L1087-L1091`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx#L1087-L1091)):
  ```ts
  canvasInstance.setup(
      proxy, // Proxy wrapping frameData.data() with optional color/filter pipeline
      frameData.deleted ? [] : filteredAnnotations,
      renderData,
  );
  ```
- `canvasInstance.setup(...)` in `cvat-canvas` updates the SVG background image and draws all `ObjectState` elements for the frame.

### 5. Multi-Instance Canvas Feasibility
- `CanvasImpl` in [`cvat-canvas/src/typescript/canvas.ts#L63-L73`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvas.ts#L63-L73) is a standard JavaScript class (`new Canvas()`) with its own `CanvasModel`, `CanvasController`, and `CanvasView`. It can be instantiated multiple times independently (`Verified`).
- **Limitation:** In `CanvasWrapperComponent`, DOM lookup uses `window.document.getElementsByClassName('cvat-canvas-container')[0]`, and Redux holds a single `state.annotation.canvas.instance`. Multiple instances cannot simply mount into `CanvasWrapperComponent` without unique DOM containers and independent state references (`Verified`).

---

## 4. Frame Index and Navigation Conventions

| Layer | Index Base | Range | Notes |
| :--- | :--- | :--- | :--- |
| **Backend DB / REST API** | 0-based | `0 .. size - 1` | `start_frame` and `stop_frame` in task/job metadata |
| **`cvat-core` (`FramesMetaData`)** | 0-based | `startFrame .. stopFrame` | Segment frames mapped via `getDataFrameNumber()` |
| **Redux Player State** | 0-based | `job.startFrame .. job.stopFrame` | `state.annotation.player.frame.number` |
| **UI Slider & Input** | 0-based | `job.startFrame .. job.stopFrame` | Displayed numbers in `InputNumber` directly match internal indices |

### Navigation Controls
- **Component:** [`cvat-ui/src/components/annotation-page/top-bar/player-navigation.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/top-bar/player-navigation.tsx)
- **Slider:** Ant Design `Slider` bounded by `min={startFrame}` and `max={stopFrame}` (`#L210-L217`).
- **Numeric Input:** Ant Design `InputNumber` clamped via `Math.floor(clamp(+value, startFrame, stopFrame))` (`#L260-L280`).
- **Validation:** Validated against `job.startFrame` and `job.stopFrame`. Jobs derived from multi-segment tasks can have a non-zero `startFrame` (`Verified`).
- **Reusable Elements:** The slider markup, frame input clamp logic, and chapter markers in `PlayerNavigation` provide direct reference implementations for frame range selection controls.

---

## 5. Canvas Annotation and Selection Flow

### 1. Shape and Landmark Representation
- Annotation items are wrapped in `ObjectState` ([`cvat-core/src/object-state.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/object-state.ts)):
  - **2D Points / Landmarks:** `shapeType = ShapeType.POINTS` (`'points'`). Coordinates stored as a flat array of numbers: `points: [x1, y1, x2, y2, ...]`.
  - **Skeletons:** `shapeType = ShapeType.SKELETON` (`'skeleton'`). Composite container whose `elements` property contains child `ObjectState` instances representing landmark joints (e.g. eyes, nose, mouth corners) linked to sublabels (`Verified`).
  - **Temporal Identity:**
    - `objectType = ObjectType.TRACK` (`'track'`): Represents a tracked object across time. The **`clientID`** (and `serverID` once persisted) remains identical across all frames of the track (`Verified`).
    - `objectType = ObjectType.SHAPE` (`'shape'`): An isolated, single-frame object. Different shapes on separate frames do not share a track ID unless assigned to the same `group.id` (`Verified`).

### 2. Object Selection Synchronization
1. **Canvas -> Sidebar:**
   - User hovers or clicks on canvas -> `cvat-canvas` fires `canvas.find` or `canvas.cursorMoved`.
   - `CanvasWrapperComponent.onCanvasCursorMoved()` calls `jobInstance.annotations.select(event.detail.states, x, y)` (`#L897-L919`).
   - Dispatches `activateObject(clientID, elementID)` -> sets `state.annotation.annotations.activatedStateID = clientID`.
   - `ObjectsListContainer` and `ObjectItemContainer` receive `activatedStateID`. The item with `objectState.clientID === activatedStateID` applies active CSS classes and expands details (`#L471-L482`).
2. **Sidebar -> Canvas:**
   - User clicks object item in sidebar -> `ObjectItemContainer.activate()` dispatches `activateObject(objectState.clientID)` (`#L471-L482`).
   - `CanvasWrapperComponent.componentDidUpdate()` detects `prevProps.activatedStateID !== activatedStateID` and calls `canvasInstance.activate(activatedStateID, activatedAttributeID)` (`#L563-L564`).

### 3. Selection vs Frame Navigation Independence
- Selecting an object does **not** change the current frame (`Verified`).
- However, changing frames (`changeFrameAsync`) resets or re-evaluates active object state unless the track continues on the destination frame (`Verified`).

---

## 6. Existing Read-Only and Reference Rendering Capabilities

The feature requires displaying reference frames without risking accidental edits, tracking, or coordinate duplication.

### Verified Capabilities
1. **State Locking (`ObjectState.lock = true`):**
   - In `cvat-canvas` ([`canvasView.ts#L3260, L3940`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvasView.ts#L3260)):
     ```ts
     if (this.stateIsLocked(state)) {
         return; // Disables activation handlers, drag, resize, and edit triggers
     }
     ```
   - Setting `lock: true` on objects passed to a reference canvas renders shapes visually without allowing geometry manipulation (`Verified`).
2. **Native Canvas Highlight API:**
   - `cvat-canvas` provides a dedicated highlight method:
     ```ts
     canvasInstance.highlight(clientIDs: number[] | null, severity: HighlightSeverity | null): void;
     ```
     ([`cvat-canvas/src/typescript/canvas.ts#L30`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvas.ts#L30) and [`canvas-wrapper.tsx#L580`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx#L580)).
   - This method highlights specific objects (e.g. for conflicts or verification) without activating them into an editable state (`Verified`).
3. **CSS Event Isolation:**
   - Wrapping a reference frame or canvas in a container with `pointer-events: none` natively suppresses all mouse/touch events at the browser DOM level, guaranteeing zero mutation side effects (`Inference`).
4. **Direct Read-Only Core Queries:**
   - Both `job.frames.get(targetFrame)` and `job.annotations.get(targetFrame)` can be called directly for arbitrary frame numbers without dispatching Redux player actions or modifying `state.annotation.player.frame` (`Verified`).

---

## 7. Relevant Existing Tests

CVAT frontend and workspace integration tests reside primarily in Cypress E2E test suites:

- **Frame Navigation:**
  - [`tests/cypress/e2e/actions_tasks/navigate_specific_frame.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/actions_tasks/navigate_specific_frame.js): Verifies frame indexing (0-based: `checkFrameNum(0)`), navigating to specific frames, URL query parameters, and latest-frame notification.
  - [`tests/cypress/e2e/actions_tasks3/case_3_task_start_stop_step_frame.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/actions_tasks3/case_3_task_start_stop_step_frame.js): Verifies boundary constraints (`start_frame`, `stop_frame`, `step`).
  - [`tests/cypress/e2e/issues_prs/issue_2485_navigation_empty_frames.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/issues_prs/issue_2485_navigation_empty_frames.js): Verifies player navigation across empty frames.
- **Points & Objects Manipulation:**
  - [`tests/cypress/e2e/actions_objects/case_34_drawing_with_predefined_number_points.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/actions_objects/case_34_drawing_with_predefined_number_points.js): Tests point landmarks creation and selection.
  - [`tests/cypress/e2e/issues_prs2/issue_1368_points_track_invisible_next_frame.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/issues_prs2/issue_1368_points_track_invisible_next_frame.js): Tests point tracks behavior across frame transitions.
  - [`tests/cypress/e2e/actions_objects/case_24_delete_unlock_lock_object.js`](file:///C:/Users/Menf/cvat/tests/cypress/e2e/actions_objects/case_24_delete_unlock_lock_object.js): Tests object locking and edit prevention.

---

## 8. Comparison of Multi-Frame UI Integration Options

We evaluate four architectural approaches for displaying up to 10 frames simultaneously with cross-frame landmark highlighting:

| Architectural Option | Code Reuse | State Isolation | Decoding & Caching Impact | Annotation Rendering | Active Frame Interference Risk | Performance with 10 Frames | Recommendation Assessment |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Option 1: Separate Modal/Popup (`Alt + M`) with Lightweight Frame Views** | High (AntD Modal, core APIs) | **Complete** (local component state, does not hijack active Redux player) | Direct `job.frames.get()` queries utilize existing 2GB chunk cache cleanly | Clean SVG or HTML5 canvas overlays rendering `ObjectState[]` | **Minimal** (independent modal layer; editing is explicit) | **Optimal** (lightweight viewports without heavy tool controllers) | **Recommended (Primary)** |
| **Option 2: Grid of Full Independent `Canvas` Instances in Workspace** | High (`cvat-canvas` reused directly) | Low-Medium (multiple `CanvasImpl` instances competing for DOM events) | 10 full `Canvas` instances with 10 SVG DOM trees and event controllers | Native `canvasInstance.setup()` | High (risk of event bubbling, tool synchronization collisions) | Poor (heavy DOM weight, 10 event controllers, layout reflows) | Not recommended |
| **Option 3: Time-Multiplexed Single Canvas Switching** | Very High (no new views) | None (shares active player state) | Rapid frame thrashing in single Redux player | Re-renders main canvas | Severe (disrupts user's active annotation context and history) | Moderate, but fails the requirement to view 10 frames *simultaneously* | Disqualified by requirements |
| **Option 4: Dual-Panel: Main Canvas (Active) + Secondary Strip (9 Reference Thumbnails)** | High (main canvas untouched, side strip for references) | High (strip views are read-only) | Reference frames decoded on-demand via `job.frames.get()` | Reference strip uses lightweight SVG overlay | Low (clear distinction between active canvas and references) | Good (1 active canvas + 9 lightweight views) | **Strong Alternative (Secondary)** |

### Recommendation Rationale
- **Option 1** matches the explicit requirement: *"Pressing `Alt + M` in the CVAT Annotation workspace opens a popup... lets the user select Start Frame and End Frame... display up to 10 frames simultaneously"*.
- Hosting lightweight reference viewers inside the modal keeps the main canvas and Redux state completely isolated, eliminating any possibility of accidental coordinate overwrites or tracking mutations.

---

## 9. Recommended Next Investigation Questions for A3, A4, and A5

1. **For A3 (Facial Landmark Data Structures & Cross-Frame Identity):**
   - How are facial landmarks represented across different job modes (`annotation` vs `interpolation`)?
   - In `ShapeType.SKELETON`, how do sublabel/element identifiers map across frames within the same track?
   - What is the exact heuristic to determine if an object has a *"reliable identity association"* across frames? (Track `clientID`/`serverID` vs group ID vs label matching).
2. **For A4 (Shortcut Registration & Modal Lifecycle):**
   - How to register `Alt + M` in [`cvat-ui/src/utils/component-subkeymap.ts`](file:///C:/Users/Menf/cvat/cvat-ui/src/utils/component-subkeymap.ts) within `ShortcutScope.ANNOTATION_PAGE` without conflicting with existing global keys?
   - How should the modal trap or release focus so that arrow-key frame navigation inside the modal does not trigger background player frame changes?
3. **For A5 (Performance & Batch Prefetching):**
   - When requesting 10 frames simultaneously via `Promise.all(frames.map(f => job.frames.get(f)))`, how does `FrameDecoder` handle concurrent chunk decoding?
   - Will requesting 10 frames trigger premature eviction in the 2GB chunk cache? Does CVAT require sequential decoding or batch prefetching?

---

## 10. Exact Source Paths and Symbol References

| File Path | Relevant Symbol / Line | Description |
| :--- | :--- | :--- |
| [`cvat-ui/src/containers/annotation-page/annotation-page.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/containers/annotation-page/annotation-page.tsx) | `AnnotationPageContainer`, `mapStateToProps` (`#L38-L63`) | Redux container for annotation workspace |
| [`cvat-ui/src/components/annotation-page/annotation-page.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/annotation-page.tsx) | `AnnotationPageComponent` (`#L45-L173`) | Root annotation page view and workspace switcher |
| [`cvat-ui/src/components/annotation-page/standard-workspace/standard-workspace.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/standard-workspace/standard-workspace.tsx) | `StandardWorkspaceComponent` (`#L21-L35`) | Standard 2D layout orchestrating canvas and sidebars |
| [`cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx) | `CanvasWrapperComponent.updateCanvas()` (`#L1040-L1094`) | Passes frame data and annotations to `cvat-canvas` |
| [`cvat-ui/src/components/annotation-page/canvas/grid-layout/canvas-layout.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/grid-layout/canvas-layout.tsx) | `ViewFabric` (`#L43-L71`), `CanvasLayout` | Grid layout supporting multi-view configuration |
| [`cvat-ui/src/components/annotation-page/top-bar/player-navigation.tsx`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/top-bar/player-navigation.tsx) | `PlayerNavigation` (`#L82-L298`) | Frame slider, numeric input, and boundary validation |
| [`cvat-ui/src/actions/annotation-actions.ts`](file:///C:/Users/Menf/cvat/cvat-ui/src/actions/annotation-actions.ts) | `changeFrameAsync` (`#L767-L864`), `fetchAnnotations` (`#L330-L360`) | Core thunks for frame switching and annotation retrieval |
| [`cvat-core/src/frames.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts) | `getFrame()` (`#L899-L1001`), `FrameData.data()` (`#L458-L550`) | Frame data decoding, chunk retrieval, and 2GB cache limits |
| [`cvat-core/src/object-state.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/object-state.ts) | `ObjectState` (`#L55-L100`) | Annotation data model with clientID, points, keyframes |
| [`cvat-canvas/src/typescript/canvas.ts`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvas.ts) | `CanvasImpl` (`#L63-L100`), `highlight()` (`#L30`) | Canvas interface and object highlight method |
| [`cvat-canvas/src/typescript/canvasView.ts`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvasView.ts) | `stateIsLocked()` (`#L3260, L3940`) | Lock state preventing canvas editing side-effects |

---

## 11. Unknowns, Risks, and Assumptions

### Unknowns
- **`Unknown` (Chunk Fetch Latency):** How long it takes in practice to decode 10 high-resolution video frames simultaneously over a network or local storage when frames span across multiple compressed chunks.
- **`Unknown` (Facial Landmark Dataset Configuration):** Whether the user's project annotates facial landmarks using single `ShapeType.POINTS` shapes (e.g., 68-point arrays) or composite `ShapeType.SKELETON` shapes with individual named sublabels (e.g. `left_eye`, `nose_tip`). Both formats must be accounted for in A3.

### Risks
- **Memory Footprint:** Displaying 10 full-resolution frames simultaneously could consume significant RAM (e.g. 10 frames at 4K resolution $\approx 330\text{ MB}$ raw pixel memory). Rendering them at scaled viewport dimensions or rendering preview thumbnails will mitigate this risk.
- **Keyboard Shortcut Collisions:** `Alt + M` must be scoped strictly to the Annotation workspace to avoid conflicting with browser hotkeys or operating system menu accelerators.
- **Accidental State Mutation:** If reference frames inadvertently trigger Redux annotation update actions, track history could be corrupted. Strict isolation using read-only wrappers is essential.

### Assumptions
- Frame indexing is strictly 0-based across all internal layers (`Verified`).
- Objects belonging to the same temporal track share a constant `clientID` within a job session (`Verified`).
- Users will only require manual inspection and independent editing in the active frame, adhering to safety rule 7 (`Verified`).
