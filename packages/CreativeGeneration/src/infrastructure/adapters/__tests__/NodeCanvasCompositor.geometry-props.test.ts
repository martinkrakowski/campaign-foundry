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
 * overrides.
 *
 * C4b / R-D4: the text layers' `anchor` prop joins them, but only when no live
 * `variation.axes.anchor` is present — a prop never shadows a live axis. `alpha`
 * (shade) is not un-deferred; it is withdrawn (R-D4): the tone axis is never
 * absent, so an override would always silence it.
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
  // that reaches the blit. At the original 400x400 canvas the wrapped block
  // already fits at the natural (unshrunk) font size — the loop's very first
  // attempt — so it never even runs once, for ANY floor: the direction
  // assertion was vacuous regardless of implementation (verified empirically:
  // floor 0.1, 0.4 and 0.8 all produced the identical fontSize=24, lines=5).
  //
  // `pixelSize.height` is squeezed to 80 so the loop actually runs. At that
  // height a floor of 0.8 (19px) stalls too high to fit vertically — 19px
  // minFirst + a 4-line span still exceeds 80px — so `settleLayout` truncates
  // the wrapped 4 lines down to the 3 that fit, ellipsizing the last one. A
  // floor of 0.1 (2px) lets the loop keep shrinking until it reaches 16px,
  // where the SAME 4-line wrap fits with no truncation at all. So the gap
  // isn't "the low floor wraps into more lines" — both wrap into 4 raw lines —
  // it's that only the high floor is forced into the ellipsis/truncation path
  // (verified empirically: floor 0.1 -> 4 lines, floor 0.4 (the constant, also
  // below 16px) -> 4 lines, floor 0.8 -> 3 lines).
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

describe("text anchor prop is honoured only without the anchor axis (C4b, R-D4)", () => {
  test("no axis anchor: the text layer's anchor prop wins over the layout-derived default", async () => {
    const req = request({
      // The bottom layout would derive "bottom" absent the prop (D54).
      layout: "headline-bottom",
      template: templateWith([IMAGE, { id: "copy", kind: "static-text", props: { anchor: "top" } }]),
    });
    const prepared = await NodeCanvasCompositor.prepare(req);
    expect(prepared.anchor).toBe("top");

    // Pixel proof, not just the field: the prop-driven render is byte-identical
    // to an explicit axis anchor of "top" on the same layout — the merge moves
    // the draw, not only `PreparedCreative.anchor`.
    const withProp = await frame(req);
    const explicitTop = await frame(
      request({ layout: "headline-bottom", anchor: "top", template: templateWith([IMAGE, COPY]) }),
    );
    expect(sameBytes(withProp, explicitTop)).toBe(true);
  });

  test("a live anchor axis wins over the text layer's anchor prop", async () => {
    const req = request({
      layout: "headline-bottom",
      anchor: "bottom", // the axis-selected anchor (T4)
      template: templateWith([IMAGE, { id: "copy", kind: "static-text", props: { anchor: "top" } }]),
    });
    const prepared = await NodeCanvasCompositor.prepare(req);
    expect(prepared.anchor).toBe("bottom");

    const withAxis = await frame(req);
    const axisAloneNoProp = await frame(
      request({ layout: "headline-bottom", anchor: "bottom", template: templateWith([IMAGE, COPY]) }),
    );
    expect(sameBytes(withAxis, axisAloneNoProp)).toBe(true);
  });

  test("an absent anchor prop renders byte-identical to the layout-derived default", async () => {
    const a = await frame(
      request({ layout: "headline-bottom", template: templateWith([IMAGE, COPY]) }),
    );
    const b = await frame(
      request({
        layout: "headline-bottom",
        template: templateWith([IMAGE, { id: "copy", kind: "static-text", props: {} }]),
      }),
    );
    expect(sameBytes(a, b)).toBe(true);
  });
});
