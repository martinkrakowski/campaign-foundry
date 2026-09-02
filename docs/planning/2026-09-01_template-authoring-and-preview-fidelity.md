# Template Authoring & Preview Fidelity — Architecture & Development Plan

**Date:** 2026-09-01
**Status:** for review
**Decision ids introduced:** D51 – D58 (D43–D50 are claimed by `2026-09-01_r7-preview-panel.md`)
**Relates to:** D26 (the preview shows only what the compositor draws), D10 (`drawLegacy` freeze)

---

## 0. What this plan answers

Two requests arrived together and are usually treated as one:

1. **"Re-think the preview."** It shows a gradient, a logo and copy, with no header, no footer and
   no controls. It should let the user finalise font, size, position, copy and an animated text
   effect — the way Google Labs *Flow* ("Type Overlays") does — for the static **and** the animated
   creative. **And it must reflect the layout exactly, at the real ratio (1:1, 9:16, …).**
2. **A new campaign feature.** Ingest N copy variants (say 6). Either hold **one layout** across all
   N and swap only the copy and the elements the user marks, or let each of the N take its own
   layout. Output: N social-ready creatives — video included — that share a campaign style but carry
   unique copy.

This plan's central claim is that **(2) is mostly already in the domain**, and that (1) splits into
two features with very different costs, only one of which (2) needs.

> **Provenance.** Derived from the code on `main` at `e4fda57` by six parallel investigators, each
> then challenged by a second reader instructed to refute it. Several first-pass conclusions were
> corrected by that challenge and are recorded as such in §7 — including two of the author's own.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D51** | **Two features, named separately and priced separately.** *Template authoring* is **pre-generation**: it edits the layout every variant inherits. *Per-creative finishing* is **post-generation**: it edits one rendered asset. This plan builds the first and explicitly defers the second. | The Flow reference edits one asset and re-renders it. Every real run here produces **6 or 12** creatives. Only per-creative finishing needs a per-creative record, a re-render verb and a policy-hash story; template authoring needs none of them. Conflating them prices a tractable feature as an intractable one. |
| **D52** | **The preview renders a real frame from the real compositor**, at the requested ratio, and is never a hand-maintained lookalike. It is fed by **`ProceduralBackgroundGenerator`** — offline, deterministic, and already the default background source — so the preview costs no credits and makes no network call. **When the brief's background source is `genai` or `asset-pool`, the preview must say the background is a stand-in**, or it implies an image it will not deliver, which is the exact D26 failure this plan exists to avoid. | The requirement is that the preview reflect the layout *exactly*. The browser SVG and the compositor are **two unrelated layout engines**: headline type size disagrees by **0.85×–2.15×**, and the sign flips with ratio because the compositor scales off canvas **width** and the preview off **height**. No amount of patching a twin makes "exactly" true. |
| **D53** | **D26 is an ordering rule and this plan obeys it: the compositor honours a setting before any UI offers it.** No control ships that the delivered creative ignores. | No decision in this repo ever rejected controls on the preview — but D26 forbids the UI-first build outright. Today the compositor's whole request vocabulary is eight fields and honours **none** of the ten requested controls. |
| **D54** | **Every new control is additive with today's value as its default**, and no default changes in the same lane. | Verified: the golden images are **byte-identical** under a defaults-preserving change. Golden churn is therefore not a cost of this proposal — unless someone alters a default "while we're in there", which would force re-recording both platform maps. |
| **D55** | **Type is stored as a ratio-relative scale, not an absolute pixel value.** The editor may *display* px for the ratio being previewed. | The compositor is fraction-of-canvas throughout (`fitText` at `width * 0.06`, logo `width * 0.16`, margins `width * 0.04`). An absolute size tuned on the square is ~44 % wrong on a story. This is the same call the domain already made twice: `CopyTimeline` stores *beats, not seconds*, and `Treatment.layout` is a relative anchor, not coordinates. |
| **D56** | **Richer creative vocabulary is the deliverable, not more sliders.** Grow layouts, tones, font choices and text-effect kinds in the compositor; the editor exposes that vocabulary. | "One layout across six creatives" is only worth having if there are layouts worth choosing. Today there are **two** (`headline-top`, `headline-bottom`) and **two** tones. A Flow-grade control panel over a two-value enum is a beautiful switch. |
| **D57** | **Position arrives as a NEW optional axis, never by widening `LAYOUT_VALUES`.** | `VariationPolicy` puts `layout` **unconditionally** into the hashed payload, while `motion`/`duration`/`headline` are conditionally spread. Widening the enum changes `policyHash` for every existing variation brief, and the re-roll path pins the persisted hash — so it would silently re-plan and un-pin live campaigns. |
| **D58** | **A control that the wizard cannot round-trip does not ship.** Every new field lands in the server validator **and** the editor's state model in the same lane. | The wizard reconstructs the brief from a whitelisted state model, so any field it does not know is **deleted on the next save**. Hand-authored YAML plus one UI save equals silent data loss. |

| **D59** | **The font control is a server-validated allowlist of bundled families — and `MESSAGE_FONT` is validated the same way, in the same lane.** | The renderer can see **312 system font families**; `has("Helvetica")` and `has("Georgia")` are both true and they render differently from Inter, with distinct hashes and an unknown family falling back to a fourth. `pipeline.ts` passes `process.env.MESSAGE_FONT` into the constructor **unvalidated**, so the determinism hole is already open at deployment scope. A per-brief control widens it to per-creative; validating one and not the other leaves the identical bug reachable. |
| **D60** | **Weight exposes only the weights that have faces**, or the asset decision is made explicitly first. | Only Inter/Lora **Regular (400) and Bold (700)** are registered. Measured: 13 CSS weight tokens collapse to **3 distinct rasters** — 100–500 render Regular, 600–800 render Bold, and 900 is synthetic emboldening (same metrics as bold, 11 454 lit pixels vs 9 164). A 100–900 slider is decorative over four faces. Today's `subtle` tone already asks for `"500"` and silently renders Regular. |

---

## 1. Verified findings

### The proposal is cheaper than it looks — three corrections in the user's favour

| id | Finding |
|---|---|
| **F1** | **The engine is `@napi-rs/canvas` (Skia) 0.1.100, not node-canvas.** Verified at runtime that `letterSpacing` and `wordSpacing` work in **both** `measureText` and the raster. The control usually assumed impossible is trivial here. *(This corrects the author's own stated premise.)* |
| **F2** | **One draw path serves static and video.** `writeFrames` calls `NodeCanvasCompositor.draw()` **once per frame**, and ffmpeg only encodes (rawvideo → libx264; no filters, no `drawtext`). Every static control lands in the video for free, and text animation is architecturally reachable today. |
| **F3** | **The golden images survive.** Checked byte-identical with neutral setters. Under **D54** the goldens are not a cost. |
| **F4** | **Per-frame text measurement is already in production.** `drawLegacy` calls `layoutHeadline → fitText → layoutAt → wrapText` on **every frame** — full autofit, ~180× per clip, today. Per-frame text work is not a new cost class. |
| **F5** | **The `drawLegacy` freeze is narrower than it reads — but only for some controls.** `layoutAt` already reads `fontWeight`/`fontFamily` off `PreparedCreative` to build `ctx.font`, so **family, weight, size and line height** can be honoured with the frozen body untouched. **Colour, alignment, baseline and media opacity are literals *inside* that body** and do require the edit. Changing what the frozen path renders is a **D10 amendment in substance** either way. |
| **F5a** | **The ctx-state route does not generalise to the timeline path — this is the concrete trap.** `resolveBeatLayouts` measures on a throwaway **1×1 context**, and `drawBeat` re-sets `ctx.font`. Any context-state control (`letterSpacing`, `wordSpacing`) must be set **again** there, or the video blit silently drops it while the static still honours it. |

### The new campaign feature is largely built

| id | Finding |
|---|---|
| **F6** | **`layout` and `tone` are already `DISTANCE_AXES` the planner honours.** Pin an axis to one value → locked across all N. Leave it open → varies, with `minDistance` guaranteeing variants differ. **"Same layout for all 6" is one missing editor control, not a feature.** Neither `axes.layout` nor `axes.tone` appears anywhere in `apps/web`. |
| **F7** | **The copy pool exists end to end.** `HEADLINE_POOL_REF = "pool://copy"`, an approved/rejected `CopyPool`, `HeadlinePoolDrawer` in the editor, and the use case gates every pooled text through compliance before rendering. "Ingest 6 copy variants" is built. |
| **F8** | **`variation.count` is authorable today** (defaults to `12`, validated ≥ 1, shown on Review). There is even a planner test named *"count 6 perRatio 2"*. "Exactly 6" is expressible now. |
| **F9** | **Video is off by default** — `output.formats` defaults to `["static"]`. `ffmpeg-static` is bundled and present. A video campaign is a brief-level opt-in that already works. |

### The fidelity gap — why D52 exists

| id | Finding |
|---|---|
| **C1** | **The preview and the compositor are two unrelated layout engines.** Across 3 ratios × 2 layouts, headline type size disagrees by **0.85×–2.15×**, and the sign flips with ratio (compositor scales off **width**, preview off **height**). |
| **C2** | **Alignment: the compositor only ever centres** (`ctx.textAlign = "center"`); the preview **left-aligns**. The preview's default is a state the renderer cannot produce. |
| **C3** | **Colour: the render is unconditionally `#ffffff`**; the preview uses a theme token that is near-black in light mode. |
| **C4** | **The preview draws neither the generated image nor the logo.** "Media opacity" has nothing to act on — and the logo's overlap-snap means the compositor **relocates a layer in response to where the headline lands**, one the preview never draws. |
| **C5** | **The accent band is 5.07× too tall in the preview**, and starts at the wrong opacity — and that band is exactly what `accent-wipe` animates, so the animated preview's most prominent event is five times its real size. |

### The costs that are real

| id | Finding |
|---|---|
| **H1** | **The compositor honours none of the ten requested controls.** `CompositorPort`'s request carries eight fields. Every control is a port change + both draw paths + tests, not a UI feature. |
| **H2** | **Font choice is deployment config, not content — and it is unvalidated.** `process.env.MESSAGE_FONT` is read once at pipeline construction and passed straight through; `fonts.ts` registers exactly **Inter Regular/Bold and Lora Regular/Bold**, while the renderer can see **312 system families**. "Choose a font" means a per-request field, an allowlist, and an asset-pipeline decision about what is bundled (**D59**, **D60**). |
| **H3** | **Text effects are not the existing motion vocabulary.** `MOTION_KINDS` are camera/ground effects; only one of four touches the copy. A text-effect control is a **new axis** or a mixed vocabulary — and motion is a plan-time axis inside the policy hash, not a per-creative setting. |
| **H4** | **A static creative cannot carry an animation** — it is a sample of the motion curve, so every new effect needs a **designed rest pose**, and the editor must say what the still will look like. |
| **H5** | **Colour and opacity controls reach into a pixel-measured compliance gate.** `validateBrandColorDensity` decodes the delivered PNG and fails below a 0.02 density of pixels within ±10 per channel of the brand hex. There is no contrast check at all. |
| **M1** | **Per-creative finishing has no home — but there is a precedent.** `CampaignExecutionOptions` carries only `regenerateOnly` (identity, nothing else), and no layer has a "re-render this one, changed" verb. The home-shaped precedent is the **per-brief sidecar** (`pools.json`, resolved under the brief id and invisible to the lister). Deferred by **D51**. |
| **M2** | **Batch-wide pinning can make a randomized brief unplannable.** Pinning a layout or tone from an editor deletes a variation axis, and both of the user's own briefs are variation-mode. |
| **M3** | **The goldens pin one point in a nine-dimensional space** — 12 cells per platform, for `darwin-arm64` and `linux-x64`. The cost of this proposal is not re-recording them (**D54** avoids that); it is **redesigning the pinning strategy**: goldens for defaults only, plus structural/property tests per control. The goldens file itself already points at this. |
| **L1** | **The inset golden silently skips on CI** — its fixture holds only `darwin-arm64`, so on linux it renames to a passing test rather than failing. Any newly pinned cell needs both platform maps or it is decorative. |
| **L2** | **D-ids collide across planning documents.** "D27" is the loop-budget rule in one doc and something else in another; the four motion kinds live at `MotionKind.vo.ts:5`. Cite the file, not the id. |

---

## 2. The recommendation

**Build template authoring. Defer per-creative finishing. Make the preview real before it gains a
single control.**

The user's campaign feature is a *template* feature: one layout, N copy variants, N videos. That is
pre-generation and needs no per-creative record. The expensive half of the Flow metaphor —
editing one rendered asset and re-rendering just that one — buys nothing this feature needs.

**Sequence, and the reason for it:** the preview must become truthful **first**, because every
control added to an untruthful preview is a control panel wired to the wrong engine. Then the
compositor gains vocabulary. Only then does the UI expose it. That order is D26's, not a preference.

---

## 3. Lanes

One lane per PR. Ownership is exclusive.

| Lane | Task | Buys |
|---|---|---|
| **T1** | **Server-rendered preview frame** (**D52**). An API route renders one cell through the real compositor at a requested ratio and returns it; the editor shows that image. **`prepare` requires a real background buffer** (`loadImage(Buffer.from(request.background))`), so the route supplies one from `ProceduralBackgroundGenerator` — no credits, no network, deterministic. Cache by brief-hash + ratio + treatment, and **debounce the editor's requests** so a dragged slider does not flood the route. | "Reflect the layout exactly" becomes true, permanently. Retires C1–C5 as a class rather than one at a time. |
| **T2** | **Expose the axes that already work** (**F6**): `axes.layout` and `axes.tone` in the editor, as lock-or-vary controls, next to the existing count and copy pool. | **The user's campaign feature, minus new vocabulary.** Cheapest real value in the plan. |
| **T3** | **Preview chrome**: header and footer bar on the preview surface — what is being previewed, which ratio, which variant, and the way out. | Answers "it needs a proper menu header and footer bar" without pretending to be an editor yet. |
| **T4** | **Vocabulary: layouts and tones** (**D56**). Grow `LAYOUT_VALUES` beyond two — as a new optional axis where position is concerned (**D57**) — with goldens for defaults only and structural tests per control. | Makes T2 worth using. |
| **T5** | **Vocabulary: type** (**D55**, **D58**). Font family from the bundled set (**H2**), weight, size *scale*, line height, letter spacing (**F1**), alignment (**C2**). Compositor first, then editor, round-tripped through the wizard's state model. | The typography half of the request, honestly. |
| **T6** | **Text effects** (**H3**, **H4**). A new effect vocabulary with a designed rest pose per kind, drawn per frame (**F2**, **F4**). | The animated half. Largest lane; do it last, when the surface is trustworthy. |

**Order.** T1 → T2 ‖ T3 → T4 → T5 → T6. T1 gates everything after it (**D53**).

---

## 4. Definition of Done

- Full gate — `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn test:cov`,
  **0 lint problems, 100 % on all four counters** — then `yarn sync:check` clean on the committed tree.
- **No control exists in the UI that the compositor ignores** (**D53**). For each control, a test
  renders through the real compositor and asserts the setting changed the output.
- **Goldens unchanged** (**D54**). If a golden moves, a default changed and the lane is wrong.
- **Every new field round-trips the wizard** (**D58**): author in UI → save → reload → unchanged;
  and author in YAML → open in UI → save → unchanged.
- **`policyHash` is unchanged for every existing brief** (**D57**), asserted against the tracked samples.
- A new pinned golden carries **both** platform maps, or it is not added (**L1**).
- Brand-density compliance still passes for the default palette after any colour work (**H5**).
- **The preview route renders without credits or network** — asserted by a test that fails if any
  generator other than the procedural one is reachable from it.
- **A non-procedural brief's preview is labelled a stand-in** (**D52**), asserted in the UI tests.
- **Any context-state control is asserted on a *video* frame, not only a still** (**F5a**) — the
  timeline path re-sets `ctx.font` and would otherwise drop it silently.
- **The font allowlist is enforced server-side and `MESSAGE_FONT` is validated by the same code**
  (**D59**); a request naming an unregistered family is refused, not silently fallen back.

---

## 5. Open questions

1. **Which ratios does a template target?** Classic mode always renders all three
   (`AspectRatio.all()`, no ratio selection). For a social video campaign the user may want one.
   Should template authoring pin the ratio axis, and if so is that a brief field or a UI default?
2. **What is the bundled font set?** Two families today. Adding fonts is an asset-pipeline and
   licensing decision before it is an engineering one.
3. **Per-element locking.** "Swap only the copy and the elements the user marks" is finer than the
   axis model, which locks whole dimensions. Is axis-level locking enough for the first release?
4. **Does the estimate stay honest?** The deliverables readout is derived from products × ratios ×
   treatments; a template feature that pins axes changes that arithmetic.

---

## 6. Explicitly deferred

**Per-creative finishing** (**D51**/**M1**) — editing one rendered creative and re-rendering just
that one. It needs a per-creative store, a new API verb, a seed-preserving re-render that reuses the
recorded background, and a policy-hash story. The sidecar precedent shows the shape when it is
wanted. Nothing in the described campaign feature requires it.

---

## 7. Corrections this plan records

| Claim | Correction |
|---|---|
| "node-canvas can't do letter-spacing" | Wrong engine. `@napi-rs/canvas` (Skia); it works. **The author's own premise.** |
| "the golden images will churn" | They are byte-identical under a defaults-preserving change. |
| "per-frame text effects reintroduce a measurement cost" | `drawLegacy` already autofits on every frame in production. |
| "every static control must edit the frozen `drawLegacy` body" | The layout helpers it delegates to are outside the freeze. |
| "no per-creative input record exists anywhere" | Overstated — the per-brief sidecar is a working precedent. |
| "D27 governs the four motion kinds" | D-ids collide across documents; cite `MotionKind.vo.ts:5`. |

---

## 8. Review record

*To be completed — two independent reviews, by models different from each other and from the author.*
