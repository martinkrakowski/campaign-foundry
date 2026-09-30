# Midnight Hybrid Verification — Architecture & Development Plan

**Date:** 2026-09-30
**Status:** **r2 — Fable plan review folded (3 blockers, 11 fixes, 7 notes). D187–D189 await the owner.** r1's CI split (MH3) is DROPPED under the owner's principle below.
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
| **D187** | **Host-sensitive tests are declared with vitest TAGS, and a local gate profile may filter them out.**<br>- `vitest.config.ts` declares `test.tags: [{ name: "golden-bytes", description: "<host facts>" }, { name: "cpu-bound", description: "<host facts>" }]`.<br>- The affected `describe`/`test` carries `{ tags: [...] }`. Tags are per TEST, not per file, because `routes.test.ts` has 76 tests and only 2 are CPU-bound.<br>- `yarn gate --profile midnight` filters with `--tagsFilter '!golden-bytes && !cpu-bound'` and prints the excluded tests (from `vitest --listTags=json`).<br>- The default gate (no profile) filters nothing.<br>- A profiled run enforces NO coverage thresholds. GitHub CI enforces 100% on the full run. |
| **D188** | **The gate lock is a per-host semaphore of `CF_GATE_SLOTS` slots** (default 1, today's behaviour):<br>- slot 0 stays `cf-gate.lock` (unsuffixed, byte-identical at SLOTS=1); slots 1..N-1 are `cf-gate.lock.<n>`;<br>- every subcommand finds the caller's slot by scanning;<br>- **`CF_GATE_SLOTS` is set HOST-WIDE** (never per seat), because a SLOTS=1 acquirer would take slot 0 while other slots are busy;<br>- **one gate per worktree,** because `verify-manifests` mutates the tree and the lock is per host, not per checkout. |
| **D189** | **Midnight is never a CI path.**<br>- The complete CI (today's `ci` job plus TP1's server step, `ci.yml:42-275`) stays on GitHub-hosted runners, unchanged, and remains the only required check (`merge-prs.sh:68` `^Build`, unchanged).<br>- No self-hosted runner is registered for this repository.<br>- **If CI speed ever becomes the goal,** the path is `vitest --shard` across hosted jobs, with `--reporter=blob` and `vitest --merge-reports --coverage` (natively supported; thresholds apply on the merged map). There is no runner and no security surface. That would be its own plan. |

---

## 1. Verified findings

| id | Severity | Finding | Evidence |
|---|---|---|---|
| **M1** | Medium | **Midnight's full gate fails only on a hardware-bound set: 10 tests in 9 files.**<br>- **Goldens** (mismatches): `CanvasFfmpegVideoCompositor.byte-golden`, `CanvasFfmpegVideoCompositor.audio-golden`, `NodeCanvasCompositor.motion-goldens`, `NodeCanvasCompositor.text-effect-goldens` (`packages/CreativeGeneration/src/infrastructure/adapters/__tests__/`).<br>- **Timeouts at vitest's 5,000 ms default:** `apps/api/bin/__tests__/generate.test.ts`, `apps/api/server/lib/__tests__/pipeline.test.ts`, `apps/api/server/routes/__tests__/routes.test.ts` (2 of its 76 tests), `…/campaigns/__tests__/capability-race.test.ts`, `…/generate-report-conflict.test.ts`.<br>None of the timed-out files sets an explicit timeout, so a longer PROFILE timeout may keep them running (MH1 measures it). | harness plan §5; grep |
| **M2** | Medium | **One gate per host is the Mac's constraint, not midnight's.** The single `mkdir` lock at `${TMPDIR:-/tmp}/cf-gate.lock` (`gate-lock.sh:90`, `gate.sh:222`) serializes midnight's 24 cores to one gate. | code |
| **H1** | High | **Any midnight job that makes a check-run on a PR head would block merges.** `merge-prs.sh:240-249` counts EVERY check-run as pending and rejects any failure, so even an "optional" self-hosted job becomes de facto required. Combined with the owner's principle, that is why D189 registers no runner. | `merge-prs.sh:240-249` (Fable) |

---

## 2. Lanes (wave `midnight-hybrid-w01`)

Every lane inherits the pipeline and skill rules. The seat is **space-bunny**. MH2 is **high** risk: every seat depends on the lock, so it gets a Fable pre-PR review.

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **MH1-gate-profiles** | normal | **D187.** Enumerated:<br>(0) **Measure first.** On midnight, run the 6 CPU-bound tests with `--testTimeout 20000` and record their times. Tag `cpu-bound` ONLY on tests that still fail. A profile-scoped timeout weakens nothing on the Mac or CI.<br>(1) **Declare** the `golden-bytes` and `cpu-bound` tags in `vitest.config.ts` `test.tags`, with the host facts as descriptions.<br>- Before tagging, check that `describe(name, { tags }, fn)` type-checks, and that root `test.tags` reaches the `extends: true` projects (`yarn vitest --listTags` once).<br>- Tag the 4 golden tests and whatever (0) leaves failing.<br>(2) **`yarn gate --profile <name>`:** profiles are defined in `scripts/gate.sh` (`midnight` = `!golden-bytes && !cpu-bound`, plus `--testTimeout 20000` if (0) needed it).<br>- Under a profile, the test step is `yarn vitest run --tagsFilter '<expr>' [--testTimeout N]` with **no `--coverage`**, and it prints "coverage thresholds are not enforced under a profile; GitHub CI enforces 100% on the full run", plus the excluded tests.<br>- An unknown profile gives exit 2.<br>- No profile means today's command, byte for byte.<br>(3) **`yarn gate --print-steps [--profile x]`** (new: `gate.sh:115-128` accepts only `--lane` today) prints the resolved step commands and exits 0.<br>**Tests:**<br>- no profile means today's steps (snapshot);<br>- the midnight profile uses the tags filter and no coverage;<br>- an unknown profile → 2;<br>- `--print-steps` output;<br>- the tag declarations exist, and every tagged test has a declared tag (strict tags).<br>**Acceptance:** on midnight, `TEST_PG_URL=… TEST_DATABASE_URL=… yarn gate --profile midnight` passes 13/13. Record its wall time. | `vitest.config.ts` (the `test.tags` block only), the tag annotations on the listed tests, `scripts/gate.sh` (profile and `--print-steps`), `tools/gate/__tests__/gate.test.ts`, `.agents/manifests/mh1-gate-profiles.json` | change the default gate; tag a test without measuring; change coverage thresholds or include/exclude |
| **MH2-gate-lock-slots** | **high** | **D188.** Enumerated:<br>(1) `CF_GATE_SLOTS`: an integer ≥ 1, default 1, validated like `CF_GATE_STALE_SECONDS`.<br>(2) **Slots:**<br>- slot 0 = `cf-gate.lock` (unsuffixed); slots 1..N-1 = `cf-gate.lock.<n>`;<br>- `acquire`/`run` try slots in order, with the pass counter (`:268`) per slot;<br>- `release`, `verify`, `heartbeat` (pid-only today, `:644-653`) and `lock_is_ours` (`:564-614`) find the caller's slot by scanning for owner and pid;<br>- `status` (`:616`) lists EVERY existing slot, whatever the caller's `CF_GATE_SLOTS`.<br>Every HX3/HX3b guarantee holds per slot: per-pid liveness, stale reclaim via `take_stale` on the judged slot, the atomic beat, signal forwarding, and `run`'s verify (`:553`).<br>(3) **Docs:** `CF_GATE_SLOTS` is set host-wide (e.g. `/etc/environment` on midnight), never per seat; one gate per worktree.<br>(4) **Carry-over, in scope:** the `run_cleanup` second-signal fix. Put `trap - EXIT; trap '' INT TERM` first in `run_cleanup` (`gate-lock.sh:370`), and apply the SAME pattern to `gate.sh:233`'s `cleanup`. This closes the Fable-reported gap where a second TERM during cleanup kills the shell before release.<br>**Tests** (on `sh` and `dash`):<br>- with SLOTS=1, every existing test passes unchanged (41 path references stay valid);<br>- with SLOTS=3, three concurrent `run`s hold three slots and a fourth gets 75;<br>- a dead holder's slot is reclaimed without touching the others;<br>- `status` lists all slots;<br>- release, verify and heartbeat act on the caller's own slot only;<br>- the second signal (park the heartbeat, TERM, TERM after 0.5 s → released), for `run` and for `gate.sh`. | `scripts/gate-lock.sh`, `scripts/gate.sh` (slot passthrough and `cleanup` traps), `tools/gate/__tests__/*.ts`, `.agents/manifests/mh2-gate-lock-slots.json`, the Template A note | change SLOTS=1 LOCKING behaviour; weaken any HX3/HX3b guarantee |

**Order:** MH1 and MH2 in parallel (they touch `gate.sh` in different places; the second to merge rebases through `merge-prs`).

---

## 3. Owner actions

1. **Stamp D187–D189.**
2. **After MH2 merges:** set `CF_GATE_SLOTS=3` host-wide on midnight (`/etc/environment`, which needs sudo) and on the opencode service's environment drop-in.

## 4. Definition of done

- D187–D189 are stamped, and MH1 and MH2 are merged with their mutations caught.
- `yarn gate --profile midnight` passes 13/13 on midnight, with its wall time recorded.
- Three concurrent gates run on midnight without interference, demonstrated once.
- `ci.yml` and `REQUIRED_CHECK` are unchanged; a test asserts that `^Build` still matches the CI job name.
