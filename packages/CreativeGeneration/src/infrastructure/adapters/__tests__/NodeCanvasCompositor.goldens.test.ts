import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AspectRatio, type CompositeRequest, type LayoutKind, type ToneKind } from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";

const LAYOUTS: readonly LayoutKind[] = ["headline-bottom", "headline-top"];
const TONES: readonly ToneKind[] = ["bold", "subtle"];
const RATIOS = ["1:1", "9:16", "16:9"] as const;

const MESSAGE = "Stay wild, stay hydrated";
const BRAND = "#1473E6";
const LOGO = "assets/inputs/hydra-logo.png";

const ratio = (v: string) => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

const product = { id: "hydra-bottle", name: "Hydra Bottle", primaryColor: BRAND, logoPath: LOGO };
const bgCtx = { campaignMessage: MESSAGE, targetAudience: "a", targetRegion: "r" };

const cellKey = (layout: LayoutKind, tone: ToneKind, ratioValue: string) =>
  `${layout}/${tone}/${ratioValue}`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const goldens = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/compositor-goldens.json"), "utf8"),
) as Record<string, string>;

describe("NodeCanvasCompositor goldens", () => {
  const compositor = new NodeCanvasCompositor();
  const backgrounds = new ProceduralBackgroundGenerator();

  test("still PNG sha256 matches the committed matrix (both layouts × both tones × three ratios)", async () => {
    const observed: Record<string, string> = {};
    for (const layout of LAYOUTS) {
      for (const tone of TONES) {
        for (const ratioValue of RATIOS) {
          const r = ratio(ratioValue);
          const bg = await backgrounds.resolveBackground(product, r, bgCtx);
          const request: CompositeRequest = {
            background: bg.image,
            message: MESSAGE,
            brandColor: BRAND,
            logoPath: LOGO,
            ratio: r,
            layout,
            tone,
          };
          const out = await compositor.compositeAsset(request);
          observed[cellKey(layout, tone, ratioValue)] = sha256(out.image);
        }
      }
    }
    expect(observed).toEqual(goldens);
  });
});
