# Review — the two 2026-09-08 composition plans

**Date:** 2026-09-10 · **Reviewer:** plan-review seat · **Verified against:** `main` at `7471bf5`.
**Subjects:** `2026-09-08_extensible-composition-plan.md`, `2026-09-08_motion-composition-implementation-plan.md`.

**Verdict up front: retire the first, rewrite the second if it is wanted at all.** Neither can be
implemented as written. The reasons are specific and are recorded below so this does not have to be
rediscovered.

---

## 1. The finding that outranks both plans

**The brief's template never reaches the compositor.** `CompositeRequest` carries no `template` and
no `creativeType`; neither `GenerateCampaignUseCase` nor `PreviewCreativeFrameUseCase` passes one;
`NodeCanvasCompositor.prepare` accepts the field but its own comment says it "stays off the port
interface until L3 wires it through" — and L3 shipped without touching the port. Every production
render therefore draws `CANONICAL_TEMPLATES["image-text"]`.

**So the entire templates arc is inert at render time**, and both plans under review assume a
pipeline that does not exist. Recorded in full, with its sequencing, in
`2026-09-10_the-motion-path-and-l9.md` as **F0** and lane **M1b**.

---

## 2. Extensible composition — **retire**

Most of it shipped under other names while the plan sat untracked.

| Plan piece | Status | Shipped as |
|---|---|---|
| `LayoutDescriptor` | shipped, renamed | `BriefTemplate` |
| `LayoutElement` | shipped, renamed | `CreativeTemplateLayer { id, kind, props? }` |
| `layers` as draw order | shipped | **D128**, iterated by `drawLegacy` |
| Schema validation at the boundary | shipped | `isBriefTemplate` + `validateTemplate` |
| Kind-keyed paint dispatch | shipped | `LAYER_DRAWERS` |
| Per-layer props | **carrier only** | D134 vocabulary exists; the compositor never reads it |
| `zIndex` per layer | **not built, and forbidden** | D128: *"there is no separate `order` field"* |
| `type: image/text/shape/gradient` | **collides** | `LAYER_KINDS` — a different, shipped vocabulary |
| `position` / `scale` / `anchor` | not built | reserved for **L10** (D130 `frame`) |
| `gradient` / `shape` overlays | not built | reserved for **L11** (D131/D132) |
| `$headline` / `$logo` bindings, `blendMode` | not built | no equivalent; unowned |
| Visual builder, `DraftCampaignService` | not built | `DraftCampaignService` does not exist |

**Implementing it as written would create a second template record, a second per-layer order field,
and a second kind vocabulary beside the shipped ones** — with `resolveLayerList` forced to choose.
That is the drift **D121** exists to prevent, and `zIndex` is the exact shape D128 rejects as *"the
three-lists problem brought back inside one record."*

**What survives:** the Phase 2 visual-builder idea, which belongs as a note on L10 rather than as a
plan of its own.

---

## 3. Motion composition — **rewrite, or drop**

Its Phase 1 is a re-housing of machinery that exists.

| Plan piece | Exists as |
|---|---|
| `MotionRendererPort` | `VideoCompositorPort.compositeVideo` |
| `FfmpegCanvasAdapter` render loop | `CanvasFfmpegVideoCompositor.writeFrames` — the same loop |
| 30 fps, H.264, `ffmpeg-static` | `MOTION_FPS`, `libx264`/`yuv420p`, already static-imported |
| `Timeline.getFrameStateAt(t)` | `beatAt` + `restT` + `kenBurnsScale` + `textEffectPose` |
| `Clip` / beats | `CopyTimeline { beats, transition, keyBeat }` |
| Copy-beat syncing, MP4 in the review grid | shipped |
| `Keyframe`, `EasingCurve`, multi-track editor | **not built** — the genuinely new part |

**Two structural objections to the package as proposed.**

A new `packages/MotionComposition` owning its own domain, use cases **and ports** would be the first
context to own its ports, in a codebase where `CreativeGeneration` is adapters-only — every
`domain/` and `application/` directory under it holds a `.gitkeep` — and ports live in
`CampaignOrchestration/src/application/ports/out/`. It would also need a manifest entry and a new
inter-context dependency to pass `hexagen arch validate`.

And keyframes on arbitrary properties would be a **fourth** motion vocabulary beside `MOTION_KINDS`,
`TextEffectKind` and `CopyTimeline` beats, with no account of how the four compose.

**If keyframes are wanted, they are an amendment to `MotionKind` / `CopyTimeline` inside the existing
split — not a new bounded context.** And nothing here can start until the motion path is list-driven
(**M1**): keyframed per-layer motion is meaningless while three of five layers are drawn by name.

---

## 4. Corrections to the plans' factual claims

- `DraftCampaignService` does not exist; the draft path is `editor-state.ts` + `briefs-api.ts`.
- The proposed default easing (cubic-bezier ease-in-out) is not the codebase's — that is
  `easeOutCubic`, and it is the one source both draw paths read.
- `pool://audio` is greenfield, not an extension: `VideoCompositeResult` has no audio surface and the
  ffmpeg args map no audio stream.
- Both plans say "re-write the rendering loop" in the singular. **There are two**, and neither plan
  names either. Only `2026-09-10_the-motion-path-and-l9.md` addresses that.

## 5. Two things this review changes elsewhere

- **There is no video byte golden at all.** D10's "frozen motion bytes" is not backed by one, so M1's
  byte-identity proof must run per frame through `NodeCanvasCompositor.draw`.
- **`PREVIEW_LAYER_ORDER` derives from `CANONICAL_TEMPLATES`, not from the brief.** Preview and
  compositor agree today only because *both* ignore the template. The M1b wiring lane must either
  carry the kit preview with it or state explicitly that the miniature stays canonical — otherwise
  **D26** breaks the moment a reorder ships end to end.
