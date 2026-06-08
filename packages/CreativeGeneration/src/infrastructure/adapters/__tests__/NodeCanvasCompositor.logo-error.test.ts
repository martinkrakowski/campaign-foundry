import { describe, test, expect, vi, afterEach } from "vitest";

// Force the logo read to reject with a NON-Error value, which real readFile/loadImage
// never do — this is the only way to exercise the catch's `String(error)` fallback.
// Isolated in its own file so the main compositor suite keeps real filesystem I/O.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    throw "logo blew up (non-Error)";
  }),
}));

import { createCanvas } from "@napi-rs/canvas";
import { AspectRatio, type CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

const ratio = () => {
  const r = AspectRatio.create("1:1");
  if (!r.success) throw r.error;
  return r.value;
};

const request = (): CompositeRequest => {
  const c = createCanvas(32, 32);
  c.getContext("2d").fillRect(0, 0, 32, 32);
  return {
    background: c.toBuffer("image/png"),
    message: "Hi",
    brandColor: "#1473E6",
    logoPath: "assets/inputs/hydra-logo.png",
    ratio: ratio(),
    layout: "headline-bottom",
    tone: "bold",
  };
};

describe("NodeCanvasCompositor — non-Error logo failure", () => {
  afterEach(() => vi.restoreAllMocks());

  test("formats a non-Error logo failure through String() and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await new NodeCanvasCompositor().compositeAsset(request());
    expect(out.logoApplied).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("logo blew up (non-Error)");
  });
});
