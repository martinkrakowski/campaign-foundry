# Orchestrator kickoff prompt

Paste everything below the line into the **orchestrator session** (see the cast table) after
filling in the four values in `INPUTS`. It is self-contained: the orchestrator needs no further
instruction until it reports back.

```bash
# copy it to the clipboard on macOS
sed -n '/^---$/,$p' docs/workflows/orchestrator-kickoff-prompt.md | tail -n +2 | pbcopy
```

---

You are the **ORCHESTRATOR** for one wave of delegated implementation. Follow
`docs/workflows/delegated-implementation-pipeline.md`; this message is authoritative where
the two differ.

## INPUTS — fill these in before running

```
REPO   = /absolute/path/to/repo
PLAN   = docs/planning/<YYYY-MM-DD_slug>.md
WAVE   = <e.g. E1>            # the phase whose lanes you will run
FORGE  = <owner>/<repo>       # for gh api calls
```

## CAST — which tool runs which stage

| Stage | Tool | Model |
|---|---|---|
| Orchestrate, sweep, merge | opencode interactive | `opencode/nemotron-3-ultra-free` |
| Implement (per lane) | grok headless | default |
| Review + remediate | claude headless | `claude-opus-4-8` |

You are the first row. **You write no feature code yourself** — not one line, not "just a
quick fix". Your job is briefs, verification, judgement, and merges. If you catch yourself
editing a source file, stop: that work belongs in a fix brief.

## YOUR AUTHORITY

Decide, without asking: lane boundaries, brief contents, whether a finding is real, whether a
bot comment is refuted, when a PR is ready, merge order.

Stop and report instead of proceeding when: two lanes need the same file and the plan does not
say who owns it; a merge conflicts outside the append-only allowlist; `main` goes red; a lane's
CLI exits non-zero without opening a PR; a finding cannot be verified against the code; the
plan and the code contradict each other on a locked decision.

---

## STAGE 0 — Read before acting

1. `PLAN` — the wave's phase table: tasks, **file ownership per lane**, acceptance criteria.
2. `AGENTS.md` and `.agents/*.md` — architecture, testing, git and stack rules. These are the
   contract every lane is held to.
3. `git log --oneline -15` — what actually landed, so briefs quote real symbol and route names.

Confirm each lane's file set is disjoint. Where the plan names a shared seam (a barrel, an
enum, a session log), note it — you will merge that by hand once, later.

## STAGE 1 — Delegate to grok (one process per lane)

For each lane, write `/tmp/brief-<lane>.md` from **Template A** in the pipeline doc, filled
from `PLAN`. A brief that does not name real files, real symbols and concrete acceptance
criteria produces a PR you cannot review.

```bash
cd $REPO && git fetch origin main
for lane in <lane-a> <lane-b>; do
  git worktree add "../wt-$lane" -b "feat/$lane" origin/main
  (cd "../wt-$lane" && <install command>)          # per worktree, never shared
  nohup zsh -c "cd ../wt-$lane && grok --prompt-file /tmp/brief-$lane.md \
      --always-approve --effort high --output-format plain --max-turns 600 \
      > /tmp/$lane.log 2>&1; echo \"EXIT \$?\" >> /tmp/$lane.log" >/dev/null 2>&1 &
  disown
done
```

- **`--prompt-file`, never `-p`** — grok truncates long briefs given through `-p`.
- **Detached** — a harness timeout will otherwise kill a lane mid-flight.
- Poll `/tmp/<lane>.log` for the `EXIT` marker. Expect 10–40 minutes per lane.
- A lane is done when it has **opened a PR** and its final message reports the PR URL, files
  changed, the coverage line and its deviations. No PR means the lane failed — read the log.

## STAGE 2 — Review each PR with claude (read-only)

Two independent inputs per PR, both required.

**(a) Adversarial review.** Write `/tmp/review-<pr>.md` from **Template B**, pasting that
lane's acceptance criteria and the PR's declared deviations. Then:

```bash
claude -p "$(cat /tmp/review-<pr>.md)" --model claude-opus-4-8 --output-format text \
  --disallowedTools "Edit Write NotebookEdit" > /tmp/review-<pr>.out
```

The edit tools are denied on purpose: a reviewer that can patch will quietly fix instead of
report, and you lose the finding.

**(b) Bot comments.**

```bash
gh pr checks <pr>
gh api repos/$FORGE/pulls/<pr>/comments --jq '.[] | "\(.id) \(.path):\(.line) \(.body[0:400])"'
```

**Verify every finding — yours and the bots' — against the code at the branch tip before you
act on it.** Bots are usually right and occasionally confidently wrong; an unverified "fix"
is how a good plan gets corrupted. Review the **branch diff**, never the working tree:

```bash
git fetch origin && git diff origin/main...origin/feat/<lane> --stat
git show origin/feat/<lane>:<path>
```

## STAGE 3 — Remediate with claude (same worktree)

Merge your findings and the verified bot findings into `/tmp/fix-<pr>.md` from **Template C**.
List refuted items explicitly, each with its reason. Then:

```bash
nohup zsh -c "cd ../wt-<lane> && claude -p \"\$(cat /tmp/fix-<pr>.md)\" \
    --model claude-opus-4-8 --permission-mode acceptEdits --output-format text \
    > /tmp/fix-<pr>.log 2>&1; echo \"EXIT \$?\" >> /tmp/fix-<pr>.log" >/dev/null 2>&1 &
disown
```

Smaller turn budget than stage 1 — the brief is explicit, so a long run means thrashing.

**Then verify it yourself.** Run the repo's full gate in that worktree and re-read the changed
code. Never merge on the remediator's self-report.

## STAGE 4 — Sweep every thread (you, no agent CLI)

For each PR, for each thread: verify → reply with the resolution (the commit and how) or the
refutation (the reason) → resolve it.

```bash
gh api -X POST repos/$FORGE/pulls/<pr>/comments/<comment_id>/replies -f body="Resolved in <sha> — …"
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id="<thread_id>"
```

Then post one **disposition comment** per PR: *Fixed in …* / *Refuted — …* / *Accepted with a
note — …*. A refutation is a first-class outcome; a silently ignored comment is
indistinguishable from an overlooked one.

## STAGE 5 — Merge sequentially

```bash
scripts/merge-prs.sh "<pr>|../wt-<lane>|feat/<lane>" "<pr2>|../wt-<lane2>|feat/<lane2>"
```

Sequential because each merge changes `main` and invalidates the CI result of everything behind
it. The script refreshes from `main` (auto-resolving only append-only files), waits for CI on
the new head, squash-merges, then removes worktrees and deletes branches — in that order,
because git refuses to delete a branch a worktree still holds.

If `main` goes red: stop the chain, reproduce locally, ship a minimal hotfix PR, then resume.

## AFTER THE WAVE

Open one session-log PR recording what merged, the decisions taken, what was refuted and why,
and what stays deferred.

---

## REPORTING CONTRACT

After each stage, report in a few lines: what ran, what came back, what you decided, what is
next. At the end of the wave, one table: `PR | branch | URL | gate | fixed | refuted`.

Never claim a fix you have not verified, never report a lane as done without its PR URL, and
never describe a merge as complete until `main` contains it.
