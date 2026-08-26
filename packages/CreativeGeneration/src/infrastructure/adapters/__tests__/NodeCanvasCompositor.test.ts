import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import * as CreativeGeneration from "@campaignfoundry/CreativeGeneration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

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
    const insets = { top: 120, right: 40, bottom: 200, left: 30 };
    const layouts = ["headline-top", "headline-bottom"] as const;
    const ratios = ["1:1", "9:16", "16:9"] as const;

    for (const layout of layouts) {
      for (const value of ratios) {
        const r = ratio(value);
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
        expect(insetHeadline.x).toBe(zeroHeadline.x);
      }
    }
  });
});

type BlitPoint = { x: number; y: number };

/** Paint a prepared request and record fillText / drawImage positions. */
async function blit(req: CompositeRequest): Promise<{ fillText: BlitPoint[]; drawImage: BlitPoint[] }> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const fillText: BlitPoint[] = [];
  const drawImage: BlitPoint[] = [];
  const origFill = ctx.fillText.bind(ctx);
  const origDraw = ctx.drawImage.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    fillText.push({ x, y });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
    drawImage.push({ x: args[1] as number, y: args[2] as number });
    return origDraw(...args);
  }) as typeof ctx.drawImage;
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return { fillText, drawImage };
}
