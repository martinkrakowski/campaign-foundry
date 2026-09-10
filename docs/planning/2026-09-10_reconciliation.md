# The Reconciliation — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `7471bf5`. Every claim below cites code that was read, not recalled.
**Supersedes nothing on its own** — it says which plans survive, and in what order they run.

---

## 0. The one finding this document exists for

**D121 says there is one source of the layer stack. There are four, and no two agree.**

| Renderer | Where it gets the order | Reads the brief's template? |
|---|---|---|
| `NodeCanvasCompositor` **still** path (`drawLegacy`) | iterates `prepared.layers` | **structurally yes, actually no** — nothing passes one |
| `NodeCanvasCompositor` **motion** path (`drawTimeline`) | `drawLayer("image"/"shade"/"accent")` **by name** | **no, by construction** |
| `packages/ui/preview-layers.ts` | `PREVIEW_LAYER_ORDER`, derived from `CANONICAL_TEMPLATES` | **no** |
| `apps/web/CreativePreview.tsx` | its own layer references | **no** |

**They agree today only because all four ignore the brief.** `CompositeRequest` carries no
`template`, so `resolveLayerList` always falls through to `CANONICAL_TEMPLATES["image-text"]`. The
reorder control, the ordering constraints and the occlusion guard are validated, stored, and then
discarded at render.

**This is the reconciliation.** Everything else in this document is ordered around it, because fixing
any one of the four alone makes the disagreement *visible* rather than fixing it — and a visible
disagreement between the preview and the delivered asset is worse than a hidden one.

---

## 1. Two further duplications, lower stakes, same shape

#### **Geometry is described twice**

`CREATIVE_GEOMETRY` is read **directly** by the drawers — `accentSolidHeightFraction`,
`logoWidthFraction`, `logoMarginFraction`. D134's per-layer `props` describe the *same* quantities,
are validated at both boundaries by `layerPropsProblem`, and are **never read by the compositor**:
the word `props` appears in `NodeCanvasCompositor.ts` exactly once, in a comment.

So a user can set `shade.props.alpha` today, have it validated, stored, round-tripped through YAML —
and rendered identically to not setting it. **D134 called this "inert on arrival" deliberately, but
no lane owns making it live**, and until one does, the vocabulary is a promise the product does not
keep.

#### **Motion is described three times**

`MOTION_KINDS`, `TextEffectKind` / `TEXT_EFFECT_VALUES`, and `CopyTimeline`'s beat model each
describe how something moves, at different granularities, with no stated composition rule. The
retired motion plan proposed keyframes as a **fourth**.

---

## 2. Proposed decisions

| id | Decision | Why |
|---|---|---|
| **R-D1** | **One stack, read from the brief, honoured by every renderer.** The order comes from `BriefTemplate.layers` and nothing else derives its own. | D121, finally enforced rather than asserted. |
| **R-D2** | **Convergence order is fixed and counter-intuitive: make the renderers agree *before* wiring the brief through.** Motion path first, then previews, then the port. | While the template is unwired every renderer draws the canonical list, so each conversion is provably byte-neutral. Wiring first makes the still honour a user's order the video ignores — a regression shipped to delivered assets. |
| **R-D3** | **`CREATIVE_GEOMETRY` is the default; `props` is the override; the drawer reads one merged value.** No drawer reads the constant directly once the merge exists. | Two descriptions of one quantity is the same defect as two descriptions of one order. |
| **R-D4** | **No fourth motion vocabulary.** Keyframes, if wanted, extend `MotionKind`/`CopyTimeline` inside the existing ports-and-adapters split. | A new bounded context owning its own ports would be the first in this codebase; `CreativeGeneration` is adapters-only. |
| **R-D5** | **A plan is retired by an explicit line in this document, not by silence.** | Three plans sat untracked for two days and one was substantially superseded without anyone noticing. |
| **R-D6** | **Every convergence lane proves byte-neutrality per frame**, through `NodeCanvasCompositor.draw`. | **There is no video byte golden.** D10's "frozen motion bytes" is not backed by a test, so the freeze has to be demonstrated rather than assumed. |

---

## 3. The plan inventory, reconciled

| Plan | Verdict |
|---|---|
| `2026-09-08_creative-templates-and-units` | **Live, amended.** Its L1–L8 shipped. Add the wiring gap it never assigned a lane to, correct L7's status, fix L9's ownership list and its DoD wording. |
| `2026-09-10_the-motion-path-and-l9` (#307) | **Live.** Absorbs the convergence sequence below; M1 and M1b are lanes C1 and C3 here. |
| `2026-09-08_extensible-composition-plan` (#309) | **Retired.** Shipped under other names; its remainder is forbidden (`zIndex` vs D128), colliding (a second kind vocabulary), or already owned by L10/L11. Keep the visual-builder idea as a note on L10. |
| `2026-09-08_motion-composition-implementation-plan` (#309) | **Retired as written.** Phase 1 is a re-housing of shipped machinery. If keyframes are wanted, they are a new, smaller plan under R-D4 — and cannot start before C1. |
| `2026-09-08_collaboration-and-curation-plan` (#309) | **Retired.** Reviewed 2026-09-10. Two thirds of it **shipped before it was drafted** — revision hashes with conditional writes (2026-08-28) and the copy-pool drawer with its routes (2026-08-30). The remainder is the **D64(b)** deferral list built on the D64(a) storage port — which cannot both be true — plus **D82**. Gated by an owner decision, not by a lane. **Inline legal lint survives as lane R1.** |
| `2026-09-10_seat-selection` (#305) | **Live**, independent of this arc. |
| `2026-09-09_verification-budget` | **Live**, V3 still open. |

---

## 4. Lanes

**Convergence — strictly ordered. Each lane is byte-neutral by construction.**

| Lane | Task | Proof |
|---|---|---|
| **C1** | **The motion path iterates the list.** `drawTimeline` stops calling the ground trio by name. The order it produces is unchanged, because the list is still canonical. | Per-frame byte-identity through `draw`. `layer-order.test.ts` pins the by-kind order deliberately and is **expected to go red and be rewritten** — that is not a golden moving. |
| **C2** | **The previews read one order.** `PREVIEW_LAYER_ORDER` and `CreativePreview.tsx` stop deriving their own and take the same list the compositor takes. Still canonical, so nothing moves. | Preview output unchanged for canonical templates. |
| **C3** | **Wire `template` onto the port.** `CompositeRequest` gains it; both use cases pass it; the test doubles follow. **Only now does a user's order reach anything.** | A reordered template renders in that order on **both** paths **and** in both previews. |
| **C4** | **`props` becomes live** under R-D3: one merge of `CREATIVE_GEOMETRY` and per-layer props, read by every drawer. | All-absent props render byte-identical to today. |

**Then the templates arc resumes**, unchanged from #307: **M2** (`enabled` at the boundary) → **M3**
(the toggle). L9 is meaningful only after C1 and C3.

**Then, and only then, the open questions:** L10 (frames), L11 (fill and region), the template
library (L7, which never shipped past a port with no consumer), and keyframes if wanted.

**M4** — amend the templates plan per §3 — runs whenever.

---

## 4b. Canonical lane names, and the master sequence

**A naming collision in my own plans, recorded rather than quietly renamed.** The reconciliation and
`2026-09-10_the-motion-path-and-l9.md` name the same two lanes twice: **C1 = M1** (the motion path
iterates the list) and **C3 = M1b** (wire `template` onto the port). Two documents naming one lane is
the same defect as four renderers naming one stack.

**The `C` names win**, because the convergence sequence is the thing that orders everything else.
`M1`/`M1b` are retired as aliases; `M2`, `M3`, `M4` keep their names and their home.

### The master sequence

**Phase 0 — unblock (nothing else may start inside this phase).**

| | Lane | Home |
|---|---|---|
| 1 | **C1** — the motion path iterates the list | this doc / the L9 doc |
| 2 | **C2** — the previews read one order | this doc |
| 3 | **C3** — wire `template` onto the port | this doc / the L9 doc |

**C3 is the moment the product starts honouring a user's template.** Everything before it is
byte-neutral by construction; nothing before it is user-visible.

**Phase 1 — finish the templates arc.**

| | Lane | Home |
|---|---|---|
| 4 | **C4** — `props` becomes live (geometry has one source) | this doc |
| 5 | **M2** — `enabled` reaches the boundary | the L9 doc |
| 6 | **M3** — the toggle (L9/D129) | the L9 doc |

**Phase 2 — the arc's own remainder**, in the templates plan's declared order: **L10** (frames,
D130), **L11** (fill and region, D131/D132), then **L7** (the template library, which never shipped
past a port with no consumer, and whose thumbnails need drawers L10/L11 build).

**Phase 3 — keyframing**, `2026-09-10_keyframing.md`: **K1 → K2 → K3 → K4**, with **K2 as its gate**.
Blocked on C1 and best done after Phase 2, since tracks address layers by id and a layer set still in
flux moves under them.

**Unblocked, parallel, any time.** These touch nothing in the render stack:

- **M4** — amend the templates plan (L7's status, L9's ownership and DoD wording, D136 half-shipped).
- **V3** — the reviewer measurement gate; **V4** — the class-disposition tool.
- **S1–S4** — the seat trials and the wave-record fields that make them arithmetic.
- **T3** — the log pane, last of the three theming lanes.
- **R1 — inline legal lint.** The brief's own message fields are legal-checked only at generation, while
  pool entries are gated before any render. The ruleset is eight literal strings and a regex in
  `BrandComplianceChecker`; exporting the matcher and running it in `validate.ts` as a warning bucket is the
  whole lane — no endpoint, no debounce. **The one survivor of the collaboration plan**, and independent of
  both D64 and the render stack.

### The one rule this sequence encodes

**Nothing user-visible ships until C3.** C1, C2 and C4 are each provably byte-neutral because the
template is unwired while they run. That is not caution for its own sake — it is the only ordering in
which a half-finished convergence cannot ship a still image and a video that disagree.

## 4c. What Phase 0 actually produced

**Phase 0 is complete** — C1 (#313), C2 (#315), C3 (#319). The brief's template now reaches the
renderer. Two outcomes need recording, because both differ from what §4 predicted.

### The short-video decision

**Wiring the template revealed that `short-video` has never rendered its own layer stack.** It maps
to `creativeType: "video"` and `template: "canonical-video"`, whose ground layer is `kind: "video"`.
**There is no `video` drawer, and no `html` drawer.** With the template unwired, `resolveLayerList`
fell through to `canonical-image-text`, so a short-video campaign silently rendered the image-text
stack. C3 exposed that; it did not cause it.

**Owner's decision, 2026-09-10: throw loudly.** `drawTimeline` now refuses an undrawable kind the way
`drawLegacy` already did — one throw site, not two disagreeing behaviours. A user-selectable type
failing with a named error beats one quietly producing the wrong stack.

**Consequence: a `video` drawer is now a blocker on a shipped feature, not an L11 nicety.** It moves
to the front of Phase 2 and needs an `html` drawer beside it before the template library (L7) can
render two of its three seed thumbnails.

### Phase 0 converged three renderers, not four

`drawTimeline` iterates the resolved list but **skips `static-text`, `animated-text` and `logo`**,
drawing them afterward in fixed positions — copy is beat-selected, the logo is anchored to the key
beat's rest-pose box. So the motion path honours the declared order **among ground layers only**.

**That was C1's explicit scope boundary**, and reshaping the beat and anchor logic is a larger change
than any Phase 0 lane. But it means the honest claim is *one order for ground layers*, not *one order
everywhere* — and a template placing the logo below the shade is still honoured on the still path and
not on the motion path.

**New lane C5 — the motion path honours the full order.** Sequence it after the `video` drawer, since
both touch `drawTimeline`'s draw sequence and doing them together avoids two passes over the same
code. Until it lands, §0's table has three renderers converged and one partly.

### One gap with no owner, found on the way

`validateBrief` checks style and sizes but does not check the brief's copy fields **against its
template's `accepts` / `required` sets** — so a brief whose template omits a text kind can still carry
campaign copy the compositor will draw. It belongs with **M2**, where the boundary is already being
extended.

## 5. Gaps this review found that no plan owned

1. **The port wiring.** The templates plan assigns no lane to putting `template` on `CompositeRequest`. Now **C3**.
2. **The previews.** No plan noticed that two of the four renderers derive their own order. Now **C2**.
3. **`props` has no consumer lane.** D134 shipped the vocabulary and validation; nothing owns the read. Now **C4**.
4. **There is no video byte golden.** D10 freezes bytes that nothing measures. **R-D6** makes each lane prove it; a standing golden is a candidate lane of its own.
5. **L7 never shipped.** A read-only port with no consumer, no route, no library page, no thumbnails — and two of the three seed thumbnails need drawers (`html`, `video`) the first arc does not build.
6. **D136 half-shipped.** The occlusion advisory reaches the editor and no further, encoded `{ passed: true, reason }` against a type documenting `reason` as *"populated on failure"*.

---

## 6. Definition of Done

- **C1–C3**: a template whose order differs from canonical renders in **that** order in the still, in
  every MP4 frame, in the kit preview and in the web preview — or the plan records explicitly which
  surface stays canonical and why.
- **C4**: a per-layer prop changes the rendered output; absent props change nothing.
- **§3**: every retired plan carries a retirement line in its own file, pointing here.
- **§5**: each gap is either a lane or a written refusal. None stays a gap.

## 7. What this plan refuses

- **It does not fix the four renderers in parallel.** They are sequenced precisely so no intermediate
  state can ship a disagreement.
- **It does not rewrite the retired plans.** Retirement is a line in the file, not a rewrite.
- **It does not treat "the tests pass" as byte-neutrality** (R-D6). Nothing currently measures the
  bytes D10 freezes.
