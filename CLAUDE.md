# CLAUDE.md — CVAT Multi-Frame Annotation

This repository is a CVAT fork. The project adds a Multi-Frame Annotation workspace. Follow these rules for all work here.

## Communication

- Explain in Vietnamese by default. Write prompts meant for coding agents entirely in English.
- Keep answers concise and practical, and beginner-friendly when needed.
- Always report the exact repository-relative paths of modified files (for example `cvat-ui/src/...`).
- When asking the user to inspect or edit something by hand, give its exact path.
- Do not ask the user to attach or paste files you can read directly in the repository.
- Do not invent requirements. If something is unclear, ask.

## Working Rules

- Inspect the existing code first: the relevant CVAT modules, state flow and existing patterns. Change only what you need to.
- Preserve existing behavior and unrelated work, including the user's uncommitted changes. Avoid unrelated refactoring and new dependencies.
- Reuse native CVAT mechanisms (annotation state, actions, Undo/Redo, autosave) instead of building parallel ones.
- Add or update tests that cover the behavior you change. Run the relevant tests, lint and builds when practical.
- Report actual results honestly. Never claim something works without verifying it. Say clearly what was not run or not verified.
- When you finish, summarize what changed, the modified file paths, the test/build results and any remaining issues.

## Git Safety

- Never commit, push or perform destructive Git operations (reset, rebase, force-push, branch deletion, discarding changes, etc.) without the user's explicit permission.
- Never change the `origin` remote.
- Wait for the user's approval before committing or pushing.

## Functional Requirements

### Workspace

- The user selects an **inclusive** frame range.
- Show up to **10 frames per batch**, with navigation between batches.
- Preserve each image's aspect ratio. Never stretch or distort frames.
- Resizing or zooming a selected tile happens **in place**. The other frames stay visible.

### Object Selection

- Select objects by their **actual annotation type**, then enter an object ID.
- Match the same object reliably across frames.
- Skeleton landmarks (elements) must belong to their parent Skeleton. Never treat them as independent objects or mix them up between Skeletons.

### Skeleton Rendering and Editing

- Render Skeleton nodes and edges correctly.
- Support moving a single landmark and moving the whole Skeleton.
- Keep the Skeleton's bounding box in sync after every edit.
- Every Skeleton edit must work correctly with Undo/Redo.

### Auto-Zoom / Auto-Follow

- Base it on the existing bounding boxes of the selected object.
- Preserve image aspect ratios.
- It changes the view only. It must **never** modify annotation coordinates.

### Save, Undo/Redo and Deletion

- Use native CVAT annotation state, autosave, persistence and Undo/Redo. Edits made in the multi-frame workspace must persist and be undoable like normal CVAT edits.
- Deletion filters: annotation type (required), object ID (optional) and an **inclusive** frame range.
- Show a preview of the objects that will be deleted, and require confirmation before deleting.
