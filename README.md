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
7. Surfaces every creative in a **HITL review UI** to approve/reject before launch.

No external API keys are required — it runs **fully offline** by default (see
[Design decisions](#key-design-decisions)).

---

## Architecture

Hexagonal architecture (**ports & adapters**) in a **modular monolith** — Yarn
workspaces + Turborepo. The domain core has zero infrastructure dependencies;
everything that touches the outside world is an adapter behind a port.

```
                       ┌──────────────────────────────────────────┐
   campaign brief ───▶ │  CampaignOrchestration  (core domain)     │
   (YAML / JSON)       │  GenerateCampaignUseCase                  │
                       │                                           │
                       │   owns the port contracts ▼               │
                       │  ImageGeneratorPort  CompositorPort       │
                       │  CompliancePort      ExportPort           │
                       └──────┬───────────┬───────────┬───────────┘
                              │           │           │
              ┌───────────────▼──┐  ┌─────▼──────────┐  ┌──▼───────────────┐
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
| `packages/Distribution` | Filesystem export + print-proof (PDF) adapter |
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
yarn install
cp .env.example .env.local   # defaults work as-is; no external keys needed
```

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
yarn dev
```
- Nitro API → http://localhost:3001 (`POST /campaigns/generate`)
- Next.js HITL UI → http://localhost:3000

```bash
curl -X POST http://localhost:3001/campaigns/generate \
  -H 'content-type: application/json' \
  --data @briefs/sample-campaign.json
```

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
  - id: acme-hydra-bottle
    name: Hydra Bottle
    primaryColor: "#1473E6"
    logoPath: assets/inputs/hydra-logo.png
  - id: acme-trail-pack
    name: Trail Pack
    primaryColor: "#E0218A"
    logoPath: assets/inputs/trail-logo.png
    inputAsset: assets/inputs/trail-pack.png   # reused when present
```

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
├── acme-hydra-bottle/
│   ├── 1x1.png
│   ├── 9x16.png
│   └── 16x9.png
├── acme-trail-pack/
│   ├── 1x1.png
│   ├── 9x16.png
│   └── 16x9.png
├── proofs/
│   ├── acme-hydra-bottle.pdf
│   └── acme-trail-pack.pdf
└── report.json     # per-asset compliance (density + logo + brandCompliant) + log
```

When a brief requests **more than one treatment**, creatives nest by treatment so
each ratio slot holds its variants side-by-side
(`output/<product>/<ratio>/<treatment>.png`):

```text
output/acme-hydra-bottle/
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
2. **Google Imagen, with an offline fallback.** Hero backgrounds are generated by
   **Google Imagen** (`@google/genai`) behind `ImageGeneratorPort` when
   `GEMINI_API_KEY` is set; otherwise a deterministic procedural adapter (a gradient
   from each product's brand colour) runs **fully offline with zero API keys**, so a
   reviewer can clone and run immediately. On any API error the run falls back to
   procedural — swapping generators is just an env var, no domain change.
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

- **Image generation** uses **Google Imagen** when `GEMINI_API_KEY` is set,
  otherwise an offline procedural gradient — both behind `ImageGeneratorPort`.
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
