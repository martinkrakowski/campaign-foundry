# Remaining work: four unplanned defects, six specified lanes, and the one decision that gates the rest

**Date:** 2026-09-06
**Author:** orchestrator
**Status:** draft — for the owner's review, then the grok + agy two-reviewer pass
**Verified against:** `main` at `f454d46` (CI green, including the `hexagen sync --check` drift gate at `.github/workflows/ci.yml:78`)
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
| **D82** | **OPEN — the owner's call: what a second tab may do to a first tab's draft.** The editor autosaves to `cf:draft:<id>` and restores from it, but never observes a change written by anyone else. Two windows on the same campaign is therefore last-write-wins with no notice. Three candidate policies: *(a)* **leave it** — document the single-window assumption and add no mechanism; ~~*(b)* **restore only when the local tab is clean**~~ — **WITHDRAWN after review**, by two reviewers from different angles. agy: the recovery effect's deps are `[draftKey, routeId, routeLoadedId]`, so a listener registered there closes over a *stale* `state`, and `saveDraftToStorage` stamps `Date.now()` on every write (`editor-state.ts:1399`), so it fires on every autosave regardless of content. grok traced it further and showed (b) does not even buy what it promises: a clean tab B restores A's draft, is thereby made dirty (`isPristine`, `editor-state.ts:1323-1329`), **autosaves the restored state back over A's newer draft**, and from then on both tabs are dirty so neither restores — i.e. it degenerates into (a) after one exchange, having clobbered a write on the way. It also still yanks a *focused-but-clean* tab with the caret in a field. **Do not implement (b) as written.** *(d)* **an exclusive editor lock** (Web Locks API) — one tab owns the campaign, others open read-only; *(e)* **restore-and-notice** — (c)'s banner plus an explicit "load it" action; *(c)* **notice, never restore** — a `storage` listener raises a passive line ("this campaign changed in another window") and the user chooses. The plan recommends **(c)**, with **(a)** defensible today and **(d)** the honest answer if the cloud migration makes multi-window a supported story rather than an accident. **(c) is the only listed option that never writes another tab's state.** | The recorded fix for this — "give recovery the subscribe/notify watch the seed effect has" — is **wrong**, and the plan says so in §1 F2. Applied literally it is a no-op, and the mechanism that would actually work introduces a worse bug than the one it fixes: two active tabs each restoring the other's draft means neither can type. That is a product decision about a multi-window story that has never been stated, not an implementation detail a lane may take. **The reviewers then killed the plan's own middle option**, which is the strongest argument that this belongs to the owner and not to a lane. |
| **D83** | **A listing that failed is a different state from a listing that is empty, in the editor as well as in the picker.** `BriefEditor` treats them as one, and the consequence is that a valid campaign is reported to its owner as not existing. The distinction W2 already required of `StartFromExistingPicker` becomes the rule for every surface that reads `listBriefs()`. | The API was made honest about this in **#189** — a store read failure is a 500, not `{briefs: []}`. The web client then discards that honesty. Shipping a truthful API behind a lying UI is the worse of the two states, because the operator now has a false negative that looks authoritative. |
| **D84** | **Modality belongs to the kit, and the kit is BOTH shells.** *(widened after review, grok.)* A shared overlay-depth counter serves `DialogShell` **and `DrawerShell`** — both render `aria-modal="true"` today. Every overlay but the topmost is marked `inert`, only the topmost carries `aria-modal`, and the counter is **authoritative for paint order**, so mount-order topmost and visual topmost cannot diverge (`z-50` drawer under a `z-[70]` dialog). The **F22 close-first workaround retires** for kit overlays. **Two overlays are outside the kit and D84 does not silently cover them**: Save-as (`BriefEditor.tsx:1624-1631`) and `CommandBar`'s confirm (`CommandBar.tsx:373-437`) are hand-rolled `aria-modal` regions. They are either converted to the kit or carry a written exemption; what they may not do is sit outside a decision that claims to own modality. | Three sites stack overlays today and each solves it, or does not, by hand. A counter in the kit is one implementation with one test surface; the alternative is the same judgment repeated at every future call site, which is how F22 arose. |
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

- **Pointer — and the mechanism is NOT the one v1 named.** *(retracted twice; the second reviewer
  found what the first and the author both missed.)* v1 said the two shells "sit at equal `z`, so the
  later one in DOM order paints above." **False at the very site it cited.** The resume two-way
  passes `containerClassName="z-[80]"` (`CreateCampaignDialog.tsx:279`), and `cn`/`twMerge`
  (`lib/cn.ts:11-12`) lets that override the shell's default `z-[70]`. `ConfirmDialog` uses the same
  override (`confirm-dialog.tsx:37`). **Stacking works today because callers hand-raise `z`, not
  because DOM order is sufficient.** This matters concretely: F-B owns `CreateCampaignDialog.tsx`,
  and a lane told that DOM order suffices is one tidy-up away from deleting the override that is
  actually doing the work.
  The drawer/dialog hazard is also real — `DrawerShell` is `z-50` (`dialog-shell.tsx:287`) against
  the dialog's `z-[70]`, so mount-order "topmost" and paint order diverge the moment a drawer mounts
  over a dialog. **F-B owns paint order** and must make the counter authoritative for it.
- **Escape — correct for the kit, not for the product.** `dialogHoldsFocus` (`:41-44`, `:79`) does
  guard two `DialogShell`s, and the suite pins it (`dialog-shell.test.tsx:187-210`). But
  `CommandBar`'s own confirm closes on Escape unconditionally with no such guard
  (`CommandBar.tsx:395-397`), so "Escape is correct" is a statement about the kit and v1 stated it
  about the product.

**What is actually wrong:** two simultaneous `aria-modal="true"` regions is undefined for a screen
reader, and a virtual cursor — which does not travel by Tab — reads straight through the lower
dialog's content. The user hears a form they cannot operate.

**Retracted after review (agy): the Tab refutation was wrong, and it hid a bigger defect — see F5.**
v1 of this plan told a future lane that Tab containment was already correct and out of scope. It is
not, and a lane briefed on that would have shipped the escape hatch intact.

**Blast radius — v1 said "three sites" and that was wrong** *(review, grok)*. The overlay estate is
larger than the kit, and a counter on `DialogShell` alone cannot deliver what §4 promised. The
inventory:

| Overlay | Implementation | `z` |
|---|---|---|
| `DialogShell` (`CreateCampaignDialog`, `BriefPicker`, `Header`, `ConfirmDialog`) | the kit | `z-[70]`, callers raise to `z-[80]` |
| `DrawerShell` (`AssetPickerDrawer`, `HeadlinePoolDrawer`) | the kit, **second shell** — also `aria-modal` | `z-50` |
| **Save-as** (`BriefEditor.tsx:1624-1631`) | **hand-rolled** `role="dialog" aria-modal="true"`, own `useDialogFocusTrap` (`:202-214`) | `z-[70]` |
| **`CommandBar`'s confirm** (`CommandBar.tsx:373-437`) | **hand-rolled**, no `dialogHoldsFocus` | `z-50` |
| `EditorDirtyProvider`'s confirm (`editor-dirty-context.tsx:104-108`), `MobileMenu` (`:102`), the grid lightbox (`grid/page.tsx:719`) | mixed | `z-[60]` and others |

Save-as is stacked **by design** — the overwrite `ConfirmDialog` mounts on top of it and returns to
it (`BriefEditor.tsx:1604-1620`) — and it is not a `DialogShell`, so a kit counter does not see it.
That is why **D84 is widened and §4's claim is rewritten** below: a kit change fixes the kit, and the
two hand-rolled overlays need either conversion or an explicit exemption.

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

**Two more F1-class swallows, and one unowned decision** *(review, grok — accepted, and they belong
in scope, not in this straggler list)*:

| Item | Where | Disposition |
|---|---|---|
| `getPool` rejection swallowed — a down API looks like *no headlines* | `components/campaign/sections/CopySection.tsx:35-36` | **Named in D83.** Not folded into F-A: different file, different surface. A follow-on lane, or F-A's brief may take it if the owner prefers one sweep. |
| `listAssets` catch sets `[]` — a down API looks like an *empty asset bin*. `AssetPickerDrawer.tsx:39-40` is the honest counterpart in the same product | `components/shell/Sidebar.tsx:105-107` | **Named in D83**, same disposition. |
| **D78, the fence** — *"a lease is a liveness hint, not mutual exclusion, until the commit is conditional on still holding it."* **No R-lane owns it** (zero mentions across the lock plan's §3 rows); it is scheduled to land with the backend binding (`2026-09-04:96-98`). | `2026-09-04_run-exclusion-and-the-distributed-lock.md:45`, `:156` | **Real remaining pipeline work outside R1–R6.** This plan's "six specified lanes plus four defects" was therefore not the whole pipeline picture, and now says so. |

D83 is stated as "every surface that reads `listBriefs()`", which is too narrow for what it is
actually about. **Read it as: a failed read is never presented as an empty result.** F-A proves the
pattern on the two surfaces it owns; the two above are named so nobody reads this plan as having
cleared them.

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
| **R2** | **Exposed, and it writes the exposure to disk.** Output paths carry no campaign segment today (`GenerateCampaignUseCase.use-case.ts:271-273`); R2's job is to add one, and `campaignId` *is* `brief.id`, the slug (`generate.post.ts:73-82`). Reports are already slug-files (`report.ts:21-23`) and the grid serves whatever the report stored (`grid/page.tsx:17-18`). So R2 stamps today's slug onto **durable bytes**, not just a runtime key. Under (b) that string is wrong; under (a) a rename orphans the new tree — which is what D74 already warned. The *want* is fork-independent; the *implementation* is not. |
| **R6** | **Exposed — and the lock plan already said so, in words this plan first dropped.** That plan reads: *"Nothing here needs D64 answered; **R6's key shape does**, which is why D81 makes the key a parameter"* (`2026-09-04:127-128`), and its §5 opens with *"D64. Still open, and R6's key shape waits on it"* (`:153`). D81 lets R6 **start** without D64; it does not let it **bind** the key. v1 of this plan quoted the first half of that sentence and dropped the second. |

So the accurate claim is: **eleven of thirteen pieces are fork-independent; R2 and R6 are not, and R2
is the serious one because its exposure is written to disk.** Neither should wait for D64 — a
campaign that overwrites another's renders is a live defect today — but R2's brief must carry the
rename risk where it already discusses migrating existing output, and R6 must ship as an
opaque-key seam with the binding deferred, exactly as D81 intends. D64 still gates *server-side
drafts, server-minted ids, ownership, and the template library*.

**"We are blocked on the identity decision" remains the wrong summary of this repo. "Nothing we do
now touches it" was the wrong correction, and this is the third time in this arc a plan of mine has
reached for it** — the create-moment plan's §3 was corrected the same way on 2026-09-03. The pattern
is worth naming: fork-independence of a *need* keeps getting written down as fork-independence of an
*implementation*. A future plan should state the two separately by default.

**Sequencing.** F1 → F-D(F2) are sequential (both own `BriefEditor.tsx`). F3 is independent.

**The package-boundary rationale v1 gave for parallelism is false** *(review, grok)*. R-lanes do not
stay out of `apps/web`: R2 owns `apps/web/src/app/(shell)/grid/page.tsx` and R4 owns
`apps/web/src/lib/briefs-api.ts` — both are in the lock plan's own ownership rows. Parallelism has to
be argued from **file** disjointness, which is what §3 now does, not from a package line that does
not hold.

---

## 3. Lanes

One lane = one worktree = one branch = one PR.

| Lane | Task | Owns | Gate |
|---|---|---|---|
| **F-A** | **A failed listing is its own state** (**D83**, F1 **and F6**). `loadBriefs` records the failure; the route-load effect distinguishes *listing failed* from *id unknown* and must not call `setUnknownId` on a failure. New copy in the campaign `messages.ts` in the M3 voice — name the fact, offer the way out (retry), and do **not** offer "start a new brief", which is the remedy that invites a duplicate. `StartFromExistingPicker.tsx:56-63` is the in-repo model. **F6 rides with it:** `fetchPersistedRun` (`run-context.tsx:200-209`) must distinguish *no persisted run* from *could not ask*; its `catch` currently answers the first for both. **Tests:** a rejected `listBriefs` on a named route shows the failure state and **not** the not-found state; an empty listing on a named route still shows not-found; a rejected `fetchPersistedRun` is not reported as an absent run. **On the retry test — v1's was vacuous** *(review, grok)*: "the focus retry recovers" passes while the defect that actually lies is untouched, because `window` `focus` never fires for a user who stays on the page, and `loadBriefs` has no generation counter of its own (the capabilities effect at `:300-325` has one; this does not). The test that earns its place asserts **in-page recovery** — a retry affordance in the failure copy, exercised without a focus event. **Mutation:** make each catch swallow again → the matching test goes red; remove the in-page retry → the recovery test goes red. | `apps/web/src/components/campaign/BriefEditor.tsx`, `components/campaign/messages.ts` (append only), `lib/run-context.tsx`, their `__tests__` | none |
| **F-B** | **An overlay-depth counter in the kit, and a trap that actually contains** (**D84**, F3 **and F5**). *(1)* `DialogShell` tracks mounted depth; every shell but the topmost gets `inert` and drops `aria-modal`, and the counter is authoritative for **paint order** too, so a drawer (`z-50`) can never sit under a dialog (`z-[70]`) it was opened over. Retire F22's close-first workaround and delete its comment at `BriefPicker.tsx:72`. *(2)* **F5:** the Tab handler gains a containment branch — when `activeElement` is outside the dialog, Tab redirects into it. *(3)* **Preserve the `z-[80]` overrides** at `CreateCampaignDialog.tsx:279` and `confirm-dialog.tsx:37` unless the counter replaces what they do — they, not DOM order, are what stacks those dialogs today. The `dialogHoldsFocus` Escape guard is correct **for the kit** and needs no change; it is the hand-rolled overlays that lack it. **Tests:** with two shells open the lower is `inert` and carries no `aria-modal`, the upper carries it; closing the upper restores the lower; a single shell is unchanged; **with `activeElement` on `document.body`, Tab lands focus inside the dialog** (red today). **Mutation:** mark all shells inert → the restore test goes red; delete the containment branch → the body-focus test goes red. | `apps/web/src/components/ui/dialog-shell.tsx` (**both shells**), `components/shell/BriefPicker.tsx`, `components/shell/CreateCampaignDialog.tsx`, `components/shell/Header.tsx`, `components/ui/confirm-dialog.tsx`, their `__tests__`. **Not owned, and that is the point:** Save-as (`BriefEditor.tsx`) and `CommandBar`'s confirm are hand-rolled `aria-modal` regions this lane cannot reach — see the DoD. | none |
| **F-C** | **The inset golden, settled** (**D85**, F4). Either record `compositor-goldens-insets.json` for `linux-x64` from a CI run, or state in the test that the non-zero inset path is proven on `darwin-arm64` only. **Recording is preferred**; the withdrawal is acceptable and must be explicit, never a silent skip. | `packages/CreativeGeneration/src/infrastructure/adapters/__tests__/fixtures/compositor-goldens-insets.json`, `NodeCanvasCompositor.goldens.test.ts` (the inset `describe` and its `skipReasons`, `:133-149`) | none |
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

For the plan as a whole: F1's false not-found state is unreachable and recoverable without leaving
the page; the focus trap contains a body-focused Tab; the inset golden's platform coverage is either
recorded or stated; and D82 is answered in writing before F-D is dispatched.

**On modality, stated so it is achievable** *(rewritten after review, grok)*. v1 promised "two
stacked overlays expose exactly one modal region", which a kit-only lane cannot deliver — Save-as
and `CommandBar`'s confirm are hand-rolled `aria-modal` regions outside `DialogShell`. The honest
DoD: **every overlay in the kit — both shells — participates in one depth counter, and each
overlay outside the kit is either converted or carries a written exemption naming why.** A plan
whose DoD cannot be met by the lane it defines is worse than one that admits the estate is bigger.

---

## 5. Open questions — for the owner and the reviewers

1. **D82.** **(b) is withdrawn** — both reviewers killed it independently (§0.1). The live options
   are (a) leave and document, (c) notice and let the user choose, (d) an exclusive editor lock, or
   (e) restore-and-notice. Both reviewers land on **(c) or (a)**; the plan recommends (c).
2. ~~**F1's grade.**~~ **Settled (agy):** **H** stands. The `focus` retry is a real heal path but
   requires the user to blur and refocus the window; a user who sits on the false "not found" screen
   never triggers it, so the heal is neither automatic nor guaranteed.
3. **D85.** Record the linux inset map, or withdraw the claim in the test?
4. **D64** remains open and is not this plan's to take. §2's claim was checked and **corrected**:
   eleven of thirteen pieces are fork-independent; **R2 and R6 are exposed in the value of a key**,
   not in whether the work is wanted. Neither should wait, and both briefs must carry the rename
   risk. The owner is asked whether that is an acceptable bet, or whether D64 should be answered
   before R2 writes paths that may need renaming.
5. ~~Should F-C be folded into an R-lane's PR?~~ **Settled (grok):** keep it small and separate, or
   attach it to a compositor-only change — **not** to R5, which already shares
   `GenerateCampaignUseCase` with R2. And it must not be a reason to slow F-A.
6. **New, for the owner:** the two hand-rolled `aria-modal` overlays (Save-as, `CommandBar`'s
   confirm). Convert them to the kit, or grant a written exemption? D84 refuses to cover them
   silently, so one of the two has to be chosen.

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
| *"The arch-linter 0.8.0 → 0.12.1 decision is open, in the owner's `wt-sync` worktree."* | **Closed.** `package.json:30-31` on `main` pins `@hexagen-monaco/arch-linter` and `@hexagen-monaco/sync` at `^0.12.1`. The five empty-barrel deletions landed, CI runs `yarn sync:check` (`.github/workflows/ci.yml:78`, under the step named at `:76`) and `main` is green, so there is no drift. The `wt-sync` worktree is a stale checkout whose three-dot diff against `main` only *looks* like a pending upgrade because its merge base predates the one that shipped. |
| *"A `null` scalar reaches `delimit` at `OpenRouterCopyGenerator.ts:33` and throws — recorded for a follow-up lane."* | **Fixed.** `delimit` now reads `const flat = (value ?? "")…` (`OpenRouterCopyGenerator.ts:38-41`) and the doc comment above it cites D68 for why a null renders as an empty slot. No follow-up lane is needed. |
| *"`yarn lint:arch` does not check what a lane's DoD claimed (layer rules cover `packages/*/src` only)."* | **NOT superseded — this plan's own correction was wrong, and it is withdrawn** *(review, grok)*. Two different claims were conflated. **Closed:** 0.12.1 enforces the layer check for *relative* imports, proved on a deliberate cross-layer import. **Still true:** the *scope* claim. `.architecture/layout.yaml` names only `domain` / `application` / `infrastructure`, and the arch reviewer path-filters on `packages/*/src/**` (`pr-agent-arch.yml:42-46`), so `apps/api` and `apps/web` — both composition roots — remain outside the graph. **A lane's DoD that cites `lint:arch` for an `apps/` claim is still citing a gate that cannot see it.** A wrong "closed" here is worse than the stale note it replaced, because it tells the next session to stop looking. Separately and unchanged: `node:crypto` in `infrastructure` (`FileSystemBackgroundCache.ts:3`, `NodeCryptoPolicyHasher.ts:1`) is the hash seam at the composition root, not a violation. |

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

### grok-4.6 (high) — verdict **rework**, folded in

Two blockers, four majors, three minors — and the deeper of the two reviews. It overturned findings
the first review had *accepted*, which is the case for running both. Every claim below was verified
against the code before disposition.

| Finding | Disposition |
|---|---|
| **B1. §2's claim is false: R2 writes today's slug into durable output, and the lock plan already said R6's key shape waits on D64.** | **Accepted in full, and it is the worst error in the plan.** The lock plan reads *"Nothing here needs D64 answered; **R6's key shape does**"* (`2026-09-04:127-128`) and its §5 opens *"D64. Still open, and R6's key shape waits on it"* (`:153`). v1 quoted the first half of that sentence and dropped the second — a misrepresentation of the document it was citing. R2 is worse than a key: it stamps the slug onto **durable bytes** (`GenerateCampaignUseCase.use-case.ts:271-273`, `report.ts:21-23`, `grid/page.tsx:17-18`). The first review reached the same conclusion about R2 from a weaker angle; grok found the citation that settles it. |
| **B1(b). The package-boundary parallelism rationale is false.** R2 owns `apps/web/.../grid/page.tsx`; R4 owns `apps/web/src/lib/briefs-api.ts`. | **Accepted.** Both are in the lock plan's own ownership rows, which were in front of the author. Parallelism is now argued from file disjointness. |
| **B2. F-B cannot meet §4's DoD**, because Save-as (`BriefEditor.tsx:1624-1631`) and `CommandBar`'s confirm (`:373-437`) are hand-rolled `aria-modal` regions outside `DialogShell`, and `DrawerShell` is a second kit shell the counter was not specified to cover. | **Accepted.** D84 now covers both kit shells and refuses to cover the hand-rolled two silently; §4's DoD is rewritten to something the lane can actually deliver. A DoD a lane cannot meet is worse than an honest admission that the estate is bigger. |
| **M1. The pointer refutation names the wrong mechanism.** The stack works because the caller passes `containerClassName="z-[80]"` (`CreateCampaignDialog.tsx:279`), not because of equal `z` and DOM order. | **Accepted, and this is the sharpest catch.** Both the author and the first reviewer reasoned from an equal-`z` premise that is false at the cited site. F-B owns that file, so a lane briefed on v1 was one tidy-up away from deleting the override doing the work. F-B now has an explicit instruction to preserve it. |
| **M1(b). The Escape refutation is a kit fact stated as a product fact** — `CommandBar.tsx:395-397` closes unconditionally with no `dialogHoldsFocus`. | **Accepted**; §1 F3 now says which claim is about the kit and which about the product. |
| **M2. D82's option (b) does not avoid the livelock** — a clean tab restores, is made dirty by restoring, autosaves the restored state back over the newer draft, and thereafter both tabs are dirty so neither restores: it degenerates into (a) having clobbered a write. The option space is also incomplete. | **Accepted.** (b) is **withdrawn**; (d) an exclusive editor lock and (e) restore-and-notice are added. Two reviewers killing the plan's own middle option from different angles is the strongest evidence that D82 belongs to the owner. |
| **M3. §7 row 3's correction is itself wrong.** 0.12.1 closed *relative cross-layer imports*; the *scope* claim is a different one and still true — `pr-agent-arch.yml:42-46` path-filters to `packages/*/src/**`, so `apps/` stays outside the graph. | **Accepted and withdrawn.** Verified. A wrong "closed" is worse than the stale note, because it tells the next session to stop looking — the exact failure mode §7 exists to prevent, committed inside §7 itself. |
| **M4. Missed work:** two more F1-class swallows (`CopySection.tsx:35-36`, `Sidebar.tsx:105-107`) and **D78, the fence, which no R-lane owns**. | **Accepted.** All three named in §1.3. D78 means "six specified lanes plus four defects" was not the whole pipeline picture. D83's wording is also widened: *a failed read is never presented as an empty result*, not "every surface that reads `listBriefs()`". |
| **m1. F1 is H, and F-A's focus-retry test is vacuous** — `window` `focus` never fires for a user who stays on the page, and `loadBriefs` has no generation counter. | **Accepted.** The grade was already H; the test was the real finding. F-A now requires an **in-page** retry affordance and a test that exercises recovery without a focus event. A test that goes green while the lying path is untouched is the vacuous-tripwire class this repo already refuses. |
| **m2. F4/D85 is accurate.** | Noted; no change. |
| **m3.** `ci.yml:77` is the step name, `:78` is the run; F-C's path omits `__tests__/fixtures/`. | **Accepted**; both corrected. |

### Where the two reviewers disagreed, and what it bought

On F3's pointer refutation agy said the equal-`z` premise held for two `DialogShell`s and objected
only to drawer-over-dialog. grok showed the premise was false **at the cited site** — the `z-[80]`
override is what stacks it. Folding only the first review would have left a wrong mechanism in a
lane brief that owns the file. **Both reviews returned `rework`; the second changed more.**
