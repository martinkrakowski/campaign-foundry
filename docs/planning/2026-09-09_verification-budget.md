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
| **V-D1** | **Fix PR-Agent's context, then re-measure; turn it off if it does not move.** Set `patch_extra_lines_before/after` so a reviewer sees the surrounding file, not a bare hunk. Re-measure over one wave. **If its refuted rate stays above 60 %, disable all three workflows.** | Its dominant failure is diagnosable and one config key: on #263 it claimed `isPlainObject` and `isFiniteInteger` were undefined when both are defined 60 lines above the hunk, asked for a `null` guard the helper performs, and asked for a `delete` the line above already does. **A reviewer that cannot see the file cannot tell "absent" from "out of hunk", and resolves the ambiguity by inventing a defect.** Fix the cause before judging the tool. |
| **V-D2** | **Dispose of a *class* once, not a thread at a time.** When ≥ 3 threads share one premise, post one disposition naming the class and its mechanism, link it from each thread, and resolve them together. | Three threads on #277 restated one wrong claim about a default-formats fallback; I wrote three replies. The reader needs the mechanism once; the threads need closing, which is cheap. |
| **V-D3** | **A finding without a mechanism gets a one-line refusal, not an investigation.** "Consider adding…", "this could be confusing", "for robustness" — reply asking for the input that fails, and resolve. Reopen if one arrives. | 14 of PR-Agent's 46 were phrased as preferences with no failing case. Verifying a claim nobody has made costs the same as verifying a real one. Both other bots lead with a mechanism, which is why their rates are better. |
| **V-D4** | **The orchestrator's mutation must be read from the file, never written from memory.** Copy the literal text, assert the edit applied (`git diff` non-empty **and** the intended line changed), then run. A mutation that fails to apply, or that changes nothing observable, is **not evidence** and must be re-done or recorded as equivalent. | Five misfired this session: a regex that missed an operator at a line end; a `[^;]*` class terminated by a semicolon inside a string; a target that was a static placeholder rather than the runtime fallback; a test file that did not contain the tests; and two genuinely equivalent mutants. **Four of the five looked like passes.** |
| **V-D5** | **Attribute every finding to the lane or to the brief, in the wave record.** | Most fix rounds this session traced to defects in the orchestrator's briefs — a scalar where the plan's own table said a list, a required field behind a fence that made it impossible, a minimum-shape check on a five-field type. Counting those against the implementer misreads the whole trial. |
| **V-D6** | **Never merge a PR whose fix round has not been verified to have landed.** Check for the commit, not the exit code. | #282 merged with four verified defects still in it — terminal escape injection, overlapping refreshes, a flag that swallows the next option, a partial escape on truncation — because its fix round reported success and committed nothing. **Four lanes this session exited 0 having written nothing.** |

---

## 1. Findings

#### **F1 · C · The cheapest fix is a config key, and it has never been set**

Neither `.pr_agent.toml` in this repo nor its sibling sets `patch_extra_lines_before` /
`patch_extra_lines_after`, so all three reviewers run PR-Agent 0.42.0's defaults — a hunk with about
three lines of context and **no view of the rest of the file**. Every "symbol X does not exist"
finding this session was X defined elsewhere in the same file.

#### **F2 · H · The reply, not the reading, is the cost**

Verifying a claim is a `grep`. Writing a disposition that states the mechanism, cites lines, and
survives a later reader is minutes. **Volume × care is the budget**, so the lever is either fewer
low-signal threads (V-D1) or cheaper disposal of them (V-D2, V-D3) — not less care.

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
| **V1** | **Give the reviewers the file** (V-D1). Set the hunk-context keys in `.pr_agent.toml`, verified against the pinned 0.42.0 digest — **do not trust this plan's spelling of them**. Replay the three workflows over two already-reviewed PRs and compare finding sets. | The one change that could move 46 threads |
| **V2** | **Rewrite the three instruction blocks** (V-D3). Require a mechanism: the input or state that produces the wrong output, and the line that must change. Forbid preference classes outright. | Findings that argue rather than suggest |
| **V3** | **Measure one wave, then decide** (V-D1's gate). Record threads and verified-real per bot in the wave record. **If PR-Agent is still above 60 % refuted, disable its three workflows** — do not tune a third time. | The evidence that ends the question |
| **V4** | **The disposition tooling** (V-D2). A small script: given a PR and a set of thread ids, post one class disposition and resolve them together. | The reply cost, halved for repeated claims |
| **V5** | **Mutation discipline in the skill** (V-D4) and **the merge precondition** (V-D6): a checklist item that a fix round's commit exists before merge. | The two failure modes that cost most this session |

**Order.** V5 first — it is documentation and prevents the worst outcome. Then V1 → V2 → V3 (gated).
V4 whenever convenient.

---

## 3. Definition of Done

- **V1**: on the two replayed PRs, **no** "symbol X does not exist" finding where X is defined in
  the same file. If that class survives, the keys are wrong or 0.42.0 ignores them — report, do not
  proceed.
- **V2**: every emitted finding names an input and a line; a preference-phrased finding is a lane
  defect, caught by reading the first wave's threads.
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
