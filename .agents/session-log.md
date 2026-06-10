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
