# Video Editing Features — Architecture & Development Plan

**Date:** 2026-09-13
**Status:** Proposed. Phase A is dispatchable; Phases B and C wait on the open questions in §8.
**Scope:** Which ideas from a reference video editor fit Campaign Foundry, and how each is built on
the existing server-side compositor instead of beside it.
**Related:** `2026-09-10_keyframing.md` (K1–K5), `2026-09-10_finishing-video.md`,
`2026-08-27_motion-copy-timeline.md` (D7, D10), `2026-09-01_template-authoring-and-preview-fidelity.md`
(D52), `2026-09-06_create-dialog-recomposition.md` (D88), `2026-08-25_randomized-campaigns-and-motion.md`
(D11), `2026-09-10_the-html-layer.md` (HL-D7).

Reference project: `reactvideoeditor/free-react-video-editor` and its documentation at
`reactvideoeditor.com/docs`. Every claim about the current codebase below was checked against `main`
at `1f85d04`.

---

## 0. Decisions

| ID | Decision | Consequence |
|---|---|---|
| **VE-D1** | **Adopt no code from the reference project or its rendering engine.** Take ideas only. | The free repository is a 489-line single-file demo with no drag, trim, undo, upload or export, last changed 2025-02-15 (C1, M1). Every real feature is in paid editions under a commercial licence with audit rights and a stated £50,000-per-breach penalty, and the engine underneath (Remotion) needs a paid company licence from four people — **aggregating the client's headcount** when the client owns the project (C1). |
| **VE-D2** | **The compositor stays the only renderer.** Every capability here extends the server path; nothing renders in the browser and nothing exports client-side. | A browser player is a second renderer, and the preview must be a real compositor frame (D52). Client export would also skip the server-side legal gate and packaging (H1). |
| **VE-D3** | **A brief that uses none of the new inputs renders byte-identically.** | D10's guarantee and the pinned MP4 golden (`CanvasFfmpegVideoCompositor.ts`, `-fflags +bitexact`) extend to every lane: no audio, no scenes, no footage ⇒ the existing golden holds unchanged. **A moved hash is a finding, never a re-record.** |
| **VE-D4** | **Captions ship with speech, not before it.** | Every line of copy is already burned into the frame. Without audio a caption track repeats on-screen text, and a player that overlays captions shows it twice (M2). Captions belong to voiceover (VE4). |
| **VE-D5** | **Scrubbing is a new control, user-driven, never autoplaying, and it leaves `ScrubBar` alone.** The preview request gains an optional `atSec`. | `ScrubBar` is a decorative option icon in the create dialog, frozen by D88 — "nothing here animates, ever" (`packages/ui/src/scrub-bar.tsx`). It is not a player (M3). A control the user drags is not a looping animation, so D88 is respected, and it lives in the editor's preview dock, not the dialog tiles. |
| **VE-D6** | **A scrub frame is the encoded frame, exactly.** | The frame at `atSec` is drawn by the same `NodeCanvasCompositor.draw` call, with the same pose, copy and effect clocks, that produces frame `i = round(atSec / durationSec × (frames − 1))` of the video, where `frames = round(durationSec × fps)` and frame `i` is drawn at pose time `i / (frames − 1)` (`CanvasFfmpegVideoCompositor.ts:93,316`). Fidelity is a byte comparison, not a visual judgement. |
| **VE-D7** | **Keyframes are the keyframing plan's.** | K1–K5 already specify tracks on the layer (K-D1–K-D6). This plan points at them and adds no fourth motion system. |

---

## 1. Context & current state (verified)

| Area | Today | Evidence |
|---|---|---|
| Video output | One still background with a pose clock (ken-burns / headline-rise / accent-wipe), a sequence of copy beats, logo, encoded to MP4 at 30 fps. | `MotionKind.vo.ts:7` (`MOTION_FPS = 30`); `CanvasFfmpegVideoCompositor.ts` |
| Audio | **None.** ffmpeg takes one input, raw RGBA on stdin; no audio codec flags. | ffmpeg args in `CanvasFfmpegVideoCompositor.ts`: `-f rawvideo … -i - … -c:v libx264 …`; `-c:a` absent |
| Copy timeline | Up to 8 beats with integer **weights**, `cut`/`fade`, a key beat for the poster. Absolute times come from `resolveTimeline(t, durationSec)`. | `CopyTimeline.vo.ts:22,34-45,91` |
| Poster / single frame | The adapter already draws one frame at chosen clocks without encoding (the poster), and samples frames at arbitrary `t` for the brand-colour check. | `CanvasFfmpegVideoCompositor.ts` poster block (`NodeCanvasCompositor.draw(ctx, prepared, restT(…), …)`) and `sampledFrames` |
| Editor preview | A still PNG from the real compositor, fed by the procedural background so no credits are spent (D52). The request carries `{ productId, canvas, layout, tone, anchor? }` — **no time**. | `preview-frame.post.ts:22-40`; `PreviewCreativeFrameUseCase.use-case.ts:24-31` |
| Editor state | `useReducer(editorReducer, …)` over an `EditorAction` union with a `restore` action for drafts. **No undo or redo.** | `editor-state.ts:425,498,2531`; `BriefEditor.tsx:179` |
| Uploads | `.png`/`.jpg`/`.jpeg` only, under `MAX_ASSET_BYTES`. | `assets.post.ts:16-17,34` |
| Video input | **None, by decision.** "It does not add video decoding… `videoPath` is output only." | `2026-09-10_finishing-video.md:104-105` |
| Packaging | Copies the mp4 and poster; never re-renders (D11). Motion profiles cap duration at 60–600 s. | `PackageForPlatformUseCase.use-case.ts` motion branch; `PlatformProfile.vo.ts:135-162` |

**Guiding principles.** One renderer (VE-D2). Absent inputs change nothing (VE-D3). Every new byte of
content reaching an ad passes the same legal gate copy already passes. Templates stay the contract
(D123, D124): this is not a free-form editor.

---

## 2. Review findings

| ID | Sev | Finding |
|---|---|---|
| **C1** | Critical | **Licensing rules out adopting the reference project.** The free repo's `LICENSE.md` says MIT with a placeholder copyright while its README says commercial use requires the paid RVE licence *and* a Remotion licence. The paid licence bans extracting components, reserves audits and names a £50,000-per-breach penalty. Remotion is source-available, free only up to three people, and counts both companies' headcount when an agency's client owns the project. → VE-D1. |
| **H1** | High | **A browser renderer breaks preview fidelity and determinism.** Its player would render a creative the compositor did not draw, contradicting D52, and its output could not share the MP4 golden that D10 pins. → VE-D2. |
| **H2** | High | **An in-app player renders brief content into the application's own DOM**, which HL-D7 forbids. → VE-D2. |
| **M1** | Medium | **The free repository contains nothing reusable.** One component, one hardcoded clip URL, local state only, no export. |
| **M2** | Medium | **Correction to this plan's first draft: captions were ranked first.** Without speech they duplicate burned-in copy. → VE-D4. |
| **M3** | Medium | **Correction to this plan's first draft: "make the scrubber move."** `ScrubBar` is an icon frozen by D88, not a player control. → VE-D5. |
| **L1** | Low | The vendor's `llms.txt` advertises an npm package, `@react-video-editor/core`, that returns 404 on npm. Its marketing is not a source for this plan. |

---

## 3. Phase A — no owner decision needed

### VE1 — Undo and redo in the editor

| # | Task | File(s) |
|---|---|---|
| 1 | Wrap `editorReducer` in a history reducer: past / present / future, with a bounded depth. | `apps/web/src/components/campaign/editor-state.ts` (or a sibling `editor-history.ts`) |
| 2 | Decide which actions are undoable. View-only actions (presentation, rail view) must not create history entries. | same |
| 3 | Coalesce consecutive text edits to one field into a single history entry. | same |
| 4 | `restore` replaces the baseline and clears both stacks — undo must never step back across a restored draft. | same |
| 5 | Keyboard shortcuts (⌘Z / ⇧⌘Z, Ctrl on other platforms), ignored while focus is in a native text input that has its own undo. | `apps/web/src/components/campaign/BriefEditor.tsx` |

**Acceptance.** Undo after any undoable action returns exactly the prior `EditorState`; redo re-applies
it; a new action clears redo; typing a word is one undo step; undo immediately after `restore` does
nothing; view-only toggles never appear in history.

### VE2 — Scrub the preview

| # | Task | File(s) |
|---|---|---|
| 1 | Add optional `atSec` to the preview cell, validated within `[0, durationSec]`; absent keeps today's still exactly. | `PreviewCreativeFrameUseCase.use-case.ts`, `apps/api/server/routes/campaigns/preview-frame.post.ts` |
| 2 | Include `atSec` in the frame fingerprint so the cache never serves one moment for another. | `PreviewCreativeFrameUseCase.use-case.ts` |
| 3 | Map `atSec` to frame `i = round(atSec / durationSec × (frames − 1))` and draw it with the same clocks `encodeFrames` uses for that frame — reuse, do not re-derive. | `packages/CreativeGeneration/src/infrastructure/adapters/CanvasFfmpegVideoCompositor.ts`, `VideoCompositorPort.ts` |
| 4 | A range control in the editor's preview dock that requests frames on release, with in-flight requests superseded. **Never autoplay.** | `apps/web/src/components/campaign/CreativePreview.tsx` (or a new control beside it) |
| 5 | Keep the procedural generator wiring — scrubbing must spend no credits. | preview route wiring |

**Acceptance.** For a fixed brief, the scrub PNG at `atSec` decodes to the same RGBA as frame `i` fed to the encoder (VE-D6), including at `atSec = 0` and
`atSec = durationSec` (the last frame, not one past it); a request without `atSec` returns today's bytes; the
existing "no other generator is reachable" test still passes; `ScrubBar` is unchanged.

---

## 4. Phase B — each lane waits on one open question

### VE3 — Music bed · waits on VE-Q1

| # | Task | File(s) |
|---|---|---|
| 1 | A brief-level audio reference to an uploaded asset, with the rights record VE-Q1 decides. | `CampaignBrief.ts`, `load-brief.ts` |
| 2 | Accept audio uploads (format list and byte cap decided in the lane). | `apps/api/server/routes/campaigns/assets.post.ts` |
| 3 | Second ffmpeg input; encode AAC; cut to `durationSec`; short fade-out; keep bit-exact flags. | `CanvasFfmpegVideoCompositor.ts` |
| 4 | Refuse a brief whose audio lacks the required rights record, at the boundary. | `load-brief.ts`, compliance checker |
| 5 | A second golden for the audio case; the silent golden must not move. | adapter golden tests |

**Acceptance.** A brief without audio produces the existing MP4 bytes (VE-D3); a brief with audio
produces a stream with one AAC track exactly `durationSec` long; missing rights metadata is refused
before any frame is drawn.

### VE4 — Voiceover and captions · waits on VE-Q2, depends on VE3

| # | Task | File(s) |
|---|---|---|
| 1 | Voiceover as a second audio source mixed under/over the music bed. | `CanvasFfmpegVideoCompositor.ts` |
| 2 | Caption cues timed to the **speech**, not to beat weights — the timing source is what VE-Q2 decides. | new value object beside `CopyTimeline.vo.ts` |
| 3 | Write a WebVTT sidecar at **generation** (packaging never re-renders, D11) and package it beside the mp4. | `GenerateCampaignUseCase.use-case.ts`, `PackageForPlatformUseCase.use-case.ts` |
| 4 | Spoken and captioned text pass the same legal gate as copy. | compliance checker |

**Acceptance.** Captions exist only when speech does; every cue's text passed the legal gate; the
sidecar is packaged for motion platforms and absent otherwise.

### VE5 — Scenes: a background per beat · waits on VE-Q3

| # | Task | File(s) |
|---|---|---|
| 1 | A beat may name its own background; absent means the creative's background, as today. | `CopyTimeline.vo.ts` |
| 2 | Prepare one ground per distinct background; `cut`/`fade` apply between scenes as they apply between beats. | `CanvasFfmpegVideoCompositor.ts`, `NodeCanvasCompositor.ts` |
| 3 | The poster shows the key beat's scene (D7). | poster block |
| 4 | Generation cost scales with distinct backgrounds; enforce the budget VE-Q3 sets. | `GenerateCampaignUseCase.use-case.ts` |

**Acceptance.** A timeline naming no backgrounds is byte-identical (VE-D3); a two-scene timeline
switches ground exactly at the resolved beat boundary; the poster matches the key beat's scene.

---

## 5. Phase C — reverses a recorded decision

### VE6 — Import footage, with trim · waits on VE-Q4

`2026-09-10_finishing-video.md` states the platform "does not add video decoding" and that `videoPath`
is output only. This lane reverses that and must not start until the owner says so. Minimal slice:
one uploaded clip as the `video` layer's ground, trimmed to an in/out range, re-timed to
`durationSec`. It brings a pinned decoder, far larger uploads than `MAX_ASSET_BYTES` allows, and a new
source of non-determinism the golden discipline has to absorb.

**Acceptance (sketch).** Decoded frames are reproducible across runs on the pinned binary; a brief
without footage is byte-identical (VE-D3); trim bounds are validated at the boundary.

---

## 6. Dependency graph

```
Phase A (independent)          Phase B                          Phase C
  VE1 undo/redo                  VE3 music ── VE4 voiceover+captions
  VE2 scrub preview              VE5 scenes                       VE6 footage (VE-Q4)
                                 (VE-Q1)      (VE-Q2)   (VE-Q3)
Keyframes: see 2026-09-10_keyframing.md (K1 blocked on its own questions)
```

VE1 and VE2 touch disjoint files and can run in parallel. VE3 and VE5 both edit
`CanvasFfmpegVideoCompositor.ts` and must not run concurrently.

---

## 7. Cross-cutting concerns

- **Credits.** Previews and scrubbing stay on the procedural generator (D52). Scenes multiply real
  generation calls per creative; that is VE-Q3's budget, not an implementation detail.
- **Determinism.** Every lane proves byte identity for briefs that do not use it (VE-D3). Goldens are
  never re-recorded to make a lane green.
- **Compliance.** Audio rights (VE3) and spoken or captioned text (VE4) enter the same gate copy
  already passes; nothing reaches an ad around it.
- **Byte and duration budgets.** Audio adds bytes against `maxBytes` (100 MiB motion) and every track
  is cut to the brief's duration, which already binds tighter (2–30 s) than any platform's cap.
- **CI.** Anything a test spawns must be POSIX `sh`; CI runners have no zsh.

---

## 8. Open questions

| ID | Question | Blocks |
|---|---|---|
| **VE-Q1** | What rights record must a music asset carry (licence id, source, expiry, territory), and is an asset without one refused or warned? | VE3 |
| **VE-Q2** | Voiceover source: uploaded recording, or generated speech? Generated speech gives word timings for captions; an upload needs an alignment step. | VE4 |
| **VE-Q3** | Scene budget: how many distinct generated backgrounds may one creative spend? | VE5 |
| **VE-Q4** | Reverse "does not add video decoding" and accept user footage? | VE6 |

---

## 9. Risks & notes

- **Audio determinism is unproven here.** The native AAC encoder with bit-exact flags is expected to be
  reproducible, but VE3 must demonstrate it with a golden before relying on it.
- **Scrub request volume.** Dragging can issue many requests; superseding in-flight requests and the
  existing frame cache keep it bounded, and VE2's acceptance includes the cache fingerprint.
- **Undo and async results.** Preview frames and generation results are not editor state; history must
  cover edits only, or undo will appear to "revert" a render.

## 10. What this plan refuses

- **A free-form multi-track editor.** Templates are the contract (D123, D124); arbitrary clips and free
  positioning would dissolve the on-brand-at-scale guarantee the platform exists for.
- **Browser rendering or export.** VE-D2.
- **Stock-media integrations.** Firefly already generates grounds, and third-party stock adds a rights
  surface no lane here needs.
- **Speech-to-text captions before speech exists.** VE-D4.

## 11. Definition of Done

- Phase A: VE1 and VE2 merged, each with its premise retired in its own PR, 100 % on all four coverage
  counters, and a mutation manifest that replays.
- Phases B and C: not started until their open question is answered in this document.
- For every lane: a brief that does not use the feature produces byte-identical output.

---

## 12. Premises

Each open lane states the gap that makes it necessary as a script that exits 0 **while the gap is
still open**. `yarn plan:verify` runs them.

```premise VE1
# The editor has no undo or redo action.
! grep -rqE '"(undo|redo)"' apps/web/src/components/campaign
```

```premise VE2
# The preview request carries no time: it can only render the still.
! grep -q 'atSec' packages/CampaignOrchestration/src/application/use-cases/PreviewCreativeFrameUseCase.use-case.ts
```

```premise VE3
# The encoder takes one raw-video input and no audio codec.
! grep -qF -- '"-c:a"' packages/CreativeGeneration/src/infrastructure/adapters/CanvasFfmpegVideoCompositor.ts
```

```premise VE4
# No caption sidecar is written or packaged anywhere.
! grep -rqi 'webvtt' packages/CampaignOrchestration/src packages/Distribution/src apps/api/server
```

```premise VE5
# A copy beat carries text and weight only — no per-beat background.
! grep -q 'background' packages/CampaignOrchestration/src/domain/value-objects/CopyTimeline.vo.ts
```

```premise VE6
# Nothing probes or decodes an input video.
! grep -rqiE 'ffprobe|inputVideo' packages/CreativeGeneration/src packages/CampaignOrchestration/src apps/api/server
```
