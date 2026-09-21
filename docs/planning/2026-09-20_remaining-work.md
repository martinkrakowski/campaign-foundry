# The remaining work — a scheduling plan

**Date:** 2026-09-20 · **Status:** on `main` as of #540 · **Nothing dispatched.**
**Scope:** every open lane in this repository as of `bd242dc`, ordered for parallel execution. This
plan **introduces no new work** — every lane below already exists in another document, and this one
only decides _when_ each runs and _who owns which file_.
**Related:** every plan it schedules is cited per lane. The open-lane inventory it draws on was
derived on 2026-09-20 by checking each cited PR with `git merge-base --is-ancestor` (164 verified,
0 problems) rather than read off a merge list.

**Lane ids are prefixed `RW-`, and decisions `RW-D`, deliberately.** A 2026-09-20 sweep found the
same bare key meaning different things in up to **eight** documents (`M4`), four (`L7`, `S1`, `W2`,
`L10`, `L11`) and three (`R5`). A bare id is not an address in this repository, so this document
does not mint one.

**It failed that rule twice in its own first draft, and review caught both.** RW-4 and RW-5 cited
bare `L10`/`L11` — two of the very ids named above as ambiguous — and seven `§` references pointed
at planning-document sections while the repository's `§` convention resolves to **DESIGN.md**.
Both are corrected below. Neither was a slip of the pen: they are how easily a document argues for
a discipline and then does not apply it.

**It failed a third time after merge, and the hatch was never a hatch.** Wave B parked RW-7 on
`editor-state.ts` beside RW-5 and offered "or RW-7 moves to Wave C" as the escape. Wave C's RW-3
owns that same file as one of its nine `RATIO_VALUES` consumers — `RATIO_OPTIONS` is the re-export,
and `editor-state.test.ts` pins `axisProductSize` at **36** in two places (`:2124` and `:2134`). The
test's own comment spells the product (`1 × 3 ratios × 2 × 2 × 1 × 3 × 1`); the default state
selects `[...RATIO_OPTIONS]`, so a fourth ratio propagates and both expects become 48. Wave D's
RW-15 owns `TimelineTape.tsx`. Only Wave A is free. RW-7 runs there **behind RW-1**, not beside it:
the flake test mounts `<BriefEditor>` (`brief-editor.creatives.test.tsx:338`) and RW-7 owns that
file, so a parallel run would poison the measurement.

---

## 0. Decisions

| ID        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RW-D1** | **`packages/CreativeGeneration` is ONE lane at a time.** **Eight** golden fixture families live in one directory — the four named in the first draft plus `-display`, `-display-insets`, `-insets` and `-mp4` — and a golden must be recorded **by the CI runner itself** (`gh workflow run ci.yml -f record_goldens=true`) because container-recorded Linux cells differed in all 16. Two lanes re-recording concurrently cannot both be proven.                                                                                                        | This is the **critical path**, and it is a scheduling fact rather than a preference. Four lanes enter that package and run **one per wave** — RW-4, RW-5, RW-3, RW-15 — not because they depend on each other but because the lock is a package, not a file. **Only some of them move bytes:** RW-4's source says goldens are _unedited_ (frames default to today's geometry), so the lock protects the shared source files and the recording run, not a byte change that lane does not make. `record_goldens_suite` also offers a per-suite mode, so a recording need not be all-or-nothing. |
| **RW-D2** | **`BriefEditor.tsx` is the second contended file, and it is scheduled, not locked.** Almost every UI lane reaches it — it mounts the sheet, the rail, the tape and the dialog. Its `railSlot` `useCallback` carries a **hand-maintained dependency list** whose staleness is invisible to the type checker **and to render counts**. `BriefEditor.tsx` says so itself: a missing dependency there “does not show up as a slow form. It shows up as a STALE one, silently … which no render count can see”. It was proved by a **mutation**, not a count. | At most **one** lane owning `BriefEditor.tsx` per wave. A second lane needing it waits rather than merging into a conflict, because the merge that reconciles two dep-list edits is the one nobody reviews properly.                                                                                                                                                                                                                                                                                                                                                                          |
| **RW-D3** | **`messages.ts` and the two barrels are append-only and therefore free.** `scripts/merge-prs.sh` resolves ordinary text conflicts in `messages.ts`, `components/ui/index.ts` and `ports/out/index.ts` by keeping both sides.                                                                                                                                                                                                                                                                                                                             | Shared freely across concurrent lanes. **Verified the hard way on 2026-09-20:** TL6 and TL7 both appended to `messages.ts` and the rebase resolved by keeping both — but the conflict boundary fell mid-function and silently ate a closing brace, which `tsc` caught. **Keep both sides, then typecheck, never eyeball.**                                                                                                                                                                                                                                                                    |
| **RW-D4** | **A blocked lane is not scheduled.** Eight named lanes below wait on an unanswered question, plus RW-25 which is a bucket of four-plus counted as one row, and this plan does not guess an answer to make a wave look full.                                                                                                                                                                                                                                                                                                                              | RW-12 (`RunRegistryPort`) and the whole `2026-09-03_create-moment-and-pipeline-prerequisites.md` §6 deferral list wait on **D64**; RW-9 (multi-window drafts) waits on **D82**; RW-14 (SE0) is a presentation question two documents answer differently. **RW-7 does not wait on D138** — that decision was answered 2026-09-16; the first draft of this row still named it, which is how a lane with a home got described as blocked in the same document that scheduled it. They appear in **§5 of this document** with their blocker named, not in a wave.                                                                                                  |
| **RW-D5** | **Every lane pays the same gate, and the gate is the estimate.** 100 % statements/branches/functions/lines, one replayed mutation, `plan:verify`, `lint:arch`, `lint:bytes`, `format:check`, and the drift gate.                                                                                                                                                                                                                                                                                                                                         | Tests cost **3–4×** the code on this codebase. Every figure below is gate-inclusive; a "one file" lane is never a one-hour lane. Measured today: K5 was ~40 minutes of authoring and ~4 hours in total.                                                                                                                                                                                                                                                                                                                                                                                       |
| **RW-D6** | **Budget one review round per lane.** Every lane merged on 2026-09-20 had at least one real finding, including two where a test I wrote **could not fail** against the defect it named.                                                                                                                                                                                                                                                                                                                                                                  | The round is in the estimate, not optimism on top of it. A lane with no finding is a lane whose reviewers were rate-limited, not a lane that was perfect.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 1. Findings

| #      | Sev          | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **Critical** | **`D64` gates more scheduled work than any other single fact in this repository.** Server-side drafts, server-minted ids, ownership on the ports, the D62 template library, markets fan-out, presigned uploads, external ingestion, and ports for reports/packages/output are _all_ behind it — plus RW-12. It is a fork (slug-as-key vs database-fronted) that only the owner can settle, and until it is settled that work cannot be scoped, let alone sequenced. **Answering D64 is worth more than any lane below.**                                                                                                                                                                                                                           |
| **H1** | High         | **The creative-authoring arc is a chain, not a set.** RW-4 (frames) → RW-6 (frame form) → RW-8 (canvas handles), and RW-8 additionally needs a **preview-footprint API that has never been minted as a lane anywhere**. Three sequential lanes plus an unwritten fourth is the longest dependency run in the tree, which is why it starts in Wave A rather than waiting.                                                                                                                                                                                                                                                                                                                                                                           |
| **H2** | High         | **`brief-editor.creatives.test.tsx` failed three times on 2026-09-20 in LOCAL `yarn test:cov` runs**, a different test each run, on branches touching no web code; every re-run passed, and it has not recurred. **CI never saw it** — the only two CI failures that day were the drift gate and a dead mutation anchor, both recorded in §6.2. The first draft of this finding claimed every lane's CI was downstream of it, which the run history does not support and which was the argument for running RW-1 first. **It still runs first, for the weaker and honest reason:** three local failures with no mechanism is a signal nobody can currently act on, and the next person to see a red local run will not know whether to believe it. **It also runs before RW-7:** the test mounts `<BriefEditor>` (`:338`) and RW-7 owns that file. A parallel run would make a red result uninterpretable and a green one prove nothing against the tree that shipped. |
| **M1** | Medium       | **VE4's estimate is the least trustworthy figure here.** Ten confirmed contract defects sit in front of it, it needs a real audio mix (the encoder maps exactly one audio track), and whether the producer is a separate service or a TypeScript port is undecided. The week below is a placeholder that should be re-estimated once those three are settled — not planned against.                                                                                                                                                                                                                                                                                                                                                                |
| **M2** | Medium       | **Two UI holes have no lane and no owner.** The summoned mobile rail gets no brief (`BriefEditor.tsx:1604`) and no tape (`:1629`); and below the rail breakpoint there is **no layer editing at all**. Both are decisions before they are work, and both are small once decided.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **L1** | Low          | **Bookkeeping has accumulated into its own lane.** M4's unapplied amendments, PD1/PD2/PD4, `2026-09-10_the-unowned-gaps.md` §42's id-collision grep, the D-id index, V3's stranded fence. Individually trivial, collectively a day, and every one of them is a thing a future reader will trust and be wrong about.                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 2. The lanes

**Corrected 2026-09-20 after an adversarial review** (§7), **and again the same day after merge**
when the Wave B hatch for RW-7 turned out not to be a hatch, and once more when putting RW-7 in
Wave A *beside* RW-1 turned out to poison the flake measurement. The first draft of this table was
wrong in ways that changed the schedule: two lanes were scheduled that are blocked, one blocked
lane was already unblocked, and two lanes' ownership omitted files they must touch. Every row below
now names the files its **source plan** requires, not the ones I assumed.

Ownership is exclusive **among lanes running in the same wave**. Exclusive ownership does not catch
a test that mounts the file the other lane is editing — RW-1 and RW-7 are sequenced for that
reason, not because they share a file.

| Lane      | What it delivers                                                                                                                                                                                    | Owns                                                                                                         | Source                                         | Est.             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------- |
| **RW-1**  | **Characterise the `creatives` flake** — reproduce, then fix or quarantine with a reason. See H2: it was seen **locally**, never in CI.                                                             | `brief-editor.creatives.test.tsx`                                                                            | H2                                             | 0.5 d            |
| **RW-2**  | **Real job progress.** `done`/`total` are `0/0` while running and jump to `n/n` at the end.                                                                                                         | `fs-job-store.ts`, `jobs.ts`, `routes/campaigns/jobs/[id].get.ts`, the web poller                            | `randomized-campaigns-and-motion.md` §10       | 0.5 d            |
| **RW-3**  | **4:5 aspect ratio.**                                                                                                                                                                               | `aspect-ratios.ts`, compositor, **goldens**, **nine web consumers** (one is `editor-state.ts` — `RATIO_OPTIONS` is the re-export; the 3-ratio product is pinned at 36 in two places, `:2124` and `:2134`), and `messages.test.ts`'s raw-ratio gate | same §10, Q2                                   | **2 d**          |
| **RW-4**  | **Per-layer frames** (`creative-templates-and-units.md`'s L10a — the _field_, not the click-to-select half). **Its source says goldens are UNEDITED**: frames default to today's geometry. **Pre-dispatch, not pre-merge:** does a frame need dropping from `canonicalLayer` the way `enabled` / `elements` / `props` / `tracks` already are? If yes, this lane acquires `editor-state.ts` and collides with RW-7. Ten minutes against D130 before Wave A starts. | `creative-geometry.ts`, `brief-template.ts`, compositor                                                      | D130                                           | 2 d              |
| **RW-5**  | **The `fill` kind and generative region** (that plan's L11; = `finishing-video.md`'s VF3).                                                                                                          | `brief-template.ts`, compositor, **goldens**, **`editor-state.ts`**, **`LayerPropsSheet.tsx`**               | D131/D132                                      | 2 d              |
| **RW-7**  | **Beat-boundary drag** (`studio-editor.md`'s TL3). **Not blocked** — D138 was answered on 2026-09-16 ("drag allowed, as a neighbour transfer; commit and flag"). **The rail host wires the callback** — `TimelineTape` cannot dispatch (the word itself is forbidden), so `BriefEditor.tsx` passes it the way TL6 passed `onDiamondCommit`. | `TimelineTape.tsx`, `editor-state.ts`, **`BriefEditor.tsx`**                                                  | TL3                                            | 1 d              |
| **RW-10** | **Overlay depth counter (F-B / D84)** — `inert` on all but the topmost, one `aria-modal`.                                                                                                           | `packages/ui/src/dialog-shell.tsx`                                                                           | `remaining-work-and-the-migration-gate.md` F-B | 0.5 d            |
| **RW-11** | **Design-system drift** — the four audit items. `text-white` is in **11 files / 26 sites**, none of them `BriefEditor.tsx`, `LayerPropsSheet.tsx`, `TimelineTape.tsx` or `editor-state.ts`.         | `DESIGN.md`, tokens, `packages/ui`, 11 `.tsx`                                                                | `create-dialog-design-audit.md` R1–R4          | 0.5 d            |
| **RW-13** | **Fence tokens on guarded writes (D78).** **No lane owns this anywhere** — scope before building.                                                                                                   | `ports/`, stores                                                                                             | `run-exclusion…` D78                           | scope first      |
| **RW-15** | **Audio clip on the tape** (TL4). **Also owns `CanvasFfmpegVideoCompositor.ts`** — the caption reads the encoder's rounding from it, exported rather than recomputed. Tape has **two** mount sites. | `TimelineTape.tsx`, `TimelineSection.tsx`, `BriefEditor.tsx`, `CanvasFfmpegVideoCompositor.ts`               | TL4                                            | 1 d              |
| **RW-18** | **Bookkeeping** — M4's amendments, PD1, PD4, `the-unowned-gaps.md` §42's collision grep, the D-id index, V3's fence. **PD2 is NOT here** — see RW-21.                                               | `docs/`, `.claude/skills/`                                                                                   | L1                                             | 1 d              |
| **RW-20** | **VE4 — voiceover and captions.**                                                                                                                                                                   | audio service, compositor, **goldens**                                                                       | `video-editing-features.md` VE4                | ~1 w, **M1**     |
| **RW-21** | **PD2 — give SG-D1 a lane or record it deferred.** Not bookkeeping: until it lands, §3.3's treatments drop is a live silent drop with no owner and `ModePanel` still renders.                       | decision, then `BriefEditor.tsx`                                                                             | `projection-drop-measurement.md` PD2           | decision + 0.5 d |
| **RW-22** | **L7's remainder** — template thumbnails and any write path.                                                                                                                                        | template library                                                                                             | `creative-templates-and-units.md` status line  | 1 d              |
| **RW-23** | **D136's aggregation half** — the occlusion advisory reaches the editor and no further.                                                                                                             | compositor, editor                                                                                           | `reconciliation.md` §5 gap 6                   | 0.5 d            |
| **RW-24** | **Slots M1** — the mixed static+motion ceiling overcount, recorded with no lane.                                                                                                                    | planner                                                                                                      | `creatives-as-slots.md`                        | 0.5 d            |

### Blocked — named, not scheduled (RW-D4)

| Lane                                       | Blocker                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RW-6** frame form (SE3)                  | **The L10a/L10b split has never been recorded** in `creative-templates-and-units.md`, and `studio-editor.md` §0 C1 says SE3 and SE5 "stay blocked until that plan records them". Scheduling it in the first draft violated this plan's own RW-D4. |
| **RW-8** canvas handles (SE5)              | The same split, **plus** L10b (click-to-select) which appears in no lane, **plus** the preview-footprint API which has never been minted.                                                                                                         |
| **RW-9** multi-window drafts (F-D)         | **D82**, unanswered.                                                                                                                                                                                                                              |
| **RW-12** `RunRegistryPort` (R6)           | **D64** — the key shape _is_ the identity model.                                                                                                                                                                                                  |
| **RW-14** SE0                              | Two documents answer oppositely.                                                                                                                                                                                                                  |
| **RW-16** Browse over a real library (CC7) | Needs scoping: TM1–TM4 partly dissolved its stated blocker.                                                                                                                                                                                       |
| **RW-17** resume inline (W2b)              | **D89(b) is owner-opt-in and unstamped**; its own plan also recommends waiting for D84 (= RW-10). Scheduling it in the first draft violated RW-D4 a second time.                                                                                  |
| **RW-19** the two unowned UI holes         | Two decisions.                                                                                                                                                                                                                                    |
| **RW-25**                                  | **A bucket, not a lane.** Also open, also unscheduled: **D34**'s copy axes (vibes/directions/subline, never planned), **D51** per-creative finishing, **TS-Q1**, and **seat-selection S1–S4**. Counting this row as one is how "nine blocked lanes" under-counted. |

---

## 3. Execution order

Two locks and one rule shape every wave: **one lane at a time inside
`packages/CreativeGeneration`** (RW-D1), **one lane per wave owning `BriefEditor.tsx`** (RW-D2),
and **a blocked lane does not occupy a slot** (RW-D4).

### Wave A — three in parallel, ~2 days

| Slot | Lane                                      | Why it can run alongside                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **RW-4** frames                           | Holds the `CreativeGeneration` lock. Longest chain in the tree. Domain and compositor files, not the editor — **pending the pre-dispatch check on `canonicalLayer`**, recorded on the RW-4 row.                                                                                                                                                                                   |
| 2    | **RW-11** drift → **RW-10** overlay depth | `packages/ui` and tokens; `text-white` is in 11 files / 26 sites, none of them `TimelineTape.tsx`, `editor-state.ts` or `BriefEditor.tsx`.                                                                                                                                                                                                                                         |
| 3    | **RW-1** flake → **RW-7** beat drag       | Sequenced inside the slot, 0.5 d then 1 d, **1.5 d in a 2-day wave**. Not a file collision — RW-1 owns the test, RW-7 owns `BriefEditor.tsx` — but the test mounts `<BriefEditor>` (`:338`), so a parallel run would make a red result uninterpretable and a green one prove nothing against the tree that shipped. The tape's section host does not have to take the callback; TL6 left diamonds unwired there the same way. |

**Before dispatching Wave A, not before merging this document.** Ten minutes against D130: does a
per-layer frame need dropping from `canonicalLayer` (`editor-state.ts:1390`) the way `enabled`,
`elements`, `props` and `tracks` already are? Each of those four was added because a brief loaded
from disk carrying spelled-out defaults dirtied on sight — that is what SE2 was, and what K5 had
to add for `tracks: []`. A frame is the same shape. If it needs canonicalising, RW-4 acquires
`editor-state.ts` and collides with RW-7 in this wave. It may genuinely not: RW-4 is the field
only, and the editor cannot author a frame until RW-6. **"The editor cannot author it" is exactly
the reasoning that was wrong for fill.**

### Wave B — two in parallel, ~2 days

| Slot | Lane                  | Note                                                                                                                                                                                                                                                         |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **RW-5** fill         | Holds the lock. **Also owns `editor-state.ts` and `LayerPropsSheet.tsx`** — the editor cannot author a `fill` today (`LayerPropsPatch` has no member for it; `LAYER_PROPS.fill` is `[]`), so this lane either widens both or ships a kind nobody can author. |
| 2    | **RW-2** job progress | API-side; no overlap.                                                                                                                                                                                                                                        |

The first draft parked RW-7 in the empty slot with "or RW-7 moves to Wave C." **That hatch is
closed.** Wave C's RW-3 owns `editor-state.ts` (the 36-pin above, twice); Wave D's RW-15 owns
`TimelineTape.tsx`. The slot stays empty rather than filled to make the wave look full — RW-D4's
cousin: do not invent occupancy.

### Wave C — three in parallel, ~2 days

RW-15 (audio clip) was assigned here until it collided with the lock; it runs in Wave D.

| Slot | Lane                    | Note                                                                                                                               |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **RW-3** 4:5            | Holds the lock. Nine web consumers plus the raw-ratio gate in `messages.test.ts`. **One of the nine is `editor-state.ts`.**        |
| 2    | **RW-24** slots ceiling | Planner-side.                                                                                                                      |
| 3    | **RW-18** bookkeeping   | Docs only.                                                                                                                         |

### Wave D — three in parallel, ~2 days

| Slot | Lane                       | Note                                                                               |
| ---- | -------------------------- | ---------------------------------------------------------------------------------- |
| 1    | **RW-15** audio clip       | Takes the lock, now free. Owns both tape mount sites and `BriefEditor.tsx`.        |
| 2    | **RW-23** D136 aggregation | Editor-side; **check against RW-15's `BriefEditor.tsx` claim before dispatching**. |
| 3    | **RW-22** L7 remainder     | Template library.                                                                  |

### Shape of it

```
Wave A  ~2d   RW-1 flake → RW-7 ──┐  RW-4 frames [CG lock] ──┐  RW-11 → RW-10
Wave B  ~2d                       │  RW-5 fill  [CG lock] ───┼─ RW-2 progress ── (empty)
Wave C  ~2d                       │  RW-3 4:5   [CG lock] ───┼─ RW-24 ceiling ── RW-18 books
Wave D  ~2d                       └─ RW-15 audio [CG lock] ──┴─ RW-23 D136 ──── RW-22 L7
```

**~8 working days** for the unblocked lanes, against ~12 serial. Sequencing RW-1 then RW-7 is
1.5 d inside a 2-day wave; RW-4 remains the 2-day gate. The lock still caps the gain: all four
waves have a `CreativeGeneration` lane in slot 1, and nothing else may enter that package while
one holds it.

**Eight named lanes are blocked and not in any wave**, plus RW-25 which is a bucket of four-plus
(D34's copy axes, D51, TS-Q1, seats S1–S4) counted as one row. Five of the named eight wait on a
decision only the owner can make, and **D64 gates more of them than any other single fact.**

## 4. Definition of done

1. Every lane in Waves A–D is merged with a PR URL, and `main` is green **after** the last merge —
   not merely at each PR.
2. `yarn plan:verify` holds and every retired fence is retired **in the lane that retired it**,
   with prose rather than a blank body.
3. Every lane ships **one** replayed mutation with its verdict recorded, and the replay is run by
   the author rather than asserted.
4. Every golden family that moved was recorded **by the CI runner**, with a pre-change baseline on
   the same runner proving equivalence where bytes were meant to hold — and every lane that was
   _supposed_ to leave them unmoved (RW-4) is proven to have done so. The first draft demanded they
   move “exactly once”, which contradicted its own claim that three lanes moved them.
5. No planning document's status line contradicts the tree at the end of the wave — the 2026-09-20
   sweep repaired thirty, and this plan must not mint the thirty-first.
6. **RW-1 has a verdict**: the flake is either fixed with a mechanism named, or quarantined with a
   reason and an owner. "It stopped happening" is not a verdict.

---

## 5. What this plan refuses

- **It does not invent work.** Every lane cites the document that already defines it; RW-1 is the
  single exception and exists because a flake was observed three times on 2026-09-20.
- **It does not schedule around an unanswered question.** Eight named lanes wait, plus RW-25's
  bucket, rather than being given a guessed answer so a wave looks full (RW-D4).
- **It does not estimate VE4 seriously.** M1 says why, and a figure that is not trustworthy is
  worse than an absent one.
- **It does not claim the waves are the only order.** The locks are real; the assignment inside
  them is a preference, and the owner may reshuffle any slot that respects RW-D1 and RW-D2.
- **It no longer claims to cover every open lane.** The first draft did, on the strength of a
  method (`merge-base --is-ancestor`) that proves what _shipped_ and cannot detect an omission by
  construction. Review found six missing lanes, now RW-21 through RW-25.
- **It does not leave a lane with a fallback it has not checked.** The merged draft parked RW-7 in
  Wave B with "or Wave C"; Wave C was already closed on the same file. A hatch is a slot, or it is
  not a hatch.

---

## 6. What a lane needs that no document holds

Every item below cost a round trip on 2026-09-20, and none was written down where a lane would
find it. Reviewer-facing versions of the first two are now in
`best_practices.md`; the rest are implementer mechanics and live here.

### 6.1 Gates that pass without running

- **`yarn typecheck` reported "8 successful, 8 cached, 186 ms" on a tree with edited files.**
  Turbo's cache had not noticed. A gate that cannot run looks exactly like a gate that passed
  (D152). **Run `TURBO_FORCE=1 yarn …` for every gate you intend as evidence**, or invoke `tsc` /
  `vitest` directly. `yarn typecheck --force` is _not_ it — that flag reaches `tsc`, which rejects
  it.
- **`vitest -t` is a regex, and a pattern matching nothing exits 0** with everything skipped,
  which reads as "survived". Confirm the pattern selects before trusting a mutation verdict.
- **`yarn sync:check` refuses a dirty tree.** Commit first, then check — otherwise the drift gate
  is only exercised in CI, which is where it will fail.

### 6.2 Gates most lanes will trip

- **A new file must join its generated barrel** or the drift gate fails with _"1 pending change"_.
  Add the export **by hand, in the barrel's sorted order** — never run `hexagen sync` to fix it.
- **The editor imports leaf subpaths, never the package barrel**, so the type vocabulary reaches
  the browser without the barrel's `node:fs` hitchhikers. Four subpaths had to be added today
  (`./tracks`, `./easing`, `./resolve-tracks`, `./motion-tracks`). Check `package.json`'s `exports`
  before assuming an import resolves.
- **Prettier rewraps long strings**, so an exact-match replacement written against pre-format text
  silently matches nothing. Format last, or match on a short unique fragment.
- **A mutation manifest's `after` may not be empty.** A pure deletion is expressed as the line
  **commented out** — the idiom in `c4b.json` and `hl2.json`.
- **Editing code near an existing mutation anchor can orphan it.** Wrapping `acquireJob` in a
  `try/catch` moved the tail of `l11.json#6` and CI reported a DEAD ANCHOR. **Re-anchor on the new
  spelling and replay to confirm it still _catches_** — never re-point it at different code.

### 6.3 The editor's own guards, all test-enforced

| Guard                   | What it refuses                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D121**                | Any literal list of layer kinds in a `campaign/` file. Derive from `LAYER_KINDS`, `TRACKABLE_LAYER_KINDS`, `TEXT_LAYER_KINDS`. **It catches test files too.**                                                                  |
| **Pixel dimensions**    | Indexing `RATIO_DIMENSIONS[…]`. Only `resolveCanvas(spec)` reads them, so a second reader cannot drift from the canvas the compositor draws.                                                                                   |
| **Never derive twice**  | A second derivation of the previewed ratio. The look carries none _by design_; `derivePreviewSpec` owns it, and it returns a `CanvasSpec` — so a display size is handled, where a bare ratio would not be.                     |
| **Operator vocabulary** | `messages.ts` may not contain `axis`, `axes`, `motion`, `draw`, `floor`, `package`, `planner`, `parser`, `static`, `[`, `>=`, `×`, or any raw ratio. **The operator word for motion is "video style"** (`outputMotionLegend`). |
| **Tape purity**         | `TimelineTape.tsx` may not contain the _word_ `dispatch`, `editor-state` or `EditorAction` — a textual guard, so a comment trips it. The tape takes callbacks.                                                                 |
| **Tape lanes**          | An empty lane implying a capability the brief lacks. Both TL6 and TL7 were caught by this one on the same day: render the lane **only when there is something in it**.                                                         |

### 6.4 Shapes worth copying rather than re-deriving

- **A draggable thing is a native `input[type="range"]`.** `use-step-navigation` hands a drag to
  the component only for `[role="slider"]`, `input[type="range"]` or `[draggable="true"]`; anything
  else is swallowed by the guided swipe. It also gives arrow/Home/End for free.
  `aria-valuenow` is the **committed** value **in the control's own units** — a normalised
  fraction inside a seconds range tells assistive technology something the widget never means.
- **Any interactive control inside the tape's scrollport must be in `commitFromCanvas`'s guard**,
  or a drag on it also scrubs the playhead. The guard named only `button` until TL6 widened it.
- **A caller test needs a prop spy.** `brief-editor.layers.test.tsx` now mocks `TrackForm` and
  `TimelineTape` to capture what the editor actually passes. Assert on the captured value, then
  **verify the test fails** with the prop hard-coded to `null` — two caller tests written on
  2026-09-20 could not fail until that check was applied.
- **`railSlot`'s dependency list is hand-maintained, and a render count will NOT catch a missing
  entry.** `dispatch` and `pickedLayerId` are already in it, so a lane reading either inside the
  rail needs no change. A lane reading something _new_ must add it — and the file warns that the
  failure is a **stale** rail rather than a slow one, which no render count can see. Render counts
  catch the opposite defect (an unmemoised value defeating a `memo`). The missing-dep case is
  covered by a mutation in `rs.json`.

---

## 7. The adversarial review, and what it changed (2026-09-20)

This plan was red-teamed by a second model against the code before approval. **It found the
scheduling core wrong**, and the corrections above are its, not mine. A third defect — RW-7's
hatch — survived that review and the merge. A fourth — RW-7 running *beside* the flake test that
mounts the file RW-7 owns — survived the hatch correction. Both are corrected here rather than
silently moved:

| Severity | What was wrong                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | **RW-5 (fill) collides with RW-6 in Wave B** — the editor cannot author a `fill` today, so that lane must widen `editor-state.ts` and `LayerPropsSheet.tsx`, which the first draft called "uncontended". |
| Critical | **RW-15 collides with its own wave's lock** — TL4 reads the encoder's rounding from `CanvasFfmpegVideoCompositor.ts`, inside the package RW-3 holds. Moved to Wave D.                                    |
| Critical | **RW-7 was parked on a decision answered four days earlier.** D138 was answered 2026-09-16 ("drag allowed, as a neighbour transfer"). A lane was lost to a stale blocker.                                |
| Critical | **H2's flake claim was unsupported by CI.** The three failures were local; CI's only two failures that day were the drift gate and a dead anchor.                                                        |
| High     | **RW-6 and RW-17 were scheduled while blocked** — the unrecorded L10a/L10b split, and an unstamped owner opt-in — which violated this plan's own RW-D4, twice.                                           |
| High     | **RW-D1 counted four golden families; there are eight.** RW-4 does not move bytes at all, so "three byte-moving lanes" and DoD 4's "exactly once" were both wrong.                                       |
| High     | **§6.4 had the `railSlot` mechanism inverted** — a stale dep is exactly what a render count _cannot_ see.                                                                                                |
| High     | **RW-3 was estimated at 0.5 d** owning three things; it owns nine web consumers and a message gate.                                                                                                      |
| Medium   | **Six open lanes were missing** — L7's remainder, D136's aggregation, Slots M1, seat selection, D34's copy axes, D51, TS-Q1 — and PD2 was mislabelled as bookkeeping when it is a live silent drop.      |
| Critical | **RW-7 has no legal slot in Waves B–D.** Wave B collides with RW-5 on `editor-state.ts`. The offered hatch — Wave C — collides with RW-3 on the same file (`RATIO_OPTIONS` is the re-export; `editor-state.test.ts` pins the 3-ratio product at 36 in two places, `:2124` and `:2134`). Wave D collides with RW-15 on `TimelineTape.tsx`. Only Wave A is free: RW-4 owns domain and compositor files, and RW-11's `text-white` sites include none of RW-7's. |
| High     | **RW-7 in Wave A beside RW-1 poisons the flake measurement.** Not a file collision — RW-1 owns `brief-editor.creatives.test.tsx`, RW-7 owns `BriefEditor.tsx` — but the test mounts `<BriefEditor>` (`:338`). A red result during Wave A would not distinguish the original intermittent failure from RW-7's edits; a green one would prove nothing against the tree that shipped. Sequenced inside the slot: RW-1 (0.5 d) then RW-7 (1 d), 1.5 d in a 2-day wave. |
| Medium   | **RW-4 may yet acquire `editor-state.ts`.** `canonicalLayer` already drops `enabled`, `elements`, `props` and `tracks` because a brief loaded from disk carrying spelled-out defaults dirties on sight. A per-layer frame is the same shape. **Check against D130 before dispatching Wave A, not before merging this document.** "The editor cannot author it" is the reasoning that was wrong for fill. |

**Two of its findings were themselves wrong, and are recorded because a review is evidence, not
authority.** It reported the `variation-plan.tsx` 1→4 render claim as having no basis in the repo
and likely misattributed; that file states it at `:29`, and the entry stands. It also reported two
list items numbered 5 in `best_practices.md` as a renumbering error; they are in different
sections, where each list restarts.

**What this says about the first draft:** it was written from a day inside the code, and it was
still wrong about which lanes could run together — because _plausible_ file ownership and _actual_
file ownership are different things, and only reading each lane's source plan tells them apart. The
Wave B hatch was the same failure one round later: a fallback named from the wave table, not from
the files the destination wave actually owns. The RW-1/RW-7 pairing was the next turn of the same
screw: exclusive ownership among concurrent lanes does not catch a test that mounts the file the
other lane is editing.
