# The cast — verified invocations, model ids, and track record

Re-probe before trusting any row: `grok models`, `agy models`, `opencode models`. Two of these
fail with a misleading error rather than "no such model".

## Seats

| Seat | Command |
|---|---|
| **implementer** | `opencode run --auto --model openrouter/z-ai/glm-5.3-flash --variant high "$(cat BRIEF.md)"` |
| **PR reviewer A** | `grok -p "$(cat REVIEW.md)" --model grok-4.6 --effort high` (add `--disallowed-tools "edit,write"`) |
| **PR reviewer B** | `agy --print "$(cat REVIEW.md)" --dangerously-skip-permissions --effort high --model gemini-3.7-flash-high` |
| **remediator** | `grok -p "$(cat FIX.md)" --model grok-4.6 --effort high` |
| **plan reviewers** | `grok-4.6` high **and** `agy --model gemini-3.1-pro-high` — run both |
| **sweep, merge** | the orchestrator, never delegated |

Launch every lane detached so a harness timeout cannot kill it, and wait on the marker:

```bash
nohup zsh -c 'CLI … > /tmp/<lane>.log 2>&1; echo "EXIT $?" >> /tmp/<lane>.log' >/dev/null 2>&1 & disown
while ! grep -qE '^EXIT [0-9]+$' /tmp/<lane>.log 2>/dev/null; do sleep 30; done
```

`scripts/dispatch-lane.sh` does both, with the stagger below.

## Traps that have each cost a cycle

- **opencode: never launch two `opencode run` invocations in the same instant.** They share a
  SQLite store; the second dies immediately with `database is locked` and `EXIT 1`. It is startup
  contention only — **stagger by 30–45 s** and both run fine concurrently. Because the failure
  writes its `EXIT` marker instantly, a marker-only wait returns at once and looks like success:
  **read the log body on `EXIT 1`.**
- **opencode: `"User not found."` means a stale stored credential, not a bad model id.** opencode
  keeps its own key in `~/.local/share/opencode/auth.json` under `<provider>.key`, and an
  `OPENROUTER_API_KEY` in the environment does **not** override it. Prove the key independently
  with `curl -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key`; a 200 with
  `limit_remaining` means the failure is opencode-side. Back the file up, replace that one field,
  `chmod 600`.
- **opencode: an unfunded seat kills every model on that account** (`Insufficient balance`), the
  alternates included, and leaves nothing behind — clean worktrees, no commits. Probe before a wave.
- **grok can take 80+ minutes and look dead**: 0 bytes written, seconds of CPU, no error, then it
  delivers. Report a silent reviewer as **unknown**, never as failed, and keep the blocking wait
  armed.
- **grok invocation:** this file prescribes `grok -p "$(cat FILE.md)"`, which every run in the wave
  that produced this skill used successfully, with briefs of several thousand words.
  `docs/workflows/orchestrator-kickoff-prompt.md` prescribes `--prompt-file FILE.md` instead. Both
  work; `--prompt-file` keeps the brief off the command line entirely, so prefer it for a very large
  brief. **The two documents disagreeing is itself worth fixing** — noted rather than silently
  diverged from.
- **grok model id is `grok-4.6`**, not `grok-4.6-high`; effort is a separate flag. Quota exhausts
  with HTTP 402 and later resets.
- **agy needs `--dangerously-skip-permissions` when detached** — the denial is the permission
  prompt failing with no TTY, not the detachment.

## Track record, from waves run in this repo

- **glm-5.3-flash** — strongest implementer here: 17/18 lanes clean, honest reports, real mutation
  checks, fastest. Has corrected a wrong orchestrator brief with evidence, and once discarded its
  own verification on noticing the check passed vacuously.
- **grok-4.6 high** — the depth leader as reviewer, and 4/4 as fixer with every fix mutation-proven.
  It has twice refused an orchestrator-approved finding with the mechanism instead of complying.
- **gemini-3.1-pro** — excellent on a narrow, fully specified remediation brief; **catastrophic on
  an open-ended lane** (shipped 40 failing tests, deleted another lane's tests, reported success).
  Task shape predicts the outcome better than model rank.
- **mercury-2** — dies above roughly 128k of context; lost 2 of 3 lanes.

**Keep the implementer and the reviewer on different models.** A clean bill from the model that
wrote the code is worth little. When the two plan reviewers disagree, take it seriously: in this
repo the dissenting one has been right both times, once overturning a plan's central claim after
the other had approved it.
