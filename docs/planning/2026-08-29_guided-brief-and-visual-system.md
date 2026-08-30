# Guided Brief & Visual System — Architecture & Development Plan

**Date:** 2026-08-29
**Status:** Draft v1.2 (after a CodeRabbit sweep: the step count reconciled, four cross-references corrected, all 246 Appendix A descriptions restored). v1.1 — revised after an independent review by Gemini 3.7 Flash (High) run against the live tree. It re-verified every factual claim in §1 as correct (including reproducing the Tailwind probe independently) and returned **2 blocking · 3 major · 2 minor** findings, all fixed here: the `Header.tsx` collision between two lanes scheduled in parallel; a preview spec that `CreativeGlyph` could not satisfy; `revealSection`'s render-cycle race; five Appendix A rows that contradicted §2.3/§2.4; an undeclared hot file; and two stale task numbers. Draft v1.0: Synthesised from a static HTML inspiration mock supplied by the user: **246 discrete items** (tokens, colours, layout, components, interactions, copy, motion, a11y, data, features, gating) inventoried in four slices, each classified against the live codebase, **19 of them contested by a second adversarial pass** and resolved here. Three codebase maps were written first (editor 69 KB, shell 52 KB, constraints 65 KB). The design panel and plan-authoring agents were lost to a spend limit mid-run; the target design in §3 and the lanes in §4 are authored directly from the verified classification, and **every load-bearing defect claim and the one prescribed fix were re-verified by hand** (see §1).
**Scope:** `apps/web` — the visual token layer, the UI kit, the shell (header/sidebar/overlays) and the `/brief` editor's presentation. `DESIGN.md` — the contract, which this plan finds has drifted from the code. **No brief-schema change, no new API route, no domain change.** Everything the mock implies beyond that boundary is enumerated and deferred in §2.4 and Appendix A.
**Source material:** `inspiration/2026-08-29_brief-wizard.html` — the mock as supplied, committed so this plan's `mock:NNN` line citations stay resolvable.
**Related:** `2026-08-26_unified-campaign-editor.md` (UE-D1–D15, locked), `2026-08-28_graphical-brief-editor.md` (GB-D1–D18, shipped across #93, #94, #95, #106, #109, #110), `2026-08-27_motion-copy-timeline.md` (shipped), `DESIGN.md`, PRs #82, #84, #85, #113, #119, #120, #126.

---

## 0. What this plan answers

> *"I want to use the following html inspiration to update the current brief view. I do not want to take the html verbatim, but rather as stylistically inspirational. Consider all of the features, colors, elements and approaches that this design is taking. It is uncovering some functionality that we have not yet implemented, which should be added to the feature plan. … The left side column features are well laid out, I am open to updating their appearance."*

The mock is an eight-step wizard with a live phone preview. The repo deliberately deleted its step wizard (UE-D1) and then made the surviving long-form `/brief` editor graphical and grade-school-simple (GB-D1–D18). So the plan cannot simply build the mock, and it must not answer "we already did that" either — because the comparison surfaced **three defects and one contract drift in shipped code**, and the single most valuable finding is not a feature at all:

**55 Tailwind utilities that `apps/web/src` already writes render nothing.** Every colour token is an opaque hex, and Tailwind 3.4 silently drops an opacity modifier applied to a `var()` colour. `ErrorPill` has no background. Three of the four `StatusChip` states have no fill or border. The grid's source badges have no tint. `DurationStrip`'s reel has no fill. The secondary `Button` has no hover. `DESIGN.md:59` documents `bg-error/20` as the canonical error class — a class that does not exist in the build. The mock's alpha-heavy palette is what exposed this, and one config change fixes all 55 at once.

## 0.1 Proposed Decisions

Continuing the D-numbering after GB-D18. Prior decisions are cited as **UE-Dn** (2026-08-26) and **GB-Dn** (2026-08-28).

| ID | Decision | Consequence |
|----|----------|-------------|
| **D19** | **Guided is a lens on the sections, not a second editor.** `/brief` gains a presentation choice — **Guided** (one section at a time with step chrome) and **Everything** (today's scroll) — and both render the *same* section components against the *same* reducer, validator and message file. The step index lives in a `useStepNavigation` hook beside `BriefEditor`; `editor-state.ts` never learns it. **Amends UE-D4** ("sections, not steps") to: *steps are a presentation of the same sections.* | No second state tree, no second validator, no second copy source. Every existing editor test keeps passing in Everything mode. The trap this closes: `scrollToSection` is called by `StatusLine` links, `ErrorStrip` chips and `refuseInvalid` (`BriefEditor.tsx:388-393`) against a section that may not be mounted in Guided — so it becomes `revealSection(section)`, which switches the step first and then scrolls. `sectionOrder(mode)` (`sections/index.ts:10-15`) is the one list of steps; Randomized's fifth step is **Variety**, the sidebar panel. |
| **D20** | **Next is never disabled, and a refused Next speaks.** The mock renders Next `disabled` while the step has issues (`mock:972`). Forbidden by **GB-D3** / `DESIGN.md:344-347`. Next stays live; pressing it on an invalid step marks that section attempted, reveals its errors, plays a one-shot `nudge`, and the step footer states the first problem — the exact shape `refuseInvalid` already gives Apply and Save. | The mock's own `go()` refusal path (`mock:1001-1008`) is the behaviour we ship; only its `disabled` attribute and the `readyPulse` **infinite** loop are dropped. Keeps the lesson of #126: a dead verb cannot answer the question pressing it asks. |
| **D21** | **No locked steps. Every navigation surface navigates freely.** The mock locks segments above `maxVisited` (`mock:837`) while its own sidebar rows and Review links bypass that lock. A locked segment is a disabled control whose reason is off-screen. | `maxVisited` survives only as *styling* (which segments read as visited), never as a gate. The segbar, the Sections outline, Review's Edit links, `StatusLine` links and `ErrorStrip` chips all reach any section in any order. |
| **D22** | **The colour tokens gain an alpha channel, and 55 dead classes come alive.** `tokens.css` **keeps its hex values**; `tailwind.config.ts` wraps each colour as `color-mix(in srgb, var(--color-x) calc(<alpha-value> * 100%), transparent)`. **Amends GB-D8**, whose workaround was to add `--color-brand-tint` / `--color-brand-rail` rather than fix the scale. | Verified by probe (§1): `.bg-error/20`, `.border-error/50`, `.ring-brand-primary/25`, `.hover:bg-border/40` all emit, and plain `.bg-error` keeps its `--tw-bg-opacity` path, so nothing that works today breaks. `--color-brand-tint` is **dead code** (0 consumers) and retires; `--color-brand-rail` has one consumer (`OutputSection.tsx:147`) which becomes `border-brand-primary/40`. `tokens.css` stays hex, so `theme.ts`, the `globals.css` scrollbar rules and every `fill="var(--color-…)"` in `PolicySection`/`CreativeGlyph` are untouched — the migration the triplet form would have forced does not happen. **Arbitrary alphas need bracket syntax**: `/8` emits nothing (not a default step), `/[0.08]` does. |
| **D23** | **`--color-text-emphasis`, and `text-white` stops being "the one literal".** 70 `text-white` occurrences across 29 files have no light-theme counterpart. Add `--color-text-emphasis` (`#0f172a` light / `#ffffff` dark). **Amends `DESIGN.md:65-66`.** | Prerequisite for D24: without it, light theme renders white headings on a white ground. |
| **D24** | **Ship a theme toggle, because a complete light palette exists that no user can reach.** `:root` in `tokens.css` is a full light theme; the root layout hard-sets `class="dark"`. Adopt the mock's mechanism: the class on `<html>`, a `localStorage` key, a header `icon-btn`, and `color-scheme` so native controls and scrollbars follow. | Requires D23. `DESIGN.md:11` ("Dark first … light must keep working, but it is not what users see") becomes true rather than aspirational. |
| **D25** | **The Sections outline joins the sidebar, below ModePanel.** The user calls the left column well laid out, so this is additive, not a rearrangement: numbered rows, a current-row inset rail, an `ErrorPill` per row, and a *no issues / N issues* aside. | Reads `sectionOrder(mode)` and collapses `IdentitySection.tsx:40-42`'s inline copy of the section names onto it (**GB-D18**: one vocabulary). Placed **below** the mode panels, not first as the mock has it, because **GB-D4** locks mode as the sidebar's first decision. In Guided it is the primary navigation; in Everything it scroll-spies. |
| **D26** | **The preview shows what the compositor draws, and nothing else.** Adopt the sticky dock (≥1280px) and the mobile mini strip. Content: a `CreativeGlyph` at preview scale inside the selected platform's `PreviewFrame` — layout, tone, brand colour, headline, ratio, and the platform's own `label`. | **Rejected outright:** the engagement rail (`12.4K / 1,203 / 8,741`), the `@handle`, "original sound — …", the Following/For You chrome and the story bars. They are fabricated numbers and invented platform chrome; a preview that shows them lies about what the pipeline produces (`DESIGN.md:186-193`, §1.3). The typewriter (26 ms/char) also goes: the pipeline does not type the headline. |
| **D27** | **Only the four motion-kind previews loop.** The mock adds four more infinite animations — `segFill` on the current segment, `readyPulse` on Next, the story bars, the skeleton `pulse`. All become static states or one-shots. In the same pass, **document the loops the repo already runs** (`animate-spin` in `Button`/`CommandBar`/grid, `animate-pulse` in `ProbeRow`) as a named loading-indicator exemption in `DESIGN.md:101-105`, each requiring a static cue. | The rule stops being narrower on paper than in practice. The current segment is marked by a static tint plus `aria-current="step"` — the sweep carried no information. |
| **D28** | **The step transitions are adopted, one-shot and `motion-safe:`.** `enterR/enterL/exitL/exitR`, the `riseIn` stagger, the check-bubble overshoot, and the press/lift micro-interactions, with tokenised durations and easings. | **Not** the mock's blanket `*` reduced-motion kill-switch (`mock:361`): it would freeze `animate-spin` mid-ring while `Button` has already swapped its label for the spinner. Per-class `motion-safe:` instead. |
| **D29** | **1.5px borders only where the mock has them.** `.opt`, `.pool-card` and `.asset-card` are 1.5px; the mock keeps `.chip` and `.swatch-lg` at 1px. Apply to `AxisCard`, `PlatformCard`, `PreviewCard` and the asset row; `ChipGroup` and `SwatchChip` stay 1px. | Stops a blanket "thicker borders" pass adding a pixel to every chip in the app and shifting the sidebar's layout at 320px. |
| **D30** | **The dirty guard becomes an in-app dialog — after the double-prompt bug is fixed.** `MobileMenu.tsx:33-42` calls `window.confirm` and then `guardedPush`, which confirms **again**: two dialogs on a dirty tab tap, against `DESIGN.md:359-361`. | The fix is one handler and it ships in the P0 lane. `shell-nav.test.tsx:393,399` assert `toHaveBeenCalled()`, which passes with two calls — **the test specifies the bug**; it tightens to `toHaveBeenCalledTimes(1)`. Only then is `window.confirm` replaced by the mock's Stay/Leave dialog, so the replacement cannot hide the count. |
| **D31** | **The estimate becomes visible in both modes.** `EstimatePanel` mounts only inside `PolicySection` (`PolicySection.tsx:420`), i.e. Randomized only, and `plan.post.ts:24` refuses a classic brief with *"not a variation brief"* — so **a classic draft has no deliverables readout anywhere in the editor.** Publish an Estimate accordion through `EditorPanelsProvider`, with the classic count derived from products × ratios × treatments (the formula that today exists only in `CommandBar.tsx:45`). | Satisfies **GB-D6** ("the Estimate is one of the five visible things") for the mode where it was missing. The mock's *"Render window ~N min on <model>"* is **deferred**: no timing data exists to derive it from, and inventing one would be the fabricated-data failure D26 rejects. |
| **D32** | **Generate moves into the header; the grid keeps Execute.** Today the only way to run an applied brief is to navigate to `/grid` and find the CommandBar. Adopt the mock's header Generate: it runs the applied brief and routes to `/grid`, and when nothing is applied it refuses out loud and sends the user to the blocking section — never disabled (D20). | `CommandBar` keeps Regenerate/Execute where the creatives are (`DESIGN.md:1.6`). The verb the user reaches for first stops being three clicks away. |
| **D33** | **`/brief` joins the header tabs.** `TABS` (`Header.tsx:12-15`) lists Grid, Compliance, Export, Runs; the editor is reachable only from the sidebar's *Edit* link or *Create new*. | Add **Brief** with `aria-current`, and route the brand mark home through the same guard. |
| **D34** | **Vibes, directions, sublines, story/carousel/OOH and an included-asset set are a schema plan, not this one.** Each needs a domain change: new `Treatment`/`VariationPolicy` axes with a policy-hash payload change; `CampaignBrief.subline` plus a second compositor text layer and new goldens for every ratio and motion kind; new `PlatformProfile` formats; a brief-level assets collection with `included`/`hero` flags. | What this plan takes is the *idiom* they arrive in — the option-card tile with a thumbnail, a label and a one-line meta — applied to the axes that **do** exist (layout, tone, background, motion kind, format, platform). Each deferred item is listed in Appendix A with its layer and its real cost. Nothing is silently dropped and nothing is invented. |

---

## 1. Context & Current State (verified 2026-08-29)

Facts below were re-verified by hand at `cef5faa`, not taken from the analysis agents.

**The alpha defect (D22).**
- `tailwindcss` is **3.4.19**; `tailwind.config.ts:16-36` maps every colour to a bare `var(--color-*)`; `tokens.css:15-36` stores opaque hex.
- The built stylesheet `apps/web/.next/static/css/app/layout.css` contains `.bg-error{` (×1), `.bg-black\/80` (×1) and `.bg-red-500\/10` (×1) — and **zero** occurrences of `bg-error\/20`, `border-error\/50`, `bg-success\/20` or `bg-brand-primary\/20`. Alpha modifiers work on stock Tailwind colours and are dropped on token colours.
- **55** token-alpha utilities exist in non-test `apps/web/src`. Named victims: `error-pill.tsx:11` (`bg-error/20`), `StatusChip.tsx:27,30,36`, `button.tsx:17` (`hover:bg-border/40`), `ModelSelector.tsx:38`, `duration-strip.tsx:190,202`, and 21 in `app/(shell)/grid/page.tsx`.
- `DESIGN.md:59` lists `bg-error/20` as the canonical error class.
- **The prescribed fix was probed**, not assumed: with `color-mix(in srgb, var(--color-x) calc(<alpha-value> * 100%), transparent)` in the config and the hex token untouched, Tailwind 3.4.19 emits `.bg-error`, `.bg-error\/20`, `.border-error\/50`, `.bg-surface-2\/60`, `.ring-brand-primary\/25` and `.hover\:bg-border\/40:hover`. `/8` emits nothing; `/[0.08]` emits.
- `--color-brand-tint` has **0** consumers in `apps/web/src` (dead since GB-D8 introduced it); `--color-brand-rail` has exactly one (`OutputSection.tsx:147`).

**Defects and drift the comparison surfaced.**
- **Double dirty prompt (D30):** `MobileMenu.tsx:33-42` confirms, then calls `guardedPush`, which confirms again (`use-guarded-navigation.ts:14-21`). `shell-nav.test.tsx:393,399` use `toHaveBeenCalled()`; the correct sibling assertion at `:339` uses `toHaveBeenCalledTimes(1)`.
- **Hardcoded vocabulary (GB-D18):** `Sidebar.tsx:78` is `const aspectsLabel = "1:1, 9:16, 16:9"`. Deriving it from the selected platforms would be *wrong* for classic briefs, which render `AspectRatio.all()` regardless — so it derives from the run's truth per mode, not from platforms.
- **No classic estimate (D31):** `EstimatePanel` is mounted once, at `PolicySection.tsx:420`; `plan.post.ts:24` refuses non-variation briefs.
- **No editor tab (D33):** `Header.tsx:12-15`.
- **`DESIGN.md` drift (D27, D22, D23):** the document describes an `ErrorPill`, `StatusChip` and alpha idiom the code does not implement, and omits eight tokens the code defines.
- **70** `text-white` occurrences across **29** non-test files (D23).

**What already exists and must not be rebuilt.** The touched/attempted error model, `visibleErrors`, `StatusLine`'s progressive sentence, `ErrorStrip`, the floating `FloatingBar` (sticky, scoped to the column), `SaveMenu`, `HeadlinePoolDrawer`, `AssetPickerDrawer`, `LogoField`, `ProbeRow`, `FormatPanel`, `MotionKindPanel`, `RatioPanel`, `DurationStrip`, `TimelineSection`, `ModePanel`, `AxisCard`, `CreativeGlyph`, `ChipGroup`, `SwatchPicker`, `PlatformCard`, `PreviewCard`, `PreviewFrame`, `Disclosure`, `SwitchRow`, `Stepper`, `Slider`, `EditorPanelsProvider`, the dirty guard, the focus-trapped overlays. Of 246 mock items, **40 are already present** and a further **109 are partial** — mostly appearance, not behaviour.

### Guiding principles

1. **One state, two presentations.** If Guided and Everything can disagree about anything, it is a bug in the plan.
2. **Restyle the control; do not re-implement it.** A `partial` item is a class change on an existing component, not a new component.
3. **The preview may only show what the compositor paints.** Anything else is a lie with a brand colour on it.
4. **Fix what the comparison caught in shipped code before adding to it.** A visual lane over a broken alpha scale would be built on sand.
5. **Adopt the idiom, defer the schema.** The mock's cards are worth copying; its vocabulary is not ours to invent.

---

## 2. Analysis

### 2.1 Findings

| # | Sev | Finding | → |
|---|-----|---------|---|
| **C1** | Critical | **55 token-alpha utilities render nothing.** Tailwind 3.4 drops `/NN` on a `var()` colour; `ErrorPill`, three `StatusChip` states, the grid source badges, the `DurationStrip` reel and the secondary `Button` hover are all silently unstyled. `DESIGN.md:59` documents one of the dead classes as canonical. | D22 |
| **C2** | Critical | **A complete light palette is unreachable.** `:root` defines the full light theme; the root layout hard-sets `dark`; no toggle exists; 70 `text-white` sites would break light if it were reachable. | D23, D24 |
| **C3** | Critical | **Double dirty prompt on a mobile tab tap**, and the test that covers it asserts `toHaveBeenCalled()` — it passes with two. | D30 |
| **H1** | High | **A classic draft has no deliverables readout at all**; the estimate is Randomized-only and the API refuses classic. | D31 |
| **H2** | High | **No step/guided presentation exists**, and the mock's version violates two locked rules (disabled Next, locked segments). | D19, D20, D21 |
| **H3** | High | **`scrollToSection` will silently no-op** the moment a section is unmounted by a step view — it is called from three places. | D19 (`revealSection`) |
| **H4** | High | **The mock adds four infinite loops** to a system that allows four, and the repo already runs four undocumented ones. | D27 |
| **H5** | High | **The preview as drawn is fabricated data** — engagement counts, a handle, a sound credit, Story chrome. | D26 |
| **H6** | High | **No preview at all today**: nothing in the editor shows what a creative will look like. | D26 |
| **H7** | High | **The editor is not in the header nav**; Generate is only reachable on `/grid`. | D32, D33 |
| **H8** | High | **Hardcoded aspect-ratio vocabulary** in the sidebar (GB-D18 violation), and the obvious fix is wrong for classic. | Lane W1 |
| **M1** | Med | Card/chip surfaces are visibly plainer than the mock's: 1px borders, 12px mono labels, small checks, no icon tile, no hover lift. | D29, W2b |
| **M2** | Med | No `icon-btn` primitive; header/close/copy buttons are bespoke each time. | W2a |
| **M3** | Med | No global `:focus-visible` ring, no `::selection` colour, no `color-scheme`. | W2a, D24 |
| **M4** | Med | `Input` has no focus halo; two bespoke inputs bypass the component (`BriefSelector.tsx:61-67`, `BriefEditor.tsx:618-624`). | W2a |
| **M5** | Med | No `Skeleton` primitive; three loading states hand-roll one. | W2a |
| **M6** | Med | Section names are duplicated between `sections/index.ts` and `IdentitySection.tsx:40-42`. | D25 |
| **M7** | Med | View titles drift from `DESIGN.md:84` (`text-xl font-bold` / `text-[22px]` vs `text-lg font-semibold`) across five pages. | W1 |
| **M8** | Med | Duration/easing tokens have **zero** `.tsx` consumers; timings are literals. | D28 |
| **L1** | Low | No eyebrow letter-spacing token (14 `tracking-widest` sites); no shared field error/hint primitive (6 bespoke 11px error lines). | W2a |
| **L2** | Low | `DESIGN.md` omits eight tokens the code defines. | D27 doc pass |

### 2.2 The contested classifications, and the calls made here

Nineteen items were disputed by a second pass. The material ones:

| Item | First read | Challenge | **Call** |
|---|---|---|---|
| **TOK-01** colour encoding | Re-encode all 13 tokens as RGB triplets; migrate every raw consumer | `color-mix` with `<alpha-value>` fixes it in `tailwind.config.ts` alone, hex tokens untouched — probe-backed | **Challenge accepted.** I re-ran the probe myself (§1). Effort M→S; `theme.ts`, the scrollbar rules and every SVG `fill` are spared. |
| **TOK-02** StatusChip colours | Map `yellow-400` → `warning` | That collapses two of **UE-D11**'s four colour-distinct states onto one hue | **Challenge accepted.** The stock literal goes, but the fourth state gets its own token rather than sharing `warning`. |
| **TOK-18** 1.5px borders | Six sites incl. chips and swatches | The mock keeps chips and swatches at 1px; a blanket pass shifts the 320px sidebar | **Challenge accepted** → D29. |
| **TOK-60** Sections outline | Place it first in the sidebar | **GB-D4** locks mode first; and `sectionOrder(mode)` already exists to drive it | **Challenge accepted** → D25 (below ModePanel, reusing the existing list). |
| **TOK-63** checkbox accent | "present, adopt" | There is **no** `type="checkbox"` in `apps/web/src`; `accent-brand-primary` appears once, on a `range` | **Challenge accepted.** Reclassified: not present, and not adoptable without the assets-collection schema change (D34). |
| **SHELL-20** Estimate | web+api | Placement is UI-only; only the per-model render time needs an API | **Challenge accepted** → D31 splits them; the time figure is deferred. |
| **SHELL-22** Aspects readout | Derive from platforms | Wrong for classic — the use case renders `AspectRatio.all()` regardless | **Challenge accepted**; derive per mode from the run's truth. |
| **SHELL-25/29** dirty guard | "present, no conflict" | The mobile path stacks a second `confirm`; the test cannot catch it | **Challenge accepted** → D30, and it ships in the P0 lane. |
| **TOK-11** motion tokens | Tokenise all timings incl. a blanket reduced-motion rule | The `*` kill-switch would freeze `animate-spin` mid-ring; `CAPABILITIES_RETRY_MS` is a network retry, not a motion timing | **Challenge accepted** → D28 (per-class `motion-safe:`), and D27 documents the loading exemption. |

### 2.3 What is **not** taken from the inspiration

- **The disabled Next button** and the `readyPulse` loop attached to it (GB-D3, `DESIGN.md:344-347`) — D20.
- **Locked progress segments** above `maxVisited`, which the mock's own links bypass — D21.
- **The fabricated preview**: engagement rail, `@handle`, sound credit, Following/For You chrome, Story bars, typewriter — D26.
- **`Save & apply` that persists an invalid draft** as *"Saved with issues — not applied"*: it reopens the exact save-but-not-applied triangle **UE-D3** closed, and would need a server-side draft store to exist at all.
- **The ungated inline error** on step 4 (red before the field is touched) — GB-D1 and the "blank brief = zero red" DoD.
- **The simulated `dooh` probe** and the OOH/story/carousel ad types: no such capability, profile or format exists; the gating *pattern* (`formatGate` + `ProbeRow`) is already the template if one ever lands.
- **Auto-advance after a colour tap.** Colour is a per-product swatch here, not a step; auto-advancing a multi-select axis is wrong, and surprising navigation is worse than a tap.
- **Moving the sidebar's DOM into the mobile menu** (`appendChild`): a vanilla single-instance trick. The repo shares `SidebarContent` by rendering it, which is the React answer.
- **Delegated click listeners with a precedence table** on one `#stage` container: a mock implementation detail. The one rule worth carrying is *no nested interactive elements inside a toggle card*.
- **Confetti on Apply.** A one-shot, so the motion budget permits it — but `DESIGN.md:1.3` is explicit that this is a review console: "no hero areas, no marketing rhythm". Raised as **Q3** rather than decided, since it is three lines if wanted.
- **The mock's copy where ours is already better**: the motion/platform gate message derives its platform names from `PLATFORM_PROFILES`; the mock hard-codes "TikTok, Instagram Reel or Story, or YouTube" — the copied vocabulary GB-D18 forbids.

### 2.4 What the mock implies beyond this plan's boundary

Each needs a domain or API change and is deferred with its cost, not rejected:

| Feature | Needs | Cost |
|---|---|---|
| Vibes (PLAYFUL, PREMIUM, WARM, MINIMAL, TECHNICAL) | `TONE_VALUES` + policy-hash payload | Every stored `policyHash` changes; goldens re-pin |
| Look & feel directions (minimal/graphic/editorial/texture) | A new `Treatment` axis + a compositor style layer | New axis in the distance metric, hash payload, goldens |
| Subline | `CampaignBrief.subline?` + a second text layer | Parser, VO, `layoutHeadline`, goldens for every ratio × motion kind |
| Story / Carousel / Wide (OOH) ad types | New `PlatformFormat`s and profiles | Packaging, safe insets, capability probe |
| Included-asset set with a hero flag | A brief-level assets collection | Parser, VO, Save-as asset copy, compositor |
| Run states (executed / in review / draft) and `updatedAt` in the picker | `StoredBrief` fields + per-asset decisions | Listing route, run history join |
| "Render window ~N min on `<model>`" | Timing telemetry | No data source exists today |

---

## 3. Target Design

### 3.1 The first run, in Guided

She lands on `/brief/new`. The sidebar shows **Classic / Randomized** as two pictures, then **Sections** — five numbered rows, `01 Identity` lit with a brand rail, no pills anywhere. The main column has a sticky head: `STEP 1 OF 6`, **Identity**, *"Name the campaign and say who it is for."*, the status chip, and a six-segment bar with the first segment tinted. The card below holds the campaign name, the derived id in mono, the region chips and the audience field. The footer reads *"Looking good."* and offers **Next**.

At ≥1280px a dock sits to the right: a `CreativeGlyph` in a 1:1 frame, in the product's colour, captioned *"Square · no platform yet"*. As she types a headline the glyph's text bars take it. Below 1280px the same information is one strip: swatch · name · headline · `1/5`.

She taps **Next** with the audience empty. Nothing is disabled: the section turns attempted, one red line appears under Audience, `01 Identity` grows a `1` pill, the segment reads amber, the footer says *"No audience yet — say who the ads are for, like urban outdoor enthusiasts, 25-40"*, and Next shakes once. She fills it in; the pill and the red both clear; Next carries a single ring pulse and she moves on.

At **05 Output** she taps *Instagram Feed* and *Instagram Story*. The dock reframes to 9:16 and captions *"Tall · Instagram Story"*. The probe row says ffmpeg was found. She reaches **Review**: the dock on the left, the draft as summary rows on the right, each with an **Edit** link straight to its step, and the same **Discard / Save ▾ / Apply to run** bar the long-form editor has always had. She never opened Advanced, and she never saw a red field she had not visited.

### 3.2 Sidebar (top to bottom)

`ModePanel` ×2 (GB-D4, unchanged) · **Sections** outline (D25) · **Campaign Brief** read-only accordion (Aspects derived per mode, D-fix) · **Project Bin** (real assets, unchanged) · **Variety** (Randomized only, unchanged) · **Estimate** (D31, both modes) · footer *Create new* / *Browse briefs* (pinned, unchanged).

### 3.3 Main column

**Steps are `sectionOrder(mode)` plus Review — six in both modes.** The five sections are what the outline numbers (`01`–`05`); **Review is the sixth step and is not a section**: it has no fields, no error keys and no outline row, because it is where the draft is launched rather than edited. So the counter reads `STEP n OF 6`, the segbar has six segments, and the outline has five numbered rows. Randomized's `05` is **Variety** (Q2), Classic's `04` is Treatments.

**Guided:** sticky head (step count eyebrow · `h1` with `tabindex="-1"` for focus handoff · subtitle · `StatusChip`) · segbar · one section as a step card · footer (step status sentence · Back · Next / *Review & launch*) · the `FloatingBar` only on Review.
**Everything:** today's layout, plus the segbar as a section-progress readout and the outline scroll-spying.
The presentation choice persists per user in `localStorage`; **Everything** is the default for a loaded brief, **Guided** for `/brief/new`.

### 3.4 Preview (D26)

`PreviewDock` (sticky, ≥1280px) and `PreviewStrip` (below), both rendering a **new** `CreativePreview`.

`CreativeGlyph` cannot be reused directly and is **not** modified: its props are `{layout?, tone?, motion?, size?}`, its `viewBox` is a hardcoded 46 × 46 square, its accent is `fill-brand-primary` (the *brand* token, not a product colour), and its "headline" is two static `<rect>` bars (`creative-glyph.tsx:8-13, 24, 103, 109-110`). It is deliberately a 46 px miniature pinned to the axis cards' accessible-name and screenshot contracts, and widening it would put the cards at risk for the preview's benefit.

`CreativePreview` is therefore its own component that **re-implements the same documented layer order** (`DESIGN.md` §4: photo ground → contrast shade on the headline edge → accent band flush to that edge → the copy), at preview scale, taking `{ratio, layout, tone, primaryColor, headline, motion?}`:
- **ratio** drives a real `viewBox` per `RATIO_VALUES`, so 9:16 is tall rather than a square letterboxed — every layer coordinate is a fraction of the box, not a constant.
- **primaryColor** is the first product's hex, passed as a `--c` custom property (the mock's technique), so the band and shade are the product's colour, not the brand blue.
- **headline** is rendered as real text with `textLength`/wrapping, not bars.
- **motion** replays the selected kind's existing one-shot keyframe.
A shared `previewLayers.ts` holds the fractions both it and `CreativeGlyph` use, so the two cannot drift from each other or from the compositor. Caption: `<ratio display name> · <PlatformProfile.label>`, or `<ratio display name> · no platform yet`.

### 3.5 New primitives

`IconButton` · `Skeleton` · `Eyebrow` · `FieldLine` (error/hint) · `SectionOutline` · `StepHeader` · `SegBar` · `StepFooter` · `CreativePreview` · `PreviewDock` / `PreviewStrip` · `ThemeToggle` · `ConfirmDialog` (in-app dirty guard) · `useStepNavigation` · `revealSection`.

### 3.6 Tokens & CSS

`tailwind.config.ts`: every colour → `color-mix(… <alpha-value> …)` (D22); `letterSpacing.eyebrow: 0.08em`; keyframes `enter-r/enter-l/exit-l/exit-r/rise-in/nudge/ready-ring/check-pop`.
`tokens.css`: **stays hex**; adds `--color-text-emphasis`, `--color-scrim`, `--easing-overshoot`; retires `--color-brand-tint`, `--color-brand-rail`.
`globals.css`: `:focus-visible` ring, `::selection` (via `color-mix` on the primary token), `color-scheme` per theme, the one-shot keyframes, `motion-safe:` guards.

---

## 4. Work Breakdown

**Merge order:** **(W0 ‖ W1) → W0b → W2a → W2b → ((W3 → W5) ‖ W4) → W6 → W7 → W8 → W9 → W10.**
W0 first because every later visual lane assumes `/NN` works, and W0b lands the sweep before anything is restyled on top of it. W1 is independent bug-fixing and ships alongside. W3/W4/W5 are disjoint (theme / sidebar / header). W6–W8 share `BriefEditor.tsx` and merge in order. **Hot files:** `tailwind.config.ts` (W0 only) · `DESIGN.md` (append-only, every lane) · `messages.ts` (append-only, W5/W6/W8/W9) · **`Header.tsx` (W3 then W5 — this is why they are not parallel)** · **`BriefEditor.tsx` (W4 publish-only, then W6, W7, W8, W9 — sequential)** · `Sidebar.tsx` (**W1** for the Aspects readout, then W4).
**Cross-lane gate:** every new error or status key must be registered in `error-sections.ts` and covered by the visibility filter, or GB-D1 regresses; W6 extends the existing coverage test to the step→section map so a section with no step is a test failure.

### W0 — the alpha scale and the contract (P0, ships first)

| # | Task | Owns |
|---|------|------|
| W0.1 | `tailwind.config.ts`: every colour → `color-mix(in srgb, var(--color-x) calc(<alpha-value> * 100%), transparent)`; `--color-brand-primary-hover` stays a full colour, mapped without alpha | `tailwind.config.ts` |
| W0.2 | Add `--color-text-emphasis`, `--color-scrim`; retire `--color-brand-tint` (dead) and `--color-brand-rail` (`OutputSection.tsx:147` → `border-brand-primary/40`) | `tokens.css`, `OutputSection.tsx` (one class) |
| W0.3 | **Build-output test**: a test that compiles the Tailwind config and asserts `bg-error/20`, `border-error/50`, `ring-brand-primary/25` and `hover:bg-border/40` all emit a rule — the assertion that would have caught C1 | `__tests__/tailwind-alpha.test.ts` |
| W0.4 | `DESIGN.md`: §2 alpha idiom, the eight undocumented tokens, the `ErrorPill`/`StatusChip` descriptions corrected to the code, the loading-indicator loop exemption (D27) | `DESIGN.md` |

W0 is four files. The **sweep** it enables is deliberately not in it — 35 files in the lane that changes the scale would bury the one change worth reviewing closely:

### W0b — the sweep (immediately after W0)

| # | Task | Owns |
|---|------|------|
| W0b.1 | Replace non-step alphas with bracket syntax (`/8` → `/[0.08]`) across the 55 revived utilities | the named component files |
| W0b.2 | Retire the stock-colour literals: `ErrorStrip`'s `red-500/NN` and the six other `DESIGN.md §1.1` violators onto tokens | those components |
| W0b.3 | `text-white` → `text-text-emphasis`, 70 occurrences in 29 files — mechanical, reviewed as one diff | those components |
| W0b.4 | Screenshot pass over each named victim in both themes; anything that now looks wrong is fixed here, not later | notes → PR body |

### W1 — defects the comparison caught (P0, parallel with W0)

| # | Task | Owns |
|---|------|------|
| W1.1 | `MobileMenu.handleTabClick`: drop the inner `window.confirm`, let `guardedPush` own the prompt; tighten `shell-nav.test.tsx:393,399` to `toHaveBeenCalledTimes(1)` | `MobileMenu.tsx`, `shell-nav.test.tsx` |
| W1.2 | `Sidebar.tsx:78`: derive Aspects per mode — classic `RATIO_VALUES`, Randomized `variation.axes.ratio ?? RATIO_VALUES` — never from platforms | `Sidebar.tsx` |
| W1.3 | Normalise the five drifted view titles to `DESIGN.md:84` (`text-lg font-semibold`) and add the eyebrow/meta pattern | `compliance/`, `export/`, `runs/`, `grid/page.tsx` (titles only) |
| W1.4 | `aria-current="page"` on the active mobile menu tab | `MobileMenu.tsx` |

### W2a — kit primitives

| # | Task | Owns |
|---|------|------|
| W2a.1 | `IconButton` (32px grid, muted → primary on hover); migrate the header, dialog closes and the slug copy button | `ui/icon-button.tsx`, `Header.tsx`, overlays |
| W2a.2 | `Skeleton` (static by default, `aria-hidden`, caller pairs a `role="status"` sentence); adopt in the pool drawer and telemetry | `ui/skeleton.tsx`, `HeadlinePoolDrawer.tsx`, `TelemetryDrawer.tsx` |
| W2a.3 | Globals: `:focus-visible` ring, `::selection` via `color-mix`, scrollbar tokens | `globals.css` |
| W2a.4 | `Input` focus halo (`ring-brand-primary/25`); fold both bespoke inputs into it | `ui/input.tsx`, `BriefSelector.tsx`, `BriefEditor.tsx` (Save-as) |
| W2a.5 | `Eyebrow` + `letterSpacing.eyebrow`; migrate the 14 mono-uppercase sites | `ui/eyebrow.tsx`, `tailwind.config.ts` (one key), call sites |
| W2a.6 | `FieldLine` for error/hint; migrate the six bespoke 11px error lines | `ui/field-line.tsx`, `OutputSection.tsx`, `PolicySection.tsx` |

### W2b — card and chip surfaces (D29)

| # | Task | Owns |
|---|------|------|
| W2b.1 | `AxisCard`: 1.5px border, icon/glyph tile that inverts when pressed, 22px badge check with `check-pop` overshoot, 15px/700 label, `aria-hidden` meta line — **accessible name stays the raw value** | `ui/axis-card.tsx` |
| W2b.2 | Same treatment for `PlatformCard`, `PreviewCard` and the `AssetPickerDrawer` row; `ChipGroup`/`SwatchChip` stay 1px | `ui/platform-card.tsx`, `ui/preview-card.tsx`, `AssetPickerDrawer.tsx` |
| W2b.3 | `SwatchPicker` size prop (52px in a step card), ring selection, ninth *custom* swatch over a labelled visually-hidden `<input type="color">` — palette and `aria-label={hex}` unchanged | `ui/swatch-picker.tsx` |
| W2b.4 | `motion-safe:` press/lift micro-interactions; `riseIn` stagger on option lists (one-shot) | `globals.css`, the card components |
| W2b.5 | Tests: the four card components keep their accessible names; reduced-motion renders no animation | `ui/__tests__/` |

### W3 — the theme toggle (D23, D24)

| # | Task | Owns |
|---|------|------|
| W3.1 | `ThemeToggle` in the header; class on `<html>`; `localStorage`; `color-scheme` per theme; no-flash inline script in the root layout | `ui/theme-toggle.tsx`, `app/layout.tsx`, `Header.tsx` |
| W3.2 | Light-theme audit of every surface touched by W0/W2 (contrast, `text-emphasis`, the revived tints) | audit notes → `DESIGN.md` |
| W3.3 | Tests: toggle round-trips, a blocked/absent `localStorage` reads as dark and never throws | `__tests__/` |

### W4 — the sidebar outline and the estimate (D25, D31)

| # | Task | Owns |
|---|------|------|
| W4.1 | `SectionOutline`: numbered rows from `sectionOrder(mode)`, current-row rail, `ErrorPill`, *no issues / N issues* aside; delete `IdentitySection.tsx:40-42`'s copy | `ui/section-outline.tsx`, `Sidebar.tsx`, `sections/index.ts` |
| W4.2 | Rows call `revealSection` so they work in both presentations | `Sidebar.tsx` |
| W4.3 | Estimate accordion published via `EditorPanelsProvider`; classic count from products × ratios × treatments, reusing `CommandBar`'s formula extracted to `derive.ts` | `EstimatePanel.tsx`, `derive.ts`, `BriefEditor.tsx` (publish only), `CommandBar.tsx` (import) |
| W4.4 | Tests: outline pills track `visibleErrors`; classic shows a count where it previously showed nothing | `__tests__/` |

### W5 — the header (D32, D33)

| # | Task | Owns |
|---|------|------|
| W5.1 | Add the **Brief** tab with `aria-current`; brand mark routes home through the guard | `Header.tsx` |
| W5.2 | Header **Generate**: runs the applied brief and routes to `/grid`; with nothing applied it refuses out loud and reveals the blocking section — never disabled | `Header.tsx`, `run-context.tsx` (reuse `execute`), `messages.ts` |
| W5.3 | Telemetry `IconButton` in the header opening the existing **non-modal right drawer** (not a dialog, and it never trips the dirty guard — it changes no draft state); model-change feedback line | `Header.tsx`, `ModelSelector.tsx` |
| W5.4 | Tests: Generate with no applied brief refuses and navigates to the section, not to `/grid` | `__tests__/` |

### W6 — Guided, part 1: the engine (D19, D20, D21)

| # | Task | Owns |
|---|------|------|
| W6.1 | `useStepNavigation(steps)` where `steps = [...sectionOrder(mode), "review"]` — **six**, and the one place the count is derived: index, direction, `maxVisited` (styling only), range guard, `go(n)` | `lib/use-step-navigation.ts` |
| W6.2 | `revealSection(section)` replaces `scrollToSection` at all three call sites. **It cannot scroll synchronously:** in Guided the target section is unmounted until the step state commits, so `document.querySelector` would miss it. Switch the step, store the target in a `pendingReveal` ref, and scroll from a `useLayoutEffect` that fires once the step card has mounted — then clear the ref. In Everything it scrolls immediately, as today | `lib/scroll-to-section.ts`, `BriefEditor.tsx`, `StatusLine.tsx`, `ErrorStrip.tsx` |
| W6.3 | Presentation toggle (Guided / Everything), persisted; Everything is the default for a loaded brief | `BriefEditor.tsx` |
| W6.4 | `StepHeader` (eyebrow · `h1 tabindex="-1"` focus handoff · subtitle · `StatusChip`), sticky, scoped to the column | `campaign/StepHeader.tsx` |
| W6.5 | `StepFooter`: step status sentence (`role="status"`), Back, **Next always live**; a refused Next marks attempted, reveals, nudges once, states the first issue | `campaign/StepFooter.tsx` |
| W6.6 | Step subtitles and footer strings → `messages.ts`; jargon test extended | `messages.ts` |
| W6.7 | Extend the error-key coverage test to totality **in both directions**: every section in `sectionOrder(mode)` has a step, and every step except `review` is a section — so adding a section without a step, or a step with no section and no explicit exemption, fails | `__tests__/` |
| W6.8 | Tests: Guided renders one section; Next never has `disabled`; a refused Next reveals exactly that section's errors; **an `ErrorStrip` chip for an unmounted section switches step and *then* scrolls — asserted by spying on the scroll after the step commits, which fails against a synchronous implementation** | `__tests__/` |

### W7 — Guided, part 2: the segbar and the transitions (D27, D28)

| # | Task | Owns |
|---|------|------|
| W7.1 | `SegBar`: one segment per **step** (six — sections plus Review, from W6.1's list, never a literal), states done/attempted-with-issues/current/unvisited, `aria-current="step"`, per-segment `aria-label`, **no lock**, hover `scaleY` under `motion-safe:` | `ui/seg-bar.tsx` |
| W7.2 | Step-card `enter/exit` by direction, one-shot, `motion-safe:`; the outgoing card absolutely positioned during exit | `globals.css`, `BriefEditor.tsx` |
| W7.3 | Swipe (60px, 1.4 ratio) and Arrow Left/Right, suppressed inside inputs and while an overlay is open; swipe hint on coarse pointers | `lib/use-step-navigation.ts`, `StepFooter.tsx` |
| W7.4 | `nudge` one-shot; `ready-ring` one-shot on becoming valid (never a loop) | `globals.css` |
| W7.5 | Tests: reduced-motion renders no transition; keyboard nav is inert inside a text field and while a dialog is open | `__tests__/` |

### W8 — Guided, part 3: Review

| # | Task | Owns |
|---|------|------|
| W8.1 | Review step: preview beside summary rows generated from the same `toBrief` projection, each row with an **Edit** link calling `revealSection` | `campaign/ReviewStep.tsx` |
| W8.2 | The existing `FloatingBar` (StatusLine · ErrorStrip · Discard · Save ▾ · Apply · ⋯) renders on Review in Guided and at the foot in Everything — one component, two placements | `BriefEditor.tsx` |
| W8.3 | Loading a brief opens Review; `Create new` opens step 1 | `BriefEditor.tsx` |
| W8.4 | Tests: every summary row's Edit reaches its section; Apply's refusal marks every failing section and reveals the first | `__tests__/` |

### W9 — the preview (D26)

| # | Task | Owns |
|---|------|------|
| W9.1 | Extract `previewLayers.ts` (the layer fractions `CreativeGlyph` hardcodes) and refactor `CreativeGlyph` onto it with **no prop or output change** — a byte-comparison test against its current render is the gate | `ui/preview-layers.ts`, `ui/creative-glyph.tsx` |
| W9.1b | `CreativePreview({ratio, layout, tone, primaryColor, headline, motion?})`: real `viewBox` per ratio, product colour via `--c`, real text; caption from `ratioDisplayName` + `PlatformProfile.label` | `campaign/CreativePreview.tsx` |
| W9.2 | `PreviewDock` (sticky ≥1280px) and `PreviewStrip` (below): swatch · name · headline · step | `campaign/PreviewDock.tsx` |
| W9.3 | Motion drafts play the selected kind's existing one-shot transition; no typewriter, no story bars, no engagement chrome | `CreativePreview.tsx` |
| W9.4 | Tests: the preview renders no text the brief does not contain (a fabrication guard); ratio follows the platform; reduced-motion is static | `__tests__/` |

### W10 — step-content polish

| # | Task | Owns |
|---|------|------|
| W10.1 | Headline: inline pool suggestion cards with char counts above the input, *More ideas* opening the existing drawer | `CopySection.tsx` |
| W10.2 | Asset rows: brand-tinted type icon, `TYPE · size` meta, `Choose from bin` wired from `LogoField` | `LogoField.tsx`, `ProductsSection.tsx` |
| W10.3 | In-app `ConfirmDialog` replaces `window.confirm` for the dirty guard (after W1.1) | `ui/confirm-dialog.tsx`, `use-guarded-navigation.ts` |
| W10.4 | `mini-chip` state pill, `empty-note` pattern, table typography per `DESIGN.md:88` | `ui/`, view pages |
| W10.5 | Dialog head/body/foot anatomy shared across the four overlays | overlay components |

---

## 5. Definition of Done

- **The alpha scale is proven, not assumed.** `W0.3`'s test compiles the config and fails if `bg-error/20`, `border-error/50`, `ring-brand-primary/25` or `hover:bg-border/40` emits no rule. A grep of the built CSS for `.bg-error\/20` returns a hit.
- **No stock Tailwind colour and no `text-white` remains** in non-test `apps/web/src` (grep, both zero).
- **Light theme is reachable and legible**: the toggle round-trips, a blocked `localStorage` reads as dark without throwing, and every surface W0/W2 touched has been audited in both themes.
- **One prompt, ever.** `shell-nav.test.tsx` asserts `toHaveBeenCalledTimes(1)` on every dirty-navigation path.
- **A classic draft shows a deliverables count** in the sidebar Estimate — the state that previously showed nothing.
- **Blank brief = zero red**, in both presentations: no `text-error` element, no pill, no strip chip, and the *New brief —* sentence.
- **No verb is ever `disabled` for invalidity.** A test asserts `disabled` is absent from Next, Apply, Save and header Generate on an invalid draft, and that pressing each reveals errors and speaks a refusal.
- **Every navigation surface reaches every section**: a test walks the outline rows, the segbar segments, the Review Edit links, the StatusLine links and the ErrorStrip chips, and asserts each mounts its target section in Guided.
- **The step→section map is total**: the coverage test fails if `sectionOrder(mode)` gains a section with no step.
- **The preview cannot fabricate**: a test renders a brief and asserts the preview's text content is a subset of the brief's own strings plus the domain's display names.
- **Accessible names are unchanged**: `getByRole("button", { name: "headline-top" | "bold" | "1:1" | "static" | "motion" | "ken-burns-in" | "#1473E6" })` and the platform ids all still resolve after the card re-skin.
- **Exactly four looping animations remain** in `globals.css` (the motion kinds), plus the documented loading indicators, each with a static cue. Reduced motion renders no step transition, no stagger, no nudge, no ring.
- **No existing brief changes behaviour**: every `briefs/*.yaml` loads, round-trips through a platform toggle-and-untoggle, and serialises byte-identically; `axisProductSize` and `policyHash` unchanged.
- **Gate**: `build`, `typecheck`, `lint` 0 problems, `lint:arch`, `sync:check` 0 ops, `test:cov` 100% on all four counters. No test deleted without a stated reason in its PR.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **W0 makes 55 previously invisible tints appear at once.** Some will look wrong. | W0 is its own PR with a screenshot pass in both themes over each named victim; the revived classes are enumerated in W0b.1 so none is discovered later. |
| `color-mix` support. | Already a dependency: `tokens.css:16` uses it for the hover token and `DESIGN.md:47` documents it. No new browser assumption. |
| A second presentation is a second editor by accident. | D19 puts the step index in a hook, not in `editor-state.ts`; W6.7's totality test and the shared-component rule are the enforcement. The DoD's "blank brief = zero red **in both presentations**" is the observable check. |
| `revealSection` misses a call site and a chip silently no-ops. | W6.2 changes all three call sites in one commit; W6.8 tests the unmounted-section path specifically. |
| The card re-skin orphans `getByRole` queries across the suite. | The accessible name is an explicit `aria-label` of the raw value (`axis-card.tsx:34-38`) and stays; W2b.5 pins it, and the DoD lists the exact queries. |
| Guided hides a section that carries an error the user cannot see. | The outline pill, the segbar segment and the `ErrorStrip` chip all remain visible in Guided and all navigate; Apply reveals every section at once. |
| Deferring vibes/directions/subline reads as ignoring the mock. | §2.4 and Appendix A state each one's layer and cost; the *idiom* ships now on the axes that exist, so the screen looks like the inspiration even where the vocabulary cannot. |
| `DESIGN.md` is appended by every lane. | Append-only in the merge script, as the GB plan established; W0.4 owns the corrections, later lanes only add §4 entries. |

---

## 7. Open Questions

- **Q1 — Which presentation is the default for a loaded brief?** Recommendation: **Everything**. A returning user is editing, not being led; Guided is the default only for `/brief/new`. Reversible in one line, and the choice persists per user.
- **Q2 — Is Variety a step in Guided?** It lives in the sidebar (GB-D6) but it is section five of `sectionOrder("variation")`. Recommendation: **yes, a step** — Guided moves the panel into the column for that step and leaves the sidebar accordion in place for Everything, so the numbering has no gap (GB-D17).
- **Q3 — Confetti on Apply?** Recommendation: **no**, on `DESIGN.md:1.3` grounds ("no marketing rhythm"). It is a one-shot and three lines if you disagree — say the word.
- **Q4 — Does the header Generate replace the CommandBar's Execute?** Recommendation: **no**. Generate stages and runs the applied brief from anywhere; Execute commits the reviewed set and belongs with the creatives.
- **Q5 — Do the deferred schema features get their own plan now?** Recommendation: **one plan for the copy axes** (vibes, directions, subline — they share the compositor and the golden re-pin) and leave story/carousel/OOH until a real platform requirement exists.

---

## Appendix A — Disposition of all 246 inspiration items

Every item the mock contains, its status against the code, and where it goes. `†` marks an item a second adversarial pass contested; §2.2 resolves the material ones. Layers: `tok` design-tokens · `ui` ui-only · `api` web+api · `dom` domain-schema · `doc` docs-only.

| Item | What the mock does | Status | Layer | Disposition |
|---|---|---|---|---|
| `SHELL-01` | Header bar chrome | partial | ui | **W5** |
| `SHELL-02` | Brand mark + name | partial | ui | **W5** |
| `SHELL-03` | Centred tabs incl. a Brief tab | partial | ui | **W5** |
| `SHELL-04` | Tab active/hover styling | partial | ui | **W5** |
| `SHELL-05` | Model select styling | present | ui | **W5** |
| `SHELL-06` | Telemetry button in the header | partial | ui | **W5** |
| `SHELL-07` | Generate button in the header | missing | ui | **W5** |
| `SHELL-08` | Light/dark theme toggle | missing | tok | **W3** |
| `SHELL-09` | Hamburger placement + a11y | partial | ui | **W5** |
| `SHELL-10` | "HITL Mode Active" label (repo only) | present | ui | **W5** |
| `SHELL-11` | icon-btn primitive | missing | ui | **W2a** |
| `SHELL-12` | Sidebar chrome + shell grid | partial | ui | **W4** |
| `SHELL-13` | Sidebar body + footer containment | present | ui | rejected §2.3 |
| `SHELL-14` | Sections outline header + issues aside | missing | ui | **W4** |
| `SHELL-15` | Numbered outline rows | missing | ui | **W4** |
| `SHELL-16` | Current-row inset rail | missing | ui | **W4** |
| `SHELL-17` | Error pill on a row | partial | tok | **W4** |
| `SHELL-18` | Accordion trigger anatomy | partial | ui | **W4** |
| `SHELL-19` | Project Bin include-checkbox rows + 0/6 count † | missing | dom | **W4** (UI half) + deferred §2.4 |
| `SHELL-20` | Estimate accordion: Deliverables + Render window † | partial | api | **W4** (UI half) + deferred §2.4 |
| `SHELL-21` | Field label + fieldbox primitive | present | ui | **W2a** |
| `SHELL-22` | Campaign Brief read-only accordion (repo only) † | present | ui | **W1** |
| `SHELL-23` | Editor-published panels: ModePanel top + Variation Policy accordion (repo only) | present | ui | **W4** |
| `SHELL-24` | Footer: Create new / Browse briefs | present | ui | **W4** |
| `SHELL-25` | Full-screen menu dialog chrome † | present | ui | **W10** |
| `SHELL-26` | Menu tab rows with icons + Brief entry | partial | ui | **W1** |
| `SHELL-27` | Sidebar body MOVED into the menu (single instance) | partial | ui | rejected §2.3 |
| `SHELL-28` | Menu close triggers + scroll lock | present | ui | rejected §2.3 |
| `SHELL-29` | Double dirty prompt on mobile tab tap (repo defect) | conflicts | ui | **W1** |
| `SHELL-30` | Picker dialog chrome + copy | partial | ui | **W10** |
| `SHELL-31` | pick-row anatomy: swatch · name · id · updated · state chip · current chip | partial | api | **W10** (UI half) + deferred §2.4 |
| `SHELL-32` | Select / create / duplicate flows | partial | ui | **W8** |
| `SHELL-33` | Loading / empty / error states | present | ui | **W10** |
| `SHELL-34` | Auto-open once on first visit (repo only) | present | ui | rejected §2.3 |
| `SHELL-35` | Right drawer chrome + footer note | partial | ui | **W10** |
| `SHELL-36` | Skeleton loading on open | partial | ui | **W2a** |
| `SHELL-37` | Pool rows: mock 'Use' vs repo approve/reject/edit | present | ui | **W10** |
| `SHELL-38` | Telemetry drawer rows + skeleton | partial | api | **W10** (UI half) + deferred §2.4 |
| `SHELL-39` | Modal vs non-modal telemetry | present | ui | **W10** |
| `SHELL-40` | Skeleton primitive (pulse loop) | conflicts | ui | **W2a** |
| `SHELL-41` | makeDialog contract (focus trap · Escape · scrim · focus restore · hooks) | partial | ui | **W10** |
| `SHELL-42` | Overlay scrim + dialog surface tokens | present | tok | **W10** |
| `SHELL-43` | Dialog head / body / foot anatomy | partial | ui | **W10** |
| `SHELL-44` | Save-as dialog copy | partial | ui | **W10** |
| `SHELL-45` | Save menu items + keyboard nav | partial | ui | **W8** |
| `SHELL-46` | In-app dirty-guard dialog (Stay / Leave) | missing | ui | **W10** |
| `SHELL-47` | One prompt, never stacked (sequencing rule) | partial | ui | **W10** |
| `SHELL-48` | View header pattern: eyebrow / view-title / view-meta | partial | ui | **W10** |
| `SHELL-49` | empty-note pattern | partial | ui | **W10** |
| `SHELL-50` | Skeleton tiles + staggered rise-in on the grid | partial | ui | **W10** |
| `SHELL-51` | mini-chip state pill | partial | ui | **W10** |
| `SHELL-52` | Table styling + run-history table | partial | api | **W10** (UI half) + deferred §2.4 |
| `SHELL-53` | comp-row key/value pattern | not-applicable | ui | rejected §2.3 |
| `SHELL-54` | CommandBar in flow vs absolute | partial | ui | **W10** |
| `SHELL-55` | Route change: aria-current, scroll reset, heading focus, key scoping | missing | ui | **W6** |
| `SHELL-56` | Global reduced-motion rule | partial | ui | **W2a** |
| `SHELL-57` | Focus-visible ring, selection, scrollbar globals | partial | tok | **W2a** |
| `SHELL-58` | Tokens as RGB triplets for alpha modifiers | missing | tok | **W0** |
| `SHELL-59` | text-emphasis token vs raw white/black literals | missing | tok | **W0** |
| `SHELL-60` | Brand link routes home through the guard | missing | ui | **W5** |
| `SHELL-61` | Icon set: lucide vs hand-drawn SVG paths | missing | ui | **W5** |
| `SHELL-62` | Model-change feedback copy | missing | ui | **W5** |
| `STEP-01` | Campaign name input | partial | ui | **W10** |
| `STEP-02` | Live brief-id slug mirror | present | ui | **W10** |
| `STEP-03` | Copy brief id button + 'copied' note | present | ui | **W10** |
| `STEP-04` | Region chips GLOBAL/EU/DE/UK/US/APAC | present | ui | **W10** |
| `STEP-05` | Target audience field — ABSENT from the mock | present | ui | **W10** |
| `STEP-06` | Step-1 validation copy | present | ui | **W10** |
| `STEP-07` | Six TONES option cards with lucide icon + one-liner | conflicts | dom | **W6** (UI half) + deferred §2.4 |
| `STEP-08` | Max-two tones with a spoken refusal | partial | ui | **W10** |
| `STEP-09` | Optional-step hint and 'neutral' fallback | partial | ui | **W10** |
| `STEP-10` | Eight 52px swatches | partial | ui | **W2b** |
| `STEP-11` | Custom pipette via native color input | missing | ui | **W2b** |
| `STEP-12` | Colour readout line | partial | ui | **W10** |
| `STEP-13` | Auto-advance after one tap | missing | ui | rejected §2.3 |
| `STEP-14` | Four pool-card suggestions with char counts | missing | ui | **W10** |
| `STEP-15` | 'More ideas' opens the pool drawer (skeleton → rows → Use) | partial | ui | **W10** |
| `STEP-16` | Own-headline input with live 'N / 48' counter turning red | present | ui | **W10** |
| `STEP-17` | Inline headline error line (not touch-gated) | conflicts | ui | **W10** |
| `STEP-18` | Subline input (optional, maxlength 60) | missing | dom | deferred §2.4 |
| `STEP-19` | Asset-card rows (tick, brand-tinted type icon, TYPE · size) | partial | ui | **W2b** |
| `STEP-20` | HERO tag + star hero button | partial | ui | deferred — the control is UI, but there is no hero flag to bind it to (§2.4) |
| `STEP-21` | Upload card → hidden multi-file input with extension-based type inference | partial | ui | **W10** |
| `STEP-22` | Step-5 validation and the missing product model | conflicts | ui | **W10** |
| `STEP-23` | Sidebar Project Bin checkboxes mirror inclusion | missing | ui | **W4** |
| `STEP-24` | Four DIRECTIONS option cards with inline SVG thumbnails (multi-select) | missing | dom | deferred §2.4 |
| `STEP-25` | Look hint + required-one validation | partial | ui | **W10** |
| `STEP-26` | Five FORMATS ('Ad types') option cards with icon / spec / description | partial | dom | **W10** (UI half) + deferred §2.4 |
| `STEP-27` | OOH card disabled by a simulated dooh probe (enter-blocked, leave-allowed) with warning icon | not-applicable | api | rejected §2.3 |
| `STEP-28` | Six PLATFORM cards with 'video-ready' / 'stills only' meta | partial | ui | **W10** |
| `STEP-29` | gate-line info / success / warning with probe copy | partial | ui | **W10** |
| `STEP-30` | gateErr: motion needs a video platform | present | ui | rejected §2.3 |
| `STEP-31` | Step-7 required-one errors and the missing Video sub-panel | present | ui | rejected §2.3 |
| `STEP-32` | Foot status sentence + Next button (disabled when invalid, 'Review & launch' on step 7) | conflicts | ui | **W6** |
| `STEP-33` | 232×464 phone dock with 'Following / For You' chrome | missing | ui | **W9** |
| `STEP-34` | Direction canvases d-minimal / d-graphic / d-editorial / d-texture driven by --c | partial | ui | **W9** |
| `STEP-35` | Story progress bars (infinite loop) | conflicts | ui | rejected §2.3 |
| `STEP-36` | Glyph from hero asset type | missing | ui | **W9** |
| `STEP-37` | Headline with typewriter (26 ms/char) and 'YOUR HEADLINE' empty state | missing | ui | **W9** — empty state only; typewriter rejected §2.3 |
| `STEP-38` | Sub line, engagement rail, caption (@handle from slug), sound line | not-applicable | dom | rejected §2.3 |
| `STEP-39` | ph-dest 'plays on X · Static · 1080×1080 · JPG' line | missing | ui | **W9** |
| `STEP-40` | preview-hint sentence | missing | ui | **W9** |
| `STEP-41` | Mobile mini strip (swatch · name · headline · step) | missing | ui | **W9** |
| `STEP-42` | Draft shape and dirty tracking | present | doc | rejected §2.3 |
| `STEP-43` | BRIEFS fixtures and the executed / in review / draft state vocabulary | partial | api | **W10** (UI half) + deferred §2.4 |
| `STEP-44` | renderEstimate: formats × directions × platforms, ~1.4 min each 'on <model>' | partial | api | **W4** (UI half) + deferred §2.4 |
| `STEP-45` | Review summary rows mirror the draft fields | missing | ui | **W8** |
| `STEP-46` | Accessible-name and role choices in the step controls | present | ui | **W2b** |
| `STEP-47` | Step-entry stagger, check badge overshoot, hover/active scale | missing | tok | **W2b** |
| `STEP-48` | Option-card / pool-card / asset-card surface treatment vs the kit's AxisCard | partial | tok | **W2b** |
| `STEP-49` | keepStep() re-render with focus restoration | partial | ui | **W6** |
| `TOK-01` | rgb-triplet colour token encoding † | missing | tok | **W0** |
| `TOK-02` | Alpha-on-token uses in the mock (full list) † | partial | tok | **W0** |
| `TOK-03` | Brand primary + hover | present | tok | **W0** |
| `TOK-04` | brand-secondary / brand-tint / brand-rail tokens absent in mock | conflicts | tok | **W0** |
| `TOK-05` | Light neutral palette | present | tok | **W0** |
| `TOK-06` | Dark 'Firefly' palette | present | tok | **W0** |
| `TOK-07` | NEW token --color-text-emphasis | missing | tok | **W0** |
| `TOK-08` | Semantic colours † | present | tok | **W0** |
| `TOK-09` | Shadows (sm, 2xl; no md/lg) | partial | tok | **W2a** |
| `TOK-10` | Radius scale + off-scale literals | partial | tok | **W2a** |
| `TOK-11` | Duration tokens vs literal durations † | partial | tok | **W7** |
| `TOK-12` | Easing curves | partial | tok | **W7** |
| `TOK-13` | Font families and weights | present | doc | **W2a** |
| `TOK-14` | Body base size 14px + antialiasing | partial | tok | **W2a** |
| `TOK-15` | Pixel size scale t10/t11/t13/t15 + 12 / 12.5 / 18 / 19 / 9 / 8 | partial | ui | **W2a** |
| `TOK-16` | Eyebrow / mono caption with .08em tracking † | partial | tok | **W2a** |
| `TOK-17` | Field label / hint / error line † | partial | tok | **W2a** |
| `TOK-18` | 1.5px card borders and 2px ticks † | missing | tok | **W2b** |
| `TOK-19` | Selected-card treatment (brand border + brand/.08 tint + inverted icon tile) † | partial | tok | **W2b** |
| `TOK-20` | Check-bubble pop with overshoot | missing | tok | **W2b** |
| `TOK-21` | Global :focus-visible outline | partial | tok | **W2a** |
| `TOK-22` | Input focus halo (border + 3px brand/.25 shadow) † | partial | tok | **W2a** |
| `TOK-23` | ::selection colour † | missing | tok | **W2a** |
| `TOK-24` | Scrollbar styling (standard + WebKit) | partial | tok | **W2a** |
| `TOK-25` | Light/dark theme toggle (class .dark + localStorage 'cf-theme') | missing | ui | **W3** |
| `TOK-26` | color-scheme declaration | missing | tok | **W3** |
| `TOK-27` | Reduced-motion handling (blanket CSS + JS flag) | partial | ui | **W6** |
| `TOK-28` | Step-card slide transitions enterR / enterL / exitL / exitR | missing | ui | **W7** |
| `TOK-29` | riseIn stagger on option lists and grid tiles | missing | ui | **W2b** |
| `TOK-30` | segFill loop on the current progress segment (and phone story bars) | conflicts | ui | **W7** — static, not a loop (D27) |
| `TOK-31` | readyPulse loop on the Next button | conflicts | ui | **W7** |
| `TOK-32` | nudge shake on a refused Next | missing | ui | **W7** |
| `TOK-33` | burst sparks (confetti) on Apply | missing | ui | **Q3** (§7) |
| `TOK-34` | pulse skeleton loop (loading states) | partial | ui | **W2a** |
| `TOK-35` | Transform micro-interactions (press, lift, hover-scale) | partial | ui | **W2b** |
| `TOK-36` | Accordion chevron rotate | present | ui | **W2b** |
| `TOK-37` | copy-note fade (slug copied) | partial | ui | **W10** |
| `TOK-38` | Phone preview colour/direction transitions | missing | ui | **W9** |
| `TOK-39` | Spacing scale as used † | partial | tok | **W2a** |
| `TOK-40` | Fixed chrome sizes | partial | ui | **W2a** |
| `TOK-41` | Button sizes, weights and variants | partial | ui | **W2a** |
| `TOK-42` | Card surface | present | ui | **W2a** |
| `TOK-43` | icon-btn primitive | missing | ui | **W2a** |
| `TOK-44` | Pill chip (32px, brand-filled when pressed) | partial | ui | **W2a** |
| `TOK-45` | StatusChip colours and dot | partial | ui | **W2b** |
| `TOK-46` | ErrorPill | partial | tok | **W2b** |
| `TOK-47` | ErrorStrip chip tokenised | partial | ui | **W2b** |
| `TOK-48` | mini-chip (20px mono status pill) | partial | ui | **W2b** |
| `TOK-49` | Save menu panel | partial | ui | **W10** |
| `TOK-50` | Overlay scrim and z-index | present | ui | **W2a** |
| `TOK-51` | Dialog / drawer anatomy | partial | ui | **W10** |
| `TOK-52` | z-index scale | present | doc | **W2a** |
| `TOK-53` | Sticky wizard top bar (progress) scoped to the main column | missing | ui | **W6** |
| `TOK-54` | Breakpoints and media features | partial | tok | **W9** |
| `TOK-55` | Sticky preview dock + mobile mini strip | missing | ui | **W9** |
| `TOK-56` | Progress segbar tokens | missing | ui | **W7** |
| `TOK-57` | View / step title typography † | partial | tok | **W1** |
| `TOK-58` | Brand mark, brand name, route tabs | partial | ui | **W5** |
| `TOK-59` | Mobile menu tab current state | partial | ui | **W10** |
| `TOK-60` | Sidebar outline row (Sections list) tokens † | missing | ui | **W4** |
| `TOK-61` | Sidebar accordion styling | partial | ui | **W2a** |
| `TOK-62` | Sidebar value box (fieldbox) | partial | ui | **W2a** |
| `TOK-63` | Native checkbox accent colour † | present | ui | **W2b** |
| `TOK-64` | Large colour swatches, selection outline and palette † | partial | ui | **W2b** |
| `TOK-65` | Product colour as `--c` custom property + YIQ contrast text | missing | ui | **W2b** |
| `TOK-66` | Hero tag / star in warning token | partial | ui | **W2b** |
| `TOK-67` | Status line colour semantics (gate-line / foot-status / apply-status) | partial | ui | **W10** |
| `TOK-68` | Literal colours the mock still uses vs the repo's stock-Tailwind defects | conflicts | tok | **W0** |
| `TOK-69` | Look & feel direction canvases (CSS-only, opacity literals) | missing | dom | deferred §2.4 |
| `TOK-70` | Phone preview chrome tokens | missing | ui | **W9** |
| `TOK-71` | Creative tile, skeleton and command card | partial | ui | **W10** |
| `TOK-72` | Table typography | partial | ui | **W2a** |
| `TOK-73` | Icon sizing and source | partial | ui | **W2a** |
| `TOK-74` | aria-live on the step header | missing | ui | **W6** |
| `TOK-75` | Headline typewriter | missing | ui | rejected §2.3 |
| `TOK-76` | theme.ts manifest gaps if triplets are adopted | partial | tok | **W0** |
| `TOK-77` | DESIGN.md drift surfaced by this comparison | conflicts | doc | **W0** |
| `TOK-78` | Base resets and utilities shared with Tailwind preflight | present | tok | rejected §2.3 |
| `TOK-79` | Main column border and scroll ownership | partial | ui | **W2a** |
| `WIZ-01` | STEPS list (8 titles + subtitles) | missing | ui | **W6** |
| `WIZ-02` | Sticky step header container | missing | ui | **W6** |
| `WIZ-03` | Back button (Previous step) | missing | ui | **W6** |
| `WIZ-04` | Step-count eyebrow | missing | ui | **W6** |
| `WIZ-05` | Step name h1 with tabindex=-1 and focus handoff | missing | ui | **W6** |
| `WIZ-06` | Step subtitle | missing | ui | **W6** |
| `WIZ-07` | aria-live polite wrapper around count/name/subtitle | missing | ui | rejected §2.3 |
| `WIZ-08` | StatusChip — four states with emoji dot | partial | tok | **W6** |
| `WIZ-09` | Segbar container | missing | ui | **W7** |
| `WIZ-10` | Per-segment states: done / err / cur / locked | missing | tok | **W7** — no locked state (D21) |
| `WIZ-11` | Segment hover scaleY(1.4) | missing | ui | **W7** |
| `WIZ-12` | seg-fill pulse on the current segment (infinite loop) | conflicts | ui | **W7** |
| `WIZ-13` | Segment aria-labels | missing | ui | **W7** |
| `WIZ-14` | Segment click navigates; locked until maxVisited | missing | ui | **W7** — lock rejected (D21) |
| `WIZ-15` | Mobile mini preview strip | missing | ui | **W9** |
| `WIZ-16` | Stage container | missing | ui | **W7** |
| `WIZ-17` | Step-card enter animation by direction | missing | tok | **W7** |
| `WIZ-18` | Old card exit: absolutely positioned, direction class, removed after 240ms | missing | ui | **W7** |
| `WIZ-19` | go(n, fromSwipe) — range guard and direction | conflicts | ui | **W6** |
| `WIZ-20` | Forward gating: cannot advance while the current step has issues | partial | ui | **W6** |
| `WIZ-21` | Next-button nudge animation | missing | ui | **W7** |
| `WIZ-22` | maxVisited high-water mark | missing | ui | **W6** |
| `WIZ-23` | attempted flags (per-step) drive red segments | partial | ui | **W6** |
| `WIZ-24` | jumpReview() | missing | ui | **W6** |
| `WIZ-25` | keepStep() — in-place re-render preserving focus via data-g/data-v | partial | ui | **W6** |
| `WIZ-26` | Swipe navigation (touch) | missing | ui | **W7** |
| `WIZ-27` | ArrowLeft / ArrowRight keyboard navigation | missing | ui | **W7** |
| `WIZ-28` | Escape closes the Save menu (two handlers) | partial | ui | **W7** |
| `WIZ-29` | Per-step footer (footHTML) | partial | ui | **W6** |
| `WIZ-30` | Swipe hint on coarse pointers | missing | ui | **W7** |
| `WIZ-31` | Next button: disabled when issues, next-ready pulse when clean, 'Review & launch' on step 7 | conflicts | ui | **W6** |
| `WIZ-32` | updateNext() — live recompute of footer + segbar + outline | partial | ui | **W6** |
| `WIZ-33` | setStepErr() — transient refusal in the footer | partial | ui | **W6** |
| `WIZ-34` | Auto-advance after a colour tap (650ms / 60ms reduced) | missing | ui | rejected §2.3 |
| `WIZ-35` | Review step layout (rev-grid + phone + summary rows) | missing | ui | **W8** |
| `WIZ-36` | Summary rows with per-row Edit links | missing | ui | **W8** |
| `WIZ-37` | Strip of step chips with issue counts | partial | tok | **W8** |
| `WIZ-38` | apply-status sentence and setApplyStatus kinds | partial | ui | **W8** |
| `WIZ-39` | Review actions: Discard / Save menu / Apply to run ('Update run' once applied) | present | ui | **W8** |
| `WIZ-40` | Save menu: items, open/close, outside-click, arrow cycling | partial | ui | **W8** |
| `WIZ-41` | Apply to run — success path with sparks and focus | present | ui | **W8** — sparks → Q3 |
| `WIZ-42` | Apply to run — refusal marks every failing step attempted | present | ui | **W8** |
| `WIZ-43` | Sparks confetti on Apply (one-shot) | missing | ui | **Q3** (§7) |
| `WIZ-44` | Save & apply (saveApply) — 'Saved with issues — not applied' | conflicts | api | rejected §2.3 |
| `WIZ-45` | Save as… dialog and confirm | partial | ui | **W8** |
| `WIZ-46` | Discard — revert to last SAVED snapshot | partial | ui | **W8** |
| `WIZ-47` | loadBrief jumps straight to Review | partial | ui | **W6** |
| `WIZ-48` | resetDraft (Create new) starts at step 0 | present | ui | **W6** |
| `WIZ-49` | Dirty guard around leaving the draft | partial | ui | **W6** |
| `WIZ-50` | stepIssues(i) — per-step remedy copy and the Review aggregate | partial | ui | **W6** |
| `WIZ-51` | Async capability probe re-gates step 7 after 1600ms | present | ui | **W6** |
| `WIZ-52` | Sidebar outline rows and Review links bypass the segbar lock | not-applicable | ui | rejected §2.3 |
| `WIZ-53` | Two delegated click listeners on #stage with fixed precedence | not-applicable | ui | rejected §2.3 |
| `WIZ-54` | Stage keydown: Enter/Space toggles asset cards | partial | ui | **W7** |
| `WIZ-55` | Reduced-motion handling (CSS + JS) | partial | ui | **W7** |
| `WIZ-56` | renderStep side effects and init | partial | ui | **W6** |

---

## Appendix B — New copy, in the house style

House rules applied (`DESIGN.md` §6, GB Appendix B): shape *"<what is missing> — <the one thing to do>"*; name the on-screen control; no jargon (`axis`, `draw`, `package`, `planner`, raw format/ratio/platform ids); no maths; empty fields are to-dos, not faults; at most two remedies; status lines lead with the chip's word.

### Step subtitles (`messages.step.<section>.subtitle`)

| Section | Subtitle |
|---|---|
| Identity | Name the campaign and say who it is for. |
| Copy | Write the one line you want people to remember. |
| Products | Add what you are advertising, with its colour and logo. |
| Treatments *(Classic)* | Choose the looks each product gets. |
| Variety *(Randomized)* | Say how many ads you want, and how much they should differ. |
| Output | Pick where the ads run, and whether they move. |
| Review | Last look, then send it to the pipeline. |

### Step footer (`messages.step.foot.*`)

| Key | String |
|---|---|
| `ok` | Looking good. |
| `optional` | Nothing needed here — skip ahead, or set it if you want. |
| `refused` | *(the section's first visible error, verbatim — never a second wording)* |
| `nextLabel` | Next |
| `nextLabelLast` | Review & launch |
| `backLabel` | Back |

### Sections outline (`messages.outline.*`)

| Key | String |
|---|---|
| `clean` | no issues |
| `count` | `${n} thing to fix` / `${n} things to fix` |

### Preview (`messages.preview.*`)

| Key | String |
|---|---|
| `caption` | `${ratioDisplayName} · ${platformLabel}` |
| `noPlatform` | `${ratioDisplayName} · no platform yet` — the ratio comes from the draft, never a fixed word |
| `hint` | This is what one of your ads will look like. |
| `emptyHeadline` | YOUR HEADLINE |

*Rejected from the mock:* `plays on tiktok · Static · 1080×1080 · JPG` — a raw platform id, a fixed size the platforms actually decide, and a file type stills do not use.

### Header (`messages.header.*`)

| Key | String |
|---|---|
| `generate` | Generate |
| `generateNoBrief` | Nothing applied yet — press Apply to run on the brief first. |
| `themeToLight` | Switch to the light theme |
| `themeToDark` | Switch to the dark theme |
| `modelChanged` | `${modelLabel} will make the next set of creatives.` |

### Estimate, classic (`messages.estimateSentenceClassic`)

> You will get `${n}` ads — `${products}` products in `${ratios}` shapes, `${treatments}` looks each.

*Deferred:* the mock's *"~14 min on firefly-3"*. No timing data exists; a made-up figure is the fabrication D26 rejects.

### Dirty guard (`messages.guard.*`)

| Key | String |
|---|---|
| `title` | Unsaved edits |
| `body` | `${what}` has changes that are not saved yet — leave anyway? |
| `stay` | Stay |
| `leave` | Leave |

*Note:* this replaces the current `window.confirm` text *"You have unsaved changes. Are you sure you want to leave?"* — a question that names nothing and offers no remedy — but only after W1.1 proves the prompt fires once.
