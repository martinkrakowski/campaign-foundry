# The Verification Budget — Architecture & Development Plan

**Date:** 2026-09-09
**Author:** orchestrator
**Status:** **SHIPPED, WITH ONE THING TO SETTLE — stamped 2026-09-20.** V1 (#290), V4 (#366) and V5 (#289) are on `main`, and **V3's decision was made by the owner and executed** (#527: `pr-agent-api.yml` deleted, `pr-agent.yml` reduced to `issue_comment`). V2 was withdrawn on evidence. **The contradiction to settle:** §5 and §8 below still read "V3 stays open" — they predate the decision — and `premise V3` at §7 is still live, because its body asks that every workflow *still* invoking PR-Agent be measured per workflow in a wave record, and `pr-agent-arch`, `pr-agent-react` and `pr-agent` are each unmeasured. The architecture reviewer is "exempt from the DISABLE decision, not from being measured", and `pr-agent-react` is a **fourth** reviewer added after the fence was written. **So: retire the fence and the stale prose, or keep the fence and record the measurement. That is an owner call and is deliberately not made here.** _Was: "draft — for the owner's review. Nothing built."_
**Verified against:** `main` at `0b1faa0`, and the 79 review threads on PRs #254–#287

---

## 0. What this plan answers

One session produced **79 automated review threads** across ~25 PRs. Every one was read, verified
against the code, answered with a mechanism, and resolved. That discipline found real defects — and
it cost more than the lanes did.

| Reviewer                   | Threads | Refuted | Accepted | Share of volume |
| -------------------------- | ------- | ------- | -------- | --------------- |
| **PR-Agent** (3 workflows) | **46**  | **32**  | 7        | **58 %**        |
| Qodo                       | 26      | 6       | 9        | 33 %            |
| CodeRabbit                 | 7       | 1       | 4        | 9 %             |

**PR-Agent produced the majority of the volume and the smallest share of the value.** Its one true
finding on #268 was raised independently by both other bots the same hour, so it has yet to
contribute a _unique_ real finding in this repository.

**This plan is not "read fewer comments".** Two of the session's worst defects — a token route
serving prose as a stylesheet, and a guard that admitted `null` layers — were found by bots and
dismissed or missed by me. The plan is to spend the same care on inputs that earn it.

---

## 0.1 Proposed decisions

| id       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **V-D1** | **Forbid the absence claim, pad the hunk modestly, then re-measure.** The reviewer may not report a symbol, import, helper, guard or cleanup as missing when its definition would sit outside the hunk. Raise `patch_extra_lines_before` to ~25 for the within-function case only. **Keep `suggestions_score_threshold = 0` and keep the architecture workflow** — both were tested and both are fine. Re-measure one wave; **disable the two UI/API workflows if refuted stays above 60 %.** | Its dominant failure is diagnosable and one config key: on #263 it claimed `isPlainObject` and `isFiniteInteger` were undefined when both are defined 60 lines above the hunk, asked for a `null` guard the helper performs, and asked for a `delete` the line above already does. **A reviewer that cannot see the file cannot tell "absent" from "out of hunk", and resolves the ambiguity by inventing a defect.** Fix the cause before judging the tool. |
| **V-D2** | **Dispose of a _class_ once, not a thread at a time.** When ≥ 3 threads share one premise, post one disposition naming the class and its mechanism, link it from each thread, and resolve them together.                                                                                                                                                                                                                                                                                      | Three threads on #277 restated one wrong claim about a default-formats fallback; I wrote three replies. The reader needs the mechanism once; the threads need closing, which is cheap.                                                                                                                                                                                                                                                                       |
| **V-D3** | **A finding without a mechanism gets a one-line refusal, not an investigation.** "Consider adding…", "this could be confusing", "for robustness" — reply asking for the input that fails, and resolve. Reopen if one arrives.                                                                                                                                                                                                                                                                 | 14 of PR-Agent's 46 were phrased as preferences with no failing case. Verifying a claim nobody has made costs the same as verifying a real one. Both other bots lead with a mechanism, which is why their rates are better.                                                                                                                                                                                                                                  |
| **V-D4** | **The orchestrator's mutation must be read from the file, never written from memory.** Copy the literal text, assert the edit applied (`git diff` non-empty **and** the intended line changed), then run. A mutation that fails to apply, or that changes nothing observable, is **not evidence** and must be re-done or recorded as equivalent.                                                                                                                                              | Five misfired this session: a regex that missed an operator at a line end; a `[^;]*` class terminated by a semicolon inside a string; a target that was a static placeholder rather than the runtime fallback; a test file that did not contain the tests; and two genuinely equivalent mutants. **Four of the five looked like passes.**                                                                                                                    |
| **V-D5** | **Attribute every finding to the lane or to the brief, in the wave record.**                                                                                                                                                                                                                                                                                                                                                                                                                  | Most fix rounds this session traced to defects in the orchestrator's briefs — a scalar where the plan's own table said a list, a required field behind a fence that made it impossible, a minimum-shape check on a five-field type. Counting those against the implementer misreads the whole trial.                                                                                                                                                         |
| **V-D6** | **Never merge a PR whose fix round has not been verified to have landed.** Check for the commit, not the exit code.                                                                                                                                                                                                                                                                                                                                                                           | #282 merged with four verified defects still in it — terminal escape injection, overlapping refreshes, a flag that swallows the next option, a partial escape on truncation — because its fix round reported success and committed nothing. **Four lanes this session exited 0 having written nothing.**                                                                                                                                                     |

---

## 1. Findings

#### **F1 · C · The cheap levers were checked and three of the four do not exist**

**This finding replaces an earlier draft of F1 that was wrong.** That draft claimed the hunk
defaults give "about three lines of context and no view of the file" and that setting one unset key
would fix it. Verified against `configuration.toml` at the pinned `v0.42.0`:

| Key                                      | Real default                  | Draft claimed  |
| ---------------------------------------- | ----------------------------- | -------------- |
| `patch_extra_lines_before`               | **5** (+3 built in)           | ~3 total       |
| `patch_extra_lines_after`                | **1** (+3 built in)           | ~3 total       |
| `allow_dynamic_context`                  | **already `true`**            | not considered |
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
  **architecture** reviewer is the _best_ proportional performer — 12 threads, 5 refuted, 3
  accepted. The volume and the noise are both in the two UI/API reviewers: **54 threads, 28
  refuted, 5 accepted**.

#### **F2 · H · The reply, not the reading, is the cost**

Verifying a claim is a `grep`. Writing a disposition that states the mechanism, cites lines, and
survives a later reader is minutes. **Volume × care is the budget**, so the lever is either fewer
low-signal threads (V-D1) or cheaper disposal of them (V-D2, V-D3) — not less care.

#### **F2b · C · The instructions already demand a mechanism, and get mechanism-shaped falsehoods**

`[pr_code_suggestions].extra_instructions` already states that **every finding MUST carry a concrete
failure scenario**, gives a worked example of one, lists seven defect classes that have really
shipped here, and closes with _"prefer silence to a speculative finding."_ It is a good prompt.

**It did not work, and that is the finding.** The dominant false class is not vague — _"`isPlainObject`
is undefined here"_ names a symbol, a file and a consequence. It is mechanism-_shaped_ and false,
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

| Lane                         | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Buys                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **V1**                       | **Forbid absence claims** in `[pr_code_suggestions]`, and raise the hunk padding modestly. Narrow wording only — the rule must kill claims about code the reviewer cannot see, **not** claims about code it can. Two of the real findings this session were about inputs to visible code.                                                                                                                                                                                                                                                                                  | The measured dominant false class                 |
| **V2**                       | _Withdrawn._ The instruction blocks already demand a concrete failure scenario and already prefer silence (F2b). Rewriting them again would repeat a lever that has been pulled.                                                                                                                                                                                                                                                                                                                                                                                           | —                                                 |
| **V3**                       | **Measure one wave, then decide** (V-D1's gate). Record threads and verified-real per bot _and per workflow_ in the wave record. **If the two UI/API reviewers stay above 60 % refuted, disable them** — do not tune a third time. The architecture reviewer is exempt; it already passes.                                                                                                                                                                                                                                                                                 | The evidence that ends the question               |
| **V3 — decided, 2026-09-19** | **The UI and API REVIEWS are disabled.** `pr-agent-api.yml` is removed outright. `pr-agent.yml` keeps its file and loses its `pull_request` trigger: it is the repo's only `/improve` entry point, and both other reviewers document relying on it — deleting it would have taken that hatch from the reviewer this lane deliberately exempts. No unprompted review; a human can still ask for one. `pr-agent-arch.yml` stays (exempt by this lane's own words) and `pr-agent-react.yml` stays (it postdates the measurement entirely, #454, and has never been measured). | Owner's call on the recorded arithmetic           |
| **V4**                       | **The disposition tooling** (V-D2). A small script: given a PR and a set of thread ids, post one class disposition and resolve them together.                                                                                                                                                                                                                                                                                                                                                                                                                              | The reply cost, halved for repeated claims        |
| **V5**                       | **Mutation discipline in the skill** (V-D4) and **the merge precondition** (V-D6): a checklist item that a fix round's commit exists before merge.                                                                                                                                                                                                                                                                                                                                                                                                                         | The two failure modes that cost most this session |

> **What the decision was taken on, stated plainly.** The only recorded
> measurement is the 2026-09-09 wave record: PR-Agent **6 threads, 1 accepted,
> 5 refuted — 83 %**, comfortably above this lane's 60 % line. But that record
> says of itself _"Do not disable yet — the gate says one wave, and this is a
> third of one"_, and it is **per bot, not per workflow**: all reviewers comment
> as `github-actions[bot]` and nothing in a comment names the workflow that
> wrote it, so the 83 % cannot be attributed to the UI and API reviewers
> specifically. The owner decided on that sample anyway. Recording it this way
> so nobody later reads the disable as the arithmetic the lane asked for — it is
> a judgement taken with the arithmetic incomplete, which is the owner's to make.
>
> **The disable is of the REVIEW, not the tool.** `pr-agent.yml` still exists and
> still invokes PR-Agent on `/improve`, which is why `premise V3` goes on counting
> it as a running reviewer. That is the honest reading: it can still post findings,
> it just no longer does so unasked.
>
> **`premise V3` is deliberately NOT retired.** It is open while any running
> reviewer is unmeasured per workflow, and two still run unmeasured. Disabling
> settles half this lane; the measure half is untouched and the fence should go
> on saying so.

**Order.** V5 first — it is documentation and prevents the worst outcome. Then V1 → V3 (gated). V4
whenever convenient. **V2 is withdrawn** and V-D3 survives only as the human-side disposal rule.
**§5 tracks which of these are still open.**

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

---

## 5. Premises

Each open lane states the claim that makes it necessary, as a script that exits 0 **while the gap is
still open**. `yarn plan:verify` runs them. Audited 2026-09-12 against `main` at `7a4b8ab`.

**V1 — shipped in #290.** `.pr_agent.toml` carries it: `patch_extra_lines_before = 25`, and
`[pr_code_suggestions].extra_instructions` forbids the absence claim outright (_"YOU ARE READING A
PATCH, NOT A FILE"_). The one wave recorded since found **zero** refuted findings in that class.

**V2 — withdrawn in §2 on evidence**, not shipped, and not tracked.

**V5 — shipped in #289.** The skill states both rules — a mutation is read from the file and
confirmed applied, and a merge requires the fix commit to exist.

```premise V3
# V3 ends in an arithmetic decision about the two UI/API reviewers — disable them
# if refuted stays above 60 %, or keep them on a recorded measurement — and
# EITHER outcome closes the lane. So the gap is open only while a reviewer still
# runs AND no wave record has measured it per workflow.
#
# Per-bot is not enough: the 09-09 record has a per-bot table and calls it "not
# yet a verdict" (three PRs of one wave). What decides is per-WORKFLOW
# attribution — all three reviewers comment as github-actions[bot] and nothing
# in a comment names the workflow that wrote it (pr-agent-arch.yml says so
# itself), so a wave record that splits the three IS the measurement. The
# architecture reviewer is exempt from the DISABLE decision, not from being
# measured: the lane says "per workflow", and asking for all three keeps this
# premise retiring late rather than early.
#
# One loop, both halves decided per reviewer — a reviewer, not a file:
#
#   RUNS — the workflow's own `uses:` line invokes PR-Agent. The `uses:` is the
#     thing that decides, not the bare image name: pr-agent.yml:19 quotes the
#     image in a comment about the pin, and a premise that matched the comment
#     would go on reporting a reviewer that has been switched off.
#
#     The earlier form passed two fixed paths to one grep, so the half was
#     decided by whether two FILES existed rather than by whether a REVIEWER
#     runs: on GNU grep (CI, ubuntu-latest) one absent argument exits 2 whatever
#     the other file matched, so renaming or moving one workflow read as "the
#     reviewer has been disabled" and retired a live lane. A workflow that no
#     longer invokes PR-Agent is a reviewer that no longer runs — nothing to
#     measure — and a renamed or added one is picked up without editing here.
#
#   MEASURED — that reviewer's own id appears in a wave record. Matched as a
#     whole token so `pr-agent-api` cannot stand in for `pr-agent`, and matched
#     case-SENSITIVELY so the per-bot row "PR-Agent" cannot stand in for the
#     per-workflow attribution this lane is about: the old form matched both,
#     so a record that measured pr-agent-api retired pr-agent, the reviewer
#     carrying 58 % of the volume. Missing a mention leaves the lane live,
#     which is the cheap direction.
#
# The gap is open while any running reviewer is unmeasured.
for wf in .github/workflows/*.yml; do
  grep -q "uses:.*pragent/pr-agent" "$wf" || continue
  id=${wf##*/}
  id=${id%.yml}
  grep -qE "(^|[^A-Za-z0-9_-])$id([^A-Za-z0-9_-]|$)" docs/planning/*wave-record*.md || exit 0
done
exit 1
```

**V4 — shipped on this branch (`tools/sweep`).** `yarn sweep threads --pr <n> --thread <PRRT_id>…
(--body | --body-file) [--post]` posts ONE class disposition — the mechanism named once, the
member ids listed verbatim — onto the PR conversation via `addComment`, then `resolveReviewThread`
on every member, in one GraphQL request; the exact comment and the exact ids are previewed before
`--post` writes, and the whole run refuses if any id is not a distinct open thread on that PR.
Whether a finding is real stays the human judgement the disposition text carries — V-D3's rule,
and this lane's own budget rule. The hand-run `gh api graphql resolveReviewThread` loop it
replaced lives on only as the operator's fallback copy in the Stage 4 runbook
(`docs/workflows/delegated-implementation-pipeline.md`). Its premise fence is retired here, in
the shape `plan:verify` accepts: deleted, not blanked and not left to exit 1 — a stale fence is
a STALE report, not a closed lane.

---

## 8. V3's first measurement — wave of 2026-09-13

V3 requires threads and verified-real **per bot and per workflow**. This is what the wave produced,
and what it could not produce.

### Scope

Three PRs — **#369, #370, #371** — dispositioned finding by finding, every verdict verified against
the branch before it was written. Earlier PRs in the same wave (#363–#368) are **excluded**: their
dispositions were written as prose and cannot be counted per finding without re-deriving verdicts
after the fact, which is not measurement.

### Per bot

| Bot                                  | Threads | Verified real | Refuted | Refuted %                     |
| ------------------------------------ | ------- | ------------- | ------- | ----------------------------- |
| **PR-Agent** (`github-actions[bot]`) | 6       | 0             | 6       | **100 %**                     |
| **Qodo** (`qodo-code-review[bot]`)   | 7       | 4             | 3       | **43 %**                      |
| **CodeRabbit** (`coderabbitai[bot]`) | 0       | 0             | 0       | — (rate limited on all three) |

Qodo's four real findings: the event-only row dropping its gate log (#369, blocking, fixed); the html
drawer painting the first layer for every dispatched layer (#371, blocking, fixed); and two real
overflow defects deferred as X10. **Both blocking defects this wave came from Qodo**, and both were
in the lane's own new code.

PR-Agent's six: two style preferences, two assertions about validation ordering that the code already
handles, one fallback that would have masked a boundary escape, and one request to draw an asset the
element vocabulary does not define.

### Per workflow — not recoverable, and that is the finding

The decision rule V3 states is **specifically about the UI and API reviewers, exempting
Architecture**. That split cannot be made from the artifacts:

- All three PR-Agent workflows post as `github-actions[bot]` with identical formatting and **no
  workflow marker in the comment body**.
- Only the check-run list attributes a PR's comments, and only when one workflow ran. **#369** lists
  UI alone (2 threads, both refuted). **#371** lists Architecture _and_ UI, so its 2 threads cannot be
  split. **#370** lists neither PR-Agent run at all, though it changed both `apps/api/**` and
  `packages/*/src/**` and carries 2 PR-Agent threads.

So: **2 threads attributable to UI Review (100 % refuted), 4 unattributable (100 % refuted).**

Note that UI Review has **no `paths` filter** — it fires on every PR opened — while API is scoped to
`apps/api/**` and Architecture to `packages/*/src/**`. That makes UI the highest-volume of the three
and the one the arithmetic most needs to isolate.

### The decision V3 asks for is not yet takeable

The raw arithmetic (6 of 6 refuted) sits far above the 60 % line, and on this wave's evidence the two
scoped reviewers look like the cut V-D1 anticipated. **It is still not enough to act on**: n = 6, and
of those only 2 are attributable to a workflow the rule names. Disabling Architecture by accident —
the one reviewer the plan exempts because it already passes — is precisely the error the per-workflow
requirement exists to prevent.

**V3 stays open, and its blocker is a recording gap, not a measurement gap.** The counts must be
written **at sweep time**, when the sweeper knows which check run produced which thread, rather than
reconstructed afterwards from artifacts that do not carry the attribution. Until a wave is recorded
that way, V3 has no arithmetic to run.

One further caution for whoever closes this lane: of PR-Agent's six refutations, **every one was
refuted with a named mechanism and line numbers**, not with a judgement call — which is the standard
V-D4 sets. A refuted rate assembled from softer refutations would not support the same decision.

### 8.1 Amendment — the same wave, three more PRs (2026-09-13, later)

§8 measured #369–#371. The wave continued, and three more PRs were dispositioned finding by finding
against their branches: **#374** (X9), **#376** (S3) and **#377** (HL4). Every thread below was
verified against the code; none is counted from a bot's self-description. §8's table stands as a
record of what was known then; this one supersedes it as the wave's figure.

| Bot            | Threads | Verified real | Refuted | Refuted %                 |
| -------------- | ------- | ------------- | ------- | ------------------------- |
| **Qodo**       | 14      | 11            | 3       | **21 %**                  |
| **PR-Agent**   | 15      | 3             | 12      | **80 %**                  |
| **CodeRabbit** | 0       | 0             | 0       | — rate limited throughout |

**Qodo's eleven** include every defect that blocked a merge this wave: the event-only row dropping its
gate log (#369); the html drawer painting the first layer for every dispatch (#371); a review blocker
hidden from the attention view, an unknown check count printed as `0`, a non-advancing cursor, and a
malformed page read as `ready` (#376); and **two script-injection holes in the publicly served ad
unit** (#377). Its three refutations were all on #370.

**PR-Agent's three real findings**, and whether each was already covered:

- `collect.ts:590`, a missing `hasNextPage` read as a completed page (#376) — **also Qodo's**.
- `markup-assembler.ts`, `brandColor` interpolated into CSS unescaped (#377) — **also Qodo's**.
- `report.ts`, the `isPersistedAsset` type predicate not verifying `clickDestination` (#377) —
  **PR-Agent alone.** Low severity: it needs a malformed report row. Recorded as **X12**.

So the marginal value of PR-Agent this wave — what would have been lost had it been off — is **one
low-severity finding in fifteen threads.**

### Per workflow

Attribution by each workflow's `paths` filter, which decides whether it can run at all (UI Review has
none; API is `apps/api/**`; Architecture is `packages/*/src/**` plus web TS):

|                                                                                   | Threads | Real | Refuted | Refuted % |
| --------------------------------------------------------------------------------- | ------- | ---- | ------- | --------- |
| **UI Review** — PRs only it could review (#369, #376)                             | 5       | 1    | 4       | **80 %**  |
| **API Review** — attributable alone                                               | 0       | —    | —       | no data   |
| **Unattributable** — #370, #371, #377, where two or three workflows were eligible | 10      | 2    | 8       | 80 %      |

**UI Review crosses V3's 60 % line on its own attributable threads — but on n = 5.** API Review has
**no** attributable thread at all: it never ran on a PR without another PR-Agent workflow beside it.

### Where that leaves the decision

- **UI Review**: the arithmetic says disable; the sample is five. One more wave recorded at sweep
  time settles it either way.
- **API Review**: not decidable from this wave, by construction. It needs a PR touching only
  `apps/api/**` — or per-comment workflow attribution, which §8 already identified as the fix.
- **Architecture Review** stays exempt, as V3 states. Nothing here argues otherwise: none of the ten
  unattributable threads can be pinned on it, and the plan's rule is not to cut a passing reviewer by
  accident.

**V3 stays open.** Its fence stays. What changed is that the case against UI Review is now numerical
rather than anecdotal, and the one question left is sample size.

**V3 recording — shipped in this PR.** `yarn sweep attribute --pr <n>` attributes each
`github-actions` review thread to a PR-Agent workflow by matching the thread's suggestion text
(the span between `**Suggestion:**` and the trailing `[label, importance: n]`, whitespace-normalised)
against that workflow's decoded job log. Exactly one matching workflow → attributed; none or several
→ `unattributed`, never a guess. A thread fetch or log read that fails exits 1 (fail closed, like
`gate`). The `premise V3` fence stays: V3's disable/keep decision still needs a recorded wave.

A missing log can only remove matches, so it can turn a true two-workflow ambiguity into a false
single attribution. The verb therefore refuses a run list that fills its limit (the page is not
treated as complete), keeps only runs whose `headSha` is a commit of this PR (a reused head-branch
name cannot import an older PR's log), and decodes each JSON string with `JSON.parse` rather than
ordered `replace` calls. Two coverage limits stay `unattributed` and are not searched further: UI
reviews triggered by an `/improve` comment (`issue_comment`) run on the default branch, so they are
not among the PR's commits; and on the HL5d PR the Architecture run's log carried no model response,
so its threads there were `unattributed`. Both are the safe outcome of the same rule.
