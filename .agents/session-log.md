# Session Log

A running record of AI-assisted work sessions. After each session, append an
entry using the template below. Keep entries short — this is a memory aid for
the next session, not documentation.

Unlike the other `.agents/*.md` spec files (which AGENTS.md marks "never edit"),
this file is **append-only by design** — adding session entries is expected.

To keep this file out of version control, add `.agents/session-log.md` to
`.gitignore`.

---

## Template (copy for each session)

**Session:** YYYY-MM-DD — topic

- **Mode:** Implementer
- **Changes:**
  - (what was edited, at a file/feature level)
- **Decisions:**
  - (choices made and the reason, so they are not relitigated)
- **Left open:**
  - (follow-ups, known gaps, anything the next session should pick up)

---

## 2026-01-01 — example entry

- **Mode:** Architect
- **Changes:**
  - none (planning only)
- **Decisions:**
  - Adopted the Hexagen template system for infrastructure slices.
- **Left open:**
  - Decide which auth provider template to install.

---

## 2026-06-08 — 100% test coverage

- **Mode:** Implementer
- **Changes:**
  - Stood up Vitest (istanbul coverage, happy-dom for the UI) and switched the
    test contract from node:test (`.agents/testing.md`, `.agents/tech-stack.md`,
    AGENTS.md). Wrote 271 tests across every workspace reaching 100%
    statements/branches/functions/lines; CI `test:cov` now enforces the gate.
  - Small seam refactors shipped with their tests: injectable client on
    GeminiImageGenerator; exported bin/generate `main()`; shared `errorMessage`
    helper. Deleted four dead generated stubs from the shared kernel.
- **Decisions:**
  - Chose Vitest over node:test (user call): the UI coverage target made happy-dom
    + built-in coverage decisive. Coverage runs as the full suite so each project
    transforms its own files.
  - Justified `istanbul ignore` only on genuinely-unreachable defensive guards
    (focus-trap `!focusables`, disabled-button/unmount-race guards).
- **Left open:**
  - Package-level `lint` script can't resolve the eslint bin inside a workspace
    (pre-existing; eslint works at the repo root).

---

## 2026-06-09 — PR #36 qodo review triage + fixes

- **Mode:** Implementer
- **Changes:**
  - FireflyImageGenerator: cache the IMS token (`{token, expiresAt}`, 60 s refresh
    margin) and share one in-flight grant across concurrent generations; +4 tests.
  - env.ts startup summary: list Firefly when both credentials are set (opt-in via
    the "firefly" model) and warn on half-configured credentials; +2 tests.
- **Decisions:**
  - qodo finding #1 (console.warn vs structured logger) rejected: AGENTS.md names
    `src/infrastructure/logging/logger.ts`, but no logger module exists anywhere in
    the repo and `console.*` with a `[Component]` prefix is the actual convention
    (~16 sites, incl. both sibling adapters). Findings #2/#3 confirmed and fixed.
  - 5 min default token TTL when IMS omits `expires_in` (conservative; IMS normally
    reports ~24 h).
- **Left open:**
  - AGENTS.md's logging convention doesn't match the codebase (no logger module, no
    eslint-no-console config) — either adopt a structured logger repo-wide or amend
    AGENTS.md; qodo compliance rule 960794 will keep firing until one happens.

---

## 2026-06-09 — hexagen tooling repair (branch fix/hexagen-tooling, no PR yet)

- **Mode:** Implementer
- **Changes:**
  - Bumped @hexagen-monaco/sync + arch-linter ^0.4.0 → ^0.6.0 (root cause: the
    wizard wrote manifest.yaml with `workspaceTemplate`, a key only parsed from
    0.6.0 on, while scaffolding ^0.4.0 pins — every hexagen command failed at load).
  - Reconciled .architecture/ with repo reality: value_objects → value-objects
    layer naming; dropped the two deleted external-service-client.out-port stubs;
    declared adapter-context depends_on CampaignOrchestration; whitelisted
    @campaignfoundry/CampaignOrchestration in invariants/linter-config.yaml
    (the linter reads invariants, not manifest depends_on).
  - Ran the first successful `yarn sync` (verified in a throwaway clone first):
    removed shared's two empty placeholder barrels + parent re-exports, added
    adapter barrels (CreativeGeneration's now exports fonts/safe-path too), empty
    application skeletons, `"dependencies": {}` in shared/package.json.
    Second sync is byte-level idempotent; all gates green (287 tests, 100% cov).
  - Gitignored SYNC-MIGRATION-REPORT.md (per-run artifact).
- **Decisions:**
  - lint:arch is green; templates:validate works ("no templates installed").
  - Did NOT wire CI gates: at 0.6.0 every failure exits 0 (manifest parse failure,
    arch violations) — gating would pass vacuously. Blocked on upstream fix.
- **Left open (upstream, hexagen-monaco):**
  - Scaffolder must pin the CLI version whose schema it writes (the root cause).
  - Exit codes: sync + arch validate exit 0 on every failure mode.
  - --dry-run is not read-only: it deleted legacy empty barrels and wrote the
    migration report (repeatable until converged).
  - Dry-run planner + counters mislabel unconditional same-content rewrites as
    create/update (43 "would" lines on a fully converged tree) — unusable as a
    drift detector until fixed.
  - Failure rollback runs `git reset --hard && git clean -fd` in the consumer repo.
  - Then: release 0.6.1, bump pins here, wire sync:dry + lint:arch into CI.

---

## 2026-06-12 — hexagen 0.7.0 + CI architecture gates (branch fix/hexagen-tooling)

- **Mode:** Implementer
- **Changes:**
  - Bumped @hexagen-monaco/sync + arch-linter ^0.6.0 → ^0.7.0 — the upstream
    release that fixed everything the 2026-06-09 entry left open: honest exit
    codes, read-only dry-run, truthful op counts, a `--check` drift mode, and
    journaled scoped rollback (no more git-reset against this repo).
  - Accepted yarn-4's normalized shared/package.json: install strips the empty
    `"dependencies": {}` that 0.6.0's sync kept re-adding; 0.7.0 emits the
    block only when non-empty, so the install↔sync churn loop is dead.
  - Added the `sync:check` script and wired CI: `yarn install --immutable`
    (lockfile is committed) + two fail-fast gates ahead of the build —
    `sync:check` (drift) and `lint:arch`.
- **Decisions:**
  - Gates went straight to `sync --check` rather than landing `sync:dry` first:
    0.7.0 shipped both upstream hardening waves at once, so the interim step
    had no window in which it was the best available gate.
  - Probed the gate in both directions before trusting it: converged tree →
    exit 0 / `Total ops : 0`; deleted generated barrel → exit 1 / "Drift
    detected: 1 pending change(s)". Non-vacuous, unlike 0.6.0.
- **Left open:**
  - setup-node's yarn cache is still disabled (TODO in ci.yml) — enabling it
    requires corepack BEFORE setup-node (yarn-4 probe gotcha); separate change.
  - Cosmetic upstream nit: dry-run logs each planned barrel op twice (counted
    once — the summary table and exit code are correct).

---

## 2026-06-15 — hexagen 0.8.0 bump + PR #37 qodo review triage (branch fix/hexagen-tooling)

- **Mode:** Implementer
- **Changes:**
  - Narrowed the CampaignOrchestration arch whitelist to its root entrypoint
    (`dd6c645`): dropped the `@campaignfoundry/CampaignOrchestration/**`
    `global_whitelist` line. The package's `exports` map exposes only `.`, so no
    subpath import resolves and none exist in the tree — `/**` added breadth with
    no edge to cover. The exact-root entry stays (load-bearing: adapters import
    the ports inward from the core).
  - Bumped @hexagen-monaco/sync + arch-linter ^0.7.0 → ^0.8.0 (`b1a834a`) once the
    upstream published 0.8.0. Needed a pin edit, not just a lock refresh: the 0.x
    caret `^0.7.0` means `<0.8.0`. 0.8.0 is functionally identical to 0.7.1 for
    both packages — the substance (sync's manifest-migration feature; arch-linter
    extracting `cross-package-violation.ts`) shipped in 0.7.1, which `^0.7.0` never
    pulled in; 0.8.0 carries it across and clears the skew in one move.
  - All three gates green on 0.8.0: `lint:arch` compliant (the `dd6c645` whitelist
    change holds under the refactored linter), `sync:check` `Total ops : 0` (no
    drift, tree untouched), 287 tests.
  - Enabled setup-node's yarn cache (`ci.yml`): moved `corepack enable` ahead of
    setup-node so its `cache: yarn` probe resolves Yarn 4 (Classic reports the
    wrong cache folder) — clears the carried-over 2026-06-12 TODO. Caches Berry's
    global cache (`enableGlobalCache: true` → `~/.yarn/berry/cache`); a miss only
    re-downloads, `install --immutable` stays authoritative.
  - Bumped checkout/setup-node/cache `@v4`→`@v5` (`ci.yml`): the v4 majors declare
    `using: node20`, deprecated as GitHub defaults the JS action runtime to Node 24
    on 2026-06-16 (Node 20 removed fall 2026). v5 majors are node24-native and
    nothing else (verified release notes); `ubuntu-latest` meets the required
    runner ≥ v2.327.1. `node-version: "22"` (the build Node) is a separate axis — left as-is.
- **Decisions:**
  - qodo PR #37 finding #1 ("overbroad whitelist", labeled Bug) — validated the
    kernel (the `/**` was unnecessary) but rejected the Bug framing: the `exports`
    map already forecloses deep imports, `/**` matched zero real imports, and
    whitelisting the core's entrypoint is the intended hexagonal edge. Applied the
    one-line tightening, nothing more.
  - qodo finding #2 ("stale TEST_COVERAGE_PLAN.md", Informational) — confirmed
    stale but mis-attributed (the staleness predates this PR; it came from the stub
    deletion in `56722fc`) and out of scope (doc untouched, belongs to
    feat/test-coverage). Left as-is. Posted both verdicts as a PR comment.
  - Targeted 0.8.0 over 0.7.1: same content for our packages, but aligns the
    consumer to the generator's published `latest` instead of trailing by a minor.
- **Left open:**
  - 0.8.0's manifest-migration analyzer reports "16 entries: 7 blocked, 9 skipped"
    in `--check` mode (writes nothing, doesn't fail the gate) — unexamined; look
    before adopting `hexagen manifest migrate`.
  - Confirmed obsolete: 0.8.0 `sync --check` refuses a dirty tree ("use
    `--allow-dirty`") instead of the old `git reset --hard` — the rollback footgun
    flagged on 2026-06-09 is gone.

---

## 2026-08-25 — generate job handle (Phase J / D5)

- **Mode:** Implementer
- **Changes:**
  - `POST /campaigns/generate` returns `202 { jobId }` and continues the run
    in-process; `writeReport` still happens on success. Invalid brief / unknown
    `?model=` stay synchronous 400s. Business-rule failures mark the job
    `failed` instead of HTTP 422.
  - New in-memory job store (`apps/api/server/lib/jobs.ts`) and
    `GET /campaigns/jobs/:id` poll surface (404 for unknown/missing — restart).
  - Web `run-context` polls the job until completed/failed; GET 404 recovers
    from `GET /campaigns/result?campaignId=`. Classic mode uses the same path.
  - `apps/api/bin/generate.ts` unchanged.
- **Decisions:**
  - Jobs live at the API edge (hexagonal); no Prisma/BullMQ/SSE. Process
    restart empties the Map → GET 404 → UI restores the last persisted report
    or throws a clear "job lost" error.
  - No pipeline progress hook: `done`/`total` stay 0 while running and equal
    `assets.length` (or 0 if halted) on complete. Poll interval 250ms; first
    GET is immediate.
- **Left open:**
  - SSE / persisted queue is a later optional train. N=100 still in-process.
## 2026-08-25 — brief schema v2 (optional fields + parse allowlist)

- **Mode:** Implementer
- **Changes:**
  - `CampaignBrief` gained optional `mode`, `variation`, and `output` (absent =
    classic behaviour).
  - `parseBrief` allowlists P0 axes (`layout`, `tone`, `background`,
    `paletteShift`) and formats (`static`); unsupported axes/formats/`pool://`
    throw with the name in the message (HTTP 400 via existing generate route).
  - Documented `?model=` vs future `genai` axis and un-wired `paletteShift` in
    `pipeline.ts`. Added `briefs/sample-randomized.yaml` (static axes only).
- **Decisions:**
  - Nested layout/tone stay `string[]` on the domain type; enum checks live in
    parseBrief so unsupported axes are rejected at the boundary, not the type.
  - `count` is validated only when present (not required by `variation: {}`).
  - Did not invoke the planner, change generation, or relax MINIMUM_PRODUCTS.
- **Left open:**
  - Phase J (job handle), Phase 2 (planner / VariationPolicy), pools, motion.
## 2026-08-25 — SeededRandom + scoped determinism lint

- **Mode:** Implementer
- **Changes:**
  - Added `SeededRandom` VO + `seedFrom` (mulberry32 + FNV-1a) in shared, with
    golden tests; hexagen barrels re-export it.
  - Owned a files-scoped ban on `Math.random` / wall-clock `Date` via per-context
    eslint templates on `shared` and `CampaignOrchestration`.
- **Decisions:**
  - Landed D14 through `bounded_contexts[].generator.eslint.template`, not a
    hand-edit of generated `eslint.config.js` (hexagen would overwrite it).
  - Excluded `PipelineExecutionLog.vo.ts` from the Date restriction rather than
    injecting a clock.
- **Left open:**
  - Phase 0.3–0.6, Phase J, the planner.
## 2026-08-25 — review docs/planning/randomizer-and-motion.md

- **Mode:** Reviewer
- **Changes:**
  - None to source. Read-only review of the randomized-campaign / motion / create-project plan against CampaignOrchestration, the compositor, generate POST, HITL identity keys, and hexagen port placement.
- **Decisions:**
  - Verdict: needs revision before implementation. Direction is sound (seeded planner, GenAI only in approved pools, ffmpeg motion as follow-on) but several contracts conflict with current code (asset identity, byte-determinism, port ownership, sync generate timeout, MINIMUM_PRODUCTS, existing /brief editor).
- **Left open:**
  - Plan author should resolve the blocking issues in the review before PRs start. Open product calls in the plan (ffmpeg-static vs system, audio, copy-pool provider, GenAI video) still need a decision.

## 2026-08-25 — revise docs/planning/2026-08-25_randomized-campaigns-and-motion.md (v2)

- **Mode:** Author
- **Changes:**
  - Plan rewritten to v2 against four reviews, in the dated planning-doc format (locked decisions D1–D14, findings C/H/M/L, phase tables, DoD). Verified in code: identity key in `report.ts keyOf` / `run-context assetKey` / `RegenerationTarget`; `MINIMUM_PRODUCTS = 2`; three fixed canvases; `/brief` is a live editor; clock use in `PipelineExecutionLog` and Firefly IMS; no `output/cache`; `.mp4` absent from output content-types; `.pools.json` would match the briefs lister; CI Node 22; hexagen `@generated` barrels.
- **Decisions:**
  - ffmpeg-static (pinned, tech-stack row + GPL note); no audio in motion MVP; OpenRouter chat text adapter for copy pools; GenAI video deferred.
  - Determinism split into three tiers (plan / composite / sources+container); job handle (202 + polling) pulled into the MVP before generate-from-plan; variant identity `productId/variantIndex` migrated in one PR across all consumers; ports (`VideoCompositorPort`, `CopyGeneratorPort`) in CampaignOrchestration; parser allowlist rejects not-yet-supported axes; `/brief` stays the editor and gains Save; `MINIMUM_PRODUCTS` relaxed to 1 in variation mode; safe insets applied at generation (default 0); packaging never re-renders; brand floor static across `t`, no logo-hold detector; lint rule scoped to domain + planner.
- **Left open:**
  - Offer reels/tiktok in the static MVP (recommend no until motion); 4:5 ratio timing.

## 2026-08-25 — wave 1 orchestration + review (PRs #39–#42)

- **Mode:** Reviewer (orchestrating Grok as Implementer)
- **Changes:**
  - Grok (`grok -p`, three worktree subagents + a verifier) implemented plan P0 (#41 SeededRandom + lint, #40 brief schema v2) and Phase J (#42 job handle). Each PR reviewed here at high effort; bot findings (Qodo, CodeRabbit) verified against the code.
  - Fix commits pushed to all three: #41 `486ad9a` (int32 state wrap, seed validation, lint fragment owned once + all bounded contexts, `Date()`/`globalThis`/`crypto`/`performance` gaps closed); #40 `81898c9` (`runCampaign` refuses `mode: variation` until the planner exists, `count` required, `pool://` names the real axis); #42 `6332173` (bounded job store + TTL, honest lost-job handling, cancellable backoff polling, 409 per-campaign guard, one `fetchPersistedRun`).
  - Every bot review thread answered and resolved; a disposition comment on each PR records what was refuted and why. Plan revised to v2.1 (#39 `5d82383`) with the review-derived corrections.
- **Decisions:**
  - Bot findings were all real; the `/code-review 40` run reviewed the working tree instead of the PR — its plan-level findings went into #39.
  - Refused: clock injection into `PipelineExecutionLog` (D14 keeps the exemption for wave 1), a `JobStore` port at the composition root (edge concern, single implementation), `Result<T,E>` as the job wire shape, dropping `done/total` (agreed Phase J shape).
- **Left open:**
  - Follow-ups noted in the plan's wave-1 status: clock injection, one `mockPipelineApi` test fixture, real progress from `PipelineExecutionLog.totalOperations`. Worktrees `../cf-wt-*` remain until the PRs merge.

## 2026-08-25 — variation planner (Phase 2.1–2.3)

- **Mode:** Implementer
- **Changes:**
  - Added `VariationPolicy`, `VariationPlan`, `Variant` (`variantTreatmentId`), and `MotionKind` (`restT` table) in CampaignOrchestration.
  - Added pure `PlanVariationsUseCase.plan` / `replan` with seeded draws, coverage minimums, Hamming `minDistance`, `count×3` candidate cap, and a 64-draw replan bound.
  - Manifest + `yarn sync` barrels. Golden tests pin `policyHash` and the first three variants. Did not touch `GenerateCampaignUseCase` or `pipeline.ts`.
- **Decisions:**
  - Stored `policy` and `briefId` on the plan so `replan` does not need the original brief.
  - Background axis values are `procedural | asset-pool | genai` (brief parser), not the rendered-asset `BackgroundSource`.
  - `perRatio` coverage is one walk of ratios after the product pass (skip if already ≥ perRatio).
- **Left open:**
  - Phase 2.4 consume the planner from `GenerateCampaignUseCase`; identity migration (2.5); GenAI cache (2.6).
