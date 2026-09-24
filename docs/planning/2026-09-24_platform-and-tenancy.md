# The Platform — tenancy, identity and cloud storage — Architecture & Development Plan

**Date:** 2026-09-24 · **Status:** **r2 — D167 and D173 STAMPED (owner, 2026-09-24); Phase 0 in progress: **PT-0a done** — [#569](https://github.com/martinkrakowski/campaign-foundry/pull/569) (`b3322320`), [#570](https://github.com/martinkrakowski/campaign-foundry/pull/570) (`a48fcc9d`), [#571](https://github.com/martinkrakowski/campaign-foundry/pull/571) (`ca7a9520`). Next: PT-0b1.** D166, D168 – D172, D174 and D175 remain proposed.
r1 was reviewed the same day by Fable 5.1 against `7535e820`. The review found one blocking error
(the Definition of Done's own grep could not fail) and five major ones. All were re-checked against
the code before they were accepted, and one of the review's claims was refuted. §8 records it all.
**Scope:** everything between today's single-process, local-disk tool and the target the owner stated
on 2026-09-24: *a remotely hosted SaaS with user logins, orgs, teams and users in a server-side
database, with every asset cloud-hosted.* It owns the whole D64 deferral list
(`2026-09-03_create-moment-and-pipeline-prerequisites.md` §6) and R6 (`RunRegistryPort`, RW-12).
**Verified against:** `main` at `7535e820`. The code inventory was surveyed file by file, the review
re-verified each citation, and each claim below was re-read before it was written.
**Decision ids introduced:** D166 – D175 (`git grep -ohP "\bD\d{3}\b" -- docs .agents | cut -c2- | sort -n -u | tail -1`
→ 165). **Lane prefix `PT-`**, checked free with `git grep -lP "\bPT-?[0-9]+\b" -- docs .agents` → 0,
where the same command finds 6 files for the known-used `AF` prefix.
**Relates to:** **D64** (b) database-fronted identity and **C7** (assets keyed by a tenant-scoped
immutable id), both **stamped 2026-09-24**; **D72** (ownership and a scope axis on the ports);
**D65** (create is a seam); **D73 – D81** (run exclusion and the distributed lock); **D82** (a second
tab's draft); **D15** (a storage port before the S3 move); **D122**/**D163** (the HTML5 bundle).
**Supersedes:** the slug-keyed S3 sketch in `.agents/architecture.md` § "S3 Adapter Shape", which
C7 contradicts.

Findings carry the house evidence labels: **[code]** read in the tree, **[intent]** a recorded or
stated intent, **[external]** a source outside the repository.

---

## 0. The finding this document exists for

**There is no boundary in this codebase that a tenant could live behind.** Three facts combine:

1. **No identity exists.** A grep for `orgId|organizationId|tenantId|teamId|userId|workspaceId|ownerId`
   across `packages`, `apps/*/src` and `apps/api/server` outside tests finds **0** hits. No package
   declares an auth dependency, and there is no cookie, session or middleware
   (`apps/web/src/middleware.ts` does not exist; Nitro's only plugin is `ffmpeg-check`).
2. **Every id is trusted after a format check.** Routes take a brief id, campaign id or job id from
   the URL, query or body and hand it on after `assertSafeId` / `SAFE_ID_PATTERN` only. No route
   asks who owns the id. `GET /output/**` (`routes/output/[...path].get.ts:58-69`) streams any file
   under the output root except `cache/` and `jobs/`. The package zip route streams from disk too.
   The asset route (`assets.get.ts:40, 52`) goes through its port, but with no ownership check.
3. **Where data lives is process-global.** `outputRoot()` reads `process.env.OUTPUT_DIR` on every call
   (`apps/api/server/lib/config.ts:9`). `projectRoot()` is memoized in a module variable
   (`packages/shared/src/infrastructure/project-root.ts:7`), and **six package adapters** resolve
   brief asset paths against it through `CreativeGeneration/src/infrastructure/safe-path.ts:17`.
   Provider keys come from `process.env` (`pipeline.ts:75-78`). **This exact mechanism produced a
   real defect this week:** a generate run outlived its test and wrote `report.json` into the
   *next* test's `OUTPUT_DIR` (#567). In a multi-tenant server, the same mechanism is one org's run
   writing into another org's space.

The ports (D15) are the right seam, and most persistence already goes through them. The plan's job
is to make the seam carry a tenant, move what bypasses it, and then swap the adapters.

---

## 1. Findings

| # | Sev | Finding |
|---|---|---|
| **C1** | **Critical** | [code] **No tenant boundary anywhere** (§0). Every read and write is addressable by anyone who can name an id, and the output route by anyone who can name a path. |
| **C2** | **Critical** | [code] **Persistence bypasses the ports in these places.** Swapping port adapters alone would leave them on local disk. **(a) Reports** (`lib/report.ts:51-53`), including a **global** "latest run" pointer, `report.json` (`:72`), which `result.get.ts:29` serves when no `campaignId` is given. **(b) Packages:** the listing reads the output tree (`packages/[campaignId].get.ts:20`), the zip streams from disk (`packages/[campaignId]/[platformZip].get.ts:62`), and `package.post.ts:88` reads reports from `outputRoot()` directly. **(c) The output route** (§0.2). **(d) The CLI:** `apps/api/bin/generate.ts` reads a brief by path (`load-brief.ts:1367` has no other caller), then calls `runCampaign`, `outputRoot()` and `writeReport` (`:3-6, 33, 56`). **Not bypasses:** `brief-files.ts:236-249` delegates to `getBriefStore()`. `assetAbsPath` (`asset-files.ts:103-104`) had no callers and was deleted in #569. **Correction found while doing it:** `briefsDir` is not dead. It backs three path-returning wrappers (`findBriefFile`, `findBriefById`, `findBriefFileById`, `brief-files.ts:209-233`) that turn the port's relative names back into disk paths, and `pools/copy.post.ts:161` uses one of them. Those wrappers are PT-0a part 2. |
| **C3** | **Critical** | [code] **Location and credentials are process-global** (§0.3). Nothing about *where* a request's data goes is a parameter. Env reads outside tests: `pipeline.ts` (11), `env.ts` (9), `preview-frame.post.ts:59, 61`, `config.ts:9` and `project-root.ts:23`. `pipeline.ts:38` also calls `loadEnv()` as a module side effect. |
| **C4** | **Critical** | [code] **Brief bodies carry slug-keyed asset paths.** Briefs reference assets as `assets/inputs/<briefId>/…`, and create and duplicate rewrite those paths when an id changes (`rewriteAssetPaths`, `briefs.post.ts:3, 57`; `duplicate.post.ts:3`). Under C7 an asset is an id, so this is a **brief schema change and a migration step**, not only an adapter change. |
| **H1** | High | [code] **Exclusion is in-process; job state is on disk.** Job records are files under `<output>/jobs` (`fs-job-store.ts:56-80`). But `acquireJob` excludes with in-memory promise chains, `withJobLock(campaignId)` and a `"__capacity__"` lock (`fs-job-store.ts:176-199, 329-340`), and brief and pool locks are the same (`fs-brief-store.ts:233`, `fs-pool-store.ts:143`). `runJob` is fire-and-forget in the API process (`lib/jobs.ts:71-123`). Two instances do not exclude each other. **R6 (`RunRegistryPort`) is the one lock-plan lane still open**, and D64 was its only blocker. |
| **H2** | High | [code] **One set of provider credentials serves every caller.** Keys are read from `process.env` when each run's pipeline is built (`pipeline.ts:72-116, 232-236`). The only per-request choice is the provider (`?model=`, `generate.post.ts:94-99`). A SaaS needs per-org metering and quotas at minimum, and possibly per-org keys (Firefly output licensing follows the paying account). |
| **H3** | High | [code] **The background cache is shared across callers.** `FileSystemBackgroundCache` keys images by sha256(provider, model, prompt, ratio, seed) (`FileSystemBackgroundCache.ts:22-30`) under one `<output>/cache` (`pipeline.ts:74`). Under tenancy, org B asking for org A's prompt and seed receives org A's paid-for image. That is a data leak and a licensing problem. (The preview-frame cache is **not** this problem: it is keyed by the request's own input and only ever runs the credit-free procedural generator, `preview-frame.post.ts:58, 68-69`.) |
| **H4** | High | [code] **The browser is a store of record.** Drafts (`cf:draft:<id>`, `editor-state.ts:3036-3071`), the whole last-opened brief as JSON (`cf:brief`, `run-context.tsx:363, 654`) and **HITL approve/reject decisions** (`cf:decisions`, `run-context.tsx:351`) live only in `localStorage`. Decisions are cleared on every switch to a different brief (`run-context.tsx:685`) and carry no actor or timestamp, so the human-in-the-loop record has **no audit trail**, which a compliance product needs. |
| **M1** | Medium | [code] **Output and asset URLs are bare paths.** Six sites build `${API}/output/<path>`: `grid/page.tsx:28, 32, 491` and `export/page.tsx:159, 177, 185`. The grid appends `?v=${version}` for cache-busting. The asset thumbnail is `/api/pipeline/campaigns/assets?briefId=&name=` (`fs-asset-store.ts:76`). Reports store `outputPath`/`videoPath`/`proofPath` as disk paths. |
| **M2** | Medium | [code] **The recorded S3 shape keys by slug** (`.agents/architecture.md` § "S3 Adapter Shape": `brief.id -> s3://bucket/briefs/<id>.yaml`, `(briefId, name) -> s3://bucket/assets/inputs/<briefId>/<name>`). It contradicts C7 and must be rewritten, not implemented. |
| **M3** | Medium | [code] **Templates are "ownerless" and in memory** (`template-store.port.ts:6`; `fs-template-store.ts:20`). The D62 template library waited on D64(b) and is unblocked now, as an org-scoped entity beside the canonical, platform-owned templates. That needs a platform-admin role (D166). |
| **M4** | Medium | [external] **AR6's hosted-`<video src>` premise may be refused for Google Ads** regardless of storage. The HTML5 validator (`h5validator.appspot.com/adwords/asset`, result `5754646918987776`, 2026-09-24) lists a "4th party calls check" described as *"all assets are relative to creative. Exceptions may be granted"*. It is not verified against Google Ads policy. Until it is, no public "delivery asset" class is planned (D172). |
| **M5** | Medium | [code] **Nothing can be deleted.** There is no `*.delete.ts` route. A SaaS needs campaign and asset deletion that removes bucket keys, and user erasure on request. |
| **L1** | Low | [code] **The lock plan's status line is stale.** It lists R1, R2 and R5 as open, but R2 shipped as #536 and R1+R5 as #537 (`fs-job-store.ts:85`: eviction "used to fall back to index 0"; `ImageGeneratorPort.ts:58` takes a `signal`). Only R6 is open. |
| **L2** | Low | [intent] **Run identity is `campaignId` alone.** Markets fan-out (C17 – C19 of the 2026-09-03 plan) needs (campaign, market). The new job and report rows should leave room for it, not build it. |

**Checked and not a defect.**
- **Decisions do not leak across campaigns.** `assetKey` has no campaign id (`run-context.tsx:328-333`),
  but switching to another brief clears the map (`:685`). The defect is H4 (no durable record), not a
  collision.
- **Decisions do survive a reload.** The mount path restores the brief with `setBriefState`, which
  does not clear them (`run-context.tsx:728-745`), and they load from storage (`:760-779`).

---

## 2. Decisions proposed

All **PROPOSED** except **D167** and **D173**, stamped by the owner on 2026-09-24. D174 is a set of technology choices that `.agents/tech-stack.md` says must be the
owner's ("if it is not here … do not introduce it without asking"). No database, queue, auth or
object-store library is in the stack today.

| id | Decision | Why |
|---|---|---|
| **D166** | **The org is the tenant and the isolation boundary.** Every record belongs to exactly one org. A user reaches an org through a **membership** carrying a role. A **team** is a group of members inside an org. **Owner's call, recommended (i): a team is an access scope** — a campaign may belong to a team, and a member sees the org's campaigns their role and teams allow. The alternative, (ii), makes a team a label with no access meaning. A **platform-admin** role, outside every org, owns the canonical templates (M3) and support access, and every use of it is audited. | The stated model is "orgs, teams and users". Only the org can be the isolation boundary: it is what a bucket prefix, a row filter and a bill attach to. Whether teams restrict access changes every list query, so it is decided before the schema, not after. |
| **D167** | **STAMPED — Owner, 2026-09-24.** **Tenant context is explicit and flows in from the edge.** Authentication yields a `TenantContext { orgId, userId, roles, teamIds }` per request. API ports receive it. **A job captures it at enqueue**, so a run carries its context, not the process's. Env keeps infrastructure config only (database URL, bucket name), read once at the composition root. **Package adapters never see a tenant:** they are constructed with an already tenant-scoped root or prefix, so the background cache is scoped by the root it is built with, not by an `orgId` in the `packages/*` cache key. | This is D72's "scope axis on the ports" made concrete, and it closes C3 by construction. #567 showed what an env-resolved location does even inside one process. The domain and package layers stay tenant-agnostic, per `.agents/architecture.md`. `lint:arch` covers `packages/*/src` only, so in `apps/api` this rule is enforced by DoD 1's grep. |
| **D168** | **Every record has an immutable surrogate id; slugs are per-org, display-only and mutable.** URLs and API paths carry ids, and the slug is a unique column per org (D64 b). The editor's client-derived brief id (`briefId: slugify(patch.campaignName)`, `editor-state.ts:1478`) retires, and the server mints ids (C11). | D64(b) as stamped. It also removes C23 of the 2026-09-03 plan: a typo at Create is no longer permanent. |
| **D169** | **The database is the store of record for every entity. Object storage holds bytes only, under C7 keys.** Briefs become schema-versioned rows, each version with an actor. **Brief asset references become asset ids** (C4), and `rewriteAssetPaths` retires. **YAML stays an import/export format**, owned by the future batch feature, not a store. Reports are rows that reference assets, so the note that "a report is hand-editable" (`report.ts:74`) no longer holds. Object keys are `org/<orgId>/campaign/<campaignId>/<kind>/<assetId>` (inputs, renders, packages), and never contain a slug. The bucket is private. | C7 as stamped. Today YAML files *are* the store (`fs-brief-store.ts:80-95`). No human hand-edits a brief, and software authors the YAML, so a row is the natural home and YAML is a serialisation. |
| **D170** | **Browsers never get a bucket path.** Every byte a browser reads comes through a short-lived signed URL, issued only after the port's ownership check. Cache-busting moves into the URL the server signs, not a client-appended `?v=`. `GET /output/**` retires. | Closes C1's worst route and M1. Signed URLs also take streaming load off the API. |
| **D171** | **Jobs are durable rows plus a queue, and workers are stateless.** **Claiming a run is one statement** that either admits it or returns the incumbent, for example an insert guarded by a partial unique index on (org, campaign) where status is running, falling through to a select of the holder in the same statement (D75). The job row is the lease, the adoption handle and the poll target (D76). **A lease expires:** a worker heartbeats, and a reaper fails a job whose heartbeat lapses, so a crashed worker cannot lock a campaign forever (D77). **Every guarded write carries the run id as a fence** and is refused if the job no longer holds the lease (D78). R6's `RunRegistryPort` is implemented here. | D73 – D81 decided the shape and D64 decided the key; this plan binds them (D81). An index with no expiry would turn every crash into a permanent lock, and an insert-then-select would reopen the race D75 exists to close. |
| **D172** | **No public "delivery asset" class until M4 is verified.** HTML5 bundles keep carrying no external references: their raster fallback is packaged beside them (D122) and the owner's validator run passed "4th party calls". Packages live in the private bucket behind signed URLs. | Planning public hosting before knowing whether Google Ads accepts an external `<video src>` would be building on an unchecked premise. That is the mistake the asset-model plan's r1 made about text placement. |
| **D173** | **STAMPED — Owner, 2026-09-24.** **The server is the store of record for decisions, drafts and the last-opened campaign.** Decisions become rows with actor, timestamp and run id: an audit trail (H4). Drafts move **once server ids exist** (PT-5), debounced and keyed per user, so autosave is not a write per keystroke and one user's draft is not another's. `localStorage` keeps UI preferences and one-shot handoffs only (`cf:theme`, `cf:editor-column-view`, `cf:brief-picked`, `cf:step-handoff`). `cf:create-seed` retires when Create becomes a POST (D65, PT-5). D82 ("what a second tab may do") is then answered by the existing revision conflicts, plus a notice. | H4. A HITL product whose approvals vanish on a brief switch cannot claim review was done. Revision-checked writes already exist (`StoredBrief.revision`, 409 adoption), so the second-tab case becomes a server conflict, not a silent overwrite. |
| **D174** | **Technology choices — the owner's.** Recommendations, each a new dependency: **(a) Database:** PostgreSQL. It has row filtering, partial unique indexes (D171) and transactional DDL, and every host offers it managed. **(b) Auth:** a managed provider with first-class organisations, memberships and invitations, rather than hand-rolled sessions. The specific vendor is an open question for the owner. **(c) Object storage:** any S3-compatible store (S3, R2 or GCS in interop mode), which `.agents/architecture.md` already assumes. **(d) Queue:** a Postgres-backed queue first (no Redis to operate), and BullMQ + Redis (named in `tech-stack.md` as a Hexagen template) only if throughput demands it. | Each is a dependency the stack file forbids adding without the owner. They are grouped so one conversation settles them. |
| **D175** | **Provider access is platform-held and metered per org, and metering exists before any external org can run.** Every generation records (org, provider, model, units) against a quota, and a run over quota is refused before any provider call. **No org other than the owner's is admitted until PT-7 has shipped.** Bring-your-own-key is a later option. | H2. An org must never be able to spend on the platform's keys before metering exists, whatever order the lanes finish in. Per-org keys can follow without changing the metering shape. |

---

## 3. The target shape

```
browser ──(session)──▶ auth ──▶ TenantContext ──▶ route ──▶ port(ctx) ──▶ adapter
                                                      │                     ├─ Postgres rows (D169)
                                                      │                     └─ object store (C7 keys, D170 signed URLs)
                                                      └─ enqueue(ctx) ──▶ worker(ctx from job row) ──▶ same ports
```

**Entities** (D166, D168, D169). Every table carries `org_id`, except the platform-owned canonical
templates. Every id is a surrogate.

| Entity | Key facts |
|---|---|
| `org`, `user`, `membership (org, user, role)` | Roles are owner, admin, editor or viewer (names to be confirmed); `platform_admin` sits outside orgs |
| `team`, `team_membership` | Meaning per D166 |
| `campaign` | `slug` unique per org, `name`, `team_id?`, `status` (draft or published, C14), `revision`, `deleted_at` |
| `brief_version` | Schema-versioned brief body per revision, asset references as ids (C4), `actor` |
| `asset` | Object key per C7, content hash, kind (input, render, fallback, package) |
| `pool` | Copy pool per campaign, revisioned (D80) |
| `template` | `org_id` null for the canonical, platform-owned templates (M3) |
| `job` | Status, lease, heartbeat and fence per D171; captured `TenantContext`; `market?` reserved (L2) |
| `report`, `package` | Per run, referencing assets; the global "latest" pointer (C2a) retires |
| `decision` | (asset, run, verdict, actor, at) per D173 |
| `usage` | (org, provider, model, units, at) per D175 |
| `audit_event` | Who did what to which record, including every platform-admin access |

---

## 4. Lanes

Phases run in order. **Phase 0 needs no technology decision and can start now.** Its lanes run
against the existing file adapters with a single, fixed local tenant, so the behaviour is unchanged
and every later phase is an adapter swap behind a seam that already exists. One PR per lane.

| Lane | Delivers | Owns | Depends on |
|---|---|---|---|
| **PT-0a** | **DONE.** #569: reports through `ReportStorePort`, the latest pointer retired, a corrupt report rejects instead of reading as absent. #570: the `brief-files.ts` wrappers that turned store keys into disk paths are gone, and it no longer reads `projectRoot()`. #571: `GET /output/**`, the package listing and the zip read through `OutputStorePort`; review hardened the cache/jobs rule to judge the real target. **Everything persists through a port (C2).** A `ReportStorePort` (reports and `package.post.ts`'s report read; the global latest pointer retires, and `result.get.ts` requires a `campaignId`). An `OutputStorePort` (renders, the packages listing and zip). The dead path helpers are deleted. File adapters only, no behaviour change beyond the retired pointer. | `lib/report.ts`, `result.get.ts`, `package.post.ts`, `packages/[campaignId].get.ts`, `packages/[campaignId]/[platformZip].get.ts`, `lib/brief-files.ts`, `lib/asset-files.ts`, new ports | — |
| **PT-0b1** | **The tenant seam, below the routes (D167).** A `TenantContext` type and a fixed `LOCAL_TENANT`. `pipeline.ts` builds its adapters from a context-scoped root, not from `outputRoot()`/`projectRoot()`, and its module-level `loadEnv()` moves to the composition root. `safe-path.ts` takes its root as a parameter, so the six package adapters are constructed with it. `runJob` captures the context at enqueue. **The CLI** (`apps/api/bin/generate.ts`) runs under `LOCAL_TENANT` through the same ports. | `lib/pipeline.ts`, `lib/jobs.ts`, `lib/config.ts`, `lib/env.ts`, `CreativeGeneration/…/safe-path.ts` and its six importers' constructors, `apps/api/bin/generate.ts` | PT-0a |
| **PT-0b2** | **The tenant seam, at the routes.** Every route builds `LOCAL_TENANT` at its edge and passes it on. The `get*Store()` singletons (`lib/ports/index.ts:23-108`, 44 call sites) become per-context factories. `preview-frame.post.ts`'s import-time env reads move to the composition root. | the routes, `lib/ports/index.ts`, `lib/pools.ts`, `lib/brief-files.ts` | PT-0b1 |
| **PT-0c** | **The shared generation cache is scoped (H3)** by constructing `FileSystemBackgroundCache` with a tenant-scoped root (D167), not by adding an org to its key. With `LOCAL_TENANT` the bytes are unchanged. A test proves two contexts never share an entry. | `pipeline.ts` (construction only) | PT-0b1 |
| **PT-0d** | **Decisions move server-side (D173, H4)** behind a `DecisionStorePort` with a file adapter, keyed by campaign and run and carrying an actor (a local placeholder until PT-1). `run-context.tsx` reads and writes decisions through the API, and `cf:decisions` retires. **Drafts do not move here**: they wait for server ids (PT-5). | `run-context.tsx` (decisions only), new port and route | PT-0b2 |
| **PT-0e** | **Docs match the decisions.** `.agents/architecture.md`'s S3 sketch is rewritten to C7 keys and D167 context (M2). The lock plan's status line is corrected (L1). **`.agents/*.md` is an owner-edit file**, so this lane is done only on the owner's instruction. | `.agents/architecture.md`, `2026-09-04_run-exclusion-…md` | owner |
| **PT-1** | **Identity (D166, D174b).** The auth provider is integrated, and a session becomes a `TenantContext`. Membership and role come from the provider or the `membership` table. Sign-in and org switching are in scope. **Invitations to other orgs stay disabled until PT-7 ships (D175).** | new `auth` module, web shell | D166, D174 |
| **PT-2** | **Authorisation at the port.** Every port method checks that the record belongs to `ctx.orgId`, and team scope per D166. **A cross-tenant test per route** asserts a 404, never a 403, so existence isn't disclosed. Platform-admin access writes an `audit_event`. | `lib/ports/*` | PT-1 |
| **PT-3** | **Database adapters (D168, D169, D174a).** Postgres adapters for briefs, pools, templates, reports and decisions. Surrogate ids, slug per org, server-minted ids (C11), `brief_version` with actor, revision conflicts preserved. **Brief asset references become ids (C4)**, with a schema-version bump and a parser migration. | new `infrastructure/db` adapters, migrations, `load-brief.ts` | PT-0*, D174 |
| **PT-4** | **Object-store adapters (C7, D170, D174c).** Assets, outputs, packages and the background cache under `org/<orgId>/…` keys. Signed URLs replace every bare path (M1), including the `?v=` cache-bust, and `GET /output/**` retires. | new object-store adapters, `grid/page.tsx`, `export/page.tsx`, `fs-asset-store.ts` successor | PT-3 |
| **PT-5** | **Ids and drafts in the client (D168, D173).** Routes and links carry campaign ids, and slugs display only. The create seam (D65) becomes the POST that mints a draft row, which reopens D35's Save semantics (C14) as the 2026-09-03 plan foretold. Drafts move server-side, debounced and per user, and `cf:draft:*`, `cf:brief` and `cf:create-seed` retire. | web routes, `create-campaign.ts`, `IdentitySection`, `editor-state.ts` (draft persistence), `BriefEditor.tsx` (autosave), W3's resume flow | PT-3 |
| **PT-6** | **Durable jobs (D171, R6).** A job table, a queue (D174d), stateless workers, and `RunRegistryPort`. A one-statement claim, heartbeat plus reaper, and fenced writes. Two workers in a test never run one campaign twice, and a killed worker's campaign becomes runnable again. | `lib/jobs.ts`, `fs-job-store.ts` successor, worker entry | PT-3 |
| **PT-7** | **Metering and quotas (D175, H2).** A usage row per generation, a per-org quota check before a run is admitted, and the platform key held server-side. **The gate for admitting any other org.** | `pipeline.ts`, new `usage` port | PT-3 |
| **PT-8** | **Data migration.** Import the local `briefs/` (operator briefs are gitignored, content unknown), `assets/inputs/` and `output/` into one named org, rewriting brief asset paths to asset ids (C4). **Dry-run first**, reporting what would import, what is refused (for example retired `html` kinds, AF3) and why. Never silent. | new migration CLI | PT-3, PT-4 |
| **PT-9** | **Deletion and erasure (M5).** Soft delete for campaigns (`deleted_at`), a purge that removes rows and bucket keys, and user erasure that anonymises actors in `decision`, `brief_version` and `audit_event`. | new routes, adapters | PT-3, PT-4 |

**Unblocked by this plan but not scheduled in it**, from the 2026-09-03 §6 list: the D62 template
library (M3), markets fan-out (L2), presigned uploads (C16, C26) and link ingestion (C27, which needs
an SSRF design). Each becomes a plan once PT-3 exists. **AR6** stays blocked on M4.

**Sequencing.**
- **Phase 0:** PT-0a, then PT-0b1, then PT-0b2 and PT-0c in parallel (disjoint Owns columns), then
  PT-0d. It is the only phase a lane can start before D166 and D174 are answered.
- **Phase 1:** PT-1 and PT-3 in parallel once D174 is stamped. PT-2 follows PT-1.
- **Phase 2:** PT-4, PT-5, PT-6 and PT-7 follow PT-3.
- **Phase 3:** PT-8 and PT-9 last.
- **No external org is admitted before PT-7** (D175).

---

## 5. What this plan refuses

- **It does not put tenancy in the domain or package layers.** `CampaignOrchestration`,
  `CreativeGeneration` and `Distribution` stay tenant-agnostic, and their adapters are constructed
  with an already-scoped root (D167).
- **It does not build SSO or SCIM, billing, or multi-region** in this plan. It records them as the
  next plans after PT-7.
- **It does not plan public asset hosting** (D172, M4).
- **It does not keep YAML as a store** (D169), and it does not drop YAML as a format.
- **It does not choose a vendor.** D174 names the kinds and recommends. The owner picks.

---

## 6. Definition of done

1. **No location or credential from env below the composition root.** Run
   `git grep -nP "process\.env" -- apps/api/server apps/api/bin ':(glob)packages/*/src/**' ':!*__tests__*' ':!*.test.*'`.
   It must list only the composition-root file(s) named in PT-0b1. Before trusting the result,
   confirm the same pathspec finds today's known positive, `packages/shared/src/infrastructure/project-root.ts:23`.
   A quoted `'packages/*/src'` pathspec matches **no files** (git's fnmatch needs the whole path), so
   it would pass on any tree.
2. **Every route has a cross-tenant test** that answers 404 for another org's id.
3. **No object key contains a slug**, asserted in the object-store adapter tests, and no brief body
   carries a path-based asset reference (C4).
4. **No `localStorage` key holds a store of record.** The remaining keys are exactly D173's list.
5. **Two workers never run one campaign at once, and a killed worker's lease expires**, both asserted
   against the real database in CI.
6. **Every generation writes a usage row**, and a run over quota is refused before any provider
   call.
7. **The migration dry-run** reports every local brief, asset and run as imported or refused, with a
   reason.
8. **A deleted campaign leaves no object in the bucket** after purge.
9. No planning document's status line contradicts the tree.

---

## 7. What the owner is deciding

- **D166 — what a team means.** Recommended: an access scope. The alternative is a label.
- **D174 — database, auth provider, object store, queue.** Recommendations are in the row. The auth
  vendor is left open on purpose.
- **D175 — whether bring-your-own-key is in the first release**, or metering on platform keys only.
- **D167 and D173 are stamped (2026-09-24).** Stamp or amend **D168 – D172**. Each follows from D64, C7 and the stated SaaS target, and each is
  recorded here as the author's proposal, not a decision.
- **PT-0e** needs the owner's instruction, because it edits `.agents/architecture.md`.

**Phase 0 (PT-0a to PT-0d) can be dispatched as soon as D167 and D173 are stamped.** It needs no
vendor.

---

## 8. What review changed (r1 → r2)

Fable 5.1 reviewed r1 against `7535e820`. Every point below was re-checked against the code before
it was accepted.

- **DoD 1 could not fail (blocking).** Its pathspec `'packages/*/src'` matches 0 files. Even
  corrected, it covered `lib/ports` and `packages` while the real env reads live in `pipeline.ts`,
  `env.ts`, `config.ts` and `preview-frame.post.ts`. The known-positive check named a file outside
  its own pathspec. The fix uses a glob pathspec, adds `apps/api/server` and `apps/api/bin`, and uses
  `project-root.ts:23` as the known positive.
- **C2 was wrong in both directions.** It counted as bypasses `brief-files.ts:236-249` (which
  delegates to the port) and two helpers with no callers. It missed `package.post.ts:88` and the
  CLI. It also put the zip route at the listing route's path.
- **The inventory missed** `safe-path.ts`, through which six package adapters resolve against
  `projectRoot()`, and the brief-body asset paths (C4). Both are now findings with owners.
- **PT-0b was under-sized** (44 store call sites, fire-and-forget jobs, an import-time `loadEnv`).
  It is split into PT-0b1 and PT-0b2.
- **PT-0d's draft half needed server ids.** An API-backed draft keyed `cf:draft:new` would be a
  write per keystroke shared across browsers. Drafts move to PT-5, and PT-0d is decisions only.
- **D171 lacked lease expiry and a one-statement claim**, and D175's ordering let external orgs spend
  before metering. Both are fixed, and PT-1 keeps invitations off until PT-7.
- **Also taken:**
  - The citations for M1 and D168 are corrected.
  - The claim that "job state is in-process" is corrected: records are on disk, and only exclusion
    is in-process.
  - The preview-frame half of PT-0c is dropped, because it is not a leak.
  - Package adapters are scoped by their root, not a key field, per the architecture.
  - Deletion and erasure (M5, PT-9), a platform-admin role, audit events, the `brief_version` actor
    and evidence labels are added.
  - The D163 citation in D172 is fixed.
- **Refuted:** the review said decisions never survive a reload. The mount path restores the brief
  with `setBriefState`, which does not clear them (`run-context.tsx:728-745`), and loads them from
  storage (`:760-779`). They survive a reload, and are lost on a switch to another brief.
