# Test Postgres Harness — Architecture & Development Plan

**Date:** 2026-09-29
**Status:** **r1 — PROPOSED.** D186 awaits the owner. Needs a plan review (Fable) before dispatch.
**Decision ids introduced:** D186
**Lane ids introduced:** TP1. `git grep -P '\bTP[0-9]'` over `docs/planning/` was empty; the known positive `\bHX7\b` matched with the same command.
**Relates to:**
- `2026-09-29_wave-hardening-and-w05-follow-ups.md` (the loaded-host findings, and M6);
- the midnight gate measurement of 2026-09-29, recorded in §1.

---

## 0. What this plan answers

Every database test starts a fresh **PGlite**, which is Postgres compiled to WebAssembly. That costs almost nothing on the owner's M3 Max or on CI's runners, but **5.2–6.5 s per start on midnight** (Intel Xeon E5-2697 v2, 2013, no AVX2). There, 245 of 8,308 tests time out at 5 s, and `yarn gate` cannot pass. A PGlite template clone would not help, because the cost is the WASM boot itself: a *second* start still took 5.2 s.

The fix is a **real, long-running test Postgres**, selected by environment, with one migrated template database that each test file copies in milliseconds. Where `TEST_PG_URL` is unset, PGlite stays exactly as it is today, so the Mac and CI change nothing unless they opt in.

---

## 0.1 Proposed decision

| id | Decision |
|---|---|
| **D186** | **The test harness can run database tests against a real Postgres server named by `TEST_PG_URL`.**<br>- When it is set, each migrated test database is a copy of a template (`CREATE DATABASE … TEMPLATE`) that is migrated once per migration-set hash. Each empty test database is a fresh `CREATE DATABASE`. Each is dropped when the test or file finishes, through the same single-connection `SqlClient` shape PGlite has today.<br>- When it is unset, PGlite is used, unchanged.<br>- **The staging database is never a test target.** The test server is a separate Postgres 18 (staging's major version) on the host that runs the lanes, bound to loopback.<br>- `TEST_DATABASE_URL` keeps its current meaning (the CI concurrency proofs) and is not reused. |

---

## 1. Verified findings

| id | Severity | Finding | Evidence |
|---|---|---|---|
| **M1** | Medium | **PGlite start-up exceeds the 5 s test budget on midnight.** One `PGlite.create()` plus `select 1` measured 6,494 ms, and 5,244 ms for a second instance in the same process. `yarn gate` there took 890 s; `test:cov` failed 245/8,308 in 35 files, nearly all `Test timed out in 5000ms` in Postgres-harness files (create, briefs-team, draft, last-opened, provider-keys, id.get, membership). The failure was unchanged with `TMPDIR` on `/tmp` instead of the mergerfs pool, so it is the CPU, not the filesystem. | the midnight probe worktree `cf-probe`; `/mnt/pool/cloud-services/tmp-cf/gate-probe.log` |
| **L1** | Low | **Every migrated test database goes through one function.** `migratedDatabase()` (`apps/api/server/lib/db/__tests__/pglite-client.ts:28`) is used by 31 files, including `setupPgHarness` (`apps/api/server/routes/__tests__/tenant-harness.ts:209`). Eleven call sites use `pgliteClient()` directly, for an EMPTY database (migrate, db CLI, schema-agreement, database tests). | `git grep` |
| **L2** | Low | **Staging runs CNPG `postgresql:18.6`, while CI's service is `postgres:17`** (`ci.yml:58-59`). The test server should match staging (18). CI stays on its own service. | `kubectl … get cluster cf-pg`; `ci.yml` |

---

## 2. Lane (wave `test-postgres-w01`)

Every lane inherits the pipeline and skill rules: `yarn gate`, 100% coverage, a mutation manifest, no attribution lines, explicit staging, and PGlite as the default. Seat: **space-bunny** (primary). Risk is `normal`: test infrastructure only, no product code.

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **TP1-test-postgres-backend** | normal | **D186.** Enumerated:<br>(1) **`testDatabaseBackend()`** answers `"server"` when `TEST_PG_URL` is set and non-empty, else `"pglite"`. It reads the environment only there (the one test-side read, beside the existing `TEST_DATABASE_URL` reads).<br>(2) **Template, when `"server"`:**<br>- the template is `cf_tpl_<first 12 hex of sha256 over every migration file's name and bytes, in order>`;<br>- if it does not exist, create it, migrate it with the shipped `migrate()`/`loadMigrations()`, and mark it `IS_TEMPLATE`;<br>- template creation is serialized across vitest workers and across hosts' concurrent lanes with `pg_advisory_lock(<fixed key>)`, so two workers never both build it;<br>- a stale template (a different hash) is never dropped while in use; a separate cleanup drops `cf_tpl_*` templates other than the current one that are older than 24 h.<br>(3) **`migratedDatabase()`, when `"server"`:** `CREATE DATABASE cf_t_<pid>_<counter>_<rand> TEMPLATE <current template>`, then a `pg.Client` (ONE connection, the same single-connection semantics PGlite gives) wrapped in the existing `SqlClient` shape (`query`, `exec`, `transaction`, `end`). `end()` closes the client AND `DROP DATABASE … WITH (FORCE)`. When `"pglite"`, today's code, unchanged.<br>(4) **An empty database, when `"server"`:** the 11 direct `pgliteClient()` sites go through a new `emptyDatabase()` that is PGlite when unset, and a fresh `CREATE DATABASE` (no template) when `"server"`, with the same `end()` drop. The call sites change from `pgliteClient()` to `emptyDatabase()` only. No test logic changes.<br>(5) **Orphan cleanup:** a killed run leaves `cf_t_*` databases behind. The template step drops `cf_t_*` databases whose name carries a pid that is not alive on this host AND that are older than 1 h (the creation time is taken from the name), never a live run's. Also a `yarn test:pg-clean` script that drops every `cf_t_*` and stale `cf_tpl_*` on demand.<br>(6) **Docs:** `.agents/testing.md` is never-edit, so the pipeline doc's Template A gains one line: "on midnight, lanes run with `TEST_PG_URL=postgres://cf_test@127.0.0.1:5433/postgres`".<br>**Tests** (they run under BOTH backends where a server is available; the server-only tests `skipIf(!TEST_PG_URL)`):<br>- the backend selection (set, unset, empty);<br>- the template hash changes when any migration's bytes change, and not otherwise;<br>- two concurrent template builds make exactly one template (advisory lock);<br>- a migrated database has every migration applied, and an empty database has none;<br>- `end()` drops the database (it is gone from `pg_database` afterwards);<br>- orphan cleanup drops a dead-pid database and keeps a live one;<br>- the whole existing suite passes with the variable UNSET, byte-for-byte today's behaviour.<br>**CI:** add one CI step that runs the api project with `TEST_PG_URL` pointed at CI's existing `postgres:17` service. That exercises the server path on every PR; Postgres 17 vs 18 is fine for these migrations, and the job notes it.<br>**Acceptance on midnight:** `yarn gate` in a midnight worktree with `TEST_PG_URL` set passes 13/13, and `test:cov` shows no `Test timed out` failures. Record the wall time against the 890 s failing baseline. | `apps/api/server/lib/db/__tests__/pglite-client.ts` (or a new sibling `test-database.ts`), the 11 `pgliteClient()` call sites (the call-site swap only), `package.json` (`test:pg-clean`), a CI step in `.github/workflows/ci.yml`, the Template A line, their tests, `.agents/manifests/tp1-test-postgres-backend.json` | change PGlite's behaviour when the variable is unset; reuse `TEST_DATABASE_URL`; point any test at the staging or Aiven database; raise any test timeout |

**Mutation:** drop `WITH (FORCE)`, or the drop itself, from `end()`. The "`end()` drops the database" test catches it.

---

## 3. Owner actions

1. **Stamp D186.**
2. **Install the test Postgres on midnight** (the command is in the orchestrator's message, 2026-09-29). It runs Postgres 18 in Docker on `127.0.0.1:5433`, with trust auth on loopback and durability off (a test server).

## 4. Definition of done

- D186 is stamped, and TP1 is merged with 100% coverage and its mutation caught.
- CI runs the server path on every PR.
- A midnight worktree's `yarn gate` passes 13/13 with `TEST_PG_URL` set, and its wall time is recorded.
- The orchestrator's dispatch notes (`cast.md`) say which host runs campaign-foundry lanes, with the evidence.
