import { describe, expect, test } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate, CompositeRequest } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * AR2 — `drawHtml` paints nothing, so a canonical image-html frame's top-left
 * pixel is the ground, never a sentinel the drawer could have stamped there.
 * The mutation that fills (0, 0, 2, 2) with `#ff00fe` before returning must
 * turn this assertion red.
 */
describe("drawHtml paints nothing", () => {
  test("the canonical image-html template's top-left pixel is not #ff00fe", async () => {
    const background = createCanvas(40, 40);
    const g = background.getContext("2d");
    g.fillStyle = "#112233";
    g.fillRect(0, 0, 40, 40);
    const template: BriefTemplate = {
      id: "canonical-image-html",
      version: CANONICAL_TEMPLATES["image-html"].version,
      creativeType: "image-html",
      unit: "standard-web",
      layers: CANONICAL_TEMPLATES["image-html"].layers,
    };
    const request: CompositeRequest = {
      background: background.toBuffer("image/png"),
      message: "Stay wild, stay hydrated",
      brandColor: "#1473E6",
      logoPath: "assets/inputs/hydra-logo.png",
      canvas: { ratio: "1:1" },
      pixelSize: { width: 40, height: 40 },
      layout: "headline-bottom",
      tone: "bold",
      template,
    };
    const prepared = await NodeCanvasCompositor.prepare(request);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    NodeCanvasCompositor.draw(ctx, prepared, 1);
    const px = ctx.getImageData(0, 0, 1, 1).data;
    const hex = `#${[px[0], px[1], px[2]]
      .map((channel) => channel!.toString(16).padStart(2, "0"))
      .join("")}`;
    // The ground is painted first and nothing after it covers the origin:
    // the html layer is a no-op and the missing logo is skipped. Any stamp
    // drawHtml might add, not only #ff00fe, changes this pixel.
    expect(hex).toBe("#112233");
  });
});
