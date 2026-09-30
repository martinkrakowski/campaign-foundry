# Midnight Hybrid Verification — Architecture & Development Plan

**Date:** 2026-09-30
**Status:** **r1 — PROPOSED.** D187–D189 await the owner. Needs a Fable plan review before dispatch.
**Decision ids introduced:** D187 – D189
**Lane ids introduced:** MH1 – MH3 (`git grep -P '\bMH[0-9]'` over `docs/planning/` was empty).
**Relates to:**
- `2026-09-29_test-postgres-harness.md` §5: the midnight acceptance run, and the "hybrid" verdict;
- `2026-09-29_wave-hardening-and-w05-follow-ups.md`: D183, the gate lock, and HX3b's `gate-lock.sh run`.

---

## 0. What this plan answers

midnight.lan (24-core Xeon E5-2697 v2, 62 GB, no AVX2) cannot run campaign-foundry's FULL gate green. Two classes of test fail for hardware reasons:
- **4 byte-exact media goldens** mismatch, because they are recorded on GitHub's runner and the encoders take different SIMD paths;
- **6 CPU-bound generate and render tests** time out at 5 s.

Everything else passes there, including every Postgres-backed test against the real `cf-test-pg` (TP1, #633). The owner asked how to use midnight *beyond* offloading lanes. This plan does it in three waves:
1. a **named gate profile** that runs everything except the declared host-sensitive set;
2. a **per-host gate-lock semaphore**, so midnight can run 2–3 gates at once;
3. a **CI split**: an ephemeral self-hosted runner on midnight runs the profile job, while GitHub keeps the goldens and the CPU-bound tests, both jobs are required, and their coverage is merged to the existing 100% gate.

Nothing weakens verification. CI still runs every test somewhere on every PR, and every exclusion is a versioned, printed list.

---

## 0.1 Proposed decisions

| id | Decision |
|---|---|
| **D187** | **The host-sensitive test set is a declared, versioned list, and a gate profile may exclude exactly that list.**<br>- `tests/host-sensitive.json` names each test FILE, with its reason (`golden-bytes` or `cpu-bound`) and the host facts behind the reason.<br>- `yarn gate --profile <name>` excludes the files the profile names from that list, and prints them on every run.<br>- The default profile (no flag) excludes nothing, so today's gate is unchanged.<br>- CI's full coverage is the union of both CI jobs (D189), so no test ever stops running on a PR. |
| **D188** | **The gate lock becomes a per-host semaphore.** `CF_GATE_SLOTS`, default **1**, which is today's behaviour; midnight sets **3**. Each slot is its own lock directory (`cf-gate.lock.<n>`) with the same pid, heartbeat, reclaim and signal semantics HX3/HX3b built, so every guarantee carries over per slot. |
| **D189** | **CI splits by host, and both jobs are required.**<br>- **`ci-midnight`** runs on an ephemeral, containerised, self-hosted runner on midnight: build through verify-manifests, `test:cov` under `--profile midnight`, against real Postgres (`cf-test-pg`), with warm caches.<br>- **`ci-github`** runs on `ubuntu-latest`: the host-sensitive list plus the PGlite path. It stays the golden source of truth.<br>- A final **`coverage`** job merges both jobs' `coverage-final.json` and enforces the repo's 100% thresholds on the MERGE.<br>- If the self-hosted runner is offline, `ci-midnight` falls back to `ubuntu-latest`.<br>- `merge-prs.sh`'s `REQUIRED_CHECK` names all three checks.<br>- **Security:**<br>  - the runner is a separate Linux user in a container;<br>  - it has no access to kubeconfig, staging secrets, `~/.ssh` or the owner's projects;<br>  - it only reaches `cf-test-pg` on loopback;<br>  - it is ephemeral (one job, then destroyed);<br>  - it only runs for this private repo's own branches. |

---

## 1. Verified findings

| id | Severity | Finding | Evidence |
|---|---|---|---|
| **M1** | Medium | **Midnight's full gate fails only on a hardware-bound set.** After TP1: 610 s, 10/8,337 failed, 0 Postgres timeouts. The goldens that fail are VG2 MP4, VE3b1 audio, C1 motion and K3 text effects (mismatches). The CPU-bound tests are the generate CLI, `pipeline.test`, two in `routes.test` (generate), `capability-race` and `generate-report-conflict` (timeouts). | `2026-09-29_test-postgres-harness.md` §5 |
| **M2** | Medium | **One gate per host is the Mac's constraint, not midnight's.** The lock is a single `mkdir` directory at `${TMPDIR:-/tmp}/cf-gate.lock` (`scripts/gate-lock.sh:90`). On midnight it serializes 24 cores to one gate. | `gate-lock.sh:90` |
| **L1** | Low | **`main` has NO branch protection.** Required-check enforcement lives entirely in `merge-prs.sh` (`REQUIRED_CHECK=${REQUIRED_CHECK:-'^Build'}`, `:68`, `:218`). A CI split changes that one pattern, not GitHub settings. | `gh api …/branches/main/protection` → 404; `merge-prs.sh:68` |
| **L2** | Low | **CI is one job** (`ci`, `ci.yml:42-44`, `ubuntu-latest`), with the full `test:cov` (`:235-236`) plus TP1's real-Postgres step (`:251-255`). Coverage thresholds are global in `vitest.config.ts`. | `ci.yml` |

---

## 2. Lanes (wave `midnight-hybrid-w01`)

Every lane inherits the pipeline and skill rules (`yarn gate`, 100% coverage, a manifest, no attribution lines, explicit staging). The seat is **space-bunny**; MH3 is **high** risk (CI and security) and gets a Fable pre-PR review.

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **MH1-gate-profiles** | normal | **D187.** Enumerated:<br>(1) `tests/host-sensitive.json` lists the 10 files from M1 as `{ file, reason, facts }`. A test asserts every listed file exists.<br>(2) `yarn gate --profile <name>`:<br>- profiles are defined in the same JSON (`"midnight": ["golden-bytes", "cpu-bound"]`);<br>- the gate passes the matching files to `test:cov` as vitest `--exclude` args, and prints `profile midnight: excluding N host-sensitive files` plus the list;<br>- an unknown profile gives exit 2;<br>- no flag means today's behaviour, byte for byte.<br>(3) **Coverage under a profile:** coverage thresholds are NOT enforced by a profiled run, which prints "coverage enforced by CI's merged report (D189)". The unprofiled local gate still enforces 100%.<br>(4) `yarn gate --print-steps --profile midnight` shows the resolved commands.<br>**Tests:**<br>- the list parses, and every file exists;<br>- a profile excludes exactly its reasons' files;<br>- no profile excludes nothing;<br>- an unknown profile → 2;<br>- the printed list matches.<br>**Acceptance:** on midnight, `TEST_PG_URL=… yarn gate --profile midnight` passes 13/13. Record the wall time. | `tests/host-sensitive.json`, `scripts/gate.sh` (the profile flag), `tools/gate/__tests__/gate.test.ts`, `.agents/manifests/mh1-gate-profiles.json` | exclude anything from the default gate; add a test to the list without a reason and host facts |
| **MH2-gate-lock-slots** | normal | **D188.** Enumerated:<br>(1) `CF_GATE_SLOTS` (integer ≥ 1, default 1, validated like `CF_GATE_STALE_SECONDS`).<br>(2) `acquire` and `run` try slots `0..N-1` in order and take the first free one. Every slot keeps HX3/HX3b's pid, heartbeat, stale reclaim, atomic beat, signal forwarding and cleanup.<br>(3) `status` lists every slot. `release` releases the caller's own slot only.<br>(4) `gate.sh` uses the same slot count.<br>(5) **Carry-over:** fix the Fable-reported `run_cleanup` second-signal gap (`trap - EXIT; trap '' INT TERM` first in `run_cleanup`), since this lane owns `gate-lock.sh`.<br>**Tests** (on `sh` and `dash`):<br>- with SLOTS=1 every existing test passes unchanged;<br>- with SLOTS=3, three concurrent `run`s hold three slots and a fourth gets 75;<br>- a dead holder's slot is reclaimed without disturbing the others;<br>- the second-signal test (park the heartbeat, TERM, TERM after 0.5 s → released). | `scripts/gate-lock.sh`, `scripts/gate.sh` (slot passthrough), `tools/gate/__tests__/*.ts`, `.agents/manifests/mh2-gate-lock-slots.json` | change SLOTS=1 behaviour; weaken any HX3/HX3b guarantee |
| **MH3-ci-host-split** | **high** | **D189.** Enumerated:<br>(1) **The runner:** `deploy/ci-runner/`, with a README and scripts for the owner to install an EPHEMERAL, containerised GitHub Actions runner on midnight:<br>- a dedicated `ghrunner` user; labels `self-hosted, midnight`;<br>- no mounts of `/home/martin`, kubeconfig or `~/.ssh`; network access to `127.0.0.1:5433` only (plus GitHub);<br>- the runner registration token is created by the OWNER and never committed or printed.<br>(2) **The `ci-midnight` job** (`runs-on: [self-hosted, midnight]`): steps 1–11 of the gate, then `test:cov --profile midnight` with `TEST_PG_URL` set, uploading `coverage-final.json` as an artifact. Caches (the yarn cache, the Turbo cache) persist on a runner-owned volume.<br>(3) **The `ci-github` job** (`ubuntu-latest`):<br>- the host-sensitive files only, with coverage uploaded;<br>- plus today's PGlite `test:cov` run? **No:** to avoid double-running, `ci-github` runs the host-sensitive files, and the PGlite path runs in `ci-midnight` only when `TEST_PG_URL` is unset. State the chosen split and prove the union covers every test file (a test lists every test file, and asserts each runs in exactly one job).<br>(4) **The `coverage` job:** it needs both jobs, merges the two `coverage-final.json` files (istanbul merge), and enforces `vitest.config.ts`'s 100% thresholds on the merge.<br>(5) **Fallback:** if `ci-midnight` isn't picked up within N minutes, a scheduled or `workflow_dispatch` path reruns it on `ubuntu-latest`, and the job name stays the same, so the required check is satisfiable.<br>(6) **`merge-prs.sh`:** `REQUIRED_CHECK` becomes a list covering all three jobs. Update its tests.<br>(7) **Goldens:** `record-goldens` stays on `ubuntu-latest`, and nothing records goldens on midnight.<br>**Tests:**<br>- the workflow parses (actionlint);<br>- the union-of-test-files check;<br>- the coverage merge fails when one side drops a covered line (a fixture);<br>- `merge-prs.sh` refuses when any of the three checks is missing.<br>**Acceptance:** one PR runs all three jobs green, and the PR records the wall time of each against today's single job. | `deploy/ci-runner/**`, `.github/workflows/ci.yml`, `scripts/merge-prs.sh` (`REQUIRED_CHECK`), `tools/**` for the union and merge checks, their tests, `.agents/manifests/mh3-ci-host-split.json` | give the runner access to secrets, kubeconfig, `~/.ssh` or other projects; record goldens anywhere but GitHub; drop any test from CI; enable the runner for forks |

**Order:** MH1 → MH2 (in parallel, since they don't share files) → MH3 (it needs MH1's profile). MH3 also needs the owner to install the runner (§3).

---

## 3. Owner actions

1. **Stamp D187–D189.**
2. **For MH3:** create the runner registration token (GitHub → repo Settings → Actions → Runners), and run MH3's install script on midnight. Never paste the token into chat.
3. **Optional:** decide whether hexagen adopts the same profile and semaphore design through its OW3 package. The hexagen orchestrator owns that.

## 4. Definition of done

- D187–D189 are stamped, and MH1–MH3 are merged with their mutations caught.
- `yarn gate --profile midnight` passes 13/13 on midnight with `TEST_PG_URL`, and its wall time is recorded.
- Midnight runs 3 concurrent gates without interference, which is demonstrated once.
- Every PR runs `ci-midnight`, `ci-github` and `coverage`. The merged coverage enforces 100%, and the union check proves every test file runs exactly once.
- The session log records the before and after CI wall times.
