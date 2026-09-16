# Video Editing Features — Architecture & Development Plan

**Date:** 2026-09-13
**Status:** Phase A shipped (VE1, VE2). VE-Q1–VE-Q4 answered by the owner on 2026-09-15 (VE-D8–VE-D11, recommended defaults, refined by plan review); VE5a shipped, then VE5b1 shipped (this PR). VE3a is dispatchable; VE3b and VE5b2 follow their predecessors. VE4 waits on the speech vendor (VE-Q5). VE6 is deferred (VE-D11).
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
| **VE-D5** | **Scrubbing is a new control, user-driven, never autoplaying, and it leaves `ScrubBar` alone.** The preview cell gains `motion`, `durationSec` and `atSec` **together**; the control is absent when the brief renders no motion. The scrub position is local component state and **never an editor action**. | `ScrubBar` is a decorative option icon in the create dialog, frozen by D88 — "nothing here animates, ever" (`packages/ui/src/scrub-bar.tsx`). It is not a player (M3). A dragged control is not a looping animation, so D88 holds. `atSec` alone determines nothing: `prepare` resolves beats from `durationSec` and the timeline, and `draw` needs the motion kind, while a variation brief can list several of each (R1). Keeping the position out of `EditorState` keeps it out of undo history and out of VE1's file (R7). |
| **VE-D6** | **A scrub frame is the encoded frame, exactly — and it is a *motion* frame, not today's still.** | Encoded frame `i` is `NodeCanvasCompositor.draw(ctx, prepared, i / (frames − 1), request.motion)` with the copy and effect clocks **omitted** (`CanvasFfmpegVideoCompositor.ts:316`), where `frames = round(durationSec × fps)` (`:93`). The poster and the editor's still both pass `effectT = 1` and are **not** comparable (R3). For `atSec`, `i = round(atSec / durationSec × (frames − 1))`. Fidelity is a byte comparison against the raw RGBA the encoder receives, not a visual judgement. |
| **VE-D7** | **Keyframes are the keyframing plan's.** | K1–K5 already specify tracks on the layer (K-D1–K-D6). This plan points at them and adds no fourth motion system. |
| **VE-D8** | **Music rights are a record on the brief, checked in two tiers.** `audio: { path, rights: { licenceId, source, expiresOn?, territories? } }`. A missing `licenceId` or `source` **refuses the brief at load**. An `expiresOn` in the past **halts the run in the legal gate** exactly as prohibited copy does. **Territories** (refined by plan review — `targetRegion` is free text, `CampaignBrief.ts:24`, so coverage cannot be matched against prose): `territories` absent means worldwide; present, it is a non-empty array of ISO 3166-1 alpha-2 codes (`^[A-Z]{2}$`), and **shape-checked further**: the ISO 3166-1 user-assigned codes (`AA`, `QM`-`QZ`, `XA`-`XZ`, `ZZ`) are refused as a small pattern rule — real *assignment* to a country is not verified; load **refuses** a brief whose `targetRegion` (trimmed, upper-cased) is not itself an alpha-2 code while `territories` is present; the legal gate **halts** when that code is not in the set. Expiry is **re-checked at packaging**. Nothing is warned-and-rendered. | Owner, 2026-09-15 (VE-Q1). The code has three tiers — legal copy halts the run (`GenerateCampaignUseCase.use-case.ts` `runLegalGate`), brand density flags, occlusion advises — and a missing licence is a legal fact. The asset store carries no metadata channel, so the record lives on the brief. Packaging never re-renders (D11) and may run after expiry, hence the re-check — against the use case's injected `packagedAt`, never `new Date()`. |
| **VE-D9** | **Voiceover is generated speech from a separate `voiceover.script` field**, swept by the legal gate with copy and beats, its audio cached by provider, model id and seed so a golden can pin it. **The vendor is VE-Q5.** | Owner, 2026-09-15 (VE-Q2). No speech code exists, so either answer is a new dependency; generated speech is one adapter and yields word timings for captions, where an upload needs a decoder and an aligner. A separate script keeps captions from repeating burned-in copy (VE-D4, M2). |
| **VE-D10** | **At most 3 distinct per-beat backgrounds per timeline**, enforced as a timeline authoring rule in `CopyTimeline.vo.ts` beside `MAX_BEATS`, so the parser and the editor refuse the same thing (D3). (Refined by plan review: generated-vs-procedural is the *variant's* background source, `variant.backgroundSource`, invisible to the timeline validator — so the cap counts distinct values regardless of source, and "a procedural scene spends nothing" is a statement the **estimate** makes, in VE5b2.) | Owner, 2026-09-15 (VE-Q3). No credit budget exists today, and variation mode multiplies scene cost by `count × ratios`; 3 covers open, middle and close. |
| **VE-D11** | **"Does not add video decoding" stands.** VE6 is deferred, not scheduled; revisit only after VE3b's AAC golden proves audio determinism. | Owner, 2026-09-15 (VE-Q4). Decode is unpinned (the compositor pins encode and scale only), uploads are base64 JSON capped at 2 MiB, and goldens would need committed video fixtures. A poster-only slice (one still extracted at upload) is the recorded middle ground if footage becomes a requirement. |

---

## 1. Context & current state (verified)

| Area | Today | Evidence |
|---|---|---|
| Video output | One still background with a pose clock (ken-burns / headline-rise / accent-wipe), a sequence of copy beats, logo, encoded to MP4 at 30 fps. | `MotionKind.vo.ts:7` (`MOTION_FPS = 30`); `CanvasFfmpegVideoCompositor.ts` |
| Audio | **None.** ffmpeg takes one input, raw RGBA on stdin; no audio codec flags. | ffmpeg args in `CanvasFfmpegVideoCompositor.ts`: `-f rawvideo … -i - … -c:v libx264 …`; `-c:a` absent |
| Copy timeline | Up to 8 beats with integer **weights**, `cut`/`fade`, a key beat for the poster. `resolveTimeline` returns **normalised** `t`-windows; `durationSec` only bounds the fade width. | `CopyTimeline.vo.ts:22,34-45,85-110` |
| Poster / single frame | The poster draws one frame without encoding, but with `effectT = 1`; the per-frame clock math lives in the private `writeFrames`, and `compositeVideo` always spawns ffmpeg. There is **no public single-frame seam**. | `CanvasFfmpegVideoCompositor.ts:91-120,307-320` |
| Editor preview | A still PNG through `CompositorPort.compositeAsset` — `draw(ctx, prepared, 1, undefined, undefined, 1)`, no motion, no timeline — fed by the procedural background so no credits are spent (D52). The cell carries `{ productId, canvas, layout, tone, anchor? }`: **no time, motion or duration**, and the use case never reaches the video adapter. | `PreviewCreativeFrameUseCase.use-case.ts:24-32,70-77`; `NodeCanvasCompositor.ts:498-506`; `preview-frame.post.ts:22-50` |
| Editor state | `useReducer(editorReducer, …)` over a 43-variant `EditorAction` union. `EditorState` holds draft fields **and** server answers: `source` (revision, saved snapshot), `pool`, `appliedSnapshot`, `capabilities`. `BriefEditor` persists the whole state to localStorage and diffs it against a stored draft. **No undo or redo.** Presentation and rail-view toggles are component state, not actions. | `editor-state.ts:257-263,407,421-422,425-503,2531`; `BriefEditor.tsx:101-139,179,361,481` |
| Uploads | `.png`/`.jpg`/`.jpeg` only, 2 MiB, PNG magic-checked. | `apps/api/server/lib/asset-files.ts:10,12,14` (`ASSET_NAME_PATTERN`, `MAX_ASSET_BYTES`, `PNG_MAGIC`) |
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


### 2a. Plan review (2026-09-13) — every point verified against `main`, every one accepted

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| **R1** | Blocking | `atSec` alone does not determine a frame: beats resolve from `durationSec` + timeline and `draw` needs the motion kind, none of which the cell carries. | VE-D5: `motion`, `durationSec`, `atSec` together. |
| **R2** | Blocking | The preview use case depends on `CompositorPort` only and never reaches the video adapter; the per-frame math is private and `compositeVideo` always spawns ffmpeg. | VE2 tasks 1–2: a `compositeFrame` seam and a `videoCompositor` dependency. |
| **R3** | Blocking | Encoded frames omit the copy and effect clocks, the poster and still pass `effectT = 1`, and the existing fake spawn discards stdin — the equality criterion had no seam and would copy the wrong call. | VE-D6 states the exact call; VE2 acceptance captures stdin. |
| **R4** | Blocking | VE1 excluded "presentation and rail view" actions that do not exist; that criterion could not fail. | VE1 task 2 names the real exclusion set. |
| **R5** | Should | `load` and `discard` also replace the draft, and `save`/`apply` write server revisions into state; a naive undo would revert a revision and turn the next save into a conflict. | VE1 tasks 3–4. |
| **R6** | Should | `BriefEditor` persists and diffs the whole state; a `{past, present, future}` shape would leak history into localStorage and back through `restore`. | VE1 task 1: history lives in a hook, never in `EditorState`. |
| **R7** | Should | VE2 named the SVG twin (`CreativePreview.tsx`); the real files are `lib/preview-frame.ts`, `PreviewFrame.tsx`, `PreviewDock.tsx`. VE1 ∥ VE2 holds only if the scrub position never enters `editor-state.ts`. | VE2 task 6; VE-D5; §6. |
| **R8** | Should | The frame fingerprint is pinned by a test; new fields must use the existing conditional spread, and hash the frame index rather than raw `atSec`. | VE2 task 4. |
| **R9** | Should | Upload rules live in `asset-files.ts`, not `assets.post.ts`. | §1; VE3 task 2. |
| **R10** | Should | Premises VE3, VE5, VE6 could be tripped or missed by unrelated text. | §12 sharpened. |
| **R11** | Nit | `resolveTimeline` returns normalised windows, not absolute times. | §1. |

---

## 3. Phase A — no owner decision needed

### VE1 — Undo and redo in the editor

| # | Task | File(s) |
|---|---|---|
| 1 | A `useEditorHistory` hook wrapping `editorReducer` (the exported, clamping reducer at `editor-state.ts:2531`), returning the present `EditorState` plus `undo`/`redo`/`canUndo`/`canRedo`. **History lives in the hook and never enters `EditorState`**, so localStorage persistence and the stored-draft diff see exactly what they see today. | new `apps/web/src/components/campaign/editor-history.ts`; `BriefEditor.tsx:179` |
| 2 | Undoable = draft edits. **Not undoable** (server answers and persistence): `setCapabilities`, `loadPool`, `load`, `apply`, `save`, `restore`, `discard`. `setPool` writes `variation.headline`, so it edits the draft — decide, and state the decision. | `editor-history.ts` |
| 3 | Undo restores **draft fields only** and carries forward the current `source` (revision and saved snapshot), `pool`, `appliedSnapshot` and `capabilities`, so undo never reverts a server revision. | `editor-history.ts` |
| 4 | `load`, `discard` and `restore` each replace the baseline and clear both stacks. | `editor-history.ts` |
| 5 | Consecutive edits to the same text field coalesce into one history entry. | `editor-history.ts` |
| 6 | ⌘Z / ⇧⌘Z (Ctrl elsewhere), ignored while focus is in a native text input that has its own undo. | `BriefEditor.tsx` |

**Acceptance.** After an undoable action, undo yields a state whose draft fields equal the prior draft
**and** whose `source`, `pool`, `appliedSnapshot` and `capabilities` equal the *current* ones; a `save`
landing between an edit and its undo leaves `source.revision` unchanged by the undo; `canUndo` is
false after `load`, `discard` and `restore`; the object handed to `saveDraftToStorage` has exactly
`EditorState`'s keys; typing a word is one undo step.

### VE2 — Scrub the preview

| # | Task | File(s) |
|---|---|---|
| 1 | Factor the per-frame clock math out of the private `writeFrames` into one function both paths call, and add `VideoCompositorPort.compositeFrame(request, atSec)` that draws frame `i` **without** spawning ffmpeg or requiring `ffmpegPath`. | `CanvasFfmpegVideoCompositor.ts:91-105,307-320`; `packages/CampaignOrchestration/src/application/ports/out/VideoCompositorPort.ts` |
| 2 | `PreviewCreativeFrameDeps` gains `videoCompositor`. A cell with `atSec` renders through it with `fps = MOTION_FPS` and `timeline = brief.copy.timeline`; a cell without it takes today's still path unchanged. | `PreviewCreativeFrameUseCase.use-case.ts:70-77` |
| 3 | Validate the cell: `motion ∈ MOTION_KINDS`, `durationSec ∈ [MIN_DURATION_SEC, MAX_DURATION_SEC]`, `atSec ∈ [0, durationSec]` — all three present, or none. | `PreviewCreativeFrameUseCase.use-case.ts`; `apps/api/server/routes/campaigns/preview-frame.post.ts` |
| 4 | Fingerprint the new fields with the existing conditional spread (`:104-116`) so a cell without them hashes exactly as today; hash frame index `i`, `motion`, `durationSec` and the timeline, not raw `atSec`. | `PreviewCreativeFrameUseCase.use-case.ts` |
| 5 | Wire `new CanvasFfmpegVideoCompositor({ fontFamily: process.env.MESSAGE_FONT })` into the route beside the still compositor; the procedural generator wiring is untouched. | `apps/api/server/routes/campaigns/preview-frame.post.ts` |
| 6 | Web: add the fields to `usePreviewFrame`'s dependency list or nothing refetches; build the cell in `PreviewFrame.tsx`; a range control in `PreviewDock.tsx` whose position is **local state, never dispatched**, requesting on release with in-flight requests superseded; absent when the brief renders no motion; never autoplays. | `apps/web/src/lib/preview-frame.ts:84-94`; `PreviewFrame.tsx`; `PreviewDock.tsx` |

**Acceptance.**
- **Byte equality (VE-D6).** A capturing fake spawn records the encoder's stdin; slice frame `i` at
  offset `i × w × h × 4`; assert every alpha byte in the slice is `255` (Skia surfaces are
  premultiplied, so a PNG round-trip is lossless only when opaque); decode the `compositeFrame` PNG to
  RGBA and compare. Checked at `atSec = 0`, a mid value, and `atSec = durationSec` (frame
  `frames − 1`, not one past it).
- **Named mutation:** `i / (frames − 1)` → `i / frames` in the shared clock function must fail it.
- A cell without the new fields returns today's bytes, and the pinned cache-key test is unchanged.
- The "no generator other than the procedural one is reachable" test
  (`apps/api/server/routes/campaigns/__tests__/preview-frame.test.ts:126`) still passes.
- Scrubbing dispatches no `EditorAction`.

VE2 must not edit `editor-state.ts` or `BriefEditor.tsx`; those are VE1's.

---

## 4. Phase B — each lane waits on one open question

### VE3a — Music rights record · VE-D8 · after VE5a (both edit `load-brief.ts`)

| # | Task | File(s) |
|---|---|---|
| 1 | `readonly audio?: { path, rights }` on `CampaignBrief` (the rights shape may be its own value object); absent means no audio, as today. | `CampaignBrief.ts`, new `AudioRights` value object if used, `load-brief.ts` |
| 2 | Refuse at load: `audio` without `rights.licenceId` or `rights.source`; malformed `expiresOn`; `territories` present but not a non-empty alpha-2 array, or present while `targetRegion` is not itself alpha-2 (VE-D8). | `load-brief.ts` |
| 3 | Halt the run in the legal gate when `expiresOn` is before the run's clock, or `targetRegion` is not in `territories`. | `GenerateCampaignUseCase.use-case.ts` (`runLegalGate`) |
| 4 | Carry the rights record on the generated asset through the report to packaging, following `clickDestination`'s chain, and refuse packaging when `expiresOn` is before the use case's injected `packagedAt`. | `GeneratedAsset.ts`, `apps/api/server/lib/report.ts` (`PersistedAsset` + its guard), `PackageForPlatformUseCase.use-case.ts` (`PackageableAsset`) |
| 5 | A duplicated brief rewrites `audio.path` like `logoPath` / `inputAsset`. | `apps/api/server/lib/asset-files.ts` (`rewriteAssetPaths`, `extractSourceAssetBriefIds` only) |
| 6 | **Interim state:** until VE3b renders audio, a run whose brief declares `audio` is refused with a message saying audio is not rendered yet (the `enforceCapabilities` pattern), so no silent MP4 ships as if it carried music. VE3b removes the refusal. | `load-brief.ts` |

**Acceptance.** No ffmpeg change. A brief without `audio` loads, generates, duplicates and packages exactly as today (VE-D3); each refusal and halt has a test naming its field; an expired licence refuses packaging against `packagedAt`; a run with `audio` is refused with the interim message.

### VE3b — Music bed in the encoder · after VE3a

| # | Task | File(s) |
|---|---|---|
| 1 | Accept audio uploads (format list decided in the lane; the 2 MiB upload cap is the binding limit — say what it admits). Remove VE3a's interim run refusal. | `apps/api/server/lib/asset-files.ts` (upload patterns and magic checks), `routes/campaigns/assets.post.ts`, `load-brief.ts` |
| 2 | Second ffmpeg input; encode AAC; cut to `durationSec`; short fade-out; keep bit-exact flags. | `CanvasFfmpegVideoCompositor.ts`, `VideoCompositorPort.ts` |
| 3 | A second golden for the audio case; the silent golden must not move. | adapter golden tests |

**Acceptance.** A brief without audio produces the existing MP4 bytes (VE-D3); a brief with audio produces a stream with one AAC track exactly `durationSec` long, reproducible across two runs on the pinned binary.

### VE4 — Voiceover and captions · VE-D9 · waits on VE-Q5 (vendor) and VE3b

| # | Task | File(s) |
|---|---|---|
| 1 | Voiceover as a second audio source mixed under/over the music bed. | `CanvasFfmpegVideoCompositor.ts` |
| 2 | Caption cues timed to the **speech**, not to beat weights — timed from the generated speech's word timings (VE-D9). | new value object beside `CopyTimeline.vo.ts` |
| 3 | Write a WebVTT sidecar at **generation** (packaging never re-renders, D11) and package it beside the mp4. | `GenerateCampaignUseCase.use-case.ts`, `PackageForPlatformUseCase.use-case.ts` |
| 4 | Spoken and captioned text pass the same legal gate as copy. | compliance checker |

**Acceptance.** Captions exist only when speech does; every cue's text passed the legal gate; the
sidecar is packaged for motion platforms and absent otherwise.

### VE5a — Scenes in the timeline · VE-D10 · dispatchable first

| # | Task | File(s) |
|---|---|---|
| 1 | A beat may name its own background as `background?: string` — an asset path, the same kind of reference a product's `inputAsset` holds; absent means the creative's background, as today. | `CopyTimeline.vo.ts` |
| 2 | At most 3 distinct `background` values per timeline, refused by the timeline validator so the API and the editor agree. | `CopyTimeline.vo.ts`, `load-brief.ts`, `apps/web/src/components/campaign/validate.ts` |
| 3 | The editor must not strip the field: `TimelineBeatDraft` carries `background`, and every site that rebuilds beats as `{ text, weight }` preserves it (the D11 round-trip rule). No editor control is required in this lane. | `apps/web/src/components/campaign/editor-state.ts` |

**Acceptance.** No compositor change (the renderer reads `text` and `weight` only). A timeline naming no backgrounds parses and serialises byte-identically; a fourth distinct background is refused with the same message at both boundaries; a loaded brief with per-beat backgrounds survives an editor load → save round trip.

### VE5b1 — Scenes in the renderer, no generation wiring · after VE5a · shipped in this PR

| # | Task | File(s) |
|---|---|---|
| 1 | `VideoCompositeRequest` gains `backgrounds?: Readonly<Record<string, Uint8Array>>`, keyed by a beat's own `background` path; `ResolvedBeat` gains `background?: string`, copied from the beat. `prepare` decodes each distinct supplied ground once; `paintBackground` paints the scene of the beat active at `copyT ?? t`, `cut`/`fade` applying between scenes exactly as they apply between beats (`beatAt`'s own `mix`). Ken-burns applies to whichever ground is drawn. Absent, or a beat naming a background with no entry, falls back to the creative's own `background` (VE-D3) — stills never carry the field (no timeline to key it by). | `VideoCompositorPort.ts`, `CopyTimeline.vo.ts`, `NodeCanvasCompositor.ts` |
| 2 | The poster shows the key beat's scene (D7), through the same `copyT` selection as the copy layer — no poster-specific branch. | `NodeCanvasCompositor.ts` (poster reaches this via `CanvasFfmpegVideoCompositor.ts`'s existing `posterCopyTAt` call, unchanged) |
| 3 | `compositeRequestFingerprint` hashes `backgrounds` (content hash per key, sorted keys) only when present, so every existing pinned fingerprint is unchanged. | `PreviewCreativeFrameUseCase.use-case.ts` |

**Acceptance.** A timeline naming no backgrounds is byte-identical (VE-D3) — including with `backgrounds: {}` — and the motion goldens, mp4 byte golden and HL3 raster tests pass untouched; a two-scene timeline switches ground exactly at the resolved beat boundary; a fade timeline crossfades the two grounds at the same mix the copy crossfades at; the poster matches the key beat's scene; a request differing only in scene bytes never shares a fingerprint, absent stays at the pinned value.

### VE5b2 — Resolve scenes at generation and preview, duplicate, estimate · after VE5b1

| # | Task | File(s) |
|---|---|---|
| 1 | Resolve one background per distinct scene at generation and wire it onto the video request's `backgrounds`; the estimate counts generated scenes and states that a procedural scene spends nothing. | `GenerateCampaignUseCase.use-case.ts`, estimate |
| 2 | The preview builds the same `backgrounds` map the run would, so a scrubbed or previewed frame matches generation. | `PreviewCreativeFrameUseCase.use-case.ts` |
| 3 | Duplicating a creative rewrites its resolved scenes rather than reusing stale bytes. | duplicate path |

**Acceptance.** A brief with per-beat backgrounds generates, previews and duplicates with the scene the timeline names; a brief naming no backgrounds is unaffected (VE-D3); the estimate names generated-scene cost and states a procedural scene is free.

---

## 5. Phase C — reverses a recorded decision

### VE6 — Import footage, with trim · deferred (VE-D11)

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
Phase A (shipped)              Phase B                                                              Phase C
  VE1 undo/redo                  VE5a scenes in timeline ── VE5b1 scenes in renderer ── VE5b2 generation   VE6 footage — deferred (VE-D11)
  VE2 scrub preview              VE3a music rights ── VE3b music in encoder ── VE4 voiceover+captions (VE-Q5)
                                 (VE5a before VE3a: both edit load-brief.ts)
Keyframes: see 2026-09-10_keyframing.md (K1 blocked on its own questions)
```

VE1 and VE2 run in parallel **only** because VE2 keeps the scrub position out of `EditorState` and edits neither
`editor-state.ts` nor `BriefEditor.tsx`. VE2 and VE3b both edit `CanvasFfmpegVideoCompositor.ts` and must not run
concurrently with each other; VE5b1 shipped with no edit to that file (the widened `VideoCompositeRequest`/`prepare`
request types were enough), but VE5b2's generation wiring may still touch it and should not run beside VE2/VE3b either.
VE3a and VE5a touch no renderer file and may run beside those, but **not beside each other** — both edit `load-brief.ts`
(imports, the `parseBrief` chain) and its tests.

---

## 7. Cross-cutting concerns

- **Credits.** Previews and scrubbing stay on the procedural generator (D52). Scenes multiply real
  generation calls per creative; that is VE-D10's budget, not an implementation detail.
- **Determinism.** Every lane proves byte identity for briefs that do not use it (VE-D3). Goldens are
  never re-recorded to make a lane green.
- **Compliance.** Audio rights (VE3a) and spoken or captioned text (VE4) enter the same gate copy
  already passes; nothing reaches an ad around it.
- **Byte and duration budgets.** Audio adds bytes against `maxBytes` (100 MiB motion) and every track
  is cut to the brief's duration — the domain's `MAX_DURATION_SEC` (`variation-defaults.ts`, 30 s; the
  compositor exports a separate 60 s ceiling of the same name) — which already binds tighter than any platform's cap.
- **CI.** Anything a test spawns must be POSIX `sh`; CI runners have no zsh.

---

## 8. Open questions

| ID | Question | Blocks |
|---|---|---|
| **VE-Q1** | ~~What rights record must a music asset carry?~~ **Answered — VE-D8.** | — |
| **VE-Q2** | ~~Voiceover source?~~ **Answered — VE-D9 (generated speech).** | — |
| **VE-Q3** | ~~Scene budget?~~ **Answered — VE-D10 (3).** | — |
| **VE-Q4** | ~~Accept user footage?~~ **Answered — VE-D11 (no; VE6 deferred).** | — |
| **VE-Q5** | Which speech vendor and model does VE4 call, under whose key, and at what per-creative cost? | VE4 |

---

## 9. Risks & notes

- **Audio determinism is unproven here.** The native AAC encoder with bit-exact flags is expected to be
  reproducible, but VE3b must demonstrate it with a golden before relying on it.
- **Scrub request volume.** Dragging can issue many requests; superseding in-flight requests and the
  existing frame cache keep it bounded, and VE2's acceptance includes the cache fingerprint.
- **Undo and server state.** `EditorState` carries server answers — the saved revision, the copy pool, the
  applied snapshot, capabilities. Undo that reverted them would make the next conditional save conflict; VE1
  carries them forward (R5).

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

**VE1 — shipped in this PR.**

**VE2 — shipped in this PR.**

**VE3a — shipped in this PR.** (`CampaignBrief.audio`, `AudioRights.vo.ts`, checked at load and in the legal gate, carried to packaging's `packagedAt` re-check; a run declaring `audio` is refused with an interim message until VE3b.)

```premise VE3b
# Either gap keeps the lane open (||): no audio codec argument in the encoder, or no audio extension accepted for upload.
! grep -qE -- '"-c:a"|"-acodec"' packages/CreativeGeneration/src/infrastructure/adapters/CanvasFfmpegVideoCompositor.ts || ! grep -qE '\b(mp3|m4a|wav|aac)\b' apps/api/server/lib/asset-files.ts
```

```premise VE4
# No caption sidecar is written or packaged anywhere.
! grep -rqiE 'webvtt|\.vtt\b' packages/CampaignOrchestration/src packages/Distribution/src apps/api/server
```

**VE5a — shipped in this PR.** (`CopyBeat.background`, capped by `MAX_SCENES` in `timelineProblem`.)

**VE5b1 — shipped in this PR.** (`VideoCompositeRequest.backgrounds`, `ResolvedBeat.background`, `paintBackground`'s
copyT-driven scene selection and crossfade in `NodeCanvasCompositor.ts`, `compositeRequestFingerprint`'s per-key scene
hash. No generation wiring — that is VE5b2.)

```premise VE5b2
# GenerateCampaignUseCase sets no `backgrounds` field on any compositor request yet.
! grep -qE '\bbackgrounds\s*:' packages/CampaignOrchestration/src/application/use-cases/GenerateCampaignUseCase.use-case.ts
```

**VE6 — deferred (VE-D11); its premise is retired until the owner schedules it.**
