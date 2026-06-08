# Test Coverage Plan — Campaign Foundry → 100%

**Branch:** `feat/test-coverage`
**Runner:** **Vitest** (v8 coverage, happy-dom for the UI)
**Goal:** Take the repository from **zero tests** to **100% coverage**
(statements / branches / functions / lines) across every workspace, with the
gate enforced in CI.

This is the implementation plan. It is ordered so coverage rises in meaningful
order (highest-value business logic first) and so each phase is independently
shippable. Vitest was chosen deliberately over the original `node:test` stack:
the 100% target includes the Next.js UI, and Vitest's built-in DOM environment
and zero-config v8 coverage remove the two biggest risks of a hand-wired
`node:test` + `c8` + `tsx` setup. The repo's test contract
(`.agents/testing.md`, `.agents/tech-stack.md`) was updated to match.

---

## 0. Guiding principles

1. **Vitest + `expect`, with `vi` for mocking.** `describe`/`test`/`expect` from
   `vitest`; `vi.fn()` / `vi.spyOn()` / `vi.mock()` for seams. Tests live in a
   `__tests__/` directory adjacent to the module, named `*.test.ts` (`*.test.tsx`
   for UI). UI tests use `@testing-library/react` under happy-dom.
2. **The architecture already paid for these tests.** The use case depends only on
   ports, so the entire pipeline is unit-testable with four in-memory fake
   adapters and **zero real I/O**. That is the spine of this plan — write the
   fakes once, reuse everywhere.
3. **Unit by default, integration by exception.** Pure logic and port-driven
   orchestration are unit tests with fakes. Code that *is* the I/O seam (canvas
   compositing, PDF export, filesystem persistence, HTTP routes, the CLI) gets a
   small, named, isolated integration layer using real adapters against a temp
   directory and fixture assets.
4. **100% is a ratchet, not a vanity metric.** Branch coverage is in the gate, the
   inventory targets *behaviours* not lines, and every coverage exclusion is
   justified in writing.

---

## 1. The honest scope decisions (resolve these first)

### 1a. Dead generated scaffolding — **delete it** (recommended)

Four files are unimplemented generator stubs with `TODO` bodies and no real
behaviour:

| File | Status |
| --- | --- |
| `packages/shared/src/infrastructure/adapters/Prisma.adapter.ts` | empty class, no port, no callers |
| `packages/shared/src/infrastructure/adapters/BullMQ.adapter.ts` | empty class, no port, no callers |
| `packages/shared/src/domain/value-objects/CustomError.vo.ts` | stub factory that validates nothing |
| `packages/shared/src/domain/value-objects/Identifier.vo.ts` | stub factory that validates nothing |

They are exported from `shared`'s barrels but used nowhere. "Covering" them means
testing code that lies about the system's capabilities (there is no database, no
job queue). **Recommendation: delete all four and their barrel re-exports.** The
fallback is to coverage-ignore them with a written justification — but deletion is
the honest move and is the default this plan assumes.

### 1b. The Next.js UI — happy-dom + Testing Library

Vitest's `happy-dom` environment gives us a DOM for free; we add
`@testing-library/react` + `@testing-library/user-event` + `@vitejs/plugin-react`
to render and drive components. This is the only place the plan adds libraries,
and it was the deciding factor in choosing Vitest — covering `run-context.tsx` and
~20 components/pages is a config line here rather than a hand-rolled DOM shim.

### 1c. Small seam refactors to make adapters testable cleanly

- **`GeminiImageGenerator`** — accept an optional pre-built client
  (`models.generateImages`-shaped) in its options, defaulting to
  `new GoogleGenAI(...)`. Lets a test inject a `vi.fn()` instead of hitting Google.
  ~3 lines, behaviour-preserving.
- **`OpenRouterImageGenerator`** — already uses global `fetch`; mock with
  `vi.spyOn(globalThis, "fetch")`. No refactor needed.
- **API routes** — keep them thin (parse → delegate → serialize) so their logic is
  already unit-covered via `lib/`; the routes themselves are covered by the HTTP
  integration layer (§4). No logic should live in a route that isn't reachable
  from `lib/`.

> Each refactor ships with the test that motivated it.

---

## 2. Test infrastructure (Phase 0 — done)

### 2.1 Tooling

- **Runner/transform:** Vitest (Vite + esbuild). Runs the TS source directly;
  Vite resolves the codebase's `.js`-suffixed imports to their `.ts` files
  (validated). No `tsx`, no build step before tests.
- **Coverage:** `@vitest/coverage-v8` — V8 coverage with source-map remap to
  `.ts`/`.tsx`, one flag (`--coverage`).
- **DOM:** `happy-dom` + `@testing-library/react` + `@testing-library/user-event`
  + `@vitejs/plugin-react` (web project only).

### 2.2 Root `vitest.config.ts` (two projects, one coverage report)

```ts
projects: [
  { extends: true, test: { name: "node", environment: "node",
      include: ["packages/*/src/**/*.test.ts", "apps/api/server/**/*.test.ts", "apps/api/bin/**/*.test.ts"] } },
  { extends: true, plugins: [react()],
    resolve: { alias: { "@": webSrc }, dedupe: ["react", "react-dom"] },
    test: { name: "web", environment: "happy-dom",
      include: ["apps/web/src/**/*.test.{ts,tsx}"], setupFiles: ["./apps/web/vitest.setup.ts"] } },
]
```

`apps/web/vitest.setup.ts` calls RTL `cleanup()` after each test.

### 2.3 Root scripts

```jsonc
"test":       "vitest run",
"test:cov":   "vitest run --coverage",
"test:watch": "vitest"
```

A single root config covers all workspaces, so no per-package `test` scripts are
needed. CI runs `yarn test` (and `yarn test:cov` once the gate is on).

### 2.4 Coverage config + justified exclusions

Configured in `vitest.config.ts` under `test.coverage`. Excludes are all
non-executable or generated: `**/index.ts` (re-export barrels), `**/*.config.*`,
`**/*.d.ts`, `**/__tests__/**`, the root `layout.tsx` html/body shell. Type-only
files (entity/port interfaces, `BackgroundSource`, `LogEntry`, `ComplianceResult`,
`PipelineResult`) emit no runtime code and need no handling.

The `thresholds: { 100: true }` gate is **added in the final phase** so
intermediate commits stay green; until then `test:cov` only reports.

### 2.5 CI

`.github/workflows/ci.yml` already runs `yarn test`. Switch the Test step to
`yarn test:cov` when the gate goes on; Node 22 in CI is fine for Vitest.

### 2.6 Shared test toolkit

`packages/CampaignOrchestration/src/application/use-cases/__tests__/_fakes.ts`
houses the four reusable in-memory fakes built on `vi.fn()`:

```ts
export const fakeImageGenerator = (source: BackgroundSource = "procedural"): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({ image: new Uint8Array([1, 2, 3]), source })),
});
export const fakeCompositor = (logoApplied = true): CompositorPort => ({
  compositeAsset: vi.fn(async () => ({ image: new Uint8Array([4, 5, 6]), logoApplied })),
});
export const fakeCompliance = (opts?: { legalPass?: boolean; density?: number }): CompliancePort => ({ /* ... */ });
export const recordingExporter = (): ExportPort & { saved: string[]; proofs: string[] } => ({ /* ... */ });
```

These make the use case's behaviour testable via assertions on *what the ports
were called with*, not on real images.

---

## 3. Coverage inventory — unit tests (the core, by value)

Each row is one `__tests__/<module>.test.ts` file.

### Phase 1 — `CampaignOrchestration` (the business core; highest ROI)

| Module | Behaviours to cover |
| --- | --- |
| `application/use-cases/GenerateCampaignUseCase` | **The big one.** Validation: rejects non-slug id, duplicate product ids, `< 2` products, non-slug treatment id, duplicate treatment ids; accepts a valid brief. Legal gate: halts on prohibited copy (campaign **and** localized message), returns `halted:true` + empty assets + zero generator calls. Happy path: full `product × ratio × treatment` matrix count; asset order product→ratio→treatment; `outputPath` namespacing on for >1 treatment, off for one; localized-message fallback; `backgroundSource` propagated; warn log on procedural. Selective regen: only targeted cells run, others untouched, proof rewritten only when its hero is targeted. Hero/proof: one proof per product from its 1:1 first-treatment composite. `mapWithConcurrency`: order preserved with `limit < n`, `limit > n`, `n = 0`. |
| `domain/value-objects/AspectRatio.vo` | `create` ok per ratio; err for unknown; `all()` returns three; `slug` colon→x; `equals` true/false; dimensions. |
| `domain/value-objects/Treatment.vo` | `SAFE_ID_PATTERN` accepts valid, rejects uppercase / `..` / slash / empty / >64; `DEFAULT_TREATMENT`; layout/tone membership. |
| `domain/value-objects/PipelineExecutionLog.vo` | `record` appends w/ level+timestamp; default `info`; `complete()` sets `completedAt`; `entries` read-only; `toJSON` shape. |

### Phase 2 — driven adapters (`CreativeGeneration`, `GovernanceAndCompliance`)

| Module | Type | Behaviours |
| --- | --- | --- |
| `CreativeGeneration/.../canvas-util` | unit | `hexToRgb` short/6-digit/no-`#`/pad/truncate; `wrapText` wraps, single long word, empty → `[text]`. |
| `CreativeGeneration/.../safe-path` | unit | accepts `assets/inputs/x.png`; rejects absolute, `../` escape, empty, outside `assets/`. |
| `CreativeGeneration/.../ProceduralBackgroundGenerator` | unit | `source:"procedural"`; deterministic; non-empty PNG; ignores context. |
| `CreativeGeneration/.../AssetReusingImageGenerator` | unit | `inputAsset` present+readable → `reused`, no delegate; missing/unsafe/unreadable → delegates (wrapped = `vi.fn()`). |
| `CreativeGeneration/.../GeminiImageGenerator` | unit (injected client) | success → `imagen`, prompt contents; client throws → fallback; throws w/o fallback; empty data → fallback. |
| `CreativeGeneration/.../OpenRouterImageGenerator` | unit (mock `fetch`) | success → `openrouter`; modality-mismatch retry; non-OK → fallback; `extractImageUrl` variants; `decodeDataUrl`; ratio→aspect map. |
| `GovernanceAndCompliance/.../BrandComplianceChecker` | unit (synthetic image) | `validateLegalCopy` clean/each term/case-insensitive/multi-hit reason; `validateBrandColorDensity` solid passes, black fails, ±10 boundary, score formula, `total=0` guard (build the PNG in-memory). |

### Phase 3 — `shared`

| Module | Behaviours |
| --- | --- |
| `domain/result` | `ok`/`err` shapes; type narrowing. *(Done — Phase 0 smoke test.)* |
| `infrastructure/project-root` | `PROJECT_ROOT` override wins; walks to marker; cwd fallback at fs root; memoization (reset module between tests). |

---

## 4. Coverage inventory — integration tests (the I/O seams)

Real adapters, `mkdtemp` working dirs, fixture assets under `__tests__/fixtures/`.

### Phase 4 — `Distribution` + `CreativeGeneration` rendering

| Module | Behaviours |
| --- | --- |
| `Distribution/.../FileSystemExporter` | `saveToDirectory` writes bytes (creates dirs); `generatePrintProof` writes a valid PDF (`%PDF`, crop marks, footer); `resolveSafe` throws on `../` in both methods. |
| `CreativeGeneration/.../NodeCanvasCompositor` | renders PNG at each ratio's exact dimensions; `logoApplied` true (fixture logo) / false on `ENOENT` / false+warn on corrupt; `headline-top`/`-bottom` × `bold`/`subtle` branches; deterministic bytes. |
| `CreativeGeneration/.../fonts` | registers from `assets/fonts` (idempotent); warns once when none found (temp cwd). |

### Phase 5 — `apps/api` lib + routes + CLI

| Module | Type | Behaviours |
| --- | --- | --- |
| `server/lib/env` | unit | `applyEnvFile` parse/quote-strip/skip/no-override; provider-detection logs (imagen/openrouter/both/none); idempotent `loadEnv`. Save/restore `process.env`. |
| `server/lib/config` | unit | default `<root>/output`; `OUTPUT_DIR` override (abs + rel). |
| `server/lib/load-brief` | unit | `parseBrief` each missing field / non-object / non-slug ids / non-array; `validateTreatments` bad layout/tone/dup; `parseRegenerateOnly` undefined/non-array/empty/non-string/valid; `loadBrief` yaml/yml/json. |
| `server/lib/pipeline` | unit (env) | `ALLOWED_IMAGE_MODELS`; `imageGenerator` selection branches (procedural / `<provider>/<model>` w/ key set+unset / default+imagen); reuse decorator outermost; `buildPipeline`/`runCampaign` smoke to temp dir. |
| `server/lib/report` | integration | `campaignReportPath` safe/unsafe; `latestReportPath`; `isKeyable`; `readPersistedAssets` missing/corrupt/non-array/drops-unkeyable; `writeReport` fresh (per-campaign+latest, derives `brandCompliant`); merge overlays by identity, preserves untouched, merges per-campaign not latest. |
| `server/routes/*` | integration (HTTP) | Boot the Nitro/h3 app. `GET /`; `POST /generate` bare/envelope/400/unknown-model-400/422; `GET /result` latest / `?campaignId=` / unknown→EMPTY / non-string→EMPTY; `GET /briefs` lists+skips malformed; `GET /output/**` streams / 404 / 400 traversal / content-type. |
| `bin/generate.ts` | integration | Export `main()`; run vs sample brief into temp `OUTPUT_DIR` → exit 0, report written; legal-gate brief → halted; `<2` products → exit 1. |

### Phase 6 — `apps/web` (happy-dom)

| Module | Type | Behaviours |
| --- | --- | --- |
| `lib/cn` | unit | merges; later Tailwind class wins; conditional/array inputs. |
| `lib/models` | unit | `labelFor` null/known/unknown; catalog ids mirror `ALLOWED_IMAGE_MODELS` (drift guard). |
| `lib/aspect-ratios` | unit | order matches domain set (drift guard). |
| `lib/run-context` | DOM | `useRun` outside provider throws; `assetKey`; `execute` posts brief + populates (mock `fetch`); **stale-run guard** (overlapping resolutions → second wins); `assetVersion` bump; `decide` toggle; `regenerateRejected` no-op/envelope/overlay/clear; `localStorage` persist+validated restore; `setBrief` keep-on-match vs fetch; error path message. |
| `components/shell/CommandBar` | DOM | expected-count math; confirm gate; regenerate button visibility; disabled while loading; status/colour. |
| `components/shell/*` | DOM | render under provider; model select; brief picker select; telemetry toggle; accordion. |
| `app/(shell)/*` pages | DOM | empty vs populated; grid pivot + badges + preview modal (esc/focus-trap) + per-tile spinner; export approved-only + dedup proofs; compliance row+gate; layout orchestrator only on `/grid`. |
| `components/ui/*` | DOM | variant classes; prop passthrough. |

---

## 5. Phased rollout & sequencing

| Phase | Scope | Status |
| --- | --- | --- |
| **0** | Vitest harness, config, scripts, fakes toolkit, §1a deletions, §1c refactors | ✅ done |
| **1** | `CampaignOrchestration` core | ✅ done |
| **2** | `CreativeGeneration` + `GovernanceAndCompliance` units | ✅ done |
| **3** | `shared` | ✅ done |
| **4** | Rendering/export integration | ✅ done |
| **5** | `apps/api` lib + routes + CLI | ✅ done |
| **6** | `apps/web` (happy-dom) | ✅ done |

**Result: 100%** statements/branches/functions/lines across all workspaces —
271 tests across 37 files, gate enforced in CI.

Each phase ends green for the modules it touches. The repo-wide
`thresholds: { 100: true }` gate flips on in the final commit; CI switches to
`yarn test:cov` at the same time.

---

## 6. Definition of done

- [ ] `yarn test:cov` reports **100%** statements/branches/functions/lines.
- [ ] `vitest.config.ts` carries the 100% threshold gate.
- [ ] CI runs `yarn test:cov` and fails under 100%.
- [ ] Every coverage exclusion is non-executable or generated, justified inline.
- [ ] No production path is reachable only from a route/CLI that lacks a test.
- [ ] Dead stubs resolved per §1a.
- [ ] Seam refactors (§1c) each shipped with their motivating test.
- [ ] `.agents/session-log.md` appended.

---

## 7. Risks & trade-offs

- **"100%" can incentivize hollow tests.** Mitigation: branch coverage in the
  gate; the inventory targets behaviours, not lines.
- **The UI is the long pole** (~20 components/pages + the provider). If timeline
  pressure hits, ship Phases 0–5 (full backend + domain at 100%) and land Phase 6
  behind a temporary per-project threshold rather than weakening the backend gate.
- **Nitro route testing** prefers booting the app (covers real wiring incl.
  auto-imports), accepting a slower, isolated integration suite.
- **Single React instance.** The web project sets `resolve.dedupe: ["react",
  "react-dom"]` so root-installed RTL and `apps/web`'s React never double up
  ("invalid hook call").

---

## 8. Estimated shape (rough)

| Area | Test files | Character |
| --- | --- | --- |
| `CampaignOrchestration` | ~5 | unit, fakes |
| `CreativeGeneration` | ~7 | unit + 2 integration |
| `GovernanceAndCompliance` | ~1 | unit (synthetic images) |
| `shared` | ~2 | unit |
| `apps/api` | ~7 | mostly integration |
| `apps/web` | ~20 | DOM |
| **Total** | **~40 files** | — |

The backend + domain (Phases 0–5, ~22 files) is the high-value majority. The UI
(Phase 6) is the remaining surface and the main beneficiary of the Vitest choice.
