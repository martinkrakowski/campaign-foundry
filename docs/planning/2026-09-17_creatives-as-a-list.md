# Creatives as a list — from two volume mechanisms to one addressable one

**Date:** 2026-09-17 · **Revised:** 2026-09-17 after an adversarial review that blocked the first draft.
**Status:** **CLOSED — not now.** The owner answered the question this document exists to ask on **2026-09-19**: hand-editing a brief is not a user need, so the addressability thesis in §2.1 has no near-term customer. CL-D10 survived into `2026-09-18_creatives-as-slots.md` as SL-D4 and **shipped**; CL-D1…CL-D9, CL-D11 and CL-D12 are **closed undecided**, not rejected on their merits. See §9. Nothing was ever dispatched from this document.
**Verified against:** `origin/main` at `78dc964a`.
**Source:** the owner's flow of 2026-09-17 — *"if user elects to generate a campaign with 2 variations (i.e. creatives), then 2 items appear in the left sidebar … User should be able to add and delete the creatives."*

> **Revision note.** The first draft was blocked for the same failure that blocked the first
> `creative-first-chrome` draft: claims about the system that did not survive contact with it. Four
> were false — they are retracted in §0 rather than quietly edited, because the argument they
> supported was wrong, not just imprecise. The corrected reading makes the case for the change
> **stronger** and the scope **larger**.

---

## 0. Retractions

| First draft claimed | Tree says | Consequence |
|---|---|---|
| *"CC3 (shipped)"* | `TemplateSection.tsx` still owns the stack; `premise CC3` still stands; `feat/rail-layers` is **PR #474, unmerged** | CC1/CC2 shipped. CC3 did not. |
| *"One-creative motions have to pretend to be a degenerate space"* | `social-post` and `display-ad` are **`mode: "brief"`** (`campaign-types.ts:43,78`) — classic, driven by named `treatments`. Only `paid-social` and `short-video` are `variation` | **§2 argued from a product that does not exist.** The degenerate-space complaint is true of *variation mode only* |
| *"every axis a `readonly string[]`"* | `CampaignBrief.ts:83-102` — `paletteShift: number[]`, `duration: number[]`, `headline: string` (a pool ref), `background: { source?: string[] }` | The entry sketch must know which of these are copied onto a creative |
| *"Touches none of the layout work in flight"* | The source requirement is a **left-sidebar list** — the column SG3 wants, the `BriefEditor.tsx` four lanes are serialised on, and the preview path CC1 just re-keyed (`preview-props.ts` uses `products[0]` and `firstOf(state.variation.layout)`) | A *schema-only* change could ignore chrome. **This plan's source cannot.** |

---

## 1. What the document is today — **two** mechanisms, not one

### 1.1 Classic (`mode: "brief"`) — a cartesian over a named list

`GenerateCampaignUseCase.use-case.ts:282-283`, immediately **after** the variation early-return:

```js
if (brief.mode === "variation") return this.executeVariation(brief, options, log);

// 3-7. Generate every creative: one per (product × canvas × treatment), where the
// canvas is a social ratio (as today) or a display size from `output.sizes` (D113).
```

`treatments` is a list of `{ id, layout, tone }` (`Treatment.vo.ts:25`). Volume is `products × canvases × treatments`, **plus each requested `output.sizes` entry**. Exhaustive, no sampling, no distance constraint.

**This is already list-shaped**, and it is how IAB display fan-out works. `social-post` and `display-ad` both use it.

### 1.2 Variation (`mode: "variation"`) — a sampled draw over axes

```yaml
variation:
  count: 8
  seed: 3
  minDistance: 2
  axes:
    layout: [headline-top, headline-bottom]
    tone: [bold, subtle]
    paletteShift: [0, 0.1]
```

The planner samples `count` points under a Hamming constraint. `Variant` (`Variant.ts:13`) is plan-time only — **the variation path never reads `output.sizes`**, and `Variant` has no `size` field. `paid-social` and `short-video` use it; classic cannot run motion at all.

### 1.3 The actual gap the owner's flow exposes

Neither mechanism gives you an **addressable creative**.

- A **treatment** is shared across every product and canvas. It is a *rule*, not an ad — editing it changes many creatives at once.
- A **variant** is ephemeral and identified by `productId + index`; `index` is a position in a draw.

So *"click creative 2 and edit it"* has **no referent in either model.** That — not a nine-axis tax — is why the owner's flow cannot be stored today.

---

## 2. The marketing case, corrected

The first draft argued one-creative motions are badly served. **They are not** — but not for the reason a previous revision of this section gave. The honest case is different and narrower.

### 2.1 Why one creative

Organic social posts one thing; a brand or launch asset is singular and gets art direction and sign-off; `short-video` costs real compute per unit; client approval presents three routes, not forty draws.

**The gap is addressability, not expression.** You can already produce a **small cartesian**; you cannot *point at a cell*, name it, or hand-edit it without changing others — because the thing you edit is a treatment or an axis set.

*(Retracted from this section: the claim that a classic brief with "one product, one ratio and no treatments yields exactly one creative." **Classic never takes one ratio:** `GenerateCampaignUseCase.use-case.ts:284` walks `AspectRatio.all()`, and `derive.ts:75-78` states it outright — "Classic draws one set per canvas (W1: it never narrows to the selected platforms)." One product with no treatments yields **three** social-ratio cells plus any `output.sizes`. The addressability thesis never needed that sentence.)*

### 2.2 Why a hundred — and there are **two** engines, both of which must survive

| Motion | Volume comes from | Engine today |
|---|---|---|
| Paid social — delivery optimisation needs creative volume as a targeting input; the platform picks winners per audience slice and cannot learn from two | **Sampling a space** | the variation draw |
| Programmatic display — one idea across every IAB size | **`products × canvases × output.sizes × treatments`** | **the classic cartesian** |
| Organic social at scale — one idea across products and ratios | **`products × canvases × treatments`** | **the classic cartesian** |
| Fatigue rotation | a deep well | either |

**The first draft's error, restated because it is the whole finding:** it used programmatic display and localisation to argue for keeping *the draw*. **The draw has never produced a display size.** The cartesian does. And the draft then retired `treatments` — deleting the mechanism it claimed to protect.

### 2.3 What that means for the change

An authored list is the right home for *addressability*. It is **not**, by itself, a volume mechanism. So the change needs **both** engines demoted into generators that write entries:

- **A fan** — *"this concept × these products × these canvases (ratios **and** `output.sizes`)"* — the replacement for `treatments`.
- **A draw** — *"add 20 spread across these axes"* — the replacement for `variation.count`.

**A fan is not a nice-to-have (CL-D7). Treatments cannot die before it exists.** Losing "explore" is a UX risk; losing the cartesian is a domain deletion.

---

## 3. The proposed document change

### 3.1 The entry must round-trip a planned variant

An entry is `Variant` **plus** a stable id, **plus** `size` for display, **minus** `index`:

```yaml
schemaVersion: 2          # D133 — bumped; see CL-D12
creatives:
  - id: hero-bottle-square          # SAFE_ID_PATTERN, unique in the list
    productId: blaze-bottle
    aspectRatio: "1:1"
    layout: headline-bottom
    tone: bold
    backgroundSource: procedural
    paletteShift: 0                 # number, not string
    seed: 918273                    # CL-D6 — persisted, not punted
  - id: story-pack-tall
    productId: blaze-pack
    aspectRatio: "9:16"
    layout: headline-top
    tone: subtle
    backgroundSource: procedural
    paletteShift: 0.1
    headline: "Stay wild. Stay hydrated."   # the DRAWN text, or the ad is unreproducible
    motion: ken-burns-in
    durationSec: 6                  # number
    seed: 445566
  - id: leaderboard-bottle
    productId: blaze-bottle
    size: "728x90"                  # display cell — absent from Variant today
    layout: headline-bottom
    tone: bold
    seed: 112233
```

**Why each addition is load-bearing:** without the drawn `headline`, a `pool://copy` ad cannot be reproduced. Without `seed`, background generation is non-deterministic (`renderVariant` sets `cellContext.seed = variant.seed`). Without `size`, display cells are inexpressible — and they are 100% of `display-ad`'s volume.

### 3.2 Reproducibility — the claim, corrected

The first draft said *"a function of the document alone."* **It is not.** Today a variation run is *(brief, seed, planner version, compositor, pools, genAI)*. After the change it is *(brief, compositor, pools, genAI)* — **stronger against planner drift, not absolute.** And D123's sentence is about materialised template layers, not about freezing a draw.

`Variant` is also **already on disk**, in the report: assets carry `variantIndex` and `attempt`. The missing link is *report → brief*, not *"the concrete creative never exists."*

---

## 4. Decisions — twelve, none defaulted

| ID | Question | Recommendation |
|---|---|---|
| **CL-D1** | Does the draw survive? | **Yes, demoted — and axes persist as a *recipe*.** If axes are dialog ephemera, the next *"give me 20 more"* starts blank, which is a worse explore-loss than a buried button. Store the last generator config on the campaign, **unused at run time**. |
| **CL-D2** | Minimum one creative? | **Yes; refuse deleting the last.** Also unspecified and needed: `emptyProduct(1)` exists, `emptyCreative` does not — the create dialog must mint the first entry. And: what happens to entries referencing a deleted product. |
| **CL-D3** | Entry identity | **Operator-visible id, inheriting `SAFE_ID_PATTERN` and 64-char limit** (ids become filesystem segments), **unique across the list** the way treatments already are. A default from product+ratio+layout is fine; a silent collision on the second `headline-bottom` is not. |
| **CL-D4** | Migration | **Read both, write new, never rewrite on open.** Specify the open path: **materialise in memory via the planner** so the sidebar is not empty. Until save, planner version can still move what the operator sees — **say so, or the reproducibility claim is false for unmigrated briefs.** CLI `generate` on an old file must keep drawing: **two run paths until samples migrate.** |
| **CL-D5** | Per-entry template/style? | **Campaign-level for now** — but then *"click creative 2"* loads only product/ratio/layout/tone/motion. **Say that explicitly**, or the owner will expect per-creative layers. And `previewLook` + the rail fetch key must take the selected entry — `editor-state` + `preview-props.ts` + CC1's key. **Not independent of chrome.** |
| **CL-D6** | Seed | **Stamp it: every entry carries a seed; retire it as a policy field.** Punting it un-earns §3.2 entirely. Opaque is fine; absent is not. |
| **CL-D7** | **Cartesian fan** *(new — the blocker)* | **Required, and specified here, not deferred.** *Add: this concept × these products × these canvases (ratios and `output.sizes`)*. It is the replacement for `treatments`. **Without it, `display-ad` and `social-post` get strictly worse.** |
| **CL-D8** | **Re-roll / HITL** *(new)* | Today `replan` draws a different point for the same index, the brief does not change, and the report records `attempt`. If the list is the document: does re-roll **mutate the entry** (then a run writes the brief), **re-render in place** (useful for genAI, useless for "give me a different one"), or **append a sibling**? A run must not write the brief unless stamped. |
| **CL-D9** | **Asset identity** *(new)* | Does `id` replace `variantIndex` in paths, reports and `regenerateOnly`? Today it is `${productId}/v${variantIndex}` (`GeneratedAsset.ts:29`). Changing it rewrites reports, goldens, merge and the regenerate flow. |
| **CL-D10** | **Occupied-set planning** *(new)* | `PlanCapacity` plans a *fresh* set. Appending 8 to a list of 3 must distance against the occupants. `conflicts()` already takes pairs; the use case does not. Also: append vs replace vs fill-to-N. |
| **CL-D11** | **Per-entry vs campaign fields** *(new)* | Which fields live where. Note the Identity step's ratio chips write `variation.ratio` — **wrong if ratio is per-creative.** |
| **CL-D12** | **`schemaVersion`** *(new)* | **Bump it.** `CampaignBrief.ts:21` already versions shape for exactly this class of change. "Read both, write new" without a bump is how you get two shapes and no way to tell which you hold. |

**SG-D1 is not stamped.** The owner gave reasoning that implies retiring `mode`; they never stamped it, and this plan previously treated the inference as settled. **If Classic survives, there are two list-shaped concepts** (treatments-cartesian vs creatives-points) and this plan got simpler by assuming the other decision. Do not supersede SG-D1 here.

---

## 5. Costs — understated in the first draft

| Cost | Why it is larger |
|---|---|
| **Brief size** | 100 entries carrying drawn headline text, seed, motion and size is far larger than the 6-field sketch. D123's precedent is real but this is a bigger instance. |
| **`policyHash`** | Hashes `count/seed/axes/coverage/minDistance` with conditional spreading so old goldens stay put. Hashing a **list** is a new payload: **every existing `policyHash` golden moves on first write-migration.** `copyHash` is unaffected — say so. |
| **Estimate** | Not "list length". `VariationEstimate` also carries `genaiCalls`, `frames`, `sceneBackgrounds`, `feasible`; a mixed stills+clips list still needs those. `classicAdCount` disappears with treatments — or must be re-derived. |
| **Asset identity** | See CL-D9 — paths, reports, goldens, merge, `regenerateOnly`. |
| **Preview cost** | Selecting creative 2 is a **look change ⇒ `/preview-frame`**. Naively, on a 100-entry list, that is precisely the cost CC1 just paid to remove. **Selection must join `previewFetchKey`**, not brief identity. |
| **`PlanCapacity`** | Still needed, but the question becomes *"can I add N against this occupied set?"* — and DESIGN.md's feasibility copy is written about shortfall vs `count`. |
| **Goldens / samples** | `briefs/sample-motion.yaml` **is** the document in §1. Migrating samples is its own lane; unmigrated ones must keep parsing **and** keep generating. |

---

## 6. Sequencing — two options, and the first draft implied the wrong one

§5 of the first draft deferred the generator UI while CL-D1 kept the draw. **That is a sequencing trap:** shipping the list without a reachable generator *is* the explore-loss, and without CL-D7's fan it is also a domain deletion.

| Option | Shape | Trade |
|---|---|---|
| **(1) Schema-first** | Domain schema → run-from-list → editor selection → **fan + draw in the same wave** | What the first draft implied. **Not scoped**, and the largest thing on the table |
| **(2) View-first** *(recommended)* | Sidebar lists the cells; select drives the rail; **no add, no delete, no edit** | Delivers the owner's screenshot without freezing a draw. It gives click-to-edit **a place to look, not a place to write** — writing still needs the list, or an override map that *becomes* the list. Scoped as inspection only; otherwise a lane invents a write path in `editor-state` and ships a shadow document |

**(2) is recommended and was not offered in the first draft.** It is also the only option that does not require CL-D7–D12 answered up front.

### 6.1 What view-first may and may not do

| Owner's sentence | View-first | Needs persistence |
|---|---|---|
| *"two variations → two sidebar rows"* | **Yes.** Variation rows from `/campaigns/plan` (`briefs-api.ts:362` already calls it). **Classic rows must be derived locally** — see §6.2 | — |
| *"clicking the creative loads the creative"* | **Yes.** The selected index joins `previewLook` and `previewFetchKey` | — |
| *"add and delete the creatives"* | **No.** A delete from a view returns on the next plan; an add is either `count++` (still a space) or a list write | **durable add/delete** |
| *"hand-edit creative 2"* | **No.** Writing `layout` on a selection either changes the axis set (every creative) or needs an override map — **and an override map *is* the list** | **edit-one** |

**Scope the slice as list + select + preview.** Nothing else. Without that boundary a lane will invent a write path in `editor-state` and ship a shadow document — a second place the truth lives, which is worse than no list at all.

### 6.2 Classic must be in the first slice

`/campaigns/plan` **400s on a classic brief** — `plan.post.ts:36`: `if (brief.mode !== "variation") { setResponseStatus(event, 400) }`. So a sidebar fed only by `plan.variants` is **blank for `social-post` and `display-ad`**, the two types that already use the cartesian and the two the owner is most likely to open.

Derive those rows locally the way `classicAdCount` already does — `products × AspectRatio.all() × treatments`, plus `output.sizes` — and list those cells. **A sidebar that only understands variation would demo well on `short-video` and be invisible on a display campaign.**

---

## 7. What this plan does not do

- **It does not claim independence from the chrome work.** Retracted — see §0. The sidebar list contends with SG3 and with `BriefEditor.tsx`.
- **It does not retire `treatments`.** That waits on SG-D1 being stamped **and** CL-D7 shipping.
- **It does not decide per-creative templates** (CL-D5 defers, explicitly).
- **It does not delete the planner.** Demoted, twice: as a draw *and* as a fan.
- **It is not dispatchable.** It has decisions and no lanes. An implementation plan follows whichever of §6's options the owner picks.
- **It does not sequence the view against the chrome.** View-first is a `BriefEditor.tsx` lane and is **not** independent of **#474** (CC3 — rail / `TemplateSection`, nine unresolved comments) or of SG3's column. **This document may merge as docs-only in parallel; the view may not start until #474's occupancy of `BriefEditor.tsx` is settled.**
- **It does not require CL-D7–D12 before the view.** The fan (CL-D7) blocks **persistence**, not the screenshot. CL-D8/D9 are run-path decisions that come after a list exists. **CL-D5 and CL-D11 should be learned from building select+preview** — what actually changes when you click row 2 — rather than stamped in the abstract.

---

## 8. Premise

```premise CL0
# The brief has no `creatives` list; variation is still axes + count. Flips when the
# document gains the list. Probes the TYPE, not the YAML samples: a brief file that
# happens to omit `variation` would make a sample-based fence pass on an unchanged
# schema. Measured: ~23 ms.
#
# This fence does NOT guard the claims in this document. Four of them were false in
# the first draft and no fence caught them, because a premise checks a precondition,
# not an argument. That is a limit of fences, recorded here rather than papered over.
! grep -qn 'creatives' packages/CampaignOrchestration/src/domain/entities/CampaignBrief.ts
```

## 9. Closed — the owner's answer, 2026-09-19

This document's case rests on one sentence in §2.1: *"you cannot point at a cell, name it, or
hand-edit it without changing others."* The owner was asked whether creatives should become a
literal authored list. The answer retires the premise rather than the design:

> _"Whether or not a user will hand edit a brief is questionable, and probably would only exist in
> the case of running batches, even then the software that we are creating is the author of this
> yaml file. A user could technically create a batch script to edit an existing yaml, e.g. change
> text and image. Then run a batch of 100 or 1000 yaml files. This batch processing does not yet
> exist and will be a future feature. The yaml import/export flow will be a part of this design."_

**What that settles.** Addressability was argued for a *human* editing one cell. There is no such
user. The author of the YAML is this software, and the only realistic editor of an existing brief is
a **script**, at batch scale, changing a field like text or an image path. So CL-D1…CL-D9, CL-D11
and CL-D12 are closed **undecided**: the schema upheaval they describe (a `creatives` list, a
`schemaVersion` bump, asset identity moving off `variantIndex`) was never refuted — it simply has no
demand behind it today, and a bump paid now would be paid against a guess at what batch needs.

**Where the work actually went.** The one decision here that had a customer was CL-D10
("occupied-set planning"), which `2026-09-18_creatives-as-slots.md` adopted as **SL-D4** and shipped
(#500/#504). Add and delete for creatives exist; they are addressed by *slot*, which is what
`regenerateOnly` already did. Grok's refutation of the coordinate design made the same point from
the other side — an override map keyed by coordinate **is** this list with a worse key.

**What replaces it.** Batch processing, as a future feature. The requirement it places on the brief
is not per-creative identity in the domain but a YAML that **round-trips losslessly and survives a
machine edit** — a different and much cheaper property. *(That framing is this document's inference
from the owner's words, not their instruction; treat it as the thing to verify first when the batch
design starts, not as a settled constraint.)*

**The YAML import/export flow is part of that design and is no longer a standalone item.** It had
been carried as named-but-unspecified work; it is now explicitly owned by the batch feature, so it
should not be scheduled, scoped, or dispatched on its own.

**Reopen this document if** a human-facing reason to edit one creative appears — or when the batch
design lands and needs per-entry identity after all. The CL0 fence below is deliberately left live:
it is cheap (~23 ms) and it still watches the exact condition that would make this question urgent
again.
