# The wireframe gap — what the owner drew, and what the editor actually is

**Date:** 2026-09-17 · **Status:** draft. **Six decisions need the owner.** Nothing dispatched.
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
| **SG-D7** | **If `mode` is retired, is `count` at its ceiling *exhaustive*?** | (a) Verify and rely on it — at `count = axisProductSize` the draw enumerates the space, so no separate concept is needed. (b) If it merely samples to that size, add an explicit exhaustive path. | **(a), pending one verification — and note this question is much smaller than it first looked.** A first draft of this row claimed `count` was capped at 48 and that "count = everything" was therefore inexpressible. **That was wrong.** `editor-state.ts:734` sets the ceiling to `axisProductSize(state)` and clamps `count` to it, so the ceiling **is** the cross-product size and the 48 in the owner's editor was simply their axis space. "Give me every combination" is already sayable: count at maximum. What remains is a property to **verify, not assume** — whether `executeVariation` at `count = axisProductSize` enumerates the space exactly once or samples to that size under `minDistance`. If it enumerates, retiring `mode` loses nothing. **A lane must prove this with a test before SG-D1 is implemented**; it is the one place the retirement could silently drop a guarantee. |
| **SG-D2** | **Middle column: lean form or six-step wizard?** | (a) Reduce to the wireframe's four controls, moving the rest into the right column and the template panel. (b) Keep the wizard, and let `studio` be the lean presentation while `guided`/`everything` keep the steps. | **(b).** D137 already makes `studio` a third presentation rather than a replacement. Deleting the wizard would strip the only surface that currently reaches Products, Policy and Output. This is the biggest-scope decision here. |
| **SG-D3** | **Does the column resizer persist, and what are its bounds?** | (a) Ephemeral, resets on reload (like zoom, D147). (b) Persisted per-operator in `localStorage` beside `cf:presentation`. | **(a) Ephemeral**, matching D147's reasoning for timeline zoom: a pane width is not a property of the campaign, and a persisted width surprises a second operator on the same brief. Bounds must keep the rail above its `56rem` container-query threshold or the resizer becomes a way to hide the right column by accident. |
| **SG-D4** | **Where does `Visual │ Yaml` live, and what happens to `Guided │ Everything`?** | (a) Move the YAML switcher to the middle column as drawn; `Guided │ Everything │ Studio` moves elsewhere or merges. (b) Keep both where they are. | **(a), with the two toggles kept distinct**: `Visual │ Yaml` is *what the middle column renders*; presentation is *how much of it*. They are different axes and must not merge into one control — but the YAML switcher does belong over the content it controls, which is the wireframe's point. |
| **SG-D5** | **Left column: replace, or add a Template panel?** | (a) Replace the Campaign Brief accordion with the wireframe's Template panel. (b) Add Template as a new accordion section above the existing ones. | **(b) Add.** The shipped fields (Target Region, Aspects, Localized Copy) are live document fields with tests; replacing the panel would delete reachable UI for them. SeedID already exists under Variation Policy → Advanced and must be *moved*, not duplicated. |
| **SG-D6** | **Where do the layer stack and inspector sit?** | The studio plan's §3 specifies three panes (stack, inspector, canvas selection) but **never says which column they occupy**. The wireframe puts the layers container in the **right** column, under the preview and timeline. | **Right column, as drawn** — and this plan records it, because `2026-09-16_studio-editor.md` §10 leaves it open and SE0 cannot be dispatched without it. |

---

## 4. Lanes

**Most of this work already has a home.** This plan mints ids only for what no plan covers.

| Lane | Owns | Depends on | Ships |
|---|---|---|---|
| **SG1** | `BriefEditor.tsx`, `editor-state.ts` (`Presentation` union) | SG-D2, SG-D4 | **The `studio` presentation itself** — the third value D137 stamped, offered only when the draft can use it, never auto-selected, persisted under `cf:presentation`. Nothing else in this plan can be seen without it. |
| **SG2** | a new resizer component, `BriefEditor.tsx` row | SG1, SG-D3 | **The column resizer.** Pointer + **keyboard** (arrow keys, `role="separator"` with `aria-valuenow`), bounded so the right column cannot be dragged below its container-query threshold. |
| **SG3** | `CreateCampaignDialog.tsx` or the sidebar | SG-D5 | **The Campaign Template panel** — template name, `Brief`/`Variation`, BriefId (auto-gen, read-only), SeedID **moved** from Variation Policy → Advanced. |
| **SG4** | `BriefEditor.tsx`, `PreviewDock.tsx` | SG-D4 | **`Visual │ Yaml` over the middle column**, with presentation kept as a separate control. |
| *(existing)* | — | SG1 | **SE0–SE5** (layer stack + inspector) and **TL1–TL7** (time surface) from `2026-09-16_studio-editor.md`, now unblocked on SG-D6. |
| *(existing)* | — | — | **TS1** — PR #469. Merge it; it is the timeline the wireframe draws. |

**Order.** TS1 (merge) → **SG1** → then **SG2 ‖ SG3 ‖ SG4** are disjoint except for the `BriefEditor.tsx` row, which SG1 and SG2 both touch — so **SG2 follows SG1**, and SG3 ‖ SG4 run beside it. SE/TL lanes follow SG1.

**`BriefEditor.tsx` is the contended file in this repo.** It is 2000+ lines and four of these lanes want it. Nothing here may be dispatched in parallel against it.

---

## 5. Definition of done

Shared gate: CI, which runs every step. Per the repo's rule, each lane names the fault that must turn it **red**:

- **SG1** — `grep -rn '"studio"' apps/web/src` returns the union member and its guard; a draft without motion or an oversized template is **not** offered `studio`; selecting it persists under `cf:presentation` and survives reload; **it is never selected without a click**. Reverting the offer-guard makes a test fail.
- **SG2** — a keyboard-only user can resize the column (arrow keys move it, `aria-valuenow` changes); dragging to the extreme **cannot** push the right column below the `@container(min-width:56rem)` threshold, so the resizer can never silently hide the surface it exists to size. Removing the bound makes a test fail.
- **SG3** — SeedID appears **once** in the DOM. A test asserts exactly one control with that accessible name — the fault this prevents is duplicating rather than moving it.
- **SG4** — the YAML switcher toggles the **middle** column; presentation still toggles independently; a test drives both and asserts they do not interfere.

---

## 6. What this plan does not do

- **It does not delete the six-step wizard.** SG-D2 recommends keeping it; if the owner chooses (a), that is a separate plan with its own migration of Products, Policy and Output.
- **It does not restate SE0–SE5 or TL1–TL7.** They are specified in `2026-09-16_studio-editor.md`. This plan unblocks them (SG-D6) and orders them behind SG1.
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

```premise SG2
# No column resizer exists. The mechanism, not the word: the probe looks for a
# separator role, because `resize` alone matches a window listener and a comment
# that are both already present and would make this fence pass on a tree that
# has no resizer at all. Measured: ~40 ms.
! grep -rqn 'role="separator"' apps/web/src --include='*.tsx'
```

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
