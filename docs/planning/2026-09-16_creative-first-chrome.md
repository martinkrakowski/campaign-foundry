# Creative-first chrome — widening the rail that already exists, and putting the creative's own controls in it

**Date:** 2026-09-16 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Revision:** second draft. The first was **blocked in review** for asserting things about the tree that were false; §0
records what it got wrong, because the corrections are the plan.
**Source:** the owner's diagram (`~/Desktop/brief-screen-flow.png`) and the intent stated with it — *"the user is
actually working on the creative within each step, instead of form selections whose effect is vague until the final
screen."*
**Relationship to `2026-09-16_studio-editor.md`:** that plan's kernel (one document, one reducer, domain functions as
the UI rules) and its §9 contracts (reducer actions with coalesce keys, canonical-form duties, the gesture and
assistive-technology contract) **govern here by reference**. This plan supersedes only its chrome *layout*.

---

## 0. What the first draft got wrong (verified at `origin/main` `c2ceb87b`)

Stated first because every lane below is a correction of it.

| Claim in draft 1 | Truth |
|---|---|
| "The preview moves out of the dock into a persistent rail" | **The rail already exists.** `BriefEditor.tsx:1661-1731` renders `<aside role="complementary">`, sticky, with a preview/YAML switcher. The work is not building a rail; it is changing **when** it appears and **what it holds**. |
| "No YAML projection exists" (and a fence guarding it) | **It ships.** `BriefEditor.tsx:1723-1727` renders `dump(draftBrief)` in the rail, per D61, pinned by a test. The proposed CC4 lane was already done. |
| "`BriefId` does not exist before the first save" | **It exists.** `editor-state.ts:311,1290` derives it, `IdentitySection.tsx:216-259` shows and copies it. |
| "Ratios are not chosen directly today" | **Half wrong, and the other half matters.** `toggleRatio` (`editor-state.ts:539,1734`) writes `variation.ratio` through `RatioPanel` (`PolicySection.tsx:179`) — but Policy is only in `sectionOrder("variation")` (`sections/index.ts:43-48`), so in **brief mode the control is unreachable**. The diagram draws ratio tiles for a static draft, which today has nowhere to set them. |
| "A centred modal is the main accessibility risk" | The deeper risks are **cost and undo**, below. |

**The lesson, recorded so the next plan does not repeat it:** the first draft verified the one thing it expected to be
dangerous (the preview's credit wiring) and asserted the rest. A plan that says "verified at `<sha>`" must have looked
at each claim.

---

## 1. Findings that actually constrain this work

| # | Severity | Finding |
|---|---|---|
| **C1** | Critical | **The rail is deliberately conditional.** It renders only when `presentation === "guided"`, the step is neither `review` nor `layout`, `railProps !== null`, and the container is at least `56rem` (`BriefEditor.tsx:1657-1664`). The comment states why: **D43 — exactly one composed preview on screen**, because Review owns the figure and Layout carries its own frame (D63). "Always visible" therefore contradicts a recorded decision in three specific places, and each needs a disposition (see **D141**). |
| **C2** | Critical | **The rail cannot render until the first product has an id.** A fresh draft *does* carry a product — `emptyProduct(1)` (`editor-state.ts:597`) — but its `id` is `""`, and `previewLook` returns `null` for that (`preview-props.ts:53-55`) because a fabricated colour is "exactly the invention D26 forbids". So *"open `/brief/new` and see the creative"* is impossible as written. The empty state's copy must name the **id**, not ask for "a product" — the Products step already shows one, and telling the operator to add what they can see is worse than saying nothing. |
| **C3** | Critical | **An always-on rail changes the cost of every keystroke.** `draftBrief` and `railProps` both derive from the whole `state` (`BriefEditor.tsx:589-595`); `usePreviewFrame` re-fetches on `brief` identity with a 300 ms debounce (`preview-frame.ts:8,83-126`); the client's abort does **not** stop the server, which finishes compositing (`preview-frame.post.ts:178`); the frame cache is an LRU of **32 entries, process-wide** (`preview-frame.post.ts:55`); and motion runs at 30 fps (`MotionKind.vo.ts:7`), so a 6-second clip has ~180 distinct frame keys. Adding a preview, a timeline, a layer list and a sheet as children of the editor's single commit makes each of them re-render on every character typed. |
| **C4** | Critical | **The template library does not exist.** `apps/api/server/lib/ports/{template-store.port.ts,fs-template-store.ts}` is a read-only store seeded from the canonical templates (L7a1); the reconciliation plan records the library itself never shipped. **Browse** is that lane (D123), not a picker lane. |
| **H1** | High | **The type binary has no home in the model.** `CreativeTemplate` and `BriefTemplate` carry `{id, version, name, unit, creativeType, layers}` — **no platforms, no mode**. Meanwhile `2026-09-06_create-dialog-recomposition.md:453` (C5) explicitly *declined* static/motion tiles in the dialog, and D120 says the campaign type stays the dialog's second field, with `validateTemplate(value, type)` deriving the template **from** the type (`load-brief.ts:197-208`). Reversing that direction is a domain lane, not a chrome lane. |
| **H2** | High | **The shell already owns a left sidebar** — 320 px, `lg:flex` (`Sidebar.tsx:19`), carrying mode, outline, estimate and policy, published from the editor (`BriefEditor.tsx:835-841`). The diagram's left rail is that sidebar. Three columns plus it is **four**. |
| **H3** | High | **A cancellable sheet implies a transaction the reducer does not have.** History is baseline / server-answer / coalesced edit (`editor-history.ts:122-168`), numeric inputs commit on every finite keystroke (`HtmlElementsEditor.tsx:114-124`), and `⌘Z` is ignored while an `aria-modal` overlay is open (`editor-history.ts:226-233`). A sheet that writes as you type and then offers Cancel would need an undo stack it does not have. |
| **M1** | Medium | **Two other surfaces already render a composed frame** — `LayoutSection.tsx:143` and `ReviewStep.tsx:223` — which is exactly why the rail is suppressed there. A rail on those steps means two frames per edit and breaks D43. |
| **M2** | Medium | **`SeedID` has no rail control today** — it is `state.variation.seed`, surfaced in Policy for Randomized mode only (`PolicySection.tsx:388-405`). |
| **M3** | Medium | **Five tests pin today's rail behaviour** (`brief-editor.test.tsx:3358,3374,3385,3406,3581`): suppressed on Review, absent in Everything, absent without a product, the YAML view, and the Layout step's own frame. Any change to the rail's scope rewrites them, each with a stated reason. |

---

## 2. Decisions — answered by the owner on 2026-09-16

The owner **adopted the recommended default for each** on 2026-09-16 (recommended defaults, twice plan-reviewed). Lanes may be dispatched against them.

| ID | Question | **Decision (owner, 2026-09-16)** | Why |
|---|---|---|---|
| **D141** | **Where may the rail appear?** Today: guided only, not on Review or Layout, ≥ 56 rem. The diagram implies always. | **Widen to all three presentations — `guided`, `everything` and `studio` (D137) — and to every step except Review and Layout**, keeping the container query. **This amends D43**, which reads "the dock mounts in Guided only and is suppressed on the Review step" (`r7-preview-panel.md:39`): the *count* invariant (exactly one composed preview) is kept; the *Guided-only* clause is dropped. The rail's own comment (`BriefEditor.tsx:1634-1637`) and the test titled for Everything (`brief-editor.test.tsx:3374`) must cite the amendment. **In `everything` there is no step cursor** — `stepIndex` is stale outside guided — so the step gate does not apply there, and `previewDockProps`' step readout (`preview-props.ts:107-109`) must not show a guided cursor in that presentation. **In `studio`, whether the Layout step still owns its own frame is undetermined** (`studio-editor.md` §10 leaves it open); CC1 must settle it or state that SE0 is superseded. | The count invariant is what D43 exists to protect; the Guided-only clause was a scope choice, and this is the smallest amendment that delivers the intent. |
| **D142** | **What does the rail show before a product exists?** | **An explicit empty state** naming the missing **product id** — not "add a product", which is wrong on the Products step where a stub is already visible — and never a fabricated placeholder creative. | D26 forbids inventing what the compositor has not painted; `previewLook`'s `null` is that rule in code. |
| **D143** | **Where do layer properties get edited** — a centred modal, or a sheet docked over the middle column? | **A sheet over the middle column, not `aria-modal`.** It leaves the creative visible, and a non-modal sheet keeps `⌘Z` working and does not swallow the guided walk's arrow keys. **Edits apply live** (no Cancel), which matches every other control in this editor and avoids inventing a transaction. | H3. A Cancel button implies a rollback the reducer cannot do; "live, undoable" is the contract the rest of the editor already has. |
| **D144** | **Does the create dialog's Static / Video-motion binary replace the four campaign types?** | **No — keep all four, and group the existing tiles by format.** The dialog already renders one `OptionTile` per `CAMPAIGN_TYPES` (`CreateCampaignDialog.tsx:332-350`); this is a **regrouping, not a replacement**: a *Static* group holding `social-post`, `paid-social` and `display-ad`, and a *Video/motion* group holding `short-video`. Two tiles mapping to two presets would make `paid-social` and `display-ad` unreachable, which contradicts "keep the four types". `applyPreset` still runs once, and the motion group's `mode: variation` comes from `CAMPAIGN_TYPE_PRESETS["short-video"].mode` (`campaign-types.ts:55-61`) through `setMode` — **the dialog never sets mode itself** (D110, D99). | H1: templates carry no platforms or mode; C5 (`create-dialog-recomposition.md:453`) declined static/motion tiles once already; D120 fixes the type→template direction. Grouping delivers the diagram's two-choice feel with **no domain change and nothing made unreachable**. |
| **D145** | **Does the rail's timeline replace the Timeline section's form, or sit beside it?** | **Beside it.** The rail gets the ruler and playhead; the form stays the precise editor for beat text, weight and key beat. | The form is correct and tested; a ruler is a different instrument, not a replacement. |

---

## 3. Lanes

Each lane changes the rail that exists. None builds a second one.

| Lane | Depends on | Ships | Proof |
|---|---|---|---|
| **CC2 → CC1 — shipped in this PR**<br>*(cost first, then scope)* | D141, D142 | **Rail scope and its cost together.** Scope: all three presentations, every non-Review/Layout step, an explicit empty state while the first product's `id` is `""`. Cost, in the same PR: (a) the aside is **mounted and fetching below `56rem` today** — the container query is CSS visibility (`hidden … [@container(min-width:56rem)]:flex`), so a rail nobody can see must stop fetching; (b) the fetch keys on `brief` **identity** (`preview-frame.ts:83`) while `draftBrief` is a new object per state change (`BriefEditor.tsx:589`), so typing an unrelated field fetches a frame — key on what the frame depends on; (c) the rail subtree is memoised on a preview/layer slice, not `EditorState` — and that requires **changing how the rail is fed**: `draftBrief` and `railProps` are `useMemo(…, [state])` and `previewDockProps` returns a fresh object every call, so a child `memo` cannot bail out today. Memoise the preview and layers, **not** the YAML view, or the YAML goes stale. `toBrief(state)` still runs per keystroke; if that stays, say so as an accepted cost. | **A look-preserving keystroke issues zero `/preview-frame` calls** (the gate is network calls, not re-renders — a keystroke that changes nothing visible must not reach the server); zero calls while the YAML view is showing; exactly one **mounted** composed frame per presentation × step — the proof must count mounts, not visible SVGs, because the container query hides without unmounting and today's tests (`brief-editor.test.tsx:3368,3594`) cannot tell the difference. Typing in `targetAudience` issues **no** frame request. Nothing fetches below the breakpoint. |
| **CC3**<br>**closes SE1** | CC1+CC2 | **Layers in the rail**: select / toggle / reorder / add / remove from the existing derivations. **Disposition is fixed, not a choice: `TemplateSection` stops rendering the stack** and the rail becomes the only one. | One stack in the tree, asserted; offers come from `addableKinds` / `removableLayerIds`; selection is ephemeral (D139). Retires the studio plan's SE1 fence. |
| **CC4**<br>**closes SE2** | CC3, D143 | **The layer sheet**: live geometry props and the html element editor in a **non-modal** sheet — **a new container, because every existing shell sets `aria-modal="true"` and traps focus** (`dialog-shell.tsx:271,279,320,328`), which disables `⌘Z` (`editor-history.ts:226-233`). Its keyboard contract, stated here because neither plan covers it: no focus trap, Tab reaches the rail, Escape dismisses (nothing to roll back), and arrow keys inside the sheet do not change step. Mounted mounted as a **sibling of the step card and never inside `renderStepCard`** (D44 — the card renders two live copies during a step change and its `transform` traps overlays). Ships `setLayerProps` with the coalesce key and `canonicalLayer` duty from `studio-editor.md` §9.1. | Creative stays visible with the sheet open; `⌘Z` still undoes; set-then-clear leaves the brief byte-identical. Retires the SE2 fence. |
| **CC5**<br>**closes TL1** | CC1+CC2, D145 | **The timeline in the rail** for motion drafts, one playhead shared with the preview, **keeping the live/committed split** (`PreviewDock.tsx:178-219`). | **Assert pointermove vs pointerup on the ruler**: a drag issues no `/preview-frame` call until release, and the live position is never passed as `atSec` (`preview-frame.ts:95` refetches on any `atSec` change and cannot see a pointer). "Equals the encoded frame" is already a compositor test and is not restated here. Retires the TL1 fence. |
| **CC6** | D144 | **Shipped in this branch.** Regrouped the dialog's existing four tiles under Still images (`social-post`, `paid-social`, `display-ad`) and Video (`short-video`) headings derived from `formatDisplayName` in `display-names.ts`. Kept `role="group"` with `aria-label` matching each heading (rather than `<fieldset>`/`<legend>`) within the named `createTypeLabel` group, avoiding browser layout and legend styling quirks while ensuring explicit accessible names for screen readers. | All four types remain reachable; `applyPreset` still runs exactly once; the motion group's `mode: variation` still comes from the preset, not the dialog. Mutation verified (`display-ad` into motion caught). |
| **CC7** | **the template library (D123)** | **Browse** over a real library. | Not scheduled here; the library is its own plan. |

**CC2 → CC1 — shipped in this PR.** `premise CC1` is retired (§5). The fetch key: `previewFetchKey(brief,
productId)` (`apps/web/src/lib/preview-frame.ts`) — a content fingerprint, never `brief`'s object identity —
covering the previewed product's colour/logo (matched by `productId`, not the whole `products` array),
`localizedMessage ?? campaignMessage`, `style`, `template`, `output.platforms`/`sizes`, `copy.timeline`, and the
`variation.axes` background-source/duration the dock itself reads. `usePreviewFrame`'s `request` memo depends on
this key plus an `identityAxis` (`identityKey ?? brief.id`) instead of `brief` by reference, so a keystroke in a
field the frame does not read (`targetAudience`) fires nothing, while FI1's identity-clearing contract (a
not-yet-saved draft keys on `tempId`, a saved brief still clears on a real id change) is preserved by construction
— `identityAxis` is that same value. The memo boundary: `BriefEditor` computes `previewKey =
JSON.stringify(rawRailProps) + previewFetchKey(draftBrief, product.id)` and uses it (not `[state]`) to memoise
both `railProps` and `previewBrief`, which feed the now-`memo`-wrapped `PreviewDock`; the YAML view keeps reading
the live `draftBrief` (D61 — it must never go stale). The breakpoint: `useMinInlineSize` (a new hook,
`apps/web/src/lib/use-min-inline-size.ts`) mirrors the row's `@container(min-width:56rem)` query in JS via
`ResizeObserver` on the same container, seeded from `window.innerWidth` (ResizeObserver reports asynchronously and
never fires under happy-dom); below it the rail still MOUNTS (D43's count invariant is about mounting, not CSS
visibility) but is not fed a `brief`, so nothing fetches. **Accepted cost:** `toBrief(state)` still runs on every
keystroke (YAML view, `draftDiffers`, Save, Review all need the live projection), and the memo key adds one
`JSON.stringify` of the look per render on top of it — bounded, not eliminated. **Studio decision (§10 of
`2026-09-16_studio-editor.md`, recorded there too):** the rail's step exclusion is `presentation === "guided" ?
(review/layout gate) : true` — presentation-agnostic outside Guided by construction — so when SE0 lands `studio`,
that presentation inherits "no step-based exclusion" automatically UNLESS SE0's own Layout arrangement renders
`<LayoutSection preview />` (its own frame), in which case **SE0 must extend the guard to `presentation ===
"guided" || presentation === "studio"` itself**, or D43's one-composed-frame invariant breaks there. SE0 is not
superseded; this is a requirement on it, not a hope.

**Order.** **CC2 lands the feed/memo/fetch contract on the rail that exists, then CC1 widens it** — cost before scope, because CC1 is the cost-increasing change. Then CC3 → CC4 ‖ CC5 → CC6. CC7 is gated on the library.
**Why one PR:** CC1 alone widens a *fetching* rail into Everything — going from zero frames to one there — so shipping scope before cost would knowingly regress the margin three lanes (X30, X32, X34) were just spent recovering.

---

## 4. Definition of done

1. In every presentation and every editing step, the creative is on screen — and on Review and Layout, exactly one composed frame still is.
2. Before a product exists, the rail says what is missing and invents nothing.
3. A keystroke commits the rail subtree at most once, and fetches no frame while YAML is showing.
4. Changing a geometry prop in the sheet changes the creative, is undoable with `⌘Z`, and set-then-clear leaves the brief not dirty.
5. Dragging the rail's timeline fetches a frame on release, not per pixel, and that frame equals what generation draws.
6. The layer stack exists exactly once in the tree.
7. The preview never calls a paid generator — asserted on the route's wiring, not only its output (D52).

---

## 5. Premises

`premise CC1` retired: CC1/CC2 shipped (§3), and the conjunction it anchored to
(`presentation === "guided" && steps[stepIndex] !== "review"`) no longer exists —
the rail's gate is now `presentation !== "guided" || (steps[stepIndex] !== "review" &&
steps[stepIndex] !== "layout")` (`BriefEditor.tsx`), which is presentation-agnostic
outside Guided by design (D141).

```premise CC3
# The layer stack is still rendered by the template section. CC3's disposition is
# fixed (the section stops rendering the stack), so this flips exactly when the lane
# ships -- the earlier "host or retire" wording would have left it holding forever
# under one of its own sanctioned outcomes.
grep -qE '(layers|template)\.layers\.map' apps/web/src/components/campaign/sections/TemplateSection.tsx
```

```premise CC4
# The html element editor is still mounted inline in the stack row, so no sheet hosts
# it. Counting its non-test mount sites is the mechanism: the component itself plus
# the stack row is two today, and CC4's sheet is necessarily a third. This is the
# SHEET's fence; the reducer-action half of CC4 is SE2's fence in the studio plan,
# and the two are not duplicated here.
test "$(grep -rl 'HtmlElementsEditor' apps/web/src/components/campaign | grep -vc '__tests__')" -le 2
```

## 5a. Renaming a fresh draft blanked the preview frame — fixed (FI1)

Frame identity includes `brief.id` (`apps/web/src/lib/preview-frame.ts`), and `patch` rewrites `briefId` from the
campaign name on a new draft (`apps/web/src/components/campaign/editor-state.ts`). Renaming a fresh draft that has a
product therefore used to blank the frame on every keystroke.

**Fixed in this PR** at `usePreviewFrame`: a new draft keys identity on `source.tempId` (the editor's stable draft
key, passed as `identityKey` from `previewDockProps`) rather than the live slug, so a re-slug is not a switch of
creative. The identity tuple is otherwise unchanged. A loaded brief still keys on `brief.id` and still clears.
CC1/CC2 no longer inherit this: §5a's own instruction was "fix it in that PR or record it as a gap with its own id",
and this lane is that id.

Cite: §5a in docs/planning/2026-09-16_creative-first-chrome.md

---

## 6. What this plan does not decide

- **The template library** (D123) — CC7 waits on it.
- **Whether the diagram's left rail replaces the shell sidebar** (H2). They hold the same things; merging them is a shell lane with its own review.
- **Editable YAML.** The read-only view ships (D61); editing needs a decision about text that is not yet a valid brief. The diagram also places the Visual/YAML switch over the **middle** column, where the creative stays visible beside it — the opposite of D61's exclusive rail view. That placement change is its own lane.
- **The column resizer.** Neither plan's gesture contract covers it. If it ships it must match the gesture set the guided walk yields to — `[role="slider"]`, `input[type="range"]` or `[draggable="true"]` (`use-step-navigation.ts:159-167`); a bare `role="separator"` is swallowed by the step swipe. Its width also needs a persisted key.
- **SeedID.** Stays in Policy (`PolicySection.tsx:388-405`), Randomized only. The diagram draws it in the left rail, which is the shell sidebar (H2) — so it moves only if that merge happens.
- **Where `save/next` lives** — the middle column has a step footer whose Next never saves, and the editor has its own Save verbs. Three verbs cannot become one without naming which survives.
