# Run Exclusion & The Distributed Lock — Architecture & Development Plan

**Date:** 2026-09-04
**Status:** for review
**Decision ids introduced:** D73 – D81
**Relates to:** C4 (a second Generate adopts the run in progress), D15 (a storage port before the S3 move), D64 (the identity model — still open), D68 (typed boundary), the wave-1 plan `2026-09-03_create-moment-and-pipeline-prerequisites.md` §5.4

---

## 0. What this plan answers

The wave-1 plan flagged one item as *"D64-independent but urgent"*: the one-run-per-campaign guard is a
per-process `Map`, so it stops nothing across instances. This plan is the real fix for that.

Its central claim is that **this is not one lock, and a distributed lock alone would make things
worse.** Investigation found four separable problems wearing one costume, and **two of them are live
bugs today, on a single instance**:

1. **Exclusion** — the check and the claim are two statements that are atomic only because no `await`
   separates them. There is no compare-and-swap anywhere in the path.
2. **Adoption** — the 409 is not a refusal. It hands back the incumbent run's handle so the loser
   *subscribes* instead of failing (C4). A boolean lock cannot express that.
3. **Observation** — `GET /campaigns/jobs/:id` reads the same in-process map. Add a distributed lock
   and leave this local, and every poll that lands on a non-owning instance manufactures *"run was
   interrupted"* while the render proceeds normally. **That is strictly worse than today.**
4. **The resource the lock is supposed to protect** — rendered bytes are keyed by product and ratio
   with **no campaign segment**, so the guard does not cover its own resource.

> **Provenance.** Derived from the code on `main` at `81bd6be` by four parallel investigators and an
> adversary instructed to attack the obvious designs, producing 68 findings (14 blockers). Every
> finding below was re-verified by the author against the file before it was written down; the three
> that carry a **verified in the operator's own data** note were confirmed against the working tree.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D73** | **Fix the live bugs first, in their own PRs, before any distribution work — but the deadline comes before the eviction fix.** They are independent of D64 and of the migration. | Both bite a single instance today. **Corrected by review (gemini, blocker):** v1 scheduled the eviction fix first as a "tiny lane". That order bricks the instance. `expireLater` is called only from `settle` (`jobs.ts:92`), so a *running* job never expires, and eviction is therefore the **only** thing that reclaims a slot from a hung run. Stop evicting runners while nothing bounds a run, and fifty hung jobs make the API permanently unable to start another. The deadline (D77/R5) must land first or in the same change. |
| **D74** | **The output namespace gains the campaign id** — for **new** runs. Rendered bytes move from `<product>/<ratio>[/<treatment>].png` to a campaign-scoped path, **including `proofs/<product>.pdf`, which v1 missed** (four sites: `use-case.ts:281, 311, 451, 519`). The `output/**` route keeps serving whatever path a report stores, so **existing reports keep resolving** and no migration is forced (review: gemini). Under D64(a) a later rename orphans output exactly as it orphans assets today — a consequence of slug-as-key, not a choice this plan makes; it is stated, not solved (the reviewers disagreed here, see §8). | **Verified in the operator's own working tree:** `trail-blaze-2026`, `trail-blaze-motion-2026` and `trail-blaze-motion2-2026` all write `blaze-bottle/` and `blaze-pack/`. They have been overwriting each other's creatives. A per-campaign lock has never excluded this, because the lock key and the resource key are different keys. |
| **D75** | **Exclusion becomes one conditional operation that both admits the run and returns the incumbent.** Never a read followed by a write. Acquisition returns either "you hold it" or "here is the holder's job handle", in one round trip. | The current pair is atomic by accident of the event loop. Splitting it back into read-then-write across instances reproduces the exact double-start it prevents — and a bare boolean lock cannot satisfy C4's adoption contract without a second read that races the incumbent's completion. |
| **D76** | **Job state moves out of the process in the same change as the lock — never after it.** Exclusion, the adoption handle and the poll target are three roles of one record, and they must move together. | A distributed lock with a still-local job map honours exclusion and then 404s every poll that lands elsewhere, which the client renders as a lost run. Half of this change is a regression. |
| **D77** | **A lease needs a deadline that exists.** A run-level `AbortSignal` is threaded from the job into `runCampaign` and into every image adapter's fetch **before or with** the lease. | There is no deadline anywhere in the stack today: the three image adapters contain no timeout and no signal, and `runCampaign` takes none. A lease TTL chosen without one is an arbitrary number whose expiry races a pipeline that is still writing. |
| **D78** | **A lease is a liveness hint, not mutual exclusion, until the commit is conditional on still holding it.** Either every guarded write carries a fence (a run id checked at write time), or the plan states plainly that a superseded holder can overwrite the winner. | Every write a lock guards today is unconditional. Without a fence, a lease that expires mid-run permits two writers with no error on either side. |
| **D79** | **Prefer removing a lock to distributing it — but a unique temp name is NOT a lock-free path.** Each critical section is classified: *replaceable by a conditional write*, *genuinely needs a lease*, or *needs no lock once the code is shaped correctly*. | **Corrected by review — both reviewers, from different angles, and they were right.** v1 claimed a unique temp name would let briefs drop their lock. It does not. It fixes only the shared-temp corruption (L9); it does nothing about lost updates, because `rewriteBrief` reads the revision and then renames **unconditionally**, and `expectedRevision` is optional for callers. Going lock-free needs the compare and the write **fused** — `If-Match` on object storage, which `.agents/architecture.md:90-91` already sketches, or a mandatory `expectedRevision` plus an equivalent compare-and-swap on a filesystem that has none. The unique temp name is still worth doing; it is a corruption fix, not a lock removal. |
| **D80** | **The pool store gains a revision before it can drop its lock.** | Briefs already have a SHA-256 revision and a conditional write, so they have a path to lock-free. `PoolStorePort` has no revision at all and both its call sites are read-modify-write over an unconditional overwrite. This asymmetry, not the lock itself, is what sizes the work. |
| **D81** | **The lock key is decided by D64, so the seam is defined now and bound later.** The port is written so that the key is a parameter, not an assumption. | D64 (slug-as-key vs a database-fronted surrogate) is still the owner's open decision. Under a database the natural claim is a row with a unique constraint; under object-store-only it is a conditional put. The seam must survive either. |

---

## 1. Verified findings

### The two that bite today, on one instance

| id | Finding |
|---|---|
| **L1** | **The eviction path silently unlocks a running campaign.** `evictToFit` (`jobs.ts:41-52`) prefers to drop a settled job, but when all `MAX_JOBS` (50) slots are running it falls through the loop and deletes the oldest entry **regardless of status**. `hasRunningJob` then answers false, a second POST is admitted, and the original pipeline keeps running and keeps writing its report. One process, no distribution required. **Two qualifications from review:** it needs fifty concurrent runners to bite, so it is a hole rather than a daily bite; and `jobs.test.ts:99` **currently requires** this behaviour ("when every job is still running, the oldest runner is evicted"), so R1 changes a pinned test deliberately and must say so. |
| **L2** | **Two campaigns sharing a product id overwrite each other's creatives.** Output paths are `<product>/<ratio>[/<treatment>].png` and `<product>/<ratio>/v<n>.{png,mp4}` under one flat root (`GenerateCampaignUseCase.use-case.ts:271, 512-513`), **and `proofs/<product>.pdf` at four more sites** (`:281, 311, 451, 519` — missed by v1, caught by review); the campaign id appears only in the report filename. **Verified in the operator's own `output/reports/`:** three campaigns claim `blaze-bottle` and `blaze-pack`. Motion makes it destructive — a variation re-roll calls `exporter.remove(videoPath)` on a path another campaign may have written. |

### What the lock actually is

| id | Finding |
|---|---|
| **L3** | **Exclusion is check-then-act, atomic only by the event loop.** `generate.post.ts:73` reads `hasRunningJob`, `:82` calls `createJob`, with no `await` between. No compare-and-set, no unique constraint, no conditional write exists in the path. |
| **L4** | **The lock *is* the job record, and crash-release is accidental.** A campaign is locked exactly while some map entry is `running`. A restart empties the map; eviction drops entries. Move that record to a database and the failure inverts: a crashed instance leaves a `running` row nothing will settle, and the campaign is permanently un-runnable. |
| **L5** | **Nothing bounds a run.** `expireLater` is called only from `settle`, so only *finished* jobs expire. Below that, the Firefly, Gemini and OpenRouter image adapters contain **no timeout and no abort signal at all**, and `runCampaign` accepts none. A hung socket holds the campaign until the process dies. |
| **L6** | **The 409 is an adoption handle, not a refusal.** It carries the incumbent's `jobId`, and the client treats 202 and 409 identically when a job id is present (C4). A lock returning true/false cannot express this. |
| **L7** | **A job handle resolves only on the instance that minted it.** The client maps 404 to *lost*, shows the interrupted-run message and falls back to the previous report. Behind a load balancer this is manufactured from a healthy run. |
| **L8** | **No fence token exists.** Every guarded write is unconditional — the exporter writes, the brief store renames, the pool store renames, the report writes. A superseded lease holder overwrites the winner with no error on either side. |

### What sizes the work

| id | Finding |
|---|---|
| **L9** | **The brief store's temp file has a fixed name** (`${filePath}.tmp`), so two overlapping writers share it and the *lock* is what makes the write atomic. The pool store deliberately does the opposite, with a pid-and-random name and a comment saying why. One line closes the gap. |
| **L10** | **`PoolStorePort` has no revision.** `writePool` is an unconditional overwrite and both call sites are read-modify-write across it. Briefs can trade their lock for a conditional write; pools cannot until a revision exists on the port, the persisted document and the two routes' contracts. |
| **L11** | **The report merge is itself an unlocked read-modify-write** (`writeReport` with `merge`), guarded today only by the run exclusion it sits behind. Whatever replaces that guard must still cover this. |
| **L12** | **The report write is not atomic either** (review, grok). `report.ts:184-185` calls `writeFile` directly for both the per-campaign report and the global latest pointer — no temp-and-rename, unlike both stores. So it is **crash-torn on a single instance**, quite apart from any lock, and the global pointer is a second unscoped overwrite. |
| **L13** | **The deadline must be threaded through the port, not only the three adapters** (review, grok). `ImageGeneratorPort` and the execution options carry no signal, so patching the adapters alone leaves the seam unable to express cancellation. `OpenRouterCopyGenerator` already shows the house pattern to copy. |

---

## 2. The recommendation

**Three PRs before any distribution, then the seam, then the binding.**

- **Fix L1 and L2 now** (D73). Neither waits on anything. L2 is a data-loss bug in the owner's working
  tree, and it also decides the lock's key, so it must land before the lock is designed around the
  wrong one.
- **Then remove what should not be distributed** (D79/D80): give the brief store a unique temp name so
  its lock stops being load-bearing, and decide the pool revision question, which is the single
  largest input to how much lock remains.
- **Then define the exclusion seam** (D75/D76/D81) as a port whose acquire returns the incumbent, with
  the in-memory implementation kept as the local adapter, exactly as `BriefStorePort` was introduced
  before its S3 adapter existed.
- **Bind it to a real backend only when the migration chooses one**, and not before, with the deadline
  (D77) and the fence (D78) landing with it rather than after.

**What this plan does not do:** choose Redis over a database over queue-level concurrency. That
choice belongs to the migration plan and to D64, and the investigation's own conclusion is that the
choice matters far less than the four problems above, three of which are unfixed on any backend.

---

## 3. Lanes

One lane per PR. Ownership exclusive among concurrent lanes.

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **R1** | **Eviction never unlocks a running campaign** (L1). When every slot is a runner, `createJob` must refuse or grow rather than silently drop a running entry. Test: fill the map with runners, create one more, assert no running entry was dropped and that exclusion still holds. | `apps/api/server/lib/jobs.ts`, its `__tests__` | A live single-instance bug closed, in a file the lock work will rewrite anyway. |
| **R2** | **Campaign-scoped output paths** (L2, **D74**). Rendered bytes, the report's stored paths, and the `output/**` route gain a campaign segment. Needs a migration note for existing output, and the grid's URL construction follows. **Largest lane; do it alone.** | `packages/CampaignOrchestration/.../GenerateCampaignUseCase.use-case.ts`, the exporter, `apps/api/server/routes/output/[...path].get.ts`, `report.ts`, `apps/web/src/app/(shell)/grid/page.tsx`, their tests | Campaigns stop overwriting each other. The lock gets a key that matches its resource. |
| **R3** | **The brief store's temp file gets a unique name** (L9, D79), copying the pool store's pid-and-random pattern and its comment. | `apps/api/server/lib/ports/fs-brief-store.ts`, its `__tests__` | One reason to distribute a lock, deleted for one line. |
| **R4** | **A pool revision** (L10, **D80**) — mirroring the brief revision: **a SHA of the stored bytes, not a field on the document** (review, grok), with the 409-carrying-fresh-revision contract. | `ports/pool-store.port.ts`, `ports/fs-pool-store.ts`, `pools/[briefId].patch.ts`, `pools/[briefId].get.ts`, `pools/copy.post.ts`, `apps/api/server/lib/pools.ts` (the facade), `apps/web/src/lib/briefs-api.ts` (both pool calls), their tests — **the GET route and the facade were missing from v1's ownership** | Pools gain the conditional-write path briefs already have — the prerequisite for dropping their lock. |
| **R5** | **A run-level deadline** (L5, L13, **D77**) — **now the first lane.** An optional `signal` on `ImageGeneratorPort` and the execution options, threaded from the job through `runCampaign` into every image adapter's fetch, with a configured ceiling. Copy `OpenRouterCopyGenerator`'s existing `AbortSignal.timeout` pattern; do **not** re-timeout the ffmpeg compositor, which already has one. | `packages/CampaignOrchestration/.../ImageGeneratorPort.ts`, `GenerateCampaignUseCase`, `apps/api/server/lib/pipeline.ts`, `jobs.ts`, the three image adapters, their tests | A hung socket stops holding a campaign forever, and a lease TTL becomes a number with a meaning. |
| **R6** | **The exclusion seam** (**D75/D76/D81**): a `RunRegistryPort` whose `claim(campaignId, jobId)` is one conditional operation returning *acquired* or *the incumbent's handle*, plus job status and the poll target, with the current in-memory `Map` as its local adapter and behaviour unchanged on one instance. | `apps/api/server/lib/ports/run-registry.port.ts` (new), `ports/memory-run-registry.ts` (new), `ports/index.ts`, `jobs.ts`, `generate.post.ts`, `jobs/[id].get.ts`, their tests | The seam D15 gave briefs and assets, for the run — swappable when the migration picks a backend. |

**Order — corrected by review.** **R5 first**, or R5 and R1 as one change: R1 removes the only reclaim
path for a hung run, and without a deadline that bricks the instance at fifty runners (gemini,
blocker). Then R1 ‖ R3. Then **R2 alone** — not because it decides the lock's key, but because it and
R5 both own `GenerateCampaignUseCase.use-case.ts`. Then R4. Then R6.

**v1 stated two dependencies wrongly** (grok): R6 does **not** depend on R2's key — the lock key is
already `campaignId` (`jobs.ts:59-62`, `generate.post.ts:73`), and D74 makes the *resource* match that
key rather than choosing it. And R6 does not need R5's lease semantics; it is sequenced after R5 only
because both own `jobs.ts`. Nothing here needs D64 answered; **R6's key shape does**, which is why
D81 makes the key a parameter.

---

## 4. Definition of Done

The repo gate (`build`, `typecheck`, `lint`, `lint:arch`, `sync:check`, `test:cov` at 100 % on all
four counters), plus per lane:

- **R1**: a full-of-runners map cannot lose a running entry; exclusion holds across the eviction path.
- **R2**: two campaigns sharing a product id no longer collide, proven by a test that runs both and
  asserts distinct paths; existing reports either migrate or are explicitly declared stale, and the
  PR body says which.
- **R3**: two overlapping writers to one brief never share a temp path.
- **R4**: a stale pool write is refused with the fresh revision in the body, mirroring briefs.
- **R5**: a run exceeding the ceiling aborts, the adapters observe the signal, and the job settles as
  failed rather than hanging.
- **R6**: on one instance behaviour is byte-identical to today, including the 409-with-handle; the
  port's contract test proves acquire-returns-incumbent in one call.
- **Mutation check per behavioural claim**, reported in the PR body.

---

## 5. Open questions

1. **D64.** Still open, and R6's key shape waits on it.
2. **R2's migration.** Do existing `output/` trees and reports get migrated, or declared stale and
   regenerated? The operator has real output today, including the three colliding campaigns.
3. **The fence (D78).** Add a run id to every guarded write, or accept and document that a superseded
   holder can overwrite? The first is correct and touches every write path; the second is honest and
   cheap.
4. **Where the run registry lives** once the migration picks a backend — a database row with a unique
   constraint, a lease in Redis, or queue-level concurrency keyed by campaign. The investigation's
   view is that queue-level concurrency fits C4 worst, because the adoption handle is not the queue's
   to give.

## 6. Explicitly deferred

Binding the registry to a real backend; a distributed lease with heartbeats; ownership and tenancy in
the key (D72); and the report/output/package ports. All belong to the migration plan, and all are
cheaper once R1–R6 have landed.

## 7. Corrections this plan records

- The wave-1 plan called this *"the per-process one-run-per-campaign lock"*, which understated it.
  Exclusion is one of four roles that one `Map` is playing, and the two most damaging findings (L1,
  L2) are not about distribution at all.
- The author's first framing was "replace the lock with a distributed one". The investigation's
  adversary pass rejected that: a distributed lock with a local job map is a **regression**, and the
  lock's key does not currently match the resource it protects.
- **v1 of this plan ordered R1 first and would have bricked the instance** — removing the only
  reclaim path for a hung run before any deadline existed. Caught by review (gemini, blocker).
- **v1 claimed a unique temp name gives briefs a lock-free path.** It does not; both reviewers said
  so independently. It is a corruption fix, and lock-free needs the compare fused with the write.
- **v1 said R6 depends on R2's key.** It does not — the key is already the campaign id. The real
  reason to sequence them is shared file ownership.

## 8. Review record

Both reviewers read-only, both asked to attack the four-problem framing and the ordering first.

**gemini-3.1-pro (high) — verdict: rework.** One blocker, accepted and it reorders the plan: **R1
without R5 is a permanent denial of service.** `expireLater` fires only from `settle`, so a running
job never expires and eviction is the sole reclaim for a hung run; removing it before a deadline
exists lets fifty hung jobs brick the instance. Also: keep the `output/**` route serving stored paths
so existing reports resolve (accepted, D74); and D74 assumes an immutable campaign id, which under
D64(a) it is not (accepted as a stated consequence rather than a delay — see the disagreement below).

**grok-4.6 (high) — verdict: approve-with-changes.** Confirmed the four-problem framing, L1, L2, and
that a distributed lock over a local job map is a regression. Corrections accepted: v1's D79 was
wrong; R6 does not depend on R2's key; L1 needs its fifty-runner precondition and its pinned test
named; R4's ownership missed the GET route and the facade; R5 must thread the port, not just the
adapters. Three misses found: the unscoped `proofs/` path, the crash-torn report write (L12), and the
port-level signal (L13).

**Where they disagreed — decision-grade, and unresolved.** On D74's coupling to D64: grok holds that
no lane takes a side, since the lock key is already the campaign id and a rename orphaning output is
a property of slug-as-key rather than a choice; gemini holds that D74 should wait for D64 precisely
because a renameable slug in a path implies directory migrations. **The plan takes grok's position and
records gemini's dissent**, because the collision is destroying data today and waiting on an open
decision to stop that is the worse trade. If D64 lands on (a) with renames, §5 question 2 becomes a
migration question rather than a hypothetical.

**Both reviewers independently rejected v1's D79**, from different angles — grok that the compare and
the write are not fused, gemini that lost updates survive a unique temp name. Two failures, one
conclusion, and it was the author's error.
