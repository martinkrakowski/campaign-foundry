# Brief Flow Remediation — Architecture & Development Plan

**Date:** 2026-08-31
**Status:** Draft v1.0 — for review. Every finding in §1 was reproduced by execution against the live tree unless explicitly marked *inferred*; the three the user could see for themselves were re-verified by hand before this plan was written.
**Scope:** `apps/web` — the `/brief` editor's verbs, routing, status surfaces and preview; `apps/api/server/lib/brief-files.ts` — the YAML writer, which one decision here gates. **No brief-schema change and no domain change.**
**Related:** `2026-08-29_guided-brief-and-visual-system.md` (D19–D34, shipped across #128–#148), `2026-08-26_unified-campaign-editor.md` (UE-D1–D15), `2026-08-28_graphical-brief-editor.md` (GB-D1–D18), `DESIGN.md`. PRs merged since: #149, #151, #152, #153, #154.

---

## 0. What this plan answers

> *"The brief is still pretty flaky, I am unable to generate a campaign. When editing an existing brief, the brief-id should be in the url e.g. `brief/{brief-id}`. The preview pop up only shows a gradient-bg with unstyled small text in a random location. The preview pop-up is not dismissable. Clicking 'Apply to run' on the last wizard screen takes user back to the first slide, with no indication as to why. This is bad UX. There's a badge that remains highlighted 'draft not applied'."*
>
> *"Why do we have 'save, save as, and apply to run'? Those can be confusing to the user. Discard or cancel should take user back to grid."*

Six reports and one design question. All six reproduce. The design question has a sharper answer than "rename the buttons", and it is the spine of this plan:

**There is no plain "Save".** `SaveMenu.tsx:57` is a *disclosure button* that opens a two-item menu — *"Save & apply"* and *"Save as…"*. And **every persist path already applies**: `handleSave` dispatches `apply` and calls `setRunBrief` (`BriefEditor.tsx:648,651`); `handleSaveAs` does the same. So of the three verbs the user named, two do the same thing and the third — *Apply to run* — is the only one that does something the others do not: **run without writing to disk**.

That is the whole answer. There are **two ideas and four labels**. The user's confusion is not a copy problem; it is the UI exposing an internal split — the editor holds a draft, the shell holds the brief it will run — and asking the user to reconcile it by hand.

The second-largest finding is not on the user's list. **`CreativePreview` computes a font size and never applies it.**

---

## 0.1 Proposed Decisions

Continuing the D-numbering after **D34**.

| ID | Decision | Consequence |
|----|----------|-------------|
| **D35** | **The editor has two persist verbs and one exit, not four.** `Save` (writes the file **and** becomes the brief the shell runs), `Save as…` (the same, under a new id), `Cancel` (leaves the editor for the grid). **"Apply to run" is retired as a user-facing concept** — it names an implementation detail of "the shell needs a brief to run". | Verified safe on the shell side: `run-context.tsx:536`'s `briefApplied` is derived from the identity of the brief the provider holds, **not** from the editor's `appliedSnapshot`, and `Header.tsx:74` gates Generate on that alone. Loading a brief already satisfies the gate. `setRunBrief` and `briefApplied` do not move. |
| **D36** | **D35 does not ship until a save is non-destructive.** Collapsing Apply into Save removes *run-without-write*, so previewing a change costs a file write. Today `brief-files.ts:39` writes through `js-yaml`'s `dump`, which **discards every comment and all hand-authored formatting**. Replace it with the `yaml` package's Document API (`parseDocument` → `setIn` → `toString`), which round-trips both. | This is the gate, and it is the reason D35 is not a one-line copy change. Until a save preserves what the user wrote by hand, making saving the only way to see a change is a downgrade. Ships **before** D35, in its own lane, with a corpus test over `briefs/*.yaml`. |
| **D37** | **A brief's identity lives in the URL.** `/brief/[id]` for an existing brief, `/brief/new` for a new one. The route is the source of truth for *which brief is open*; `cf:brief` in `localStorage` stops being the addressing mechanism and survives only as a "last opened" convenience, if at all. | Fixes the user's request and three defects it causes (§1 **H4–H6**): a reload cannot address a brief, `/brief/new` erases the selection merely by being visited, and an unsaved draft is keyed to a per-mount temp id so a reload orphans it. |
| **D38** | **A refused verb must answer where the user lands.** `StatusLine` and `ErrorStrip` render on **every** guided step, not only on Review. Only the verbs stay in the Review-step bar. | The direct cause of *"takes user back to the first slide, with no indication as to why"*: the refusal message and the bar that carries it are unmounted by the very press that produces them (§1 **C2**). |
| **D39** | **`Execute Pipeline` is never disabled for being un-estimated.** `CommandBar.tsx:210`'s `variationBlocked` is dropped from `disabled`; only `loading` may disable it. A press before the plan lands says so; an infeasible plan shows the planner's reason. | **GB-D3 / `DESIGN.md` §5**, already locked and violated here. A dead primary verb cannot answer the question pressing it asks — the lesson of #126, re-learned. This is a leading candidate for *"I am unable to generate a campaign"*. |
| **D40** | **`Discard` splits into `Cancel` and `Revert`.** *Cancel* leaves the editor for the grid and prompts through the dirty guard if there is unsaved work. *Revert* restores the last saved state and **asks first**, through the same `confirmReplace` every other replace path already uses. | Today `Discard` is a silent, irreversible wipe that leaves the user on the same step (§1 **M5**). "Stop editing" and "throw away this edit" are two intentions on one button. |
| **D41** | **`StatusChip` has two states, not four.** With every persist path applying, `hasApplied` and `savedSnapshot !== null` cannot diverge, so the chip reduces to **Unsaved changes / Saved**. | Retires the *"Draft not applied"* badge the user reports as stuck — not by suppressing it, but by removing the distinction it was drawing. UE-D11 (four colour-distinct states) is **amended**: it governed four states that no longer exist. |
| **D42** | **The Review preview is a bounded panel, not an accidental overlay**, and the preview that was designed to be persistent becomes persistent. `PreviewDock` / `PreviewStrip` mount in the guided column; the Review figure is capped so it reads as a panel beside the summary. | `ReviewStep`'s figure is not a dialog at all (§1 **H2**) — it reads as one because a 1080×1920 intrinsic SVG is handed an `auto` grid track. The dock and strip that W9 built for exactly this purpose have **never rendered in the product** (§1 **M2**). |

---

## 1. Verified findings

Severity: **C**ritical (blocks a core flow) · **H**igh · **M**edium · **L**ow. Every row was reproduced by executing code unless marked *inferred*.

### Critical

| ID | Finding | Evidence |
|----|---------|----------|
| **C1** | **`CreativePreview` never applies the font size it computes.** `fontSize` is computed at `CreativePreview.tsx:148` and used for `lineHeight` and `firstBaseline`, but the `<text>` at `:211-217` carries `x`, `y`, `fontFamily`, `fontWeight`, `className` and **no `fontSize`**. The headline renders at the inherited 16px inside a 1080×1920 viewBox — **~16 % of intended size** — at a baseline solved for 102px type, with lines 110 units apart. | Rendered attribute dump: `has font-size attr: false`. `fitHeadline` with identical inputs returns `102.04`. **No test has ever asserted the rendered attribute** — `creative-preview.test.tsx` asserts `fit.fontSize`, the pure function's return value, so the suite is green with the attribute deleted. This is exactly *"a gradient-bg with unstyled small text in a random location"*. |
| **C2** | **The Apply refusal destroys its own explanation.** `refuseInvalid()` sets `attempted` and calls `reveal(blockedAt)` in **one React commit**. `BriefEditor.tsx:1055` renders the action bar only when `steps[stepIndex] === "review"` — so the same commit that makes `StatusLine` emit the refusal also unmounts the bar carrying it. | The user lands on step 1 with no message, and the word "Apply" is no longer on the page. Precisely *"takes user back to the first slide, with no indication as to why."* |
| **C3** | **`Execute Pipeline` is dead while the plan has not landed.** `CommandBar.tsx:210` — `disabled={loading \|\| variationBlocked}`, where `variationBlocked = isVariation && (plan === null \|\| plan.kind === "infeasible")`. `plan` resets to `null` on every brief-identity change and is only set inside `planCampaign().then()`, so a slow, cancelled or never-resolving estimate leaves it `null` **forever**. | Executed against the real `CommandBar`: a `/campaigns/plan` POST that never settles leaves the primary verb greyed out permanently, with no message and no way to ask why. Violates **GB-D3**. A leading candidate for *"unable to generate a campaign"*. |
| **C4** | **A second Generate 409s and discards the run that actually succeeded.** `run-context.tsx:471` `beginRun()` aborts the previous poller and bumps `runSeq` **before** the new POST goes out; the server answers 409 *"already in progress"*; the first run's poller then rejects and **both its error and its result are swallowed** by the `runSeq` guard. | The pipeline really ran and really wrote its report; the grid shows an error about a run that was fine. Pressing Generate twice — or the header's Generate and then the bar's Execute — loses the campaign. |

### High

| ID | Finding | Evidence |
|----|---------|----------|
| **H1** | **The preview has no dismiss because it is not a dialog.** `ReviewStep`'s `<figure>` has `role=dialog` nodes: 0, `aria-modal`: 0, close-ish buttons: 0; Escape leaves the DOM byte-identical. *Inferred* (no layout in happy-dom): it reads as an overlay because `ReviewStep.tsx:130` puts a 1080-wide intrinsic SVG in an `auto` grid track with `w-full`. | The grid's real `PreviewModal` is well-behaved — it closes three ways (×, Escape, backdrop) — and is unreachable with no assets, so it cannot be what the user saw. |
| **H2** | **The refused press drops focus to `document.body`**, and the one focus handoff that would have caught it is suppressed on a reveal. | Keyboard and screen-reader users get no landing point at all. |
| **H3** | **`Save & apply` and `Save as…` bounce identically and silently**, and `Save as…` leaves its modal floating over the result. | Same root cause as C2. |
| **H4** | **No `[id]` route.** `app/(shell)/brief/` contains only `page.tsx` and `new/page.tsx`; the open brief is addressed by `localStorage`. | A reload or a shared link cannot open a specific brief. |
| **H5** | **Visiting `/brief/new` erases the persisted selection**, and `Apply` on `/brief/new` swaps the page component, remounting the editor back to step 1. | |
| **H6** | **An unsaved draft is keyed to a per-mount temp id**, so a reload orphans the autosaved recovery copy. | |
| **H7** | **The *"Draft not applied"* badge is armed by reload, by picking a brief, and by `Save as…`** — every `load` nulls `appliedSnapshot`. It contradicts the shell, which will happily run that brief. | The badge the user reports as stuck. |
| **H8** | **The status line advertises *"Save without applying"* — a control that does not exist.** | |

### Medium / Low

| ID | Finding |
|----|---------|
| **M1** | The bounce target is the first bucket in `validateState`'s **key order**, not the first failing **step** — so the step it lands on is arbitrary with respect to the walk. |
| **M2** | `PreviewDock` and `PreviewStrip` are mounted **nowhere** — all 15 references are in tests. W9.2/D26's persistent preview has never rendered in the product. |
| **M3** | A `cf:brief` naming a brief no longer in `briefs/` silently becomes an unsaved **new** draft. |
| **M4** | Every `Apply` re-arms a window in which `Execute` is dead (C3's cause, user-triggered). |
| **M5** | **`Discard` never confirms.** With `confirm` stubbed to return `false`, Discard still reverted the field and the stub was **never called** — it does not go through `confirmReplace`, unlike every other replace path. It then purges the recovery copy, which the autosave effect immediately rewrites. |
| **M6** | The Review step promises a launch it does not carry. |
| **M7** | *Inferred:* the guided step card carries a permanent `transform`, making it the containing block for the Asset Bin drawer's `fixed inset-0`. |
| **L1** | `purgeDraftFromStorage` is a no-op — the autosave effect rewrites the key it just deleted. |
| **L2** | The ready-ring remounts the Next button; a click landing during the remount is lost. |

---

## 2. The verb model

### 2.1 What the four labels actually do

| Label | Where | Writes a file? | Retargets the shell's run? | Navigates? |
|---|---|---|---|---|
| **Save** (`SaveMenu.tsx:57`) | action bar | — | — | — *(a disclosure button, not a verb)* |
| **Save & apply** | menu item | **yes** | **yes** | no |
| **Save as…** | menu item | **yes** (new id) | **yes** | no |
| **Apply to run** | action bar | **no** | **yes** | no |
| **Discard** | action bar | no (purges the draft) | no | **no** — stays on the step |

Two observations follow immediately. First, **there is no plain Save** — the thing that looks like the primary verb opens a menu. Second, **"& apply" is redundant in both menu items**, because both already apply. The only verb that does something distinct is *Apply to run*, and what it does is **run without writing**.

### 2.2 Why "apply" exists at all

The editor holds a draft; `run-context` holds the brief the shell will run. `Apply` is the manual bridge. But `briefApplied` (`run-context.tsx:536`) never reads the editor's `appliedSnapshot` — it is derived from the identity of the brief the provider holds, and **loading a brief already satisfies Generate's gate**. So the bridge is already automatic at load; `Apply` exists to cover the one case where the user has *edited* the draft and wants the shell to run the edit without committing it.

That is a real capability. It is also a capability no label on screen explains, priced at a permanent fourth verb and a four-state badge.

### 2.3 The recommendation, and the one thing that gates it

**Collapse to Save / Save as… / Cancel (D35).** The prize is not just three labels instead of four: `StatusChip`'s four states become two (D41), which is what actually retires the *"Draft not applied"* badge — by removing the distinction, not by hiding it.

**The collapse removes run-without-write.** Under it, the only way to see what a change looks like is to write it. That is acceptable **only if a write is non-destructive** — and today it is not: `brief-files.ts:39` writes through `js-yaml`'s `dump`, which deletes every comment and all hand-authored formatting. Trying three headlines rewrites the file three times, and the first rewrite silently destroys the notes the user left explaining why the brief is shaped the way it is.

Hence **D36 ships first**. Once a save round-trips comments, making saving the normal act is a simplification rather than a downgrade.

Two alternatives were reviewed adversarially and rejected:

- **Rename only.** Touches none of the four verb defects — every one lives in a handler, not a label — and forks the vocabulary, since "applied" is load-bearing in code and would survive in state, tests and messages while disappearing from the UI.
- **Collapse into Generate** (*Generate runs the draft, saving first if needed*). Puts an unconfirmed, credit-spending, irreversible action on the exact button D3 trains users to press to ask *"what is wrong?"*.

### 2.4 Discard

Per the user: **Cancel returns to the grid** (D40). `Revert` keeps the destructive meaning, gains the confirmation every other replace path already has, and stays in the overflow menu.

---

## 3. Lanes

Each lane is one worktree, one branch, one PR. Ownership is exclusive; two lanes never hold the same file.

| Lane | Task | Owns |
|---|---|---|
| **R1.1** | Apply `fontSize` to the `<text>` (**C1**) | `campaign/CreativePreview.tsx` |
| **R1.2** | Assert the **rendered** `font-size` attribute, not `fitHeadline`'s return (the gap that let C1 ship) | `campaign/__tests__/` |
| **R1.3** | Bound the Review figure so it reads as a panel (**H1**, D42) | `campaign/ReviewStep.tsx` |
| **R2.1** | Hoist `StatusLine` + `ErrorStrip` to every guided step; verbs stay on Review (**C2**, **H3**, D38) | `campaign/BriefEditor.tsx` |
| **R2.2** | Bounce to the first failing **step**, not the first error bucket (**M1**) | `campaign/BriefEditor.tsx` |
| **R2.3** | Give the refused press a focus target (**H2**) | `campaign/BriefEditor.tsx` |
| **R3.1** | Drop `variationBlocked` from `disabled`; the press answers (**C3**, D39) | `shell/CommandBar.tsx`, `messages.ts` |
| **R3.2** | `beginRun()` after a successful 202; treat 409 as *"already running"* and keep polling (**C4**) | `lib/run-context.tsx` |
| **R4.1** | **Non-destructive YAML writes** — `yaml` Document API, corpus test over `briefs/*.yaml` (**D36**) | `apps/api/server/lib/brief-files.ts` |
| **R5.1** | `/brief/[id]` + `/brief/new`; route is the source of truth (**H4**, D37) | `app/(shell)/brief/**` |
| **R5.2** | Key the recovery draft to the real id (**H6**); handle an unknown id (**M3**) | `campaign/editor-state.ts` |
| **R6.1** | Collapse the verbs to Save / Save as… / Cancel (**D35**) | `campaign/SaveMenu.tsx`, `BriefEditor.tsx`, `messages.ts` |
| **R6.2** | `StatusChip` → two states (**D41**); retire the *"Save without applying"* copy (**H8**) | `campaign/StatusChip.tsx`, `StatusLine.tsx` |
| **R6.3** | Cancel → grid; Revert confirms (**M5**, D40) | `campaign/BriefEditor.tsx` |
| **R7.1** | Mount `PreviewDock` / `PreviewStrip` in the guided column (**M2**, D42) | `campaign/BriefEditor.tsx` |

**Order.** `R1 ‖ R3 ‖ R4` → `R2` → `R5` → `R6` → `R7`.

R4 gates R6 (D36). R2 and R6 both own `BriefEditor.tsx`, so they are sequential; R7 follows R6 so the dock is not mounted against a verb model about to change. R1 and R3 are independent of everything and should go first — **C1 and C3 are the two the user will notice within a minute.**

---

## 4. Definition of Done

- Every finding in §1 has either a merged fix or a row here saying why it was not taken.
- `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn test:cov` — **0 lint problems, 100 % on all four counters**, then `yarn sync:check` clean on the committed tree.
- **C1 has a test asserting the rendered attribute.** The existing tests pass with the bug present; that is the defect behind the defect, and it is not fixed until a test would have caught it.
- **R4 has a corpus test**: every file in `briefs/` survives a load→save round trip with its comments and formatting intact.
- **C3 and C4 have tests driving the real `CommandBar` / `RunProvider`**, not mocks that agree with themselves — a never-settling plan request, and a double Generate.
- No verb is `disabled` for being invalid anywhere in the diff (**GB-D3**).
- The word *"apply"* survives in code and state if it must, but appears **nowhere** in rendered copy.

## 5. Open questions for review

1. **Is run-without-write worth keeping?** D35 removes it. If it matters, it belongs on the Generate side (*"Generate runs what is on screen"*), never as a fourth verb in the editor.
2. **Should `cf:brief` survive D37 at all**, or does the URL fully replace it? Keeping both risks two sources of truth for the same question.
3. **UE-D11** locked four colour-distinct `StatusChip` states. D41 amends it to two. Confirm that is intended rather than a regression against a locked decision.
