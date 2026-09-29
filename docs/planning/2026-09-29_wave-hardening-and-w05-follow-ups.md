# Wave Hardening & the w05 Follow-ups — Architecture & Development Plan

**Date:** 2026-09-29
**Status:** **r1 — PROPOSED.** D181 – D185 await the owner. Nothing is dispatched.
**Decision ids introduced:** D181 – D185
**Lane ids introduced:** HX0 – HX7. `git grep -P '\bHX[0-9]'` over `docs/planning/` was empty before this plan; the known positive `\bPT-5c2\b` matched with the same command.
**Relates to:**
- the platform plan `2026-09-24_platform-and-tenancy.md` §4.5 (wave w05, closed 2026-09-29), D173, D179 (on fs, id = slug) and D180;
- `.claude/skills/orchestrate-wave/` and `docs/workflows/delegated-implementation-pipeline.md`;
- the w05 record in `.agents/session-log.md`.

---

## 0. What this plan answers

Wave w05 shipped PT-5a – PT-5e (#610 – #623), and it left three kinds of debt:

1. **Product defects found on the way.** A campaign slug can collide with a static route under `/campaigns`. Nothing in the app warns before a page unloads with unsaved work.
2. **Pipeline machinery that exists only as habit.** The gate lock is a script in a session scratchpad, with no liveness. The pre-PR review of high-risk lanes is a convention, not a gate. A push to `main` cancels the CI run verifying the merge before it, which happened twice.
3. **One flaky test that cost every lane gate retries.** Four lanes reported it independently, under host load.

Every finding below was verified against `main` at `eb55f3e4` before it was written down. Each verification is cited.

---

## 0.1 Proposed decisions

| id | Decision |
|---|---|
| **D181** | **Every static segment directly under `/campaigns` is a reserved campaign id, and a test derives the list from the route tree**, so a new route that is not reserved fails CI. The reserved list is **split in two**: `RESERVED_STORE_AREAS` (today's `cache`, `jobs`, `orgs`, `packages`, which `fs-output-store.ts:24` turns into hidden output areas) and `RESERVED_ROUTE_SEGMENTS`. `isReservedCampaignId` checks their union. The split exists because appending route names to the current list would also hide those directories in the output store, which is a behaviour change nobody asked for. **Existing campaigns whose slug is now reserved are not renamed.** They stay reachable by uuid on Postgres, and through the listing-first match on fs (as `last-opened` did in #623). |
| **D182** | **CI never cancels an in-progress run on `main`.** `cancel-in-progress` stays true for pull requests only. A merge's verification must finish even when a docs commit lands behind it. |
| **D183** | **The gate lock moves into the repository, with liveness.** `yarn gate` becomes the only gate invocation a brief names:<br>- it acquires the lock, runs every gate step in the foreground, and reports each step's real exit code;<br>- it releases the lock in a trap;<br>- the lock records a PID and a heartbeat, and a lock whose PID is dead, or whose heartbeat is stale, is reclaimed with a logged notice.<br>This retires the scratchpad `gate.sh`. |
| **D184** | **Plan rows carry a `risk:` tier** (`high` / `normal`). A `high` row's PR does not merge until the wave log holds a pre-PR `review settled` event for that lane, plus, if the verdict was `changes-required`, a later `remediate settled`. `scripts/merge-prs.sh` enforces this; `yarn plan:review check` reports it. |
| **D185** | **The shell warns before unloading with unsaved work.** `beforeunload` fires when the editor is dirty OR a draft write is pending or failed. It is one shell-level listener, not a per-feature one. |

---

## 1. Verified findings

| id | Severity | Finding | Evidence |
|---|---|---|---|
| **M1** | Medium | **A campaign slug equal to a static `/campaigns` segment shadows that campaign's routes.**<br>- Static GET files exist for `assets`, `briefs`, `capabilities`, `decisions`, `result` and `templates`, and `jobs`, `packages`, `pools`, `provider-keys` and `templates` are directories. A campaign slugged `templates` is never served by `[id].get.ts`.<br>- `briefs/draft.get.ts` (PT-5d's latest-draft route) shadows `[id]/draft.get.ts` for a campaign slugged `briefs`.<br>- The reserved list covers only `cache`, `jobs`, `last-opened`, `orgs` and `packages`.<br>- On fs the id IS the slug (D179), so such a campaign is unreachable by id. On Postgres the uuid still works, but slug refs collide. | `ls apps/api/server/routes/campaigns/`; `Treatment.vo.ts:26`; `validate.ts:82` |
| **M2** | Medium | **A push to `main` cancels the CI run verifying the previous merge.** The concurrency group is `ci-${{ github.ref }}-${{ github.event_name }}` with `cancel-in-progress: true`. On 2026-09-29 the w05 docs push cancelled #623's run on `98ac160d`, and the next run (`eb55f3e4`) covered it. It is recorded twice in the operator's notes. | `.github/workflows/ci.yml:45-47` |
| **M3** | Medium | **The gate lock has no liveness and lives outside the repository.**<br>- A dead holder (mercury-2.5, w05) left an orphaned lock that had to be released by hand.<br>- Fix-round prompts that said "same rules as before" lost the path, and a lane held the lock about 6 minutes while it searched.<br>- Two lanes held it for 35 – 38 minutes across retries.<br>- One lane piped `test:cov` through `tail`, so every run reported exit 0 while failing coverage. | the w05 session log; PT-5e opencode logs |
| **M4** | Medium | **The pre-PR review of high-risk lanes is a habit.** It found real bugs every time it ran in w05: PT-5c2 had 1, which would have been 404s on staging; PT-5d had 3, among them a leak of a hidden campaign and a race in its compare-and-swap. Nothing stops a high-risk PR from merging without it. | `scratchpad/grok-review/review-5c2b.md`, `review-5d.md`; the plan's §4.5 shipped note |
| **M5** | Medium | **No `beforeunload` anywhere in the web app.** Unsaved brief edits and a pending or failed draft PUT are lost on a tab close or reload without warning. The in-app navigation guard (`use-guarded-navigation.ts`) covers route changes only. CodeRabbit raised it on #622, and it was declined as out of that lane's scope. | `git grep beforeunload -- apps/web/src` (no hits); `BriefEditor.tsx:1103-1119` publishes the dirty flag |
| **M6** | Medium | **`jobs.test.ts` "handle minted survives across separate processes" flakes under host load.** It runs `spawnSync("yarn", ["tsx", …])` with no spawn timeout, so it pays yarn's and tsx's cold start per run. Four w05 lanes (PT-5c2, PT-5d, PT-5e twice) lost full gate runs to it or its neighbours, and each passed in isolation. | `apps/api/server/lib/__tests__/jobs.test.ts:379-399` |
| **L1** | Low | **fs id lookups scan the briefs directory.** `findBriefFileById` backs `resolveCampaign` / `campaignVisibility` / `campaignMeta` on hot paths (assets, decisions, pools, preview-frame). This is unmeasured; it was raised on #621 (thread 7irL). | `fs-brief-store.ts`; `brief-store.port.ts` |
| **L2** | Low | **Staging's `0014_draft` / `0015_last_opened` are not yet confirmed as applied.** The pod runs `eb55f3e4`, but the last three hours of logs carry no migration line. Drafts and last-opened have never been exercised by a signed-in user on staging. | `kubectl -n campaign-foundry-staging` image and logs |
| **L3** | Low | **The skill and cast docs predate w05's seat results.**<br>- `references/cast.md` has no grades for GLM, space-bunny, nemotron or mercury.<br>- The fix-round template has no absolute lock path and no "never pipe `test:cov`" rule.<br>- The pipeline doc does not name the stricter merge-CI wait (the `--workflow ci.yml` plus SHA filter). | `.claude/skills/orchestrate-wave/references/cast.md` |

---

## 2. Lanes (wave `wave-hardening-w06`)

The rules every lane inherits are the platform plan's §4.1 list: the gate lock, 100% coverage, a mutation manifest, no attribution lines, explicit staging, and PGlite only. HX3 changes how the lock is taken; lanes dispatched after HX3 merges use `yarn gate`.

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **HX0-seat-and-template-docs** | normal | **Orchestrator-authored docs PR (L3).**<br>- `cast.md` gains the w05 grades, space-bunny included, marked "trial only — no name, price or second provider".<br>- The fix-round template names the absolute lock path (then `yarn gate`, after HX3) and forbids piping `test:cov`.<br>- The pipeline doc's merge section adds the merge-CI wait (`--workflow ci.yml`, `headSha` filter). | `.claude/skills/orchestrate-wave/**`, `docs/workflows/delegated-implementation-pipeline.md` | edit `.agents/*.md` |
| **HX1-route-segments-reserved** | **high** | **D181.** Enumerated:<br>(1) `RESERVED_STORE_AREAS` and `RESERVED_ROUTE_SEGMENTS` in `Treatment.vo.ts`, with the web copy in `validate.ts`. `RESERVED_CAMPAIGN_IDS` becomes their union, so existing callers are unchanged. `fs-output-store.ts:24` derives `HIDDEN_AREAS` from `RESERVED_STORE_AREAS` ONLY.<br>(2) `RESERVED_ROUTE_SEGMENTS` = every static first segment under `routes/campaigns/` (files and directories, excluding `[…]`, `__tests__` and `index`): today `assets`, `briefs`, `capabilities`, `decisions`, `generate`, `jobs`, `last-opened`, `package`, `packages`, `plan`, `pools`, `preview-frame`, `provider-keys`, `result`, `templates`.<br>(3) An api test reads the route directory and fails if any static segment is missing from the list.<br>(4) The web pinned copy has a test asserting it equals the package's.<br>**Tests:**<br>- creating a campaign named `Templates` gets a slug other than `templates`, on both backends;<br>- the route-tree test fails when a new static file is added (mutation);<br>- `HIDDEN_AREAS` is unchanged (a snapshot of today's four).<br>Existing slugs are not migrated (D181). | the two list files and their tests, `fs-output-store.ts` (the `HIDDEN_AREAS` source only), `.agents/manifests/fu-reserved-campaign-ids.json` (re-anchor), a new route-tree test | rename any route; migrate stored campaigns |
| **HX2-main-ci-never-cancels** | normal | **D182.** `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}` with a one-line comment citing M2. Verified by a docs-only push that lands behind a running `main` run and does not cancel it. | `.github/workflows/ci.yml` (that line) | change any job step |
| **HX3-gate-in-repo** | normal | **D183.** Enumerated:<br>(1) `scripts/gate-lock.sh` (POSIX sh, because CI has no zsh) with the subcommands `acquire <lane>`, `release <lane>`, `status` and `heartbeat`:<br>- a `mkdir` lock at `${TMPDIR:-/tmp}/cf-gate.lock` holding `owner`, `pid`, `started` and `beat`;<br>- `acquire` reclaims a lock whose PID is not alive (`kill -0`) or whose `beat` is older than 10 min, and says so;<br>- exit 75 when busy, as today.<br>(2) `yarn gate [--lane <id>]` runs the full gate: `build`, `typecheck`, `lint`, `format:check`, `lint:arch`, `sync:check`, `lint:bytes`, the nitro route-scan guard, `test:cov` and `verify-manifests`.<br>- The lock is held only around `test:cov` and `verify-manifests`, with a heartbeat loop in the background while it is held and `trap … release` on exit.<br>- Each step's exit code is printed, and the gate stops at the first failure, reporting its name.<br>- A coverage threshold failure is a failure even if vitest exits 0 (grep `ERROR: Coverage`).<br>(3) The skill, the pipeline doc and the brief templates name `yarn gate` only.<br>**Tests:**<br>- a busy lock → 75;<br>- a dead PID → reclaimed;<br>- a stale beat → reclaimed;<br>- a trap on a failing step releases the lock;<br>- a threshold-only failure fails the gate. | `scripts/gate-lock.sh`, `scripts/gate.sh`, `package.json` (`gate`), their tests, the skill and pipeline doc references | take the lock around read-only steps; use zsh |
| **HX4-pre-pr-review-gate** | normal | **D184.** Enumerated:<br>(1) `plan-review hashes` / `check` parse an optional `risk:` token from the row (the `Lane` cell's trailing `· risk: high`), defaulting to `normal`.<br>(2) `merge-prs.sh` refuses a high-risk lane's PR unless the wave log has a `review settled` event for the lane, and, if its detail verdict is `changes-required`, a later `remediate settled`. The refusal names the missing event.<br>(3) The status page flags "high-risk PR open without pre-PR review".<br>**Tests:** each refusal and each pass; a `normal` row is unaffected; the flag renders. | `tools/plan-review/**`, `tools/wave-status/**`, `scripts/merge-prs.sh` (the refusal), their tests | block a `normal` row |
| **HX5-leave-guard** | normal | **D185.** Enumerated:<br>(1) One `beforeunload` listener in the shell layout, active while `EditorDirtyContext` reports dirty OR the draft write chain (PT-5d) has a pending or failed write.<br>(2) The draft chain exposes `hasPendingWrite()`.<br>(3) No listener at all when clean, because an always-on `beforeunload` disables the bfcache.<br>**Tests:** dirty → the event is prevented; clean → no listener registered; a pending PUT → prevented; a failed PUT → prevented; a successful PUT → released. Use `new Event("beforeunload", { cancelable: true })`, because happy-dom events default to `cancelable: false`. | `app/(shell)/layout.tsx`, the draft chain in `BriefEditor.tsx` / `editor-state.ts` (the pending flag only), their tests | change autosave timing |
| **HX6-jobs-subprocess-test** | normal | **M6.** Replace the `yarn tsx` spawn with a fresh module graph in-process: `vi.resetModules()` plus a dynamic re-import of `jobs.js`. That proves the handle survives a new module instance without paying for a process start.<br>If a real process is kept, use `process.execPath` with `--import tsx` directly (no yarn), with an explicit `timeout` and a failure message that includes `result.error` and stderr.<br>Never raise `testTimeout`. | `apps/api/server/lib/__tests__/jobs.test.ts` | change `jobs.ts` |
| **HX7-fs-id-index** | normal | **L1, measure first.** A benchmark over 1,000 campaigns decides whether this lane runs:<br>- if `findBriefFileById` costs more than 5 ms per call, add an in-memory id → slug index invalidated on create, rename and release;<br>- otherwise close L1 with the numbers. | `fs-brief-store.ts`, its tests | change the port |

**Order.**
- HX2 and HX0 go first; both are orchestrator PRs.
- HX3 goes next, since every later lane uses `yarn gate`.
- Then HX6, so gate retries stop.
- HX1, HX4 and HX5 can then run in parallel. They share no files. HX1 is high-risk under its own new rule, so it gets a grok-4.7 pre-PR review whether or not HX4 has landed.
- HX7 runs last, and only if its measurement says so.

**Seats.**
- GLM-5.3-Flash takes HX3, HX5 and HX6.
- Sonnet takes HX1 (high risk) and HX4, which touches the zsh merge script.
- space-bunny may take ONE lane as its second trial. The recommendation is HX6 or HX7, which are low risk and read the least client code.

---

## 3. Owner actions (not lanes)

1. **Stamp or amend D181 – D185.**
2. **Staging (L2):**
   - confirm the migrations with a read-only `select` against the staging database's migrations table (the orchestrator can run it with `kubectl exec`, in the staging namespace only);
   - then sign in and exercise: autosave, a reload that restores the draft, Save deleting the draft, and a bare `/grid` redirecting to the last-opened campaign.
3. **Optional system housekeeping** (the operator's settings, never the orchestrator's): exclude `ADOBE/.worktrees` from Time Machine, and prune the opencode database (5.8 GB).
4. **Still blocked:** PT-4, PT-8 and PT-9 wait on the B2 credentials.

---

## 4. Definition of done

- D181 – D185 are stamped, or amended with the owner's wording.
- HX0 – HX6 are merged, each with 100% coverage and a replayed mutation manifest. HX7 is merged or closed with its measurements.
- `git grep beforeunload -- apps/web/src` has exactly one production hit.
- Re-running the M2 scenario (a docs push behind a running `main` run) leaves the earlier run to finish.
- A dead-PID lock is reclaimed by `yarn gate` without a human.
- Staging runs the HX merges, with `0014` and `0015` confirmed. The owner has exercised drafts and last-opened, and the session log records it.
