# The 2026-09-19 wave — what shipped, and the decisions it made without writing them down

**Date:** 2026-09-19
**Status:** **RECORD — not a plan. Nothing here is dispatchable, and nothing here proposes work.**
Every decision below was already shipped by a merged PR before this document existed; the document
exists because the decisions were embedded in commit messages and PR bodies where nobody can find
them. **Do not dispatch a lane from this file.**
**Verified against:** `origin/main` at `44955866`, each decision re-read against the code it describes.
**Decision ids introduced:** **D148 – D157**
**Relates to:** `2026-09-18_creatives-as-slots.md` (SL lanes, stamped the same day),
`2026-09-17_wireframe-gap.md` (SG), `2026-09-06_create-dialog-recomposition.md` (§9, superseded the
same day), `D45` (preview and render must not disagree), `D66`, `D139`.

---

## 0. Why this document exists

Twenty PRs merged on 2026-09-19. Between them they settled ten questions that will be asked again —
how identity is resolved, what a gate owes its reader, when a fence stops being a fence — and **none
of them had anywhere to live.** The repo's decision system is D-ids inside planning documents, and
this wave produced no planning document, so its decisions went into commit bodies.

That is a findability failure, not a process failure: the work was reviewed, mutation-checked and
gated. But `D110` is answerable in one grep and _"why does the preview resolve product by id?"_ was
not answerable at all.

**This document deliberately does not adopt a separate ADR tree.** 147 D-ids already exist, each
defined in exactly one document. Copying them into parallel files would create 147 new places to
drift — and four separate drifts were repaired _during this wave_ (SL-D rows reading "proposed"
after shipping, SL-D4 citing a moved line, §1 of the slots plan describing deleted code in the
present tense, and W1 presenting a dead premise as live work). A second home for decisions is the
same defect, industrialised.

---

## 1. The wave

| PRs                          | Area                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| #499, #500, #502, #506, #507 | variation planner — occupancy, bounds, policy integers                              |
| #501, #503, #504, #508       | brief editor — default output, clickable preview, creatives list, the Generate gate |
| #505                         | gates — inexact capacity refused, control bytes fail the build                      |
| #509 – #512                  | fixture vocabulary, `-t` liveness, preview product identity, refusal targeting      |
| #513, #514, #516, #518, #519 | records — seat evidence, closing a plan, stamping, supersession, a dead fence       |
| #515, #517                   | variation planner — the appended slot's draw budget and the refusal it produces     |

The SL, M and CE lanes' own decisions are recorded in `2026-09-18_creatives-as-slots.md` and are
**not** restated here. What follows is only what had no home.

---

## 2. Decisions

| ID       | Decision                                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D148** | **Identity is resolved, never inferred from appearance.** A surface that needs to know _which_ product, creative or slot it is drawing takes the id. It may not deduce it by matching a display property — colour, label or name.                                                  | #511. `PreviewFrame` gained a `productId` prop that **nothing outside a test ever passed**, and the cell fell through to `products.find(p => p.primaryColor === primaryColor)`. That agrees with the client only by coincidence, and picks the wrong product outright when two share a brand colour — right colour, wrong logo, wrong product in the markup. This is D45's split (preview and render disagreeing) wearing a disguise, which is why it is stated as a rule rather than filed as a bug.                                                                                               |
| **D149** | **An appended slot is guaranteed its own draws, and the guarantee stops at `count`.** The shared pool `allocated × 3` still governs the replay; a slot at `cursor >= count` additionally gets `REPLAN_MAX_DRAWS` of its own before the planner may call it impossible.             | #515. The pool is spent in order, so an appended slot — last allocated and most constrained, since it must clear every occupant — inherited whatever was left, often nothing; and the exhaustive fallback is deliberately closed for an append. Measured over a 4–20 × 12-seed × 2-distance sweep: **42** briefs whose dense plan succeeds refused on one add. The bound matters as much as the floor: widening it to every slot lets the random draw reach sets `exhaustiveAccept` used to serve, **silently changing plans for briefs nobody added a slot to**. The first draft did exactly that. |
| **D150** | **An operator-facing refusal names the constraint that binds, not the theoretical ceiling.** Where occupants exist, capacity (a property of the space) and reachability (a property of the space _given those occupants_) are different numbers, and the second is the one quoted. | #517. Holding seven creatives, the operator was told the brief "can yield at most 8 distinct variants" — true of the axes, and read as spare room, while nothing remaining was far enough from the seven they had. The advice that followed was being weighed against a number that did not apply. Both figures now appear; with no occupants the message is byte-identical to before.                                                                                                                                                                                                              |
| **D151** | **A refusal lands on the field that is wrong, and reading order is the document's order.** The bounce targets the failing control, not its section; which field comes first is answered by `querySelectorAll`, never by sorting an error record.                                   | #512. The validator mints one key per failing field; the refusal was throwing that away and landing at the top of a section. `FieldErrors` is a `Record` whose key order is whatever the validator appended — it matches the form today **only because** `validateProducts` walks rows in array order. Sorting the record would encode that coincidence as a rule; asking the DOM cannot. Focus lands on the control, so the fix can be typed without a second navigation, and H2's requirement (never `document.body`) still holds.                                                                |
| **D152** | **A gate distinguishes "cannot run" from "failed", and says which.** A check that could not look must report that it could not look — never a verdict about the thing it failed to inspect.                                                                                        | #510. `mutate:anchors` read an empty `vitest list` as `DEAD -t PATTERN`, conflating "the pattern selects nothing" with "this file registers no tests in this environment". A `--mode=skip-build` worktree skips ffmpeg-static's postinstall, so gated tests never register, and a healthy manifest was accused by name and index. Worse than silence: the report sends the next reader hunting for a defect in a file that does not have one. #505's control-byte gate is the same family — a byte nobody can see is refused rather than tolerated.                                                 |
| **D153** | **A premise fence that can no longer flip is retired, or relabelled an invariant — and the two are decided separately.** Retire when the trigger will never occur; relabel when the lane is gone but what it guards outlived it.                                                   | #519. `premise SG1` probed for `"studio"`; SG1 was rewritten before dispatch so that _"studio never needs to exist"_, leaving a fence permanently green by construction. A gate that cannot fail is not a gate. `premise SG3` also cannot flip — its lane was superseded — but it still catches a future relocation of the SeedID control becoming a duplicate, so it stays with its comment corrected. Retirement is always **prose**: `parsePremises` throws on a blank body.                                                                                                                     |
| **D154** | **A seat's own verdict is not evidence of work. The branch is.** Read `git rev-list --count origin/main..HEAD` and the PR before any status field, prose or machine-readable.                                                                                                      | #513. An agy lane returned `EXIT 0` **and** `"status":"SUCCESS"` after 359 s and 643 k tokens having written **zero files and made zero commits** — it launched the test suite as its first act and narrated waiting for it. The 2026-09-11 qualification had already established that the seat's prose self-report is not evidence; this establishes that the machine-readable verdict is not either. The derived-status block in `orchestrate-wave/SKILL.md` now leads with the commit count.                                                                                                     |
| **D155** | **A decision is stamped against the code, never against a merge list.** "The lane merged" is not evidence that the decision it carried is true of the tree today.                                                                                                                  | #516. Seven rows read **proposed** in a document headed COMPLETE. Stamping them against `origin/main` — rather than ticking them off because the lanes had merged — found three claims that had stopped being true, including SL-D4 citing `conflicts` at a line it had moved from and implying a call that **does not exist** (`grep -c 'conflicts('` in the use case returns 0; the rule shipped through `meetsMinDistance`). A merge-list stamp would have recorded all three as fine.                                                                                                           |
| **D156** | **A permissive wire type needs a vocabulary guard where the fixture is defined.** Where the transport type is deliberately wide, the narrow vocabulary is enforced at the literal's definition site with `satisfies`.                                                              | #509. A test fixture carried `tone: "minimal"`; `ToneKind` is `"bold" \| "subtle"`. Nothing rejected it — `PlanVariant.tone` is `string` because the route body may carry anything, and the plan stub widens to `readonly unknown[]` so a test can post a malformed plan on purpose. Both are correct individually; between them there was no point left that could refuse an undrawable tone. `CreativeGlyph` resolved `HEAVY["minimal"]` as `undefined`, so the fixture's own claim that adjacent slots differ in tone was true **by an undefined lookup**.                                       |
| **D157** | **A prop nobody passes is indistinguishable from a prop that does not exist.** A wiring claim is proved by a test that spans the whole chain — state through props through component to the request — not by a test that hands the component the value.                            | #511, and it is the general form of D148's failure. Every per-component test was green and honest about its own component; the lane's red fault passed by handing `PreviewFrame` the prop directly, which is a path the application never takes. Only the chain-spanning test reds when the forward is removed. The same shape recurred in #517 (`occupants` defaults to `[]`, so a caller that forgets it compiles and every other assertion still passes) and in #512 (the `revealField` call site).                                                                                              |

---

## 3. Raised and deliberately not fixed

| #      | Sev  | Finding                                                                                                                                                                                                                    |
| ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | Low  | **The mobile menu plans twice.** Pre-existing, predates this wave, never investigated — its size is genuinely unknown and should not be assumed small. _**Investigated and closed 2026-09-20. It does not plan twice.** There is no doc-vs-doc duplicate: `RS-D5` explicitly leaves SG11 intact (*"SG11 unchanged, and now symmetric"*) and `2026-09-17_rail-in-the-shell.md` says outright *"It does not build SG11"*. The real split is doc-vs-code — `SG-D16` refused a menu of menus, the owner then asked for exactly that, and #485 shipped the owner's version while the D-id was never stamped, which is D155's own failure mode. Repaired at the source: `SG-D16` amended, the `SG11` lane row stamped, and the half-met red fault plus the empty-dock consequence recorded there. **The size question is answered — the documentation repair was small; the live gap it exposed is the summoned rail getting no brief, which is a separate call.**_ |
| **R2** | Low  | **Greedy packing corners still refuse, and should.** 15 of the swept 42 cases cannot be placed at any budget (D149). The refusal is honest and D150 now explains it correctly.                                             |
| **R3** | Info | **147 D-ids have no index.** `D110` is answerable only by grepping 48 files. A generated index, gated like `plan:verify`, would fix findability without a second home for decisions — proposed, not built, not dispatched. |

---

## 4. What this wave did not do

- **It did not adopt an ADR tree.** See §0.
- **It did not touch batch processing**, which owns the YAML import/export flow and remains a future
  feature (`2026-09-17_creatives-as-a-list.md` §9).
- **It did not dispatch W1** of the create-dialog plan — red-teaming it before dispatch found its
  premise had been dead since 2026-09-07. `2026-09-06_create-dialog-recomposition.md` §9 records it.
- **It did not re-record a golden**, weaken a mutation, or raise a timeout.

---

## 5. Definition of done

This document is done when its ten decisions are findable by id and true of the tree. Both held at
`44955866`. **If a later reader finds one false, the decision has changed and the fix is to amend it
here with the reason — not to delete the row.**
