# Campaign Foundry — Creative Automation Pipeline

Turn a **single campaign brief** into on-brand social ad **creatives across every
product and aspect ratio** — with automated brand & legal compliance and a
human-in-the-loop (HITL) approval step before launch.

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
4. **Composites** the creative for **three aspect ratios** — `1:1` (1080×1080),
   `9:16` (1080×1920), `16:9` (1920×1080) — overlaying the campaign message and
   the product logo with deterministic layering.
5. **Checks brand compliance** (brand-colour density) on each rendered creative.
6. **Saves outputs** organized by product and aspect ratio, plus a print-proof PDF.
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

## Example output

Outputs are organized **by product, then aspect ratio**:

```
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
└── report.json     # per-asset compliance scores + pipeline log
```

---

## Key design decisions

1. **Hexagonal / ports & adapters.** The domain core (`CampaignOrchestration`)
   depends only on interfaces it owns. Generation, compositing, compliance, and
   export are adapters injected at the app composition root — each swappable
   without touching business logic.
2. **Procedural by default, GenAI-ready.** Ships a deterministic procedural
   background adapter (a gradient derived from each product's brand colour) so the
   pipeline runs **fully offline with zero API keys** — the reviewer can clone and
   run immediately. Swapping in a GenAI image model is a single new adapter behind
   `ImageGeneratorPort`; no domain change.
3. **Deterministic layer stacking.** Compositing follows a fixed Z-order —
   background → dark contrast gradient (WCAG legibility) → centred message → logo
   top-right — so output is reproducible and on-brand every run.
4. **Compliance as a non-throwing circuit breaker.** Checks always return a
   `ComplianceResult`; the *use case* owns the halt decision. The legal gate halts
   the run early; the visual check annotates each asset's `complianceScore`.
5. **Human-in-the-loop approval.** A review surface for approve/reject before
   launch — directly targeting the "slow approval cycles" pain point in the brief.
6. **Modular monolith.** In-process contexts, one repo, one command to run — with
   clean seams to split into services later.

---

## Assumptions & limitations

- **Image generation is procedural**, standing in for a GenAI image model. The
  `ImageGeneratorPort` seam + an API-key-gated adapter is the production path.
- **Proofs are RGB, not colour-managed** — print-accurate CMYK is out of scope.
- **Storage is the local filesystem**, abstracted behind `ExportPort` (a cloud
  storage adapter — S3/Azure/Dropbox — is a drop-in replacement).
- **Localization** falls back to the campaign message when no localized copy is
  supplied; full multi-locale generation is a stretch goal.
- **Compliance heuristics are illustrative** (pixel-density + word-list), not a
  production moderation system.

---

## Repository scripts

| Command | Action |
| --- | --- |
| `yarn install` | Install the workspace |
| `yarn generate --brief <file>` | Run the pipeline from a brief (CLI) |
| `yarn dev` | Start the Nitro API + Next.js UI together |
| `yarn build` | Build every workspace |
| `yarn typecheck` | Type-check every workspace |
