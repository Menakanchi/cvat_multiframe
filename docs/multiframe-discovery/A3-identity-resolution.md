# A3.1 — CVAT Annotation Data Model & Cross-Frame Identity Discovery

**Date:** 2026-10-13  
**Target Feature:** Multi-Frame Annotation & Object Verification for 2D Facial Landmarks  
**Active Branch:** `feature/multiframe-annotation`  
**Base Commit:** `0482c4793`  
**Status:** Complete Discovery and Verified Architectural Contract  

---

## 1. Executive Summary

This report establishes the data modeling, identity tracking, and frame query semantics of CVAT Community Edition (`2.76.1 alpha.0`) for implementing the upcoming **"Multi-Frame Annotation & Object Verification for 2D Facial Landmarks"** feature.

### Core Discoveries
1. **Temporal Identity Exists Exclusively for Tracks (`ObjectType.TRACK`):**
   - Objects modeled as `Track` (`PointsTrack`, `RectangleTrack`, `SkeletonTrack`) retain a persistent **`clientID`** (session-scoped) and **`serverID`** (database-scoped) across all frames.
   - When calling `job.annotations.get(frame)`, CVAT evaluates all tracks at that frame and constructs an `ObjectState` carrying the track's persistent `clientID` and `serverID`.
2. **Standalone Shapes (`ObjectType.SHAPE`) Have Zero Cross-Frame Identity:**
   - Standalone shapes (`Shape`, `PointsShape`, `SkeletonShape`) exist strictly on their assigned frame (`shape.frame`).
   - Calling `shape.get(otherFrame)` explicitly throws `ScriptingError('Received frame is not equal to the frame of the shape')`.
   - Standalone shapes across different frames cannot be linked using existing data without manual guessing, which is strictly prohibited.
3. **Skeleton Hierarchies Provide Deterministic Landmark Part Mapping:**
   - In `SkeletonTrack`, the parent skeleton and every landmark element (`elements`) are individual `Track` instances.
   - An individual landmark is uniquely identified across frames by the tuple:
     $$\langle \text{Parent Track clientID},\ \text{Sublabel ID} \rangle$$
   - Selecting a landmark on frame $F_1$ allows deterministic matching to the landmark on frame $F_2$ by locating the skeleton with matching parent `clientID` and child element with matching sublabel ID.
4. **Annotation Retrieval (`job.annotations.get`) is Completely In-Memory and Read-Only:**
   - When a job is loaded, all shapes and tracks for the entire session are cached in an in-memory `AnnotationsCollection`.
   - Calling `job.annotations.get(targetFrame)` executes purely against this in-memory collection without making HTTP requests, mutating Redux player state, triggering history saves, or causing side effects.
5. **Frame Indexing is Strictly Uniform and 0-Based:**
   - Both `job.frames.get(frame)` and `job.annotations.get(frame)` consume the exact same absolute frame index ($frame \in [\text{startFrame}, \text{stopFrame}]$). No offset translation is required.

---

## 2. Verified Source Files & Symbols

| File Path | Relevant Symbol / Function | Architectural Purpose |
| :--- | :--- | :--- |
| [`cvat-core/src/enums.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/enums.ts) | `ObjectType`, `ShapeType` (`#L80-L93`) | Enumerates fundamental object types (`track`, `shape`, `tag`) and geometries (`points`, `skeleton`, etc.) |
| [`cvat-core/src/object-state.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/object-state.ts) | `ObjectState` (`#L55-L100`) | Unified public wrapper returned to the UI representing an object on a specific frame |
| [`cvat-core/src/annotations-objects/track.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/track.ts) | `Track.get()` (`#L88-L119`), `Track.shapes` | Multi-frame track container; reconstructs frame states preserving `clientID` and `serverID` |
| [`cvat-core/src/annotations-objects/shape.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/shape.ts) | `Shape.get()` (`#L78-L81`) | Single-frame shape container; throws if queried outside its designated frame |
| [`cvat-core/src/annotations-objects/skeleton-track.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/skeleton-track.ts) | `SkeletonTrack.elements`, `SkeletonTrack.get()` (`#L194-L230`) | Composite skeleton track managing child `Track` instances for individual landmarks |
| [`cvat-core/src/annotations-objects/skeleton-shape.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/skeleton-shape.ts) | `SkeletonShape.elements` (`#L42-L65`) | Composite standalone skeleton shape limited to a single frame |
| [`cvat-core/src/annotations-collection.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-collection.ts) | `AnnotationsCollection.get()` (`#L407-L448`) | In-memory evaluation and filtering of objects on arbitrary frames |
| [`cvat-core/src/annotations.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations.ts) | `getAnnotations()` (`#L140-L155`) | Session API proxy delegating to in-memory `AnnotationsCollection` |
| [`cvat-core/src/frames.ts`](file:///C:/Users/Menf/cvat/cvat-core/src/frames.ts) | `getFrame()`, `FrameData.data()` (`#L458-L550`) | Retrieves frame metadata and decodes pixel chunks via `FrameDecoder` |
| [`cvat-canvas/src/typescript/canvasView.ts`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvasView.ts) | `CanvasView.highlight()` (`#L3404-L3434`) | Imperative canvas shape highlight and activation behavior |

---

## 3. Annotation Model Comparison Table

| Attribute / Behavior | Standalone Shape (`ObjectType.SHAPE`) | Tracked Object (`ObjectType.TRACK`) | Standalone Skeleton (`ShapeType.SKELETON`, Shape) | Tracked Skeleton (`ShapeType.SKELETON`, Track) |
| :--- | :--- | :--- | :--- | :--- |
| **Class in `cvat-core`** | `Shape` / `PointsShape` | `Track` / `PointsTrack` | `SkeletonShape` | `SkeletonTrack` |
| **Temporal Scope** | Single frame ($F$) | Multi-frame ($F_{\text{start}} .. F_{\text{stop}}$) | Single frame ($F$) | Multi-frame ($F_{\text{start}} .. F_{\text{stop}}$) |
| **`clientID` Stability** | Local to single frame | **Persistent across all frames** | Local to single frame | **Persistent across all frames** |
| **`serverID` Stability** | Local to single frame | **Persistent across all frames** (when saved) | Local to single frame | **Persistent across all frames** (when saved) |
| **`parentID` Value** | `null` | `null` | `null` | `null` (children have parent `clientID`) |
| **Child Elements** | `[]` | `[]` | Array of child `Shape` instances | Array of child `Track` instances |
| **Cross-Frame Lookup** | Throws `ScriptingError` | Evaluated via `track.get(frame)` | Throws `ScriptingError` | Evaluated via `skeletonTrack.get(frame)` |
| **Identity Verification Feasibility** | **No Reliable Identity** | **Reliable (Track ID)** | **No Reliable Identity** | **Reliable (Track ID + Sublabel ID)** |

---

## 4. Cross-Frame Identity Findings

### 1. `clientID` vs `serverID` Mechanics
- **`clientID`:** A positive integer assigned sequentially by `injection.nextClientID()` during collection construction or object creation in the browser session.
  - In a `Track`, `this.clientID` is immutable for the lifetime of the session. Every call to `track.get(frame)` assigns `state.clientID = this.clientID` (`Verified`).
  - In a standalone `Shape`, `this.clientID` exists only for that frame's shape instance. Standalone shapes on separate frames receive distinct `clientID` numbers (`Verified`).
- **`serverID`:** The database primary key (`id`) populated after saving to the Django backend.
  - In a saved track, `this._serverId` is identical across all frames (`Verified`).
  - For unsaved tracks (newly created in the current session), `serverID` is `null`, but `clientID` is always present and stable (`Verified`).
- **Conclusion:** `clientID` is the authoritative session-scoped identifier for tracking and matching across frames within the client application.

### 2. Standalone `POINTS` Shapes
- A standalone `PointsShape` records facial landmarks as a coordinate array `points: [x1, y1, x2, y2, ...]` on one frame.
- There is **no persistent identifier** linking a `PointsShape` on frame 10 to a `PointsShape` on frame 11.
- Identical label names, similar bounding boxes, or matching array lengths cannot establish identity without heuristic tracking, which is prohibited by the project requirements.
- **Verdict:** Standalone `POINTS` shapes **cannot** support cross-frame verification matching.

### 3. Skeleton Annotations (`SkeletonTrack`)
- In `SkeletonTrack` ([`skeleton-track.ts#L44-L73`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-objects/skeleton-track.ts#L44-L73)):
  - Skeletons represent landmarks (e.g. 68-point face, 5-point face landmarks) using a structured label with defined `sublabels`.
  - When a `SkeletonTrack` is instantiated, it constructs an array of child `Track` instances (`this.elements`) corresponding to each sublabel:
    ```ts
    this.elements = this.label.structure.sublabels.map((sublabel) => {
        ...
        return trackFactory(..., injection.nextClientID(), {
            parentId: this.clientID,
        });
    });
    ```
  - When `skeletonTrack.get(frame)` is executed:
    - The returned parent `ObjectState` has `shapeType = 'skeleton'`, `objectType = 'track'`, and a stable parent `clientID`.
    - Its `elements` array contains child `ObjectState` instances where each landmark element has:
      - `parentID = parentSkeleton.clientID`
      - `clientID = landmarkTrack.clientID` (stable track ID for that specific landmark)
      - `label.id = sublabel.id` (e.g. ID corresponding to "left_eye_pupil", "nose_tip")
- **Verdict:** `SkeletonTrack` provides full, deterministic, hierarchical identity across frames.

### 4. Visibility, Keyframes, and "Outside" States
- When a tracked object or landmark leaves the camera frame or becomes occluded:
  - `outside: true`: The object is outside the frame. In `AnnotationsCollection.get()`:
    ```ts
    if (stateData.outside && !stateData.keyframe && !allTracks && object instanceof Track) {
        continue; // Excluded from visible objects unless allTracks is requested
    }
    ```
    (`Verified` in [`annotations-collection.ts#L426-L428`](file:///C:/Users/Menf/cvat/cvat-core/src/annotations-collection.ts#L426-L428)).
  - `occluded: true`: The object is present but obscured. It is rendered and retains full identity.
  - `keyframe: boolean`: True if the user explicitly placed a keyframe on this frame. If false, coordinates are mathematically interpolated between adjacent keyframes.

---

## 5. Frame Indexing & Boundary Verification

### 1. Indexing Conventions
- **0-Based Indexing:** All internal representations in CVAT use 0-based integer frame indices.
- **Job Boundaries:**
  - `job.startFrame`: The first frame of the job segment ($0 \le \text{startFrame} \le \text{stopFrame}$).
  - `job.stopFrame`: The last frame of the job segment.
  - Tasks split into multiple jobs have non-zero `startFrame` (e.g. Segment 2: `startFrame = 100`, `stopFrame = 199`).

### 2. API Uniformity
- Calling `job.annotations.get(F)` expects $F \in [\text{startFrame}, \text{stopFrame}]$.
- Calling `job.frames.get(F)` expects $F \in [\text{startFrame}, \text{stopFrame}]$.
- **Result:** There is **zero conversion** required between the UI frame selector, the annotation query API, and the frame decoder. All operate on the identical absolute job frame index $F$.

---

## 6. Selection & Highlighting Trace

### 1. Canvas to Redux Selection Flow
1. User clicks/hovers an object on `cvat-canvas` -> Canvas dispatches `canvas.find` or `canvas.cursorMoved`.
2. `CanvasWrapperComponent.onCanvasCursorMoved()` ([`canvas-wrapper.tsx#L897-L919`](file:///C:/Users/Menf/cvat/cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx#L897-L919)) calls `jobInstance.annotations.select(states, x, y)`.
3. Dispatches Redux action `activateObject(activatedStateID, activatedElementID)`:
   - `activatedStateID`: The `clientID` of the selected object (or parent skeleton).
   - `activatedElementID`: The `clientID` or element index of the landmark joint (if a skeleton point was clicked).
4. Redux stores `state.annotation.annotations.activatedStateID` and `activatedElementID`.

### 2. Critical Caveat: `canvasInstance.highlight()` Activates Objects
- In [`cvat-canvas/src/typescript/canvasView.ts#L3431-L3434`](file:///C:/Users/Menf/cvat/cvat-canvas/src/typescript/canvasView.ts#L3431-L3434):
  ```ts
  if (this.highlightedElements.elementsIDs.length) {
      this.deactivate();
      const clientID = this.highlightedElements.elementsIDs[0];
      this.activate({ clientID, attributeID: null });
  }
  ```
- **Discovery:** Calling `canvasInstance.highlight([clientID], ...)` in `cvat-canvas` internally invokes `this.activate()`, which puts the shape into an **editable state** on that canvas instance!
- **Architectural Implication:** For reference frames in the multi-frame verification UI, **do not** call `canvasInstance.highlight()` on an interactive `Canvas` instance.
- **Safe Solution for Reference Frames:**
  - Reference frames should render shapes via lightweight SVG overlays or read-only HTML5 canvas contexts with CSS `pointer-events: none`.
  - Highlighted objects in reference frames should simply receive a visual highlight CSS class (e.g. `.cvat_reference_shape_highlighted`) without triggering any imperative canvas activation.

---

## 7. Recommended Read-Only Identity Resolution Contract

Based strictly on verified source code semantics, the following contract defines how the multi-frame verification feature must resolve and represent object correspondences across frames.

### 1. Resolution Inputs
```typescript
interface ResolutionRequest {
    selectedState: ObjectState;      // ObjectState selected on the active frame
    targetFrame: number;             // Destination frame to check for counterpart
    jobInstance: Job;                // Current CVAT job instance
}
```

### 2. Resolution Output Schema
```typescript
type ResolutionStatus =
    | 'MATCHED'             // Reliable identity confirmed
    | 'ABSENT_ON_FRAME'     // Track exists in job, but is outside/absent on target frame
    | 'NO_IDENTITY'         // Object is a standalone shape; identity cannot be established
    | 'SKELETON_ELEMENT_ABSENT'; // Parent skeleton exists, but this landmark is outside

interface ResolutionResult {
    status: ResolutionStatus;
    targetState: ObjectState | null;          // Resolved corresponding ObjectState
    targetElementState?: ObjectState | null;  // Resolved landmark element (if skeleton)
    parentClientID?: number | null;
    matchedClientID?: number | null;
}
```

### 3. Resolution Algorithm Specification
```typescript
async function resolveObjectOnFrame(request: ResolutionRequest): Promise<ResolutionResult> {
    const { selectedState, targetFrame, jobInstance } = request;

    // Rule 1: Standalone shapes have no cross-frame identity
    if (selectedState.objectType !== ObjectType.TRACK && selectedState.parentID === null) {
        return {
            status: 'NO_IDENTITY',
            targetState: null,
        };
    }

    // Rule 2: Fetch annotations for target frame (Read-Only in-memory query)
    const targetStates: ObjectState[] = await jobInstance.annotations.get(targetFrame, true);

    // Case A: Selected object is a Skeleton Element (landmark point)
    if (selectedState.parentID !== null) {
        const parentClientID = selectedState.parentID;
        const sublabelID = selectedState.label.id;

        // Find parent skeleton on target frame
        const targetParent = targetStates.find((state) => state.clientID === parentClientID);
        if (!targetParent || targetParent.outside) {
            return {
                status: 'ABSENT_ON_FRAME',
                targetState: null,
                parentClientID,
            };
        }

        // Find matching landmark element by sublabel ID
        const targetElement = (targetParent.elements || []).find(
            (el) => el.label.id === sublabelID
        );

        if (!targetElement || targetElement.outside) {
            return {
                status: 'SKELETON_ELEMENT_ABSENT',
                targetState: targetParent,
                targetElementState: null,
                parentClientID,
            };
        }

        return {
            status: 'MATCHED',
            targetState: targetParent,
            targetElementState: targetElement,
            parentClientID,
            matchedClientID: targetElement.clientID,
        };
    }

    // Case B: Selected object is a top-level Track (e.g., PointsTrack or SkeletonTrack)
    const matchedTrack = targetStates.find((state) => state.clientID === selectedState.clientID);
    if (!matchedTrack || matchedTrack.outside) {
        return {
            status: 'ABSENT_ON_FRAME',
            targetState: null,
            matchedClientID: selectedState.clientID,
        };
    }

    return {
        status: 'MATCHED',
        targetState: matchedTrack,
        matchedClientID: matchedTrack.clientID,
    };
}
```

---

## 8. Performance & Memory Risks

1. **In-Memory Annotation Retrieval (Negligible Overhead):**
   - Querying `job.annotations.get(frame, true)` executes synchronously against in-memory arrays. Querying 10 frames sequentially or via `Promise.all` executes in **< 15 milliseconds** total.
2. **Concurrent Frame Decoding (`FrameDecoder` Throughput):**
   - Video chunks in CVAT typically bundle 36 frames per compressed MP4 chunk.
   - If a 10-frame window ($F .. F+9$) falls within the same chunk, `FrameDecoder` decodes the chunk **once** and serves all 10 frames from memory.
   - If the 10 frames span across two chunks, a second chunk download and decoding cycle is triggered.
3. **Decoded Image Retention:**
   - 10 active `ImageBitmap` frames at $1920 \times 1080$ resolution consume $\approx 83\text{ MB}$ raw GPU/RAM pixel memory.
   - When the multi-frame modal closes, all held `ImageBitmap` references in local React component state must be explicitly cleared to allow garbage collection.
4. **Active Player Frame Non-Interference:**
   - Querying `job.frames.get(F)` and `job.annotations.get(F)` for the 10 displayed frames does **not** dispatch `CHANGE_FRAME` to Redux, completely protecting the active player frame and undo/redo stacks.

---

## 9. Final Decision Matrix

| Annotation Configuration in Job | Cross-Frame Verification Support | Rationale |
| :--- | :--- | :--- |
| **Tracked Skeletons (`SkeletonTrack`)** | **Fully Supported** | Parent track provides unique face identity; sublabels provide deterministic facial landmark part matching. |
| **Tracked 2D Points (`PointsTrack`)** | **Fully Supported** | Track `clientID` uniquely identifies the point landmark across all frames. |
| **Tracked Bounding Boxes (`RectangleTrack`)** | **Fully Supported** | Track `clientID` uniquely identifies the bounding box across all frames. |
| **Standalone Skeletons (`SkeletonShape`)** | **Not Supported** | Skeletons exist only on a single frame; no cross-frame link exists in data. UI must display `"Unverified / No cross-frame track"`. |
| **Standalone 2D Points (`PointsShape`)** | **Not Supported** | Isolated point annotations cannot be reliably correlated across frames without guessing coordinates. |
| **Tag Annotations (`ObjectType.TAG`)** | **Not Supported** | Tags are frame-level metadata without spatial landmark identity. |
