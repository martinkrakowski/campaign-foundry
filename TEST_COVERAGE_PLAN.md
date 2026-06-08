# Test Coverage Plan — Campaign Foundry → 100%

**Branch:** `feat/test-coverage`
**Goal:** Take the repository from **zero tests** to **100% coverage**
(statements / branches / functions / lines) across every workspace, using the
stack the repo already mandates — `node:test` + `node:assert/strict`, tests in
`__tests__/` dirs, fakes injected at the ports — and wire coverage enforcement
into Turbo and CI.

This is a **plan**, not the implementation. It is ordered so coverage rises in
meaningful order (highest-value business logic first) and so each phase is
independently shippable.

---

## 0. Guiding principles

1. **Honor the existing contract.** `.agents/testing.md` is law: `node:test`
   runner, `node:assert/strict` assertions, `*.test.ts` files in a `__tests__/`
   directory adjacent to the module, `mock.fn()` over external mock libs, no
   `expect()`, no Jest/Vitest/Mocha/Chai. One behaviour per test; the name states
   the behaviour.
2. **The architecture already paid for these tests.** The use case depends only on
   ports, so the entire pipeline is unit-testable with four in-memory fake
   adapters and **zero real I/O**. That is the spine of this plan — write the
   fakes once, reuse everywhere.
3. **Unit by default, integration by exception.** Pure logic and port-driven
   orchestration are unit tests with fakes. Code that *is* the I/O seam (canvas
   compositing, PDF export, filesystem persistence, HTTP routes, the CLI) gets a
   small, **named, isolated** integration layer that uses real adapters against a
   temp directory and fixture assets — exactly as `.agents/testing.md` permits.
4. **100% is a ratchet, not a vanity metric.** We enforce thresholds in CI so the
   number can never regress, and we justify every coverage exclusion in writing.

---

## 1. The honest scope decisions (resolve these first)

Three things stand between us and a *truthful* 100%. Each needs an explicit
decision, recorded here, before any test is written.

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
writing tests for code that lies about the system's capabilities (there is no
database, no job queue). **Recommendation: delete all four and their barrel
re-exports.** This removes ~4 files of misleading surface *and* removes the
coverage burden. If product direction is to keep them as scaffolding, the
fallback is to `c8`-ignore them with a written justification — but deletion is
the honest move and is the default this plan assumes.

> Decision owner: maintainer. Default: **delete**.

### 1b. The Next.js UI — DOM testing is required for true 100%

`node:test` has no DOM. To cover `run-context.tsx` (stateful provider) and the
React components/pages, we need a DOM global. The thread-the-needle solution that
stays inside the contract:

- **Runner stays `node:test`.** Assertions stay `node:assert/strict`.
- Add **`happy-dom`** (register a DOM global) + **`@testing-library/react`** +
  **`@testing-library/user-event`** as `devDependencies` of `apps/web` only.
- This brings **no `expect()` and no competing runner** — RTL renders, we assert
  with `node:assert`. It is compatible with `.agents/testing.md`'s prohibitions.

This is the one place the plan adds libraries. Update `.agents/tech-stack.md` in
the same change (the doc explicitly asks for this) so the stack reference doesn't
go stale.

> Decision owner: maintainer. Default: **add the DOM layer** (the alternative —
> excluding the UI — means the headline "100%" wouldn't include the review UI,
> which is half the product).

### 1c. Small seam refactors to make adapters testable cleanly

Two adapters construct their external client internally, which forces ugly module
mocking. A *minimal* refactor makes them honestly injectable:

- **`GeminiImageGenerator`** — accept an optional pre-built client
  (`models.generateImages`-shaped) in its options, defaulting to
  `new GoogleGenAI(...)`. Lets a test inject a `mock.fn()` instead of hitting
  Google. ~3 lines.
- **`OpenRouterImageGenerator`** — already uses global `fetch`; no refactor
  needed (mock `globalThis.fetch` with `mock.method`). Documented here so we
  don't refactor it needlessly.
- **API routes** — keep them *thin* (parse → delegate → serialize) so the
  business logic they call is already unit-covered via `lib/`; the routes
  themselves get covered by the HTTP integration layer (§4). No logic should
  live in a route that isn't reachable from `lib/`.

> These are behaviour-preserving and each ships with the test that proves it.

---

## 2. Test infrastructure (Phase 0 — do this before any test)

### 2.1 TypeScript execution

Packages run from source (`"main": "src/index.ts"` + path mapping), so tests must
execute TS directly. The repo already depends on **`tsx`**. Run tests with:

```
node --import tsx --test "src/**/*.test.ts"
```

(Node 22 in CI; `tsx` strips types and emits inline source maps, which the
coverage tool consumes.)

### 2.2 Coverage tool: `c8`

Node's built-in `--experimental-test-coverage` does not remap through `tsx`
cleanly on Node 22. Use **`c8`** (V8 coverage + source-map remap to `.ts`) at the
**repo root** as a dev dependency:

```
c8 --reporter=text --reporter=lcov \
   node --import tsx --test "<workspace>/**/*.test.ts"
```

### 2.3 Per-package `test` script

`turbo.json` already declares a `test` task (`dependsOn: ^build`) and CI already
calls `yarn test`, but **no package defines a `test` script today**, so the suite
is currently a no-op. Add to each workspace `package.json`:

```jsonc
"scripts": {
  "test": "node --import tsx --test \"src/**/*.test.ts\"",
  "test:cov": "c8 --100 node --import tsx --test \"src/**/*.test.ts\""
}
```

(`apps/web` uses `\"src/**/*.test.ts\" \"src/**/*.test.tsx\"`; `apps/api` globs
`server/**` and `bin/**`.)

### 2.4 Root-level aggregate coverage

Add a root script that measures coverage across the whole monorepo in one pass
(so cross-package c8 merging is unnecessary):

```jsonc
"scripts": {
  "test:cov": "c8 --100 --reporter=text --reporter=lcov node --import tsx --test \"{packages,apps}/**/src/**/*.test.{ts,tsx}\" \"apps/api/server/**/*.test.ts\" \"apps/api/bin/**/*.test.ts\""
}
```

### 2.5 `.c8rc.json` (coverage config + justified exclusions)

```jsonc
{
  "all": true,                       // count untested files as 0%, not invisible
  "100": true,                       // fail under 100% on any metric
  "src": ["packages", "apps"],
  "include": ["**/src/**/*.ts", "**/src/**/*.tsx", "apps/api/server/**/*.ts", "apps/api/bin/**/*.ts"],
  "exclude": [
    "**/*.test.ts", "**/*.test.tsx", "**/__tests__/**",
    "**/dist/**", "**/.next/**", "**/.nitro/**", "**/.output/**",
    "**/index.ts",                   // generated barrels: pure re-exports, no logic
    "**/*.config.{ts,mts,js,mjs}",   // next/tailwind/postcss/eslint configs
    "apps/web/next-env.d.ts",
    "**/*.d.ts"
  ]
}
```

Every exclusion above is **non-executable or generated**: barrels (re-exports),
config files, type declarations, build output. Type-only files (entity/port
interfaces, `BackgroundSource`, `LogEntry`, `ComplianceResult`, `PipelineResult`)
emit no runtime code and contribute no coverable lines, so they need no special
handling.

### 2.6 CI

`.github/workflows/ci.yml` already runs `yarn test`. Two edits:
- Point the Test step at `yarn test:cov` so CI enforces the 100% gate.
- Upload `coverage/lcov.info` as an artifact (optional, for PR visibility).

Node version in CI is `"22"` — fine for `tsx --test`. No change needed.

### 2.7 Shared test toolkit

Create `packages/CampaignOrchestration/src/application/use-cases/__tests__/_fakes.ts`
(or a tiny internal test-only module) housing the four reusable fakes:

```ts
// In-memory fakes — the whole point of ports. No I/O, fully deterministic.
export const fakeImageGenerator = (source: BackgroundSource = "procedural"): ImageGeneratorPort => ({
  resolveBackground: mock.fn(async () => ({ image: new Uint8Array([1, 2, 3]), source })),
});
export const fakeCompositor = (logoApplied = true): CompositorPort => ({
  compositeAsset: mock.fn(async () => ({ image: new Uint8Array([4, 5, 6]), logoApplied })),
});
export const fakeCompliance = (opts?: { legalPass?: boolean; density?: number }): CompliancePort => ({ /* ... */ });
export const recordingExporter = (): ExportPort & { saved: string[]; proofs: string[] } => ({ /* ... */ });
```

These fakes are the lever: they make the use case's entire behaviour testable
with assertions on *what the ports were called with*, not on real images.

---

## 3. Coverage inventory — unit tests (the core, by value)

Ordered highest-value first. Each row is one `__tests__/<module>.test.ts` file.

### Phase 1 — `CampaignOrchestration` (the business core; highest ROI)

| Module | Behaviours to cover |
| --- | --- |
| `application/use-cases/GenerateCampaignUseCase` | **The big one.** Validation: rejects non-slug id, duplicate product ids, `< 2` products, non-slug treatment id, duplicate treatment ids; accepts a valid brief. Legal gate: halts on prohibited copy (campaign **and** localized message), returns `halted:true` + empty assets + zero generator calls. Happy path: full `product × ratio × treatment` matrix count; asset order is product→ratio→treatment; `outputPath` namespacing **on** for >1 treatment and **off** for one; localized-message fallback to `campaignMessage`; `backgroundSource` propagated onto assets; warn-level log on procedural source. Selective regen: only targeted cells run, others untouched, proof only rewritten when its hero is targeted. Hero/proof: one proof per product from its 1:1 first-treatment composite. Concurrency: `mapWithConcurrency` preserves order with `limit < n`, `limit > n`, and `n = 0`. |
| `domain/value-objects/AspectRatio.vo` | `create` ok for each ratio; `create` err for unknown; `all()` returns the three; `slug` colon→x; `equals` true/false; width/height correct. |
| `domain/value-objects/Treatment.vo` | `SAFE_ID_PATTERN` accepts valid slugs, rejects uppercase / `..` / slash / empty / >64 chars; `DEFAULT_TREATMENT` shape; `LAYOUT_VALUES` / `TONE_VALUES` membership. |
| `domain/value-objects/PipelineExecutionLog.vo` | `record` appends with level + timestamp; default level `info`; `complete()` sets `completedAt`; `entries` is read-only view; `toJSON` shape incl. `totalOperations`. |

### Phase 2 — driven adapters (`CreativeGeneration`, `GovernanceAndCompliance`)

| Module | Type | Behaviours |
| --- | --- | --- |
| `CreativeGeneration/.../canvas-util` | unit | `hexToRgb`: `#abc` short form, 6-digit, missing `#`, padding/truncation; `wrapText`: wraps at width, single long word, empty → `[text]`. |
| `CreativeGeneration/.../safe-path` (`resolveAssetPath`) | unit | accepts `assets/inputs/x.png`; rejects absolute, `../` escape, empty, and a path resolving outside `assets/`. |
| `CreativeGeneration/.../ProceduralBackgroundGenerator` | unit | returns `source:"procedural"`; deterministic (same input → identical bytes); non-empty PNG; ignores context. |
| `CreativeGeneration/.../AssetReusingImageGenerator` (decorator) | unit | with `inputAsset` present + readable → `source:"reused"`, does **not** delegate; missing/unsafe/unreadable `inputAsset` → delegates to wrapped generator. Wrapped generator is a `mock.fn()`. |
| `CreativeGeneration/.../GeminiImageGenerator` | unit (injected client) | success → `source:"imagen"`, prompt contains product name/audience/region/colour; client throws → delegates to `fallback`; throws with no `fallback`; empty image data → fallback. |
| `CreativeGeneration/.../OpenRouterImageGenerator` | unit (mock `fetch`) | success → `source:"openrouter"`; modality-mismatch error → retries with `["image","text"]`; non-OK HTTP → fallback; `extractImageUrl` for `images[].image_url.url`, `images[].url`, and `content[]` array; `decodeDataUrl` with/without comma; ratio→aspect mapping. |
| `GovernanceAndCompliance/.../BrandComplianceChecker` | unit (synthetic image) | `validateLegalCopy`: clean passes, each prohibited term fails, case-insensitive, multi-hit reason lists all; `validateBrandColorDensity`: a solid brand-colour PNG passes with score ~1, a black PNG fails below threshold, tolerance ±10 boundary, score formula, `total=0` guard. (Build the test PNG in-memory with canvas — deterministic, no fixtures.) |

### Phase 3 — `shared`

| Module | Behaviours |
| --- | --- |
| `domain/result` | `ok` shape `{success:true,value}`; `err` shape `{success:false,error}`; type narrowing exercised. |
| `infrastructure/project-root` | `PROJECT_ROOT` env override wins; walks up to a `yarn.lock`/`turbo.json` marker; falls back to cwd at filesystem root; memoization (second call doesn't re-walk — assert via a spy or stable result). *Reset the module cache between tests.* |

*(If §1a is accepted, the four stubs are deleted and need no tests.)*

---

## 4. Coverage inventory — integration tests (the I/O seams)

Named and isolated per `.agents/testing.md`. Real adapters, temp dirs, fixture
assets. Suffix files `*.itest.ts`? No — keep `*.test.ts` (the contract names one
convention) but place them in `__tests__/integration/` and have them create/clean
a `mkdtemp` working directory.

### Phase 4 — `Distribution` + `CreativeGeneration` rendering

| Module | Behaviours |
| --- | --- |
| `Distribution/.../FileSystemExporter` | `saveToDirectory` writes bytes to `<temp>/a/b.png` (creates dirs); `generatePrintProof` writes a valid PDF (magic bytes `%PDF`, crop marks present, footer text); `resolveSafe` throws on `../` traversal in both methods. Uses `mkdtemp`. |
| `CreativeGeneration/.../NodeCanvasCompositor` | renders a PNG at each ratio's exact dimensions; `logoApplied:true` with a real fixture logo, `false` on `ENOENT`, `false`+warn on an unreadable/corrupt logo; `headline-top` vs `headline-bottom` and `bold` vs `subtle` both render (cover all layout/tone branches); deterministic bytes for identical input. Uses a small fixture PNG under `__tests__/fixtures/`. |
| `CreativeGeneration/.../fonts` (`registerBundledFonts`) | registers from `assets/fonts` (idempotent — second call no-ops); warns once when no fonts dir is found (run in a temp cwd). |

### Phase 5 — `apps/api` lib + routes + CLI

| Module | Type | Behaviours |
| --- | --- | --- |
| `server/lib/env` | unit | `applyEnvFile` parses `K=V`, strips matching quotes, skips comments/blank/`=`-less lines, never overrides an existing `process.env`; provider-detection log lines for imagen-only / openrouter-only / both / none; idempotent `loadEnv` (second call no-ops). Use a temp `.env` and a saved/restored `process.env`. |
| `server/lib/config` (`outputRoot`) | unit | default `<root>/output`; `OUTPUT_DIR` override (absolute and relative). |
| `server/lib/load-brief` | unit | `parseBrief`: each missing required field; non-object; non-slug id/product/treatment; non-array products/treatments; valid → typed brief. `validateTreatments`: bad layout, bad tone, dup id. `parseRegenerateOnly`: undefined→undefined, non-array throws, empty array throws, non-string fields throw, valid maps. `loadBrief`: `.yaml`, `.yml`, `.json` parse paths. |
| `server/lib/pipeline` | unit (env-driven) | `ALLOWED_IMAGE_MODELS` membership; `imageGenerator` selection branches: `"procedural"`→procedural-only, `"<provider>/<model>"`→OpenRouter (key set vs unset), default/`"imagen"` chain, reuse decorator always outermost (assert via a product with `inputAsset`). Set/unset `GEMINI_API_KEY`/`OPENROUTER_API_KEY` per case. `buildPipeline`/`runCampaign` smoke against a temp output dir with a minimal brief. |
| `server/lib/report` | integration | `campaignReportPath` safe id vs unsafe→null; `latestReportPath`; `isKeyable` true/false; `readPersistedAssets` on missing file→[], corrupt JSON→[], non-array assets→[], drops unkeyable rows with warn; `writeReport` fresh (writes per-campaign **and** latest, derives `brandCompliant = passed && logo`); `writeReport` merge overlays by identity, preserves untouched cells, merges against per-campaign not latest. `mkdtemp` output root via `OUTPUT_DIR`. |
| `server/routes/*` | integration (HTTP) | Boot the Nitro/h3 app (or use `nitropack`'s test util / a built `.output` + `supertest`-style fetch). `GET /` → `{status:"ok"}`; `POST /campaigns/generate` bare brief → 200 with assets; envelope with `regenerateOnly` → merge; bad brief → 400; unknown `?model=` → 400; business failure (e.g. 1 product) → 422. `GET /campaigns/result` latest / `?campaignId=` / unknown id → EMPTY / non-string param → EMPTY. `GET /campaigns/briefs` lists & skips malformed. `GET /output/**` streams a file, 404 missing, 400 on traversal, correct content-type. |
| `bin/generate.ts` | integration | Refactor `main()` to be importable (export it; keep the `main().catch` guard behind an `import.meta` entry check). Run against `briefs/sample-campaign.yaml` into a temp `OUTPUT_DIR`; assert exit code 0, report written, assets listed; run a legal-gate-failing brief → halted message; a `<2` product brief → exit 1. |

### Phase 6 — `apps/web` (DOM layer from §1b)

| Module | Type | Behaviours |
| --- | --- | --- |
| `lib/cn` | unit | merges classes; later Tailwind class wins (`px-2 px-4`→`px-4`); conditional/array inputs. |
| `lib/models` (`labelFor`, `MODELS`) | unit | `labelFor(null)`→"Auto", known id→label, unknown id→"Auto"; catalog ids mirror `ALLOWED_IMAGE_MODELS` (a guard test that fails if the two drift). |
| `lib/aspect-ratios` | unit | exported order matches the domain set (guard test). |
| `lib/run-context` (`RunProvider`/`useRun`) | DOM | `useRun` outside provider throws; `assetKey` identity; `execute` posts the brief and populates assets (mock `fetch`); **stale-run guard** — a brief switch mid-run discards the late response (drive two overlapping `fetch` resolutions, assert the grid shows the second brief); `assetVersion` bumps on success; `decide` toggles approve/reject/clear; `regenerateRejected` no-op when none rejected, else posts envelope and overlays by identity + clears those decisions; `localStorage` persistence of brief/decisions and validated restore (reject malformed stored JSON); `setBrief` keeps the run when `campaignId` matches, else fetches the per-campaign report; error path surfaces the actionable message on non-JSON 5xx. |
| `components/shell/CommandBar` | DOM | expected-count math (`products × ratios × treatments`); confirm dialog gates `execute`; regenerate button appears only with rejected > 0; disabled while loading; status/colour per state. |
| `components/shell/*` (Header, Sidebar, BriefPicker, ModelSelector, TelemetryDrawer, MobileMenu, Accordion) | DOM | render under `RunProvider`; key interactions (model select sets `selectedModel`; brief picker select calls `setBrief`; telemetry toggle; accordion open/close). |
| `app/(shell)/*` pages (grid, compliance, export, runs, brief) + `layout` | DOM | empty state vs populated; **grid** pivot product→ratio→treatment, badges (PASS/LOW, LOGO/NO LOGO, source), preview modal open/escape/focus-trap, per-tile regen spinner; **export** lists only approved + dedup proofs; **compliance** row per asset with derived gate; **layout** shows orchestrator only on `/grid`. |
| `components/ui/*` (button, card, input) | DOM | variant class application; passthrough props. |

---

## 5. Phased rollout & sequencing

| Phase | Scope | Why this order | Net coverage gain |
| --- | --- | --- | --- |
| **0** | Infra: scripts, `c8`, `.c8rc`, fakes toolkit, CI gate, §1a deletions, §1c refactors | Nothing measurable until the harness exists | harness only |
| **1** | `CampaignOrchestration` core | Highest business value; proves the fakes pattern | the domain + use case |
| **2** | `CreativeGeneration` + `GovernanceAndCompliance` units | Pure helpers + injected/mock adapters | most adapter logic |
| **3** | `shared` | Tiny, fast, unblocks aggregate number | kernel |
| **4** | Rendering/export integration | Real canvas/PDF seams | I/O adapters |
| **5** | `apps/api` lib + routes + CLI | Wiring + HTTP contract | the backend edge |
| **6** | `apps/web` (DOM) | Largest surface; lands last behind the DOM decision | the UI |

Each phase ends green at **100% for the packages it touches** (run
`yarn workspace <pkg> test:cov`), so the ratchet only ever goes up. The repo-wide
`--100` gate flips on at the end of Phase 6 (before then, per-package gates hold).

---

## 6. Definition of done

- [ ] `yarn test:cov` at the root reports **100%** statements/branches/functions/lines.
- [ ] Every workspace has a `test` + `test:cov` script; `turbo test` runs them all.
- [ ] CI runs `yarn test:cov` and fails the build under 100%.
- [ ] Every coverage exclusion in `.c8rc.json` is non-executable or generated, and
      justified inline.
- [ ] No production code path is reachable only from a route/CLI that lacks a test.
- [ ] `.agents/tech-stack.md` updated for the DOM test libs (§1b); `.agents/testing.md`
      unchanged (we conformed to it).
- [ ] Dead stubs resolved per §1a (deleted, or ignored-with-justification).
- [ ] Seam refactors (§1c) each shipped with the test that motivated them.
- [ ] `.agents/session-log.md` appended (per `AGENTS.md`).

---

## 7. Risks & trade-offs

- **"100%" can incentivize hollow tests.** Mitigation: branch coverage is in the
  gate, and the inventory above targets *behaviours*, not lines. Review tests for
  meaningful assertions, not just execution.
- **The UI is the long pole.** ~20 components/pages + the stateful provider. If
  timeline pressure hits, ship Phases 0–5 (full backend + domain at 100%) and
  land Phase 6 behind a temporary per-package threshold, rather than weakening the
  backend gate.
- **Nitro route testing has two viable shapes** — boot the dev server and fetch,
  or unit-test extracted handlers. This plan prefers booting (covers the real
  wiring incl. auto-imports), accepting a slower, isolated integration suite.
- **`c8` + `tsx` source-map remap** is the one tooling bet. Validate it in Phase 0
  with a single trivial test before building out — if remap is flaky on Node 22,
  fall back to `node --experimental-test-coverage` with a `tsc`-built `dist/`
  target, or pin Node 24+ in CI where native TS + coverage is smoother.

---

## 8. Estimated shape (rough, for planning only)

| Area | Test files | Character |
| --- | --- | --- |
| `CampaignOrchestration` | ~5 | unit, fakes |
| `CreativeGeneration` | ~7 | unit + 2 integration |
| `GovernanceAndCompliance` | ~1 | unit (synthetic images) |
| `shared` | ~2 | unit |
| `apps/api` | ~7 | mostly integration |
| `apps/web` | ~20 | DOM |
| **Total** | **~40 files** | — |

The backend + domain (Phases 0–5, ~22 files) is the high-value 80% and is fully
inside the existing `node:test` stack. The UI (Phase 6) is the remaining surface
and the only part needing new (contract-compatible) tooling.
