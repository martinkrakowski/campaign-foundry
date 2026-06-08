import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
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
});
