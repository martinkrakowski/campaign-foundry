# R7 — The Preview Panel: Architecture & Development Plan

**Date:** 2026-09-01
**Status:** for review
**Supersedes:** lanes **R1.3** and **R7.1** of `docs/planning/2026-08-31_brief-flow-remediation.md`
**Decision ids introduced:** D43 – D50, D61

---

## 0. What this plan answers

The 2026-08-31 remediation plan gives R7 a single row — *"Mount `PreviewDock` / `PreviewStrip`
in the guided column"* — and gives the Review figure's cap to a different lane, **R1.3**, which
never landed. Both halves are decision **D42**, both land on the same pixels, and neither can be
done without the other. This plan replaces both rows.

It answers three questions the one-line row does not:

1. **Where does the preview live, and how many are there?** D42 as written puts a dock on every
   guided step *and* leaves the Review figure in place, which renders the same creative twice on
   the same screen.
2. **What feeds it?** There is no prop-derivation for these components anywhere in product code.
   The only one that exists is a fixture inside a test file whose docstring claims it maps state
   *"exactly as the host wires them"* — while no host exists.
3. **How is it verified?** The bounding half cannot be proven by this suite at all. The test
   environment performs no layout, and the existing tests are green **with** the defect present.

> **Provenance.** Every claim below was derived from the code on `main` at `4004a0a` by six
> parallel readers, each then challenged by a second reader instructed to refute it. Findings the
> challenge corrected are marked. Nothing here is carried over from an earlier document on trust;
> where a document and the code disagree, this plan records the code and says so.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D43** | **Exactly one composed preview is rendered at any time — dock, strip and figure counted together.** The dock mounts in Guided only and is **suppressed on the Review step**, where the figure owns the preview. `PreviewStrip` is **deleted** (owner decision, §6 question 3), so the dock and the figure are the only two surfaces and this decision fully constrains them. | D42 as written mandates two. `ReviewStep.tsx:162` carries the same wrapper class as `PreviewDock.tsx:76` and the same `className="block h-auto w-full"` reaches `CreativePreview` at both call sites — so at ≥`xl` the Review step would carry both pictures of the same brief, side by side. (The calls differ in how `ratio` is derived; see **C1**.) |
| **D44** | **The dock is `sticky top-0 self-start`, mounted as a sibling of the main column, never `fixed` and never inside `renderStepCard`.** | D26 always specified a *sticky* dock; the component W9 built has no positioning at all, so mounting it as-is does not implement the decision. `sticky` also resolves against the nearest scrollport and is therefore immune to the step card's `transform` — which is what keeps R7 clear of **M7**. And `renderStepCard` renders **two** live copies during a step change, so a dock inside it would briefly animate twice. |
| **D45** | **The host's prop derivation is product code, exported, and the fabrication test imports it.** No test fixture may be the only definition of how a component is wired. | `previewFrom` (`creative-preview.fabrication.test.tsx:35-47`) claims to map state "exactly as the host wires them" while `MP7` proves there is no host. It is mode-blind, so it would draw the wrong creative for a classic brief, and it disagrees with `ReviewStep`'s real derivation — shipping it would make the dock and the figure show *different looks for the same brief*. |
| **D46** | **The cap goes on the inline axis, as `minmax(0,20rem)`, never a bare length and never `max-h` alone.** | A percentage cap cannot clamp an intrinsic contribution; only a definite length can. A bare `20rem` track and `minmax(0,20rem)` measure identically at full width but diverge once the YAML split view is open, where the content row falls to ~624/464/208 px. |
| **D47** | **The bounding half is verified in a browser. A class-string assertion is never accepted as proof of a layout fix.** | The suite runs under happy-dom, which performs no layout: `review-step.test.tsx:54` clicks every Edit button and passes *today*, while in a real browser the creative paints over those buttons. A green assertion about a class that does nothing is the exact failure mode this lane exists to end. |
| **D48** | **`PreviewStrip` gains an accessible name, and every mount assertion queries by role or landmark from a render of the editor** — never by bare text, never by DOM index. | Both rails render simultaneously under happy-dom (`hidden xl:flex` / `flex xl:hidden` are pure CSS), so a bare-text assertion cannot tell the dock from the strip and therefore cannot prove which surface a user sees. `PreviewStrip` is a plain `<div>` reachable in its own test only via `container.firstElementChild`, a handle that evaporates at editor level. |
| **D49** | **R7 absorbs R1.3 and names every file it takes**, superseding the 2026-08-31 lane table. | R7 must edit `ReviewStep.tsx` to do the H1 half — a file the table assigns to R1.3 — and may edit `CreativePreview.tsx`, which it assigns to R1.1. Carrying that implicitly is how the plan's own exclusive-ownership rule gets broken. |
| **D61** | **The right rail is one slot with a segmented switcher: an eye glyph for the preview, `</>` for the YAML view. The two are exclusive — never side by side.** The `w-96` YAML split sidebar and the ⋯ menu's "YAML split" item are retired; YAML becomes the rail's second view. | Owner decision. It also *dissolves* §6 question 2 rather than answering it: the 208 px collapse existed only because the YAML split and the content column shared the row. One slot, two views — no contention, no suppression rule, no container-query fallback for that case. |
| **D50** | **The preview names its motion kind in the caption, and the preview's one-shot gains `forwards`** — on the animation class in `CreativePreview.tsx`, never on the shared keyframes. | `DESIGN.md`'s rule that *a loop is never the only carrier of meaning* is honoured by the glyph and not by the preview. `kf-ken-burns-in` ends at `scale(1.15)` and, without a fill-mode, the creative snaps back to `scale(1)`. `MOTION_KIND_META` is already the display-name vocabulary, so the caption costs one lookup. |

---

## 1. Verified findings

### Critical

| id | Finding | Consequence |
|---|---|---|
| **C1** | **D42 as written renders the same creative twice.** A dock mounted at the proven slot renders on every guided step; the Review step already draws its own `<figure>`. The wrapper `<div>` carries the same class string at `ReviewStep.tsx:162` and `PreviewDock.tsx:76`, both hand `CreativePreview` the same `className="block h-auto w-full"`, and `ReviewStep`'s figcaption inlines the same `messages.previewCaption(...)` expression as `PreviewCaption`. The calls themselves are **not** identical, and the difference is a trap for §6 question 4: `ReviewStep` pre-derives at `:121` (`derivePreviewRatio(platformId, undefined)`) and passes the **result** as `ratio`, while `PreviewDock` takes `ratio` as a **hint** and derives internally at `:83`. One prop name, two meanings — sharing the component naively double-derives. | Two pictures of one brief, side by side, at ≥1280 px. Resolved by **D43**. |

### High

| id | Finding | Consequence |
|---|---|---|
| **H1** | **The `auto` track eats the row.** `ReviewStep.tsx:130` is `lg:grid-cols-[minmax(0,1fr)_auto]`; the figure sits in the `auto` track; `CreativePreview` renders `<svg width={W} height={H}>` (1080×1920 for 9:16) and is handed `block h-auto w-full`. The summary column resolves to **0 px** and the creative paints over the Edit controls. This is engine-independent: with base = 1080 the `fr` track's hypothetical size is negative, so `minmax(0,1fr)` is re-treated as inflexible and keeps its 0 base in every engine. Tailwind preflight deliberately excludes `svg` from its `max-width` reset, so there is no global safety net. | The user's report — *"the preview pop-up is not dismissable"*. It is not a dialog and never was; it is a figure that consumes the row. |
| **H2** | **No prop derivation exists in product code.** `PreviewDock`/`PreviewStrip` reach no product code; the only live import from that module is `derivePreviewRatio`, used by `ReviewStep.tsx:5`. The one written mapping is a test fixture that is mode-blind, omits `motion`, and hardcodes `step: 1, stepCount: 6`. | Lifting the fixture would make the dock disagree with the Review figure about the same brief. Resolved by **D45**. |
| **H3** | **The suite is green with the bug and cannot verify the fix.** happy-dom performs no layout, `getBoundingClientRect` returns zeros, and `userEvent` does no hit-testing — so the covering H1 describes is invisible to the tests. `apps/web` has no browser-level test runner. The 2026-08-31 DoD would not have failed at any point while `PreviewDock` sat unmounted through four PRs. | The 100 % coverage gate pushes toward exactly the decorative assertion this repo has twice shipped. Resolved by **D47**. |
| **H4** | **Mounting both rails degrades existing editor tests silently rather than failing them.** Both render under happy-dom. `PreviewIdentity` prints `campaignName` and `headline` as `<p>` text and `CreativePreview` prints the headline into `<tspan>`s; `campaignName` is set to the brief id on load, so the mount adds a third `"camp…"` text node to a 2760-line test file that uses indexed and bare-text queries. | Queries silently resolve to the wrong node. Resolved by **D48**, plus a budgeted pass over `brief-editor.test.tsx`. |

### Medium

| id | Finding |
|---|---|
| **M1** | **D26 specifies a sticky dock; neither component has any positioning.** `sticky`, `fixed`, `top-`, `bottom-` appear nowhere in `PreviewDock.tsx`. At the foot of a long flowing editor page the strip would simply scroll away. Resolved by **D44**. |
| **M2** | **`PreviewShowcaseProps.step` is documented as *"1-based position in the campaign's creative set"*, not the wizard step.** Using it as a wizard readout is a wrong wiring the fabrication test cannot catch, and the readout is meaningless in Everything mode. |
| **M3** | **The dock has no empty state.** `primaryColor` is required and there is no `hasProduct` branch, while `ReviewStep` renders nothing without a product. The guard must key on **`products.length === 0`** — a real state via `blankBrief`. `/brief/new` is *not* that case: it seeds one default-blue product, which the figure and the dock would both draw. Whether an untouched default product is worth previewing is a separate call, and is listed in §6. |
| **M4** | **`PreviewStrip` has no accessible name** — a plain `<div>`, reachable in its own test only as the render root. Resolved by **D48**. |
| **M5** | **`ken-burns-in` snaps back.** `kf-ken-burns-in` runs `scale(1) → scale(1.15)` (`globals.css:72-79`); with **no fill-mode** the preview's 2.4 s one-shot reverts from `1.15` to `1` the moment it ends. The fix belongs on the Tailwind animation class in **`CreativePreview.tsx`**, not in `globals.css` — those keyframes are shared with the glyph's `infinite` rules, which never end, so a fill-mode there implements nothing. |
| **M6** | **An existing test pins the very sizing H1 blames.** `creative-preview.test.tsx:104-105` asserts the intrinsic `width`/`height` attributes. If R7 drops them in favour of `viewBox` alone, that test is in the diff — and rewriting it is the strongest available evidence the lane worked, because it is a test that was pinning the cause. |
| **M9** | **`PreviewStrip` and `FloatingBar` claim the same bottom band — but only in two places.** The bar renders at `BriefEditor.tsx:1199` (Guided, **Review only**) and `:1242` (Everything). So under **D43** the collision exists only in Everything and on Review below `xl`; a Guided non-Review step has no bar at all. Folded into §6 question 3. *(Renumbered from M7: the parent plan already uses **M7** for the Asset Bin drawer trapped by the step-card transform, and one id for two defects would let an implementer think they had settled both.)* |
| **M8** | **Lane-ownership collision with R5, which is in flight.** R7 needs `app/(shell)/brief/__tests__/**`, which the 2026-08-31 table assigns to R5.1, and both lanes edit `BriefEditor.tsx`. |

### Low

| id | Finding |
|---|---|
| **L1** | The preview has **no non-motion cue**; `prefers-reduced-motion` is otherwise respected via `motion-safe:`. Resolved by **D50**. |
| **L2** | **`DESIGN.md` has absorbed none of the W6–W9 wave**, and its responsive rule still contradicts the dock's breakpoint. `yarn sync:check` is `hexagen sync --check` — a scaffold/manifest check — so nothing in the gate forces the contract to describe what shipped. R7 is the last lane; nobody after it will. |
| **L3** | The 2026-08-31 plan's **M2 row is stale**: it says *"all 15 references are in tests"*. There are 26 matched lines across 4 files, and `ReviewStep.tsx:5` is not a test — the module is a live dependency of a rendered component. |
| **L4** | **`kf-headline-rise` is geometrically invisible on this canvas.** It was authored for the 46-unit glyph and reused verbatim at 1080×1920; a CSS transform length on an SVG element resolves in the local user coordinate system, so `translateY(3px)` is ≈0.1 CSS px here. |
| **L5** | **The binding decision ids for R7 are D42, D26, D27, D38, GB-D3 and GB-D18** — the graphical-brief series stops at GB-D18, so any reference to a "GB-D20" is a slip. |
| **L6** | **`accent-wipe` scales about the canvas, not the rect** — no `transform-box` is declared anywhere in `apps/web/src` or `packages`, so the reference box is the view-box. |
| **L7** | The Review figure ignores the brief's ratio: `ReviewStep.tsx:121` calls `derivePreviewRatio(platformId, undefined)`, so the common case is **1:1**, not the 9:16 the defect narrative emphasises. At a 20rem cap that is a 318×318 square — the size the design call should actually be judged at. |

---

## 2. Scope, and what is deliberately not in it

**In scope.** Cap the Review figure (H1); mount the dock Guided-only and suppress it on Review
(C1/D43); give it the `sticky` D26 always required (M1/D44); write and export the prop derivation
(H2/D45); give the strip a name and repair the query surface (H4/D48); the caption's motion name
and the fill-mode (D50); and the `DESIGN.md` amendment (L2).

**Not in scope, with reasons.**

- **A shell-level right-hand outlet.** No right-hand outlet exists; creating one is a two-file
  change to shared shell code, and because `MobileMenu` re-renders `SidebarContent`, any slot
  placed there also appears in the mobile overlay. The proven slot inside `BriefEditor` costs none
  of that, and only `BriefEditor` holds the live draft anyway — so even a shell outlet would end up
  publishing a rendered `<PreviewDock/>` from here.
- **M7 (the Asset Bin drawer trapped by the step card's transform).** Real and CSS-derivable, but
  pre-existing and out of D42's scope. R7 is **M7-neutral**: mounting outside `renderStepCard` with
  `sticky` (never `fixed`) neither fixes nor worsens it. Scope is now bounded — `AssetPickerDrawer`
  is the *only* trapped overlay in the guided column; `HeadlinePoolDrawer` is already hoisted to
  `BriefEditor`'s root.
- **The loop budget.** D27 locks **four looping *kinds***, and `globals-motion.test.ts` enforces
  that by counting `infinite` **declarations** in `globals.css`. `FormatPanel.tsx:94` is an allowed
  *instance* of `kf-ken-burns-in` on the Video card, not a fifth kind — stated here so nobody
  "fixes" a GB-D8/D9 feature. Do **not** expand that test to count instances. **R7 must add no
  `infinite` animation**: `CreativePreview` is a 2.4 s one-shot, and keeping it one-shot is what
  keeps R7 clear of both the budget and WCAG 2.2.2.

---

## 3. Tasks

**Two PRs, not one** — see *Order* below. R7 takes these files, superseding the earlier table
(**D49**): `campaign/PreviewDock.tsx`, `campaign/ReviewStep.tsx`, `campaign/BriefEditor.tsx`,
`campaign/CreativePreview.tsx` (the `forwards` fill-mode lands here **unconditionally**, plus M6's
attributes if they change), `campaign/messages.ts` (D48's strip name, D50's motion-kind caption),
and the test files `campaign/__tests__/{preview-dock,review-step,creative-preview,creative-preview.fabrication}.test.tsx`
plus `app/(shell)/brief/__tests__/**`, and `DESIGN.md`.
**`globals.css` is not in the lane** — its keyframes are shared with the glyph's `infinite` rules.

| Task | What | Acceptance |
|---|---|---|
| **R7.1** | Cap the Review figure: `lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]` (**D46**). Leave `CreativePreview`'s `shrink-0` alone — it is inert at every production call site, but keep `w-full`/`max-w-full` if the wrapper ever becomes a flex container. | Verified in a browser at the **six** widths of §4, not by a class assertion. The summary column is non-zero and every Edit button is clickable at all six. |
| **R7.2** | Write the prop derivation in product code and export it (**D45**): mode-aware `layout`/`tone` (treatment first, axes second, as `ReviewStep` does), a real `motion`, an explicit zero-product answer, and `step`/`stepCount` passed as `stepIndex + 1` / `steps.length` with the JSDoc corrected (**M2**). | `creative-preview.fabrication.test.tsx` **imports** the derivation instead of defining its own. A classic brief and a randomized brief each produce the same look in the dock as in the Review figure. |
| **R7.3** | Mount `PreviewDock` as a sibling of the main column inside the `flex items-start` row, `sticky top-0 self-start`, **Guided only**, **suppressed when `steps[stepIndex] === "review"`** (**D43/D44**). Never inside `renderStepCard`. | A test rendering the **editor** finds the dock by `getByRole("complementary", { name: "Preview" })` — `getByRole`, never `getAllByRole(...)[0]`. It is absent on Review, and absent in Everything. |
| **R7.4** | **Delete `PreviewStrip`** and its tests (owner decision, concurring with both reviews). `PreviewDock` keeps its `xl:` classes until R7.6 rehomes visibility. Below the rail's breakpoint the preview lives in the wizard's layout-editor step (the template plan's T7), not in a bottom bar. | `PreviewStrip` no longer exists; no test references it; D43/R7.3 need no strip suppression. |
| **R7.5** | Repair the query surface (**H4**): scope every affected assertion in `brief-editor.test.tsx` with `within(...)`, a role, or the `Preview` landmark. Tighten the review-row assertion to a **count** of headline-bearing SVGs — turning a silent degradation into an explicit statement of how many creatives Review draws. | No test passes by resolving to a node in the wrong rail. |
| **R7.6** | Motion honesty (**D50**) — **delivered by the template plan's T1a**, which owns `CreativePreview.tsx` (the `forwards` fill-mode); the `PreviewCaption` motion name lands with PR B, which owns `PreviewDock.tsx`. Listed here so D50 is not lost, executed there so two parallel lanes never share a file. | The kind is readable without watching the animation; the creative does not snap back. No new `infinite` — `globals-motion.test.ts` still counts four. |
| **R7.7** | Amend `DESIGN.md` (**L2**): add the dock and the rail switcher to §4 (the strip is deleted, R7.4), and amend §7 so `lg` is the sidebar line and `xl` the preview line. | The contract describes what shipped. |
| **R7.8** | **The rail switcher** (**D61**): one right-rail slot headed by a segmented control — eye = `PreviewDock`, `</>` = the YAML view. Remove the `w-96` split sidebar (`BriefEditor.tsx:1230`) and the ⋯ menu's "YAML split" item; the rail remembers its last view. | Exactly one of preview/YAML is rendered at a time; the side-by-side layout and its width-collapse case no longer exist. |

**Order — split into two PRs.**

**PR A (now, against current `main`): R7.1 alone.** Capping the Review figure is the
user-visible defect and it depends on nothing in the routing model — `ReviewStep.tsx`,
`CreativePreview.tsx`, `messages.ts`, `DESIGN.md` and `review-step.test.tsx` are untouched by R5.
Blocking the covering fix behind a branch that has no PR yet would be the wrong trade.

**PR B: R7.2 + R7.3 + R7.4 + R7.5 + R7.7 + R7.8**, plus PR B's half of R7.6 (the caption). These edit `BriefEditor.tsx` and
`app/(shell)/brief/__tests__/**`, which R5 rewrites.

**M8 corrected:** R5 is a **local branch (`feat/r5-brief-route`) with no PR open** — it is not an
in-flight GitHub lane, and the parent plan's ordering rationale for R7 ("not against a verb model
about to change") was satisfied by R6. The confirmed collision is the brief test directory; the
`BriefEditor.tsx` dual-edit is likely but is not in the parent plan's owns-table.

---

## 4. Verification

### The browser matrix (D47)

The content column width, and therefore whether the fix holds, depends on the YAML split view —
a sibling of the main column, toggled from the ⋯ menu. **Six checks, not three:**

**Preconditions, all six cells:** Guided presentation; a brief with **`products.length > 0`**;
the **Review** step (so the dock is absent under **D43**); the default derived ratio, which is
**1:1** — `ReviewStep.tsx:121` passes `undefined` as the explicit ratio, so 9:16 is *not* the
common case (**L7**). Record the browser and version. For each cell record two numbers: the
computed width of the `<dl>` summary column and of the `<figure>`, plus a yes/no that **every Edit
button is clickable**. Open the YAML split from the ⋯ menu.

These are Review-step widths, so no rail width is Derived from `(shell)/layout.tsx:31` (`gap-4`, `p-4`), `Sidebar.tsx:18` (`w-[320px]`
at ≥`lg`), `BriefEditor.tsx:1085` (`max-w-5xl`, `sm:p-8`) and the YAML split at `:1230` (`w-96`).

| Viewport | YAML split closed | YAML split open |
|---|---|---|
| 1440 px | 960 px | 624 px |
| 1280 px | 848 px | 464 px |
| 1024 px | 592 px | **208 px** |

**Only the 208 px cell fails** `minmax(0,20rem)`: at 1024 px with the split closed the summary is
a healthy 592 px, so moving the two-column line to `xl:` would stack a case that works. §6
question 2 records the two reviewers' disagreement about the remedy.

**Repro conditions**, so a reviewer does not miss the defect: Guided presentation only
(`renderStepCard` is called only in that branch), and a brief with **at least one product**
(`hasProduct ? <figure> : null`). An empty brief shows a single, correct column.

### The suite

- Every mount assertion originates from a render of `BriefEditor` or the brief page, by role or
  landmark (**D48**).
- **Do not** write an assertion about `shrink-0` or any other class that does nothing. A green
  assertion about an inert class would be cited in a later audit as evidence this was fixed.
- Where an inline style carries a cap, assert the **parsed** `el.style.*`, never
  `getComputedStyle(...)` — class-driven styles resolve to `""` here, so such a test can neither
  distinguish a real class from a typo nor fail when the class is removed.
- If M6's `width`/`height` attributes go, `creative-preview.test.tsx:104-105` changes in the same
  diff, and the PR says so — it is the test that was pinning the cause.

---

## 5. Definition of Done

- `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn test:cov` — **0 lint
  problems, 100 % on all four counters** — then commit, then `yarn sync:check` clean on the
  committed tree.
- **The H1 half has a browser check recorded in the PR** with the six measurements of §4. The gate
  cannot prove this half, and the PR must say so plainly rather than imply the suite covered it.
- **A test fails if the dock is unmounted.** The whole reason this lane exists is that a component
  sat at 100 % coverage, driven by two test files, while rendering nowhere in the product for four
  PRs. Coverage is blind to dead code; a mount assertion is not.
- Exactly **one** composed preview is reachable on any screen (**D43**), asserted by count.
- The fabrication guard imports the **product** derivation (**D45**).
- `globals-motion.test.ts` still counts exactly four infinite animations.
- No verb, control or preview is `disabled` for being invalid (**GB-D3**); one domain vocabulary
  throughout (**GB-D18**).

---

## 6. Open questions — settled by the owner (2026-09-01)

1. **Dock visibility** → **container query on the editor row**, as both reviewers recommended,
   ratified by the owner. A viewport breakpoint lies once the rail changes the row's real width.
2. **The 1024 px YAML-split collapse** → **dissolved by D61**, a third answer superseding both
   reviewers': the YAML view and the preview become exclusive views of one rail slot behind a
   segmented switcher (eye / `</>`), never side by side — so the width contention the reviewers
   were arbitrating no longer exists. Until R7.6 lands, the §4 matrix's split-open column remains
   the truth of the interim code and PR A still verifies against it.
3. **`PreviewStrip`** → **deleted** (owner, concurring with both reviewers). Below the rail's
   breakpoint the preview belongs to the wizard's layout-editor step (see the template plan, T7).
4. **Share `PreviewPicture`?** → **yes** (owner ratifies both reviewers), minding the recorded
   trap: `ReviewStep` pre-derives `ratio` while `PreviewDock` derives internally — unify on one
   derivation before sharing, or it double-derives.
5. **Untouched default product** → still open; low stakes, decided in implementation.

---

## 7. What this plan corrects in the 2026-08-31 plan

| Where | Correction |
|---|---|
| M2 row (`:74`) | *"all 15 references are in tests"* — there are 26 lines across 4 files, and `ReviewStep.tsx:5` is a live production import. |
| Lane table (`:132`, `:145`) | R1.3 and R7.1 are one lane, not two (**D49**). R1.3 never landed; `ReviewStep.tsx` is byte-for-byte what W8 shipped in #144. |
| Order (`:147`) | R7's stated rationale — *"so the dock is not mounted against a verb model about to change"* — was satisfied by R6. The real constraint is **R5**, which rewrites the editor's mount. |
| §5 open question 2 | *"Should `cf:brief` survive D37"* is answered by D37's own wording and is settled in R5's brief, not here. |

---

## 8. Review record

Two independent reviews of this plan at `2219ed5`, run in isolated read-only worktrees, by models
different from each other and from the author.

| Reviewer | Model | Verdict | Findings |
|---|---|---|---|
| agy | Gemini 3.1 Pro | not safe as written | 1 blocker, 1 minor, 2 nits |
| grok | grok-4.6 (high) | not safe as written | 1 blocker, 6 major, 4 minor, 5 nits |

**Both independently found the same blocker** — the §4 width matrix mixed dock-present and
dock-absent states, giving 3 of 6 cells the wrong box. Both derived the same correction
(960/848/592 closed). It is fixed above.

What the reviews changed, beyond the matrix:

- **D43 did not actually cover `PreviewStrip`**, so the plan simultaneously required "exactly one
  composed preview" and mounted a second rail. Question 3 now gates R7.4.
- **D50 aimed the fill-mode at the wrong file, and M5 had the keyframe backwards.**
  `kf-ken-burns-in` runs `scale(1) → scale(1.15)`; the fix belongs on `CreativePreview.tsx`'s
  animation class, because `globals.css`'s keyframes are shared with `infinite` rules that never end.
- **`M7` named two different defects** (this plan's strip/bar collision and the parent plan's
  transform trap). Renumbered to **M9**.
- **The sequencing was wrong**: R5 has no PR, and R7.1 does not depend on the routing model, so the
  user-visible cap no longer waits on it. Split into PR A and PR B.
- **The `FormatPanel` loop was mis-framed** as a budget hole; it is an allowed *instance* of an
  existing kind. Left alone, with a warning not to "fix" it.
- **M3's `/brief/new` contrast was false** — that route seeds a default product. The guard keys on
  `products.length === 0`.
- **The DoD browser check was not reproducible**: no ratio, no platform, no browser, no recorded
  measurement, and the dock's presence unstated. Now a six-cell checklist with preconditions.

Corrections to the *author's own* errors are listed because they are the point of the exercise:
`GB-D20` was a citation this plan invented and then "corrected", and "byte-identical" overstated a
similarity that matters precisely because the two call sites differ.
