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
- **The current seats are in `references/cast.md`, and it is the authority** — this file does not
  restate them, because it drifted once already: it named `agy gemini-3.8-flash-high` as the
  implementer long after the roster moved to `openrouter/qwen/qwen3.8-flash` primary with gemini as
  the reserve. Whatever the seat, **record the worktree tip first** and watch the provider's quota.
  Reviewers stay in-house: a second `Agent` that is **not** the implementer. There is **no lane
  launcher**: `scripts/dispatch-lane.sh` was deleted on 2026-09-17 because its detached launch killed
  the lanes it started (the mechanism is in the Implement stage, below). Launch every lane yourself
  and emit its event in the call immediately before — `scripts/wave-event.sh` is the emitter.

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
git -C "<worktree>" rev-list --count origin/main..HEAD                             # 0 ⇒ it wrote nothing
(cd "<worktree>" && yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov && yarn lint:bytes)
git -C "<worktree>" status --porcelain=v1 -b && git -C "<worktree>" diff --stat origin/main...HEAD
```

**Run the commit count first, and do not skip it because the seat said `SUCCESS`.** A seat's own
verdict is not evidence of work: on 2026-09-19 an agy lane reported `EXIT 0` *and*
`"status":"SUCCESS"` after six minutes and 643 k tokens, having made **zero commits** — it launched
the test suite as its first act and narrated waiting for it. `cast.md` carries the detail. Zero
commits is a stuck lane no matter how the run describes itself.
**The gate is a subset of CI, and the difference is named.** `ci.yml` runs **three** steps the seven
commands above do not. The first is the one that bites most quietly:

**`yarn install --immutable`.** The local gate never runs it, so a lane that adds a workspace
dependency passes every check locally and fails in CI on a stale lockfile — its green report is true
and useless. **Say in the brief whether a lane may add a dependency**, and if it may, that the
regenerated `yarn.lock` travels with it. The never-edit rule means *do not hand-edit* the lockfile,
not that a dependency can never be added; `.architecture/manifest.yaml` is where to check whether the
edge is already sanctioned before assuming it is not.

**`yarn lint:bytes`** is in the gate above rather than in this list, deliberately. It scans ~920
files for raw C0 control bytes in about 100 ms, and it exists because a raw `\x00` inside a string
literal once survived `build`, `typecheck`, `lint`, `format:check` and 6,103 tests — nothing else in
the gate set looks at bytes, and it was caught only because a mutation anchor stopped matching.
Unlike `install --immutable` it is cheap and runnable locally, so a lane should meet it before CI
does. **Note it is NOT inside `yarn typecheck`** — that chain type-checks the tool, it does not run
the scan; `yarn typecheck` on a tree containing a raw NUL exits 0, measured.

The other two: `check:env` (a conditional no-op here — no such script exists) and the
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

**Every lane brief ends with two lines, and they are not optional.** Both were earned:

- *If a finding is wrong, say so with the mechanism rather than changing code to match it.* Counters
  the failure that rots a suite quietly — an assertion weakened until it passes.
- *Run the gate in the foreground and read its exit code. A task you launched is not a result.* Two
  seats reported green gates they had started and never watched; one of those branches did not
  typecheck.

**Which gates are machinery, and which are you.** Know the difference before trusting the green:

| Gate | Enforced by |
|---|---|
| `yarn plan:verify` | **CI.** A lane dispatched against a closed gap fails the build. |
| a lane retiring its own premise | **CI**, as a consequence of the above: a shipped lane that leaves its fence behind fails its own PR. |
| `yarn mutate:verify` on a **changed** manifest | **CI** (`scripts/verify-manifests.sh`). |
| **a manifest existing at all** | **you.** Nothing can require one without punishing the docs PR, the refactor and the premise audit that legitimately have none. It is a line in every lane brief, and it stops being applied the moment an orchestrator forgets to write it. |
| `yarn handoff:check` | **you**, when you set up a two-stage lane. |

The two in the last rows are habits, not gates. Say so when you hand this over.

**A two-stage lane hands over a handoff file, not a claim.** Stage 1 writes
`.agents/handoff/<lane>.json` binding every rule in its brief to the test that pins it, and
`yarn handoff:check` refuses the handoff unless **every rule names a test that exists and is
currently failing**. A missing rule caps the implementation at stage 1's completeness and leaves no
trace in coverage; a test that already passes pins nothing, because stage 2 can satisfy it by
changing nothing. Both have happened: one stage-1 author wrote twelve tests for eight states, missed
three conditions from its own brief, and the lane shipped reporting a failing PR as `merged` at
100 % coverage.

**And every lane brief opens by asking the lane to prove the defect before changing anything:**

> Restate the defect in your own words and demonstrate it — the failing test, the wrong output, the
> command that misbehaves. If you cannot reproduce it, **stop and report that**. Do not implement
> against a defect you have not seen.

This exists because the orchestrator's briefs are wrong often enough to matter: a brief this week
described a client-side sort as absent when it had shipped, and the only seat that found the real
defect was the one that went and looked before writing code. A lane that cannot reproduce the defect
has found something more valuable than the fix — and the alternative is a lane that implements the
brief's mistake faithfully, which costs the full cycle and passes review.

**Every cell of your final table is command output, not recollection.** If you cannot produce the
output for a cell, the cell is *unknown* — a valid answer. A confident wrong one is not.

## Before you dispatch

1. **Verify main is green** and the tree is clean. Fast-forward local main.
2. **Give the subagent what it cannot infer.** It inherits none of this conversation, so its
   prompt must carry the **absolute worktree path**, the branch, whether a PR already exists, and
   the house rules below. A brief that assumes context the agent does not have is the
   equivalent of an unfunded seat: a whole cycle, nothing to show.
3. **Prove each seat with a trivial DISPATCH, not a chat probe — and give a failing seat one
   attempt per wave.** A one-word probe measures the wrong thing. On 2026-09-16 `opencode`'s
   `big-pickle` and `qwen3.8-flash` both answered `ready` and then wrote **0 bytes with no process**
   on a real lane; `qwen3-coder` errored outright. Three failures, three model ids, one broken run
   path — while `agy` (a different binary) ran first time, which is what located the fault. A probe
   that passes and a dispatch that dies look identical until you spend a cycle.

   So: prove a seat by asking it to edit a scratch file in the lane worktree and exit, then check
   the file changed — **and delete it before dispatching the lane, verifying the tree is clean
   again.** A probe artefact left behind is worse than no probe: `git status --porcelain` in that
   worktree is what the next step reads to derive lane status, so an untracked scratch file reads as
   lane activity, and a lane that later stages with a broad pattern can commit it. Found by two
   reviewers independently on the PR that introduced this rule. And when a seat fails a real dispatch, **switch rather than debug** — one
   attempt per wave. Two extra cycles were spent on 2026-09-16 rediscovering a rule written after
   the first failure.

4. **Confirm the cast, the lanes and their file ownership** with the owner, and wait for the
   go-ahead. If the plan does not assign file ownership per lane, say so — that is a plan defect
   and the lanes will collide.
5. **Red-team each lane brief against the code before dispatching it.** Every path, symbol and line
   number a brief cites must exist; every acceptance criterion must be able to fail. This step has
   caught false premises that would have stalled a lane at its mandatory mutation check.
6. **Red-team each brief against ITSELF for completeness.** Step 4 checks that what a brief cites
   exists. This step checks that what it *omits* was a decision. **A lane implements the brief's
   enumeration, not its adjective** — "in full", "the whole surface", "all the relevant fields"
   carry no information the implementer can act on, and they actively suppress the question,
   because a lane that sees a list assumes the list was checked.

   Before dispatch, for every brief:
   - **If it names a type or a document surface, open that type and paste its fields in.** A brief
     covering `CopyTimeline` names five things, because `CopyBeat` is `{text, weight, background?}`
     and `CopyTimeline` is `{beats, transition, keyBeat}`.
   - **Write one test requirement per field**, so a missed field fails a test instead of shipping.
   - **If a value is parsed from a string, name the hazards**: leading zeros, values past
     `Number.MAX_SAFE_INTEGER`, delimiters that can appear in the data.
   - **If the lane compares or gates on state, list the inputs and their refresh cadence.** Two
     sides collected at different times need a carve-out, not a threshold.

   Four defects on 2026-09-16 came from briefs that failed exactly this, and in every case the lane
   implemented what was written:
   - X33's copy hash was told to cover "`copy.timeline` **in full**" against a list naming two of
     its five fields — `beat.weight`, `transition` and `keyBeat` were omitted, each of which
     changes what renders. Found by a bot as a High.
   - X33's test list omitted `localizedMessage`, so the 100%-branch gate failed on the untaken arm
     of a conditional spread — a field the hash *did* cover but nothing proved reached it.
   - The template-routes brief named no precision hazard, so a version past the safe-integer range
     could resolve to a **different stored version than the caller pinned**.
   - X38 was briefed as "a past-wave lane is not counted as needing a human" — true as a sentence,
     wrong as a rule, because age came only from log and event timestamps while liveness and PR
     checks were live-probed. Two fact sets, different ages, no carve-out.

   The tell is an adjective standing where a list belongs. When you write one, stop and enumerate.

7. **Check each lane id against every plan, not just this one.** `grep -rn '\*\*<ID>\*\*'
   docs/planning/` — one command. Ids are the join key for the session-log citation, the plan's
   shipped note, `.agents/manifests/<lane>.json`, the status-page row and the premise fence's own
   name, so a collision silently merges two lanes' histories. It has happened twice: `L10`/`L11`
   between two plans (studio plan's C2) and `TL1` for both the template routes and the timeline
   playhead (gap ledger §42). Arc-prefixed ids (`L7a2`, `CC5`, `SE3`) have never collided; bare
   sequential ones have.
8. **Check the plan's premises first.** `yarn plan:verify` fails when a lane's stated gap has already
   been closed. Four lanes in one week were dispatched, or nearly dispatched, to re-implement shipped
   behaviour. A lane whose premise no longer holds is not a lane.
9. **Every fence you write must be TIMED and shown to decide, before it lands.** `plan:verify`
   kills a premise at **10 seconds** and reports `TIMED-OUT — not stale, make the premise decide
   quickly`. A premise with no verdict protects nothing: it neither holds nor flips, it just turns
   the gate red for a reason unrelated to the lane. So for each fence, run it, record the wall time
   in a comment beside it, and keep it in **milliseconds** — a fence is a probe, not a scan.
   Verify three things, not one: that it **holds today** (the gap is open), that it **can flip**
   (construct the closed state and watch it change), and that it **answers fast**.

   Three fences failed this way on 2026-09-16, each differently, and the pattern is worth knowing:
   - **Too slow.** SE2 flattened a 100 kB file with `tr` and ran `.{0,700}` against the single
     resulting line — catastrophic backtracking, killed at 10s. Bounded to the function body with
     `sed -n '/^function name/,/^}/p'`, it answered in ~7 ms.
   - **Too narrow.** X1 asked whether a Prettier config existed — half of its own section's title,
     and the half that closes first. It went STALE on the config-only commit while 400 files were
     still unformatted, which would have forced a 400-file single commit.
   - **Too slow again, from the opposite direction.** X1's replacement ran `prettier --check` over
     679 files: 4.8s locally, TIMED-OUT on the runner. Local timing is not the test; the runner is
     slower and contended.

   Prefer a probe over a scan: grep one file for the marker that means the lane is done, rather
   than recomputing the lane's whole subject. If the honest completion marker is a gate step, grep
   the workflow for it — a lane that wires a gate cannot land without satisfying that gate, so the
   marker cannot be forged.

10. **Send the plan to the plan reviewer** (`Agent` · `subagent_type: "Plan"` · `model: "fable"`)
   **before dispatching any lane from it**, whenever the plan *introduces or rewrites lanes* or
   *changes a premise*. It is read-only by construction, so it returns a review and cannot patch
   around what it finds. On its first use it caught a rule in an **already-dispatched** brief that
   contradicted both the plan and the code — `restT` per track, where `REST_T` is per motion kind —
   which the lane would otherwise have pinned in a test. The lane was stopped with nothing committed.
   Nothing else needs this seat; it is not a review gate on prose.

## The six stages

*Emitting is part of the stage, not a courtesy.* Every transition below appends one event via
`scripts/wave-event.sh <logdir> <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']`
— one JSON line in `<logdir>/events.jsonl` — and a stage with no event is, to the server, a stage
that did not happen.

1. **Implement.** One lane = one worktree = one branch = one PR. `yarn install` per worktree
   yourself — **one at a time, never in parallel, and only where the lane actually needs one.**

   Yarn Berry hardlinks package contents from a shared global cache. Concurrent installs across
   worktrees can evict or relink an entry while another checkout is holding it, and the victim is the
   checkout nobody is installing into: the **main checkout**, which silently loses a native binary
   while keeping the package directory. Twice on 2026-09-17 this broke the owner's `yarn dev` —
   `@next/swc-darwin-arm64` and then `@napi-rs/canvas-darwin-arm64`, each left with its
   `package.json` and `README.md` intact and its `.node` file gone. Platform-specific optional
   dependencies are what break, because they are the large binaries.

   So: serialise installs; skip them **only for a lane that runs no local command needing
   dependencies** — which in practice means a docs-only lane and very little else. **A deletion lane
   is not one of them**: W1 deletes a test file, and proving the *remaining* suite still passes is
   exactly the command that needs `node_modules`. (I skipped `cf-w1`'s install on the strength of the
   first draft of this rule; review caught it before the lane ran.) And
   **after a wave's installs, verify the main checkout still has its native binaries** rather than
   letting the owner's next dev start find out:

   ```sh
   # Names any platform package left with metadata only, and is silent when healthy.
   #
   # `find node_modules -name '*.node' | head` is NOT a check: a stripped package simply
   # contributes no line, so the command prints the survivors and exits 0 — it reports what
   # exists, never what is missing. Nor is "has a .node file" the test: @esbuild ships
   # `bin/esbuild`, @img/sharp-libvips ships `lib/`, and both are healthy with no .node at
   # all. The payload test below has neither false negative nor false positive on this repo.
   for d in node_modules/@*/*darwin*/ node_modules/*darwin*/; do
     [ -d "$d" ] || continue
     n=$(find "$d" -type f ! -name '*.json' ! -name '*.md' ! -name 'LICENSE*' | wc -l)
     [ "$n" -eq 0 ] && echo "STRIPPED: $d"
   done
   ```

   Run on 2026-09-17 it found **two more** beyond the two that had already broken `yarn dev`:
   `@turbo/darwin-arm64` — which is why that day's dev run opened with *"Turborepo did not find the
   correct binary for your platform"* and repaired itself — and `@rolldown/binding-darwin-arm64`,
   which nothing had asked for yet and would have failed later, with no obvious cause.

   The repair is to delete the stripped package directory and reinstall — a plain `yarn install` will
   not restore it, because the directory's presence makes the package look installed.

   Write each brief from Template A, then dispatch it as an `Agent`. **Record the worktree tip
   first** — an agent that reports success having committed nothing looks identical to one that did
   the work. Never let two lanes own the same file at the same time.

   **A lane is not done until the PR exists, and lanes routinely stop one step short.** On
   2026-09-16, CC1 and CC6 each committed clean, verified work and never pushed or opened a PR, and
   CC1 paused four separate times mid-`mutate:verify` waiting on its own background job. Write
   "commit, push, and open the PR with `gh pr create`" as the explicit final instruction in every
   brief — and when a lane stops anyway, **finish it mechanically yourself** after verifying the
   diff. That is a legitimate orchestrator action, not a fix the lane owes you; what is not
   legitimate is reporting the lane done because it said so.
   Emit the event in the tool call **immediately before** the launch, with nothing between them —
   never afterwards, and never "as you go", which is what an orchestrator reads and skips. It cannot
   literally be the same call on the primary path: an `Agent` dispatch and a Bash call to
   `scripts/wave-event.sh` are different tools by construction, so a rule demanding one call is
   unfollowable, and an unfollowable rule teaches that rules are optional. The property that matters
   is that **no lane is ever launched without its event already written**; the adjacency is how you
   get there. **There is no launcher that emits for you, and there will not be one.** A script that
   emitted and launched in one call existed until 2026-09-17 and was deleted: it killed every lane it
   started on 2026-09-13, and again on 2026-09-16, when both lanes dispatched through it wrote 0 bytes
   with no process while every directly-launched lane that day worked. **The mechanism, so nobody
   rebuilds it:** `nohup` only ignores `SIGHUP` and `disown` only drops the shell's job-table entry —
   neither calls `setpgid`, so a lane launched that way stays in the **caller's process group**. A
   launcher that then *waits* holds the tool call open past its timeout, and the harness signals the
   whole group, taking the lanes with it. A direct `nohup … & disown` survives precisely because the
   tool call **returns immediately** and a finished call is never group-killed. Atomicity bought this
   way costs the lane; adjacency from a direct launch is the supported shape.

   Emission is therefore yours. On 2026-09-16 four of five lanes ran through the `Agent` tool or a
   direct CLI and nobody emitted for them, so the wave-status page showed **one event for the whole
   wave** and 30+ events had to be backfilled afterwards with a note that their timestamps were
   recording times, not event times. A stage with no event did not happen, and a backfilled one
   cannot be trusted for timing.

   Emit as you go (`scripts/wave-event.sh`): `dispatch started` per lane just before its launch,
   carrying the seat that runs it in `--detail` — `--detail '{"seat":"<implementer model>"}'` — because
   the status page names the seat that ran each lane, and a lane whose record never names one reads
   **unknown**. The seat is a property of the lane, so later stages need not repeat it.
   **When the seat is an external CLI** (the `openrouter/` roster in `references/cast.md`), launch it
   directly from a tool call — `nohup zsh -c "cd <worktree> && <cli> … \"\$(cat <ABSOLUTE brief>)\" >
   <log> 2>&1; echo \"EXIT \$?\" >> <log>" < /dev/null > /dev/null 2>&1 & disown` — from a tool call
   that returns straight away, never from a wrapper that launches and then waits (see above). The
   brief path **must be absolute**: the command `cd`s into the worktree first and `briefs/` exists only
   in the main checkout. The template assumes paths without spaces or glob characters, true of this
   repo's worktrees; quote them for the inner shell if that ever changes. Liveness differs by CLI:
   `opencode run --format json` streams within seconds, so a log still at 0 bytes after ~30 s **with no
   `opencode run` process for that worktree** (`pgrep -f 'cd <worktree> && opencode'`) is a dead lane;
   `agy --print` writes nothing until it exits, so watch its process and the worktree's commits. Never
   call a lane dead from the log alone.
   **Every brief carries the checkpoint rule**: commit the failing tests locally the moment they have
   been seen to fail, commit again after each green step, push only when the gate passes. On
   2026-09-13 provider failures (one 522, six 429s) killed seven lane runs. The two that had written
   nothing to disk lost the whole run; every other one resumed from what it had committed — or, once,
   from uncommitted files that happened to survive in the worktree, which is luck, not a method.
   **This is a scoped exception to `.agents/testing.md` ("a red suite blocks the commit"), confirmed by
   the owner on 2026-09-14,** and it covers checkpoint commits on a lane's own branch only. The branch is
   pushed only when the gate passes on its head, so no pushed head and no CI run is red; the red
   checkpoints do travel to the lane branch on `origin` as history, and never reach `main`, because PRs
   squash-merge. Do not rewrite history to hide them — that is the destructive step checkpoints prevent.
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
   reasons. **After any interrupted or killed `mutate:verify`, scan for a stranded mutation before
   anything commits**: a mutation applies a change to the source and restores it at the end, so a
   run that dies in the middle leaves the source mutated and the next commit ships it. The check is
   five lines — for each manifest entry, assert its `before` text is present and its `after` text is
   not. It ran four times on 2026-09-16 (0 stranded each time) and is cheap enough to be
   unconditional; a killed verification is the one moment the working tree can be silently wrong.

   Run the remediator in that worktree, then **verify it yourself**: full gate, re-read the
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
   **A green gate is not a merge condition on its own.** Merge only when, on the PR's *final* head:
   every check-run conclusion is success, skipped or neutral (read conclusions, not the rollup line —
   `neutral` is what informational checks report); the review bots have had time to post on that head;
   and **zero review threads are unresolved**. **`scripts/merge-prs.sh` enforces this**: once the
   required check has concluded green on the head it pushed, it waits a bounded settle period for the
   review bots (`REVIEW_SETTLE_SECONDS`, default 120, refused unless a whole number), then refuses to merge
   while any review thread is unresolved
   — naming each open thread's first-comment author and an excerpt — and re-reads the PR's head
   immediately before `gh pr merge`, refusing if it is no longer the SHA whose checks were read. The
   decision itself lives in TypeScript (`tools/sweep`, `yarn sweep gate --pr <n> --sha <sha>`), because
   it has to be tested and the runners have no zsh; the script is only its caller. A page of threads
   that could not be read is "could not decide" and refuses — never a silent zero (X13).
   **The settle period is a wait, not a proof that the bots reviewed the final head.** Only bots that
   re-run on push (Qodo, CodeRabbit) can post on a refreshed head; the PR-Agent workflows trigger on
   `opened`/`reopened`/`ready_for_review` only, and nothing checks that any bot ran. The script enforces
   two things — no unresolved threads and an unchanged head — and a PR whose final head deserves a bot's
   eyes still needs you to confirm the bot posted on it.
   On 2026-09-13 a merge gated on CI alone raced the bots — nothing was missed that time, but only by
   luck — and the full condition later held back a PR whose final-head review found a real defect
   the gate could not see.
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

- **Never spawn a funded model seat to reproduce a defect.** `opencode run`, `agy`, `grok` and the
  rest bill the owner. On 2026-09-17 lane W1 demonstrated the launcher's process-group kill by
  launching one real `opencode run` against the owner's account — about four seconds of a paid seat,
  disclosed unprompted, for a fact a stub would have shown just as well. The dispatch mechanics being
  probed (does the child survive a group signal?) are a property of `setpgid`, `nohup` and `disown`,
  not of any model: `sleep 60` reproduces them exactly. The existing rules named the owner's dev
  servers and their GenAI credits and did not name this, so write it into every brief: **reproduce
  dispatch and launcher behaviour with a stub process, never a paid CLI.** A seat is for doing the
  lane's work, not for demonstrating that a launcher kills it.

- **Touching a manifest arms it.** CI replays only the manifests a change *touches* — the
  **`Replay changed mutation manifests`** step in `ci.yml`, which runs `scripts/verify-manifests.sh`
  against `MANIFEST_DIFF_BASE` (named, not cited by line: a line number in a rule about anchors
  rotting is the joke writing itself) — so editing one for an unrelated reason pulls it into the replay set and every
  anchor in it must then resolve. On 2026-09-17 lane TS1 re-anchored two entries in `cc1.json` and
  turned its third — stale since X1's formatter run — into a red gate.

  **The corollary used to be worse than the inconvenience, and was fixed on 2026-09-18.** A manifest
  nobody touched was never checked again, so its evidence rotted in silence: a full audit found
  **57 dead anchors across 34 of 93 manifests — 12% of all 468 mutation claims**, three manifests
  dead outright. (An earlier partial count said 45 across 29; the measured figure is 57.) Repairing
  them exposed **three mutations recorded `caught` that actually survived** — one live on `main` the
  whole time, invisible because a dead sibling made its manifest refuse to replay at all.

  **`yarn mutate:anchors` now checks every anchor in every manifest** — a string count, no build, no
  tests, all 94 in under a second — and runs ahead of the replay in `verify-manifests.sh`, so a dead
  anchor costs one second instead of twenty minutes. Anchors no longer rot in silence. **The replay
  is still diff-scoped**, so the rest of this rule stands: touching a manifest still arms its full
  replay.

  **The same check now asks the second question, added 2026-09-18: does the `command`'s `-t` still
  select a test?** `vitest -t` is a REGEX, and a pattern that matches nothing skips every test and
  **exits 0**, which `mutate:verify` reads as `survived`. That is worse than a dead anchor — a dead
  anchor refuses, this one answers, confidently and wrongly. It did so twice: a title's `(X30)`
  pasted into the pattern, where the parentheses are a capture group and not two literal characters
  (182 tests skipped, exit 0, "survived"), and three `sg4` entries after SG10 renamed the test they
  name. The check proves a pattern live from the test file's syntax where it can (no spawn) and
  escalates the rest — a `test.each` title formatted per case, a title that is an expression — to
  `vitest list`, so it condemns nothing it has not seen vitest refuse. Cost on 2026-09-18: 212
  patterns, 207 proved by syntax, 5 listed, ~8s all in. **When you write a `-t`, verify it selects
  before you record it** (`yarn vitest list <file> -t '<pattern>'` prints the tests it picks, or
  nothing), and escape the metacharacters in a title you are copying.

  A mutation whose subject was *deleted* can carry **`"retired": "<why>"`** with a required reason,
  skipped by both the check and the replay. Retiring is a claim: an unexplained one is
  indistinguishable from abandoning a test that was catching something, and retiring a mutation that
  *survives* is `verdict: "survived"` with a coat of paint. Re-anchor when the code moved; retire
  only when it is gone.

- **Before `git reset --hard`, save the diff.** `git diff > /tmp/<name>.patch` (and
  `git diff --cached` if anything is staged) first. A hard reset silently destroys uncommitted work,
  and the moment it costs most is the one where you are resetting *because* something went wrong —
  which is exactly when the work you are discarding was the fix. It cost a hardened script here that
  had to be written twice. **Commit before you test, not after**, for the same reason.


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
