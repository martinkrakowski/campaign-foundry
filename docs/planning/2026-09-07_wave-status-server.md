# The Wave Status Server — Architecture & Development Plan

**Date:** 2026-09-07
**Author:** orchestrator
**Status:** draft — for the owner's review
**Verified against:** `main` at `2341401`
**Decision ids introduced:** D102 – D106
**Relates to:** `.claude/skills/orchestrate-wave/SKILL.md` (the pipeline this observes),
`scripts/merge-prs.sh`, **#211** (a wave is finished when its record is committed)

---

## 0. What this plan answers

The owner asked for a local web application showing the exact status, logs and telemetry of each
lane and wave as the orchestrate-wave pipeline runs.

**The motivating incident, from this session.** Lane S2's log sat at **0 bytes for 43 minutes**
because `opencode` buffers its output. Establishing whether the lane was alive or dead took four
commands — log size, mtime, `EXIT` marker, and finally `pgrep` for the worktree path — and the log
alone was genuinely ambiguous, because a lane that dies at startup and a lane that is working
silently look identical. That question should cost a glance.

**The honest split between what is free and what is not.**

*Derivable today, with no change to how the pipeline runs:* per-lane log size, mtime, `EXIT` marker
and process liveness; per-PR number, branch and check conclusions (`gh --json`); gate exit codes and
coverage lines from the gate logs; wave and lane structure from the plan file.

*Not derivable:* findings fixed and refuted, mutation results, refutation reasons, which stage a lane
is actually in. **All of that currently exists only as orchestrator prose in a chat transcript.**
Making it telemetry means instrumenting the pipeline to emit a record per stage — and that
instrumentation, not the display, is the substance of this plan. A dashboard that only shows file
sizes is a `watch ls`; a dashboard that shows *"S4: remediation 2/5, 3 mutations confirmed, 1
refuted"* requires the orchestrator to say so in a machine-readable place.

**What this is not.** Not a product feature, not part of `apps/web`, and not on the user's dev
ports. It is a development tool for one operator on one machine.

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D102** | **It lives in `tools/wave-status/`, outside the `apps/*` and `packages/*` workspaces — but it IS in the test gate.** A new vitest project covers `tools/**`, and its pure modules are held to the repo's 100 % on all four counters. | Two failure modes to avoid. Putting it in `packages/` subjects a dev tool to the hexagonal layer rules (`domain`/`application`/`infrastructure`), which is a costume it does not fit. Leaving it outside the gate entirely means a tool nobody notices rotting — and this repo's whole character is that nothing untested ships. Outside the workspaces, inside the gate, is the honest middle. **Accepted cost, stated plainly: a broken dev tool will block a product PR.** That is the price of it staying alive, and if it proves annoying the answer is to fix the tool, not to exempt it. |
| **D103** | **The server never infers a stage it can be told.** The orchestrator appends one JSON object per stage event to `/tmp/wave-<id>/events.jsonl`; the server reads that file and merges it with what it can derive from the filesystem and `gh`. | This is the decision the plan turns on. Everything valuable — which stage a lane is in, how many findings were fixed versus refuted, whether a mutation actually bit — is knowledge the orchestrator has and the filesystem does not. Inferring it from log prose would be a parser guessing at English, which is exactly the class of thing that produces a confident wrong answer. **Where the two disagree, derived facts win and the UI shows both** — the same rule the pipeline already applies to lane self-reports. |
| **D104** | **No new runtime dependency.** `node:http`, `node:fs`, the `gh` and `git` CLIs already required, `tsx` (already a root devDependency), and a single hand-written HTML page with no framework and no build step. | `.agents/tech-stack.md` requires a stated reason for any new dependency, and there is none here: SSE is four lines of `node:http`, and the page is a table that polls. A build step for a dev tool means the tool needs building before it can tell you why your build failed. |
| **D105** | **Bind `127.0.0.1` on port `4317`, never `3000` or `3001`.** The port is configurable and the server refuses to start on 3000/3001 even if asked. | The owner's `next dev` and API run on 3000/3001, and the house rules already forbid touching them. A refusal in code is better than a rule in a document — the rule has been in `AGENTS.md` all along and the port is still worth guarding. `4317` was verified free. |
| **D106** | **The page is read-only. It starts nothing, kills nothing, and merges nothing.** | An observability tool that can act becomes a second control plane, and then the question "did the dashboard or the orchestrator do that?" has to be answerable. It does not. If a button would help, it belongs in the skill, not the window. |

---

## 1. Findings

#### **F1 · M · A silent lane is indistinguishable from a dead one**

`opencode` buffers, so an in-flight lane can show `0` bytes for 40+ minutes. The dispatch script's
own comment already records the mirror-image trap: *"a lane that dies at startup writes `EXIT`
immediately, so a marker-only wait returns at once and looks like success."* Both directions of that
ambiguity are resolved by one fact — **is the process alive?** — which nothing currently surfaces.

#### **F2 · M · Stage is the missing dimension, and it is the one that matters**

A lane passes through dispatch → implement → PR → gate → review → remediate → sweep → merge. The
filesystem shows only the first three. In this session the orchestrator ran **five** distinct
remediation rounds across two waves; none of that is visible anywhere except prose. **D103.**

#### **F3 · L · The data is spread across four places with no join key**

Lane logs in `/tmp/wave*/`, gate logs beside them, PR state in `gh`, and lane→wave structure in the
plan document. There is no identifier tying them together: `/tmp/waveS/s4.log` and PR #218 are the
same lane, and nothing says so. The event stream (D103) supplies the join key.

#### **F4 · L · `tools/` is outside every existing gate**

The workspaces are `apps/*` and `packages/*`; coverage covers `packages/*/src`,
`apps/api/{server,bin}` and `apps/web/src`. A new `tools/` directory is linted by nothing, typechecked
by nothing and covered by nothing unless the plan adds it — hence **D102**.

---

## 2. The recommendation

```
T1  the pure core   →  event log + derived facts → one WaveStatus object      (100% tested)
T2  the server      →  node:http, /api/status, /api/stream (SSE), /api/log    (thin)
T3  instrumentation →  the orchestrator emits events; the skill says when      (the substance)
```

**T1 before T2** — the server is a transport for T1's object and is uninteresting without it.
**T3 is independent of both** and is the half that makes the dashboard worth opening; it can land
first if the owner wants the record even before the window exists.

### 2.1 The shape of an event (D103)

One JSON object per line, appended, never rewritten:

```jsonc
{ "ts": "2026-09-07T16:55:43Z", "wave": "S", "lane": "s4", "stage": "remediate",
  "event": "settled", "pr": 218, "round": 1,
  "detail": { "fixed": 5, "refuted": 2, "mutations": 3, "mutationsBit": 3 } }
```

`stage` is the pipeline's own vocabulary — `dispatch`, `implement`, `gate`, `review`, `remediate`,
`sweep`, `merge`, `record`. `event` is `started` | `settled` | `failed`. Everything else is optional
detail. **Append-only, so a crashed orchestrator loses nothing already written.**

### 2.2 What the page shows

A row per lane, grouped by wave: **stage** (from events), **liveness** (`pgrep`), **log** (bytes,
mtime, `EXIT`), **PR** (number, checks), **gate** (exit + coverage), and **findings** (fixed /
refuted / mutations). Click a lane to tail its log. A banner when derived facts and reported events
disagree — *"lane says settled; no PR found"* — because that contradiction is the single most
valuable thing the pipeline has learned to look for.

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **T1** | **The pure core.** `readEvents(path)` parses the JSONL, tolerating a truncated final line (a crash mid-append must not blank the view). `deriveLane({ logPath, worktree, pr })` returns log bytes/mtime/`EXIT`, liveness, gate exit and coverage. `mergeStatus(events, derived)` produces one `WaveStatus`, **flagging disagreements rather than resolving them** (D103). All pure: filesystem and `gh` results are passed **in**, never read here — that is what makes 100 % coverage cheap and honest. Tests: a truncated last line; an `EXIT 1` with a body; a lane with events but no PR; a lane with a PR but no events; a disagreement. | `tools/wave-status/lib/*.ts`, its tests, `vitest.config.ts` (a `tools` project + coverage include) | The object everything else renders. |
| **T2** | **The server and the page.** `node:http` on `127.0.0.1:4317`, **refusing 3000/3001 by construction** (D105). `GET /` serves one hand-written HTML file; `GET /api/status` returns the `WaveStatus`; `GET /api/stream` is SSE pushing on change (`fs.watch` on the event log, plus a slow poll for `gh`); `GET /api/log/:wave/:lane?tail=N` returns the last N KB. Read-only — **no route mutates anything** (D106). The page is one table, no framework, no build step, and re-uses the repo's token names so it does not invent a second palette. | `tools/wave-status/server.ts`, `bin.ts`, `public/index.html`, their tests | The window. |
| **T3** | **Instrumentation — the half that matters.** A `waveEvent()` helper and a matching `scripts/wave-event.sh` so both the orchestrator and shell steps can append. `SKILL.md` gains the emission points: one event per stage transition, and the numbers the orchestrator already computes for its disposition comments (fixed, refuted, mutations run, mutations that bit). **The skill must say emitting is part of the stage, not a courtesy** — the same lesson as #211's wave record, which slid for three waves precisely because it was defined as a separate final step. | `tools/wave-status/lib/emit.ts`, `scripts/wave-event.sh`, `.claude/skills/orchestrate-wave/SKILL.md` | Every column worth looking at. |

**Order.** T3 ‖ T1 (disjoint), then T2. T3 alone is already worth having: it turns the pipeline's
prose into a durable record even with no server running.

---

## 4. Definition of Done

- `tools/**` is in the vitest gate at **100 % on all four counters**; the pure modules carry the
  logic and the `node:http` glue stays thin enough to test through `deriveLane`/`mergeStatus`.
- **A mutation per behavioural claim, confirmed to compile and run.** At minimum: truncate the last
  event line → the tolerance test fails; make `mergeStatus` prefer the reported stage over a
  contradicting derived fact → the disagreement test fails.
- The server **refuses to bind 3000 or 3001** — asserted, not documented.
- **No route mutates**; a test enumerates the routes and asserts the set.
- No new runtime dependency in any `package.json`.
- `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov`
  green, and **`lint:arch` unaffected** — `tools/` is outside `packages/*/src`, which the plan states
  rather than assumes.

---

## 5. Deferred

| What | Why |
|---|---|
| Publishing status to a page reachable from another device | A separate decision — it needs a push and a hosted surface; the local server cannot be reached from a phone. |
| Historical/cross-session telemetry | The event logs are per-wave under `/tmp` and vanish. Persisting them is worth doing *after* the format has settled. |
| Cost and token telemetry per lane | The CLIs do not report it in a form the pipeline captures today. |
| Any control action from the page | **D106.** |

---

## 6. Open questions

1. **Does `tools/` blocking a product PR turn out to be intolerable?** D102 accepts it deliberately.
   If it bites, the fix is a separate CI job, not an exemption.
2. **Should the event log live under `/tmp` or in the repo?** `/tmp` vanishes on reboot, which is
   fine for live watching and useless for auditing a finished arc. The deferred row above is the
   real answer; the plan starts in `/tmp` because that is where the logs already are.
3. **Is a table the right shape**, or does a wave want a timeline? A table answers "what is stuck";
   a timeline answers "where did the hours go". This plan builds the table.

---

## 7. What this plan does not pretend

The dashboard's value is bounded by T3. Without instrumentation it is a prettier `ls -l`, and the
temptation will be to ship T1 and T2 because they are self-contained and satisfying, then leave the
emission points for later — which is exactly how three waves' records went unwritten in this session
until the owner noticed. **T3 is the deliverable; T1 and T2 are its display.**
