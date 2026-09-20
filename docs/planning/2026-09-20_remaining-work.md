# The remaining work — a scheduling plan

**Date:** 2026-09-20 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
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

---

## 0. Decisions

| ID        | Decision                                                                                                                                                                                                                                                                                                                                                                                                   | Consequence                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RW-D1** | **The compositor and its four golden families are ONE lane at a time.** `compositor-goldens.json`, `-motion`, `-text-effect` and `-mp4-audio` all live in one directory, and a golden must be recorded **by the CI runner itself** (`gh workflow run ci.yml -f record_goldens=true`) because container-recorded Linux cells differed in all 16. Two lanes re-recording concurrently cannot both be proven. | This is the **critical path**, and it is a scheduling fact rather than a preference. The three byte-moving lanes run **in series across Waves A, B and C** — RW-4 (frames), then RW-5 (fill), then RW-3 (4:5) — and no other lane may touch the compositor while one holds it. They are one-per-wave for this reason alone, not because they depend on each other.                    |
| **RW-D2** | **`BriefEditor.tsx` is the second contended file, and it is scheduled, not locked.** Almost every UI lane reaches it — it mounts the sheet, the rail, the tape and the dialog. Its `railSlot` `useCallback` carries a **hand-maintained dependency list** whose staleness is invisible to the type checker and is caught only by render-count tests.                                                       | At most **one** lane owning `BriefEditor.tsx` per wave. A second lane needing it waits rather than merging into a conflict, because the merge that reconciles two dep-list edits is the one nobody reviews properly.                                                                                                                                                                  |
| **RW-D3** | **`messages.ts` and the two barrels are append-only and therefore free.** `scripts/merge-prs.sh` resolves ordinary text conflicts in `messages.ts`, `components/ui/index.ts` and `ports/out/index.ts` by keeping both sides.                                                                                                                                                                               | Shared freely across concurrent lanes. **Verified the hard way on 2026-09-20:** TL6 and TL7 both appended to `messages.ts` and the rebase resolved by keeping both — but the conflict boundary fell mid-function and silently ate a closing brace, which `tsc` caught. **Keep both sides, then typecheck, never eyeball.**                                                            |
| **RW-D4** | **A blocked lane is not scheduled.** Four lanes below wait on an unanswered question, and this plan does not guess an answer to make a wave look full.                                                                                                                                                                                                                                                     | RW-12 (`RunRegistryPort`) and the whole `2026-09-03_create-moment-and-pipeline-prerequisites.md` §6 deferral list wait on **D64**; RW-9 (multi-window drafts) waits on **D82**; RW-7 (beat-boundary drag) waits on **D138**; RW-14 (SE0) is a presentation question two documents answer differently. They appear in **§5 of this document** with their blocker named, not in a wave. |
| **RW-D5** | **Every lane pays the same gate, and the gate is the estimate.** 100 % statements/branches/functions/lines, one replayed mutation, `plan:verify`, `lint:arch`, `lint:bytes`, `format:check`, and the drift gate.                                                                                                                                                                                           | Tests cost **3–4×** the code on this codebase. Every figure below is gate-inclusive; a "one file" lane is never a one-hour lane. Measured today: K5 was ~40 minutes of authoring and ~4 hours in total.                                                                                                                                                                               |
| **RW-D6** | **Budget one review round per lane.** Every lane merged on 2026-09-20 had at least one real finding, including two where a test I wrote **could not fail** against the defect it named.                                                                                                                                                                                                                    | The round is in the estimate, not optimism on top of it. A lane with no finding is a lane whose reviewers were rate-limited, not a lane that was perfect.                                                                                                                                                                                                                             |

---

## 1. Findings

| #      | Sev          | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1** | **Critical** | **`D64` gates more scheduled work than any other single fact in this repository.** Server-side drafts, server-minted ids, ownership on the ports, the D62 template library, markets fan-out, presigned uploads, external ingestion, and ports for reports/packages/output are _all_ behind it — plus RW-12. It is a fork (slug-as-key vs database-fronted) that only the owner can settle, and until it is settled that work cannot be scoped, let alone sequenced. **Answering D64 is worth more than any lane below.** |
| **H1** | High         | **The creative-authoring arc is a chain, not a set.** RW-4 (frames) → RW-6 (frame form) → RW-8 (canvas handles), and RW-8 additionally needs a **preview-footprint API that has never been minted as a lane anywhere**. Three sequential lanes plus an unwritten fourth is the longest dependency run in the tree, which is why it starts in Wave A rather than waiting.                                                                                                                                                 |
| **H2** | High         | **`brief-editor.creatives.test.tsx` failed three times on 2026-09-20**, a different test each run, on branches touching no web code; every re-run passed, and it has not recurred since. It is unowned. A flaky test is one nobody trusts on the day it finally catches something real. **RW-1 exists to characterise it, and runs first because every other lane's CI is downstream of it.**                                                                                                                            |
| **M1** | Medium       | **VE4's estimate is the least trustworthy figure here.** Ten confirmed contract defects sit in front of it, it needs a real audio mix (the encoder maps exactly one audio track), and whether the producer is a separate service or a TypeScript port is undecided. The week below is a placeholder that should be re-estimated once those three are settled — not planned against.                                                                                                                                      |
| **M2** | Medium       | **Two UI holes have no lane and no owner.** The summoned mobile rail gets no brief (`BriefEditor.tsx:1604`) and no tape (`:1629`); and below the rail breakpoint there is **no layer editing at all**. Both are decisions before they are work, and both are small once decided.                                                                                                                                                                                                                                         |
| **L1** | Low          | **Bookkeeping has accumulated into its own lane.** M4's unapplied amendments, PD1/PD2/PD4, `2026-09-10_the-unowned-gaps.md` §42's id-collision grep, the D-id index, V3's stranded fence. Individually trivial, collectively a day, and every one of them is a thing a future reader will trust and be wrong about.                                                                                                                                                                                                      |

---

## 2. The lanes

Ownership is exclusive **among lanes running in the same wave**. A file listed twice across
different waves is fine; twice within one wave is the defect RW-D1 and RW-D2 exist to prevent.

| Lane      | What it delivers                                                                                                                                                                          | Owns                                                                 | Source                                            | Est.             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ---------------- |
| **RW-1**  | **Characterise the `creatives` flake** — reproduce, then fix or quarantine with a reason.                                                                                                 | `brief-editor.creatives.test.tsx`                                    | H2, new                                           | 0.5 d            |
| **RW-2**  | **Real job progress.** `done`/`total` are `0/0` while running and jump to `n/n` at the end, so progress is binary.                                                                        | `fs-job-store.ts`, `jobs.ts`, `jobs.get.ts`, the web poller          | `randomized-campaigns-and-motion.md` §10          | 0.5 d            |
| **RW-3**  | **4:5 aspect ratio.** Absent since August; `RATIO_VALUES` is still the three social ratios.                                                                                               | `aspect-ratios.ts`, compositor, **goldens**                          | `randomized-campaigns-and-motion.md` §10 Q2       | 0.5 d            |
| **RW-4**  | **Per-layer frames** (`creative-templates-and-units.md`'s L10, _not_ the run-exclusion plan's). Canvas-relative position/size per layer, defaults byte-identical.                         | `creative-geometry.ts`, `brief-template.ts`, compositor, **goldens** | `2026-09-08` D130                                 | 2 d              |
| **RW-5**  | **The `fill` kind and generative region** (`creative-templates-and-units.md`'s L11, _not_ the run-exclusion plan's; = `finishing-video.md`'s VF3).                                        | `brief-template.ts`, compositor, **goldens**                         | `2026-09-08` D131/D132                            | 2 d              |
| **RW-6**  | **Frame form in the inspector (SE3).**                                                                                                                                                    | `LayerPropsSheet.tsx`, `editor-state.ts`                             | `2026-09-16` SE3                                  | 0.5 d            |
| **RW-7**  | **Beat-boundary drag (TL3).** _Blocked: D138._                                                                                                                                            | `TimelineTape.tsx`, `editor-state.ts`                                | `2026-09-16` TL3                                  | 0.5 d            |
| **RW-8**  | **Canvas handles (SE5)** — drag a layer's frame on the preview. **Also needs the preview-footprint API lane, which does not exist.**                                                      | `CreativePreview.tsx`, preview route                                 | `studio-editor.md` SE5 + `studio-editor.md` §0 C3 | 2 d + unscoped   |
| **RW-9**  | **Multi-window draft policy (F-D).** _Blocked: D82._                                                                                                                                      | `BriefEditor.tsx`                                                    | `2026-09-06` F-D                                  | 0.5 d            |
| **RW-10** | **Overlay depth counter (F-B / D84)** — `inert` on all but the topmost, one `aria-modal`.                                                                                                 | `packages/ui/dialog-shell.tsx`                                       | `2026-09-06` F-B                                  | 0.5 d            |
| **RW-11** | **Design-system drift** — the four audit items: seven missing kit entries, `--color-brand-on-primary`, the typography scale, the overlay rule.                                            | `DESIGN.md`, tokens, `packages/ui`, 16 `.tsx`                        | `2026-09-08` R1–R4                                | 0.5 d            |
| **RW-12** | **`RunRegistryPort` (R6).** _Blocked: D64 — the key shape is the identity model._                                                                                                         | `ports/`, `jobs.ts`                                                  | `2026-09-04` R6                                   | 1 d              |
| **RW-13** | **Fence tokens on guarded writes (D78).** **No lane owns this anywhere** — it needs scoping before it needs building.                                                                     | `ports/`, stores                                                     | `2026-09-04` D78                                  | 1 d              |
| **RW-14** | **SE0 — does a third presentation survive?** Two documents answer oppositely (`studio-editor.md` "open"; `wireframe-gap.md` H1 "will never be built"). _Decision, then possibly nothing._ | —                                                                    | H1 vs SE0                                         | decision         |
| **RW-15** | **Audio clip on the tape (TL4).** Needs the encoder's frame rounding exported.                                                                                                            | `TimelineTape.tsx`                                                   | `2026-09-16` TL4                                  | 0.5 d            |
| **RW-16** | **Browse over a real library (CC7).** Its stated blocker partly dissolved when TM1–TM4 shipped; **scope it before building it.**                                                          | shell                                                                | `2026-09-16` CC7                                  | scope first      |
| **RW-17** | **Resume inline (W2b)** — replace the second `role="dialog"`.                                                                                                                             | `CreateCampaignDialog.tsx`                                           | `2026-09-06` W2(b)                                | 0.5 d            |
| **RW-18** | **Bookkeeping** — M4's amendments, PD1/PD2/PD4, the `the-unowned-gaps.md` §42 collision grep, the D-id index, V3's fence.                                                                 | `docs/`, `.claude/skills/`                                           | L1                                                | 1 d              |
| **RW-19** | **The two unowned UI holes** — the summoned rail's empty dock, and no layer editing below the breakpoint. _Decisions, then small._                                                        | `BriefEditor.tsx`                                                    | M2                                                | decision + 0.5 d |
| **RW-20** | **VE4 — voiceover and captions.** Ten contract defects, a real audio mix, Python/TS undecided.                                                                                            | audio service, compositor, **goldens**                               | `2026-09-13` VE4                                  | ~1 w, **M1**     |

---

## 3. Execution order

Three constraints shape every wave: **one compositor lane at a time** (RW-D1), **one
`BriefEditor.tsx` lane at a time** (RW-D2), and **blocked lanes do not occupy a slot** (RW-D4).

### Wave A — three in parallel, ~2 days

| Slot | Lane                                             | Why it can run alongside the others                                                                       |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1    | **RW-1** flake                                   | Owns one test file. Runs **first in the wave** because every later lane's CI reads the signal it repairs. |
| 2    | **RW-4** frames                                  | Takes the compositor lock for the whole wave. Longest chain in the tree (H1), so it starts now.           |
| 3    | **RW-11** design drift → **RW-10** overlay depth | `packages/ui` and tokens; touches neither the compositor nor `BriefEditor.tsx`.                           |

_Not in this wave:_ RW-2 and RW-17 would each be fine technically, but a fourth concurrent lane
exceeds what one reviewer round can absorb honestly (RW-D6).

### Wave B — three in parallel, ~2 days

| Slot | Lane                      | Note                                                                               |
| ---- | ------------------------- | ---------------------------------------------------------------------------------- |
| 1    | **RW-5** fill             | Takes the compositor lock. **Serialised behind RW-4 by RW-D1**, not by dependency. |
| 2    | **RW-6** frame form (SE3) | Needs RW-4 merged. Owns the sheet; `editor-state.ts` is uncontended this wave.     |
| 3    | **RW-2** job progress     | API-side; no overlap with either.                                                  |

### Wave C — three in parallel, ~2 days

| Slot | Lane                          | Note                                                                                                                                                                                          |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **RW-3** 4:5 ratio            | Compositor lock. **Deliberately last of the three byte-movers:** it re-records goldens for a _new_ ratio, so doing it after the frame and fill changes means recording once, not three times. |
| 2    | **RW-15** audio clip (TL4)    | Owns `TimelineTape.tsx`.                                                                                                                                                                      |
| 3    | **RW-17** resume inline (W2b) | Owns the create dialog.                                                                                                                                                                       |

### Wave D — two in parallel, ~2 days

| Slot | Lane                          | Note                                                                                                                  |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1    | **RW-8** canvas handles (SE5) | **Mint the preview-footprint API lane first** — H1: it has never existed, and SE5 may not be scheduled until it does. |
| 2    | **RW-18** bookkeeping         | Docs only; safe beside anything.                                                                                      |

### Unscheduled until a decision lands

**RW-7** (D138) · **RW-9** (D82) · **RW-12** (D64) · **RW-14** (SE0) · **RW-19** (two calls) ·
**RW-13** and **RW-16** (need scoping, not a slot) · **RW-20** (VE4 — M1).

### Shape of it

```
Wave A  ~2d   RW-1 flake ─┐   RW-4 frames [compositor] ─┐   RW-11 → RW-10 ─┐
Wave B  ~2d                └─ RW-5 fill [compositor] ────┼── RW-6 form ────┼── RW-2 progress
Wave C  ~2d                   RW-3 4:5 [compositor] ─────┼── RW-15 audio ──┼── RW-17 resume
Wave D  ~2d                   RW-8 handles (+API lane) ──┴── RW-18 books ───┘
```

**~8 working days** for everything not blocked, against ~13 days if the same lanes ran one at a
time. The compositor lock is what caps the gain: three of the four waves have a byte-moving lane
in slot 1, and nothing else may touch those files while they do.

---

## 4. Definition of done

1. Every lane in Waves A–D is merged with a PR URL, and `main` is green **after** the last merge —
   not merely at each PR.
2. `yarn plan:verify` holds and every retired fence is retired **in the lane that retired it**,
   with prose rather than a blank body.
3. Every lane ships **one** replayed mutation with its verdict recorded, and the replay is run by
   the author rather than asserted.
4. The goldens moved **exactly once** across Waves A–C, recorded by the CI runner, with a
   pre-change baseline on the same runner proving equivalence where bytes were meant to hold.
5. No planning document's status line contradicts the tree at the end of the wave — the 2026-09-20
   sweep repaired thirty, and this plan must not mint the thirty-first.
6. **RW-1 has a verdict**: the flake is either fixed with a mechanism named, or quarantined with a
   reason and an owner. "It stopped happening" is not a verdict.

---

## 5. What this plan refuses

- **It does not invent work.** Every lane cites the document that already defines it; RW-1 is the
  single exception and exists because a flake was observed three times on 2026-09-20.
- **It does not schedule around an unanswered question.** Four lanes wait, named, rather than being
  given a guessed answer so a wave looks full (RW-D4).
- **It does not estimate VE4 seriously.** M1 says why, and a figure that is not trustworthy is
  worse than an absent one.
- **It does not claim the waves are the only order.** The three locks are real; the assignment
  inside them is a preference, and the owner may reshuffle any slot that respects RW-D1 and RW-D2.

---

## 6. What a lane needs that no document holds

Every item below cost a round trip on 2026-09-20. None was discoverable before tripping it, and
none is written down anywhere else. Reviewer-facing versions of the first two are now in
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
- **`railSlot`'s dependency list is hand-maintained.** `dispatch` and `pickedLayerId` are already
  in it, so a lane reading either inside the rail needs no change — but a lane reading something
  _new_ must add it, and only a render-count test will notice if it does not.
