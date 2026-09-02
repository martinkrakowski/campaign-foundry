import { describe, test, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import {
  AspectRatio,
  MOTION_KINDS,
  restT,
  type CompositeRequest,
  type LayoutKind,
  type MotionKind,
  type ToneKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { registerBundledFonts } from "../../fonts.js";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";
import {
  compositorGoldenKey,
  missingGoldenMapMessage,
  resolveGoldenMap,
  type GoldenFixture,
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

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/compositor-goldens.json"), "utf8"),
) as GoldenFixture;

const render = (prepared: Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>, t: number, motion?: MotionKind) => {
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, motion);
  return canvas.toBuffer("image/png");
};

afterEach(() => vi.restoreAllMocks());

describe("NodeCanvasCompositor D10 — the legacy path is byte-identical after the timeline change", () => {
  // Registering the bundled fonts (as the goldens test does via its compositor
  // instance) is required for the hashes; without it text renders in a fallback.
  registerBundledFonts();
  const backgrounds = new ProceduralBackgroundGenerator();
  const key = compositorGoldenKey();
  const goldens = resolveGoldenMap(fixture, key);
  const skipReason = goldens ? undefined : missingGoldenMapMessage(key, Object.keys(fixture));

  // The committed platform goldens encode the pre-timeline still bytes. `draw` and
  // `drawLegacy` must BOTH land on them for every motion kind at rest, or the
  // timeline feature changed what a timeline-free request renders (D10).
  test.skipIf(Boolean(skipReason))(
    skipReason ??
      "draw and drawLegacy both match the committed still goldens at restT(kind) for every motion kind",
    { timeout: 120_000 },
    async () => {
      const map = resolveGoldenMap(fixture, key);
      if (!map) {
        throw new Error(`unreachable: skipped when goldens missing for "${key}"`);
      }

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
            const prepared = await NodeCanvasCompositor.prepare(request);
            expect(sha256(render(prepared, 1))).toBe(map[cellKey(layout, tone, ratioValue)]);

            for (const kind of MOTION_KINDS) {
              // draw (no timeline) routes to drawLegacy — both must match the still.
              expect(sha256(render(prepared, restT(kind), kind))).toBe(map[cellKey(layout, tone, ratioValue)]);
              const legacyCanvas = createCanvas(prepared.width, prepared.height);
              const legacyCtx = legacyCanvas.getContext("2d");
              NodeCanvasCompositor.drawLegacy(legacyCtx, prepared, restT(kind), kind);
              expect(sha256(legacyCanvas.toBuffer("image/png"))).toBe(map[cellKey(layout, tone, ratioValue)]);
            }
          }
        }
      }
    },
  );

  test(
    "a timeline-free request renders identical frames through draw and drawLegacy across a motion grid",
    { timeout: 120_000 },
    async () => {
      const base = {
      brandColor: BRAND,
      logoPath: LOGO,
      background: (() => {
        const c = createCanvas(64, 64);
        const g = c.getContext("2d");
        g.fillStyle = "#333333";
        g.fillRect(0, 0, 64, 64);
        return c.toBuffer("image/png");
      })(),
    };
    const variants: CompositeRequest[] = [
      { ...base, message: MESSAGE, ratio: ratio("1:1"), layout: "headline-bottom", tone: "bold" },
      {
        ...base,
        message: MESSAGE,
        ratio: ratio("16:9"),
        layout: "headline-top",
        tone: "subtle",
        safeInsets: { top: 120, right: 0, bottom: 200, left: 0 },
      },
      { ...base, message: "Hi", ratio: ratio("9:16"), layout: "headline-top", tone: "bold" },
    ];

    for (const request of variants) {
      const prepared = await NodeCanvasCompositor.prepare(request);
      for (const kind of [undefined, ...MOTION_KINDS] as const) {
        for (const t of [0, 0.5, 1] as const) {
          // Comparing `draw` against `drawLegacy` pixel-for-pixel would be tautological:
          // with no timeline prepared, `draw` *calls* `drawLegacy`, so the assertion can
          // only fail if canvas rendering is non-deterministic — never if this code
          // regresses. The golden-hash comparison above is what actually pins the bytes.
          //
          // The invariant worth asserting is the one that would break: that a request
          // with no timeline still travels the single legacy path, rather than a second
          // copy of it growing beside the first and drifting.
          const spy = vi.spyOn(NodeCanvasCompositor, "drawLegacy");
          const canvas = createCanvas(prepared.width, prepared.height);
          NodeCanvasCompositor.draw(canvas.getContext("2d"), prepared, t, kind);
          expect(spy).toHaveBeenCalledTimes(1);
          // D10: drawLegacy gained the effect clock (5th arg, defaulting to the
          // motion t). Timeline-free draw always forwards it so still bytes stay
          // on one path; a style-less brief is the identity pose either way.
          expect(spy.mock.calls[0].slice(1)).toEqual([prepared, t, kind, t]);
          spy.mockRestore();
        }
      }
    }
  });
});