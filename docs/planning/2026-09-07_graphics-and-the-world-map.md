# Graphics and the World Map — Architecture & Development Plan

**Date:** 2026-09-07
**Author:** orchestrator
**Status:** draft — for the owner's review, then the two-reviewer pass
**Verified against:** `main` at `c9a0505` (W1 merged; W2(a) in flight on `feat/w2a`)
**Decision ids introduced:** D93 – D96
**Relates to:** `2026-09-06_create-dialog-recomposition.md` (D86 – D92, C1 – C7), **D65** (no id in
the dialog), **D88** (no new looping animation), DESIGN.md §1.3 (dense and operational, no hero
areas), §2 (tokens; the looping-preview budget at :203-213)

---

## 0. What this plan answers

The recomposed dialog shipped (PR #203) and the owner's verdict on the styling was that it did not
look like the inspiration. Comparing the two screenshots side by side, that verdict is correct, and
**the cause is not DESIGN.md.**

The inspiration's tiles are three-part: a 132 px **preview panel** on its own ground, holding
miniature poster skeletons at true ratios with a mono corner caption; a **body** with icon, name,
uppercase mono tag and a check badge; then a **blurb** sentence and a mono **meta** line. What
shipped is a 46 px glyph, a name, and one muted caption.

`OptionTile` was built with exactly the slots to carry the richer version — `tag`, `blurb`, and a
caller-sized picture slot, which was the entire reason for not reusing `AxisCard`'s fixed 44 px
well. `ModePanel` passes none of it:

```tsx
// apps/web/src/components/campaign/ModePanel.tsx — every prop it passes
<OptionTile value={option} name={option} meta={modeDisplayName(option)} … >
  <ModeGlyph scattered={…} />   // the same 46px glyph AxisCard showed
</OptionTile>
```

And the previous plan's §2.2 *specified* the static replacements for the mockup's animated previews
— "three overlapping frames, offset", "a static scrub with the head at ~30 % and two tick marks" —
which no lane was ever briefed to build. **The container shipped; the contents did not.** That is
a gap between the plan and its briefs, recorded in §7 as this plan's own correction.

**What DESIGN.md actually forbids is one thing: looping animation** (D88, §2:203-213). Preview
panels, poster skeletons, true-ratio frames, corner captions, tags, blurbs, eyebrow labels, status
colour — all static, all token-only, all permitted. The repo already carries the vocabulary:
`CreativeGlyph` draws layered rects, `RatioFrame` draws true proportions, `Eyebrow` and `MiniChip`
exist. The one rule that genuinely needed a decision — §1.3's "no hero areas" — the owner has now
taken (D93).

**Scope, as the owner set it (2026-09-07):** full inspiration parity on the previews; the
start-from picker as a card rail (C3's affordance on the real domain); **and the world map (C2)**.
The map is the one item that is not a styling lane, and §1 F2 is the finding that decides its
shape: the region reaches generation only as prompt text, so the map can ship **now, single-select,
with no domain change** — and multi-select waits on a decision the code cannot make for us (D95).

**What this plan is not.** It does not reopen D65 (the campaign-ID readout), C4 (assets at create),
C5 (format tiles) or C6 (the estimate line). It does not change `targetRegion`'s type.

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D93** | **A preview panel is operational chrome, not a "hero area".** DESIGN.md §1.3 forbids editorial rhythm; a picture of what an option produces is the opposite — it is the review console's own idiom (`PreviewCard`, `PreviewDock`, the compositor preview). The `OptionTile` preview panel is permitted at the mockup's scale (~132 px) on its own `bg-background` ground. | The owner took this on 2026-09-07. Recording it as a decision, not an assumption, because it is the one place a reviewer could cite §1.3 against the whole wave. |
| **D94** | **The world map ships single-select, over the existing six-value vocabulary, with no domain change.** `targetRegion` stays `string`. Each of `GLOBAL / EU / DE / UK / US / APAC` gets a map footprint (§2.3); clicking a footprint sets the value exactly as clicking its chip does; `Other…` stays a chip, because a map cannot represent free text. The map and the chips are two views of one control. | F2: the region is consumed by generation as **prompt text and nothing else** — four `Market/region: ${…}` lines, no axis, no capacity, no branch on any value. A multi-select map would therefore be a control whose only effect is a comma-joined string, wearing copy ("runs dispatch per region") that is false here. Single-select is what the map can honestly do today, and it needs none of the eight-layer type change C2 was priced at. |
| **D95** | **OPEN — the owner's call: what does more than one region *mean* for generation?** Three candidates: *(a)* **prompt text only** — the list joins into `Market/region: DE, UK`, the readouts show a list, nothing else changes (cheap; semantically thin); *(b)* **a variation axis** — region joins `axes` beside layout/tone/ratio, so Randomized campaigns fan out per region and Classic gets one (domain-native; needs the compositor to ignore it and `PlanCapacity` to count it); *(c)* **per-region runs** — one generate pass per region, N× creatives and N× credits (needs capacity, the lock, and a run model that does not exist). The plan recommends **not deciding this now**: the map does not need it, and (b)/(c) are plans of their own. | Every earlier costing of C2 assumed the type change was the work. It is not; the *meaning* is. `targetRegion: string → string[]` is mechanical at eight layers; what a second value does at `GenerateCampaignUseCase.use-case.ts:211` and `:336` is a product decision nobody has stated. **The kit does not pre-build for it**: no `multiple` prop, no arc code — a slot with no consumer is not a deliverable (§7), and dead code behind an unreachable flag is red under the 100 % branch gate. D95's lane adds both. |
| **D96** | **D88 forbids loops, not transitions. The map's arcs and dot-reveal stay; its ping goes.** A `transition` that runs once on a selection change — the arc's `stroke-dashoffset`, each dot's staggered `transition-delay`, the tile preview's dim/undim — is a one-shot on interaction and is what DESIGN.md:203-208 permits. `@keyframes ping … infinite` is a loop and is refused. | Without this split a cautious lane drops the arcs and the dot matrix "to be safe", and the map loses most of its character for no rule. Stating which is which is cheaper than re-litigating it in review. |

---

## 1. Findings

Severity: **C** breaks a user's data or the build · **H** the product tells the user something false
· **M** a real defect with a bounded blast radius · **L** correctness of the estate, not the product.

#### **F1 · M · The tile's slots are empty, and the plan's own static previews were never briefed**

`OptionTile` offers `tag`, `blurb`, `meta`, `description` and a caller-sized picture slot
(`ui/option-tile.tsx:6-29`). `ModePanel` passes `value`, `name`, `meta`, and the pre-existing 46 px
`ModeGlyph` — nothing else. The previous plan's §2.2 replacement table ("three overlapping frames,
offset"; "a static scrub with the head at ~30 %") named the pictures and no lane was told to draw
them. Graded **M**: nothing is false, the dialog simply does not look like the thing it was built
to look like. *Owned in §7.*

#### **F2 · H · The region is prompt text and nothing else — and the mockup says otherwise**

Every consumer of `targetRegion` outside display:

| Site | What it does with the value |
|---|---|
| `GenerateCampaignUseCase.use-case.ts:208-212, :333-337` | copies it into `BackgroundContext.targetRegion` |
| `GeminiImageGenerator.ts:96`, `OpenRouterImageGenerator.ts:163`, `FireflyImageGenerator.ts:189` | `Market/region: ${context.targetRegion}.` in the background prompt |
| `OpenRouterCopyGenerator.ts:129` | `Market/region: ${delimit(brief.targetRegion)}.` in the copy prompt |
| `PlanCapacity`, `PlanVariations`, the `axes` block (`CampaignBrief.ts:65`) | **do not read it** |
| any `"GLOBAL"` branch | **none** — it is a label |

So the mockup's Regions hint — *"Five macro regions — runs dispatch per region"* — describes a
product this is not. Graded **H** because a lane that copies the mockup's copy would ship a sentence
that is false about what Create does. **D94 is the answer**, and the map's hint must be written
against F2, not against the mockup.

#### **F3 · M · `OptionTile` cannot hold a full-bleed preview without a structural change**

The tile is one `flex flex-col … p-3.5` button (`ui/option-tile.tsx:66`). The mockup's `.pvbox` is a
panel that runs edge to edge *above* a padded body, with its own ground and a rule beneath it. A
132 px panel dropped inside 14 px of padding reads as a picture in a frame, not as the mockup. G1
therefore adds a **`preview` slot rendered outside the padding**, and moves the padding to the body.
The accessible-name contract is unaffected; the two suites that query mode cards by raw value survive.

#### **F4 · L · The mockup's map is portable pure code**

`chaikin()`, `pip()`, `polyPath()`, the `REGIONS` table and the polygon constants are framework-free
TypeScript with no DOM dependency. They are kit utilities with unit tests, trivially 100 %-branch
coverable, and should be **ported verbatim** into the kit rather than redrawn. The only parts that
need rewriting are the DOM wiring (React instead of `innerHTML`) and the vocabulary (§2.3).

#### **F5 · L · Two of the six regions have no polygon in the mockup**

The mockup's polygons are continent-grain (`NA`, `EUR`, `ASIA`, `AUS`, …). `EU`, `UK`, `US`,
`APAC` and `GLOBAL` can be composed from them (§2.3). **`DE` needs a Germany polygon and `US` needs a
contiguous-states polygon**, neither of which exists — two coarse anchor lists of ~8–10 points each,
smoothed by the same `chaikin()` pass so they share every other landmass's designed roundness.
Recorded so M1 budgets for drawing them rather than discovering the gap.

---

## 2. The recommendation

### 2.1 The shape

```
G1  kit previews        →  PosterFrame, PreviewPanel, OptionTile `preview` slot      (file-disjoint from W2a — dispatch now)
G2  the mode tiles      →  ModePanel fills every slot: preview, tag, blurb, meta      (file-disjoint — dispatch now)
G3  the start-from rail →  StartFromExistingPicker as a card rail with previews       (file-disjoint — dispatch now)
M1  the map, in the kit →  WorldMap + geo utilities, single-select, six footprints    (file-disjoint — dispatch now)
M2  the dialog          →  01 · Targeting gains the map above the chips; G4 chrome    (owns the dialog — AFTER W2(a) merges)
```

G1 → G2/G3 in order (they consume G1's exports); M1 in parallel with all three; M2 last, alone.

### 2.2 What replaces the mockup's animation — per element (D88, D96)

| Mockup | Loop? | Disposition |
|---|---|---|
| Motion tile's three-frame cross-fade (`cycstep`) | yes | **static stack** — the three `pA/pB/pC` skeletons drawn overlapping, offset |
| Scrub playhead sweep (`sweep`) | yes | **static scrub** — head at ~30 %, two tick marks |
| Map hub ripple (`pingring`) | yes | **dropped** — the hub dot stays, solid |
| Arc draw-in (`stroke-dashoffset` transition on `.on`) | no | **deferred to D95** — arcs join two selected hubs, and single-select never has two; permitted motion, but dead code today |
| Dot-matrix reveal (per-dot `transition-delay` from the hub) | no | **kept** — same |
| Tile preview dim/undim (`opacity`/`saturate` transition) | no | **kept** — already in `OptionTile` |
| Check badge `check-pop` | no | **kept** — already exempt |

### 2.3 The vocabulary, mapped to footprints (D94)

The six values stay. Each gets a footprint composed from the mockup's polygons, with the two gaps
in F5 drawn new:

| Value | Footprint | Hub |
|---|---|---|
| `GLOBAL` | every landmass | none — the label sits at the map's centre |
| `EU` | `EUR` + `SCAN` (coarse: the continental bloc plus the Nordics) | the mockup's `emea` hub |
| `DE` | **new** Germany polygon inside `EUR` | its centroid |
| `UK` | the mockup's `UK` polygon (not `IRL`) | its centroid |
| `US` | **new** contiguous-states polygon inside `NA` | the mockup's `na` hub |
| `APAC` | `ASIA` + `J1` + `J2` + `TWN` + `PHI` + `SUM` + `JAV` + `BOR` + `SUL` + `NG` + `SLK` + `AUS` + `TAS` + `NZN` + `NZS` | the mockup's `apac` hub |
| `Other…` | **no footprint** — the chip alone; while Other is active the map shows no selection | — |

Single-select means no arcs *between* regions (there is only ever one hub); the arc code is **not
ported** — it would be unreachable, and unreachable code is red under the coverage gate. D95's lane
ports it with the `multiple` mode it needs.

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **G1** | **Kit previews** (**D93**, F3). *(1)* **`PosterFrame`** — a frame at one of the domain's three ratios (`1:1`, `9:16`, `16:9` — union-keyed like `RatioFrame`, so a fourth is a compile error; the mockup's `4:5` "feed" poster is a ratio the compositor never renders and D26 refuses) holding the mockup's layered skeleton: image block, headline bar, subhead bar, CTA chip in `brand-primary`; three layout variants (`pA` image-top, `pB` image-left, `pC` centred). Token fills only, `aria-hidden`, sized by the caller. *(2)* **`PreviewPanel`** — the `.pvbox`: full-width, `bg-background`, `border-b border-border`, rounded top, `children` centred, optional mono `caption` bottom-right, and a `dimmed` prop for the unselected treatment (`opacity-[0.55] saturate-[0.45]`, transition not loop). *(3)* **`OptionTile` gains a `preview?: ReactNode` slot rendered edge-to-edge above the body**, with the padding moved onto the body — F3. The existing `children` picture slot is kept for callers that do not want a panel. Every existing `OptionTile` test passes unedited; the raw-value name contract is untouched. *(4)* **Static motion previews**: a `PosterStack` (three frames overlapping, offset) and a `ScrubBar` (track, head at ~30 %, two ticks) — the §2.2 replacements, finally built. Tests: every prop's present/absent pair; a test that no `animate-*` class appears on any of these. | `ui/poster-frame.tsx`, `ui/preview-panel.tsx`, `ui/poster-stack.tsx`, `ui/scrub-bar.tsx` (all new), `ui/option-tile.tsx`, `ui/index.ts`, their tests | The pictures the previous plan promised. |
| **G2** | **The mode tiles, filled** (F1). `ModePanel` passes everything: `preview` = a `PreviewPanel` holding the mode's picture — Classic: one `PosterFrame` repeated (a tidy 2×3 of the same layout); Randomized: six frames across the three variants — with caption `6 creatives` / `6 variations`; `tag` = a short uppercase mono word per mode; `blurb` = one sentence saying what the mode produces; `meta` = the display name as today. **`ModePanel` gains a `compact` prop** (the `SectionShell` idiom): the create dialog renders the full preview panel; `BriefEditor`'s 320 px sidebar (`:749`) passes `compact` and keeps the 46 px glyph — a 132 px panel at ~150 px per tile is not the context D93 was decided for. **Strings go in `messages.ts`** (jargon gate: no `axis`, no `appl`, no `launch`, no raw ids). The two pinned assertions (`ModePanel.test.tsx` raw-value names + `Classic`/`Randomized` in `textContent`) survive unedited. | `campaign/ModePanel.tsx`, `campaign/messages.ts` (append only), `campaign/__tests__/ModePanel.test.tsx` | The tiles the screenshot was missing. |
| **G3** | **The start-from rail** (C3, resolved as "adopt the affordance, refuse the name"). `StartFromExistingPicker` becomes a horizontal rail of `OptionTile`s: the blank card first (a `PreviewPanel` of three dashed empty frames, as the mockup's Blank), then one card per brief with a `PreviewPanel` of `PosterFrame`s at the brief's ratios, `name` = the id (mono, as today), `meta` = `startFromRowMeta(products, treatments, region)` unchanged, and a `tag` reading the mode. Keyboard-reachable, `overflow-x-auto`, no scroll-snap. The word *template* appears nowhere. Existing loading/empty/error states and their strings unchanged; `aria-pressed` on the selected card as today. | `shell/StartFromExistingPicker.tsx`, `shell/__tests__/StartFromExistingPicker.test.tsx`, `campaign/messages.ts` (append only, own block) | The mockup's rail on the real domain. |
| **M1** | **The world map, in the kit** (**D94**, **D96**, F4, F5). *(1)* **`ui/geo/`**: `chaikin`, `pip`, `polyPath`, the polygon constants and the `REGIONS` table ported verbatim from the mockup, plus the **two new polygons** (F5), each with a unit test. *(2)* **`WorldMap`**: props `footprints: readonly { value; label; polys; hub? }[]`, `value: string \| null`, `onSelect(value)`, `hoverLabel?`. **No `multiple`, no arcs** — D95 adds both; nothing is pre-built for a mode with no consumer. **The a11y model is the mockup's own, and it is decided here, not by the lane:** the SVG is `aria-hidden="true"` — a pointer enhancement bound to the same state as the chips, exactly as every picture in the kit is (`AxisCard`, `CreativeGlyph`, `RatioFrame`); **`ChipGroup` remains the sole accessible and keyboard control.** Two focusable controls for one value would make a screen reader hear six regions *and* six chips. Renders the graticule, one `<g>` per footprint with a pointer `onClick`, the selected footprint painted, the dot matrix revealed from the hub on selection (transition, D96), the solid hub dot, **no ping**. A visually-hidden caption beside the SVG says "or use the chips below". *(3)* **`RegionChip`** — the mockup's chip with a state dot: `label`, `code`, `pressed`, `onToggle`; `aria-pressed`; the dot is `aria-hidden`. Tests: clicking a footprint calls `onSelect` with its value; `value` paints exactly one footprint selected; `null` paints none; the SVG is `aria-hidden` and contains no focusable element; no `animate-*` class anywhere in it. | `ui/geo/*` (new), `ui/world-map.tsx` (new), `ui/region-chip.tsx` (new), `ui/index.ts`, their tests | The map, honest about what it does. |
| **M2** | **The dialog: the map in `01 · Targeting`, and the section chrome** — **after W2(a) merges.** *(1)* The region field becomes `WorldMap` **above** the existing `ChipGroup`, both bound to `targetRegion` — click either, both update; `Other…` stays a chip and clears the map's selection. The map's hint is written against F2: it says the region shapes the generated backgrounds and copy, and **does not say runs dispatch per region**. *(2)* `Eyebrow` group labels with count readouts where the mockup has them (the start-from rail: *`N` campaigns*). *(3)* The existing `Field` error / `JumpStrip` / one-`role="status"` split is untouched; the map adds no live region. Every constraint from the W1 brief still binds (eight singular `getByRole("status")` queries, the seed deep-equal, `container.textContent` free of the slug, region chips named exactly, the resume two-way untouched, W2(a)'s guard untouched). | `shell/CreateCampaignDialog.tsx`, `campaign/messages.ts` (append only), `shell/__tests__/CreateCampaignDialog.test.tsx` | The dialog as the inspiration, minus the two things it lies about. |

**Waves, for `/orchestrate-wave`.**

| Wave | Lanes | Gated on |
|---|---|---|
| **A** | **G1 ‖ M1** | This plan on `main`. Both file-disjoint from `feat/w2a`. |
| **B** | **G2 ‖ G3** | G1 merged (both consume its exports). Still disjoint from `feat/w2a`. |
| **C** | **M2** | W2(a) merged **and** M1 merged. Owns the dialog. |

**Shared seams — and how they actually merge.** `ui/index.ts` (G1 ‖ M1) and `campaign/messages.ts`
(G2 ‖ G3) are each touched by two concurrent lanes. `scripts/merge-prs.sh` auto-resolves conflicts
**only** in its `APPEND_ONLY` list, which today is `session-log.md`, `CHANGELOG.md` and the ports
barrel — so the second merge of each wave would abort. The script reads the list from an
environment variable, so the orchestrator extends it **at merge time, without editing the script**:

```
APPEND_ONLY='^(\.agents/session-log\.md|CHANGELOG\.md|packages/[^/]+/src/application/ports/out/index\.ts|apps/web/src/components/ui/index\.ts|apps/web/src/components/campaign/messages\.ts)$' scripts/merge-prs.sh …
```

The resolver keeps both sides of a conflict hunk in order, which is correct only if both lanes
**append at the end of the file** — hence the rule for the lanes: own block each, appended, a
comment header naming the lane, never an edit to an existing line. The script waits on CI for the
refreshed head, so a bad merge cannot land silently; the orchestrator additionally reads the merged
barrel before that wait.

---

## 4. Definition of Done

For every lane: the full gate green in the lane's worktree (`yarn build && yarn typecheck && yarn lint
&& yarn lint:arch && yarn sync:check && yarn test:cov`, **100 % on all four counters**); a mutation
check per behavioural claim, run and named in the PR body; every new string in `messages.ts` and past
the jargon gate; tokens only, no raw hex, no stock colour, no `--rgb-*`; **no looping animation by
any route** — `globals.css` untouched, no stock `animate-ping` / `animate-bounce` / `animate-pulse`
(D96 names exactly which motion is permitted); house test style, no `jest-dom`; a *Deviations*
section, even if empty.

Per lane:

- **G1**: `OptionTile`'s existing tests pass unedited; the `preview` slot renders outside the body
  padding (assert DOM structure, not pixels); no `animate-*` on any new component (assert by class
  scan).
- **G2**: `ModePanel.test.tsx`'s two pinned assertions pass unedited; both tiles carry `tag`, `blurb`
  and a `PreviewPanel`; `compact` renders no panel (both arms tested); the `CreateCampaignDialog`
  **and `brief-editor`** suites pass unedited.
- **G3**: the blank card is first and `aria-pressed` when nothing is chosen; **its accessible name
  is exactly `messages.startFromExistingBlank`** and each brief card's name is its id, because
  `CreateCampaignDialog.test.tsx:393-395, :460-483` queries them that way — **that suite passes
  unedited**, though G3 does not own it; the three states (loading/empty/error) keep their strings;
  the word `template` is absent from the diff.
- **M1**: `chaikin`/`pip`/`polyPath` unit-tested against the mockup's own numbers (ported constants
  are the fixtures); the six footprints each select; `Other` has none; **the SVG is `aria-hidden`
  with no focusable descendant — the chips remain the keyboard path**; no `multiple`, no arc code;
  the SVG contains no `animate-*`.
- **M2**: the map and the chips are one control (set via map → chip pressed; set via chip → footprint
  selected; `Other…` → no footprint); the hint does **not** contain "dispatch"; the eight singular
  `role="status"` assertions still pass; `briefs/sample-*` untouched (no schema change, D94).

---

## 5. Deferred — each with the decision it waits on

| What | Waits on |
|---|---|
| Multi-select regions, `targetRegion: string[]`, the eight-layer change, the YAML migration, arcs between regions | **D95** — what a second region *means* for generation. `WorldMap` takes `multiple` so nothing is rewritten when it lands. |
| The campaign-ID readout with `regen` | **D65** stands; **D64** still open. Unchanged from C1. |
| Assets at create (C4), format tiles (C5), the estimate line (C6) | unchanged from the previous plan. |
| The mockup's `probe: ffmpeg → found` line under the tiles | belongs with C5; a probe readout beside *mode* tiles would describe a control that is not there. |

---

## 6. Open questions

1. **What is the tag word per mode?** The mockup's are `STILLS` / `CLIPS` — *format* words. For mode
   the honest pair is nearer *one design* / *a set*; G2 chooses within the jargon gate, and the owner
   may rename after seeing it.
2. **`EU` as `EUR + SCAN`** is coarse (it paints Switzerland and Norway). Acceptable at picker grain,
   or redraw? The plan says acceptable — a picker, not an atlas — but it is the kind of thing a
   stakeholder notices.
3. **Does the brief editor's Identity step also get the map?** M2 puts it in the dialog only; the
   editor's `ChipGroup` is the same control and could take it in a follow-up. Not in this plan.

---

## 7. Corrections this plan records

- **"The styling was constrained by DESIGN.md."** It was not, and this plan's author let that
  impression stand. DESIGN.md forbade three loops; the previous plan replaced them with static
  pictures in §2.2 and then briefed no lane to draw them. `OptionTile` shipped with `tag`, `blurb`
  and a picture slot that `ModePanel` never filled. The container was reviewed three times and
  passed; nobody asked whether it had contents. The correction: **a reusable slot is not a
  deliverable until something is in it** — a kit primitive's DoD should include one real consumer.
- **"C2 requires the multi-region domain change."** The previous plan priced C2 as an eight-layer
  type change plus a migration. That priced the wrong thing. The type change is mechanical; what
  nobody had checked is that the region has **no generation semantics beyond a prompt sentence**
  (F2), so "multi-region" has no defined meaning to implement. The map does not need one. The
  question that does — D95 — is the owner's, and genuinely open.
- **"The mockup's map is single-mode."** It is multi-select, and its hint describes per-region run
  dispatch. Neither is true here. The map is adopted; its two claims are not.

- **"§2.3's footprint data carries a `label`."** It did, and that was wrong in this plan's own
  terms: §4 requires every new string to live in `messages.ts` and forbids literals in the kit, and
  a `label` column put `"Germany"`, `"Europe"`, `"United Kingdom"` inside `ui/geo/`. Lane M1 built
  exactly what §2.3 specified; Qodo caught the contradiction on #207. `label` is gone from
  `Footprint`; `labelFor: (value) => string` is a **required** `WorldMap` prop and the consumer
  supplies copy. **The rule this makes explicit: a data table in a plan is a schema, and a schema
  that carries user-facing words has already broken the string rule.**
- **"The G1 brief's `text-muted/18`."** Copied from the mockup's `rgb(…)/.18` without checking
  DESIGN.md:83, which states that arbitrary alphas require bracket syntax. `/18` is not on
  Tailwind's opacity scale, so it emits **no rule at all** — the poster frames' image layer and the
  scrub track rendered invisible while every class-string assertion passed. Corrected on #206, and
  guarded by `apps/web/src/__tests__/tailwind-alpha.test.ts`, which compiles the classes and asserts
  a rule is emitted for each. **A class-string assertion cannot distinguish a generated utility from
  a dead one** — which is precisely the blindness that let the styling ship looking wrong.

---

## 8. Review record

### Waves A and B

| Lane | PR | Fixed | Refuted | Of the fixed, tests that could not fail |
|---|---|---|---|---|
| G1 — kit previews | #206 | 6 | 1 | 3 |
| M1 — world map | #207 | 8 | 1 | 5 |
| G2 — mode tiles | #208 | *(remediating)* | — | — |
| G3 — start-from rail | #209 | *(remediating)* | — | — |

Reviewers: an adversarial `grok-4.6` pass per PR against the branch diff (never the working tree),
plus Qodo, CodeRabbit and PR-Agent. Every finding was verified against the code before action, and
every fix was mutation-proven — by the fixer, and independently re-run by the orchestrator for the
load-bearing ones.

**The finding that best characterises this wave:** M1's `US` polygon. The brief required every
anchor to sit inside `NA`; the lane did that and the test passed — while the northern chord *between*
two valid anchors crossed Hudson Bay. Vertices inside, edge outside. The containment test now samples
interpolated points along each edge. A test can be true of every point it checks and still be false
of the shape.
