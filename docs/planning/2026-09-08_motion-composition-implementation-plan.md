# Implementation Plan: Motion Composition & Video Sequencing

> **RETIRED 2026-09-10** — see `2026-09-10_reconciliation.md` §3. Phase 1 is a re-housing of
> shipped machinery: `VideoCompositorPort`, `CanvasFfmpegVideoCompositor.writeFrames`,
> `MOTION_FPS`, `CopyTimeline`, `beatAt`. The keyframe half is replaced by
> `2026-09-10_keyframing.md`, which puts tracks inside the existing ports-and-adapters split
> rather than a new bounded context. Do not implement.

**Date:** 2026-09-08
**Context:** Transitioning Campaign Foundry from an approval-loop proof-of-concept into a market-ready video generation platform for advertising.
**Architectural Goal:** Establish the `MotionComposition` bounded context to support true multi-track, keyframe-based video generation with maximum production scalability, strictly adhering to our hexagonal architecture.

---

## 1. Architectural Strategy (Path B)

We will introduce a dedicated bounded context for motion: `packages/MotionComposition`. This decouples the core domain logic (what a timeline *is*) from the infrastructure implementation (how to render it via Canvas, Remotion, or WebCodecs).

### 1.1 The Hexagonal Boundaries

*   **Domain (`domain/`)**: Pure TypeScript entities representing `Timeline`, `Clip`, `Keyframe`, and `EasingCurve`.
    *   *Rule:* No references to DOM, Canvas, ffmpeg, or Node-specific built-ins.
    *   *Core Method:* `Timeline.getFrameStateAt(t: number)` — deterministically resolves the layout properties for any given millisecond.
*   **Application (`application/`)**: Use cases (e.g., `RenderTimelineUseCase`) and Port definitions.
    *   *Core Port:* `MotionRendererPort` defines how the application asks the infrastructure to produce video.
*   **Infrastructure (`infrastructure/`)**: The concrete adapters.
    *   *Adapter:* `FfmpegCanvasAdapter` (Phase 1 MVP) handles the piping of pure frame states into a canvas, which is then piped to ffmpeg.

---

## 2. Default Configurations & Standards

To ensure consistency and determinism, the `MotionComposition` domain will enforce the following defaults:

### 2.1 Video Specifications
*   **Framerate:** 30 FPS (configurable per `Timeline`, but defaults to 30 to balance smoothness and render speed).
*   **Duration:** 6000ms (6 seconds) default for standard display and social units.
*   **Resolutions:** Inherited from the Brief's target formats (e.g., `1080x1080` for 1:1, `1080x1920` for 9:16).
*   **Codec:** H.264 (MP4) for maximum platform compatibility. AAC for audio.

### 2.2 Animation Defaults
*   **Easing:** `ease-in-out` (Cubic Bezier: `0.42, 0, 0.58, 1`) is the default transition curve to ensure smooth, natural motion.
*   **Properties:** Animatable properties default to: `opacity` (0-1), `scale` (multiplier), `position` ({x, y} percentage relative to container bounds).
*   **Layout Schema:** Layout elements will accept a JSON schema descriptor referencing these properties.

---

## 3. Suggested Features (Phased Rollout)

The features are broken down to deliver immediate marketing value while building toward the ultimate vision.

### Phase 1: Playback & Extensible Composition (The MVP)
*   **JSON-Schema Layout Descriptors:** Deprecate hardcoded Z-order in `NodeCanvasCompositor` in favor of a data-driven layout schema.
*   **The Playback Scrubber:** Add a read-only timeline scrubber to the UI's Review Grid, allowing users to play generated MP4s and visualize compliance gates (brand density, prohibited words) over time.
*   **FfmpegCanvasAdapter:** Implement the first renderer port using standard Canvas + `ffmpeg-static` for fully offline, deterministic generation.

### Phase 2: Keyframe Animation Editor (The Core Product)
*   **Multi-track Timeline UI:** A new section in the editor (`MotionTimelineSection`) where users can visually position clips and assign keyframes to layout elements (e.g., "Logo slide-in").
*   **Interactive Playhead:** Scrubbing the UI timeline fetches `getFrameStateAt(t)` and renders a live, low-fidelity preview in the UI dock.
*   **Copy Beat Syncing:** Integrate the existing copy beats directly into the timeline tracks.

### Phase 3: Scale & Collaboration (The Enterprise Platform)
*   **Audio / Voiceover Syncing:** Extend the `pool://` mechanism to support `pool://audio`. Introduce a waveform track in the UI for visually syncing motion to beats.
*   **Remotion/Serverless Adapter:** Implement a `RemotionAdapter` for `MotionRendererPort` to farm out massive batch rendering to AWS Lambda/Serverless environments, bypassing the local CPU bottleneck.
*   **Draft Campaign Service:** Introduce a real-time collaborative locking and revision service to support multi-user brief editing.

---

## 4. Implementation Plan (Step-by-Step)

### Step 1: Package Scaffolding & Domain Modeling
1.  Initialize `packages/MotionComposition` in the monorepo workspace.
2.  Define the entities in `src/domain/`:
    *   `keyframe.ts` (id, timeMs, value, easing)
    *   `clip.ts` (startMs, durationMs, elementRef, tracks)
    *   `timeline.ts` (durationMs, fps, clips, `getFrameStateAt()`)
3.  Write Vitest unit tests to prove `getFrameStateAt()` correctly interpolates values across keyframes.

### Step 2: Application Ports & Initial Adapter
1.  Define `MotionRendererPort` in `src/application/ports/`.
2.  Implement `FfmpegCanvasAdapter` in `src/infrastructure/adapters/`.
    *   *Implementation detail:* Loop from `0` to `durationMs` at `1000/fps` increments.
    *   Call `getFrameStateAt(t)`.
    *   Pass the state to `NodeCanvasCompositor` (reused from `CreativeGeneration`).
    *   Extract the canvas buffer and write to an `ffmpeg` child process `stdin`.
3.  Add E2E tests validating that a mock timeline generates a valid MP4 file.

### Step 3: Wire to CampaignOrchestration
1.  Update the `CampaignBrief` schema to support an optional `timeline` object.
2.  Create the `RenderTimelineUseCase`.
3.  Expose `POST /campaigns/:id/render-timeline` in the API.

### Step 4: UI Updates (Phase 1)
1.  In `apps/web`, build the `TimelineScrubber` component for the Review step.
2.  Map the `complianceFrames` array to the scrubber to visually indicate when a frame passes/fails brand guidelines.

### Step 5: Extensible Layout (Parallel Track)
1.  Refactor `NodeCanvasCompositor` to accept a `LayoutDescriptor` instead of relying on hardcoded rendering logic.
2.  Ensure backward compatibility with existing static briefs.

---

## 5. Risks & Mitigation

*   **Risk:** `ffmpeg` dependency introduces environmental inconsistency (missing binary, version mismatch).
    *   **Mitigation:** Continue using `ffmpeg-static` for guaranteed availability, and fail gracefully to static PNGs if encoding fails.
*   **Risk:** Canvas frame-by-frame rendering becomes too slow for high-resolution 60fps video.
    *   **Mitigation:** Default to 30fps and 6s duration. For the future, the `MotionRendererPort` abstraction allows swapping to the `RemotionAdapter` or WebCodecs without rewriting the application logic.
*   **Risk:** UI timeline state management becomes overly complex.
    *   **Mitigation:** Isolate the motion state in a dedicated sub-reducer within the `EditorState`, avoiding pollution of the main brief state until save.
