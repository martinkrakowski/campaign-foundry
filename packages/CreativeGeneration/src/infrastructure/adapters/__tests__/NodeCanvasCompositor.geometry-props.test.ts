import { describe, expect, test, vi } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type CreativeTemplateLayer,
  type CreativeType,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * C4 / R-D3: the per-layer geometry props (D134) become live. Each of the four
 * in-scope props — `accent.solidHeight`/`accent.fadeHeight`, `logo.width`/
 * `logo.margin`, and the text layers' `typeFloor` — must change the drawn
 * result in the direction its name implies, and a layer carrying the prop
 * ABSENT (or an empty `props`) must render byte-identically to the constant it
 * overrides. `anchor` (text) and `alpha` (shade) are out of scope: each shadows
 * a variation axis and is left reading exactly as today.
 *
 * The assertion surface is pixels: a prop is live iff moving it moves pixels,
 * and byte-neutral when absent iff the frames are equal to the pixel.
 */

const SIZE = 400;
const BRAND = "#1473E6";
const BRAND_RGB: readonly [number, number, number] = [0x14, 0x73, 0xe6];

const background = (): Uint8Array => {
  const c = createCanvas(SIZE, SIZE);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, SIZE, SIZE);
  return c.toBuffer("image/png");
};

type TemplateRequest = CompositeRequest & {
  readonly template?: BriefTemplate;
  readonly creativeType?: CreativeType;
};

const request = (over: Partial<TemplateRequest> = {}): TemplateRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: BRAND,
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "1:1" },
  pixelSize: { width: SIZE, height: SIZE },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

const templateWith = (layers: readonly CreativeTemplateLayer[]): BriefTemplate => ({
  id: "canonical-image-text",
  version: 1,
  creativeType: "image-text",
  unit: "standard-web",
  layers,
});

interface Frame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Render a still to raw RGBA — the whole draw, not the dispatch spy. */
async function frame(req: TemplateRequest): Promise<Frame> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  const imageData = ctx.getImageData(0, 0, prepared.width, prepared.height);
  return { data: imageData.data, width: prepared.width, height: prepared.height };
}

/** How many text blits a still frame makes (drawStaticText paints one per line). */
async function fillTextCalls(req: TemplateRequest): Promise<number> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  const spy = vi.spyOn(ctx, "fillText");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return spy.mock.calls.length;
}

const sameBytes = (a: Frame, b: Frame): boolean =>
  a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

const at = (f: Frame, x: number, y: number): number => (y * f.width + x) * 4;

/** Count columns where the two frames differ in any row — a horizontal footprint. */
function diffColumns(a: Frame, b: Frame): number {
  let n = 0;
  for (let x = 0; x < a.width; x++) {
    for (let y = 0; y < a.height; y++) {
      const i = at(a, x, y);
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Count rows differing between two frames — a vertical footprint. */
function diffRows(a: Frame, b: Frame): number {
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = at(a, x, y);
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Rows, from the bottom edge up, painted in the exact (opaque) brand colour. */
function solidBrandRowsFromBottom(f: Frame): number {
  let n = 0;
  for (let y = f.height - 1; y >= 0; y--) {
    const i = at(f, Math.floor(f.width / 2), y);
    if (f.data[i] === BRAND_RGB[0] && f.data[i + 1] === BRAND_RGB[1] && f.data[i + 2] === BRAND_RGB[2]) {
      n++;
    } else {
      break;
    }
  }
  return n;
}

/** The leftmost column at which `with` diverges from `base` — a footprint's near edge. */
function leftmostDiffColumn(base: Frame, with_: Frame): number {
  for (let x = 0; x < base.width; x++) {
    for (let y = 0; y < base.height; y++) {
      const i = at(base, x, y);
      if (
        base.data[i] !== with_.data[i] ||
        base.data[i + 1] !== with_.data[i + 1] ||
        base.data[i + 2] !== with_.data[i + 2]
      ) {
        return x;
      }
    }
  }
  return base.width;
}

/** A PNG byte-comparison through the pipeline's own loader. */
async function pngEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const ia = await loadImage(Buffer.from(a));
  const ib = await loadImage(Buffer.from(b));
  const ca = createCanvas(ia.width, ia.height);
  const cb = createCanvas(ib.width, ib.height);
  ca.getContext("2d").drawImage(ia, 0, 0);
  cb.getContext("2d").drawImage(ib, 0, 0);
  return sameBytes(
    { data: ca.getContext("2d").getImageData(0, 0, ca.width, ca.height).data, width: ca.width, height: ca.height },
    { data: cb.getContext("2d").getImageData(0, 0, cb.width, cb.height).data, width: cb.width, height: cb.height },
  );
}

const IMAGE: CreativeTemplateLayer = { id: "image", kind: "image" };
const COPY: CreativeTemplateLayer = { id: "copy", kind: "static-text" };

describe("logo.width is live (C4, R-D3)", () => {
  test("a larger width paints the logo over a wider span", async () => {
    const base = await frame(request({ template: templateWith([IMAGE, COPY]) }));
    const dflt = await frame(
      request({ template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo" }]) }),
    );
    const wide = await frame(
      request({
        template: templateWith([
          IMAGE,
          COPY,
          { id: "logo", kind: "logo", props: { width: 0.32 } },
        ]),
      }),
    );
    const baseSpan = diffColumns(base, dflt);
    const wideSpan = diffColumns(base, wide);
    expect(baseSpan).toBeGreaterThan(0);
    expect(wideSpan).toBeGreaterThan(baseSpan);
  });

  test("an absent width (empty props) renders byte-identical to the constant", async () => {
    const noKey = request({ template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo" }]) });
    const emptyProps = request({
      template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo", props: {} }]),
    });
    const a = await NodeCanvasCompositor.prepare(noKey);
    const b = await NodeCanvasCompositor.prepare(emptyProps);
    const ca = createCanvas(a.width, a.height).getContext("2d");
    const cb = createCanvas(b.width, b.height).getContext("2d");
    NodeCanvasCompositor.draw(ca, a, 1);
    NodeCanvasCompositor.draw(cb, b, 1);
    expect(await pngEqual(ca.canvas.toBuffer("image/png"), cb.canvas.toBuffer("image/png"))).toBe(true);
  });
});

describe("logo.margin is live (C4, R-D3)", () => {
  test("a larger margin pulls the corner logo inward", async () => {
    const base = await frame(request({ template: templateWith([IMAGE, COPY]) }));
    const dflt = await frame(
      request({ template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo" }]) }),
    );
    const wide = await frame(
      request({
        template: templateWith([
          IMAGE,
          COPY,
          { id: "logo", kind: "logo", props: { margin: 0.16 } },
        ]),
      }),
    );
    // The bottom-layout logo sits top-right; a bigger margin moves it left, so
    // the footprint's left edge reaches further into the canvas.
    expect(leftmostDiffColumn(base, dflt)).toBeGreaterThan(0);
    expect(leftmostDiffColumn(base, wide)).toBeLessThan(leftmostDiffColumn(base, dflt));
  });

  test("an absent margin renders byte-identical to the constant", async () => {
    const a = await frame(
      request({ template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo", props: {} }]) }),
    );
    const b = await frame(
      request({ template: templateWith([IMAGE, COPY, { id: "logo", kind: "logo" }]) }),
    );
    expect(sameBytes(a, b)).toBe(true);
  });
});

describe("accent.solidHeight is live (C4, R-D3)", () => {
  test("a taller solid band covers more rows in the brand colour", async () => {
    const thin = await frame(
      request({ template: templateWith([IMAGE, { id: "accent", kind: "accent", props: { solidHeight: 0.02 } }]) }),
    );
    const thick = await frame(
      request({ template: templateWith([IMAGE, { id: "accent", kind: "accent", props: { solidHeight: 0.12 } }]) }),
    );
    const thinRows = solidBrandRowsFromBottom(thin);
    const thickRows = solidBrandRowsFromBottom(thick);
    expect(thinRows).toBeGreaterThan(0);
    expect(thickRows).toBeGreaterThan(thinRows);
  });

  test("an absent solidHeight renders byte-identical to the constant", async () => {
    const a = await frame(request({ template: templateWith([IMAGE, { id: "accent", kind: "accent" }]) }));
    const b = await frame(
      request({ template: templateWith([IMAGE, { id: "accent", kind: "accent", props: {} }]) }),
    );
    expect(sameBytes(a, b)).toBe(true);
  });
});

describe("accent.fadeHeight is live (C4, R-D3)", () => {
  test("a taller fade extends the band's footprint upward", async () => {
    const base = await frame(request({ template: templateWith([IMAGE]) }));
    const thin = await frame(
      request({
        template: templateWith([
          IMAGE,
          { id: "accent", kind: "accent", props: { solidHeight: 0.02, fadeHeight: 0.01 } },
        ]),
      }),
    );
    const tall = await frame(
      request({
        template: templateWith([
          IMAGE,
          { id: "accent", kind: "accent", props: { solidHeight: 0.02, fadeHeight: 0.2 } },
        ]),
      }),
    );
    expect(diffRows(base, tall)).toBeGreaterThan(diffRows(base, thin));
  });

  test("an absent fadeHeight renders byte-identical to the constant", async () => {
    const a = await frame(request({ template: templateWith([IMAGE, { id: "accent", kind: "accent" }]) }));
    const b = await frame(
      request({ template: templateWith([IMAGE, { id: "accent", kind: "accent", props: {} }]) }),
    );
    expect(sameBytes(a, b)).toBe(true);
  });
});

describe("text typeFloor is live (C4, R-D3)", () => {
  // A message long enough that the autofit loop runs to the floor, so where the
  // floor sits decides the headline's resolved type size — and the line count
  // that reaches the blit. `pixelSize.height` is squeezed well below the
  // square default (400): at the natural (unshrunk) font size the wrapped
  // block does not fit in 400px of headroom either — the autofit loop runs —
  // but it fits again after only one or two 4px steps, before floor 0.1 and
  // floor 0.8 (2px vs 19px) diverge, so both floors converge on the same
  // stopping size and the direction assertion is vacuous. At height 80 the
  // low floor keeps shrinking (and re-wrapping into more, shorter lines)
  // past where the high floor is forced to settle — verified empirically:
  // floor 0.1 -> 4 lines, floor 0.4 (the constant) -> 4 lines, floor 0.8 -> 3.
  const LONG =
    "Stay wild, stay hydrated, and keep every drop exactly where the adventure left it, " +
    "mile after mile, ridge after ridge, river after river under an open sky";

  const textReq = (props?: Record<string, number>): TemplateRequest =>
    request({
      message: LONG,
      pixelSize: { width: SIZE, height: 80 },
      template: templateWith([
        IMAGE,
        { id: "copy", kind: "static-text", ...(props ? { props } : {}) },
      ]),
    });

  test("a higher floor keeps the headline larger — fewer lines reach the blit", async () => {
    const low = await fillTextCalls(textReq({ typeFloor: 0.1 }));
    const high = await fillTextCalls(textReq({ typeFloor: 0.8 }));
    // Non-vacuousness: the default floor really is being shrunk to, so the prop
    // has something to move.
    const dflt = await fillTextCalls(textReq());
    expect(dflt).toBeGreaterThan(1);
    expect(high).toBeLessThan(low);
  });

  test("an absent typeFloor renders byte-identical to the constant", async () => {
    const a = await frame(textReq());
    const b = await frame(textReq({}));
    expect(sameBytes(a, b)).toBe(true);
  });
});
