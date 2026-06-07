# @campaignfoundry/CreativeGeneration

The **creative-rendering** bounded context. It turns a product plus campaign
context into finished, on-brand PNG creatives — one per aspect ratio — using
[`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) for compositing and,
optionally, Google Imagen for the background imagery.

This package is the **adapter (infrastructure) side** of the hexagon. It holds no
business logic: the workflow, domain rules, and orchestration live in
`@campaignfoundry/CampaignOrchestration`. This package only _implements two
outbound ports that orchestration depends on_, so the use case can render
creatives without knowing whether a background came from Imagen, a reused asset,
or a gradient — or that a canvas is involved at all.

```text
CampaignOrchestration (domain + use case)
        │ depends on contracts ↓ (never on this package)
        ▼
   ImageGeneratorPort        CompositorPort        ← interfaces it owns
        ▲                          ▲
        │ implemented by ──────────┘
   CreativeGeneration  (this package — adapters only)
```

> **Why no domain layer?** `src/domain/` is an intentional placeholder
> (`export {}`). A `Product`, an `AspectRatio`, and the campaign copy are all
> owned by the orchestration aggregate; this context contributes rendering
> machinery, not entities.

---

## What's in the box

| Export                          | Port it satisfies                | Responsibility                                                                       |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `ProceduralBackgroundGenerator` | `ImageGeneratorPort`             | Deterministic gradient background from the brand colour. Offline default + fallback. |
| `GeminiImageGenerator`          | `ImageGeneratorPort`             | Photographic background via Google Imagen, with graceful fallback.                   |
| `AssetReusingImageGenerator`    | `ImageGeneratorPort` (decorator) | Reuse a product's supplied asset when present; otherwise delegate.                   |
| `NodeCanvasCompositor`          | `CompositorPort`                 | Stack background + shade + copy + logo into the final PNG.                           |

Two helpers are **internal** (not exported): `infrastructure/fonts.ts`
(bundled-font registration) and `infrastructure/adapters/canvas-util.ts`
(`hexToRgb`, `wrapText`).

The public barrel is `src/index.ts → src/infrastructure/index.ts`. Everything is
served straight from TypeScript source (`main`/`types` → `src/index.ts`); there is
no build step in dev.

---

## The two contracts

Both are defined in `CampaignOrchestration/src/application/ports/out/`. Buffers
cross the boundary as `Uint8Array` so the domain never imports anything Node-ish.

```ts
// ImageGeneratorPort — produce the base background layer.
resolveBackground(product: Product, ratio: AspectRatio, context: BackgroundContext): Promise<Uint8Array>

// CompositorPort — stack the visual layers and return the rendered PNG.
compositeAsset(request: CompositeRequest): Promise<Uint8Array>
// CompositeRequest = { background: Uint8Array; message: string; logoPath: string; ratio: AspectRatio }
```

`BackgroundContext` is `{ campaignMessage, targetAudience, targetRegion }` — the
"relevance" levers a GenAI adapter can personalize against. `AspectRatio` fixes
the canvas size: `1:1 → 1080×1080`, `9:16 → 1080×1920`, `16:9 → 1920×1080`.

---

## How one creative is built, end to end

For every `product × ratio`, `GenerateCampaignUseCase` calls the two ports in
sequence. The composition root (`apps/api/server/lib/pipeline.ts`) decides which
concrete generator is live and injects it:

```text
product, ratio, context
      │
      ▼
ImageGeneratorPort.resolveBackground()
      │   AssetReusingImageGenerator   ── inputAsset present?  ── yes → cover-fit it, return
      │            │ no
      │            ▼
      │   GeminiImageGenerator (if GEMINI_API_KEY set)  ── Imagen call
      │            │ on any failure
      │            ▼
      │   ProceduralBackgroundGenerator  ── brand-colour gradient
      ▼
background: Uint8Array (PNG)
      │
      ▼
CompositorPort.compositeAsset({ background, message, logoPath, ratio })
      │   NodeCanvasCompositor → 4-layer stack
      ▼
creative: Uint8Array (PNG)   → brand-compliance check → saved to disk
```

The key idea: **reuse-vs-generate** and **which model** are composition
decisions, layered as decorators around one port. The compositor is identical
regardless of where the background came from.

---

## The adapters in detail

### `ProceduralBackgroundGenerator`

Paints a diagonal linear gradient `(0,0) → (width,height)` from the product's
`primaryColor` to a 35%-darkened shade of it, and returns PNG bytes. Pure,
synchronous, fully offline — it ignores `BackgroundContext`. This is both the
GenAI-free default and the fallback when Imagen is unavailable.

### `GeminiImageGenerator`

Wraps `@google/genai`. `resolveBackground` calls
`ai.models.generateImages({ model, prompt, config: { numberOfImages: 1, aspectRatio: ratio.value } })`
and decodes `response.generatedImages[0].image.imageBytes` (base64) into a
`Uint8Array`.

- **Model:** `imagen-4.0-generate-001` by default; override with `IMAGEN_MODEL`.
- **Prompt** (`buildPrompt`): describes the _scene only_ — product name, audience,
  region, the brand accent colour, "cinematic / photographic / negative space at
  the bottom for a headline", and an explicit **"absolutely no text, words,
  letters, logos or watermarks."** The campaign message is deliberately _not_ sent,
  so the model can't bake the slogan into the image — the headline is owned solely
  by the compositor's text layer.
- **Failure handling:** any error (missing access, rate limit, network, empty
  response) logs a warning and delegates to the injected `fallback` generator, so a
  bad key degrades to a procedural background instead of aborting the run.

### `AssetReusingImageGenerator`

A decorator over any `ImageGeneratorPort`. If `product.inputAsset` is set, it
loads the file and **cover-fits** it to the ratio (scale to `max(w/iw, h/ih)`,
centre-crop) and returns it; if the asset is missing or unreadable, or no asset is
provided, it delegates to the wrapped generator. This is what satisfies the
brief's _"reuse input assets when available, generate when missing"_ rule — and it
does so for **any** underlying generator, including Imagen.

### `NodeCanvasCompositor`

The heart of the package. `compositeAsset` creates a canvas at the ratio's pixel
size and paints four layers in strict bottom-to-top order:

```text
┌──────────────────────────────────────────────┐
│  (4) brand logo ─ top-right, optional      ▣  │  width·0.16 wide, margin width·0.04
│                                                │
│  (1) background ─ full-bleed                   │  the Uint8Array from the generator
│                                                │
│  (2) ░▒▓ dark gradient, from 45% down ▓▒░      │  rgba(0,0,0,0) → 0.7, copy legibility
│  (3) "Stay wild. Stay hydrated."               │  centred · bold · bundled font · white
└──────────────────────────────────────────────┘
```

1. **Background** — `drawImage(background, 0, 0, width, height)`, stretched full-bleed.
2. **Shade** — a vertical gradient from transparent at 45% height to `rgba(0,0,0,0.7)`
   at the bottom, guaranteeing WCAG-legible copy over any imagery.
3. **Copy** — the resolved campaign message, drawn bold and white, centred, at
   `fontSize = round(width · 0.06)`, greedily word-wrapped to 85% of the width
   (`wrapText`), line height `1.25×`, anchored `8%` up from the bottom.
4. **Logo** — `product.logoPath` scaled to `width · 0.16` and pinned top-right with a
   `width · 0.04` margin. Wrapped in `try/catch`, so a missing logo is skipped cleanly
   rather than failing the creative.

Result: `canvas.toBuffer("image/png")`. Because layers 2–4 are deterministic,
brand presentation is identical no matter how chaotic the background is — and the
top-right logo box is exactly the region the brand-compliance check
(`@campaignfoundry/GovernanceAndCompliance`) samples for brand-colour density.

The constructor takes the font family (default `"Inter"`) and calls
`registerBundledFonts()` once.

### `fonts.ts` (internal)

`registerBundledFonts()` registers the OFL-licensed fonts under `assets/fonts/`
(`Inter` sans, `Lora` serif; Regular + Bold each) with the canvas engine via
`GlobalFonts.registerFromPath`. It searches the cwd upward
(`[cwd, ../, ../..]`) — so it resolves whether the CLI runs from the repo root or
Nitro runs from `apps/api` — mirroring the `.env` loader. It's idempotent and a
no-op if the directory isn't found, so text falls back to a generic sans rather
than crashing. Bundling the fonts makes headline rendering identical on macOS,
Windows, and Linux with no system fonts assumed.

### `canvas-util.ts` (internal)

- `hexToRgb("#1473E6") → [20, 115, 230]` — tolerant of `#`, 3-digit shorthand, and
  short strings.
- `wrapText(ctx, text, maxWidth) → string[]` — greedy word wrap using the canvas
  context's own `measureText`, so wrapping matches the actual rendered font.

---

## Configuration

This package reads **no environment variables itself** — adapters are configured
by constructor injection at the composition root, which is where env is read:

| Variable                            | Effect                                                   | Read by                                            |
| ----------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | When set, the live generator is Imagen (else procedural) | `pipeline.ts` → `GeminiImageGenerator({ apiKey })` |
| `IMAGEN_MODEL`                      | Override the Imagen model id                             | `GeminiImageGenerator`                             |
| `MESSAGE_FONT`                      | Headline font family — `Inter` (default) or `Lora`       | `pipeline.ts` → `new NodeCanvasCompositor(...)`    |

---

## Cross-platform & determinism notes

- **`@napi-rs/canvas`** ships prebuilt native binaries for macOS, Windows, and
  Linux (x64/arm64/musl) and needs no system libraries — a reviewer runs the
  pipeline with a plain `yarn install`, no Cairo/Pango to build.
- **Bundled fonts** remove the last platform dependency for text. See
  [`assets/fonts/README.md`](../../assets/fonts/README.md) for licensing.
- Procedural backgrounds, the shade, the type, and the logo box are all
  deterministic, so output is reproducible except where Imagen is the source.

---

## Extending it

- **Add a new image source** (a different model, a stock-photo API): implement
  `ImageGeneratorPort.resolveBackground` and inject it at the composition root.
  Nothing else changes — you can even keep `AssetReusingImageGenerator` and a
  procedural `fallback` wrapped around it.
- **Change the layout** (different logo anchor, multiple text blocks, a CTA badge):
  edit `NodeCanvasCompositor`; the port contract stays the same.
- **Add a font:** drop the `.ttf` into `assets/fonts/`, register it in
  `fonts.ts`, and select it via `MESSAGE_FONT`.

To see the output, run `yarn generate` from the repo root — it writes a full
creative set per product to `output/<product-id>/<ratio>.png`.
