# The wireframe gap — what the owner drew, and what the editor actually is

**Date:** 2026-09-17 · **Revised:** 2026-09-17 (owner stamped SG-D1, SG-D2, SG-D4, SG-D5; SG-D6 dissolved; SG-D8 raised)
**Status:** **one decision open — SG-D7.** §8.4 and §9 answered by the owner 2026-09-17. SG-D8 stamped; SG-D9 answered then partly superseded; SG-D10–SG-D14 recorded from the owner's run-gate correction (§8). CC3 dispatched; TS1 merged as `#469`.
**Verified against:** `origin/main` at `4876aa31`.
**Source:** the owner's annotated wireframe of the campaign editor (two images, 2026-09-17), read against the shipped DOM of `/brief/new` captured from the owner's own browser the same day.
**Related:** `2026-09-16_studio-editor.md` (D137–D140, SE0–SE5, TL1–TL7 — **drafted, never dispatched**), `2026-09-16_creative-first-chrome.md` (D141–D145, CC1 shipped), `2026-09-16_rail-timeline-surface.md` (TS1, in PR #469, **unmerged**), `DESIGN.md` §3 shell anatomy.

---

## 0. Why this plan exists

The owner reported, three times across one day, that "none of the styling I provided landed." Each
report was investigated as a delivery fault — stale build, browser cache, a container query, a
serving directory. **Every one of those was refuted**, and the refutations were correct: the code on
main is the code in the browser.

The actual finding is that the wireframe was **never implemented**. It was turned into two planning
documents, both of which still read *"Nothing dispatched."* The one lane anyone built from them —
TS1, the timeline tape — is open in PR #469 and has never merged.

This is an orchestration failure, not a styling one, and it is recorded here so the next reader does
not re-run the same four investigations. **When an owner says a design did not land, check the
dispatch ledger before the build pipeline.**

---

## 1. What the wireframe asks for, against what ships

| Wireframe element | On `origin/main` |
|---|---|
| Header: `CF` · Campaign Pipeline · settings menu · account menu | **Shipped** (`DESIGN.md` §3; account menu absent, settings is the model picker) |
| Three-column shell | **Shipped** |
| Aspect-ratio chips; region search + world map | **Shipped** (`IdentitySection`) |
| `New` / `Browse` footer; main-content footer bar | **Shipped** |
| **Left column = Campaign Template**: template name, `Brief`/`Variation`, BriefId (auto-gen), SeedID | **Absent.** Left column is Campaign Brief + Project Bin + Variation Policy + Estimate |
| **`Visual │ Yaml` over the middle column** | **Misplaced.** The eye/`</>` switcher is inside the *rail*; the middle toggle is `Guided │ Everything` |
| **Right column: Layers container, Add layer, per-layer toggle** | **Absent.** Layers are a *step in the form* (`04 · Template`) |
| **Right column: Timeline + Video scrubber, scrubbing drives the preview above** | **Absent from main.** Built in PR #469, unmerged |
| **Column resizer between middle and right** | **Absent.** No such control exists |
| **`save/next` in the right column** | **Absent.** Save lives in the sticky action bar |
| Middle column: name, audience, ratios, regions — and little else | **Diverged.** A six-step wizard |
| Create modal: two tiles, `Static` │ `Video/motion` | **Diverged.** Four tiles in two groups |

---

## 2. Findings

| # | Severity | Finding |
|---|---|---|
| **C1** | **Critical** | **The right column does not exist.** The wireframe's right column is a creative preview *with a layers container, a timeline and a video scrubber under it*, sized by a draggable resizer. What ships is `aside[aria-label="Preview"]` — a **256px** (`w-64`) strip holding a preview image and an eye/`</>` switcher. `TimelineTape.tsx` is **absent from `origin/main`**; there is **no layers-panel component anywhere in the tree**. This single gap accounts for most of the owner's "nothing landed". |
| **H1** | High | **The `studio` presentation was stamped and never built.** `D137` (owner, 2026-09-16) adds `studio` as a third operator-chosen presentation. `grep -rn '"studio"' apps/web/src` returns **nothing**. The decision is recorded; the code does not exist. Every SE and TL lane in the studio plan depends on it. |
| **H2** | High | **No column resizer exists, and no plan mentions one.** The only `resize` occurrences in `apps/web/src` are a `window.addEventListener("resize", …)` in `section-outline.tsx:58` and a *comment* in `BriefEditor.tsx:1817`. The wireframe's resizer is not a refinement of something shipped — it is unbuilt and unplanned. |
| **M1** | Medium | **`Visual │ Yaml` is in the wrong column.** The wireframe places it over the middle column, annotated *"Controls middle content area."* Shipped, the eye/`</>` switcher lives **inside the rail** and controls the rail, while the middle column carries `Guided │ Everything` — a different axis entirely. Moving one without deciding the fate of the other leaves two toggles competing for the same corner. |
| **M2** | Medium | **The left column is a different object.** The wireframe's left column is about the **template** (template name, `Brief`/`Variation`, auto-generated BriefId, SeedID). The shipped left column is about the **brief** (Brief ID, Target Region, Aspects, Localized Copy) plus Project Bin, Variation Policy and Estimate. These are not the same panel with different styling; they hold different fields from different parts of the document. |
| **L1** | Low | **The create modal diverged deliberately.** The wireframe shows two tiles (`Static`, `Video/motion`); `CAMPAIGN_TYPE_GROUPS` ships four in two groups (Still images: social-post, paid-social, display-ad; Video: short-video). The grouping landed 2026-09-16 and is *newer* than the wireframe. This may be intentional evolution rather than drift — **SG-D1** settles it. |
| **L2** | Low | **`save/next` placement.** The wireframe puts a `save/next` control at the foot of the right column; shipped, Save/Cancel live in the sticky action bar at the foot of the middle column. Cheap either way, but it is a real difference and is listed so it is not mistaken for an oversight later. |

---

## 3. Decisions the owner must make

**None of these can be defaulted.** Each changes what gets built, and three of them change how much.

| ID | Question | Options | Recommendation |
|---|---|---|---|
| **SG-D1** | **Create modal: two tiles or four — and does `mode` survive?** | (a) **Two tiles at the root** (`Static` │ `Video/motion`), the creative **count** chosen in the wizard, and `mode` retired as an operator-facing concept. (b) Keep the four grouped tiles and the `Classic` / `Randomized` labels. | **(a).** *Revised 2026-09-17 after the owner's reasoning; my first recommendation was (b) and was too narrow — it defended the tiles without noticing they encode a question `motion` already answers.* Three facts carry it: **(i)** `static \| motion` is already the root axis of the domain (`output.formats`; `CAMPAIGN_TYPE_GROUPS` groups by exactly it), so two tiles *are* the domain, and the four types are preset bundles above it. **(ii)** Motion **cannot** run classic — `GenerateCampaignUseCase.use-case.ts:1026` refuses a brief with `copy.timeline` outside variation mode, so picking Video already determines the mode and asking afterwards is a question with one legal answer. **(iii)** `variation.count` already exists and already reaches 1, so "how many creatives" is a control the domain has. Retiring `mode` deletes the `Classic`/`Randomized` vocabulary by removing the **concept**, not by renaming it. |
| **SG-D2** | **Middle column: lean form or six-step wizard?** | — | **STAMPED (owner, 2026-09-17): the six-step wizard is deprecated and removed.** *My recommendation was (b), keep it; the owner chose to remove it, and checking what that displaces showed the change is far smaller than I claimed.* `sections/index.ts:51` gives the order, and two things fall out. **(i) `treatments` exists only in `brief` mode**, so retiring `mode` (SG-D1) deletes that section outright — no rehoming. **(ii) `everything` already renders every remaining section in one scrolling column**, so "remove the wizard" means **remove `guided` and the step cursor**; `copy`, `products`, `output` and `policy` stay where they are. Only **two** sections move: `template` → the modal (SG-D5), `layout` → the right column. **`review` is the one orphan — see SG-D8.** |
| **SG-D3** | **Does the column resizer persist, and what are its bounds?** | (a) Ephemeral, resets on reload (like zoom, D147). (b) Persisted per-operator in `localStorage` beside `cf:presentation`. | **(a) Ephemeral**, matching D147's reasoning for timeline zoom: a pane width is not a property of the campaign, and a persisted width surprises a second operator on the same brief. Bounds must keep the rail above its `56rem` container-query threshold or the resizer becomes a way to hide the right column by accident. |
| **SG-D4** | **Where does `Visual │ Yaml` live?** | — | **STAMPED (owner, 2026-09-17): a switch inside the middle content panel.** With `guided` gone there is no competing presentation toggle to keep distinct, so the concern in my original recommendation dissolves with SG-D2. |
| **SG-D5** | **Template: sidebar panel or modal?** | — | **STAMPED (owner, 2026-09-17): a new modal view.** *This overrides my recommendation of a sidebar accordion.* Thumbnails, searchable, sortable; clicking a template opens its **detail view within the same modal** with a back arrow to the listing; the detail view shows the creative as generated plus the brief details and attached assets. **Specified in full in `2026-09-17_template-library-modal.md`**, which supersedes lane SG3. A 320px column cannot give a template library browsing room; the owner is right. |
| **SG-D6** | **Where do the layer stack and inspector sit?** | — | **DISSOLVED by SG-D2.** The question only existed because `studio` was to be a third presentation beside `guided`/`everything`. With `guided` deprecated there is one layout, and the wireframe's right column is it. Recorded rather than deleted so `2026-09-16_studio-editor.md` §10's open question has a visible answer. |
| **SG-D7** | **If `mode` is retired, is `count` at its ceiling *exhaustive*?** | (a) Verify and rely on it — at `count = axisProductSize` the draw enumerates the space, so no separate concept is needed. (b) If it merely samples to that size, add an explicit exhaustive path. | **(a), pending one verification — and note this question is much smaller than it first looked.** A first draft of this row claimed `count` was capped at 48 and that "count = everything" was therefore inexpressible. **That was wrong.** `editor-state.ts:734` sets the ceiling to `axisProductSize(state)` and clamps `count` to it, so the ceiling **is** the cross-product size and the 48 in the owner's editor was simply their axis space. "Give me every combination" is already sayable: count at maximum. What remains is a property to **verify, not assume** — whether `executeVariation` at `count = axisProductSize` enumerates the space exactly once or samples to that size under `minDistance`. If it enumerates, retiring `mode` loses nothing. **A lane must prove this with a test before SG-D1 is implemented**; it is the one place the retirement could silently drop a guarantee. |
| **SG-D8** | **Where does Review go?** | — | **STAMPED (owner, 2026-09-17): nowhere. Review as a step is deleted, and its three jobs are split by what each fact belongs to.** *My recommendations moved twice here and both moves came from the owner: first to the Generate confirm once "what is Review a review of?" forced the answer (a pre-flight on the **document**, not the creatives — it renders `toBrief(state)`, the exact projection `Save` sends), then to this split once the owner asked why it is not simply a field error.* **(i) Per-field — inline, beside the control, exactly like a validation error but read from the PROJECTION rather than from `state`.** This is the one thing inline validation structurally cannot do today: `validate.ts` (589 lines) asks *is this value acceptable?* and reads `state`; the missing question is *did this value reach the document?*, which no field can answer because no field looks at `toBrief`. A valid letter-spacing that the projection drops has nothing to complain about and no row to be missing from. **(ii) Aggregates and the composed creative → the Generate confirm.** *"12 creatives · 4 layers · these platforms"* plus the figure have no field to attach to, and they are a **cost** question, not a problem — and `Header.tsx:339` wires **Generate** straight to `handleGenerate` with no pre-flight on an action that spends the owner's GenAI credits. **(iii) The aggregate list → a `Problems` tab in the telemetry drawer (SG-D9).** D43's rail-vs-Review arbitration dissolves with the step: the rail keeps the only composed frame while editing, and the confirm draws its own where the rail is not the subject. |
| **SG-D9** | **Does the telemetry drawer host the problem list?** *(new — owner's proposal, 2026-09-17)* | (a) Reuse the drawer **chrome** and add tabs — `Telemetry │ Problems` — two panels, two data models. (b) Dump validation into the existing log. (c) A separate surface. | **(a).** The owner's instinct is right and fills a real gap: `messages.ts:427` already renders **`"No issues"` / `"N things to fix"`** — a count with **no list to open**. The drawer is also already **shell-wide** (`(shell)/layout.tsx:71`), not grid-only, so it is reachable from the editor today. **(b) is refused, and the reason is the data model, not the container.** The drawer renders `useRun().log` — `LogEntry[]` = `{ timestamp, stage, message, level }`, the **last run's** pipeline events: historical, frozen once the run ends, machine-voiced, and `Copy` flattens it to `HH:MM [stage] message`. Validation is the opposite on every axis — **current**, recomputed per keystroke, keyed by field, and each entry must be a **control that jumps to its field**. Forcing it into `LogEntry[]` means fabricating a timestamp and a stage for things that are not events, losing the Edit affordance a monospace log line cannot carry, and having validation and run telemetry fight for one surface. So: **reuse the container, not the log.** The drawer's floating panel, `max-w-[800px]`, expand/collapse, Copy and its `inert`/`aria-hidden` open-close mechanics are a solved problem worth inheriting; the log's shape is not. |

---

## 4. Lanes

**Most of this work already has a home.** This plan mints ids only for what no plan covers.

| Lane | Owns | Depends on | Ships |
|---|---|---|---|
| **SG1** | `BriefEditor.tsx`, `editor-state.ts`, `sections/index.ts` | SG-D2, **SG-D8** | **Retire `guided`.** *Rewritten 2026-09-17: this lane used to ADD a `studio` presentation. SG-D2 makes that unnecessary — with `guided` deprecated there is one layout, so `studio` never needs to exist and **D137 dissolves with it**.* The lane removes the step cursor, the stepper nav and the guided-only gates, leaves `everything`'s single scrolling column as the editor, and rehomes `review` per SG-D8. `Presentation` collapses from a union to nothing. |
| **SG2** ✅ shipped (`#482`) | `(shell)/layout.tsx`, `ColumnResizeHandle.tsx`, `apps/web/package.json`, `vitest.config.ts` | SG-D3, SG-D17 | **The column resizer.** Pointer + **keyboard** (arrow keys, `role="separator"` with `aria-valuenow`), bounded by `minSize` on both panels so neither column can be collapsed. *Revised 2026-09-17: it does **not** touch `BriefEditor.tsx` — RS2 moved the rail into the shell row first, so the handle sits between `<main>` and the rail there. Its old bound (“not below the right column's container-query threshold”) is **obsolete with the container query RS2 deleted**; the bound that stands is the two `minSize` floors. It no longer depends on SG1.* |
| ~~SG3~~ | — | — | **Superseded by `2026-09-17_template-library-modal.md`** (TM1–TM4). SG-D5 made Template a modal, not a panel, so the panel lane no longer exists. The one piece worth keeping from it: **SeedID must be _moved_, not duplicated** — `premise SG3` still guards that and stays. |
| **SG4** ✅ shipped (`#483`) | `BriefEditor.tsx`, `messages.ts` | SG-D4, SG-D13 | **`editor │ yaml` over the middle column.** *Revised 2026-09-18: "presentation kept as a separate control" is **stale** — SG1 retired the `presentation` axis, so there is no second control to keep independent. And the control ships with **two** positions, not SG-D13's three: `validate` needs the validation view, which is SG10, and a third position wired to nothing is the defect that cost this project two days. The record is typed so SG10's `validate` is a `tsc` failure until the view exists. The rail becomes **preview-only** — see the DoD for what that cost.* |
| *(existing)* | — | SG1 | **SE0–SE5** (layer stack + inspector) and **TL1–TL7** (time surface) from `2026-09-16_studio-editor.md`, now unblocked on SG-D6. |
| *(existing)* | — | — | **TS1** — PR #469. Merge it; it is the timeline the wireframe draws. |
| **SG5** | *(measurement only — no product change)* | — | **How often does the projection actually drop a valid field?** *The first task under SG-D8, and it must run before SG6.* Enumerate every conditional write in `toBrief(state)` and, for each, state whether a field can be **valid in `state` and absent from the projection**. Output is a list, not a feature: the field, the condition, and whether the loss is intentional (a gated block) or a defect. **If the answer is "never", SG6 is deleted and the inline notice is not built** — a mapping that detects nothing is worse than no mapping. |
| **SG6** | `validate.ts`, the field components | **SG5** | **The projection notice** — per-field, inline, beside the control, worded as a distinct thing from a validation error because it is one: the value is fine, it did not reach the document. Rides the existing `aria-describedby` rail (X15/X19). |
| ~~SG7~~ | — | — | **RETIRED by §8.5** — the validation view is a middle-column view reached by the segmented control (SG-D13), so a `Problems` tab in the telemetry drawer is redundant. The `"N things to fix"` count still becomes a control that opens the list; the list is **SG10's view**, not a drawer panel. The drawer stays telemetry-only. |
| **SG8** | the editor toolbar, a new confirm | SG-D8, **SG-D10** | **The Generate pre-flight** — *"12 creatives · 4 layers · these platforms"* and the composed figure, shown before a run spends credits. Replaces Review's aggregate half. **Revised by §8.5:** it sits behind the **toolbar's** `Generate`, not the header's, which SG-D10 removes. |

**Order.** TS1 ✅ merged (`#469`) → **CC3** ✅ built (`#474`, in review) → **SG5** (measure, no code) → **SG1** (retire `guided`, which deletes the Review step) → **SG2 ‖ SG4 ‖ SG8 ‖ SG9 ‖ SG10**, then **SG6** if SG5 says it is needed, then SE/TL lanes.

**SG5 gates SG6 and nothing else** — it is measurement, touches no product code, and may run immediately and in parallel with everything. **SG7 is retired** (§8.5) and is no longer in this order. The template modal's **TM1–TM4** are independent throughout: a new client and a new component, sharing no file with any SG lane.

**`BriefEditor.tsx` is the contended file.** SG1, SG2, SG4 and CC3 all want it. Nothing that touches it may be dispatched in parallel with anything else that does.

**`BriefEditor.tsx` is the contended file in this repo.** It is 2000+ lines and four of these lanes want it. Nothing here may be dispatched in parallel against it.

---

## 5. Definition of done

Shared gate: CI, which runs every step. Per the repo's rule, each lane names the fault that must turn it **red**:

- **SG1** — `grep -rn '"studio"' apps/web/src` returns the union member and its guard; a draft without motion or an oversized template is **not** offered `studio`; selecting it persists under `cf:presentation` and survives reload; **it is never selected without a click**. Reverting the offer-guard makes a test fail.
- **SG2** ✅ — a keyboard-only user can resize the column (arrow keys move it, `aria-valuenow` changes); dragging to either extreme **cannot** collapse either column, so the resizer can never silently hide the surface it exists to size. Removing either `minSize` makes a test fail. *The threshold this criterion used to name — `@container(min-width:56rem)` — no longer exists: RS2 deleted the container query, so the bound is the two `minSize` floors (rail 25%, main 50%). Below `lg` the handle is additionally not interactive at all — `display: none` for the width, `tabIndex={-1}` for the tab order, `disabled` for the keyboard — because the rail there is hidden but still mounted.*
- **SG3** — SeedID appears **once** in the DOM. A test asserts exactly one control with that accessible name — the fault this prevents is duplicating rather than moving it.
- **SG4** ✅ — the view switch toggles the **middle** column and the rail's preview frame stays mounted across the flip (asserted by mount count, since the viewport gate hides without unmounting). The YAML view renders the **projection** (`toBrief(state)`), not the editor state, so it cannot disagree with the document Save sends. *The "presentation still toggles independently" half of this criterion is **withdrawn**: SG1 retired that axis.*
  **What the move cost, recorded rather than discovered later.** Taking the single switch onto the middle column makes the rail preview-only, which deletes a side effect nobody had named: the rail's `yaml` view used to unmount `PreviewDock`, so while the document was up **no `/preview-frame` call was possible.** An operator could park in `yaml` and edit without spending GenAI credits. That is gone, and the test asserting it is deleted with it. CC1/CC2's actual contract is untouched and still asserted (`rail-in-shell.test.tsx:523`, `brief-editor.test.tsx:3368` — a look-preserving keystroke issues zero calls); what is lost is an incidental way to suppress the calls a *look-changing* edit makes. If deliberate suppression is wanted back it should be an explicit control, not a side effect of a view — **not built, and awaiting the owner.**

---

## 6. What this plan does not do

- **It does not itself delete the six-step wizard.** SG-D2 stamps the removal; the lane that performs it is **SG1**, restated below. The migration is far smaller than the first draft of this plan assumed — see SG-D2.
- **It does not restate SE0–SE5 or TL1–TL7.** They are specified in `2026-09-16_studio-editor.md`. SG-D6 is now dissolved, so they are unblocked outright.
- **It does not specify the template modal.** That is `2026-09-17_template-library-modal.md`, which supersedes SG3.
- **It does not add an account menu.** The wireframe shows one; there is no identity model yet, and the cloud-migration direction records the identity fork as undecided. Naming it here would imply a side.
- **It does not re-decide D137–D147.** Those are stamped. Where this plan touches the same surface, it defers.

---

## 7. Premises

```premise SG1
# The `studio` presentation does not exist. It flips when SG1 adds it.
# Greps the source rather than the built bundle: a fence that needs a build
# cannot answer inside the 10s budget. Measured: ~40 ms.
! grep -rqn '"studio"' apps/web/src --include='*.ts' --include='*.tsx'
```

**`premise SG2` retired: SG2 shipped.** The fence probed for the absence of
`role="separator"` in `apps/web/src`, and `PanelResizeHandle` now renders exactly
that between the middle column and the rail — so the fence reports the lane stale
rather than live, which is the fence working, not failing. What replaced it is
stronger than a grep: `column-resizer.test.tsx` drives the arrow keys and asserts
the split actually moves (`data-panel-size` 65/35 → 55/45, `aria-valuenow` 65 →
55), which a `role="separator"` grep cannot distinguish from a hand-rolled div
that resizes nothing — and `sg2.json`'s first mutation swaps in precisely that
div and shows the suite go red.

```premise SG3
# The SeedID CONTROL exists exactly once today, under Variation Policy -> Advanced
# (`PolicySection.tsx:443`). SG3 MOVES it to the Template panel. The fence asserts the
# count, so duplicating rather than moving is caught: 1 through a correct move, 2 on
# the failure this guards.
#
# The probe counts `aria-label="Seed"`, NOT the word `Seed`. The first draft of this
# fence counted files containing `Seed` and FAILED ON ITS OWN FIRST RUN at 2 -- because
# `BriefEditor.tsx` imports `takeSeed` from `create-campaign`, which is the create
# stash (D109), a completely different seed. Counting the word would have made this
# fence permanently red for a reason unrelated to the lane. Measured: ~30 ms.
test "$(grep -rl 'aria-label="Seed"' apps/web/src --include='*.tsx' | grep -vc __tests__)" -eq 1
```

---

## 8. The run gate (owner's correction, 2026-09-17)

**The owner records that putting Generate in the top header was a decision made in error.** This section supersedes parts of SG-D4, SG-D8 and SG-D9.

### 8.1 What is decided

| ID | Decision |
|---|---|
| **SG-D10** | **Generate leaves the top header.** It moves into the editor's own toolbar, following the **grid toolbar pattern** (`CommandBar`). |
| **SG-D11** | **The verb is `Validate` until the brief has been validated, then `Generate`.** One slot, two verbs — never a disabled Generate. |
| **SG-D12** | **`Validate` runs the validation and reveals the validation view.** |
| **SG-D13** | **The segmented control offers `editor │ validate`; YAML is a menu item.** *Amended 2026-09-18 by the owner, superseding this decision's own "grows to three".* The owner: *"The yaml view displays the code configuration for the creative and is **only intended for importing and exporting** the configuration… tuck it in as a menu item in the three-dots menu within the middle panel toolbar."* A utility for moving configuration in and out is not a co-equal way of looking at the brief, and giving it a third of the primary control over-promoted it. The column can still **show** three views — `ColumnView` keeps `yaml`, and a stored `"yaml"` still restores — but the **switcher offers two**: `COLUMN_VIEWS` and `ColumnView` stopped being the same set, so `isColumnView` now validates against the total label record rather than the switcher's list (reading `COLUMN_VIEWS` there was correct until this change and strands an operator the moment it is not). While YAML is up **no segment is pressed**, because leaving `editor` pressed would state in the one attribute a screen reader reads that the form is on screen while the document is; the switcher is the way back. **Not built, and recorded rather than assumed:** the import/export flow itself. The owner named YAML's *purpose*, and asked only that it be tucked into the menu. |
| **SG-D14** | **The validation view carries a refresh icon** to re-run the validation. |
| **SG-D15** | **Any update to the editor reverts the verb to `Validate`.** A prior validation does not survive an edit. Keyed on the `state` reference — see §8.4. |

### 8.2 Why this fits the existing principle rather than breaking it

Both surfaces already refuse to disable their verb, and say so:

- `Header.tsx:197` — *"D3 / DESIGN.md §5: Generate is never disabled, so with nothing committed it answers out loud instead of sitting dead."*
- `CommandBar.tsx:136` — *"The verb is never disabled for being invalid (GB-D3) — the press is how a user asks what is wrong, so every state answers."*

**Swapping `Generate` for `Validate` is not disabling the verb — it is always offering a meaningful one.** The owner's design is the same principle carried one step further: instead of pressing a verb to be told what is wrong, you press the verb *whose job is to tell you*.

### 8.3 What moving Generate costs, and what it simplifies

`handleGenerate` (`Header.tsx:235`) carries three behaviours that must move rather than vanish:

| Behaviour | Fate in the editor's toolbar |
|---|---|
| **D35 three-way** — editor mounted and its draft differs from the shell brief ⇒ *"which brief do you want to run?"* | **Collapses.** In the editor's own toolbar there is no ambiguity: the brief on screen is the brief. One question disappears. |
| **D3 fallback** — nothing committed ⇒ say what is missing and route to `/brief` | **Simplifies.** The header could not scroll a section it does not render, so it routed. The editor's toolbar *can* scroll it — `refuseInvalid`'s third act (attempted → reveal → scroll) becomes reachable without a route change. |
| **`guardedAction` over the whole gesture** — *"Leave is consent to Generate; Stay cancels both"* | **Must be preserved.** This exists so a user answering *Leave* does not land on the grid with nothing running. It is the subtlest of the three and the easiest to drop by accident. |

So two of the three get simpler by moving. **The third is a regression risk and the lane must pin it with a test.**

### 8.4 Validation becomes stateful — **answered**

Today validation is **derived**: `validate.ts` recomputes from `state` on every render, so it is never stale by construction. *"Has not been validated"* and a **refresh** button imply the opposite — a result that exists, can be re-run, and can go out of date.

**STAMPED (owner, 2026-09-17): any update to the editor hides `Generate` and surfaces `Validate` again.** A prior validation does not survive an edit.

#### The mechanism — and two wrong answers I proposed first

The requirement is exact: validation is fresh iff nothing has changed since it ran. It took three attempts to key that correctly, and the two rejected keys are recorded because each looks right.

**Rejected 1 — `previewRailKey` (my first recommendation).** Wrong because it is *deliberately* narrower than validation's input. `preview-props.ts:185-192` fingerprints `rawRailProps` + `previewFetchKey(brief, productId)` + the identity axis — the **look and the fetch inputs**, built by CC1/CC2 precisely so a look-preserving keystroke does **not** refetch. A change to the seed, to `minDistance`, or to a policy axis need not move it, and validation cares about all three. Keying on it would leave validation looking **fresh after an edit that changed validity** — the exact bug this decision exists to prevent.

**Rejected 2 — the `draftBrief` projection.** Closer, and still wrong. `toBrief(state)` is what `Save` sends, so an **invalid** value can be dropped or clamped on the way out: type a bad `count`, and the projection may be byte-identical while validity changed. Same failure, one step subtler.

**Adopted — the `state` reference itself.** Validation is a pure function of `state`, so it is fresh exactly while `state` is unchanged:

```
validatedState === state   →  validated    →  Generate
validatedState !== state   →  stale        →  Validate
no stored result           →  unvalidated  →  Validate
```

Reference equality is sufficient and needs no fingerprint, no hash and no flag. Two properties of the existing reducer make it exact rather than approximate:

- **A real change returns a new object**, so any edit flips the comparison — which is the owner's requirement, verbatim.
- **A refused or no-op action deliberately stays identity-equal** (`editor-state.ts:744`, `:1155-1156` — *"A flip to the same mode changed nothing — keep the state identity-equal, the way a refused action stays identity-equal"*). So a rejected keystroke does **not** invalidate a good validation, which is correct: nothing changed.

**Explicitly not a boolean `isValidated`.** A flag must be cleared by every writer that can invalidate it, and the writer that forgets is the bug. There is no such flag in `editor-state.ts` today and none should be added.

### 8.5 Consequences for lanes already recorded

- **SG7 is retired.** The validation view is a middle-column view reached by the segmented control, so the `Problems` tab in the telemetry drawer is redundant. **SG-D9's analysis still stands and is worth keeping**: the drawer's log is `LogEntry[]` of the last run's events and was never the right data model for validation — that reasoning is why validation gets its own view rather than borrowing one. The drawer stays telemetry-only.
- **SG4 is revised** — the segmented control it builds has three positions, not two (SG-D13).
- **SG8 is revised** — the Generate pre-flight now lives behind the toolbar's `Generate`, not the header's.

### 8.6 New lanes

| Lane | Owns | Depends on | Ships |
|---|---|---|---|
| **SG9** | `Header.tsx`, the editor toolbar | SG-D10–SG-D12, SG-D15 | **Generate leaves the header; the toolbar gains the `Validate` → `Generate` slot.** Must preserve `guardedAction`'s whole-gesture contract and pin it with a test. |
| **SG10** | the validation view | SG-D12–SG-D14, SG5 | **The validation view** — every error including the ones shown inline, each row a control that reveals its field, plus the refresh. Reached by `validate` on the segmented control **and** by pressing `Validate`. |

**Order.** **SG9 ‖ SG10** (disjoint: one is the toolbar, one is a new view), both after **SG1** retires `guided`.

---

## 9. Panel access at every width (owner, 2026-09-17)

**STAMPED: all three panels must be reachable at every width.** This settles the narrow-width regression CC3 declared and Qodo independently found on #474.

### 9.1 What was wrong

The rail is gated on `@container(min-width:56rem)` — **measured at 1264px of viewport**, because the container is `viewport − 368px`. CC3 made the rail the only home for the layer stack (§4.6's one-stack invariant), so below that width there was **no layer editing at all**. `MobileMenu.tsx:9` already shares `SidebarContent`, so the **left** panel has a narrow-width home; the **right** panel never had one.

### 9.2 What hexagen does, and what we take from it

`~/Projects/hexagen-monaco/apps/web/features/manifest-generation/ManifestPreview.tsx:100` states its own rule:

> *"Desktop (md+) shows the resizable YAML column; below md it's hidden and the YAML lives in the mobile overlay, so the PanelGroup is desktop-only."*

| Width | hexagen |
|---|---|
| md+ | `PanelGroup` + `ManifestResizeHandle` |
| below md | panel `md:hidden`; content moves to a full-screen overlay opened by a **dedicated floating button** (`fixed bottom-16 right-4`, `aria-controls`) |

**Taken: the principle** — the same content, relocated rather than removed, with an explicit control.
**Not taken: the floating button.** Two reasons: this editor's action bar already occupies `sticky bottom-6`, so a floating toggle contends for that corner; and with three panels it means three floating controls.

| ID | Decision |
|---|---|
| **SG-D16** | **Below the breakpoint, the segmented control carries the panels.** SG-D13 already gives the middle column `editor │ yaml │ validate`; below the breakpoint it also offers the left and right panels. One control, one tap, already in the design, no new pattern, no corner contention. The hamburger keeps the **route tabs** — it does not become a menu of menus. |
| **SG-D17** | **The resizer is `react-resizable-panels`.** hexagen ships `^2.1.4`; `PanelResizeHandle` is already a focusable `role="separator"` and keyboard-resizable, which **is** SG2's acceptance criterion — so the keyboard contract comes from the library rather than from us. **This is a new dependency and is called out as one.** |
| **SG-D18** | **CC3 (#474) merges with the gap, and SG11 repairs it next.** The regression is real, recorded, bounded to <1264px, and short-lived. Shipping the layers panel at desktop width is worth more than holding it; **SG11 is dispatched before any further middle-column work.** |
| **SG-D21** | **The validation view wears the log panel's chrome; the drawer keeps its data.** The owner asked to reuse the telemetry drawer as the validation screen. §8.5 already recorded — via SG-D9 — that the drawer's `LogEntry[]` was never the right data model for validation, and that reasoning stands: `TelemetryDrawer` binds to `useRun()` and renders run-shaped rows (`timestamp`, `stage`, `level`), a validation error is a section-bucketed field message **no run produced**, and the drawer is a floating overlay where the validation view is a middle-column view. So the reuse is the **chrome**: a domain-free `LogPanel` in `@campaignfoundry/ui` carrying the header row, the Copy control and the scrolling monospace body, with `TelemetryDrawer` reduced to `LogPanel` + `useRun` + its own position and `inert` behaviour. The owner's intent — same look, same affordances, every error including the inlined ones collected in one place — is met by the panel; the data binding stays per-consumer, and **no row invents a timestamp or a stage it does not have** (D26), because a fabricated stage would make the Copy control emit a log claiming a run that never happened. **Shipped by LP1.** |
| **SG-D22** | **`Generate` runs the projection it validated, passed explicitly.** SG-D15 flips the verb on any edit, but freshness alone is not sufficient: a bare `execute()` runs the **committed** brief, so an operator who validates a clean draft and presses Generate would spend GenAI credits on the stale committed document — D35's *"which brief?"* silently answered wrong rather than dissolved. The editor therefore calls `execute(draftBrief)` — the projection — so the run is byte-identical to what the gate validated **by construction** rather than by inference about what the shell happens to hold. It does **not** `setRunBrief`: `cf:brief` is D37's last-opened *pointer*, so committing a never-saved draft's id would route a later reload into M3's "no such brief"; the run records its producer as `CommittedRun.target` (R6) instead. A deliberate credit-spending confirm (after `CommandBar.tsx:164`) is the gesture's consent, so the dirty guard is not asked twice. *Amended 2026-09-18: this decision was first stamped as "validated **and** applied", and SG9 refuted that with a mechanism — `appliedSnapshot` is written only by `load` and `save`, so `applied` is false for any draft with unsaved edits, i.e. the normal flow. Generate would never have appeared after a clean validation: a live-looking button that answers nothing, which is worse than the disabled one D3 existed to prevent. Passing the target also gives the stronger guarantee and preserves GB-D3's run-without-write, so a brief never written to disk stays runnable.* |

### 9.3 Lanes

| Lane | Owns | Depends on | Ships |
|---|---|---|---|
| **SG11** | the segmented control, `MobileMenu.tsx` | SG-D16 | **Panel access below the breakpoint.** The left and right panels become positions on the segmented control; the right panel's content is shared the way `SidebarContent` already is, so one definition serves both widths. |

**Red fault for SG11:** at a viewport below 1264px a test reaches the **layer stack** and the **preview** through the control and asserts both render; removing either position makes it fail. And **exactly one stack stays mounted** — the §4.6 invariant must survive being reachable from two places, which is the trap this lane could introduce.

**SG2 is revised** by SG-D17: it wraps `PanelResizeHandle` rather than writing pointer and keyboard handling. **Shipped in `#482`.** Its bound stands in a new form: the "own threshold" it named was the container query, which RS2 deleted, so the floors are `minSize` on both panels (rail 25%, main 50%). Two consequences worth recording. **The group holds only the two resizable columns, not the left sidebar** — the library converts pointer travel into a percentage of the *group's* width while a panel renders as a percentage of what the group has left to distribute, so enclosing the 320px sidebar and the row's gaps would make the divider lag the cursor (~72px per 100px at 1280px). **And the sizes are percentages, not pixels** — v2 removed the pixel unit, so the rail's 35% is ~320px at 1280px and proportionally wider on a larger screen.
