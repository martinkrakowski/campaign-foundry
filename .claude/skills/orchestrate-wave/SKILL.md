---
name: Orchestrate a delegated wave
description: >
  Run one wave of the delegated implementation pipeline for this repo: intake and confirm the
  cast, cut a worktree and branch per lane, dispatch lane briefs to the implementer CLI, review
  every PR with two independent models, remediate, sweep the review threads, and merge
  sequentially. Use for "run wave N of the plan", "dispatch the lanes", "orchestrate the
  implementation", "delegate this plan to the agents". Explicit invocation only — it creates
  worktrees, spends money on other CLIs, and opens pull requests.
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

- Verified CLI invocations, model ids and each model's track record: [references/cast.md](references/cast.md)
- Staggered dispatch + blocking wait: `${CLAUDE_SKILL_DIR}/scripts/dispatch-lane.sh`

## The rule everything else rests on

**Lane status is derived, never asserted.** Before believing any progress report — an
implementer's, a reviewer's, or your own from an earlier turn — run these and let their output be
the status:

```bash
gh pr list --head "<branch>" --json number,url --jq '.[] | "#\(.number) \(.url)"'   # empty ⇒ stuck
(cd "<worktree>" && yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov)
git -C "<worktree>" status --porcelain=v1 -b && git -C "<worktree>" diff --stat origin/main...HEAD
```

Read the diffstat's **deletions**, not just its file count: a tree removing tests whose sources
still exist is thrashing, not progress. A lane with **no PR has not started stage 2**, and stage 2
is the only stage that finds defects. If the derived status contradicts the report, the derived
status wins and your summary says so.

**Every cell of your final table is command output, not recollection.** If you cannot produce the
output for a cell, the cell is *unknown* — a valid answer. A confident wrong one is not.

## Before you dispatch

1. **Verify main is green** and the tree is clean. Fast-forward local main.
2. **Verify the seats are funded and resolve.** `grok models`, `agy models`, and a one-word
   `opencode run` probe. An unfunded implementer costs a whole cycle and leaves nothing behind.
3. **Confirm the cast, the lanes and their file ownership** with the owner, and wait for the
   go-ahead. If the plan does not assign file ownership per lane, say so — that is a plan defect
   and the lanes will collide.
4. **Red-team each lane brief against the code before dispatching it.** Every path, symbol and line
   number a brief cites must exist; every acceptance criterion must be able to fail. This step has
   caught false premises that would have stalled a lane at its mandatory mutation check.

## The five stages

1. **Implement.** One lane = one worktree = one branch = one PR. `yarn install` per worktree
   yourself. Write each brief from Template A, then launch detached via the dispatch script and
   wait on the `EXIT` marker. Never let two lanes own the same file at the same time.
2. **Review.** Two independent inputs per PR, both required: a read-only review from a model that
   is **not** the implementer, and the bot comments (`gh pr checks`, `gh api …/comments`). Verify
   every finding — yours and the bots' — against the branch diff before acting on it. Require the
   reviewer to remove any throwaway worktree it created, and check: two have been left behind.
3. **Remediate.** Merge verified findings into a fix brief (Template C), listing refuted items with
   reasons. Run the remediator in that worktree, then **verify it yourself**: full gate, re-read the
   diff. Never merge on a remediator's self-report.
4. **Sweep** (you, no CLI). Per thread: verify → reply with the resolution and its commit, or the
   refutation and its mechanism → resolve. Then one disposition comment per PR. A refutation is a
   first-class outcome; a silently ignored comment is indistinguishable from an overlooked one.
5. **Merge** (you). Sequential, via `scripts/merge-prs.sh` — each merge invalidates the CI of
   everything behind it. If main goes red: stop, reproduce locally, ship a minimal hotfix, resume.
6. **Close the wave** (you, immediately — not later). Append the orchestrator's wave record to
   `.agents/session-log.md`: what merged with its commits, what was refuted **and why**, what the
   review layer actually bought, any defect found in the *plan* rather than the code, and what
   stays deferred. **A wave is not finished when its PRs merge; it is finished when that record is
   committed.** Do this before dispatching the next wave, even under standing authorization —
   especially then, because chained waves are exactly where it slides. If a lane's own session-log
   entry already exists, yours is still owed: a lane reports on itself, the orchestrator reports on
   the wave.

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
