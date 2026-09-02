import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest, type SafeInsets } from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { projectRoot } from "@campaignfoundry/shared";
import * as CreativeGeneration from "@campaignfoundry/CreativeGeneration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

const wrapCapture = vi.hoisted(() => ({ maxWidths: [] as number[] }));

vi.mock("../canvas-util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../canvas-util.js")>();
  return {
    ...actual,
    wrapText: (
      ctx: { measureText: (text: string) => { width: number } },
      text: string,
      maxWidth: number,
    ) => {
      wrapCapture.maxWidths.push(maxWidth);
      return actual.wrapText(ctx, text, maxWidth);
    },
  };
});

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

/** A solid background PNG the compositor can draw under its layers. */
const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

const request = (over: Partial<CompositeRequest> = {}): CompositeRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  ratio: ratio("1:1"),
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

// A real but non-decodable file under assets/, to exercise the corrupt-logo branch.
const corruptLogo = resolve(projectRoot(), "assets/__cf-corrupt-logo-fixture.png");

describe("NodeCanvasCompositor", () => {
  const compositor = new NodeCanvasCompositor();

  beforeAll(() => writeFileSync(corruptLogo, "not a real image"));
  afterAll(() => rmSync(corruptLogo, { force: true }));
  afterEach(() => vi.restoreAllMocks());

  test("does not leak prepare/draw from the package root", () => {
    expect(CreativeGeneration).not.toHaveProperty("drawCreative");
    expect(CreativeGeneration).not.toHaveProperty("prepareCreative");
    expect(CreativeGeneration).not.toHaveProperty("PreparedCreative");
    expect(typeof CreativeGeneration.NodeCanvasCompositor.prepare).toBe("function");
    expect(typeof CreativeGeneration.NodeCanvasCompositor.draw).toBe("function");
  });

  test("static prepare defaults the font family to Inter", async () => {
    const prepared = await NodeCanvasCompositor.prepare(request());
    expect(prepared.fontFamily).toBe("Inter");
  });

  test("renders a PNG at the requested ratio's exact dimensions", async () => {
    for (const value of ["1:1", "9:16", "16:9"] as const) {
      const r = ratio(value);
      const out = await compositor.compositeAsset(request({ ratio: r }));
      const img = await loadImage(Buffer.from(out.image));
      expect(img.width).toBe(r.width);
      expect(img.height).toBe(r.height);
    }
  });

  test("reports logoApplied when the brand logo renders", async () => {
    const out = await compositor.compositeAsset(request());
    expect(out.logoApplied).toBe(true);
  });

  test("logo geometry derives from the domain's creative-geometry leaf", async () => {
    const r = ratio("1:1");
    const captured = await blit(request({ ratio: r }));
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    const margin = r.width * CREATIVE_GEOMETRY.logoMarginFraction;
    expect(logo.width).toBe(r.width * CREATIVE_GEOMETRY.logoWidthFraction);
    // Bottom headline → the logo rests top-right, inset by the margin.
    expect(logo.x).toBe(r.width - logo.width - margin);
    expect(logo.y).toBe(margin);
  });

  test("covers both layout edges and tones deterministically", async () => {
    const top = request({ layout: "headline-top", tone: "subtle" });
    const bottom = request({ layout: "headline-bottom", tone: "bold" });
    const a = await compositor.compositeAsset(top);
    const b = await compositor.compositeAsset(top);
    expect(Buffer.from(a.image).equals(Buffer.from(b.image))).toBe(true); // deterministic
    const c = await compositor.compositeAsset(bottom);
    expect(c.logoApplied).toBe(true);
  });

  test("logoApplied is false (no warning) when the logo is simply missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await compositor.compositeAsset(request({ logoPath: "assets/inputs/missing-logo.png" }));
    expect(out.logoApplied).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test("logoApplied is false with a warning when the logo is present but unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await compositor.compositeAsset(request({ logoPath: "assets/__cf-corrupt-logo-fixture.png" }));
    expect(out.logoApplied).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  test("logoApplied is false when the logo path is unsafe (resolves to nothing)", async () => {
    const out = await compositor.compositeAsset(request({ logoPath: "/etc/passwd" }));
    expect(out.logoApplied).toBe(false);
  });

  test("omitted and all-zero safeInsets produce identical PNG bytes", async () => {
    const omitted = await compositor.compositeAsset(request());
    const zeros = await compositor.compositeAsset(
      request({ safeInsets: { top: 0, right: 0, bottom: 0, left: 0 } }),
    );
    expect(Buffer.from(zeros.image).equals(Buffer.from(omitted.image))).toBe(true);
  });

  test("headline first baseline and logo top-left move by exactly the inset on every ratio and layout", async () => {
    const insets: SafeInsets = { top: 120, right: 40, bottom: 200, left: 30 };
    const layouts = ["headline-top", "headline-bottom"] as const;
    const ratios = ["1:1", "9:16", "16:9"] as const;

    for (const layout of layouts) {
      for (const value of ratios) {
        const r = ratio(value);
        const innerWidth = r.width - insets.left - insets.right;
        const zero = await blit(request({ layout, ratio: r }));
        const inset = await blit(request({ layout, ratio: r, safeInsets: insets }));

        const zeroHeadline = zero.fillText[0];
        const insetHeadline = inset.fillText[0];
        const zeroLogo = zero.drawImage[1];
        const insetLogo = inset.drawImage[1];
        if (!zeroHeadline || !insetHeadline || !zeroLogo || !insetLogo) {
          throw new Error(`missing blit capture for ${layout} ${value}`);
        }

        if (layout === "headline-top") {
          expect(insetHeadline.y).toBe(zeroHeadline.y + insets.top);
          expect(insetLogo.x).toBe(zeroLogo.x + insets.left);
          expect(insetLogo.y).toBe(zeroLogo.y - insets.bottom);
        } else {
          expect(insetHeadline.y).toBe(zeroHeadline.y - insets.bottom);
          expect(insetLogo.x).toBe(zeroLogo.x - insets.right);
          expect(insetLogo.y).toBe(zeroLogo.y + insets.top);
        }
        expect(zeroHeadline.x).toBe(r.width / 2);
        expect(insetHeadline.x).toBe(insets.left + innerWidth / 2);
        expect(zero.wrapWidths[0]).toBe(r.width * 0.85);
        expect(inset.wrapWidths[0]).toBe(innerWidth * 0.85);
      }
    }
  });

  const THREE_LINE =
    "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today";

  test("clamps a top headline up when the default last baseline would cross the bottom inset", async () => {
    const insets: SafeInsets = { top: 200, right: 0, bottom: 400, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-top", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    const fontSize = Math.round(r.width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    const lineHeight = fontSize * 1.25;
    const span = 2 * lineHeight;
    const maxLast = r.height - insets.bottom;
    expect(captured.fillText).toHaveLength(3);
    expect(captured.fillText[0]?.y).toBe(maxLast - span);
    expect(captured.fillText[2]?.y).toBe(maxLast);
  });

  test("clamps a bottom headline down when the default first baseline would cross the top inset", async () => {
    const insets: SafeInsets = { top: 400, right: 0, bottom: 200, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-bottom", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    const fontSize = Math.round(r.width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    const minFirst = insets.top + fontSize;
    expect(captured.fillText).toHaveLength(3);
    expect(captured.fillText[0]?.y).toBe(minFirst);
  });

  test("reduces fontSize in 4px steps when a multi-line block cannot fit the inset height", async () => {
    const insets: SafeInsets = { top: 400, right: 0, bottom: 400, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-top", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    expect(captured.fillText).toHaveLength(2);
    const lineHeight = (captured.fillText[1]?.y ?? 0) - (captured.fillText[0]?.y ?? 0);
    expect(lineHeight).toBe(83 * 1.25);
    expect(captured.fillText[0]?.y).toBeGreaterThanOrEqual(insets.top + 83);
    expect(captured.fillText[1]?.y).toBeLessThanOrEqual(r.height - insets.bottom);
  });

  test("truncates with an ellipsis at the 40% floor when shrinking is not enough", async () => {
    const insets: SafeInsets = { top: 500, right: 800, bottom: 500, left: 800 };
    const r = ratio("16:9");
    for (const layout of ["headline-top", "headline-bottom"] as const) {
      const captured = await blit(request({ layout, ratio: r, message: THREE_LINE, safeInsets: insets }));
      expect(captured.fillText).toHaveLength(1);
      expect(captured.fillText[0]?.text).toMatch(/…$/);
      const floor = Math.round(
      Math.round(r.width * CREATIVE_GEOMETRY.headlineTypeWidthFraction) *
        CREATIVE_GEOMETRY.headlineTypeFloorFraction,
    );
      expect(captured.fillText[0]?.y).toBeGreaterThanOrEqual(insets.top + floor);
      expect(captured.fillText[0]?.y).toBeLessThanOrEqual(r.height - insets.bottom);
    }
  });

  test("trims the last kept line until the ellipsis fits the wrap width", async () => {
    const insets: SafeInsets = { top: 500, right: 800, bottom: 500, left: 800 };
    const r = ratio("16:9");
    const captured = await blit(
      request({
        layout: "headline-top",
        ratio: r,
        message: "Supercalifragilisticexpialidocious wild stay hydrated",
        safeInsets: insets,
      }),
    );
    expect(captured.fillText).toHaveLength(1);
    expect(captured.fillText[0]?.text).toBe("Supercalif…");
  });

  test("keeps a one-line headline at the floor when even that line is taller than the inset", async () => {
    const insets: SafeInsets = { top: 520, right: 0, bottom: 520, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(request({ layout: "headline-top", ratio: r, message: "Hi", safeInsets: insets }));
    expect(captured.fillText).toHaveLength(1);
    expect(captured.fillText[0]?.text).toBe("Hi");
  });

  test("clamps the logo into the inset rectangle when margin would overflow it", async () => {
    const insets: SafeInsets = { top: 0, right: 400, bottom: 0, left: 500 };
    const r = ratio("1:1");
    const captured = await blit(request({ layout: "headline-top", ratio: r, safeInsets: insets }));
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    expect(logo.x).toBeGreaterThanOrEqual(insets.left);
    expect(logo.x + logo.width).toBeLessThanOrEqual(r.width - insets.right);
    expect(logo.y).toBeGreaterThanOrEqual(insets.top);
    expect(logo.y + logo.height).toBeLessThanOrEqual(r.height - insets.bottom);
  });

  test("pins the logo to the inset origin when the logo is larger than the inset rectangle", async () => {
    const insets: SafeInsets = { top: 50, right: 500, bottom: 1700, left: 500 };
    const r = ratio("9:16");
    const prepared = await NodeCanvasCompositor.prepare(request({ layout: "headline-top", ratio: r, safeInsets: insets }));
    expect(prepared.logo?.x).toBe(insets.left);
    expect(prepared.logo?.y).toBe(insets.top);
  });

  test("emits a lone ellipsis when even one trimmed character cannot fit the wrap width", async () => {
    const insets: SafeInsets = { top: 500, right: 960, bottom: 500, left: 959 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-top", ratio: r, message: "Stay wild hydrated", safeInsets: insets }),
    );
    expect(captured.fillText).toHaveLength(1);
    expect(captured.fillText[0]?.text).toBe("…");
  });

  test("16:9 three-line copy with {top:200,bottom:200} snaps the logo to the opposite inset edge", async () => {
    const insets: SafeInsets = { top: 200, right: 0, bottom: 200, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-top", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    expect(captured.fillText).toHaveLength(3);
    const fontSize = Math.round(r.width * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    expect(captured.fillText[0]?.y).toBeGreaterThanOrEqual(insets.top + fontSize);
    expect(captured.fillText[2]?.y).toBeLessThanOrEqual(r.height - insets.bottom);
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    expect(logo.x).toBeGreaterThanOrEqual(insets.left);
    expect(logo.y).toBe(r.height - insets.bottom - logo.height);
    expect(logo.y + logo.height).toBeLessThanOrEqual(r.height - insets.bottom);
  });

  test("snaps the overlapping logo flush to the opposite edge when that clears the headline", async () => {
    const insets: SafeInsets = { top: 200, right: 0, bottom: 50, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-top", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    expect(logo.y).toBe(r.height - insets.bottom - logo.height);
  });

  test("flips the logo to the other inset edge when the opposite edge still overlaps", async () => {
    const insets: SafeInsets = { top: 200, right: 0, bottom: 1400, left: 0 };
    const r = ratio("9:16");
    const captured = await blit(request({ layout: "headline-top", ratio: r, safeInsets: insets }));
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    expect(logo.y).toBe(insets.top);
  });

  test("snaps a bottom-headline logo to the top inset edge when the block overlaps it", async () => {
    const insets: SafeInsets = { top: 200, right: 0, bottom: 200, left: 0 };
    const r = ratio("16:9");
    const captured = await blit(
      request({ layout: "headline-bottom", ratio: r, message: THREE_LINE, safeInsets: insets }),
    );
    const logo = captured.drawImage[1];
    if (!logo) throw new Error("missing logo blit");
    expect(logo.y).toBe(insets.top);
  });

  test.each([
    ["top", { top: Number.NaN, right: 0, bottom: 0, left: 0 }],
    ["right", { top: 0, right: Number.POSITIVE_INFINITY, bottom: 0, left: 0 }],
    ["bottom", { top: 0, right: 0, bottom: -1, left: 0 }],
    ["left", { top: 0, right: 0, bottom: 0, left: Number.NaN }],
  ] as const)("prepare throws naming safeInsets.%s when that side is not a finite ≥ 0", async (side, safeInsets) => {
    await expect(NodeCanvasCompositor.prepare(request({ safeInsets }))).rejects.toThrow(
      new RegExp(`safeInsets\\.${side}`),
    );
  });

  test("prepare throws when top + bottom is not less than height", async () => {
    await expect(
      NodeCanvasCompositor.prepare(request({ safeInsets: { top: 540, right: 0, bottom: 540, left: 0 } })),
    ).rejects.toThrow(/safeInsets\.top \+ safeInsets\.bottom/);
  });

  test("prepare throws when left + right is not less than width", async () => {
    await expect(
      NodeCanvasCompositor.prepare(
        request({ ratio: ratio("16:9"), safeInsets: { top: 0, right: 960, bottom: 0, left: 960 } }),
      ),
    ).rejects.toThrow(/safeInsets\.left \+ safeInsets\.right/);
  });
});

type BlitPoint = { x: number; y: number; text: string };
type BlitImage = { x: number; y: number; width: number; height: number };

/** Paint a prepared request and record fillText / drawImage positions plus wrap widths. */
async function blit(
  req: CompositeRequest,
): Promise<{ fillText: BlitPoint[]; drawImage: BlitImage[]; wrapWidths: number[] }> {
  wrapCapture.maxWidths = [];
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const fillText: BlitPoint[] = [];
  const drawImage: BlitImage[] = [];
  const origFill = ctx.fillText.bind(ctx);
  const origDraw = ctx.drawImage.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    fillText.push({ x, y, text });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
    drawImage.push({
      x: args[1] as number,
      y: args[2] as number,
      width: args[3] as number,
      height: args[4] as number,
    });
    return origDraw(...args);
  }) as typeof ctx.drawImage;
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return { fillText, drawImage, wrapWidths: [...wrapCapture.maxWidths] };
}
