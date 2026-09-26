# Tech Stack Reference

The explicit, canonical list of tools. Read this before suggesting any library —
if it is not here (or is in "Never Suggest"), do not introduce it without asking.

## In Use

| Tool          | Purpose       | Notes                                              |
| ------------- | ------------- | -------------------------------------------------- |
| Next.js       | Web framework | App Router. Do not add Pages Router.               |
| React         | UI            | Function components + hooks; no class components.   |
| TypeScript    | Language      | `strict: true`. No `any` — narrow or use `unknown`. |
| Vitest        | Test runner   | `import { describe, test, expect } from "vitest"`; `vi` for mocks. |
| @testing-library/react | UI tests | Render/query components under happy-dom; assert with `expect`. |
| happy-dom     | Test DOM      | Vitest `environment: "happy-dom"` for the web project.           |
| ffmpeg-static | Video encode (motion creatives) | Pinned 5.3.0 (exact, both package.jsons); GPL-licensed binary — note for client distribution |
| PostgreSQL    | Database (store of record, D169) | D174a, stamped 2026-09-24: hosted on the owner's **Aiven** service (15 connections in all — the pool is bounded, `DATABASE_POOL_MAX`, default 5). Reached over TLS that verifies the server certificate against the service CA (`DATABASE_CA_PATH`). Schema changes are plain SQL files in `apps/api/server/lib/db/migrations/`, applied by `yarn db:migrate`. |
| `pg`          | Postgres driver | `apps/api` only, behind the `SqlClient` interface (`lib/db/sql-client.ts`); adapters never import it. |
| `@electric-sql/pglite` | Postgres in process, **tests only** | A real Postgres (WASM) per test, so database tests need no server and never touch the Aiven service. Single connection: it cannot test two writers racing — for that one case (the PT-6a job-claim concurrency test), CI runs a `postgres:17` service container (`.github/workflows/ci.yml`, job-level `services:`) and the test connects to it over `TEST_DATABASE_URL`, skipped when that variable is unset. Every other database test stays on PGlite. |
| `yaml`        | YAML load/dump | `apps/api` (brief load + Document patch writes) and `packages/shared` (canonical `dumpBrief`). One library, one schema — the package default, YAML 1.2 — for both load and save. Alias expansion capped (`maxAliasCount`). |
| `better-auth` | Authentication (D174b) | `apps/api` (server) and `apps/web` (client: `createAuthClient` from `better-auth/react` with the `organizationClient` and `magicLinkClient` plugins, `basePath: "/api/auth"`, same-origin through the Next rewrite; PT-1b2). Off by default (`AUTH_MODE=local`; opt in with `AUTH_MODE=better-auth`, which requires `STORE_BACKEND=postgres`). Google and email (magic link) sign-in, organisations mapped onto `org` (0001/0008) rather than a second table. Its schema ships as our numbered migration (`0008_auth.sql`), applied by `yarn db:migrate` like every other table — `lib/auth/` adapters never import its bundled query builder (Kysely), which is a transitive dependency, not a way for this codebase to write SQL. |

> Keep this table accurate. When you add a dependency (or a Hexagen template
> adds one), add its row here in the same change — a stale stack reference is
> how agents start hallucinating.

## Never Suggest

- **Jest / Mocha / Chai** — this project uses Vitest (with `@testing-library/react`
  + happy-dom for UI). Do not add a second test runner.
- **Pages Router** — App Router only.
- **`any`** — use a precise type, a generic, or `unknown` with narrowing.
- **An ORM or query builder (Prisma, Drizzle, TypeORM, Kysely, Knex)** — adapters write SQL through
  `SqlClient`, and migrations are plain SQL files. Older project documents mention Prisma; it was never
  adopted.
- **Tests against a remote database** — use PGlite (`lib/db/__tests__/pglite-client.ts`). `DATABASE_URL`
  names the owner's service; only `yarn db:ping` and `yarn db:migrate`, run by the operator, reach it.
- A new HTTP client, date library, or state manager **before checking** whether
  the standard platform API (`fetch`, `Intl`, React state) already covers it.

## Per-Template Additions

Hexagen templates extend this stack. After installing a template, add its
primary packages here — e.g. BullMQ + ioredis (background jobs), LangGraph
(agent graphs), Supabase (storage). Run `hexagen validate-templates` to see
what is installed.
