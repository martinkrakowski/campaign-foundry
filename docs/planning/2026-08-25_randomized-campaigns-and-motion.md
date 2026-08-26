# Randomized Campaigns, Motion Creatives & Create New Project — Architecture & Development Plan

**Date:** 2026-08-25
**Status:** Implemented through wave 5 (2026-08-26) — decisions D1–D14 locked, one open question (Q2). Supersedes the v1 draft of the same day; v2.1 folded in the wave-1 code review (PRs #40–#42). §5 carries the per-phase **Wave status** table (PRs #39–#54 plus the wave-5 lanes), task 4.5 the recorded perf-spike numbers, §10 the evidence behind each Definition-of-Done item and the deferred list.
**Scope:** `packages/CampaignOrchestration`, `packages/CreativeGeneration`, `packages/Distribution`, `packages/GovernanceAndCompliance`, `packages/shared`, `apps/api`, `apps/web`, `briefs/`, `.agents/`
**Related:** `.agents/session-log.md` (2026-08-25 review + revision entries; the C/H/M/L findings themselves are recorded in §2 of this document), `.agents/tech-stack.md`, `.agents/testing.md`

> **Revision note.** This version incorporates four independent plan reviews (findings C1–C4, H1–H9, M1–M6, L1–L5 in §2) and three product decisions from the author (D1–D3). The most consequential corrections vs. the first draft: byte-level determinism is **not** promised for GenAI backgrounds or mp4 containers; a **job handle** moves into the MVP; variant identity is **`productId/variantIndex`** and is migrated across every consumer in one PR; new ports live in **CampaignOrchestration**, never in CreativeGeneration; `/brief` **stays an editor**; the parser **rejects** not-yet-supported axes instead of silently running the classic matrix.

---

## 0. Locked Decisions

| ID | Decision | Consequence |
|----|----------|-------------|
| **D1** | **`ffmpeg-static`**, version pinned. No system ffmpeg. | Zero setup, same binary locally and in CI. GPL-licensed binary — note for client distribution. Row added to `.agents/tech-stack.md` in the same PR. There is **no failing boot check today** (`env.ts` only warns); Phase 4.6 adds a Nitro plugin (`server/plugins/ffmpeg-check.ts`) that probes the binary once, **warns rather than crashes**, and flips the `formats: motion` allowlist off when it fails. The CLI gets the same probe in `bin/generate.ts`. |
| **D2** | **No audio** in the motion MVP. | No BGM pool, no loudness, no muxing. Later: a locked `bgm` asset referenced from the brief. |
| **D3** | **OpenRouter chat** (text model) for copy pools via a new adapter. | The existing image adapters (`OpenRouterImageGenerator`, `GeminiImageGenerator`) are not reusable for text. Gemini text is a possible second adapter, not a reuse. |
| **D4** | **Determinism is tiered** (§3). Plan and composite are bit-stable; GenAI sources are cached and attributed; mp4 is frame-deterministic, container-approximate. | Golden tests assert on the plan JSON and canvas frames only. Never on GenAI pixels or mp4 bytes. |
| **D5** | **Job handle in the MVP.** `POST /campaigns/generate` → `202 { jobId }` + `GET /campaigns/jobs/:id` polling; in-memory store; SSE optional later. | Nothing at N=100 ships on the synchronous POST (it already overran the Next proxy on a 12-cell demo). Classic mode uses the same path. |
| **D6** | **Variant identity = `productId/variantIndex`** in variation mode; `seed` is provenance. Classic key `productId/aspectRatio/treatment` unchanged. | One PR migrates every consumer: `GenerateCampaignUseCase` **target matcher** (`targetKeys`), `RegenerationTarget` in the **inbound port** `ports/in/CampaignPipelinePort.ts` (so the inbound port *does* change — 2.4 amended), `report.ts keyOf` **and `isKeyable`**, `run-context assetKey`, `parseRegenerateOnly`, grid, export, runs and compliance pages. The CLI builds no keys and is untouched. Merge is golden-tested. |
| **D7** | **Ports live in `CampaignOrchestration/application/ports/out`.** `VideoCompositorPort`, `CopyGeneratorPort` sit beside `CompositorPort`. Adapters stay in CreativeGeneration. | Matches current law (CreativeGeneration's `ports/` dirs are empty by design); `hexagen arch validate` stays green. |
| **D8** | **Parser allowlist.** `parseBrief` validates v2 fields against `SUPPORTED_AXES` / `SUPPORTED_FORMATS` that grow as phases land; unsupported values are a 400. | A variation brief can never silently run as the classic matrix. Schema ships in P0 without implying pools or motion exist. |
| **D9** | **`/brief` stays the in-memory editor** and gains *Save to briefs/*. The wizard at `(shell)/new` authors from scratch. | The current tweak → Run HITL loop is preserved. |
| **D10** | **`MINIMUM_PRODUCTS` relaxes to 1 in `mode: variation`**; classic keeps 2. | Single-SKU randomized campaign — the flagship case — is allowed. Wizard and use case share the rule and message. |
| **D11** | **Packaging never re-renders.** Platform profiles map onto the three existing canvases; safe insets are applied at *generation* as the union of insets for platforms sharing a ratio; classic briefs pass zeros. | No 100 × 7 explosion; classic output byte-identical (snapshot-guarded). 4:5 is a later `AspectRatio` extension. Reels/TikTok/Shorts listed only after motion (P4). |
| **D12** | **Brand floor is static across `t`.** Motion moves background and headline only; accent band and logo never animate. | Per-frame density holds by construction; compliance samples frames as a regression guard. No per-frame logo-localisation ("logo-hold") detector is invented. |
| **D13** | **Planner fails loud.** `count` is the total; distance is Hamming over discrete axes (continuous axes are enumerated steps); over-generate to `count × 3`; if accepted < `count` the plan fails with the shortfall and the axis-product size. Re-roll is `replan(plan, index, attempt)` inside the planner. | Never emits near-duplicates; re-roll stays golden-tested and distance-checked. |
| **D14** | **Lint rule is scoped and owned once.** The ban lives in a root `eslint.deterministic-core.js` fragment, spread into every bounded context's generated `eslint.config.js` through the hexagen **workspace-default** eslint template (CampaignOrchestration's per-context override widens it to `src/application/use-cases/**` and exempts `PipelineExecutionLog.vo.ts`). Covers `Math.random`, `Date.now`, bare `Date()`, zero-arg `new Date()`, `performance.now`, `crypto.randomUUID`/`getRandomValues`, and `globalThis.*` escapes; `__tests__` excluded; `new Date(value)` allowed. | Firefly IMS expiry (`Date.now()`, infrastructure) is outside the scope. `PipelineExecutionLog` keeps its clock by explicit filename exemption — injecting a clock is a follow-up, not part of wave 1. *(Landed in PR #41.)* |

---

## 1. Context & Guiding Principles

### Current State (verified 2026-08-25)

- `CampaignBrief { id, targetRegion, targetAudience, campaignMessage, localizedMessage?, products[], treatments?[] }` is loaded from `briefs/*.yaml|json`; the lister uses `BRIEF_PATTERN = /\.(ya?ml|json)$/i` over regular files only.
- `GenerateCampaignUseCase` runs products × `AspectRatio.all()` × treatments. Canvases are fixed: **1:1** 1080², **9:16** 1080×1920, **16:9** 1920×1080. `MINIMUM_PRODUCTS = 2`. `MAX_CONCURRENT_BACKGROUNDS = 8` exists because a sequential run overran the Next rewrite timeout on a 2×3×2 demo.
- Asset identity is `productId/aspectRatio/treatment` in `apps/api/server/lib/report.ts:11` (`keyOf`, used by `writeReport({ merge })`), `apps/web/src/lib/run-context.tsx:63` (`assetKey`), `RegenerationTarget` / `parseRegenerateOnly`, the grid, export, and the CLI.
- All four ports (`ImageGeneratorPort`, `CompositorPort`, `CompliancePort`, `ExportPort`) live in `CampaignOrchestration/src/application/ports/out`. `CreativeGeneration/src/application/ports/{in,out}` are `.gitkeep` only.
- Adapters: `FireflyImageGenerator`, `GeminiImageGenerator`, `OpenRouterImageGenerator` (3 of the 6 `ALLOWED_IMAGE_MODELS`), `ProceduralBackgroundGenerator`, `AssetReusingImageGenerator` (cover-fits `inputAsset`; **no cache**), `NodeCanvasCompositor` (opaque accent band is the brand-density floor), `BrandComplianceChecker`, `FileSystemExporter`. No `output/cache/` exists anywhere.
- None of the GenAI providers is called with a seed.
- API: `GET /campaigns/briefs`, `POST /campaigns/generate` (synchronous to completion, then `writeReport`), `GET /campaigns/result`, `GET /output/**` — content-type map is **png/pdf/json only**.
- Web: `(shell)/brief/page.tsx` is a **live in-memory editor** (`setBrief`, no file write); grid / compliance / export / runs; `BriefPicker` modal; `run-context`.
- Clock use: `PipelineExecutionLog.vo.ts` (`new Date()` ×3), `FireflyImageGenerator.ts` (`Date.now()` for IMS token expiry).
- Persistence: `output/reports/<campaignId>.json`. No DB, no queue (Prisma/BullMQ are not in the codebase and must not be introduced).
- Tooling: `packages/*/src/**/index.ts` barrels are `@generated` by hexagen (`yarn sync`); `application/ports/out/index.ts` is hand-maintained. `hexagen arch validate` in CI. Tests in adjacent `__tests__/` (`.agents/testing.md`). CI pins Node **22** (`ci.yml:47`). `.agents/tech-stack.md` requires a row for every new dependency.
- A same-day Reviewer session (`.agents/session-log.md`, 2026-08-25) returned "needs revision" on the v1 draft; this document is the revision.

### Guiding Principles

1. **Seeded variation over a deterministic pipeline.** The planner draws parameters from a PRNG seeded by `seedFrom(briefId, String(variantIndex), String(attempt))`; the existing compositor renders them.
2. **GenAI builds approved pools up front; it is never called inside the per-creative loop.** This is the deliberate departure from MoneyPrinterTurbo.
3. **Ports are contracts in CampaignOrchestration; adapters implement them.** Nothing in `application/` imports from `infrastructure/`.
4. **Absent v2 fields mean today's behaviour.** Existing briefs, reports and tests are untouched by default.
5. **Fail loud, never approximate silently.** Unsupported axes → 400. Unreachable `count` → plan failure. Lost job → explicit recovery from the persisted report.
6. **New dependencies need a tech-stack row in the same PR.** `ffmpeg-static` is the only new runtime dependency in this plan; no virtualization library, no queue.

---

## 2. Review Findings → Resolution

| ID | Severity | Finding | Resolved by |
|----|----------|---------|-------------|
| **C1** | Critical | "Same bytes" is false for GenAI (no seeds) and mp4 (container drift). | D4, §3 |
| **C2** | Critical | Identity key is 3-part in three consumers; `variantIndex` on `regenerateOnly` alone would overwrite siblings on merge. | D6, Phase 2.5 |
| **C3** | Critical | Planner combinatorics unspecified; `count × 1.5` cannot reach 100 from a 24-combo product; no failure mode. | D13, Phase 2.2 |
| **C4** | Critical | P5 safe insets "at packaging" require re-rendering; cross-ratio mapping undefined. | D11, Phase 5 |
| **H1** | High | `VideoCompositorPort` / `CopyGeneratorPort` placed in CreativeGeneration. | D7 |
| **H2** | High | MVP at N=100 still on the synchronous POST; jobs scheduled after motion. | D5, Phase J |
| **H3** | High | Schema accepts `pool://copy`, motion, `formats: motion` before their phases; wizard could run a variation brief as the classic matrix. | D8, Phase 0.4 |
| **H4** | High | Package-wide `Date` ban breaks the execution log and Firefly auth. | D14 |
| **H5** | High | Safe insets change classic geometry and every snapshot. | D11, Phase 5.2 (zeros by default) |
| **H6** | High | `MINIMUM_PRODUCTS = 2` rejects the single-SKU randomized case. | D10 |
| **H7** | High | `/brief` is already an editor; making it read-only regresses HITL. Logo upload has no route and could overwrite demo logos. | D9, Phase 1.2–1.3 |
| **H8** | High | `drawCreative(ctx, req, t)` cannot be a no-behaviour-change extract: I/O per frame, wrong rest pose, vacuous logo-hold. | D12, Phase 4.2 (`prepareCreative` + rest pose) |
| **H9** | High | Image adapters cannot generate text pools. | D3 |
| **M1** | Major | Platform ratios (4:5, 1.91:1) are not the domain's three canvases. | D11, Phase 5.1 |
| **M2** | Major | Perf not budgeted: ~3.7 GB raw RGBA per 15 s 9:16 variant; canvas raster is on the event loop. | Phase 4.5 (spike + budget) |
| **M3** | Major | Per-frame density is trivially passed if the band is static, flickers if not. | D12 |
| **M4** | Major | Lint machinery / new-dep gate (`ffmpeg-static`, virtualization lib) not in tech-stack. | D1, D14, Phase 6.1 |
| **M5** | Major | `AssetReusingImageGenerator` cited as a cache precedent; it is not one. | §1 corrected; Phase 2.6 designs the cache from scratch |
| **M6** | Major | Re-roll via `seed + attempt` moved planning into the generate use case, outside golden tests. | D13 (`replan`) |
| **L1** | Low | `.mp4` absent from the output route's content-type map. | Phase 4.6 |
| **L2** | Low | `briefs/<id>.pools.json` matches the briefs lister. | Phase 3.1 (`briefs/<id>/pools.json`) |
| **L3** | Low | Numeric `seed + attempt` vs string `seedFrom` — pick one. | Principle 1 (string parts only) |
| **L4** | Low | `treatment` and independent layout/tone axes both first-class. | Phase 2.1 (synthesized label) |
| **L5** | Low | CI "Node 24" claim; `ci.yml` pins 22. | §1; Phase 7 |

---

## 3. Determinism Contract (D4)

| Tier | Guarantee | Test |
|------|-----------|------|
| **1 · Plan** | Same brief + same seed → identical `VariationPlan` (bit-stable JSON, `policyHash`). | Golden hash |
| **2 · Composite** | Same background bytes + same `CompositeRequest` → identical PNG; same prepared inputs + `t` → identical frame. | Canvas snapshots |
| **3 · Sources / container** | GenAI backgrounds are **cached and attributed** (`output/cache/`, gitignored, not CI-cached). mp4 is deterministic in frames, **approximate in container bytes** across ffmpeg builds/CPU paths. | Never pixel- or byte-golden-tested |

The report records `backgroundSource`, the cache key, and `policyHash`, so any divergence between machines is explainable rather than silent.

---

## 4. Domain & Schema

### 4.1 Brief schema v2 (all fields optional; absent = classic behaviour)

```yaml
mode: variation            # default "brief"
variation:
  count: 100               # TOTAL variants across all products/ratios
  seed: 42                 # optional; default seedFrom(id)
  minDistance: 2           # Hamming distance over DISCRETE axes
  coverage:                # optional minimums
    perProduct: 1
    perRatio: 1
  axes:                    # list per axis; omitted = locked
    layout: [headline-top, headline-bottom]
    tone: [bold, subtle]
    background: { source: [procedural, asset-pool, genai] }
    paletteShift: [0, 0.1, 0.2]     # enumerated steps; procedural only
    headline: pool://copy            # 400 until Phase 3 (D8)
    motion: [ken-burns-in, ken-burns-out, headline-rise, accent-wipe]  # 400 until Phase 4
    duration: [6, 10, 15]            # 400 until Phase 4
output:
  formats: [static]        # "motion" → 400 until Phase 4
  platforms: [instagram-feed, linkedin, x]
```

### 4.2 New domain types

| Type | Package | Notes |
|------|---------|-------|
| `SeededRandom` VO + `seedFrom(...parts: string[])` | `shared/domain/value-objects` | mulberry32 + FNV-1a. Run `yarn sync`; commit the barrel diff. |
| `VariationPolicy` VO | `CampaignOrchestration/domain/value-objects` | Parsed policy incl. coverage. |
| `Variant` entity | `CampaignOrchestration/domain/entities` | `{ index, seed, productId, ratio, layout, tone, background, paletteShift, headline?, motion?, duration? }`; `treatment` synthesized as `${layout}-${tone}` for labels only (L4). |
| `VariationPlan` VO | `CampaignOrchestration/domain/value-objects` | `{ variants, estimate, policyHash }`. |
| `GeneratedAsset` (extended) | `CampaignOrchestration/domain/entities` | `+ variantIndex?, seed?, format: "static" \| "motion", descriptor?` |
| `PlatformProfile` VO (data table) | `Distribution/domain/value-objects` | `id, ratio, safeInsets, maxDurationSec?, maxBytes, formats` |
| `MotionKind` VO | `CampaignOrchestration/domain/value-objects` | Declares easing and rest `t` per kind. |
| `CopyPool` VO | `CampaignOrchestration/domain/value-objects` | Entries with `status: approved \| rejected`, `reason?`. |

### 4.3 New / changed ports (all in `CampaignOrchestration/application/ports/out`, D7)

```ts
// BackgroundContext gains an optional seed; cache key = sha256(provider, model, prompt, ratio, seed)
interface BackgroundContext { campaignMessage; targetAudience; targetRegion; seed?: number }

// CompositeRequest gains safe insets (zeros by default, D11)
interface CompositeRequest { …; safeInsets?: { top; right; bottom; left } }

interface VideoCompositeRequest extends CompositeRequest {
  durationSec: number; fps: number; motion: MotionKind;
  sampleAt: readonly number[];          // t values chosen by orchestration, not the adapter
}
interface VideoCompositeResult { video: Uint8Array; poster: Uint8Array; sampledFrames: Uint8Array[]; logoApplied: boolean }
interface VideoCompositorPort { compositeVideo(req: VideoCompositeRequest): Promise<VideoCompositeResult> }

interface CopyGeneratorPort { suggestHeadlines(brief: CampaignBrief, count: number): Promise<string[]> }
```

`application/ports/out/index.ts` is hand-maintained — export the new ports there. Everything else goes through `yarn sync`.

---

## 5. Phased Implementation Plan

> **Wave 1 status (2026-08-25):** P0 (#41 seed + lint, #40 schema v2) and J (#42 job handle) are implemented and reviewed; the task rows below reflect what landed, including the review fixes. Deferred from the wave-1 review, tracked for later PRs: inject a clock into `PipelineExecutionLog` (D14 note); collapse the four test fetch-router fixtures in `apps/web` into one `mockPipelineApi` helper; real `done/total` progress from the pipeline log (the fields stay 0 until completion by design in J).

### Wave status (2026-08-26)

Every phase below has landed on `main` except the two wave-5 implementation lanes, which are open PRs at the time of writing. PR numbers are GitHub PRs on `main`; "wave" is the delegation wave in `.agents/session-log.md`.

| Phase | Tasks | PR(s) | Wave |
|-------|-------|-------|------|
| P0 | 0.1 `SeededRandom` + `seedFrom`, 0.2 deterministic-core lint (D14) | #41 | 1 |
| P0 | 0.3 schema v2, 0.4 allowlist (D8), 0.4b parse-but-never-run, 0.6 `briefs/sample-randomized.yaml` | #40 | 1 |
| P0 | 0.5 `?model=` vs `genai` axis documented in `pipeline.ts` | #50 | 3 |
| J | J.1–J.4 job handle, polling, lost-job recovery | #42 | 1 |
| P2 | 2.1 VOs + `MotionKind`, 2.2 `plan`, 2.3 `replan` | #46 | 2 |
| P2 | 2.4 generate-from-plan (D10), 2.5 identity migration (D6), 2.6 GenAI seed cache, 2.7 `policyHash`/`seed` in the report + Runs page | #50 | 3 |
| P1 | 1.1 briefs routes, 1.2 `POST /campaigns/assets` | #47 | 2 |
| P1 | 1.3 `/brief` Save, 1.4 picker Create/Duplicate, 1.5 wizard, 1.6 `POST /campaigns/plan` estimate | #51 (plan route itself in #50) | 3 |
| P5 | 5.1 `PlatformProfile` table, 5.3 `PackageForPlatformUseCase` + manifest | #48 | 2 |
| P5 | 5.2 compositor half — optional `safeInsets` on `CompositeRequest` (zeros byte-identical) | #49 | 3 |
| P5 | 5.2 generate half — union of platform insets per ratio in variation mode (D11) | wave 5 lane A `feat/motion-generation`, in progress | 5 |
| P5 | 5.4 Export tabs, checks, zip (+ `GET /campaigns/packages/:campaignId`) | #53 | 4 |
| P6 | 6.1 grid filters/chips/paging, 6.2 estimate panel, 6.3 re-roll rejected, 6.4 Runs `seed` + `policyHash` | #53 (6.3 identity path in #50) | 4 |
| P4 | 4.2 `prepareCreative` / `drawCreative` extract (H8) with platform-keyed goldens | #45 | 2 |
| P4 | 4.1 `VideoCompositorPort`, 4.3 motion in `draw` (D12), 4.4 `CanvasFfmpegVideoCompositor`, 4.6 boot probe + `.mp4` route + tech-stack row | #54 | 4 |
| P4 | 4.5 perf spike — numbers recorded in the task row below; no PR | — | 4 |
| P4 | 4.7 sampled-frame compliance + mp4 export, 4.8 allowlist `motion`/`duration`/`formats: motion` + visible motion profiles, 4.9 grid video cells + frames estimate | wave 5 lane A `feat/motion-generation`, in progress | 5 |
| P3 | 3.1 `briefs/<id>/pools.json`, 3.2 `CopyGeneratorPort` + `OpenRouterCopyGenerator`, 3.3 `POST /campaigns/pools/copy` (+ `GET`/`PATCH /campaigns/pools/:briefId`) | #52 | 4 |
| P3 | 3.4 allowlist `headline: pool://copy` + planner consumption, 3.5 wizard pool panel | wave 5 lane B `feat/pool-headlines`, in progress | 5 |
| P7 | Plan document | #39 | 1 |
| P7 | Wave-1 deferrals: clock injected into `PipelineExecutionLog`; shared `mockPipelineApi` | #43, #44 | 2 |
| P7 | README Modes section, `briefs/sample-motion.yaml`, `briefs/sample-pooled.yaml`, this status table | wave 5 lane C `docs/plan-implemented` | 5 |

Phases are atomic and independently mergeable. **P0 → J → P2 → P1 → P5 → P6 (partial) is the MVP** (randomized static campaigns, authored in the UI, packaged per platform). P4 (motion) and P3 (pools) are independent follow-on trains.

---

### Phase 0 — Foundations
**Goal:** the seed primitive exists, the v2 schema parses with a strict allowlist, and nothing else changes.

| # | Task | File(s) |
|---|------|---------|
| 0.1 | `SeededRandom` VO + `seedFrom`; `yarn sync`; commit barrels. | `packages/shared/src/domain/value-objects/SeededRandom.vo.ts` |
| 0.2 | **(D14)** Deterministic-core lint fragment + hexagen templates (workspace default + CampaignOrchestration override). Package `eslint.config.js` files stay `@generated`. | `eslint.deterministic-core.js`, `.architecture/manifest.yaml` |
| 0.3 | `CampaignBrief` gains optional `mode`, `variation`, `output`. | `CampaignOrchestration/src/domain/entities/CampaignBrief.ts` |
| 0.4 | **(D8, H3)** `parseBrief` validates v2 blocks against `SUPPORTED_AXES` / `SUPPORTED_FORMATS`; unsupported → throws (400). `variation.count` is required when `mode: variation`. | `apps/api/server/lib/load-brief.ts` |
| 0.4b | **(D8)** `runCampaign` refuses `mode: variation` (API 422, CLI failure) until Phase 2 consumes the policy — parse-but-never-run. Removed in 2.4. | `apps/api/server/lib/pipeline.ts` |
| 0.5 | `?model=` vs `genai` axis: axis decides *whether*, `?model=` decides *which provider*. `paletteShift` applied only by `ProceduralBackgroundGenerator`. Document in `pipeline.ts`. | `apps/api/server/lib/pipeline.ts` |
| 0.6 | Sample brief (static axes only). | `briefs/sample-randomized.yaml` |

**Acceptance:** all existing tests green; a v2 brief with `motion:` or `pool://` is rejected with a message naming the unsupported axis; `seedFrom("a","1","0")` is stable across runs and platforms (golden).

---

### Phase J — Job Handle (D5, H2)
**Goal:** long runs survive the proxy; the UI recovers from a lost job.

| # | Task | File(s) |
|---|------|---------|
| J.1 | `POST /campaigns/generate` → `202 { jobId }`; run continues in-process; `writeReport` on completion. **409** while that campaign already has a running job (no concurrent writers to the same paths). Store capped at `MAX_JOBS = 50`, settled jobs expire after `JOB_TTL_MS` (unref'd timer). | `apps/api/server/routes/campaigns/generate.post.ts`, `apps/api/server/lib/jobs.ts` |
| J.2 | `GET /campaigns/jobs/:id` → `{ status, done, total, log, result? }`; 404 for unknown (restart). | `apps/api/server/routes/campaigns/jobs/[id].get.ts` |
| J.3 | `run-context` polls with backoff (250 ms → 2 s), tolerates up to five transient non-OK polls, and owns an `AbortController` per run (aborted on brief switch, unmount, new run). A 404 is reported as **lost**, never as a result: the saved report is shown *as the previous run* (no cache-bust, decisions kept, explicit message); a lost re-roll leaves the grid untouched. One `fetchPersistedRun()` serves mount, `setBrief`, and recovery. | `apps/web/src/lib/run-context.tsx` |
| J.4 | `bin/generate.ts` unchanged (in-process, no job). | — |

**Acceptance:** a 12-cell classic run completes through the job path; killing Nitro mid-run and reloading the page shows the last persisted report, not a spinner.

---

### Phase 2 — Variation Planner & Identity
**Goal:** a pure, golden-tested planner; generation from a plan; one identity migration.

| # | Task | File(s) |
|---|------|---------|
| 2.1 | `VariationPolicy`, `Variant`, `VariationPlan`, `MotionKind` (kinds declared, unused until P4). | `CampaignOrchestration/src/domain/**` |
| 2.2 | **(D13, C3)** `PlanVariationsUseCase.plan(brief)`: coverage minimums first, then seeded draws to `count × 3`, greedy-accept at `minDistance`, fail with shortfall + axis-product size. `estimate = { creatives, feasibility, genaiCalls }`. | `CampaignOrchestration/src/application/use-cases/PlanVariationsUseCase.use-case.ts` |
| 2.3 | `replan(plan, index, attempt)` — re-draws one slot at `seedFrom(id, index, attempt)`, distance-checked against the rest. | same |
| 2.4 | `GenerateCampaignUseCase`: when `mode === "variation"` call the planner internally; cells = variants; `MINIMUM_PRODUCTS` → 1 in that mode (D10). Remove the 0.4b refusal. `execute(brief, options)` keeps its signature; `RegenerationTarget` on the inbound port widens (see 2.5). | `GenerateCampaignUseCase.use-case.ts`, `pipeline.ts` |
| 2.5 | **(D6, C2)** Identity migration: `GeneratedAsset` fields; the use case's `targetKeys` matcher; `RegenerationTarget` (inbound port) + `parseRegenerateOnly` accept `variantIndex` + `attempt`; `keyOf` **and `isKeyable`** / `assetKey` branch on `variantIndex`; grid, export, runs, compliance pages. Output path `<product>/<ratio>/v<index>.png`. | `GenerateCampaignUseCase.use-case.ts`, `ports/in/CampaignPipelinePort.ts`, `report.ts`, `run-context.tsx`, `load-brief.ts`, `grid/page.tsx`, `export/page.tsx`, `runs/page.tsx`, `compliance/page.tsx` |
| 2.6 | GenAI cache: `BackgroundContext.seed`; Firefly/Gemini/OpenRouter adapters hash `(provider, model, prompt, ratio, seed)` → `output/cache/<key>.png`; descriptor records hit/miss. `.gitignore` `output/cache`. | `CreativeGeneration/src/infrastructure/adapters/*ImageGenerator.ts`, `.gitignore` |
| 2.7 | Report gains `policyHash`, `seed`; Runs page shows them. | `report.ts`, `runs/page.tsx` |

**Acceptance:** golden tests — fixed brief+seed → fixed plan hash; undersized axis product → failure with shortfall; `replan` keeps `minDistance`; merge of a re-rolled variant replaces exactly one row. Classic-mode report key and paths unchanged (existing report fixtures pass).

---

### Phase 1 — Create New Project
**Goal:** briefs can be authored and persisted from the UI without regressing the in-memory HITL loop.

| # | Task | File(s) |
|---|------|---------|
| 1.1 | `POST /campaigns/briefs` (409 on overwrite unless `?replace=1`), `PUT /campaigns/briefs/:id`, `POST /campaigns/briefs/:id/duplicate`. Path-safe ids; same validator as generate. | `apps/api/server/routes/campaigns/briefs.post.ts`, `briefs/[id].put.ts`, `briefs/[id]/duplicate.post.ts` |
| 1.2 | **(H7)** `POST /campaigns/assets`: writes only under `assets/inputs/<briefId>/`; png/jpg; size cap; refuses seeded demo logos. Local-tool trust model stated in the route doc. | `apps/api/server/routes/campaigns/assets.post.ts` |
| 1.3 | **(D9)** `/brief` keeps editing in memory; adds **Save to briefs/**. | `apps/web/src/app/(shell)/brief/page.tsx` |
| 1.4 | `BriefPicker`: **Create new** row, **Duplicate** per entry. | `apps/web/src/components/shell/BriefPicker.tsx` |
| 1.5 | Wizard `(shell)/new`: Campaign type → Brand & products → Copy → Variation policy → Output → Review. P2 lands first, so the Randomized type is live from the start; "Generate suggestions" hidden until P3. | `apps/web/src/app/(shell)/new/page.tsx`, `components/wizard/*` |
| 1.6 | Estimate + feasibility panel in the policy step (from `PlanVariationsUseCase.estimate` via `POST /campaigns/plan`, dry-run). | `apps/api/server/routes/campaigns/plan.post.ts`, wizard |

**Acceptance:** a brief authored in the wizard round-trips through `GET /campaigns/briefs` and runs; a one-product variation brief saves and runs; a one-product classic brief is blocked with the existing message; upload outside `assets/inputs/<briefId>/` is impossible by construction (route test).

---

### Phase 5 — Platform Packaging (`packages/Distribution`)
**Goal:** per-platform output without re-rendering.

| # | Task | File(s) |
|---|------|---------|
| 5.1 | **(D11, M1)** `PlatformProfile` table: `instagram-feed → 1:1`, `linkedin → 1:1 \| 16:9`, `x → 16:9`; `instagram-story \| reel`, `tiktok`, `youtube-short → 9:16` marked `formats: [motion]` and hidden until P4. | `Distribution/src/domain/value-objects/PlatformProfile.vo.ts` |
| 5.2 | **(H5)** `CompositeRequest.safeInsets` (default zeros). Generate computes the union of insets for platforms sharing each ratio, variation mode only. Snapshot test proves classic output unchanged. | `NodeCanvasCompositor.ts`, `GenerateCampaignUseCase.use-case.ts` |
| 5.3 | `PackageForPlatformUseCase`: select the variant render for each platform ratio, validate (dimensions, bytes, format), copy to `output/<campaign>/platforms/<platform>/`, write `manifest.json`. | `Distribution/src/application/use-cases/PackageForPlatformUseCase.use-case.ts`, `FileSystemExporter.ts` |
| 5.4 | Export page: per-platform tabs, checks, zip download. | `apps/web/src/app/(shell)/export/page.tsx` |

**Acceptance:** a packaged campaign passes every profile check in its manifest; classic-brief compositor snapshots are byte-identical before/after 5.2.

---

### Phase 6 — UI for Scale
**Goal:** 100 cells are usable; runs are reproducible from the UI.

| # | Task | File(s) |
|---|------|---------|
| 6.1 | **(M4)** Grid filters (product / ratio / format / axis value), descriptor chips; `content-visibility: auto` + paged sections — **no virtualization library**. | `grid/page.tsx` |
| 6.2 | Estimate panel before **Run** (creatives, feasibility, GenAI calls + cost warning when keys present; frames/encode-minutes after P4). | `CommandBar.tsx` |
| 6.3 | Approve/reject per variant; **Re-roll rejected** batches `replan` via `regenerateOnly`. | `grid/page.tsx`, `run-context.tsx` |
| 6.4 | Runs page shows `seed` + `policyHash`. | `runs/page.tsx` |

**Acceptance:** 100-variant report renders and filters without jank on a laptop; re-rolling three rejected variants changes exactly three rows.

---

### Phase 4 — Motion Layer (after J and P2)
**Goal:** deterministic-frame mp4 variants from the same compositor, silent (D2).

| # | Task | File(s) |
|---|------|---------|
| 4.1 | **(D7)** `VideoCompositorPort` beside `CompositorPort`; export from `ports/out/index.ts`. | `CampaignOrchestration/src/application/ports/out/VideoCompositorPort.ts` |
| 4.2 | **(H8)** Refactor: `prepareCreative(request)` loads background + logo once → `drawCreative(ctx, prepared, t)`; still path renders the rest pose (`t = 1`; each `MotionKind` declares its rest). **Byte-identical stills** are the PR's acceptance test. Own PR, no other change. | `NodeCanvasCompositor.ts` |
| 4.3 | **(D12)** Motion moves background and headline only; accent band and logo static for all `t`. | `NodeCanvasCompositor.ts`, `MotionKind.vo.ts` |
| 4.4 | `CanvasFfmpegVideoCompositor`: frame loop → raw RGBA piped to `ffmpeg-static`. Input side is mandatory for a raw pipe: `-f rawvideo -pix_fmt rgba -s <w>x<h> -framerate <fps> -i -`; output: `-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20 -movflags +faststart -map_metadata -1 -f mp4`. Poster = rest frame; `sampledFrames` at `sampleAt`. | `CreativeGeneration/src/infrastructure/adapters/CanvasFfmpegVideoCompositor.ts` |
| 4.5 | **(M2)** Perf spike before scoping 4.4: measure frames/s on a laptop; encode pool starts at 2. Budget: 10 × 6 s 9:16 variants < 3 min, else default fps 24. **Recorded (see below).** | numbers recorded here |

**4.5 spike results (recorded 2026-08-26, verbatim):**

> Perf spike (plan 4.5) — 2026-08-26, darwin-arm64 laptop, @napi-rs/canvas 0.1 + ffmpeg-static 5, 1080×1920 raw RGBA piped:
> - 30 fps × 6 s veryfast: 180 frames in 1.31 s (137 fps end-to-end), draw 0.1 ms/frame, pipe+encode 6.9 ms/frame, 1.49 GB raw, 1.19 MB mp4
> - 24 fps × 6 s veryfast: 144 frames in 0.74 s (193 fps), 4.7 ms/frame, 1.11 MB
> - 30 fps × 6 s medium:   180 frames in 1.41 s (128 fps), 6.5 ms/frame, 1.01 MB
>
> Acceptance (10 × 6 s < 3 min) met by ~14×. Decisions: fps default 30, preset veryfast (medium costs ~8 % for ~15 % smaller files — optional flag), encode pool 2, no fps fallback needed. Bottleneck is the pipe/encode, not canvas.

The M2 assumption that canvas raster would be the bottleneck was wrong: draw is 0.1 ms/frame; the raw-RGBA pipe and libx264 dominate. `MAX_CONCURRENT_ENCODES = 2` (#54) stands.
| 4.6 | **(D1, L1)** Nitro plugin probes the binary once (warn, don't crash; disables `formats: motion`); same probe in the CLI; `.mp4` in the output content-type map; `ffmpeg-static` row + GPL note in `.agents/tech-stack.md`. | `apps/api/server/plugins/ffmpeg-check.ts`, `apps/api/bin/generate.ts`, `routes/output/[...path].get.ts`, `.agents/tech-stack.md`, `apps/api/package.json` |
| 4.7 | Compliance samples `sampledFrames` with `validateBrandColorDensity`; `ExportPort.saveToDirectory` reused for `.mp4`; proof uses the poster. Generate sets `sampleAt`. | `GenerateCampaignUseCase.use-case.ts` |
| 4.8 | Schema allowlist gains `motion`, `duration`, `formats: motion`. Making motion platform profiles visible **depends on P5 5.1** (`PlatformProfile.vo.ts` does not exist before it) — that half ships after P5. | `load-brief.ts`, (`PlatformProfile.vo.ts` after P5) |
| 4.9 | Grid video cells (poster + hover-play); estimate gains frames/encode minutes. | `grid/page.tsx`, `CommandBar.tsx` |

**Acceptance:** 4.2 lands with zero snapshot diffs; ffmpeg smoke test produces a playable mp4 (skipped when the binary cannot execute); sampled-frame density ≥ threshold for every `MotionKind`.

---

### Phase 3 — Approved Pools (after P1)
**Goal:** LLM-generated headline pools, legal-gated once, chosen by the planner.

| # | Task | File(s) |
|---|------|---------|
| 3.1 | **(L2)** `CopyPool` persisted at `briefs/<id>/pools.json` (directory — invisible to the briefs lister). | `apps/api/server/lib/pools.ts` |
| 3.2 | **(D3, D7, H9)** `CopyGeneratorPort` + `OpenRouterCopyGenerator` (chat completions, text model, key already present). | `CampaignOrchestration/.../ports/out/CopyGeneratorPort.ts`, `CreativeGeneration/.../adapters/OpenRouterCopyGenerator.ts` |
| 3.3 | `POST /campaigns/pools/copy` — generate N, run `validateLegalCopy`, persist with status + reason. Rejected entries are never selectable. | `apps/api/server/routes/campaigns/pools/copy.post.ts` |
| 3.4 | Allowlist gains `headline: pool://copy`; planner resolves the pool at plan time (missing/empty pool → plan failure). | `load-brief.ts`, `PlanVariationsUseCase` |
| 3.5 | Wizard: pool editor + **Generate 10 suggestions**. | `components/wizard/*` |

**Acceptance:** a pool with a rejected entry never appears in any variant; planner golden hash is stable for a fixed pool.

---

### Phase 7 — Quality, Ops & Docs (rolling, per PR)

- Tests adjacent in `__tests__/`; keep the coverage bar. `hexagen arch validate` and `yarn sync --check` green.
- CI stays on the Node version `ci.yml` pins (22, L5); `ffmpeg-static` postinstall verified there in the P4 PR.
- README modes section; Desktop Field Guide PDF refresh after MVP; session-log entry per PR.

---

## 6. Phase Dependency Graph

```
P0 (seed + schema allowlist)
 └── J (job handle)
      └── P2 (planner + generate-from-plan + identity)
           ├── P1 (briefs API + wizard) ── P5 (packaging) ── P6 (grid/estimate)   = MVP
           │        └── P3 (pools)
           └── P4 (drawCreative → port + ffmpeg adapter → video cells; 4.8's profile half waits for P5)
```

---

## 7. Cross-Cutting Concerns

- **Operations notes live here, not in a runbook** (matching the planning convention). Each lands with its phase:
  - *Lost job* (J): `GET /campaigns/jobs/:id` → 404 after a Nitro restart; UI recovers from `GET /campaigns/result`; re-run rejected variants only via `regenerateOnly`.
  - *Report shapes* (P2): classic reports keep the 3-part key; variation reports carry `variantIndex`/`seed`/`policyHash`. Presence of `variantIndex` is the discriminator.
  - *GenAI cache* (P2.6): key format, `output/cache` is safe to delete (re-fetches, cost applies), cross-machine renders may differ by design (D4).
  - *Motion* (P4): boot-check failure message, GPL note, lowering fps, encode pool size, disk pressure from raw pipes.
- **Concurrency.** Backgrounds: `MAX_CONCURRENT_BACKGROUNDS = 8` (unchanged). Encodes: separate pool, starts at 2 (4.5).
- **Cost.** `genai` is an opt-in axis; the estimate shows call count before Run; the cache prevents re-calls on re-render.
- **Security posture.** Local tool: file writes confined to `briefs/`, `assets/inputs/<briefId>/`, `output/`. Path-safe ids everywhere (`SAFE_ID_PATTERN`). No new network surface beyond OpenRouter chat.
- **Hexagen.** New VOs/use-cases in conventional folders → `yarn sync` → commit barrels. Ports exported by hand from `ports/out/index.ts`.

---

## 8. Open Questions

| ID | Question | Blocks |
|----|----------|--------|
| **Q2** | When to add a 4:5 `AspectRatio` (Instagram feed native)? It touches the compositor matrix and every product's render count. | A later Phase 5 extension only |

*Resolved:* ffmpeg (D1), audio (D2), copy provider (D3), GenAI video (deferred to a Phase 8 `VideoGeneratorPort` behind the same opt-in pattern as `FireflyImageGenerator`), reels/TikTok/Shorts in the static MVP (no — D11 and 5.1 hide them until P4).

---

## 9. Risks & Notes

- **Determinism expectations.** Tier 3 will surprise anyone who reads "seeded" as "byte-identical everywhere". The report's cache key and `policyHash` are the answer; the README modes section must say it plainly.
- **Identity migration blast radius.** Six consumers in one PR. Mitigation: classic key untouched, fixture reports for both shapes, merge golden test.
- **Planner feasibility at high counts.** The §4.1 sample's static axes give 2 × 2 × 3 × 3 = 36 discrete combos (432 once motion and duration unlock) against `count: 100`; the estimate will show infeasible until more axes are unlocked or `count` drops. That is the feature working.
- **Motion throughput.** 3.7 GB raw per 15 s variant through a pipe. The spike (4.5) decides fps default and pool size before code is scoped; do not skip it.
- **GenAI cost.** Opt-in axis + estimate + cache. Keys present ⇒ cost warning in the panel.
- **Scope creep from MoneyPrinterTurbo** (narration, subtitles, stock footage, BGM). Out. Revisit only after P4 ships.
- **Field Guide PDF** lags the code already; it will lag more. Refresh is a P7 task, not optional.

---

## 10. Definition of Done

Each item carries the evidence that exists on `main` as of 2026-08-26 (test names are Vitest titles; files are adjacent `__tests__/`). "Partial" means the item is not fully demonstrated by an automated check yet.

1. A variation brief authored in the wizard, with `count: 100` and static axes, runs through the job handle, renders 100 distinct variants (`minDistance ≥ 2`), passes compliance, and packages for `instagram-feed`, `linkedin`, `x` with green manifests.
   *Evidence — partial.* Wizard authoring: `wizard.test.tsx` "toggles remaining axes and saves a randomized brief, offering Replace on 409", "shows a live estimate, a 422 message, and estimate unavailable on 404". Job path: `POST /campaigns/generate` → 202 + `GET /campaigns/jobs/:id` (`jobs.test.ts`, `routes.test.ts`). Planner distance: `PlanVariationsUseCase.use-case.test.ts` "minDistance 2 accepts strictly fewer or equal variants than minDistance 1". Packaging: `PackageForPlatformUseCase.use-case.test.ts` "selects 1:1 assets for instagram-feed and 16:9 for x; 9:16 is not selected", "packages only the included identities (classic triple and variation product/v<index>)"; `packages.test.ts` for the route + zip. **Not shown at `count: 100`**: the static axis product of the shipped sample is 2 × 2 × 1 × 3 = 12 combos (`briefs/sample-randomized.yaml`, `count: 12`, generated end-to-end in #50); `count: 100` on static axes only is infeasible by design (§9) until `motion`/`duration`/`headline` unlock in wave 5. No automated 100-variant end-to-end run exists.
2. Re-running the same brief with the same seed yields an identical `policyHash` and identical PNGs for procedural/asset backgrounds (Tier 1 + 2 golden tests observed passing).
   *Evidence.* Tier 1: `PlanVariationsUseCase.use-case.test.ts` "a fixed two-product brief yields a fixed policyHash and first three variants (golden)", "the same brief twice yields deep-equal plans"; `SeededRandom.vo.test.ts` mulberry32 / FNV-1a goldens. Tier 2: `NodeCanvasCompositor.goldens.test.ts` 12-cell sha256 map keyed `darwin-arm64` / `linux-x64` (skips with a named message elsewhere). GenAI tier: `FileSystemBackgroundCache.test.ts` (cache hit/miss by `(provider, model, prompt, ratio, seed)`), never pixel-golden (D4).
3. A classic brief's report, paths, and compositor snapshots are byte-identical to before this plan.
   *Evidence — partial by platform.* Darwin 12-cell goldens recorded at `6263f1d` (pre-refactor) and unchanged through #45, #49, #54. The linux map was recorded from CI *after* the 4.2 refactor, so it pins the FreeType output going forward but does not prove pre/post identity there. Zero insets: `NodeCanvasCompositor.test.ts` "omitted and all-zero safeInsets produce identical PNG bytes"; the inset pixel golden (`compositor-goldens-insets.json`) exists for `darwin-arm64` only — **linux inset golden not recorded**. Report shape: `report.test.ts` "isPersistedAsset requires the four string identity/path fields" (classic rows carry no `format`/`descriptor`/`variantIndex`/`seed`); `GenerateCampaignUseCase.use-case.test.ts` "produces the full product × ratio matrix for a single (default) treatment", "ignores variation-shaped targets on a classic run".
4. An unsupported axis in a brief is rejected with a message naming it (D8).
   *Evidence.* `load-brief.test.ts` `parseBrief v2 fields` "rejects %s" cases: the motion axis, the duration axis, an unknown axis key, `axes.headline`, a `pool://` string under axes, the motion format; `PlanVariationsUseCase` "undersized axis product fails naming count and axisProductSize". After wave 5 the motion/duration/format cases become capability-gated (rejected with the probe's `reason` when `capabilities.motion` is false) and `headline: pool://copy` becomes the one accepted pool reference — lanes A/B carry the updated cases.
5. Rejecting three variants and re-rolling replaces exactly three rows in the persisted report.
   *Evidence — one row proven, three by composition.* `report.test.ts` "merge of a re-rolled variation slot replaces exactly one row; siblings unchanged"; `GenerateCampaignUseCase.use-case.test.ts` "regenerateOnly + variantIndex calls replan with attempt and generates only those slots", "de-duplicates regenerateOnly targets by variantIndex", "re-roll keeps productId, aspectRatio, and outputPath of the slot"; `PlanVariationsUseCase` "replaces only the target slot and keeps distance versus the others"; `run-context.test.tsx` "re-roll of a variant asset sends productId, variantIndex, attempt and increments", "re-roll after a reload advances from the persisted asset.attempt". No test rejects exactly three and counts rows.
6. `hexagen arch validate`, `yarn sync --check`, lint, typecheck, and tests are green on every merged PR; `.agents/tech-stack.md` lists `ffmpeg-static` before the first motion PR merges.
   *Evidence.* `ci.yml` runs `yarn sync:check`, `yarn lint:arch`, `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test:cov` (100 % statements/branches/functions/lines gate) on every PR; branch protection requires it. The `ffmpeg-static` row (GPL note) lands in the same PR as the first motion machinery (#54), not before it — a same-PR reading of D1, not a preceding one.
7. (Motion train) The `drawCreative` refactor merged with zero snapshot diffs; a motion variant's sampled frames all pass brand density; the perf budget in 4.5 is recorded in this document.
   *Evidence — partial.* 4.2 refactor: #45 with unchanged darwin goldens (see item 3 for the linux caveat); #54 adds "draw at `restT(kind)` is byte-identical to the still for every `MOTION_KINDS` kind" across the 12 cells. Perf budget: recorded in task 4.5. **Sampled-frame density**: `validateBrandColorDensity` over `sampledFrames` is wave 5 lane A (`feat/motion-generation`), in progress — no evidence on `main` yet.

### Deferred (not in any wave)

- **Phase 8 GenAI video** — a `VideoGeneratorPort` behind the same opt-in pattern as `FireflyImageGenerator` (§8, resolved-as-deferred).
- **4:5 `AspectRatio`** (Q2) — touches the compositor matrix and every product's render count; Instagram feed stays on 1:1.
- **SSE for jobs** — polling with backoff (J.3) is the shipped path; D5 lists SSE as optional.
- **Real `done/total` progress** — `GET /campaigns/jobs/:id` reports `0/0` while running and `n/n` on completion (`jobs.test.ts` "createJob starts running at 0/0", "completeJob records assets.length as done/total"); wiring the pipeline log into the counter is still open from wave 1.
- **`withTempProjectRoot` test helper** — the api route tests each build their own tmp dir and swap `PROJECT_ROOT` (`briefs.test.ts`, `pools.test.ts`, `assets.test.ts`, …); the shared helper noted in the #47 review has not been extracted.
- **Structured logger** — `AGENTS.md` mandates `logger.*`; the api routes/plugins still use `console.warn` for skipped briefs, the ffmpeg probe, and provider detection (exempt as "server startup" only in part).
- **Linux inset golden** — record `compositor-goldens-insets.json` for `linux-x64` from CI (items 3 and 7 above).
- **Desktop Field Guide PDF refresh** (P7) — still lags the code.
