# The Verification Budget — Architecture & Development Plan

**Date:** 2026-09-09
**Author:** orchestrator
**Status:** draft — for the owner's review. Nothing built.
**Verified against:** `main` at `0b1faa0`, and the 79 review threads on PRs #254–#287

---

## 0. What this plan answers

One session produced **79 automated review threads** across ~25 PRs. Every one was read, verified
against the code, answered with a mechanism, and resolved. That discipline found real defects — and
it cost more than the lanes did.

| Reviewer | Threads | Refuted | Accepted | Share of volume |
|---|---|---|---|---|
| **PR-Agent** (3 workflows) | **46** | **32** | 7 | **58 %** |
| Qodo | 26 | 6 | 9 | 33 % |
| CodeRabbit | 7 | 1 | 4 | 9 % |

**PR-Agent produced the majority of the volume and the smallest share of the value.** Its one true
finding on #268 was raised independently by both other bots the same hour, so it has yet to
contribute a *unique* real finding in this repository.

**This plan is not "read fewer comments".** Two of the session's worst defects — a token route
serving prose as a stylesheet, and a guard that admitted `null` layers — were found by bots and
dismissed or missed by me. The plan is to spend the same care on inputs that earn it.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **V-D1** | **Forbid the absence claim, pad the hunk modestly, then re-measure.** The reviewer may not report a symbol, import, helper, guard or cleanup as missing when its definition would sit outside the hunk. Raise `patch_extra_lines_before` to ~25 for the within-function case only. **Keep `suggestions_score_threshold = 0` and keep the architecture workflow** — both were tested and both are fine. Re-measure one wave; **disable the two UI/API workflows if refuted stays above 60 %.** | Its dominant failure is diagnosable and one config key: on #263 it claimed `isPlainObject` and `isFiniteInteger` were undefined when both are defined 60 lines above the hunk, asked for a `null` guard the helper performs, and asked for a `delete` the line above already does. **A reviewer that cannot see the file cannot tell "absent" from "out of hunk", and resolves the ambiguity by inventing a defect.** Fix the cause before judging the tool. |
| **V-D2** | **Dispose of a *class* once, not a thread at a time.** When ≥ 3 threads share one premise, post one disposition naming the class and its mechanism, link it from each thread, and resolve them together. | Three threads on #277 restated one wrong claim about a default-formats fallback; I wrote three replies. The reader needs the mechanism once; the threads need closing, which is cheap. |
| **V-D3** | **A finding without a mechanism gets a one-line refusal, not an investigation.** "Consider adding…", "this could be confusing", "for robustness" — reply asking for the input that fails, and resolve. Reopen if one arrives. | 14 of PR-Agent's 46 were phrased as preferences with no failing case. Verifying a claim nobody has made costs the same as verifying a real one. Both other bots lead with a mechanism, which is why their rates are better. |
| **V-D4** | **The orchestrator's mutation must be read from the file, never written from memory.** Copy the literal text, assert the edit applied (`git diff` non-empty **and** the intended line changed), then run. A mutation that fails to apply, or that changes nothing observable, is **not evidence** and must be re-done or recorded as equivalent. | Five misfired this session: a regex that missed an operator at a line end; a `[^;]*` class terminated by a semicolon inside a string; a target that was a static placeholder rather than the runtime fallback; a test file that did not contain the tests; and two genuinely equivalent mutants. **Four of the five looked like passes.** |
| **V-D5** | **Attribute every finding to the lane or to the brief, in the wave record.** | Most fix rounds this session traced to defects in the orchestrator's briefs — a scalar where the plan's own table said a list, a required field behind a fence that made it impossible, a minimum-shape check on a five-field type. Counting those against the implementer misreads the whole trial. |
| **V-D6** | **Never merge a PR whose fix round has not been verified to have landed.** Check for the commit, not the exit code. | #282 merged with four verified defects still in it — terminal escape injection, overlapping refreshes, a flag that swallows the next option, a partial escape on truncation — because its fix round reported success and committed nothing. **Four lanes this session exited 0 having written nothing.** |

---

## 1. Findings

#### **F1 · C · The cheap levers were checked and three of the four do not exist**

**This finding replaces an earlier draft of F1 that was wrong.** That draft claimed the hunk
defaults give "about three lines of context and no view of the file" and that setting one unset key
would fix it. Verified against `configuration.toml` at the pinned `v0.42.0`:

| Key | Real default | Draft claimed |
|---|---|---|
| `patch_extra_lines_before` | **5** (+3 built in) | ~3 total |
| `patch_extra_lines_after` | **1** (+3 built in) | ~3 total |
| `allow_dynamic_context` | **already `true`** | not considered |
| `max_extra_lines_before_dynamic_context` | **10**, to an enclosing scope | not considered |

So a reviewer already sees roughly eight lines before a hunk and expands to ten until it reaches an
enclosing function or class. **The direction of the diagnosis survives** — a symbol defined 60 to
700 lines away is still invisible, and that is where every "symbol X does not exist" finding came
from — **but no amount of hunk padding reaches 700 lines**, and padding trades against file
coverage, because this repo's `max_model_tokens` is what prunes files from a large review.

Two further levers were tested against the record and **both are dead**:

- **A score threshold does not separate signal.** Cross-tabulating every thread by its
  `importance` score against its verdict: importance **9** produced **five refuted and zero
  accepted**; importance **8**, five refuted and one accepted; accepted findings appear at 2, 3, 4,
  5, 6, 7 and 8. **The score is uncorrelated with truth**, so the existing
  `suggestions_score_threshold = 0` and the rationale written beside it are **confirmed, not
  overturned**. Leave both alone.
- **There is no single bad workflow to switch off.** Splitting threads by signature, the
  **architecture** reviewer is the *best* proportional performer — 12 threads, 5 refuted, 3
  accepted. The volume and the noise are both in the two UI/API reviewers: **54 threads, 28
  refuted, 5 accepted**.

#### **F2 · H · The reply, not the reading, is the cost**

Verifying a claim is a `grep`. Writing a disposition that states the mechanism, cites lines, and
survives a later reader is minutes. **Volume × care is the budget**, so the lever is either fewer
low-signal threads (V-D1) or cheaper disposal of them (V-D2, V-D3) — not less care.

#### **F2b · C · The instructions already demand a mechanism, and get mechanism-shaped falsehoods**

`[pr_code_suggestions].extra_instructions` already states that **every finding MUST carry a concrete
failure scenario**, gives a worked example of one, lists seven defect classes that have really
shipped here, and closes with *"prefer silence to a speculative finding."* It is a good prompt.

**It did not work, and that is the finding.** The dominant false class is not vague — *"`isPlainObject`
is undefined here"* names a symbol, a file and a consequence. It is mechanism-*shaped* and false,
because the reviewer cannot distinguish **absent** from **outside the hunk** and resolves the
ambiguity toward a finding.

**So the fix is not to ask harder for mechanisms. It is to forbid the one claim the tool is
structurally unable to make.**

#### **F3 · H · Four lanes exited cleanly having produced nothing**

`L7a`, `L8`, `W1` (twice) and `W2b`. Two were killed for reading without writing; two answered with
a plan or stopped after reading. A fifth round for `W1b` did the same and its PR was merged anyway.
**An exit code is not evidence of work**, which is the same rule already applied to lane reports.

#### **F4 · M · Brief size predicts lane failure better than any seat**

Every lane with 2–3 deliverables shipped. Both 5-deliverable lanes were killed, together billing
~1.5 M input tokens for ~81 K output. This is already in the spending rules; it belongs here because
**a failed lane's review threads are pure cost** — the reviewers still comment on a branch that
never worked.

---

## 2. Lanes

| Lane | Task | Buys |
|---|---|---|
| **V1** | **Forbid absence claims** in `[pr_code_suggestions]`, and raise the hunk padding modestly. Narrow wording only — the rule must kill claims about code the reviewer cannot see, **not** claims about code it can. Two of the real findings this session were about inputs to visible code. | The measured dominant false class |
| **V2** | *Withdrawn.* The instruction blocks already demand a concrete failure scenario and already prefer silence (F2b). Rewriting them again would repeat a lever that has been pulled. | — |
| **V3** | **Measure one wave, then decide** (V-D1's gate). Record threads and verified-real per bot *and per workflow* in the wave record. **If the two UI/API reviewers stay above 60 % refuted, disable them** — do not tune a third time. The architecture reviewer is exempt; it already passes. | The evidence that ends the question |
| **V4** | **The disposition tooling** (V-D2). A small script: given a PR and a set of thread ids, post one class disposition and resolve them together. | The reply cost, halved for repeated claims |
| **V5** | **Mutation discipline in the skill** (V-D4) and **the merge precondition** (V-D6): a checklist item that a fix round's commit exists before merge. | The two failure modes that cost most this session |

**Order.** V5 first — it is documentation and prevents the worst outcome. Then V1 → V3 (gated). V4
whenever convenient. **V2 is withdrawn** and V-D3 survives only as the human-side disposal rule.

---

## 3. Definition of Done

- **V1**: over the measured wave, **no** finding claims a symbol is undefined, missing or
  never-called where it is in fact defined elsewhere in the same file. That class is the test; if it
  survives the prohibition, instruction wording is exhausted and V3 decides on arithmetic.
- **V3**: a per-bot table in the wave record. The disable decision is **arithmetic, not judgement**.
- **V5**: the skill states that a mutation is read from the file and confirmed applied, and that a
  merge requires the fix commit to exist.

---

## 4. What this plan refuses

- **It does not stop verifying bot findings.** The two worst defects of the session were found by
  bots — one of which I refuted with a confident, wrong mechanism.
- **It does not silence a bot for being wrong often.** It fixes the diagnosable cause first, then
  disables on measured evidence. A reviewer starved of context is not a bad reviewer yet.
- **It does not add a reviewer.** Three producing 79 threads is already past the point where the
  marginal one is read carefully.
- **It does not filter by score, and it does not touch the architecture reviewer.** Both were
  candidate cuts. Both were measured and both were kept. **A plan that only ever confirms its own
  first guess is not measuring anything** — this one lost two of its four levers to the data, and an
  earlier draft of F1 was false in exactly the way V-D4 warns about.
