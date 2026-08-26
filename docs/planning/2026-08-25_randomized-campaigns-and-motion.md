# Randomized Campaigns, Motion Creatives & Create New Project — Architecture & Development Plan

**Date:** 2026-08-25
**Status:** Revised (decisions D1–D14 locked; two open questions) — supersedes the v1 draft of the same day
**Scope:** `packages/CampaignOrchestration`, `packages/CreativeGeneration`, `packages/Distribution`, `packages/GovernanceAndCompliance`, `packages/shared`, `apps/api`, `apps/web`, `briefs/`, `.agents/`
**Related:** `.agents/session-log.md` (2026-08-25 review + revision entries), `.agents/tech-stack.md`, `.agents/testing.md`

> **Revision note.** This version incorporates four independent plan reviews (findings C1–C4, H1–H9, M1–M6, L1–L5 in §2) and three product decisions from the author (D1–D3). The most consequential corrections vs. the first draft: byte-level determinism is **not** promised for GenAI backgrounds or mp4 containers; a **job handle** moves into the MVP; variant identity is **`productId/variantIndex`** and is migrated across every consumer in one PR; new ports live in **CampaignOrchestration**, never in CreativeGeneration; `/brief` **stays an editor**; the parser **rejects** not-yet-supported axes instead of silently running the classic matrix.

---

## 0. Locked Decisions

| ID | Decision | Consequence |
|----|----------|-------------|
| **D1** | **`ffmpeg-static`**, version pinned. No system ffmpeg. | Zero setup, same binary locally and in CI. GPL-licensed binary — note for client distribution. Row added to `.agents/tech-stack.md` in the same PR. Boot check *executes* the resolved binary; the "binary missing" story is a boot-check failure, not a wizard branch. |
| **D2** | **No audio** in the motion MVP. | No BGM pool, no loudness, no muxing. Later: a locked `bgm` asset referenced from the brief. |
| **D3** | **OpenRouter chat** (text model) for copy pools via a new adapter. | The existing image adapters (`OpenRouterImageGenerator`, `GeminiImageGenerator`) are not reusable for text. Gemini text is a possible second adapter, not a reuse. |
| **D4** | **Determinism is tiered** (§3). Plan and composite are bit-stable; GenAI sources are cached and attributed; mp4 is frame-deterministic, container-approximate. | Golden tests assert on the plan JSON and canvas frames only. Never on GenAI pixels or mp4 bytes. |
| **D5** | **Job handle in the MVP.** `POST /campaigns/generate` → `202 { jobId }` + `GET /campaigns/jobs/:id` polling; in-memory store; SSE optional later. | Nothing at N=100 ships on the synchronous POST (it already overran the Next proxy on a 12-cell demo). Classic mode uses the same path. |
| **D6** | **Variant identity = `productId/variantIndex`** in variation mode; `seed` is provenance. Classic key `productId/aspectRatio/treatment` unchanged. | One PR migrates `report.ts keyOf`, `run-context assetKey`, `RegenerationTarget` + `parseRegenerateOnly`, grid, export, `bin/generate.ts`. Merge is golden-tested. |
| **D7** | **Ports live in `CampaignOrchestration/application/ports/out`.** `VideoCompositorPort`, `CopyGeneratorPort` sit beside `CompositorPort`. Adapters stay in CreativeGeneration. | Matches current law (CreativeGeneration's `ports/` dirs are empty by design); `hexagen arch validate` stays green. |
| **D8** | **Parser allowlist.** `parseBrief` validates v2 fields against `SUPPORTED_AXES` / `SUPPORTED_FORMATS` that grow as phases land; unsupported values are a 400. | A variation brief can never silently run as the classic matrix. Schema ships in P0 without implying pools or motion exist. |
| **D9** | **`/brief` stays the in-memory editor** and gains *Save to briefs/*. The wizard at `(shell)/new` authors from scratch. | The current tweak → Run HITL loop is preserved. |
| **D10** | **`MINIMUM_PRODUCTS` relaxes to 1 in `mode: variation`**; classic keeps 2. | Single-SKU randomized campaign — the flagship case — is allowed. Wizard and use case share the rule and message. |
| **D11** | **Packaging never re-renders.** Platform profiles map onto the three existing canvases; safe insets are applied at *generation* as the union of insets for platforms sharing a ratio; classic briefs pass zeros. | No 100 × 7 explosion; classic output byte-identical (snapshot-guarded). 4:5 is a later `AspectRatio` extension. Reels/TikTok/Shorts listed only after motion (P4). |
| **D12** | **Brand floor is static across `t`.** Motion moves background and headline only; accent band and logo never animate. | Per-frame density holds by construction; compliance samples frames as a regression guard. No per-frame logo-localisation ("logo-hold") detector is invented. |
| **D13** | **Planner fails loud.** `count` is the total; distance is Hamming over discrete axes (continuous axes are enumerated steps); over-generate to `count × 3`; if accepted < `count` the plan fails with the shortfall and the axis-product size. Re-roll is `replan(plan, index, attempt)` inside the planner. | Never emits near-duplicates; re-roll stays golden-tested and distance-checked. |
| **D14** | **Lint rule is scoped.** `no-restricted-properties` for `Math.random` / `Date` applies to `CampaignOrchestration/domain/**`, the planner use case, and `shared/domain/**` only. | `PipelineExecutionLog` (`new Date()`) and Firefly IMS expiry (`Date.now()`) keep working. |

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

Phases are atomic and independently mergeable. **P0 → J → P2 → P1 → P5 → P6 (partial) is the MVP** (randomized static campaigns, authored in the UI, packaged per platform). P4 (motion) and P3 (pools) are independent follow-on trains.

---

### Phase 0 — Foundations
**Goal:** the seed primitive exists, the v2 schema parses with a strict allowlist, and nothing else changes.

| # | Task | File(s) |
|---|------|---------|
| 0.1 | `SeededRandom` VO + `seedFrom`; `yarn sync`; commit barrels. | `packages/shared/src/domain/value-objects/SeededRandom.vo.ts` |
| 0.2 | **(D14)** Scoped `no-restricted-properties` rule for `Math.random` / `Date`. | `packages/CampaignOrchestration/eslint.config.js`, `packages/shared/eslint.config.js` |
| 0.3 | `CampaignBrief` gains optional `mode`, `variation`, `output`. | `CampaignOrchestration/src/domain/entities/CampaignBrief.ts` |
| 0.4 | **(D8, H3)** `parseBrief` validates v2 blocks against `SUPPORTED_AXES` / `SUPPORTED_FORMATS`; unsupported → throws (400). | `apps/api/server/lib/load-brief.ts` |
| 0.5 | `?model=` vs `genai` axis: axis decides *whether*, `?model=` decides *which provider*. `paletteShift` applied only by `ProceduralBackgroundGenerator`. Document in `pipeline.ts`. | `apps/api/server/lib/pipeline.ts` |
| 0.6 | Sample brief (static axes only). | `briefs/sample-randomized.yaml` |

**Acceptance:** all existing tests green; a v2 brief with `motion:` or `pool://` is rejected with a message naming the unsupported axis; `seedFrom("a","1","0")` is stable across runs and platforms (golden).

---

### Phase J — Job Handle (D5, H2)
**Goal:** long runs survive the proxy; the UI recovers from a lost job.

| # | Task | File(s) |
|---|------|---------|
| J.1 | `POST /campaigns/generate` → `202 { jobId }`; run continues in-process; `writeReport` on completion. | `apps/api/server/routes/campaigns/generate.post.ts`, `apps/api/server/lib/jobs.ts` |
| J.2 | `GET /campaigns/jobs/:id` → `{ status, done, total, log, result? }`; 404 for unknown (restart). | `apps/api/server/routes/campaigns/jobs/[id].get.ts` |
| J.3 | `run-context` polls; on 404 recovers from `GET /campaigns/result`. Classic mode uses the same path. | `apps/web/src/lib/run-context.tsx` |
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
| 2.4 | `GenerateCampaignUseCase`: when `mode === "variation"` call the planner internally; cells = variants; `MINIMUM_PRODUCTS` → 1 in that mode (D10). Inbound port unchanged. | `GenerateCampaignUseCase.use-case.ts` |
| 2.5 | **(D6, C2)** Identity migration: `GeneratedAsset` fields; `keyOf` / `assetKey` branch on `variantIndex`; `RegenerationTarget` + `parseRegenerateOnly` accept `variantIndex` + `attempt`; grid, export, CLI. Output path `<product>/<ratio>/v<index>.png`. | `report.ts`, `run-context.tsx`, `load-brief.ts`, `grid/page.tsx`, `export/page.tsx`, `bin/generate.ts` |
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
| 1.5 | Wizard `(shell)/new`: Campaign type → Brand & products → Copy → Variation policy → Output → Review. Randomized type enabled only when P2 is merged; "Generate suggestions" hidden until P3. | `apps/web/src/app/(shell)/new/page.tsx`, `components/wizard/*` |
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
| 4.4 | `CanvasFfmpegVideoCompositor`: frame loop → raw RGBA piped to `ffmpeg-static`; `-r fps -pix_fmt yuv420p -c:v libx264 -preset veryfast -crf 20 -movflags +faststart -map_metadata -1`; poster = rest frame; `sampledFrames` at `sampleAt`. | `CreativeGeneration/src/infrastructure/adapters/CanvasFfmpegVideoCompositor.ts` |
| 4.5 | **(M2)** Perf spike before scoping 4.4: measure frames/s on a laptop; encode pool starts at 2 (canvas raster is the bottleneck, not ffmpeg). Budget: 10 × 6 s 9:16 variants < 3 min, else default fps 24. | spike branch; numbers into this doc |
| 4.6 | **(D1, L1)** Boot check executes the binary; `.mp4` in the output content-type map; `ffmpeg-static` row + GPL note in `.agents/tech-stack.md`. | `apps/api/server/lib/env.ts`, `routes/output/[...path].get.ts`, `.agents/tech-stack.md`, `apps/api/package.json` |
| 4.7 | Compliance samples `sampledFrames` with `validateBrandColorDensity`; `ExportPort.saveToDirectory` reused for `.mp4`; proof uses the poster. Generate sets `sampleAt`. | `GenerateCampaignUseCase.use-case.ts` |
| 4.8 | Schema allowlist gains `motion`, `duration`, `formats: motion`; profiles with `formats: [motion]` become visible. | `load-brief.ts`, `PlatformProfile.vo.ts` |
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
           └── P4 (drawCreative → port + ffmpeg adapter → video cells)
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
| **Q1** | Offer reels/TikTok/Shorts in the static MVP? They map to 9:16 stills today. **Recommendation: no** — hide until P4 (already the default in 5.1). | Nothing; confirms 5.1 |
| **Q2** | When to add a 4:5 `AspectRatio` (Instagram feed native)? It touches the compositor matrix and every product's render count. | A later Phase 5 extension only |

*Resolved:* ffmpeg (D1), audio (D2), copy provider (D3), GenAI video (deferred to a Phase 8 `VideoGeneratorPort` behind the same opt-in pattern as `FireflyImageGenerator`).

---

## 9. Risks & Notes

- **Determinism expectations.** Tier 3 will surprise anyone who reads "seeded" as "byte-identical everywhere". The report's cache key and `policyHash` are the answer; the README modes section must say it plainly.
- **Identity migration blast radius.** Six consumers in one PR. Mitigation: classic key untouched, fixture reports for both shapes, merge golden test.
- **Planner feasibility at high counts.** The sample policy has ~48 discrete combos against `count: 100`; the estimate will show infeasible until more axes are unlocked or `count` drops. That is the feature working.
- **Motion throughput.** 3.7 GB raw per 15 s variant through a pipe. The spike (4.5) decides fps default and pool size before code is scoped; do not skip it.
- **GenAI cost.** Opt-in axis + estimate + cache. Keys present ⇒ cost warning in the panel.
- **Scope creep from MoneyPrinterTurbo** (narration, subtitles, stock footage, BGM). Out. Revisit only after P4 ships.
- **Field Guide PDF** lags the code already; it will lag more. Refresh is a P7 task, not optional.

---

## 10. Definition of Done

1. A variation brief authored in the wizard, with `count: 100` and static axes, runs through the job handle, renders 100 distinct variants (`minDistance ≥ 2`), passes compliance, and packages for `instagram-feed`, `linkedin`, `x` with green manifests.
2. Re-running the same brief with the same seed yields an identical `policyHash` and identical PNGs for procedural/asset backgrounds (Tier 1 + 2 golden tests observed passing).
3. A classic brief's report, paths, and compositor snapshots are byte-identical to before this plan.
4. An unsupported axis in a brief is rejected with a message naming it (D8).
5. Rejecting three variants and re-rolling replaces exactly three rows in the persisted report.
6. `hexagen arch validate`, `yarn sync --check`, lint, typecheck, and tests are green on every merged PR; `.agents/tech-stack.md` lists `ffmpeg-static` before the first motion PR merges.
7. (Motion train) The `drawCreative` refactor merged with zero snapshot diffs; a motion variant's sampled frames all pass brand density; the perf budget in 4.5 is recorded in this document.
