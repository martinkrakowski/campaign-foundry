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

## 2026-08-25 — briefs API (Phase 1.1–1.2)

- **Mode:** Implementer
- **Changes:**
  - `POST /campaigns/briefs` (409 unless `?replace=1`), `PUT /campaigns/briefs/:id`,
    `POST /campaigns/briefs/:id/duplicate`, `POST /campaigns/assets`.
  - Write helpers: confined path resolve, yaml dump in sample key order, asset
    name/magic/size checks. README authoring curl block. Route tests under
    `mkdtemp` `PROJECT_ROOT`.
- **Decisions:**
  - PUT rewrites existing `.yaml`/`.yml` only (404 on JSON-only); JSON is
    replaced via `POST ?replace=1` which writes `<id>.yaml`.
  - Asset `name` is `SAFE_ID_PATTERN` plus `.(png|jpg|jpeg)`. Writes only under
    `assets/inputs/<briefId>/` (demo logos at `assets/inputs/*.png` cannot be
    overwritten). Local-tool trust model in the route doc.
  - Decoded size is capped at 2 MiB (413) before magic so a huge payload is
    rejected without a header scan.
- **Left open:**
  - Phase 1.3–1.6 UI (Save to briefs/, BriefPicker create/duplicate, wizard).

## 2026-08-25 — briefs API review fixes (PR #47)

- **Mode:** Implementer
- **Changes:**
  - `findBriefFileById`: POST/PUT/duplicate key off `brief.id` (filename may differ)
    and rewrite the found file in its own format (JSON vs yaml). README examples
    use `summer-hydration-2026` / `winter-summit-2026`.
  - Creates use `writeFile(..., { flag: "wx" })` (EEXIST → 409). Rewrites `lstat`
    and 400 if the target is a symlink. Asset uploads 413 on encoded size before
    decode as well as after.
  - `dumpBrief` orders known keys then emits remaining ones. `?replace=1` uses
    the first query value when repeated.
  - Shared `assertSafeId`, `errorMessage` on the new routes, `briefs.get.ts`
    uses `briefsDir()` + `BRIEF_SOURCE_EXTS`, output GET uses `resolveConfined`.
    Dropped `briefFileName` and the JSON-only PUT 404.
- **Decisions:**
  - PUT rewrites json in place (dropped "JSON briefs must be replaced via POST").
  - YAML comments lost on PUT is inherent to re-serialising — documented on PUT.
  - Left as-is: duplicate keeps source `logoPath` (shared inputs), YAML scalar
    coercion, `withTempProjectRoot` test helper.
- **Left open:**
  - Phase 1.3–1.6 UI.
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

## 2026-08-25 — variation planner review fixes (PR #46)

- **Mode:** Implementer
- **Changes:**
  - Coverage is now a property of the accepted set: round-robin deficient
    products/ratios (retry distance rejects), then fill to `count`; fail up
    front when `perProduct × |products|` or `perRatio × |ratios|` exceeds
    `count`; `err` naming the first unmet product/ratio after planning.
  - `replan` refuses a substitute that would break coverage; bounded redraw.
  - `VariationPolicy.fromBrief` validates count/minDistance/coverage/seed/
    paletteShift and canonicalises option lists before `axisProductSize` and
    `policyHash`. Shortfall messages include `accepted` and `minDistance`.
- **Decisions:**
  - Hamming axes live on the policy VO (`DISTANCE_AXES`) so `minDistance`
    cannot exceed the axis count. Planner stays pure (no clock / Math.random).
  - Golden `policyHash` and first-three-variant literals did not change
    (zero coverage + unique lists are identity for the golden brief).
- **Left open:**
  - Phase 2.4 consume the planner from `GenerateCampaignUseCase`.
## 2026-08-25 — platform packaging (Phase 5.1+5.3)

- **Mode:** Implementer
- **Changes:**
  - `PlatformProfile` table in Distribution (three canvases only; motion platforms hidden).
  - `PackageStorePort` + `FileSystemPackageStore` + `PackageForPlatformUseCase`: copy matching-ratio statics under `output/<campaignId>/platforms/<id>/` and write `manifest.json`. Never re-renders.
  - `POST /campaigns/package` wires the use case at the route; `readReport` helper shared with `GET /campaigns/result`.
- **Decisions:**
  - LinkedIn is 1:1 static (this wave's table wins over the long-form `1:1 | 16:9` note).
  - `safeInsets` are zeros; `maxBytes` is 8 MiB static / 100 MiB motion (documented caps, not live APIs).
  - Empty ratio selection still writes an empty-items manifest so the platform folder exists.
  - Port/adapter omitted from the hexagen manifest: listing them emits `*.out-port.ts` / `*.adapter.ts` stubs that clash with neighbour names (`ExportPort.ts`, `FileSystemExporter.ts`). Hand-export the port from `application/ports/out/index.ts`.
  - Distribution `src/index.ts` re-exports application + domain (hexagen modular-monolith mode does not refresh the package root barrel when new layers gain content).
- **Left open:**
  - Phase 5.2 (safe insets at generation) and 5.4 (export-page UI). Motion profiles stay `visible: false` until P4.

## 2026-08-25 — PR #48 packaging review fixes

- **Mode:** Implementer
- **Changes:**
  - Use case catches store errors per platform (`Platform "<id>": <reason>`, absolute paths stripped) and the route maps use-case `err` to 422.
  - Adapter stages each platform in `<platformDir>.staging-<random>` then `rm -rf` + `rename` so a failure never leaves a mixed folder and a smaller re-package drops stale files.
  - Packaging moved to `output/packages/<campaignId>/<platformId>/`. Shared `resolveSafe` helper; campaign root resolved in the adapter constructor; `readFile` Buffer returned as-is.
  - Exported `isPersistedAsset` (productId/aspectRatio/treatment/outputPath); invalid rows skipped + counted on the manifest; non-array `assets` → 422. Duplicate platform ids de-duplicated in order.
  - `packagedAt` ISO timestamp injected from the composition-root clock (no `new Date()` in the use case). Removed filled-layer `.gitkeep`s; `yarn sync` barrel-exported `safe-path.ts`.
- **Decisions:**
  - Refuted Qodo "old campaign packages newer bytes": renders are not campaign-namespaced; that is wave-3 identity/output-path work. The package is explicitly the current output for that report (`packagedAt` + route/README sentence).
- **Left open:**
  - Wave-3 campaign-namespaced output paths. Phase 5.2 / 5.4.
## 2026-08-25 — drawCreative extract (Phase 4.2)

- **Mode:** Implementer
- **Changes:**
  - Recorded 12-cell compositor PNG goldens (both layouts × both tones × three ratios, procedural hydra-bottle `#1473E6` background + bundled logo) from the pre-refactor compositor, then split `NodeCanvasCompositor.compositeAsset` into `prepareCreative` (I/O) and `drawCreative(ctx, prepared, t)` (pure blit; `t` ignored, stills pass `t = 1`).
  - Golden sha256 fixture is the wave-3 safety net; hashes unchanged after the extract.
- **Decisions:**
  - wrapText stays in `drawCreative` on the real ctx (drawing-adjacent, not filesystem I/O) so measureText cannot drift.
  - No barrel or manifest *file* was edited. The `@generated` barrels `export *` from `NodeCanvasCompositor.ts`, so the new module-level `PreparedCreative` / `drawCreative` exports still leaked from `@campaignfoundry/CreativeGeneration`'s root (and through them `@napi-rs/canvas` `Image` / `SKRSContext2D`). Hexagen has no non-barreled `internal` export path.
- **Left open:**
  - Phase 4.3 motion (background + headline only; band and logo static across `t`).

## 2026-08-25 — compositor goldens keyed by platform

- **Mode:** Implementer
- **Changes:**
  - Keyed the 12-cell PNG sha256 fixture by `darwin` / `linux` so CI (FreeType) and local (CoreText) both assert byte-identity without changing draw/prepare.
- **Decisions:**
  - Missing `process.platform` failed the test (did not skip) in this commit. See the following entry for arch-keyed maps and skip-on-missing.
- **Left open:**
  - none.

## 2026-08-25 — PR #45 review: public surface, golden keying, evidence

- **Mode:** Implementer
- **Changes:**
  - `NodeCanvasCompositor.prepare(request)` / `.draw(ctx, prepared, t)` are static members; `PreparedCreative` is module-private (not exported). The barrel surface stays the class. Dropped unused `PreparedCreative.subtle` — tone still drives `shadeAlpha` / `fontWeight` locally; draw path unchanged.
  - Goldens keyed by `${process.platform}-${process.arch}` (`darwin-arm64`, `linux-x64`). Missing or empty map skips via `test.skipIf` with a message naming the key and how to record it. Key-resolution helper unit-tested.
- **Decisions:**
  - Darwin hashes were recorded at `6263f1d` (pre-refactor) and are unchanged through the refactor — proven identity on darwin. The linux map was recorded from CI *after* the refactor, so it pins the refactored output going forward but does not prove identity on the FreeType path.
- **Left open:**
  - none.
## 2026-08-25 — shared mockPipelineApi helper

- **Mode:** Implementer
- **Changes:**
  - Exported `json`, `jobOk`, and `mockPipelineApi({ report?, job?, post?, result? })` from `apps/web/src/__tests__/helpers.ts`.
  - Wired the four fetch-router copies (vitest.setup `beforeEach`, `seedPersistedRun`, `seedSingle`, run-context `mockApi`) through that helper; removed duplicate local `json` helpers in coverage-gaps, run-context, grid, and shell-modals tests.
- **Decisions:**
  - Default POST jobId stays `job-1` (run-context); other call sites still passed `post` so `test-job` / `seed-job` (and pending POST) were unchanged in this first pass.
  - `mockApi` is a thin wrapper that forwards `{ post, job, result }` so run-context call sites stay as they were.
- **Left open:**
  - Consolidation was not complete. Remaining hand-rolled `fetch` routers: `coverage-gaps.test.tsx` (POST → 500 "boom"; pending POST; telemetry `seedLog`), `grid.test.tsx` (pending POST, empty / one-asset report), `shell-modals.test.tsx` (`/campaigns/briefs` via GET, telemetry `seedLog`), `run-context.test.tsx` (`campaignId=…` routers, restore `mockResolvedValue` / `mockRejectedValue`). `mockApi` alias still present. Per-site `post` overrides still existed only to pick `seed-job` / `test-job`.

---

## 2026-08-25 — mockPipelineApi review findings

- **Mode:** Implementer
- **Changes:**
  - Dropped the `mockApi` alias; run-context call sites use `mockPipelineApi`. Converted the remaining 1:1 hand-rolled fetch routers (coverage-gaps POST 500 / pending POST / telemetry seedLog; grid pending POST + empty/one-asset reports; shell-modals `/campaigns/briefs` via `result` + telemetry seedLog; run-context `campaignId=…` + restore resolve/reject) onto `{ post, job, result, report }`.
  - One `EMPTY_REPORT` + `MockReport` type; job-GET default is `jobSnapshot` of that report (`log: { entries: [] }` when `log` is null). Optional `jobId`; dropped `test-job` / `seed-job` post overrides. `mockPipelineApi` spies `fetch` when it is not already a mock. Job route matches `${API}/campaigns/jobs/`. Fresh-Response comment lives on `json()`.
- **Decisions:**
  - `done/total = 0` when `halted` matches production `completeJob` (`apps/api/server/lib/jobs.ts`); the old inline fixture that used asset length on a halted job was wrong — left `jobOk` as-is.
  - Remaining custom `post`/`job`/`result` callbacks are the helper's extension points (inspect POST body, hang a POST, toggle `posted`, poll sequencing) — not duplicate routers.
- **Left open:**
  - No hand-rolled `vi.mocked(globalThis.fetch).mockImplementation` routers remain.
## 2026-08-25 — inject log clock (D14 follow-up)

- **Mode:** Implementer
- **Changes:**
  - `PipelineExecutionLog` constructor is now `(campaignId, now)`; `startedAt` / `record` / `complete` call `now()`. No default clock in the domain.
  - `GenerateCampaignDeps.now` is required; `buildPipeline` supplies `() => new Date()`. Tests use a fixed/sequenced fake clock and assert exact timestamps.
  - Dropped the CampaignOrchestration eslint ignore of `PipelineExecutionLog.vo.ts` (manifest template + `yarn sync`).
- **Decisions:**
  - No `now` default in the use case either — application/use-cases is under the same deterministic-core lint.
  - Composition root is the only place that may close over `new Date()`.
- **Left open:**
  - none for this follow-up.

---

## 2026-08-26 — generate variation campaigns from the planner

- **Mode:** Implementer
- **Changes:**
  - `GenerateCampaignUseCase` consumes `PlanVariationsUseCase` when `mode: variation`; cells are plan variants; `MINIMUM_PRODUCTS` is 1 in that mode. Classic matrix/keys/paths unchanged.
  - Variant identity `productId/v<index>` migrated across the use-case matcher, `RegenerationTarget`, `report.ts`, `parseRegenerateOnly`, `run-context` `assetKey`, grid/export/runs/compliance. `POST /campaigns/plan` dry-runs the planner.
  - GenAI seed cache (`BackgroundCachePort` + `FileSystemBackgroundCache`); procedural `paletteShift` hue-shift. Sample randomized brief now generates 12 variants.
- **Decisions:**
  - Classic assets omit `format`/`descriptor`/`variantIndex`/`seed` so report JSON stays byte-identical.
  - Web `assetKey` mirrors domain `assetIdentity` rather than re-exporting it: a client-bundle import of CampaignOrchestration fails webpack resolution of `.js` specifiers onto `.ts` sources (`transpilePackages` is not enough). Fixtures are pinned in tests.
  - Hexagen `yarn sync` skipped existing adapter barrels; `FileSystemBackgroundCache` was added to the generated `adapters/index.ts` by hand so the package export exists.
- **Left open:**
  - Webpack `extensionAlias` for `.js` → `.ts` on `next.config.ts` (not this lane) would let the web app re-export `assetIdentity` at runtime.
  - Packaging still types `PersistedAsset` with required `treatment`; variation rows without treatment pass the guard but are slightly unsound for `PackageableAsset`.

---

## 2026-08-26 — persist briefs and create-campaign wizard (wave 3 lane B)

- **Mode:** Implementer
- **Changes:**
  - Typed web client `apps/web/src/lib/briefs-api.ts` for list/create/replace/update/duplicate/upload/plan. Plan 404 and network failure return `{ kind: "unavailable" }` so the wizard does not depend on lane A's `POST /campaigns/plan`.
  - `/brief` keeps the in-memory Save → `/grid` loop and adds **Save to briefs/** (POST create, 409 → Replace with `?replace=1`) and **Save as…** (POST the in-memory editor under a new id).
  - `BriefPicker`: **Create new** → `/new`; **Duplicate** prompts for a path-safe id, POSTs `/campaigns/briefs/:id/duplicate` with `{ newId }`, reloads, `setBrief(copy)`.
  - Wizard at `(shell)/new`: type → products → copy → (policy) → output → review. Classic ≥2 products, randomized ≥1 (D10). Estimate panel debounces `POST /campaigns/plan`. No "Generate suggestions".
- **Decisions:**
  - Save-as on a dirty editor POSTs a cloned brief (new id) rather than the duplicate endpoint, which copies the on-disk file and would drop unsaved edits.
  - YAML preview copies `BRIEF_KEY_ORDER` locally; no `js-yaml` (web has no such dependency).
  - SAFE_ID_PATTERN is duplicated in the web app (value-importing CampaignOrchestration barrels breaks the Next build).
  - `PUT /campaigns/briefs/:id` is implemented on the client but unused by the UI (create + `?replace=1` covers persist).
- **Left open:**
  - Lane A lands `POST /campaigns/plan`; until then the estimate panel shows "estimate unavailable" on 404.

---

## 2026-08-26 — PR #51 review findings (brief save + wizard)

- **Mode:** Implementer
- **Changes:**
  - `/brief` merges editor drafts over loaded products by id (keeps `inputAsset` and other optional fields) and re-initialises the form when `brief.id` changes. Save is disabled while `form.id !== brief.id`.
  - Wizard policy validation matches `VariationPolicy.fromBrief` (seed uint32, minDistance 0–6, coverage ≥ 0). Empty axis selections block Next instead of omitting the axis (omitted = planner defaults).
  - Logo uploads are named `<productId>-<stem>.<ext>`; a 409 for that name is treated as success. Product drafts have a stable `key` for React keys and async upload dispatch; Remove is disabled while that product's upload is in flight.
  - YAML preview quotes scalars js-yaml would retype. EstimatePanel passes `AbortSignal` into `planCampaign` and aborts on edit/unmount; the leave-step test uses fake timers.
  - Stepper sets `aria-current="step"` and moves focus to the step heading after Next/Back.
  - Removed unused `updateBrief`; collapsed `BriefWriteResult` into `BriefEntry`; `fileToBase64` uses `FileReader.readAsDataURL`.
- **Decisions:**
  - Left `PUT /campaigns/briefs/:id` unwired — create + `?replace=1` still covers persist. Dropped the unused client helper rather than adding a second save path.
  - Left the 404 → "estimate unavailable" branch as the network/absent fallback (route exists on `main`).
- **Left open:**
  - none for this review pass.
## 2026-08-26 — compositor optional safeInsets (Phase 5.2 compositor half)

- **Mode:** Implementer
- **Changes:**
  - `CompositeRequest.safeInsets?` (`top/right/bottom/left`). Absent or all-zero keeps today's geometry.
  - `NodeCanvasCompositor.prepare` normalizes insets and offsets the captured logo anchor; `draw` offsets the headline first/last baseline. Accent band, shade, background, and `t` are unchanged.
  - Existing 12-cell goldens still omit the field (byte-identical). New `compositor-goldens-insets.json` records one `headline-top/bold/9:16` cell with `{ top: 120, bottom: 200 }` on `darwin-arm64`, skip-on-missing-key. Structural test spies `fillText`/`drawImage` on every ratio × layout.
- **Decisions:**
  - Logo offset lives in prepare (that is where x/y are captured); headline offset lives in draw via threaded `PreparedCreative.insets`. Callers are not wired — GenerateCampaignUseCase still omits the field.
- **Left open:**
  - Lane A / later wave: union of platform-profile insets at generate time. Linux inset golden not recorded (skipIf).

---

## 2026-08-26 — PR #49 review: wrap, clamp, overlap, validation

- **Mode:** Implementer
- **Changes:**
  - Exported `SafeInsets` (`readonly` top/right/bottom/left, all required) from `CompositorPort`. Example: `{ top: 120, right: 0, bottom: 200, left: 0 }`.
  - Headline wrap width is `(width - left - right) * 0.85`; `fillText` centres at `left + (width - left - right) / 2`.
  - After insets, the headline block is clamped (first baseline ≥ `top + fontSize`, last ≤ `height - bottom`). If it still cannot fit, `fontSize` drops by 4 px to 40 % of original, then lines truncate with `…`.
  - Logo stays inside the inset rectangle (clamped in prepare). If the still headline box overlaps it, draw snaps the logo to the opposite inset edge, or the other edge if that is the only clear one.
  - `prepare` throws an `Error` naming the side for NaN / non-finite / negative / over-size insets.
  - `t` stays ignored (`void t`). Logo inset offset stays in prepare. Structural tests are the platform-independent guard; darwin-arm64 inset golden kept.
- **Decisions:**
  - Zero-inset / omitted path keeps the original wrap, centre, logo additive offset, and font size so PNG bytes stay identical (12-cell goldens unchanged).
  - `Distribution.PlatformProfile.safeInsets` should adopt `SafeInsets` when generation wires profiles through — next wave, out of this lane.
  - Inset pixel golden stays laptop-only until a linux map is recorded from CI (same caveat as #45).
- **Left open:**
  - Lane A / later wave: union of platform-profile insets at generate time; overlap-vs-headline must re-run per frame once headline position depends on `t`.

---

## 2026-08-26 — PR #50 review fixes (lane A)

- **Mode:** Implementer
- **Changes:**
  - Merged `origin/main` (#49 safe insets); session-log kept both sides.
  - Replan pins `productId` + `aspectRatio`; rejects `attempt < 1`. Variation assets stamp `attempt` (0 originals). Web derives next attempt from the loaded asset; `attemptByKey` removed.
  - Variation `regenerateOnly`: productId must match the planned slot, index in range, duplicates de-duped; classic-only targets err "targets do not match the brief mode".
  - Print proof pinned to the first 1:1 variant per product in plan order.
  - Background cache: failed `set` still returns bytes + warns; get validates PNG magic + length and deletes junk; atomic tmp+rename; in-flight set de-dupe. `GET /output/**` 404s `cache/*`; dropped redundant `/output/cache/` gitignore.
  - `isPersistedAsset` requires the four strings always; variation rows also need integer `variantIndex` and `attempt` ≥ 0.
  - `POST /campaigns/plan` 400 unless `mode === "variation"`.
  - Grid/export/compliance/runs labels include `v<index>`; re-roll updates the tile in place and clears its decision.
- **Decisions:**
  - Omitted re-roll `attempt` defaults to 1 (first re-roll), never 0. Generate still surfaces use-case err as a failed job (Phase J), not a synchronous 422.
  - Qodo #6 (failed variation batch overwrites earlier outputs) is inherited classic behaviour — noted, not changed.
- **Left open:**
  - Webpack `extensionAlias` so the web app can re-export `assetIdentity` at runtime.



---

## 2026-08-26 — Wave 4 lane A: video compositor machinery (PR 13)

- **Mode:** Implementer
- **Changes:**
  - `VideoCompositorPort` (`VideoCompositeRequest extends CompositeRequest` + `durationSec`/`fps`/`motion`/`sampleAt`; result = `video`/`poster`/`sampledFrames`/`logoApplied`) exported from the hand-maintained `ports/out/index.ts`.
  - `NodeCanvasCompositor.draw(ctx, prepared, t, motion?)` animates the four `MOTION_KINDS` with easeOutCubic; solid accent band + logo static at every `t`; logo-overlap re-checked against the risen headline box per frame. Golden test proves byte-identity to the still at `restT(kind)` for every kind and cell.
  - `CanvasFfmpegVideoCompositor`: raw RGBA → spawned `ffmpeg-static` (libx264/yuv420p/veryfast/crf 20, `-map_metadata -1`, mp4 to `pipe:1`), stdin back-pressure, poster at `restT`, sampled PNGs, `MAX_CONCURRENT_ENCODES = 2` gate, non-zero exit rejects with a redacted stderr tail.
  - Boot probe: Nitro plugin `ffmpeg-check.ts` → `lib/capabilities.ts` `{ motion, reason? }` (warns, never throws; 5 s timeout); `bin/generate.ts` runs the same probe (log only). `.mp4 → video/mp4` on `GET /output/**`.
  - `ffmpeg-static@5` added to CreativeGeneration and api; tech-stack row added.
- **Decisions:**
  - Ken-burns rest pose is the identity (scale 1.00 at `restT`): `in` eases 1.08→1.00, `out` 1.00→1.08. Anything else cannot be byte-identical to the still.
  - `-movflags +faststart+empty_moov`: the plain mp4 muxer refuses a non-seekable `pipe:1` output; `empty_moov` puts `moov` up front so the stream stays pipe-friendly.
  - `VideoCompositorPort` is **not** listed in `.architecture/manifest.yaml`: no existing port is, and listing it makes `hexagen sync` emit a duplicate `VideoCompositorPort.out-port.ts` stub (`VideoCompositorPortPort`).
- **Left open:**
  - Next wave: unlock `motion`/`duration`/`formats: motion` in the parser, wire the adapter into generation, and read `getCapabilities().motion` there. `GenerateCampaignUseCase`, `load-brief.ts`, the image chain and `apps/web` untouched here.

---

## 2026-08-26 — PR #54 review fixes (lane A, video compositor)

- **Mode:** Implementer
- **Changes:**
  - `CanvasFfmpegVideoCompositor` encodes to a `mkdtemp` file (`-movflags +faststart -fflags +bitexact`, `-y out.mp4`) and reads it back; the dir is removed in `finally`. Output is a finalized mp4: `ftyp moov free mdat`, mvhd duration > 0, `start: 0.000000` (was `empty_moov` fMP4 with duration 0). The integration test walks the boxes with a tiny ISO-BMFF parser.
  - `ffmpeg-static` is now a static ESM import in the adapter and `capabilities.ts`; `resolveFfmpegBinary()` resolves it lazily and never throws (null export / missing / non-executable → `{ motion: false, reason }`). `nitro.config.ts` adds `externals.traceInclude: [require.resolve("ffmpeg-static")]` so the package + binary land in `.output/server/node_modules`. Verified locally: build, boot 3 s, `curl /` → 200 (previously died with `Cannot find module 'ffmpeg-static'`).
  - Golden matrix tests carry `{ timeout: 60_000 }` (Vitest 4: options are the second argument) and draw the still from the same `prepare()` as the four rest-pose frames.
  - Under `CI`, the real-binary suite asserts `ffmpegOk` instead of skipping; a new real-binary test spawns with `-not-a-real-flag` and checks the EPIPE path rejects cleanly and releases the gate.
  - `encodeTimeoutMs` (default 120 s) + `killGraceMs` (default 2 s): SIGTERM at expiry, SIGKILL after grace, clear rejection; gate and temp dir released in `finally`. Tested with hung fakes.
  - Logo overlap is resolved from the rest-pose headline box, so it is identical at every `t` for every motion kind (tests go red on the previous per-frame behaviour).
  - Validation: `fps` integer in [1, 60], `durationSec` finite in (0, 60], `sampleAt` finite in [0, 1], de-duplicated and sorted; all throw `VideoCompositeValidationError`.
  - Nits: `ffmpeg-static` pinned to exact 5.3.0 (both package.jsons + tech-stack row); path redaction matches absolute paths only (root + segment + separator) and the tail is taken after redaction; CLI probe capped at 2 s; `capabilities.ts` documents that Nitro does not await async plugins.
- **Decisions:**
  - `traceInclude` needs the resolved file path: a bare `"ffmpeg-static"` stays external in rollup and node-file-trace then looks for `apps/api/ffmpeg-static` and fails the build.
  - Logo placement is derived from the rest-pose box in `draw` rather than cached in `prepare`: `layoutHeadline` needs a measuring context, and the rest-pose box is a pure function of the prepared creative, so the result is the same every frame.
  - CLI probe is capped rather than gated on `output.formats: motion` — the parser still rejects `motion`, so the gate would be dead code until the next wave.
- **Left open:**
  - Next wave: unlock `motion` in the parser, wire the adapter into generation, gate the CLI probe on the brief.
