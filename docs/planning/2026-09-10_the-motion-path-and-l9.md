# The Motion Path Blocks L9 — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Origin:** the Fable plan review of `2026-09-08_creative-templates-and-units.md`, 2026-09-09.
**Verified against:** `main` at `7471bf5`.

---

## 0. Why this exists

L9 — the layer toggle (D129) — is the next lane in the templates plan. **It cannot meet its own
definition of done**, and the reason is one line of the compositor that predates it.

The review that found this also found a **shipped** defect on the same code path, which is already
fixed (#303). The rest was never written down; it lived in one conversation. This document is that
record.

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **MP-D1** | **The motion path iterates the resolved layer list, like the still path already does.** | `drawLegacy` iterates `prepared.layers` (`NodeCanvasCompositor.ts:293`). `drawTimeline` calls `drawLayer("image")`, `drawLayer("shade")`, `drawLayer("accent")` by name (`:848-850`). A template's declared order therefore governs stills only — and a **disabled** layer would be honoured on the poster and ignored in every delivered frame. |
| **MP-D2** | **That change lands *before* L9, in its own lane, not inside it.** | L9 does not own `NodeCanvasCompositor.ts`; the templates plan's ownership table puts it elsewhere. A toggle shipped without this is a feature the MP4 silently ignores — worse than not shipping it. |
| **MP-D3** | **Occlusion is evaluated over the *enabled* subset; order constraints stay on the *full* array.** | Two inputs, two rules. A disabled layer draws nothing, so it cannot occlude — but it keeps its slot, so re-enabling can never produce an illegal order. `findOcclusionDelta` takes `{id?, kind}` and has no `enabled` input today. |
| **MP-D4** | **"Required cannot be disabled" means at least one *enabled* instance of each required kind.** | `image` is uncapped in `image-text`, so two image layers can both be disabled while `presentKinds` still contains `image` and the boundary passes. Nothing would paint the ground. |
| **MP-D5** | **`maxOf` and `sharedBudgets` count disabled layers.** | A hidden layer still occupies its slot in the template. Otherwise disabling a logo would let a second be added and re-enabling would exceed the cap. |
| **MP-D6** | **Record D136 as half-shipped rather than done.** | The advisory reaches the editor and no further. It is also encoded `{ passed: true, reason }`, while `ComplianceResult` documents `reason` as *"populated on failure"* — an aggregator reading `passed` sees nothing and one reading `reason` sees a failure. |

---

## 1. Findings

#### **F0 · C · The brief's template never reaches the compositor at all**

**Everything the templates arc shipped is inert at render time.** The reorder control, the ordering
constraints, the occlusion guard, the layer list itself — all validated, all stored, all reflected in
the editor's own preview, and **all ignored when a campaign renders.**

**Evidence.**
- `CompositorPort.ts` — `CompositeRequest` has **no `template` and no `creativeType` field**.
  `VideoCompositorPort` extends it and adds none.
- `GenerateCampaignUseCase` and `PreviewCreativeFrameUseCase` build those requests and **neither
  passes a template**. The only mention of the word across the whole application layer is one
  comment.
- `NodeCanvasCompositor.prepare` accepts an optional `template`, and its own comment says the field
  "stays off the port interface until L3 wires it through". **L3a and L3b shipped; the port was never
  touched.**
- `resolveLayerList(undefined, undefined)` therefore falls through to
  `CANONICAL_TEMPLATES["image-text"]` for every still, poster, MP4 frame and preview frame. The only
  callers that pass a template are tests.

**Mechanism.** A user reorders layers in the Template section. The order passes `validateTemplate`
and `isBriefTemplate`, is persisted in the brief, and renders in the canonical order regardless.

**What it changes.** MP-D1's *"like the still path already does"* is true at the adapter seam and
**false in the product**. M1 is necessary but not sufficient, and a wiring lane must follow it.

**Sequencing matters and is counter-intuitive.** M1 must land **before** the wiring, not after. While
the template is unwired, M1's list is always the canonical one, so byte-identity is trivially
preserved and the refactor is safe. **Wiring first would open F1's hazard for every reorder rather
than only for toggles** — the still image would honour the user's order while the video ignored it.

#### **F1 · C · L9's definition of done cannot be met on timeline briefs**

L9's DoD says *"a disabled optional layer is absent from the draw list"*. True on the still path,
false on the motion path.

**Evidence.** `drawTimeline` draws the ground trio by kind (`:848-850`), under a comment stating
this is deliberate for D10 — motion bytes are frozen — and deferred to "the lanes that teach the
compositor `video` and `animated-text`". `drawLegacy` iterates the list (`:293`).

**Mechanism.** An `image-text` brief with `copy.timeline` and `durationSec`, with `shade` disabled:
the poster and `/preview-frame` omit the shade; every delivered frame draws it.

**Already proven on the same path.** The logo half of this was a live defect — the motion path drew
a logo gated on whether the file loaded while the asset record reported the layer list, so a brief
with no logo layer shipped frames containing one. Fixed in #303. **The ground trio is the same
shape and is still open.**

#### **F2 · H · Toggle and occlusion have no stated rule**

`findOcclusionDelta(before, after)` takes `{id?, kind}`; `enabled` is not an input, and the reducer
recomputes the notice only on add, remove and move.

**Three mechanisms.** Disable an `accent` that is currently occluding a headline: the array is
unchanged, the delta is null, and **the notice persists for a layer that no longer draws**.
Re-enable it: no delta, no notice, though the occlusion is back. Move a *disabled* `shade` above
text: a notice fires for something that paints nothing.

#### **F3 · H · L7 did not ship, and the wave order treats it as done**

Only the read-only template store port exists (`3192005`); nothing consumes it. There is no
templates route, no library page, no thumbnail code. `isBriefTemplate` and `validateTemplate` accept
only `CANONICAL_TEMPLATE_IDS` and require `id === CANONICAL_TEMPLATES[creativeType].id`, and neither
checks `version` against any library — so **D123's "a new version is a new record" is unreachable
from a brief.** The plan's "L4 ‖ L7" is false and the library work is unowned.

**A thumbnail dependency the first arc does not build:** `LAYER_DRAWERS` has no `html`, `video` or
`fill` drawer and `drawLayer` throws, so two of the three seed thumbnails cannot be produced.

#### **F4 · M · `enabled` has no validation slot**

`isLayerEntry` and the API's layer check read `id`, `kind` and `props` only — `enabled: "yes"` passes
both today. `LAYER_KEY_ORDER` is `["id","kind","props"]`, so the field survives a YAML round trip but
dumps after `props`. **L9's ownership list is missing the files it will actually touch**:
`creative-templates.ts`, `brief-template.ts`, `brief-yaml.ts`, `editor-state.ts`, `messages.ts`, and
`NodeCanvasCompositor.ts`.

#### **F5 · M · L9's DoD contradicts the kit's gating rule**

It says *"a disabled control"*. `DESIGN.md` §1 and `TemplateSection.tsx`'s own header say the
opposite: absent from the offer, never present-and-disabled. Rewrite as *no toggle is offered on a
required layer*.

---

## 2. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **M1** | **The motion path iterates the list.** Keep the drawn order identical for canonical templates so goldens do not move; the change is *where the order comes from*, not what it is. Prove byte-identity on the canonical set before anything else. | `NodeCanvasCompositor.ts`, its tests | L9 becomes possible |
| **M1b** | **Wire `template` through the port.** Add it to `CompositeRequest`, pass it from both use cases, and decide whether the kit's `PREVIEW_LAYER_ORDER` follows the brief or stays canonical — it derives from `CANONICAL_TEMPLATES` today, so preview and compositor agree only because **both** ignore the brief. **Must land after M1.** | `CompositorPort.ts`, both use cases, port test doubles, possibly `preview-layers.ts` | The arc stops being inert |
| **M2** | **`enabled` reaches the boundary**: the field, its validation in `isBriefTemplate` and `validateTemplate`, its slot in `LAYER_KEY_ORDER`, and MP-D4/MP-D5 counting rules. | `creative-templates.ts`, `brief-template.ts`, `brief-yaml.ts`, `load-brief.ts` | The contract L9's UI needs |
| **M3** | **The toggle itself** (D129) — the control, the reducer action, and MP-D3's occlusion rule over the enabled subset. | `editor-state.ts`, `derive.ts`, `TemplateSection.tsx`, `messages.ts` | L9 |
| **M4** | **Amend the templates plan**: F3's L7 status, F4's ownership list, F5's DoD wording, and D136 as half-shipped. | `2026-09-08_creative-templates-and-units.md` | The plan stops asserting things that are not true |

**Order.** M1 → **M1b** → M2 → M3, strictly. M4 whenever. **M1 is the gate**: if the canonical goldens move,
stop and report rather than re-recording them — a golden that changes under a refactor is either a
real behaviour change or a bug, and both want a decision.

## 3. Definition of Done

- **M1**: every canonical template renders byte-identical before and after — proven per frame through
  `NodeCanvasCompositor.draw`, since **there is no video byte golden** and D10's freeze is not backed
  by one. `NodeCanvasCompositor.layer-order.test.ts` pins the by-kind order deliberately and is
  **expected to go red and be rewritten**; that is not a golden moving.
- **M1b**: a reordered template renders in that order on **both** paths, and the editor preview agrees
  with the compositor or is explicitly documented as canonical-only.
- **M1**: (superseded above); a template whose list
  omits a ground kind omits it from **both** paths. Proven by mutation, not by inspection.
- **M2**: `enabled: "yes"` is refused at both boundaries; a disabled layer survives a YAML round trip
  in its declared key position; two disabled `image` layers are refused under MP-D4.
- **M3**: disabling a required layer offers no control and is refused at the boundary; a disabled
  layer is absent from **both** draw paths and present in the document; occlusion notices name only
  layers that draw.

## 4. What this plan refuses

- **It does not make the motion path list-driven as part of L9.** That is MP-D2, and it is the whole
  point: a toggle whose effect the MP4 ignores is worse than no toggle.
- **It does not touch the frozen order.** D10's concern is bytes. M1 changes where the order is read
  from and must prove the bytes are unchanged.
- **It does not re-open D136.** It records the shipped half honestly and leaves the aggregation to
  whoever owns the compliance page.
