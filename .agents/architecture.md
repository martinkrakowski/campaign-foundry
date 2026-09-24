# Architecture

Style: **hexagonal**

> An HITL orchestrator for deterministic creative generation and automated brand compliance.

## Who Enforces This

Two things review the architecture, and they do not overlap.

`hexagen arch validate` (`yarn lint:arch`) proves the layer graph **deterministically** from
`.architecture/invariants/layer-rules.yaml`, on every PR, as a merge gate: which layers may
import which, package boundaries, cross-layer relative imports, node builtins in domain/application,
whitelist conformance, subpath conventions, and file placement by layer.

`yarn arch:inventory` (`tools/arch-inventory`) gates the complement the linter cannot see: the
per-context inventories in `.architecture/manifest.yaml` against the module files on disk. Declare a
new port or module **by hand**, editing `.architecture/manifest.yaml` directly, then run
`yarn arch:inventory` (must report no drift) and `yarn sync:dry` (must report `Total ops : 0`) before
committing. **Never run `hexagen arch port` or `hexagen arch context`** to do this: both save the
manifest through a code path (`generateManifestYaml` / `generateManifestYaml2` -> `saveManifest` in
`@hexagen-monaco/sync`'s `dist/cli.js`) that keeps only `system, scope, architecture, bounded_contexts,
monorepo, apps` — it silently drops the top-level `generator:` block, which is where this repo's
`naming` overrides live (see the comment above `generator:` in the manifest). Losing that block makes
the next `sync` scaffold duplicate stub files beside every real port/adapter.

`.github/workflows/pr-agent-arch.yml` is an **advisory** LLM reviewer scoped to the
complement — what the import graph cannot express: whether a port is an abstraction or a
disguised implementation detail, whether adapter failure modes leak through it, whether a
*legal* import pulls an illegal runtime into a bundle, whether layer-correct code belongs to
the layer it sits in, and whether a port is wired to anything. It is given the linter's own
rules so it can recognise and refuse them, and it is not a merge gate.

The split matters: a reviewer that repeats what the linter already proves is worse than no
reviewer, because it teaches people to skim it. See
`docs/planning/2026-08-29_pr-agent-api-and-architecture.md` §2.2.

## Universal Boundary Rules

These hold regardless of style and are enforced in review:

- **Dependencies point inward / downward.** Business logic never imports
  framework, transport, or persistence code. The edges depend on the core, not
  the other way round.
- **No circular dependencies** between modules.
- **I/O lives at the edges.** Network, filesystem, database, and clock access
  are isolated behind a thin boundary so the core stays pure and testable.
- **One reason to change per module.** If a file mixes business rules with
  wiring, split it.

## Layer Conventions

The naming below is the convention for the **hexagonal** style. If
your style differs, keep the *intent* (clear boundaries, inward dependencies)
even if the folder names change.

- **hexagonal** — `domain/` (entities, value objects, pure logic), `application/`
  (use cases + `*.port.ts` interfaces), `infrastructure/` (`*.adapter.ts`
  implementations). Domain imports nothing outward; adapters implement ports.
- **layered** — `presentation/` → `application/` → `domain/` → `infrastructure/`,
  each layer importing only the one below it.
- **feature-based** — top-level `features/<name>/` slices, each self-contained;
  shared code lives in a `shared/` module that features may import but that
  never imports a feature.
- **monolith** — keep modules cohesive and dependencies explicit; resist a
  single god-module by grouping by responsibility.

## Adding Code

1. Identify the layer the change belongs to.
2. If it crosses a boundary, define/extend a port (interface) rather than
   reaching across directly.
3. Put the test next to the module (see `.agents/testing.md`).

## Storage Ports & Cloud Storage Boundary (API)

Everything `apps/api` persists goes through a port in `apps/api/server/lib/ports/`
(`*.port.ts`), with a file adapter (`fs-*-store.ts`) today:

| Port | Holds |
| --- | --- |
| `BriefStorePort` | campaign briefs, revision-checked (a stale write is `ECONFLICT` → 409) |
| `AssetStorePort` | a campaign's input assets (logos, backgrounds) |
| `PoolStorePort` | a campaign's asset and copy pools |
| `TemplateStorePort` | saved creative templates |
| `JobStorePort` | run jobs: the one-run-per-campaign claim, progress, outcome |
| `ReportStorePort` | a campaign's run report, revision-checked |
| `OutputStorePort` | renders, proofs and packages the browser reads |
| `DecisionStorePort` | review decisions: verdict, actor, time and run per creative |

No `node:fs`, path joining, or `process.cwd()` may leak through route handlers or port
interfaces into callers. A port's interface names records by id, never by path.

### Tenant context (D167)

Location and credentials come from the tenant, never from `process.env` below the routes.

- A request resolves a `TenantContext { orgId, userId, roles, teamIds }` (`lib/tenant.ts`).
  Until authentication exists (PT-1) every request is `LOCAL_TENANT`.
- The composition root (`lib/run-environment.ts`) is the only place that reads env. It turns a
  tenant into a `RunEnvironment` (output root, asset root, font, provider settings), and a run
  **captures it at enqueue**, so a job's writes land where the run was admitted, whatever the
  process looks like later.
- Stores are built per root from a `StorageScope` (a tenant, or a run's captured environment):
  `get*Store(scope)` in `lib/ports/index.ts`. A non-local org's root is `<root>/orgs/<orgId>`.
- **Package adapters never see a tenant.** They are constructed with an already tenant-scoped root
  or prefix, so `packages/*` stays tenant-agnostic and a cache is isolated by where it is built,
  not by an org in its key.
- The check that a record belongs to `ctx.orgId` (and, per D166, to one of the member's teams for
  team-scoped campaigns) happens **at the port**, and a record of another org answers as absent
  (404), never forbidden.

### The cloud target (docs/planning/2026-09-24_platform-and-tenancy.md)

Each port keeps its interface; the adapters change.

- **The database is the store of record** (D169; PostgreSQL, D174a). Briefs, pools, templates,
  reports, jobs and decisions become rows. Every record has an immutable surrogate id; a slug is a
  mutable, per-org display column (D64 b, D168). YAML is an import/export format, not a store.
- **Object storage holds bytes only**, in one private bucket, under
  `org/<orgId>/campaign/<campaignId>/<kind>/<assetId>` (`kind`: inputs, renders, packages).
  **A key never contains a slug** (C7): renaming a campaign moves no object.
- **Browsers never get a bucket path** (D170). Every byte a browser reads comes through a
  short-lived signed URL, issued after the port's ownership check; `GET /output/**` retires.
- **The run lock is a job row, not a file or a cache entry** (D171): a one-statement claim guarded
  by a partial unique index on (org, campaign) while running, a heartbeat and reaper so a crashed
  worker releases its campaign, and the run id as a fence on every guarded write.
- **Secrets stay on the server** (D175). An org's own provider keys (BYOK) are stored encrypted,
  are write-only from the browser, and are decrypted only where a provider is called.
- Infrastructure config (the database URL, the bucket) is env, read once at the composition root.
  **Credentials are never committed**; `.env*` is gitignored.
