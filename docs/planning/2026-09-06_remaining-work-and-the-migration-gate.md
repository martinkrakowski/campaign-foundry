# Remaining work: four unplanned defects, six specified lanes, and the one decision that gates the rest

**Date:** 2026-09-06
**Author:** orchestrator
**Status:** draft — for the owner's review, then the grok + agy two-reviewer pass
**Verified against:** `main` at `f454d46` (CI green, including the `hexagen sync --check` drift gate)
**Decision ids introduced:** D82 – D85
**Relates to:** **D64** (identity model — OPEN, the owner's call), D73 – D81 (the lock plan), D11
(draft recovery), D15 (a storage port before the S3 move), D68 (null-legal brief scalars), F19 (the
seed never destroys an abandoned draft), F22 (two `DialogShell`s at one layer stack two scrims)

---

## 0. What this plan answers

Three plans in this arc have merged and every lane any of them specified has shipped, except one
plan's six. This plan answers a narrower question: **what is actually left, and what is it waiting
on?**

The answer is not a backlog. It is three piles of very different character, and the value of writing
them down together is that the piles have been confused for one another:

1. **Six lanes already specified in full** — the run-exclusion work in
   `2026-09-04_run-exclusion-and-the-distributed-lock.md` §3 (R1 – R6). They are not re-planned
   here. They are undispatched, not unplanned, and this plan only carries their ordering
   constraints forward and says where they sit beside the web work.
2. **Four defects nobody has planned** — three of them recorded out-of-lane during earlier waves and
   never briefed, one of them a gap in a golden-image fixture. All four are verified below against
   the code, and one of them is materially worse than the note that recorded it said.
3. **Everything else, which is gated on a single open decision** — D64, the identity model. This
   plan's most useful claim is about the *shape* of that gate: it is narrower than the deferral
   tables suggest, and none of the four defects sit behind it.

**What this plan is not.** It does not decide D64, it does not re-specify R1 – R6, and it does not
plan the cloud migration. It also does not invent work: every finding below names the file and line
it was read from, and §7 records three items that earlier notes call open which the code shows are
already closed.

**Its scope, stated precisely after review.** This plan covers the brief-workflow arc, the pipeline,
and the defects recorded out-of-lane during its waves. It is **not** an audit of every open item in
a 2,400-line session log; §1.3 names the older-arc stragglers it deliberately leaves uncosted, so
that "remaining work" is not read as "everything".

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D82** | **OPEN — the owner's call: what a second tab may do to a first tab's draft.** The editor autosaves to `cf:draft:<id>` and restores from it, but never observes a change written by anyone else. Two windows on the same campaign is therefore last-write-wins with no notice. Three candidate policies: *(a)* **leave it** — document the single-window assumption and add no mechanism; *(b)* **restore only when the local tab is clean** — a `storage` listener re-runs recovery, but only when the local editor is not dirty, so a typing tab is never yanked. **Harder than it looks (review, agy):** the recovery effect's deps are `[draftKey, routeId, routeLoadedId]`, so a listener registered there closes over a *stale* `state` and its "is the tab clean" test is answered by a snapshot, not by the editor; and `saveDraftToStorage` stamps `Date.now()` on every write (`editor-state.ts:1399`), so the listener fires on every autosave whether or not the content changed. Choosing (b) means solving both; *(c)* **notice, never restore** — a `storage` listener raises a passive line ("this campaign changed in another window") and the user chooses. The plan recommends **(c)**, with **(a)** a defensible answer today. | The recorded fix for this — "give recovery the subscribe/notify watch the seed effect has" — is **wrong**, and the plan says so in §1 F2. Applied literally it is a no-op, and the mechanism that would actually work introduces a worse bug than the one it fixes: two active tabs each restoring the other's draft means neither can type. That is a product decision about a multi-window story that has never been stated, not an implementation detail a lane may take. |
| **D83** | **A listing that failed is a different state from a listing that is empty, in the editor as well as in the picker.** `BriefEditor` treats them as one, and the consequence is that a valid campaign is reported to its owner as not existing. The distinction W2 already required of `StartFromExistingPicker` becomes the rule for every surface that reads `listBriefs()`. | The API was made honest about this in **#189** — a store read failure is a 500, not `{briefs: []}`. The web client then discards that honesty. Shipping a truthful API behind a lying UI is the worse of the two states, because the operator now has a false negative that looks authoritative. |
| **D84** | **Modality belongs to the kit, not to each stacking site.** `DialogShell` gains an overlay-depth counter; every shell but the topmost is marked `inert`, and only the topmost carries `aria-modal="true"`. The **F22 close-first workaround retires** — a caller may open a second overlay over a first without first closing the first. | Three sites stack overlays today and each solves it, or does not, by hand. A counter in the kit is one implementation with one test surface; the alternative is the same judgment repeated at every future call site, which is how F22 arose. |
| **D85** | **The inset pixel golden is recorded for `linux-x64`, or the claim it backs is withdrawn.** `compositor-goldens-insets.json` exists for `darwin-arm64` only, so the inset path has no pixel evidence on the platform CI actually runs. Either record the map from CI, or state in the test that inset fidelity is unproven off darwin. | A golden that silently skips on the only platform that runs it unattended is a vacuous tripwire — the documented class this repo already refuses elsewhere. Both answers are honest; the present state is the one that is not. |

---

## 1. Findings

Severity: **C** breaks a user's data or the build · **H** the product tells the user something false
· **M** a real defect with a bounded blast radius · **L** correctness of the test estate, not the
product.

### 1.1 Verified against `f454d46`

Every row was read from the code at the cited line, not from a planning document or a session log.

---

#### **F1 · H · A failed brief listing is reported to the operator as a campaign that does not exist**

`BriefEditor.loadBriefs` swallows every rejection:

```ts
// apps/web/src/components/campaign/BriefEditor.tsx:522-531
const loadBriefs = async () => {
  try {
    const entries = await listBriefs();
    setBriefs(entries);
  } catch (error) {
    console.error("Failed to load briefs:", error);
  } finally {
    setBriefsLoaded(true);          // <- set on the failure path too
  }
};
```

`briefs` stays `[]` while `briefsLoaded` becomes `true`. The route-load effect then reads exactly
those two values:

```ts
// apps/web/src/components/campaign/BriefEditor.tsx:376-384
if (!briefsLoaded) return;
if (routeLoadedId === routeId) return;
const match = briefs.find((entry) => entry.brief.id === routeId);
// M3: an id the listing does not know is answered where the user landed — the
// empty state below — never a silent new unsaved draft.
if (!match) {
  setUnknownId(routeId);
  return;
}
```

So a user who opens `/brief/spring-2026` while the store is unreadable is told **that campaign is
not found**, and offered the not-found remedies (`briefNotFound` / `briefNotFoundGrid` /
`briefNotFoundNew`, `messages.ts:618-622`) — one of which is to start a new brief. The campaign is
fine. The listing failed.

This is precisely the state **#189** made the API stop telling: that PR changed a brief-store read
failure from `{briefs: []}` to a 500 *because* an empty listing and a broken listing are different
facts. The web client re-merges them one layer up.

*The counter-argument, recorded so the reviewers can settle it.* A `focus` handler re-runs
`loadBriefs` (`:287`), so a transient failure heals when the user returns to the window; the false
message is a window, not a permanent state. That argues **M**. The plan grades it **H** anyway: the
severity of a false statement about the operator's own data does not depend on how quickly the
product stops making it, and the offered remedy invites creating a second campaign for one that
already exists. **Reviewers are asked to confirm or lower this grade.**

*The honest counterpart already exists in the same codebase.* W2's picker keeps the states apart:

```tsx
// apps/web/src/components/shell/StartFromExistingPicker.tsx:56-63
if (error) {
  return <p className="p-4 text-[13px] text-error">{messages.startFromExistingError}</p>;
}
…
// An empty store is not an error: this will be the first campaign.
```

Two surfaces, one API, one of them honest. **D83** makes it the rule.

---

#### **F2 · M · Draft recovery cannot observe the store, and the recorded fix would not work**

The recovery effect re-runs on three values, none of which is the stored draft:

```ts
// apps/web/src/components/campaign/BriefEditor.tsx:342-355
useEffect(() => {
  if (routeId !== undefined && routeLoadedId !== routeId) return;
  const draft = loadDraftFromStorage(state);
  if (draft && !valuesEqual(draft, state)) {
    dispatch({ type: "restore", state: draft });
  }
}, [draftKey, routeId, routeLoadedId]);
```

The out-of-lane note recorded during wave 1 says this "needs the subscribe/notify watch the seed
effect has." **That fix is wrong, and this plan corrects it.**

The seed's subscriber set exists for a stated reason:

```ts
// apps/web/src/lib/create-campaign.ts:41-47
// Why a subscriber set: a same-window `localStorage` write raises no `storage` event
// in the writing document (and happy-dom raises none at all), so the provider cannot
// learn of the write that way. `createCampaign` writes the key and then notifies;
// nobody here may rely on the `storage` event.
```

That mechanism solves a **same-window, two-component** problem: the dialog writes the seed, the
editor reads it. Drafts have no such problem. `saveDraftToStorage` has exactly one caller —
`BriefEditor.tsx:456`, the editor's own autosave (verified by sweeping every `setItem` in
`apps/web/src`). **The only writer of a draft is the component that would be subscribing to it**, and
it already knows its own state. A subscriber set here is a no-op.

The real gap is **cross-window**, which needs a `storage` event listener — a different mechanism the
seed's comment explicitly says nobody may rely on. And that is where it stops being an
implementation task: if a `storage` change re-runs the effect above, then with two tabs open on one
campaign, each tab's autosave fires the other tab's recovery, and each restores the other's draft
over the edit in progress. **Neither tab can type.** That is worse than today's silent
last-write-wins.

Hence **D82**: the multi-window story has to be stated before it can be built. The lane is gated on
it, and its shape depends entirely on which of (a) / (b) / (c) the owner picks.

---

#### **F3 · M · Two dialogs can be modal at once, and the lower one stays reachable to assistive technology**

`DialogShell` renders `role="dialog"` with `aria-modal="true"` at `dialog-shell.tsx:235-236` (the
dialog variant) and `:284-285` (the drawer variant). Nothing marks a lower overlay `inert` or
`aria-hidden`, and nothing tracks depth.

The stack is real and shipped: `CreateCampaignDialog` renders its own shell at `:170` and the W3
resume two-way at `:275`, both mounted at once by design.

**What is already fine, verified — so the lane does not "fix" it:**

- **Pointer, for the stack that exists.** The dialog scrim is `fixed inset-0 z-[70]` with
  `onClick={onClose}` (`dialog-shell.tsx:239-242`). The only reachable stack today is **two
  `DialogShell`s** (`CreateCampaignDialog.tsx:170` and `:275`), which sit at equal `z`, so the later
  one in DOM order paints above and a click aimed at the lower one lands on the upper scrim.
  **Scoped after review (agy):** this is not a general rule. `DrawerShell` renders at `z-50`
  (`dialog-shell.tsx:287`) against the dialog's `z-[70]`, so a drawer opened *over* a dialog would
  paint underneath it. No such site exists — the two drawers (`AssetPickerDrawer`,
  `HeadlinePoolDrawer`) open from the editor, and no dialog contains a control that opens one — so
  this is a latent ordering hazard, not a live defect. **F-B owns it:** the depth counter must be
  authoritative for paint order too, so the hazard cannot become real silently.
- **Escape.** Guarded by `dialogHoldsFocus` (`:79`), so the lower shell's listener returns and only
  the focused dialog closes. This one stands.

**What is actually wrong:** two simultaneous `aria-modal="true"` regions is undefined for a screen
reader, and a virtual cursor — which does not travel by Tab — reads straight through the lower
dialog's content. The user hears a form they cannot operate.

**Retracted after review (agy): the Tab refutation was wrong, and it hid a bigger defect — see F5.**
v1 of this plan told a future lane that Tab containment was already correct and out of scope. It is
not, and a lane briefed on that would have shipped the escape hatch intact.

**Blast radius:** the counter lands in `ui/dialog-shell.tsx`; the three existing stacking sites
(`CreateCampaignDialog`, `BriefPicker`, `Header`) come along, and `BriefPicker`'s F22 close-first
comment (`:72`) is deleted with the workaround it describes.

---

#### **F4 · L · The inset pixel golden does not exist for the platform CI runs on**

`compositor-goldens-insets.json` is recorded for `darwin-arm64` only, so the inset path's pixel
evidence is absent on `linux-x64` — the platform CI actually executes. Carried since the
2026-08-25 plan (`:425`, "record `compositor-goldens-insets.json` for `linux-x64` from CI") and never
picked up.

The zero-inset case *is* covered platform-independently (`NodeCanvasCompositor.test.ts`, "omitted and
all-zero safeInsets produce identical PNG bytes"), so this is a gap in the non-zero path only. Graded
**L**: it weakens the test estate, and no user-visible defect is known behind it. **D85** allows
withdrawing the claim as an equally honest answer.

---

#### **F5 · H · The focus trap is escapable, in a single dialog as well as a stacked one** *(review, agy)*

The Tab handler acts only when `document.activeElement` is exactly the first or last focusable
element of its dialog:

```ts
// apps/web/src/components/ui/dialog-shell.tsx:93-99
if (e.shiftKey && document.activeElement === first) {
  e.preventDefault();
  last.focus();
} else if (!e.shiftKey && document.activeElement === last) {
  e.preventDefault();
  first.focus();
}
```

Click any non-focusable region inside the dialog panel — its body text, its padding — and
`activeElement` becomes `document.body`. Neither branch matches, the handler does nothing, and the
browser's native Tab moves focus to the first tabbable element in document order, which is the page
*behind* the dialog. **The modal is escapable by keyboard from a single dialog**; the stacked case is
only the most visible instance.

This is not the depth counter's job — `inert` on lower overlays does not help when the page behind
is the destination. **The trap needs a containment branch**: when `activeElement` is outside the
dialog, Tab redirects into it.

*Honest caveat on testing.* happy-dom does not move focus on a Tab keypress, so a test cannot observe
the native escape. The assertion that works is on the handler's own contract: with `activeElement`
set to `document.body`, dispatching Tab must land focus inside the dialog. That is the test F-B
writes, and it is red today.

*Grading.* **H**, not M: it defeats modality for keyboard and switch users on every dialog in the
product, not just the one stacked pair.

---

#### **F6 · M · A second surface swallows an API rejection the way F1 does** *(review, agy)*

```ts
// apps/web/src/lib/run-context.tsx:200-209
async function fetchPersistedRun(campaignId: string): Promise<RunResult | null> {
  try {
    const res = await fetch(`${API}/campaigns/result?campaignId=${encodeURIComponent(campaignId)}`);
    …
  } catch {
    /* non-JSON / network — treat as "no persisted run" */
  }
  return null;
}
```

An unreachable API is reported to the operator as *this campaign has no run history*. Same class as
F1, same decision (**D83**), and v1 of this plan missed it. Graded **M** rather than H because the
absent-history state offers no destructive remedy, where F1's offers "start a new brief".

---

### 1.2 Specified elsewhere — carried, not re-planned

R1 – R6 are fully specified in `2026-09-04_run-exclusion-and-the-distributed-lock.md` §3 and were
reviewed there by grok (approve-with-changes) and gemini (rework), both folded in. **They are not
restated here.** Only the constraints that bind them to this plan's sequencing are carried:

- **R5 (the run deadline) comes before R1 (the eviction fix).** Removing eviction without a deadline
  leaves a hung run holding a campaign forever — eviction is currently the only reclaim path. This
  ordering was a gemini blocker on that plan and it survives here unchanged.
- **R2 (campaign-scoped output paths) runs alone.** It is the largest lane and it touches the
  use-case, the exporter, the output route, the report and the grid together.
- Two of the four problems that plan names **bite a single instance today** — they are not migration
  work waiting on a backend. In particular, rendered bytes carry no campaign segment, verified in the
  owner's own `output/reports/`: `trail-blaze-2026`, `trail-blaze-motion-2026` and
  `trail-blaze-motion2-2026` all write into `blaze-bottle/` and `blaze-pack/`.

### 1.3 Older-arc stragglers — named, not assessed

v1 implied it enumerated everything left. It does not, and the reviewers were right to push. This
plan's scope is **the brief-workflow arc, the pipeline, and the defects recorded out-of-lane during
its waves**. The session log carries older items that no one has closed and that this plan does not
cost or schedule:

| Item | Where |
|---|---|
| Two stock colour literals the W0b sweep missed — `TILE_CLASS`'s `bg-black` and one motion literal | `.agents/session-log.md:1576` |
| `StatusChip`'s fourth-state token; white primary buttons under a light theme (W3.2) | `.agents/session-log.md:1162` |
| `TURBO_TOKEN` / `TURBO_TEAM` never configured, so remote cache is off | `.github/workflows/ci.yml:109` |

**Refuted, with evidence (review, agy).** The review also cited `.agents/session-log.md:1147` and
`:1118` — the W0b bracket-alpha sweep and the `text-white` migration — as open work. They are not:
the lane that closed them is four lines below, `## 2026-08-30 — W0b lane: the sweep W0 enabled
(branch feat/w0b-sweep)` (`:1151`). The 65 remaining `token/alpha` utilities are the *supported*
form that W0 introduced (`globals.css` `color-mix`), not debt. A "Left open" line is only open until
the next entry closes it, and this log records both.

---

## 2. The recommendation

**Take the four defects now; hold the six R-lanes for the owner's go-ahead; stop treating D64 as
though it blocks more than it does.**

Three things follow from the findings.

**The web defects are fork-independent and small.** F1, F3 and F4 touch no identity concept, no
storage key, and no port. They survive either side of D64 unchanged. They have been sitting
out-of-lane for two waves for no reason other than that nobody wrote them down as lanes. F1 in
particular should not wait: it is the product telling an operator that their campaign is gone.

**One of them is a decision wearing a lane's clothes.** F2 was recorded as an implementation task
with a named fix. The fix is a no-op, the mechanism that would work creates a two-tab livelock, and
the question underneath — *may a second window take a first window's work?* — has never been asked.
D82 asks it. Until it is answered the honest state is (a), leave it, documented.

**D64's gate is narrower than the deferral tables imply — but v1 of this plan overstated how much
narrower.** The create-moment plan's §6 defers eight items to D64(b) or "the migration plan", which
reads as though the project is stalled behind one decision. It is not. But the first version of this
section claimed R1 – R6 are *fork-independent*, and that is too strong. **Corrected after review
(agy):**

| | Fork exposure |
|---|---|
| **F1, F3, F4, F5, F6** | **None.** No identity concept, no storage key, no port. Ready now. |
| **F2 / D82** | **None.** A draft key is `cf:draft:<whatever the route calls the brief>` either way. |
| **R1, R3, R5** | **None.** Eviction, a temp-file name and a run deadline touch no identity. |
| **R4** | **None.** A pool revision is a SHA of stored bytes. |
| **R2** | **Exposed in its key, not its need.** Campaigns overwriting each other is a live bug under either fork, so the lane is wanted either way — but the segment it writes takes *today's* identity value, which is the slug. Under D64(b) those directories are renamed, so R2 lands a second migration on top of the one it already carries for existing output. |
| **R6** | **Exposed in its key.** `claim(campaignId, jobId)` keys exclusion on whatever `campaignId` means. The seam survives the fork; the values in it do not. |

So the accurate claim is: **eleven of thirteen pieces of work are fork-independent and ready, and the
two that are exposed are exposed in the value of a key, not in whether the work is wanted.** Neither
R2 nor R6 should wait for D64 — a campaign that overwrites another's renders is a live defect today
— but both must be dispatched knowing they carry a rename if D64 lands on (b), and R2's brief must
say so where it already discusses migrating existing output. D64 still gates *server-side drafts,
server-minted ids, ownership, and the template library*. "We are blocked on the identity decision"
remains the wrong summary of this repo; "nothing we do now touches it" was the wrong correction.

**Sequencing.** F1 → F-D(F2) are sequential (both own `BriefEditor.tsx`). F3 is independent. The
R-lanes live in `apps/api` and `packages/`; the F-lanes live in `apps/web`. That package boundary is
what makes one web lane safe beside one api lane, and it is the only parallelism this plan claims.

---

## 3. Lanes

One lane = one worktree = one branch = one PR.

| Lane | Task | Owns | Gate |
|---|---|---|---|
| **F-A** | **A failed listing is its own state** (**D83**, F1 **and F6**). `loadBriefs` records the failure; the route-load effect distinguishes *listing failed* from *id unknown* and must not call `setUnknownId` on a failure. New copy in the campaign `messages.ts` in the M3 voice — name the fact, offer the way out (retry), and do **not** offer "start a new brief", which is the remedy that invites a duplicate. `StartFromExistingPicker.tsx:56-63` is the in-repo model. **F6 rides with it:** `fetchPersistedRun` (`run-context.tsx:200-209`) must distinguish *no persisted run* from *could not ask*; its `catch` currently answers the first for both. **Tests:** a rejected `listBriefs` on a named route shows the failure state and **not** the not-found state; an empty listing on a named route still shows not-found; the focus retry recovers to the loaded brief; a rejected `fetchPersistedRun` is not reported as an absent run. **Mutation:** make each catch swallow again → the matching test goes red. | `apps/web/src/components/campaign/BriefEditor.tsx`, `components/campaign/messages.ts` (append only), `lib/run-context.tsx`, their `__tests__` | none |
| **F-B** | **An overlay-depth counter in the kit, and a trap that actually contains** (**D84**, F3 **and F5**). *(1)* `DialogShell` tracks mounted depth; every shell but the topmost gets `inert` and drops `aria-modal`, and the counter is authoritative for **paint order** too, so a drawer (`z-50`) can never sit under a dialog (`z-[70]`) it was opened over. Retire F22's close-first workaround and delete its comment at `BriefPicker.tsx:72`. *(2)* **F5:** the Tab handler gains a containment branch — when `activeElement` is outside the dialog, Tab redirects into it. **Do not** touch the Escape guard; §1 verifies it is correct. **Tests:** with two shells open the lower is `inert` and carries no `aria-modal`, the upper carries it; closing the upper restores the lower; a single shell is unchanged; **with `activeElement` on `document.body`, Tab lands focus inside the dialog** (red today). **Mutation:** mark all shells inert → the restore test goes red; delete the containment branch → the body-focus test goes red. | `apps/web/src/components/ui/dialog-shell.tsx`, `components/shell/BriefPicker.tsx`, `components/shell/CreateCampaignDialog.tsx`, `components/shell/Header.tsx`, their `__tests__` | none |
| **F-C** | **The inset golden, settled** (**D85**, F4). Either record `compositor-goldens-insets.json` for `linux-x64` from a CI run, or state in the test that the non-zero inset path is proven on `darwin-arm64` only. **Recording is preferred**; the withdrawal is acceptable and must be explicit, never a silent skip. | `packages/CreativeGeneration/.../compositor-goldens-insets.json`, the compositor golden test | none |
| **F-D** | **The multi-window draft policy** (**D82**, F2), *shape decided by the owner's answer*. Under (a) the lane is a comment and a test naming the assumption. Under (b) or (c) it is a `storage` listener plus the chosen guard. **Whichever lands, the plan's §1 F2 correction goes in the code comment**: a same-window subscriber set is not the mechanism here. | `apps/web/src/components/campaign/BriefEditor.tsx`, `components/campaign/editor-state.ts`, their `__tests__` | **D82**, and **F-A** (same file) |
| **R1 – R6** | **Not re-specified.** See `2026-09-04_run-exclusion-and-the-distributed-lock.md` §3. | as that plan states | the owner's go-ahead |

**Dispatch shape.** F-A ‖ F-B ‖ F-C is safe — three disjoint file sets. F-D follows F-A (same
file). One R-lane may run beside one F-lane (different packages); R5 precedes R1, and R2 runs alone.

**F-B grew after review** and is now the largest F-lane: a depth counter, paint-order authority and
a focus-trap fix in the kit's own file, with three stacking sites in the blast radius. If it needs
splitting, the seam is *(1)* modality and paint order, *(2)* F5's containment branch — F5 is a
single-dialog defect and does not depend on the counter.

---

## 4. Definition of Done

Per lane, and the gate is the repo's, not a lane's:

1. `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn test:cov`, then commit, then
   `yarn sync:check` **on the committed tree**, then push. Coverage stays **100 % on all four
   counters**.
2. Every new user-facing string lives in `messages.ts` behind the jargon gate, appended, never
   edited in place.
3. **Every named test mutation-checked**: mutate the source, watch the named test go red, restore.
   The lane reports each mutation and its result. A test that stays green when its subject is broken
   is a vacuous tripwire and does not count as coverage.
4. No `getBoundingClientRect` and no computed-style assertions — happy-dom performs no layout.
5. The lane appends a `### 2026-09-0N — <lane>: …` block to `.agents/session-log.md` **and commits
   it**.
6. **Never `git add -A`** — `briefs/` and `assets/inputs/` are the owner's operator data. **Never
   start a dev server and never request `localhost:3000` / `:3001`** — those are the owner's live
   servers and a request there spends their GenAI credits.

For the plan as a whole: F1's false not-found state is unreachable; two stacked overlays expose
exactly one modal region; the inset golden's platform coverage is either recorded or stated; and
D82 is answered in writing before F-D is dispatched.

---

## 5. Open questions — for the owner and the reviewers

1. **D82.** (a) leave and document, (b) restore only when clean, or (c) notice and let the user
   choose? The plan recommends (c) and holds (a) to be defensible today.
2. ~~**F1's grade.**~~ **Settled (agy):** **H** stands. The `focus` retry is a real heal path but
   requires the user to blur and refocus the window; a user who sits on the false "not found" screen
   never triggers it, so the heal is neither automatic nor guaranteed.
3. **D85.** Record the linux inset map, or withdraw the claim in the test?
4. **D64** remains open and is not this plan's to take. §2's claim was checked and **corrected**:
   eleven of thirteen pieces are fork-independent; **R2 and R6 are exposed in the value of a key**,
   not in whether the work is wanted. Neither should wait, and both briefs must carry the rename
   risk. The owner is asked whether that is an acceptable bet, or whether D64 should be answered
   before R2 writes paths that may need renaming.
5. Should F-C be folded into an R-lane's PR rather than run as its own? It is a fixture change with
   no product surface, and a separate PR for it may cost more review than it earns.

---

## 6. Explicitly deferred

Unchanged from `2026-09-03_create-moment-and-pipeline-prerequisites.md` §6 — server-side drafts,
server-minted ids, ownership on the ports, the D62 template library, markets fan-out, presigned
uploads, external ingestion, and ports for reports/packages/output. Each waits on D64(b) or on the
migration plan, and this plan moves none of them.

Added here:

| Item | Waits on | Why not now |
|---|---|---|
| Removing the `wt-sync` worktree | nothing — housekeeping | Its branch `chore/hexagen-sync-upgrade` is 59 commits behind and its content landed long ago (§7). It is a stale checkout, not work. |
| A shared "the store is unreachable" treatment across every surface that reads the API | F-A landing first | F-A establishes the pattern in the editor; generalising it before there are two honest surfaces would be inventing an abstraction from one case. |

---

## 7. Corrections this plan records

Three items that recent notes carry as open, which the code at `f454d46` shows are closed. They are
recorded here so that the next session does not re-open them, and so that the memory files carrying
the stale claims can be corrected.

| Claim, as recorded | What the code shows |
|---|---|
| *"The arch-linter 0.8.0 → 0.12.1 decision is open, in the owner's `wt-sync` worktree."* | **Closed.** `package.json:30-31` on `main` pins `@hexagen-monaco/arch-linter` and `@hexagen-monaco/sync` at `^0.12.1`. The five empty-barrel deletions landed, CI runs `yarn sync:check` (`.github/workflows/ci.yml:77`) and `main` is green, so there is no drift. The `wt-sync` worktree is a stale checkout whose three-dot diff against `main` only *looks* like a pending upgrade because its merge base predates the one that shipped. |
| *"A `null` scalar reaches `delimit` at `OpenRouterCopyGenerator.ts:33` and throws — recorded for a follow-up lane."* | **Fixed.** `delimit` now reads `const flat = (value ?? "")…` (`OpenRouterCopyGenerator.ts:38-41`) and the doc comment above it cites D68 for why a null renders as an empty slot. No follow-up lane is needed. |
| *"`yarn lint:arch` does not check what a lane's DoD claimed (layer rules cover `packages/*/src` only)."* | **Superseded, with a caveat worth keeping.** 0.12.1 enforces the layer check for relative imports and bans node builtins in `domain` *and* `application`; the upgraded gate was proved to bite on a deliberate cross-layer relative import. The caveat that survives: `node:crypto` remains legitimately present in `infrastructure` (`FileSystemBackgroundCache.ts:3`, `NodeCryptoPolicyHasher.ts:1`) — that is the hash seam at the composition root, not a violation. |

A fourth correction, to this plan's own lineage: the wave-1 note recording F2 prescribed a fix that
does not work. §1 F2 states why, and **D82** replaces it. A recorded remedy is not evidence; the
mechanism is.

---

## 8. Review record

### agy (gemini-3.1-pro-high) — verdict **rework**, folded in

Four blockers, two majors, one minor. Every claim was verified against the code before it was
accepted or refuted; the disposition is below, and the plan above already carries the result.

| Finding | Disposition |
|---|---|
| **§2's headline claim is false — R2 depends on D64.** R2 writes physical paths keyed on `campaignId`, which is the slug today; under D64(b) those directories need renaming. | **Accepted.** §2 now carries a fork-exposure table. The correction is narrower than the finding: R2's *need* is fork-independent (campaigns overwrite each other today, on either fork) but its *key value* is not. R6 has the same exposure and the review did not name it — added. This is the second time in this arc a plan of mine claimed fork-independence too broadly; the first was corrected in `2026-09-03`'s §3. |
| **The Tab refutation is false** — with `activeElement` on `document.body`, neither branch matches and native Tab walks into the page behind. | **Accepted, and promoted.** This is worse than a wrong refutation: it is a live defect in *every* dialog, not only stacked ones, and v1 told a future lane it was out of scope. Now **F5 (H)**, with a containment branch and a test that is red today. The best finding of the review. |
| **The pointer refutation is false** — `DrawerShell` is `z-50` against the dialog's `z-[70]`, so a drawer over a dialog paints underneath. | **Accepted as written, scoped as a hazard.** The z-values are exactly as stated. But no such site exists: both drawers open from the editor and no dialog contains a control that opens one, so it is latent, not live. The claim in v1 ("two shells sit at equal z") was true of the only reachable stack and wrong as a general rule. F-B now owns paint order so it cannot become real silently. |
| **D82 option (b) does not avoid the livelock** — the recovery effect omits `state` from its deps, so a listener registered there reads a stale snapshot; and `saveDraftToStorage` stamps `Date.now()` on every write, so the listener fires on every autosave. | **Accepted.** Verified at `editor-state.ts:1399` and `BriefEditor.tsx:342-355`. Both mechanisms are now written into D82's option (b), which makes (c) and (a) look better by comparison — exactly what a decision entry should surface. |
| **Missed work: `fetchPersistedRun` swallows** (`run-context.tsx:200-209`) — an unreachable API is reported as "no run history". | **Accepted.** Now **F6 (M)**, folded into F-A because it is the same decision (D83). Graded M rather than H: the absent-history state offers no destructive remedy, where F1's offers "start a new brief". |
| **Missed work: TODOs and dozens of "Left open" entries in the session log**, citing `:1147` and `:1118` (the W0b bracket-alpha sweep, the `text-white` migration). | **Partly refuted, partly accepted.** The two cited entries are **closed** — the lane that closed them is four lines below at `:1151`, `## 2026-08-30 — W0b lane: the sweep W0 enabled`, and the 65 remaining alpha utilities are the supported form W0 introduced, not debt. A "Left open" line is open only until the next entry closes it. **But the underlying point stands:** the plan implied it enumerated everything. §0 now states its scope and §1.3 names the genuine older-arc stragglers (`:1576`, `:1162`, `ci.yml:109`) as deliberately uncosted. |
| **F1's grade: H is correct** — the focus retry needs a blur/refocus the user may never perform. | **Accepted**; §5's question 2 is settled and marked so. |

**Net effect:** two new findings (F5, F6), one refutation retracted and one scoped, the headline
claim corrected, and the plan's scope stated honestly. Three of the four blockers were real.

### grok-4.6 (high) — pending

Dispatched with the same brief at the same time. Reported as **unknown, not failed**: on the
create-moment plan this reviewer wrote nothing for 78 minutes and then delivered the most valuable
of three reviews at 84. Its findings will be folded in a second pass, and §8 updated in place.
