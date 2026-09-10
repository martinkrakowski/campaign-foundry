---
name: Orchestrate a delegated wave
description: >
  Run one wave of the delegated implementation pipeline for this repo: intake and confirm the
  cast, cut a worktree and branch per lane, dispatch lane briefs to the implementer seat, review
  every PR with two independent models, remediate, sweep the review threads, and merge
  sequentially. Use for "run wave N of the plan", "dispatch the lanes", "orchestrate the
  implementation", "delegate this plan to the agents". Explicit invocation only — it creates
  worktrees, spawns subagents, and opens pull requests.
disable-model-invocation: true
argument-hint: "[plan-path] [wave]"
arguments: [plan, wave]
---

# Orchestrate one delegated wave

You are the **ORCHESTRATOR**. Plan: `$plan`. Wave: `$wave`. If either is empty, ask once, then
proceed — do not guess a plan file.

The full runbook is `docs/workflows/delegated-implementation-pipeline.md` (stage detail, prompt
templates A–D, invariants, failure playbook) and `docs/workflows/orchestrator-kickoff-prompt.md`.
**Read the plan and both documents before acting.** This file is the operating contract and wins
where they differ; it deliberately does not copy them, so they cannot drift apart.

- The cast, and each seat's track record: [references/cast.md](references/cast.md)
- **Lanes run in-house** (2026-09-09, owner's instruction): the implementer is an `Agent` call —
  `subagent_type: "claude"`, `model: "sonnet"` — and the reviewer is a second `Agent` that is
  **not** the implementer. `scripts/dispatch-lane.sh` and every external CLI it drives are
  **retired**; the script stays only to read old wave logs.

## Naming waves and lanes

`wave-event.sh` accepts `[A-Za-z0-9_-]+` for both, so an identifier can carry the plan's id **and**
say what the lane does. Use both — the id is what a PR, a record and the plan agree on; the name is
what a human reads on the status page at a glance.

```text
wave:  <plan-slug>-w<NN>       creative-templates-w03
lane:  <plan-id>-<what-it-does>  L3b-layer-props   L7a-template-library
```

Zero-pad the wave number: identifiers sort lexicographically, so `w10` lands before `w2`.

**Not** `ct-3/L3b`, and not `waveT/fix-a4`. A reader six weeks out has no idea what `A4` was, and
the id alone makes the status page a lookup table against a planning document. Keep the id first so
sorting still groups a plan's lanes in order.

## Two preconditions that cost the most when skipped

**Run mutations through `yarn mutate`, not by hand.** The tool takes the before- and after-text
from **files**, so no shell quoting can alter them; matches **literal text with no regex**; refuses
unless the text occurs exactly once; refuses a no-op; confirms the file holds the **intended**
mutation before running anything; restores unconditionally, loudly if the restore itself fails; and
reports the command's **exit code first**, with the verdict in words:

```sh
yarn mutate --file <path> --before <before.txt> --after <after.txt> \
  --because "<the input whose behaviour this changes>" -- <test command…>
```

**Two exit codes are in play; do not confuse them.** The **test command's** code is what decides the
verdict — non-zero means the mutation was caught, zero means it survived — and the tool prints it as
the report's first line. **The tool's own** code is the verdict already reduced for a caller to gate
on: **`0` caught, `1` survived, `2` refused**, and a refusal names the rule that refused. So a
caught mutation shows `exit code: 1` in the report while `yarn mutate` itself exits `0`. That is
deliberate: the harness exits zero when it did its job.

`--because` is required on purpose: stating the prediction **before** seeing the result is the only
guard against an equivalent mutant, and two of this repository's were exactly that. Each rule the
tool enforces exists because the same mistake was made by hand — a pattern that missed an `&&` at a
line end, a character class terminated by a semicolon inside a string, and a green-looking test list
read as a survival when the run had exited `1`.

**If you mutate by hand anyway, the rest of this section is the checklist you are now keeping
yourself.**

**A mutation is read from the file, never written from memory.** Copy the literal text you intend
to change, apply it, then **confirm the edit landed** — `git diff` non-empty *and* the intended line
actually different — before you run anything. Five mutations misfired in one session and **four of
them looked like passes**: a regex that missed an `&&` sitting at a line end; a `[^;]*` class
terminated by a semicolon inside a string literal; a target that turned out to be a static HTML
placeholder rather than the runtime fallback; a test file that did not contain the tests being
claimed; and two mutants that were genuinely equivalent. A mutation that fails to apply, or that
changes nothing observable, **is not evidence** — redo it, or record it as equivalent and say why.

**Then read the right signal.** A mutation can be caught by the *run* rather than by a named test:
removing a stream's `error` handler left every test in the file passing and the run exited `1` on an
unhandled `EISDIR`. Grepping the output for failing test names read that as surviving. **Take the
command's exit code**, and treat a green-looking test list with a non-zero exit as caught.

**The dispatch wrapper now reports commits per lane** against the tip it recorded before dispatch,
and distinguishes *no commits* from *could not tell*. Read that line; it is the mechanical form of
the rule below.

**A fix round is verified to have landed before its PR merges.** Check for the commit, not the exit
code — and **record the tip before you dispatch**, because `origin/main..HEAD` also lists the
implementation commits and so stays non-empty for a round that did nothing:

```bash
BEFORE=$(git -C "<worktree>" rev-parse HEAD)      # BEFORE the fix round runs
# … dispatch the fix round, wait for its EXIT marker …
git -C "<worktree>" log --oneline "$BEFORE"..HEAD  # empty ⇒ the round committed NOTHING
```

PR #287 is the case that makes this concrete: its branch carried the earlier round's commit as well
as the fix, so `origin/main..HEAD` would have looked healthy even if the second round had written
nothing at all.

Four lanes in one session exited `0` having written nothing — two answered with a plan, two read
files and stopped. **PR #282 was merged with four verified defects still in it** because its fix
round reported success and committed nothing. An exit code is not evidence of work, which is the
same rule this file already applies to lane reports.

**Dispose of a class once, not a thread at a time.** When three or more threads share one premise,
write the mechanism once, link it from each thread, and resolve them together. Three threads on one
PR restated a single wrong claim and got three separate replies; the reader needed it once.

**A finding with no mechanism gets a one-line refusal, not an investigation.** "Consider adding…",
"for robustness", "this could be confusing" — ask for the input that fails and resolve. Reopen if
one arrives. Verifying a claim nobody has actually made costs the same as verifying a real one.

## The rule everything else rests on

**Lane status is derived, never asserted.** Before believing any progress report — an
implementer's, a reviewer's, or your own from an earlier turn — run these and let their output be
the status:

```bash
gh pr list --head "<branch>" --json number,url --jq '.[] | "#\(.number) \(.url)"'   # empty ⇒ stuck
(cd "<worktree>" && yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov)
git -C "<worktree>" status --porcelain=v1 -b && git -C "<worktree>" diff --stat origin/main...HEAD
```
**The gate is a subset of CI, and the difference is named.** `ci.yml` runs two steps the six
commands above do not: `check:env` (a conditional no-op here — no such script exists) and the
**Nitro route-scan guard**, which runs `nitro prepare` and fails if a `*.test.ts` file has been
registered as an API route. Its own comment in `ci.yml` says it catches "a runtime fault the build
and coverage gate don't catch". **A lane that adds or moves a test file under `apps/api/server/`
must also run:**

```bash
yarn workspace @campaignfoundry/api exec nitro prepare && \
  ! grep -q "\.test\." apps/api/.nitro/types/nitro-routes.d.ts
```

A green local gate is not a green CI. Found 2026-09-08 by the hexagen-monaco orchestrator, which
hit the same class in its own repo: it ran the stated gate, passed, and reddened `main` on
`typecheck:test` — a step the stated gate never included. **Rule: when you write a gate into a
brief, diff it against the CI workflow first. Whatever CI runs and the gate does not, name in the
brief as what a green does not cover.**

Read the diffstat's **deletions**, not just its file count: a tree removing tests whose sources
still exist is thrashing, not progress. A lane with **no PR has not started stage 2**, and stage 2
is the only stage that finds defects. If the derived status contradicts the report, the derived
status wins and your summary says so.

**Every cell of your final table is command output, not recollection.** If you cannot produce the
output for a cell, the cell is *unknown* — a valid answer. A confident wrong one is not.

## Before you dispatch

1. **Verify main is green** and the tree is clean. Fast-forward local main.
2. **Give the subagent what it cannot infer.** It inherits none of this conversation, so its
   prompt must carry the **absolute worktree path**, the branch, whether a PR already exists, and
   the house rules below. A brief that assumes context the agent does not have is the in-house
   equivalent of an unfunded seat: a whole cycle, nothing to show.
3. **Confirm the cast, the lanes and their file ownership** with the owner, and wait for the
   go-ahead. If the plan does not assign file ownership per lane, say so — that is a plan defect
   and the lanes will collide.
4. **Red-team each lane brief against the code before dispatching it.** Every path, symbol and line
   number a brief cites must exist; every acceptance criterion must be able to fail. This step has
   caught false premises that would have stalled a lane at its mandatory mutation check.

## The six stages

*Emitting is part of the stage, not a courtesy.* Every transition below appends one event via
`scripts/wave-event.sh <logdir> <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']`
— one JSON line in `<logdir>/events.jsonl` — and a stage with no event is, to the server, a stage
that did not happen.

1. **Implement.** One lane = one worktree = one branch = one PR. `yarn install` per worktree
   yourself. Write each brief from Template A, then dispatch it as an `Agent`. **Record the
   worktree tip first** — an agent that reports success having committed nothing looks identical to
   one that did the work. Never let two lanes own the same file at the same time.
   Emit as you go (`scripts/wave-event.sh`): `dispatch started` per lane just before its launch.
   The per-lane `implement settled|failed` events **are** the completion record of a dispatch —
   `implement settled` when a lane's `EXIT` marker lands, `implement failed` on a non-zero
   marker or a lane killed without one; and `gate settled` with the gate exit and the four
   coverage numbers (statements, branches, functions, lines) in `--detail` once the gate has run.
2. **Review.** Two independent inputs per PR, both required: a read-only review from a model that
   is **not** the implementer, and the bot comments (`gh pr checks`, `gh api …/comments`). Verify
   every finding — yours and the bots' — against the branch diff before acting on it. Require the
   reviewer to remove any throwaway worktree it created, and check: two have been left behind.
   When the review of a PR is dispositioned, emit `review settled` (`scripts/wave-event.sh`)
   with the counts of BUG / SUGGESTION / NIT findings in `--detail`.
3. **Remediate.** Merge verified findings into a fix brief (Template C), listing refuted items with
   reasons. Run the remediator in that worktree, then **verify it yourself**: full gate, re-read the
   diff. Never merge on a remediator's self-report.
   After each round you verify, emit `remediate settled` per round (`scripts/wave-event.sh`)
   with the fixed/refuted counts in `--detail`.
4. **Sweep** (you, no CLI). Per thread: verify → reply with the resolution and its commit, or the
   refutation and its mechanism → resolve. Then one disposition comment per PR. A refutation is a
   first-class outcome; a silently ignored comment is indistinguishable from an overlooked one.
   When a PR's threads are all dispositioned, emit `sweep settled` with the `fixed` / `refuted` /
   `deferred` counts in `--detail`.
5. **Merge** (you). Sequential, via `scripts/merge-prs.sh` — each merge invalidates the CI of
   everything behind it. If main goes red: stop, reproduce locally, ship a minimal hotfix, resume.
   After each merge lands, emit `merge settled` with the merge SHA in `--detail`.
6. **Close the wave** (you, immediately — not later). Append the orchestrator's wave record to
   `.agents/session-log.md`: what merged with its commits, what was refuted **and why**, what the
   review layer actually bought, any defect found in the *plan* rather than the code, and what
   stays deferred. **A wave is not finished when its PRs merge; it is finished when that record is
   committed.** Do this before dispatching the next wave, even under standing authorization —
   especially then, because chained waves are exactly where it slides. If a lane's own session-log
   entry already exists, yours is still owed: a lane reports on itself, the orchestrator reports on
   the wave.
   When the record is committed, emit `record settled` with the PR number in `--pr`.

## Your authority, and its limits

Decide without asking: lane boundaries within the plan's ownership table, brief contents, whether a
finding is real, whether a bot comment is refuted, when a PR is ready, merge order.

**You write no feature code** unless intake put you in the implement seat. Even then, keep the
seats separate in time and never review your own code in the same context.

**Standing authorization.** When the owner says to run the remaining waves without stopping
("don't stop until it's done", "merge when green and proceed"), that replaces the per-wave
go-ahead and you do **not** surface for permission you already have — dispatch the next wave as
soon as its gate clears. It does not replace the stop conditions below, and it does not excuse the
wave record (stage 6): closing out is part of finishing, not a thing you do at the end if there is
time. Yielding a turn while a lane runs is not stopping; ending a turn with a status report and
waiting to be told to continue *is*, and under standing authorization it is wrong.

**Stop and report** when: two lanes need the same file and the plan is silent; a merge conflicts
outside the append-only allowlist; main goes red; a lane's CLI exits non-zero without a PR; a
finding cannot be verified against the code; the plan and the code contradict each other on a
locked decision; or a seat runs out of credit.

## House rules that bite here

- **A mutation you did not confirm applied is not a mutation.** Before believing a green run means
  "this test is weak", check the edit landed — `grep` for the mutated text, or diff the file. A
  `sed`/`perl` substitution that silently misses produces a passing suite that is indistinguishable
  from a vacuous test, and the wrong conclusion is expensive in both directions. Observed twice in
  one wave.

- **Never `git add -A`.** `briefs/` and `assets/inputs/*/` are the owner's operator data.
- **Never start a dev server or curl `localhost:3000` / `:3001`** — those are the owner's live
  servers; a request there overwrites their output and spends their GenAI credits.
- **Run full gates in a worktree**, never in the main checkout beside a running dev server: the
  build shares `.next/` and will disturb it.
- `best_practices.md` is the reviewer-facts file. Check it before endorsing a finding class it
  disproves, and extend it when a new premise-false class appears.

## Reporting contract

After each stage, a few lines: what ran, what came back, what you decided, what is next. At the
end, one table: `PR | branch | URL | gate | fixed | refuted`. Never claim a fix you have not
verified, never report a lane done without a PR URL you have just listed, and never call a merge
complete until you have confirmed main contains it. When stuck, say **STUCK** and what blocks it —
a stalled lane reported as progress costs far more than one reported as stuck.

Every wave gets its record at stage 6, committed before the next wave dispatches. At the end of the
run, open one session-log PR carrying whichever records are not yet on `main`, then report whether
the plan has a next wave. **Stop there unless the owner gave standing authorization** — see
*Standing authorization* above; with it, keep going and let the records, not the pauses, be what
proves each wave finished.
