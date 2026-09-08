# Display Advertising — Architecture & Development Plan

**Date:** 2026-09-07
**Author:** orchestrator
**Status:** draft — for the owner's review. **Not a quick win, and the plan says why before anything else.**
**Verified against:** `main` at `6217632`
**Decision ids introduced:** D113 – D118
**Relates to:** `2026-09-07_campaign-type.md` (adds the `display-ad` type this plan's ratios make
renderable), **D26** (the preview shows only what the compositor draws), **D52–D55** (the compositor
is the one layout engine; type is a fraction of canvas *width*), **D85** (the inset goldens exist for
`darwin-arm64` only)

---

## 0. What this plan answers

The owner's first stated market is *online static and video ads*. The campaign-type plan showed that
**paid social** is a preset over platforms the domain already has — but **display advertising**, in
the sense a media buyer means it, is not. It is a family of fixed pixel sizes with no relationship to
the three canvas ratios the compositor renders, and the compositor's type model does not survive
them.

**This is the expensive one.** Everything in the campaign-type plan lives inside `1:1`, `9:16` and
`16:9`. Display advertising requires new ratios, new canvas sizes, a change to how the compositor
sizes type, new platform profiles with new safe areas, re-recorded pixel goldens on two platforms,
and a compile-forced sweep through every union-keyed component in the kit. Each of those is
bounded; together they are a plan, not a lane.

**The five sizes.** The IAB standard units a buyer will actually ask for, and what each does to the
current model:

| Unit | Pixels | Ratio | What breaks |
|---|---|---|---|
| Medium rectangle | 300 × 250 | `6:5` | new ratio; small canvas |
| Leaderboard | 728 × 90 | `~8:1` | **type sized by width overflows the height** (F1) |
| Wide skyscraper | 160 × 600 | `4:15` | type sized by width is unreadably small (F1) |
| Mobile banner | 320 × 50 | `32:5` | F1, worst case — 50 px tall |
| Half page | 300 × 600 | `1:2` | new ratio; the only one close to an existing shape |

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D113** | **Display sizes are a second ratio family, not more members of the first.** `DISPLAY_SIZES` is its own union-keyed constant with pixel dimensions; `RATIO_VALUES` is untouched. A `CanvasSpec` type unifies the two (`ratio` *or* `size`) at the one place the compositor reads dimensions. | The three social ratios are *proportions* rendered at 1080/1920; a display unit is an *exact pixel size* that must not be scaled. Folding `6:5` into `RATIO_VALUES` would invite rendering a 300×250 as 1080×900, which no ad server accepts. Two families with one join point keeps the invariants of each. |
| **D114** | **The compositor's type scale becomes a function of the canvas's short side — not width alone — for the size family.** The three social ratios keep D55 exactly (type, logo and margin proportional to **width**), so their goldens stay byte-identical by construction. Width terms use width; the short side governs type, logo and margin for the size family. | F1 is the finding that makes this plan real. **Verified:** `aspect-ratios.ts:14-16` maps ratios to 1080-based sizes, and `fitText` (`NodeCanvasCompositor.ts:579`) derives size from width. A leaderboard would set type at ~49 % of its height before the headline's second line exists. **The three existing ratios must render byte-identically after this change** — that is the golden suite's job (D115) and the reason this lane cannot be waved through on a visual check. Owner decision 2026-09-07: scaling is split by canvas family. |
| **D115** | **Goldens are recorded for `linux-x64` as well as `darwin-arm64` before any display size lands — closing D85 first.** The inset goldens exist for darwin only; the base goldens for both. | A golden that silently skips on the platform CI runs is a vacuous tripwire (D85's own words). D114 changes type sizing under every existing ratio; if the only pixel evidence is on the operator's laptop, the change ships unverified where it actually runs. This is a **prerequisite lane**, not a follow-up. |
| **D116** | **Display placements are platform profiles, like the seven social ones.** `google-display`, `meta-audience-network`, and a generic `display-web` each carry a `sizes: readonly DisplaySize[]` instead of a single `ratio`, with safe-area insets per size. | The platform profile is already where ratio, formats and insets live for social; display is the same shape with a list of sizes where social has one ratio. A separate mechanism would be a second `Distribution` model. |
| **D117** | **`display-ad` joins `CAMPAIGN_TYPES` only in this plan's last lane, after the sizes render.** Until then it is not selectable anywhere. | The campaign-type plan's D108 refuses a type that produces an unrenderable campaign. Adding the option first and the rendering later is the D8 failure — a create choice that leads to a dead end — and it is exactly the shape the `GLOBAL` map trap and the classic+motion defect both took. |
| **D118** | **Display is static-only in this plan.** No HTML5 or video display units. | Rich-media and video display are a third format family (animated HTML, VAST) that the compositor does not produce and `ffmpeg` does not target. Stating the boundary here keeps "display advertising" from meaning everything a buyer might ask for. |

---

## 1. Findings

#### **F1 · C · The type model does not survive the aspect ratios display requires**

```ts
// packages/CampaignOrchestration/src/domain/value-objects/aspect-ratios.ts:14-16
"1:1":  { width: 1080, height: 1080 },
"9:16": { width: 1080, height: 1920 },
"16:9": { width: 1920, height: 1080 },
```

and `fitText` (`NodeCanvasCompositor.ts:579`) sizes type as a fraction of `width` (D55 chose this
deliberately: *"the compositor is width-fraction throughout — `fitText` at `width * 0.06`"*). Across
the three social ratios the short side is never less than 56 % of the long, so width-scaling is a
reasonable proxy for short-side scaling. Display units break the proxy: 728×90 has a short side
**12 %** of the long. Width-scaled type would be `728 × 0.06 ≈ 44 px` on a 90 px canvas — before a
subhead, a CTA, or a second line. On 320×50 it is worse. Graded **C** because it is a build-level
change to the one layout engine (D52), guarded by pixel goldens.

#### **F2 · H · A `display-ad` type added before its sizes render is a dead end at create**

The campaign-type plan's D108 deliberately excludes `display-ad`. If it were added as a preset over
platforms that do not exist yet, the user would create a campaign whose Output step has no platform to
select and whose run produces nothing. **D117** orders the lanes so the type is the *last* thing to
land, not the first.

#### **F3 · M · The inset goldens have no `linux-x64` map**

`compositor-goldens.json` keys `darwin-arm64` and `linux-x64`; `compositor-goldens-insets.json` keys
`darwin-arm64` only. D85 recorded this as "record it, or withdraw the claim." D114 changes rendering
under every ratio, so the claim must be recorded, not withdrawn — **before** the change, as the
baseline it is measured against.

#### **F4 · M · Every union-keyed component in the kit is a compile error waiting to be resolved**

`RatioFrame`, `PosterFrame`, `CanvasRatio` in `Distribution`, and `PROPORTIONS`-style records are
union-keyed on the three ratios *on purpose* — a new member is a compile error, not a silent fallback.
D113's second family means each decides: render display sizes (the compositor preview must, D26),
render a placeholder, or refuse. **The compiler produces the list**; the lane resolves it.

#### **F5 · L · Safe areas are per-platform today; display needs them per-size**

`PlatformProfile` carries one `insets` per profile because it carries one ratio. A display profile
with five sizes needs five inset sets — a 320×50 has no room for any inset at all. D116's `sizes`
list carries insets per entry.

---

## 2. The recommendation

```
A0  goldens on linux-x64       →  close D85; the baseline every later lane is measured against
A1  the second ratio family    →  DISPLAY_SIZES, CanvasSpec, the join point in the compositor
A2  type scale by short side   →  fitText; the three social ratios byte-identical (goldens prove it)
A3  display profiles + insets  →  three platforms, per-size insets
A4  the kit resolves the union →  RatioFrame / PosterFrame / previews for display sizes
A5  the campaign type          →  `display-ad` joins CAMPAIGN_TYPES; preset = display profiles
```

**A0 first and alone.** **A1 → A2** (A2 needs the join point). **A3 ‖ A4** after A2. **A5 last**
(D117).

### 2.1 What "byte-identical" means for A2

The golden suite renders every fixture at every existing ratio and compares pixels. A2 changes the
type-scaling formula; for the three social ratios the new formula **must reproduce the old output
exactly**, or the change is not a generalisation but a redesign. If it cannot — if short-side scaling
genuinely differs from width scaling on `16:9` by even a pixel of glyph advance — the lane stops and
the plan needs a decision on whether the social output may move. **The goldens decide, not the eye.**

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **A0** | **Record the inset goldens for `linux-x64`** (D115, F3, closing D85). Run the recording on the platform CI uses — a GitHub runner, not the operator's laptop — commit the map, and make the inset golden test **fail** rather than skip when the running platform has no map. | `CreativeGeneration/.../fixtures/compositor-goldens-insets.json`, `NodeCanvasCompositor.goldens.test.ts` | A tripwire that trips where it runs. Prerequisite for everything below. |
| **A1** | **The second family** (D113). `DISPLAY_SIZES = { "300x250": {width,height}, … }` as its own union-keyed constant; `CanvasSpec = { ratio: AspectRatioValue } \| { size: DisplaySize }`; **one function** resolves a spec to pixel dimensions and it is the only place the compositor reads them. `RATIO_VALUES` untouched. YAML: `output.sizes?` beside `output.formats` (D112's optional-with-default precedent). `validateSizes` in `load-brief.ts`. Every `briefs/sample-*` parses unedited. | `aspect-ratios.ts` (the resolver), `display-sizes.ts` (new), `CampaignBrief.ts`, `load-brief.ts`, `brief-yaml.ts`, tests | Sizes the compositor can be asked for. |
| **A2** | **Type scale by short side** (D114, F1). `fitText` and every `width * k` sibling (logo `0.16`, margins `0.04` — enumerate them all first; the template plan counted three) become functions of `min(w, h)` for type, logo and margin; width terms use width. **A0's goldens must pass unedited for every social ratio.** Then render the five display sizes and **record their goldens** on both platforms. If any social golden moves, **stop** — §2.1. | `NodeCanvasCompositor.ts`, both golden fixtures, tests | Readable type on a 90 px canvas without touching a single social pixel. |
| **A3** | **Display platform profiles** (D116, F5). `google-display`, `meta-audience-network`, `display-web`, each with `sizes: readonly { size, insets }[]`. `PlatformProfile` gains the size-list shape as an alternative to `ratio`; the seven social profiles are unchanged. `PLATFORM_ORDER`, `togglePlatform`, `platformsToRatios` learn the alternative. | `PlatformProfile.vo.ts`, `editor-state.ts` (derive), `derive.ts`, tests | Somewhere for a display campaign to be sent. |
| **A4** | **The kit resolves the union** (F4). Widen `RatioFrame`/`PosterFrame` to `CanvasSpec`; the preview renders display sizes at true proportion (a 728×90 preview is a very wide, very short frame — that is correct and the point). `PreviewDock`/`CreativePreview` render the compositor's real output for a size, per D26/D52. **Let the compiler enumerate the sites**; do not grep. | `ui/ratio-frame.tsx`, `ui/poster-frame.tsx`, `ui/preview-layers.ts`, `campaign/PreviewFrame.tsx`, `CreativePreview.tsx`, tests | Previews that tell the truth about a leaderboard. |
| **A5** | **`display-ad` joins the vocabulary** (D117). `CAMPAIGN_TYPES` gains the fourth member; `CAMPAIGN_TYPE_PRESETS` maps it to A3's profiles, `static`, `brief`. A fourth `OptionTile` in the dialog with a `PosterFrame` at a display size. **Last, because until A2 ships the tile would lead to an unrenderable campaign.** | `campaign-types.ts`, the dialog, `messages.ts`, tests | The create option, once it cannot dead-end. |

**Waves.** **A0** → **A1** → **A2** → **A3 ‖ A4** → **A5**. Five waves, sequential at the head.

---

## 4. Definition of Done

Standing gate per lane (100 % ×4); a mutation per claim confirmed to **compile, run, and target the
path the test names**.

- **A0**: the inset golden test **fails** (not skips) on a platform with no map; both maps present.
- **A1**: one resolver, asserted to be the only reader of pixel dimensions (a grep in a test);
  every sample brief parses unedited; unknown size → 400 on `briefs`, `generate`, `plan`.
- **A2**: **every social golden byte-identical on both platforms** — the PR body shows the fixture
  diff is empty for `1:1`/`9:16`/`16:9`; display goldens recorded on both platforms; a 728×90 render
  fits a two-line headline with the CTA visible (asserted on the layout result, then pinned by pixels).
- **A3**: the seven social profiles unchanged (their tests unedited); each display profile's every
  size has insets; `platformsToRatios` and `platformsToFormats` handle a mixed selection.
- **A4**: `tsc` clean with zero `as` casts added at union sites; a `PosterFrame` at `728x90` renders
  at true proportion.
- **A5**: choosing `display-ad` at create yields a campaign that **runs** — proven end to end
  against the API with the display profiles, not asserted from the preset table.

---

## 5. Deferred

| What | Waits on |
|---|---|
| HTML5 / rich-media display units | a third format family (D118) — animated markup the compositor does not produce |
| Video display (VAST, out-stream) | D118, and an ad-server integration that does not exist |
| Responsive / flexible units | the size list is fixed by design; a fluid unit is a layout engine change |
| Non-IAB sizes (DOOH, print) | D113's family model extends to them; each is its own size table |

---

## 6. Open questions

1. **May the social output move at all under D114?** §2.1 says no by default. If short-side scaling
   turns out to be *better* on `16:9`, the owner may want it — but that is a redesign with new
   goldens, decided on purpose.
2. **Which five sizes first?** The table is the IAB "most common" set. A buyer's actual demand list
   may differ; the family model makes adding one cheap *after* A2.
3. **Is `display-web` a real platform or a bucket?** A generic profile is honest about the fact that
   most display is served by networks the domain does not model. Whether it should exist, or the
   two named networks are enough, is a product call.

---

## 7. What this plan does not pretend

That this is comparable in size to the campaign-type plan. It is not: the type plan is presets over
existing data and ships in three lanes; this one changes the layout engine's central formula under
pixel goldens, on two platforms, before its first user-visible surface exists. **A0 through A2 are
the whole cost, and A2 is where it can fail** — if short-side scaling cannot reproduce the social
output byte-for-byte, the plan needs the owner's decision before any display size renders. Everything
after A2 is data and unions the compiler enumerates.
