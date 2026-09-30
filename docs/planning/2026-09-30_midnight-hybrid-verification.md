# Midnight Hybrid Verification — Architecture & Development Plan

**Date:** 2026-09-30
**Status:** **r2 — Fable plan review folded (3 blockers, 11 fixes, 7 notes). D187–D189 STAMPED (owner, 2026-09-30: "stamp D187–D189").** **r3:** Fable's pre-dispatch re-check folded (3 fixes, 5 notes). It corrected D187's listing command, so D187 needed a re-stamp. **r4:** Fable's brief review corrected the slot-name rule (F2) and MH2's second-signal recipe (F1), so D188 also needed one. **D187 and D188 RE-STAMPED (owner, 2026-09-30: "re-stamp D187 and D188"), over the r4 text Fable cleared.** r1's CI split (MH3) is DROPPED under the owner's principle below.
**Decision ids introduced:** D187 – D189
**Lane ids introduced:** MH1, MH2 (`grep -rniwE 'MH[0-9]+'` and D187–D189: no collisions). MH3 is withdrawn.
**Relates to:**
- `2026-09-29_test-postgres-harness.md` §5: the midnight acceptance run, and the "hybrid" verdict;
- `2026-09-29_wave-hardening-and-w05-follow-ups.md`: D183, and HX3/HX3b's lock.

---

## 0. What this plan answers

**The owner's principle, 2026-09-30:** "GitHub CI is the single source of truth for everyone, and midnight is your private workshop." Future contributors will never get midnight access. **A self-hosted runner would run their PR code on midnight,** so midnight must never be a CI path.

Within that principle, this plan makes midnight a better workshop for the owner's own lanes:
- **MH1:** a local **gate profile** that runs everything except the declared host-sensitive tests, selected by vitest tags. It gives a fast, meaningful pre-push signal on midnight.
- **MH2:** a **per-host gate-lock semaphore**, so midnight's 24 cores can run 2–3 gates at once.

Both default to today's behaviour: no profile, one slot. Nothing contributor-facing depends on midnight.

---

## 0.1 Proposed decisions

| id | Decision |
|---|---|
| **D187** | **STAMPED — Owner, 2026-09-30.** **Host-sensitive tests are declared with vitest TAGS, and a local gate profile may filter them out.**<br>- `vitest.config.ts` declares `test.tags: [{ name: "golden-bytes", description: "<host facts>" }, { name: "cpu-bound", description: "<host facts>" }]`.<br>- The affected `describe`/`test` carries `{ tags: [...] }`. Tags are per TEST, not per file, because `routes.test.ts` has 76 tests and only 2 are CPU-bound.<br>- `yarn gate --profile midnight` filters with `--tagsFilter '!golden-bytes && !cpu-bound'` and prints the excluded tests (from `yarn vitest list --tagsFilter 'golden-bytes || cpu-bound'`; `--listTags` lists only the tag declarations).<br>- The default gate (no profile) filters nothing.<br>- A profiled run enforces NO coverage thresholds. GitHub CI enforces 100% on the full run. |
| **D188** | **STAMPED — Owner, 2026-09-30.** **The gate lock is a per-host semaphore of `CF_GATE_SLOTS` slots** (default 1, today's behaviour):<br>- slot 0 stays `cf-gate.lock` (unsuffixed, byte-identical at SLOTS=1); slots 1..N-1 are `cf-gate.lock.<n>`. **A slot's suffix is digits only** (reject `''|*[!0-9]*`), so no slot's own transients (`cf-gate.lock.1.cand.<pid>`) can read as a slot;<br>- every subcommand finds the caller's slot by scanning;<br>- **`CF_GATE_SLOTS` is set HOST-WIDE** (never per seat), because a SLOTS=1 acquirer would take slot 0 while other slots are busy;<br>- **one gate per worktree,** because `verify-manifests` mutates the tree and the lock is per host, not per checkout. |
| **D189** | **STAMPED — Owner, 2026-09-30.** **Midnight is never a CI path.**<br>- The complete CI (today's `ci` job plus TP1's server step, `ci.yml:42-275`) stays on GitHub-hosted runners, unchanged, and remains the only required check (`merge-prs.sh:68` `^Build`, unchanged).<br>- No self-hosted runner is registered for this repository.<br>- **If CI speed ever becomes the goal,** the path is `vitest --shard` across hosted jobs, with `--reporter=blob` and `vitest --merge-reports --coverage` (natively supported; thresholds apply on the merged map). There is no runner and no security surface. That would be its own plan. |

---

## 1. Verified findings

| id | Severity | Finding | Evidence |
|---|---|---|---|
| **M1** | Medium | **Midnight's full gate fails only on a hardware-bound set: 10 tests in 9 files.**<br>- **Goldens** (mismatches): `CanvasFfmpegVideoCompositor.byte-golden`, `CanvasFfmpegVideoCompositor.audio-golden`, `NodeCanvasCompositor.motion-goldens`, `NodeCanvasCompositor.text-effect-goldens` (`packages/CreativeGeneration/src/infrastructure/adapters/__tests__/`).<br>- **Timeouts at vitest's 5,000 ms default:** `apps/api/bin/__tests__/generate.test.ts`, `apps/api/server/lib/__tests__/pipeline.test.ts`, `apps/api/server/routes/__tests__/routes.test.ts` (2 of its 76 tests), `…/campaigns/__tests__/capability-race.test.ts`, `…/generate-report-conflict.test.ts`.<br>None of the timed-out files sets an explicit timeout, so a longer PROFILE timeout may keep them running (MH1 measures it). | harness plan §5; grep |
| **M2** | Medium | **One gate per host is the Mac's constraint, not midnight's.** The single `mkdir` lock at `${TMPDIR:-/tmp}/cf-gate.lock` (`gate-lock.sh:90`, `gate.sh:222`) serializes midnight's 24 cores to one gate. | code |
| **H1** | High | **Any midnight job that makes a check-run on a PR head would block merges.** `scripts/merge-prs.sh:238-249` counts EVERY check-run as pending and rejects any failure, so even an "optional" self-hosted job becomes de facto required. Combined with the owner's principle, that is why D189 registers no runner. | `scripts/merge-prs.sh:238-249` (Fable) |

---

## 2. Lanes (wave `midnight-hybrid-w01`)

Every lane inherits the pipeline and skill rules. The seat is **space-bunny**. MH2 is **high** risk: every seat depends on the lock, so it gets a Fable pre-PR review.

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **MH1-gate-profiles** | normal | **D187.** Enumerated:<br>(0) **Measure first.** On midnight, run the 6 CPU-bound tests with `--testTimeout 20000` and record their times. Tag `cpu-bound` ONLY on tests that still fail. A profile-scoped timeout weakens nothing on the Mac or CI. Use the profile's `--testTimeout`, never a tag-level `timeout`: a `TestTagDefinition` may carry one, and it would apply on CI too.<br>(1) **Declare** the `golden-bytes` and `cpu-bound` tags in `vitest.config.ts` `test.tags`, with the host facts as descriptions.<br>- Before tagging, check that `describe(name, { tags }, fn)` type-checks, and that root `test.tags` reaches the `extends: true` projects (`yarn vitest --listTags` once). Also verify once that `vitest list --tagsFilter` honours the filter. It is applied in `interpretTaskModes`, so tests may be listed as skipped rather than hidden; if so, use `--json` and filter on the mode.<br>- Tag the 4 golden tests and whatever (0) leaves failing.<br>(2) **`yarn gate --profile <name>`:** profiles are defined in `scripts/gate.sh` (`midnight` = `!golden-bytes && !cpu-bound`, plus `--testTimeout 20000` if (0) needed it).<br>- Under a profile, the test step is `yarn vitest run --tagsFilter '<expr>' [--testTimeout N]` with **no `--coverage`**, and it prints "coverage thresholds are not enforced under a profile; GitHub CI enforces 100% on the full run", plus the excluded tests (from `vitest list --tagsFilter 'golden-bytes || cpu-bound'`).<br>- An unknown profile gives exit 2.<br>- No profile means today's command, byte for byte.<br>(3) **`yarn gate --print-steps [--profile x]`** (new: `gate.sh:115-128` accepts only `--lane` today) prints the resolved step commands and exits 0.<br>**Tests:**<br>- no profile means today's steps (snapshot);<br>- the midnight profile uses the tags filter and no coverage;<br>- an unknown profile → 2;<br>- `--print-steps` output;<br>- the tag declarations exist, and every tagged test has a declared tag (vitest's `strictTags` defaults to true; the test pins that no config turns it off).<br>**Acceptance:** on midnight, `TEST_PG_URL=… TEST_DATABASE_URL=… yarn gate --profile midnight` passes 13/13. Record its wall time.<br>(4) **The required check still matches CI:** `tools/gate/__tests__/required-check.test.ts` reads `scripts/merge-prs.sh`'s `REQUIRED_CHECK` default (`:68`, `^Build`) and the `ci` job's `name:` in `.github/workflows/ci.yml` (`:43`), and asserts the pattern matches the name. | `vitest.config.ts` (the `test.tags` block only), the tag annotations on the listed tests, `scripts/gate.sh` (profile and `--print-steps`), `tools/gate/__tests__/gate.test.ts` (exclusively), `tools/gate/__tests__/required-check.test.ts`, `.agents/manifests/mh1-gate-profiles.json` | change the default gate; tag a test without measuring; change coverage thresholds or include/exclude |
| **MH2-gate-lock-slots** | **high** | **D188.** Enumerated:<br>(1) `CF_GATE_SLOTS`: an integer ≥ 1, default 1, validated like `CF_GATE_STALE_SECONDS`.<br>(2) **Slots:**<br>- slot 0 = `cf-gate.lock` (unsuffixed); slots 1..N-1 = `cf-gate.lock.<n>`;<br>- `acquire`/`run` try slots in order, with the pass counter (`:268`) per slot;<br>- `release`, `verify`, `heartbeat` (pid-only today, `:644-653`) and `lock_is_ours` (`:564-614`) find the caller's slot by scanning for owner and pid;<br>- **slots are exactly `cf-gate.lock` and `cf-gate.lock.<digits>`, with a digits-only suffix (reject `''|*[!0-9]*`).** A `[0-9]*` glob would also match `cf-gate.lock.1.cand.<pid>`. The transients `.cand.<pid>` (`:148`) and `.reclaim.<pid>.<x>` (`:192`) are never slots, and each slot's candidate and aside names derive from that slot's own path;<br>- `status` (`:616`) lists EVERY existing slot, whatever the caller's `CF_GATE_SLOTS`.<br>Every HX3/HX3b guarantee holds per slot: per-pid liveness, stale reclaim via `take_stale` on the judged slot, the atomic beat, signal forwarding, and `run`'s verify (`:553`).<br>(3) **Docs:** `CF_GATE_SLOTS` is set host-wide (e.g. `/etc/environment` on midnight), never per seat; one gate per worktree.<br>(4) **Carry-over, in scope:** the `run_cleanup` second-signal fix. Put `trap - EXIT; trap '' INT TERM` first after `status=$?` in `run_cleanup` (`gate-lock.sh:369-370`), and apply the SAME pattern to `gate.sh:233`'s `cleanup`. With slots, `gate.sh:222`'s release message names the caller's slot, not the fixed `cf-gate.lock`. This closes the Fable-reported gap where a second TERM during cleanup kills the shell before release.<br>**Tests** (on `sh` and `dash`):<br>- with SLOTS=1, every existing test passes unchanged (41 path references stay valid);<br>- with SLOTS=3, three concurrent `run`s hold three slots and a fourth gets 75;<br>- a dead holder's slot is reclaimed without touching the others;<br>- `status` lists all slots;<br>- release, verify and heartbeat act on the caller's own slot only;<br>- the second signal. **For `run`:** extend `gate-lock.test.ts:1006` (`CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV`) with a second TERM after 0.5 s → released. **For `gate.sh`** (its heartbeat has TERM at default, `gate.sh:256`, so parking it widens nothing): add a test hook `CF_GATE_TEST_PAUSE_BEFORE_RELEASE` in `gate-lock.sh`'s `release`, after the owner/pid check and before `rm -rf`. In `gate-signals.test.ts`, TERM during a `sleep 1` step, then TERM again at the marker; assert exit 143 AND stdout `gate: lock released, heartbeat stopped`. Lock absence alone is not proof, because the parked release child outlives its parent. | `scripts/gate-lock.sh`, `scripts/gate.sh` (slot passthrough and `cleanup` traps), `tools/gate/__tests__/gate-lock.test.ts`, a NEW `tools/gate/__tests__/gate-signals.test.ts` (gate.sh's second-signal case; `gate.test.ts` belongs to MH1), `.agents/manifests/mh2-gate-lock-slots.json`, the Template A note | change SLOTS=1 LOCKING behaviour; weaken any HX3/HX3b guarantee |

**Order:** MH1 and MH2 in parallel. They touch `scripts/gate.sh` in different hunks: MH1 the arg loop `:115-128`, the step list `:157-173` and `run_test_cov` `:297`; MH2 the release message `:222` and `cleanup` `:231-240`. They share no test file. The second to merge rebases through `merge-prs`.

---

## 3. Owner actions

1. **DONE 2026-09-30: D187–D189 stamped.**
2. **After MH2 merges:** set `CF_GATE_SLOTS=3` host-wide on midnight (`/etc/environment`, which needs sudo) and on the opencode service's environment drop-in.

## 4. Definition of done

- D187–D189 are stamped, and MH1 and MH2 are merged with their mutations caught.
- `yarn gate --profile midnight` passes 13/13 on midnight, with its wall time recorded.
- Three concurrent gates run on midnight without interference, demonstrated once.
- `ci.yml` and `REQUIRED_CHECK` are unchanged; a test asserts that `^Build` still matches the CI job name (MH1 (4), `required-check.test.ts`).

---

## 5. Follow-up lanes, split out of MH2 (proposed; not yet reviewed or scheduled)

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **MH4-one-gate-per-worktree** | **high** | **Qodo #2 on PR #636** (thread on `gate-lock.sh:650`). **r2: Fable's row review folded in, against main b7bb9ce6, post-MH2.** With `CF_GATE_SLOTS>1`, a second gate in the same checkout takes another slot, and both run `verify-manifests` (which mutates the tree) at once. "One gate per worktree" is only documented. Enumerated:<br>(1) **Identity:** `acquire` computes the caller's worktree ONCE, before the slot loop: `git rev-parse --show-toplevel 2>/dev/null \|\| pwd -P`. gate-lock.sh never changes directory, so this is the caller's cwd: the worktree root for `yarn gate`, the lane's cwd for `run`. In a linked worktree it prints that worktree's root. It is passed to `try_create`, which writes it as a FIFTH lock file, `worktree`. Update the "four files" comments (`gate-lock.sh:58`, `:280`, `:1162`). The seeded four-file assertion at `gate-lock.test.ts:1335` stays.<br>(2) **The check runs AFTER a slot is won** (after `try_create`'s read-back), over `existing_slots` (so only canonical, provenance-passing slots count). If ANY OTHER slot's `worktree` matches and its holder is LIVE (`pid_alive` and not `beat_is_stale`, the slot loop's own judgement, so a holder the loop would reclaim never blocks), `rm -rf` your own slot and exit 75 naming that holder and the words "same worktree". This never lets two run: whichever of two same-worktree acquirers checks later sees the other at its name. The one residual is a double-yield, when both land before either checks: both get 75 and both retry, which is the busy contract. A rule that yields only to a LOWER slot is NOT safe: a third holder releasing slot 0 between the two acquires lets the later one land below the earlier one after the earlier one has already checked.<br>(3) **The check runs BEFORE the slot is recorded in `CF_GATE_SLOT_OUT`** (`gate-lock.sh:616-622`), so a slot given back on a same-worktree refusal is never a pin that the caller, or MH5's cleanup fallback, can act on.<br>(4) **Compatibility:** a slot with no `worktree` file (a pre-MH4 holder, or one seeded by tests) never blocks. At SLOTS=1 the only change is that a caller whose worktree matches a LIVE numbered-slot holder now gets 75, which is correct under D188's host-wide rule.<br>**Tests** (`gate-lock.test.ts`):<br>- `startLockIn`/`runLockIn` gain a `cwd` option. The ONE existing test that must change is "three runs hold three slots at once, and a fourth is busy" (`:1436`): each run gets its own plain `mkdtemp` scratch cwd, which differ under the `pwd -P` branch. Every other SLOTS>1 case uses seeded slots and is unaffected;<br>- a second acquire from a SUBDIRECTORY of the same `git init` scratch is refused with 75 and "same worktree" (the git branch), the refused acquirer's slot is gone, and the holder's slot is intact;<br>- two acquires from two plain scratch dirs both succeed (the `pwd -P` branch);<br>- a live same-worktree holder in a HIGHER slot also blocks (the any-other rule);<br>- a same-worktree holder that is dead or stale does not block;<br>- a seeded slot without a `worktree` file does not block;<br>- the refusal writes nothing to `CF_GATE_SLOT_OUT`.<br>**Mutation (1):** drop the worktree check → the same-worktree test fails. | `scripts/gate-lock.sh` (acquire, try_create, and the comments), `tools/gate/__tests__/gate-lock.test.ts`, `.agents/manifests/mh4-one-gate-per-worktree.json` | touch `scripts/gate.sh` or `gate-signals.test.ts` (MH5's); write `CF_GATE_SLOT_OUT` before the check; weaken any HX3/HX3b/MH2 guarantee |
| **MH5-gate-sh-signal-hygiene** | **high** | **Absorbs MH6 (owner, 2026-09-30: run in parallel now, Fable reviewing). r2: Fable's row review folded in, against main b7bb9ce6, post-MH2.** Both defects are in `scripts/gate.sh`'s signal and cleanup path. Enumerated:<br>(1) **The acquire-window leak** (found by the MH2 lane). A TERM delivered while the foreground `acquire` child runs (`gate.sh:521-528`; the child is `:522`) is deferred by both dash and bash until the child exits. The child is not signalled, so it runs to completion. If it WON, it has written `CF_GATE_SLOT_OUT` last, so `exit 143` then runs with `LOCK_HELD=0` and a slot file naming the won slot, and `release_lock` (`:344`) skips: the lock is left naming a dead pid. It is a leak, not a permanent hold, because the next acquirer reclaims it.<br>**Fix:** in `release_lock`, when this gate has NOT yet attempted a release and `LOCK_SLOT_PATH` is still empty but the slot file's CONTENT is non-empty (the exact shape of the window: the child returned, `:529` never ran), release THAT slot through `gate-lock.sh release` with `CF_GATE_SLOT_PATH=<content>` and `CF_GATE_CALLER_PID=$$`. `release` goes through `require_trusted_slot` and refuses unless owner and pid are ours (`:1040-1043`), so only a slot this gate won is touched.<br>- A release-attempted flag, set by `release_lock` on ANY attempt, keeps the end-of-run release (`:602`) followed by cleanup's `release_lock` from ever releasing twice or reporting a refusal on a green gate. The same holds after the `CF_GATE_TEST_NO_SLOT_RECORDED` path.<br>- An EMPTY slot file (a busy or refused acquire) does nothing, and prints nothing. The busy-exit tests (`gate.test.ts:197`) must not gain output.<br>- It runs before `cleanup` removes the slot file (`:401`).<br>- **Residual, out of scope:** a process-group Ctrl-C that kills the child between its `mv` and its slot write leaves an empty file and a dead-pid lock for the next acquirer's reclaim, as today.<br>(2) **Cleanup messages swallowed under bash-as-sh** (found by Fable on MH2 round 3). A signal during `test:cov` runs the trap while `run_test_cov`'s `> "$COVLOG" 2>&1` redirect (`:469`, in `run_test_cov` `:467`) is active, so the gate's release messages land in COVLOG, which cleanup deletes. dash is unaffected; bash (the Mac's `/bin/sh`) is affected. The lock IS released.<br>**Fix:**<br>- save the original stdout and stderr ONCE, early (`exec 3>&1 4>&2`, beside `LOCK_HELD=0` at `:330`, before `trap cleanup EXIT` at `:407`);<br>- route `release_lock`'s and `cleanup`'s output through them, INCLUDING the release child's stdio (`sh "$LOCK_SCRIPT" release "$LANE" >&3 2>&4`, whose `gate-lock: released by` line is asserted), with the `gate: FAILED to release` line (`:369`) going `>&4`;<br>- **close both in the heartbeat subshell as its first line (`exec 3>&- 4>&-`).** An orphaned `sleep` holding the saved stdout would otherwise keep the caller's pipe open for a whole interval after the gate is gone (the hazard `:414-420` already names);<br>- do NOT close them on `run_test_cov`'s eval: under bash the trap runs inside that redirect context, and `>&3` must still work there.<br>**Tests** (`gate-signals.test.ts`, on its existing SIGNAL_SHELLS, which already lists bash where the host has it; on midnight that is dash plus bash, and on a Mac `sh` IS bash):<br>- (1): start a gate with `CF_GATE_STEPS="verify-manifests\tsleep 1"` and the EXISTING `CF_GATE_TEST_PAUSE_BEFORE_MV=<marker>` hook (in `try_create`, inherited by the acquire child: the parent's deferred trap fires when the child exits, wherever it was parked, and the child completes its rename and slot write after the marker is removed). `waitForFile(marker)`, `SIGTERM` the gate (the parent only), `rmSync(marker)` → exit 143, no `cf-gate.lock` directory, and stdout contains `gate: lock released, heartbeat stopped` and `gate-lock: released by lane-a`. **No new hook:** `CF_GATE_TEST_PAUSE_AFTER_ACQUIRE` is already taken by `run_locked` (`:902`) and must not be reused;<br>- (2): a `test:cov` step of `sleep 3`, TERM during it → exit 143, with the release line on stdout under every listed shell, and the test finishes well within its timeout (no orphaned fd 3);<br>- a green gate prints the release line exactly ONCE and no refusal;<br>- a busy exit prints nothing new;<br>- every existing gate-signals, gate and gate-lock test passes unchanged.<br>**Mutations (2):**<br>- drop the `LOCK_HELD=0` fallback → test (1) fails on every shell;<br>- route `release_lock`'s release line back to fd 1 (drop its `>&3`) → test (2) fails under bash, but SURVIVES under dash. That is why bash is in the shell list, and why the manifest command must run on a host that has bash (midnight does). The manifest records the shell. | `scripts/gate.sh` (the start-of-script fd save, `release_lock`, `cleanup`, the heartbeat subshell's first line), `tools/gate/__tests__/gate-signals.test.ts`, `.agents/manifests/mh5-gate-sh-signal-hygiene.json` | touch `scripts/gate-lock.sh` at all (MH4 owns it); change the step list, profile or arg loop (MH1's); add output to busy exits; weaken any HX3/HX3b/MH2 guarantee |

---

## 6. Shipped (wave `midnight-hybrid-w01`, 2026-09-30)

| Lane | PR → main | Rounds | Result |
|---|---|---|---|
| **MH1-gate-profiles** | #637 → 8ae711c3 | 1 + 2 fix rounds | **`yarn gate --profile midnight`: 13/13 on midnight, 603 s, 8,354 passed, 0 failed.** This is the first fully green gate midnight has produced for this repo. |
| **MH2-gate-lock-slots** | #636 → b7bb9ce6 | 1 + 3 lane fix rounds + 1 orchestrator fix | `CF_GATE_SLOTS` semaphore (≤ 64); the pinned slot; canonical, owned slots only; the second-signal release; busy acquires leave nothing in the holder's lock. 7 mutations. |

**Both lanes ran on midnight** (space-bunny, `--agent lane`, briefs in `.agents/briefs/`). The orchestrator verified every round on the Mac before any PR.

| Run | Wall (s) | Steps |
|---|---:|---:|
| MH1 | 2,527 | 110 |
| MH1 fix 1 | 646 | 55 |
| MH1 fix 2 | 1,264 | 66 |
| MH2 | 2,182 | 145 |
| MH2 fix 1 | 912 | 79 |
| MH2 fix 2 | 1,991 | — |
| MH2 fix 3 | 2,274 | — |

**What each review layer caught** (every finding was fixed or refuted with its mechanism):
- **Fable, on the plan and briefs (r3, r4):**
  - a wrong vitest listing command in D187;
  - a shared test file between the two lanes;
  - a slot-name glob that matched slot 1's own transients;
  - an MH2 signal recipe that could not reproduce the gap;
  - a snapshot file that CI would reject;
  - a mutation that would have run the real gate.
- **The orchestrator's Mac cross-check:** MH2's SLOTS=3 test was order-dependent, failing 11/15 on the Mac while it passed on midnight, and each failure leaked looping processes.
- **Fable, pre-PR:**
  - MH1: an empty `--profile` fell through to the default gate;
  - MH2: an uncapped slot count; `gate-signals` swallowed its asserted line under bash-as-sh, where the Mac's `/bin/sh` is bash and midnight's is dash; the "no slot recorded" path leaked the lock.
- **Qodo:**
  - **a security finding:** forged digit-suffixed slots redirected verify and heartbeat. It is reachable where the lock parent is shared, as with the `/tmp` fallback. **Fixed by pinning the acquired slot and trusting only canonical slots the caller owns;**
  - heartbeat matched by pid;
  - a vacuous `survived` read;
  - zero-padded counts;
  - MH1's listing filter drifting from the profile.
- **CodeRabbit:** every busy acquire nested its candidate inside the holder's lock. The orchestrator fixed it in 2d53760b, and Fable reviewed that fix.
- **Refuted, with evidence:** PR-Agent's quoting claim, and Qodo's "lists skipped tests" claim.

**D188 behaviour note:** a recycled pid of a `kill -9`'d gate, whose orphaned heartbeat still refreshes slot 0, now gets exit 2 ("already holds") instead of an endless 75.

**DoD status:**
- D187–D189 are stamped ✅.
- MH1 and MH2 are merged, with their mutations caught ✅.
- The profile gate passes 13/13 on midnight ✅.
- `ci.yml` and `REQUIRED_CHECK` are unchanged, and `required-check.test.ts` pins them ✅.
- **Open:** three concurrent gates on midnight, demonstrated once. This needs the owner to set `CF_GATE_SLOTS=3` host-wide (sudo).

**Follow-ups:**
- **MH4:** one gate per worktree, enforced (§5);
- **MH5:** the `gate.sh` acquire-window leak (§5);
- **MH6 (new):** `run_test_cov` swallows the gate's own cleanup messages when a signal lands during `test:cov` under bash-as-sh. The lock is still released. Proposed fix: `exec 3>&1` at start, and `>&3` in cleanup.
