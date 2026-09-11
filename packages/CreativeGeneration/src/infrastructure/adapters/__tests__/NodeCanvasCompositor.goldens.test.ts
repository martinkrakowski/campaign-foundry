import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import {
  AspectRatio,
  DISPLAY_SIZE_VALUES,
  MOTION_KINDS,
  resolveCanvas,
  restT,
  type CompositeRequest,
  type DisplaySize,
  type LayoutKind,
  type ToneKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";
import {
  BASE_GOLDEN_CELL_COUNT,
  DISPLAY_GOLDEN_CELL_COUNT,
  DISPLAY_INSET_GOLDEN_CELL_COUNT,
  INSET_GOLDEN_CELL_COUNT,
  compositorGoldenKey,
  goldenPlatformKeys,
  goldenRun,
  isRecordingGoldens,
  missingGoldenMapMessage,
  recordGoldenMap,
  resolveGoldenMap,
  type GoldenFixture,
  type GoldenRun,
} from "./compositor-golden-key.js";

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

const fixturesDir =
  process.env.COMPOSITOR_GOLDEN_FIXTURE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldensPath = join(fixturesDir, "compositor-goldens.json");
const insetsPath = join(fixturesDir, "compositor-goldens-insets.json");
const displayGoldensPath = join(fixturesDir, "compositor-goldens-display.json");
const displayInsetsPath = join(fixturesDir, "compositor-goldens-display-insets.json");

const fixture = JSON.parse(readFileSync(goldensPath, "utf8")) as GoldenFixture;

const finishGolden = (
  path: string,
  key: string,
  observed: Record<string, string>,
  run: GoldenRun,
  expectedCellCount: number,
): void => {
  if (run.kind === "record") {
    recordGoldenMap(path, key, observed, expectedCellCount);
    return;
  }
  expect(observed).toEqual(run.map);
};

describe("NodeCanvasCompositor goldens", () => {
  const compositor = new NodeCanvasCompositor();
  const backgrounds = new ProceduralBackgroundGenerator();
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(fixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(fixture));

  test(
    "still PNG sha256 matches the committed matrix (both layouts × both tones × three ratios)",
    // 12 cells × full-size raster: comfortably over Vitest's 5 s default on the CI runner.
    { timeout: 60_000 },
    async () => {
      const run = goldenRun(goldens, recording, missingMessage);

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
              canvas: { ratio: ratioValue },
              layout,
              tone,
            };
            const out = await compositor.compositeAsset(request);
            observed[cellKey(layout, tone, ratioValue)] = sha256(out.image);
          }
        }
      }
      finishGolden(goldensPath, key, observed, run, BASE_GOLDEN_CELL_COUNT);
    },
  );

  test(
    "draw at restT(kind) is byte-identical to the still for every MOTION_KINDS kind",
    // 12 cells × 5 full-size rasters (still + four kinds): well over the 5 s default.
    { timeout: 60_000 },
    async () => {
      const run = goldenRun(goldens, recording, missingMessage);

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
              canvas: { ratio: ratioValue },
              layout,
              tone,
            };
            // One prepare per cell; the still and all four rest-pose frames share it
            // (the still test above already proves compositeAsset matches the map).
            const prepared = await NodeCanvasCompositor.prepare(request);
            const canvas = createCanvas(prepared.width, prepared.height);
            const ctx = canvas.getContext("2d");
            NodeCanvasCompositor.draw(ctx, prepared, 1);
            const stillHash = sha256(canvas.toBuffer("image/png"));
            if (run.kind === "assert") {
              expect(stillHash).toBe(run.map[cellKey(layout, tone, ratioValue)]);
            }

            for (const kind of MOTION_KINDS) {
              NodeCanvasCompositor.draw(ctx, prepared, restT(kind), kind);
              expect(sha256(canvas.toBuffer("image/png"))).toBe(stillHash);
            }
          }
        }
      }
    },
  );
});

const INSET_CELL = "headline-top/bold/9:16";
const INSET_INSETS = { top: 120, right: 0, bottom: 200, left: 0 } as const;

const insetFixture = JSON.parse(readFileSync(insetsPath, "utf8")) as GoldenFixture;

// Pixel goldens are keyed by platform-arch. Structural tests in
// NodeCanvasCompositor.test.ts are the platform-independent guard for offsets,
// wrap width, clamping, overlap, and validation. A missing map fails (D115);
// record via record-goldens.yml on the platform that will assert it.
describe("NodeCanvasCompositor inset goldens", () => {
  const compositor = new NodeCanvasCompositor();
  const backgrounds = new ProceduralBackgroundGenerator();
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(insetFixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(insetFixture), {
    fixtureFile: "compositor-goldens-insets.json",
    cellsHint: `the ${INSET_CELL} cell`,
  });

  test(`still PNG sha256 with non-zero safeInsets matches ${INSET_CELL}`, async () => {
    const run = goldenRun(goldens, recording, missingMessage);

    const r = ratio("9:16");
    const bg = await backgrounds.resolveBackground(product, r, bgCtx);
    const request: CompositeRequest = {
      background: bg.image,
      message: MESSAGE,
      brandColor: BRAND,
      logoPath: LOGO,
      canvas: { ratio: r.value },
      layout: "headline-top",
      tone: "bold",
      safeInsets: { ...INSET_INSETS },
    };
    const out = await compositor.compositeAsset(request);
    finishGolden(insetsPath, key, { [INSET_CELL]: sha256(out.image) }, run, INSET_GOLDEN_CELL_COUNT);
  });
});

const displayFixture = JSON.parse(readFileSync(displayGoldensPath, "utf8")) as GoldenFixture;
const displayInsetFixture = JSON.parse(readFileSync(displayInsetsPath, "utf8")) as GoldenFixture;

const DISPLAY_INSET_CELL = "headline-top/bold/300x250";
const DISPLAY_INSET_INSETS = { top: 8, right: 8, bottom: 8, left: 8 } as const;

const displayBackground = (size: DisplaySize): Uint8Array => {
  const { width, height } = resolveCanvas({ size });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
};

describe("NodeCanvasCompositor display goldens", () => {
  const compositor = new NodeCanvasCompositor();
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(displayFixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(displayFixture), {
    fixtureFile: "compositor-goldens-display.json",
    cellsHint: "20 sha256 cells (both layouts × both tones × five display sizes)",
  });

  test(
    "still PNG sha256 matches the committed matrix (both layouts × both tones × five sizes)",
    { timeout: 60_000 },
    async () => {
      const run = goldenRun(goldens, recording, missingMessage);

      const observed: Record<string, string> = {};
      for (const layout of LAYOUTS) {
        for (const tone of TONES) {
          for (const size of DISPLAY_SIZE_VALUES) {
            const request: CompositeRequest = {
              background: displayBackground(size),
              message: MESSAGE,
              brandColor: BRAND,
              logoPath: LOGO,
              canvas: { size },
              layout,
              tone,
            };
            const out = await compositor.compositeAsset(request);
            observed[cellKey(layout, tone, size)] = sha256(out.image);
          }
        }
      }
      finishGolden(displayGoldensPath, key, observed, run, DISPLAY_GOLDEN_CELL_COUNT);
    },
  );
});

describe("NodeCanvasCompositor display inset goldens", () => {
  const compositor = new NodeCanvasCompositor();
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(displayInsetFixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(displayInsetFixture), {
    fixtureFile: "compositor-goldens-display-insets.json",
    cellsHint: `the ${DISPLAY_INSET_CELL} cell`,
  });

  test(`still PNG sha256 with non-zero safeInsets matches ${DISPLAY_INSET_CELL}`, async () => {
    const run = goldenRun(goldens, recording, missingMessage);

    const request: CompositeRequest = {
      background: displayBackground("300x250"),
      message: MESSAGE,
      brandColor: BRAND,
      logoPath: LOGO,
      canvas: { size: "300x250" },
      layout: "headline-top",
      tone: "bold",
      safeInsets: { ...DISPLAY_INSET_INSETS },
    };
    const out = await compositor.compositeAsset(request);
    finishGolden(
      displayInsetsPath,
      key,
      { [DISPLAY_INSET_CELL]: sha256(out.image) },
      run,
      DISPLAY_INSET_GOLDEN_CELL_COUNT,
    );
  });
});

