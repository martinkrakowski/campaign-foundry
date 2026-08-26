# Campaign Foundry — Creative Automation Pipeline

Turn a **single campaign brief** into on-brand social ad **creatives across every
product, aspect ratio, and creative treatment** — with automated brand & legal
compliance and a human-in-the-loop (HITL) approval step before launch.

Built as a proof-of-concept for scalable, localized social ad production: the
creative team supplies a brief (and optional assets), and the pipeline generates,
composites, checks, and organizes every variation automatically.

---

## What it does

Given a campaign brief with **≥2 products**, a **target region**, a **target
audience**, and a **campaign message**, the pipeline:

1. **Validates** the brief (≥2 products, required fields).
2. **Runs a legal gate** on the copy (prohibited-terms check) before spending any
   effort generating assets.
3. **Resolves a background** per product — reuses a provided input asset when one
   exists, otherwise **generates** one.
4. **Composites** a creative for every **aspect ratio × treatment** — three ratios
   (`1:1` 1080×1080, `9:16` 1080×1920, `16:9` 1920×1080) and one creative per
   requested *treatment* (a layout + tone). Layering is deterministic; layout and
   tone are **data from the brief**, not hardcoded — so "generate variations" is a
   function of the brief.
5. **Checks brand compliance** on each creative — **brand-colour density** *and*
   **logo presence** — in addition to the legal gate from step 2.
6. **Saves outputs** organized by product and aspect ratio (and treatment when a
   brief requests more than one), plus a print-proof PDF per product.
7. Surfaces every creative in a **HITL review UI** to approve/reject before launch —
   approved creatives gate the export queue, and rejected ones can be **re-rolled in
   place** ("Regenerate Rejected") without disturbing the rest.

No external API keys are required — it runs **fully offline** by default; add
provider keys to generate real imagery (see
[GenAI image providers](#genai-image-providers-optional) and
[Design decisions](#key-design-decisions)).

---

## Architecture

Hexagonal architecture (**ports & adapters**) in a **modular monolith** — Yarn
workspaces + Turborepo. The domain core has zero infrastructure dependencies;
everything that touches the outside world is an adapter behind a port.

```text
                       ┌──────────────────────────────────────────┐
   campaign brief ───▶ │  CampaignOrchestration  (core domain)    │
   (YAML / JSON)       │  GenerateCampaignUseCase                 │
                       │                                          │
                       │   owns the port contracts ▼              │
                       │  ImageGeneratorPort  CompositorPort      │
                       │  CompliancePort      ExportPort          │
                       └───────┬───────────┬────────────────┬─────┘
                               │           │                │
              ┌────────────────▼──┐  ┌─────▼──────────┐  ┌──▼───────────────┐
              │ CreativeGeneration│  │ Governance &   │  │ Distribution     │
              │  procedural bg +  │  │ Compliance     │  │ filesystem export│
              │  canvas compositor│  │ brand + legal  │  │ + print proofs   │
              └───────────────────┘  └────────────────┘  └──────────────────┘

   apps/api (Nitro)  = HTTP entry point + composition root (wires adapters)
   apps/web (Next.js)= HITL review UI
```

| Package | Responsibility |
| --- | --- |
| `packages/CampaignOrchestration` | Domain model + `GenerateCampaignUseCase` + the four port contracts |
| `packages/CreativeGeneration` | Background generation + compositing adapters |
| `packages/GovernanceAndCompliance` | Brand-colour + prohibited-words compliance adapter |
| `packages/Distribution` | Filesystem export, print-proof (PDF), and per-platform packaging |
| `packages/shared` | `Result` kernel and shared primitives |
| `apps/api` | Nitro server: `POST /campaigns/generate` + the composition root |
| `apps/web` | Next.js HITL review interface |

**Stack:** TypeScript · Node 20+ · Yarn 4 + Turborepo · Nitro · Next.js 15 /
React 19 · `@napi-rs/canvas` (compositing, prebuilt — no system libs) · `pdf-lib`
(proofs, pure-JS).

---

## Getting started

### Prerequisites
- **Node.js 20+**
- **Yarn 4** via Corepack: `corepack enable`

### Install
```bash
corepack enable
yarn install
cp .env.example .env.local   # defaults work as-is; no external keys needed
```

### GenAI image providers (optional)

Out of the box the pipeline runs **fully offline** — no keys, deterministic
procedural backgrounds. To generate real hero imagery, set either or both keys in
`.env.local`:

```bash
GEMINI_API_KEY=...            # Google Imagen (primary GenAI source)
OPENROUTER_API_KEY=...        # OpenRouter (second source: Grok / Nano Banana / GPT Image, …)
FIREFLY_CLIENT_ID=...         # Adobe Firefly Services (select with the "firefly" model)
FIREFLY_CLIENT_SECRET=...     # — server-to-server IMS credentials
# optional overrides:
IMAGEN_MODEL=imagen-4.0-generate-001
OPENROUTER_IMAGE_MODEL=x-ai/grok-imagine-image-quality   # default
OPENROUTER_COPY_MODEL=openai/gpt-4o-mini                 # default (copy pools)
```

**Adobe Firefly Services** is a first-class provider: select the `firefly` model (UI
picker or `?model=firefly`) and, with credentials set, hero backgrounds are generated
with Firefly v3, degrading to the chain below on any failure. It's a single adapter
(`FireflyImageGenerator`) behind `ImageGeneratorPort` — adopting it touched one file
plus one line at the composition root; the domain, compliance, export, and UI are
unchanged.

**Fallback chain** — each tier is used only when its credentials are present, and any
failure or rate-limit drops to the next, so a run never aborts:

```text
reuse provided asset → (Firefly | Imagen) → OpenRouter → procedural gradient
```

> **Keys are read once at startup.** If you add keys to `.env.local` while
> `yarn dev` is already running, **restart `yarn dev`** (from the repo root) to pick
> them up — otherwise the server keeps the keyless snapshot and stays on procedural.
> On boot the API logs which providers it detected (`[env] image generation: …`), so
> a keyless run is obvious rather than a silent gradient.

Every creative records which source produced its background (`imagen` /
`openrouter` / `procedural` / `reused`) — surfaced as a badge in the review grid
and stored in `report.json`. So a fallback (e.g. Imagen hitting its daily quota →
OpenRouter) is **visible, not hidden**. In the HITL UI you can also **pick the
model at runtime** (the model badge in the header → a picker); the choice is the
*primary*, with the same chain beneath it. The API accepts it as `?model=<id>`,
validated against an allowlist.

### Run it — CLI (simplest)
```bash
yarn generate --brief briefs/sample-campaign.yaml
```
Generates every creative into `output/`, prints a run report, and writes proofs.

Request multiple **creative treatments** (layout × tone) per cell — the pipeline
produces the full product × ratio × treatment matrix:
```bash
yarn generate --brief briefs/sample-campaign-variants.yaml
```

### Run it — dev servers (API + HITL UI)
```bash
yarn dev   # from the REPO ROOT — Turbo starts both servers together
```
- Nitro API → http://localhost:3001 (`POST /campaigns/generate`)
- Next.js HITL UI → http://localhost:3000

> Run this from the **repo root**, not `apps/web`. `yarn dev` inside `apps/web`
> starts only the UI; the API on `:3001` won't be up, so the HITL view's pipeline
> calls fail with `ECONNREFUSED` / a 500. (The UI surfaces this with an
> actionable message; the API proxy logs the refused connection.)

```bash
curl -X POST http://localhost:3001/campaigns/generate \
  -H 'content-type: application/json' \
  --data @briefs/sample-campaign.json
# → 202 { "jobId": "…" }  — the run continues in the API process
curl http://localhost:3001/campaigns/jobs/<jobId>
# → { "status": "running" | "completed" | "failed", "result"?: {…}, "error"?: "…" }
```

`POST /campaigns/generate` validates the brief synchronously (400 on a bad brief or
unknown `?model=`, 409 if that campaign already has a run in progress) and returns a
job handle; poll `GET /campaigns/jobs/:id` until `status` leaves `running`. A
business-rule failure (e.g. one product) shows up as `status: "failed"` with the
message in `error`. Jobs live in memory: an API restart (or ten minutes after a job
settles) makes the id 404 — the persisted report is still at
`GET /campaigns/result?campaignId=<id>`. The CLI (`yarn generate`) is unchanged and
runs in-process.

### Authoring briefs via the API

Local authoring tool — writes stay under `briefs/` and `assets/inputs/<briefId>/`.
The same `parseBrief` validator as generate applies; ids are path-safe slugs.
Lookup is by `brief.id`, not filename: `sample-campaign.yaml` is
`summer-hydration-2026`, `sample-campaign.json` is `winter-summit-2026`.

```bash
# Create (409 if any briefs/ file already has that id, unless ?replace=1)
curl -X POST http://localhost:3001/campaigns/briefs \
  -H 'content-type: application/json' \
  --data '{"id":"new-campaign-2026","targetRegion":"DE","targetAudience":"a","campaignMessage":"Hi","products":[{"id":"alpha"},{"id":"beta"}]}'
# → 201 { "file": "new-campaign-2026.yaml", "brief": {…} }

# Replace the file that owns this id, in that file's format (yaml dump or JSON).
# Repeated `replace=1` still means replace. A symlink at the target is refused (400).
curl -X POST 'http://localhost:3001/campaigns/briefs?replace=1' \
  -H 'content-type: application/json' \
  --data @briefs/sample-campaign.json
# → 201 { "file": "sample-campaign.json", "brief": {…} }  # id winter-summit-2026

# Update the file that contains this id (yaml or json; 404 if none does).
# Path id must equal brief.id. YAML comments are lost — the brief is re-serialised.
curl -X PUT http://localhost:3001/campaigns/briefs/summer-hydration-2026 \
  -H 'content-type: application/json' \
  --data '{"id":"summer-hydration-2026","targetRegion":"DE","targetAudience":"a","campaignMessage":"Stay wild. Stay hydrated.","products":[{"id":"hydra-bottle"},{"id":"trail-pack"}]}'
# → 200 { "file": "sample-campaign.yaml", "brief": {…} }

curl -X PUT http://localhost:3001/campaigns/briefs/winter-summit-2026 \
  -H 'content-type: application/json' \
  --data @briefs/sample-campaign.json
# → 200 { "file": "sample-campaign.json", "brief": {…} }

# Duplicate (404 source missing, 409 if any file already has newId)
curl -X POST http://localhost:3001/campaigns/briefs/summer-hydration-2026/duplicate \
  -H 'content-type: application/json' \
  --data '{"newId":"summer-hydration-copy"}'
# → 201 { "file": "summer-hydration-copy.yaml", "brief": {…} }

# Upload a PNG/JPEG (≤ 2 MiB) into assets/inputs/<briefId>/
curl -X POST http://localhost:3001/campaigns/assets \
  -H 'content-type: application/json' \
  --data '{"briefId":"summer-hydration-2026","name":"logo.png","contentBase64":"..."}'
# → 201 { "path": "assets/inputs/summer-hydration-2026/logo.png" }
```

`GET /campaigns/briefs` lists anything POST/PUT/duplicate wrote. PUT and
`POST ?replace=1` rewrite the existing file (`.yaml`/`.yml`/`.json`) in its own
format; they never create a sibling named `<id>.yaml`. Asset `name` is a slug
plus `.png`/`.jpg`/`.jpeg`.

### Copy pools

Generate a legal-gated headline pool for a brief (Phase 3.1–3.3). Requires
`OPENROUTER_API_KEY` (same key as the image adapter); `OPENROUTER_COPY_MODEL`
picks the text model (default `openai/gpt-4o-mini`). A randomized brief draws
headlines from the pool with `variation.axes.headline: pool://copy` (the only
supported pool reference); the planner resolves the approved texts at plan time
and `headline` becomes a Hamming axis. A missing or fully-rejected pool is a
422 on `POST /campaigns/plan` and a failed job on generate, naming
`briefs/<id>/pools.json`. The wizard's Copy step curates the pool (generate,
approve/reject, edit) and the policy step unlocks the axis once one entry is
approved.

```bash
# Generate headlines (default count 10, max 25), run the legal gate, persist
curl -X POST http://localhost:3001/campaigns/pools/copy \
  -H 'content-type: application/json' \
  --data '{"briefId":"summer-hydration-2026","count":10}'
# → 201 { "pool": { "briefId", "generatedAt", "model", "entries": [{ "id", "text", "status", "reason?" }] }, "added": 10 }
#   200 + "added": 0 when the model only repeated headlines already in the pool

curl http://localhost:3001/campaigns/pools/summer-hydration-2026
# → 200 { "pool": {…} }

curl -X PATCH http://localhost:3001/campaigns/pools/summer-hydration-2026 \
  -H 'content-type: application/json' \
  --data '{"entries":[{"id":"h1","status":"approved"},{"id":"h2","status":"rejected","text":"Edited headline"}]}'
```

Persisted at `briefs/<briefId>/pools.json` (a directory, so the briefs lister
ignores it). Suggestions are capped at `count` and 60 characters, then run
through `validateLegalCopy`; failures are stored as `rejected` with a reason and
are not selectable later. A PATCH edit whose text duplicates another entry is a
422. Upstream failures map to 502 (bad key / other error), 429 + `Retry-After`
or 503 (rate limit), 503 (network / 30 s timeout), 422 (unreadable reply).


`POST /campaigns/package` copies a run's already-rendered creatives into
`output/packages/<campaignId>/<platformId>/` (never re-renders). The package is
the current output for that report — renders are not campaign-namespaced;
`packagedAt` on `manifest.json` records when this copy was taken.

---

## Example input

```yaml
# briefs/sample-campaign.yaml
id: summer-hydration-2026
targetRegion: DE
targetAudience: Urban outdoor enthusiasts, 25–40
campaignMessage: Stay wild. Stay hydrated.
localizedMessage: Bleib wild. Bleib hydriert.
products:
  - id: hydra-bottle
    name: Hydra Bottle
    primaryColor: "#1473E6"
    logoPath: assets/inputs/hydra-logo.png
  - id: trail-pack
    name: Trail Pack
    primaryColor: "#E0218A"
    logoPath: assets/inputs/trail-logo.png
```

Add an optional **`inputAsset`** to a product to **reuse** a provided background
(cover-fit per ratio, badged `REUSED`) instead of generating one — see
`briefs/sample-campaign-reuse.yaml`. A missing/unreadable `inputAsset` simply falls
through to generation, so it's safe to omit.

Optionally request **creative treatments** (omit for a single default treatment,
so existing briefs are unchanged). See `briefs/sample-campaign-variants.yaml`:

```yaml
treatments:
  - { id: bold-bottom, layout: headline-bottom, tone: bold }
  - { id: subtle-top,  layout: headline-top,    tone: subtle }
```
`layout` ∈ `headline-bottom | headline-top`, `tone` ∈ `bold | subtle`.

## Example output

Outputs are organized **by product, then aspect ratio**:

```text
output/
├── hydra-bottle/
│   ├── 1x1.png
│   ├── 9x16.png
│   └── 16x9.png
├── trail-pack/
│   ├── 1x1.png
│   ├── 9x16.png
│   └── 16x9.png
├── proofs/
│   ├── hydra-bottle.pdf
│   └── trail-pack.pdf
├── reports/
│   └── summer-hydration-2026.json
├── packages/
│   └── summer-hydration-2026/
│       └── instagram-feed/
│           ├── hydra-bottle/1x1.png
│           └── manifest.json   # packagedAt + skipped + items
└── report.json     # per-asset compliance (density + logo + brandCompliant) + log
```

When a brief requests **more than one treatment**, creatives nest by treatment so
each ratio slot holds its variants side-by-side
(`output/<product>/<ratio>/<treatment>.png`):

```text
output/city-backpack/
├── 1x1/   ├── bold-bottom.png  └── subtle-top.png
├── 9x16/  ├── bold-bottom.png  └── subtle-top.png
└── 16x9/  ├── bold-bottom.png  └── subtle-top.png
```

---

## Key design decisions

1. **Hexagonal / ports & adapters.** The domain core (`CampaignOrchestration`)
   depends only on interfaces it owns. Generation, compositing, compliance, and
   export are adapters injected at the app composition root — each swappable
   without touching business logic.
2. **Multi-provider GenAI with graceful fallback.** Hero backgrounds resolve through
   a chain behind `ImageGeneratorPort`: reuse a provided asset → **Google Imagen**
   (`@google/genai`) → **OpenRouter** (Grok / Nano Banana / GPT Image, via the
   OpenAI-compatible API) → a deterministic **procedural** gradient from the brand
   colour. Each GenAI tier runs only when its key is present, and any error or
   rate-limit drops to the next, so a run never aborts and a keyless clone works
   **fully offline**. The model is selectable at runtime (UI badge / `?model=`) with
   the chosen one as primary; provenance is recorded per asset and shown as a badge,
   so a degraded run (e.g. Imagen quota → OpenRouter) reads honestly. Backgrounds are
   resolved **concurrently** (a small bounded pool) so a full matrix doesn't serialize
   N slow GenAI calls — adding or swapping a provider is an adapter, not a domain change.
3. **Deterministic, treatment-driven layer stacking.** Compositing follows a fixed
   Z-order — background → contrast shade (WCAG legibility) → **brand-colour accent
   band** → message → logo — but the *headline edge* (top/bottom), shade direction,
   accent edge, and logo corner are driven by the treatment's **layout**, and the
   shade opacity + font weight by its **tone**. The compositor holds no hardcoded
   layout opinion; same inputs → same output every run.
4. **Variations are a function of the brief.** A brief lists **treatments** (layout
   + tone); the use case produces the full product × ratio × treatment matrix.
   Adding a variation is data, not code — the strongest expression of the brief's
   "generate variations" requirement, and a clean story for arbitrary reviewer
   assets (drop in a YAML, get a branded, compliance-gated matrix).
5. **Two-signal brand compliance, as a non-throwing circuit breaker.** Checks always
   return a `ComplianceResult`; the *use case* owns the halt decision. The legal
   gate halts early; per creative, brand compliance is **two independent signals** —
   brand-colour **density** and **logo presence** — kept distinct on the entity, with
   a derived `brandCompliant` (`density AND logo`) for a single green/red view. The
   brand-colour accent band (decision 3) is what keeps density honest: it gives every
   creative a deliberate ~5% density — clearing the gate in **both** the Imagen and
   procedural paths — while a creative that lost its brand presence would still fail.
   Without it, photographic GenAI backgrounds carry no brand colour and every asset
   fails.
6. **Human-in-the-loop approval.** A review surface for approve/reject before
   launch — directly targeting the "slow approval cycles" pain point in the brief.
   The grid pivots product → ratio → treatment, so the variation matrix is legible
   at a glance.
7. **Modular monolith.** In-process contexts, one repo, one command to run — with
   clean seams to split into services later.

---

## Assumptions & limitations

- **Image generation** chains reuse → **Google Imagen** (`GEMINI_API_KEY`) →
  **OpenRouter** (`OPENROUTER_API_KEY`) → an offline procedural gradient — all behind
  `ImageGeneratorPort`, each tier key-gated and degrading to the next on failure.
- **Proofs are RGB, not colour-managed** — print-accurate CMYK is out of scope.
- **Storage is the local filesystem**, abstracted behind `ExportPort` (a cloud
  storage adapter — S3/Azure/Dropbox — is a drop-in replacement).
- **Localization** falls back to the campaign message when no localized copy is
  supplied; full multi-locale generation is a stretch goal.
- **Compliance heuristics are illustrative** (brand-colour pixel-density, logo
  application, prohibited-word list), not a production moderation system. Logo
  presence is enforced at composite time (the compositor is the authority), not
  by detecting a logo in an arbitrary externally-supplied image.

---

## Repository scripts

| Command | Action |
| --- | --- |
| `yarn install` | Install the workspace |
| `yarn generate --brief <file>` | Run the pipeline from a brief (CLI) |
| `yarn dev` | Start the Nitro API + Next.js UI together |
| `yarn build` | Build every workspace |
| `yarn typecheck` | Type-check every workspace |
