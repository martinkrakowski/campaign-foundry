import { describe, test, expect } from "vitest";
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
  type CopyTimeline,
  type LayoutKind,
  type MotionKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { ProceduralBackgroundGenerator } from "../ProceduralBackgroundGenerator.js";
import {
  MOTION_GOLDEN_CELL_COUNT,
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

/**
 * Motion goldens (C1 / R-D6). `NodeCanvasCompositor.goldens.test.ts` hashes
 * only the still PNG and the restT-equals-still frame for every
 * `MOTION_KINDS` value — it never draws a moving frame through the timeline
 * path. So D10's "frozen motion bytes" was frozen by assertion only; these
 * cells are the first thing that actually measures them.
 *
 * Recorded here, against the UNMODIFIED compositor, before C1 changes
 * `drawTimeline` to iterate `prepared.layers` for the ground trio instead of
 * calling `drawLayer("image"/"shade"/"accent", ...)` by name. With no
 * `template` ever passed to the port (that wiring is C3, deliberately after
 * this lane), `resolveLayerList` always falls through to
 * `CANONICAL_TEMPLATES["image-text"]`, whose layers are already
 * image → shade → accent → static-text → logo — the exact order the by-name
 * calls produced. So the refactor cannot move a pixel, and these hashes must
 * be identical before and after it.
 *
 * Two draw shapes, matching the only two ways production ever calls a motion
 * frame (`CanvasFfmpegVideoCompositor`):
 *  - "clip": `t` drives pose, copy and effect together —
 *    `draw(ctx, prepared, t, kind)`, sampled across the whole clock.
 *  - "poster": the rest pose, with the key beat's own mid-window copy clock
 *    and a settled effect clock — `draw(ctx, prepared, restT(kind), kind,
 *    copyT, 1)`. This is the one shape `goldens.test.ts` never exercises
 *    (its restT check passes no `copyT`/`effectT`), and it is the shape that
 *    feeds `effectT` into the ground layers' draw context explicitly.
 */

const LAYOUTS: readonly LayoutKind[] = ["headline-bottom", "headline-top"];
/** Samples across the whole clock; every kind's restT is 0 or 1, already inside this set. */
const CLIP_TS = [0, 0.25, 0.5, 0.75, 1];

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

// Two beats, unequal weight (Q1: 2/1) so no CLIP_TS sample lands exactly on
// the beat boundary — "cut" never crossfades (mix stays 0), but the split
// still governs which beat's copy layer paints at a given `t`.
const TIMELINE: CopyTimeline = {
  beats: [
    { text: "Stay wild", weight: 2 },
    { text: "stay hydrated", weight: 1 },
  ],
  transition: "cut",
  keyBeat: 1,
};
const DURATION_SEC = 6;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const clipKey = (layout: LayoutKind, kind: MotionKind, t: number) =>
  `${layout}/${kind}/clip/${t.toFixed(2)}`;
const posterKey = (layout: LayoutKind, kind: MotionKind) => `${layout}/${kind}/poster`;

const fixturesDir =
  process.env.COMPOSITOR_GOLDEN_FIXTURE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldensPath = join(fixturesDir, "compositor-goldens-motion.json");
const fixture = JSON.parse(readFileSync(goldensPath, "utf8")) as GoldenFixture;

const finishGolden = (key: string, observed: Record<string, string>, run: GoldenRun): void => {
  if (run.kind === "record") {
    recordGoldenMap(goldensPath, key, observed, MOTION_GOLDEN_CELL_COUNT);
    return;
  }
  expect(observed).toEqual(run.map);
};

describe("NodeCanvasCompositor motion goldens (C1)", () => {
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(fixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(fixture), {
    fixtureFile: "compositor-goldens-motion.json",
    cellsHint: `${MOTION_GOLDEN_CELL_COUNT} sha256 cells (both layouts × ${MOTION_KINDS.length} motion kinds × five clip samples + the poster frame)`,
  });

  test(
    "the timeline path's motion frames match the committed matrix, per kind and t (D10/R-D6)",
    // 2 layouts × 4 kinds × 6 full-size rasters: comfortably over the 5 s default.
    { timeout: 120_000 },
    async () => {
      const run = goldenRun(goldens, recording, missingMessage);
      const backgrounds = new ProceduralBackgroundGenerator();
      const r = ratio("1:1");
      const bg = await backgrounds.resolveBackground(product, r, bgCtx);

      const observed: Record<string, string> = {};
      for (const layout of LAYOUTS) {
        const request: CompositeRequest & { durationSec: number; timeline: CopyTimeline } = {
          background: bg.image,
          message: MESSAGE,
          brandColor: BRAND,
          logoPath: LOGO,
          canvas: { ratio: "1:1" },
          layout,
          tone: "bold",
          durationSec: DURATION_SEC,
          timeline: TIMELINE,
        };
        const prepared = await NodeCanvasCompositor.prepare(request);
        const timeline = prepared.timeline;
        if (timeline === undefined) {
          throw new Error("expected prepare() to resolve a timeline for this request");
        }
        const keyBeat = timeline[TIMELINE.keyBeat - 1];
        const posterCopyT = (keyBeat.startT + keyBeat.endT) / 2;
        const canvas = createCanvas(prepared.width, prepared.height);
        const ctx = canvas.getContext("2d");

        for (const kind of MOTION_KINDS) {
          for (const t of CLIP_TS) {
            NodeCanvasCompositor.draw(ctx, prepared, t, kind);
            observed[clipKey(layout, kind, t)] = sha256(canvas.toBuffer("image/png"));
          }
          // The poster shape (D7): rest pose, key-beat mid-window copy clock,
          // settled effect clock — the one call shape goldens.test.ts never
          // exercises.
          NodeCanvasCompositor.draw(ctx, prepared, restT(kind), kind, posterCopyT, 1);
          observed[posterKey(layout, kind)] = sha256(canvas.toBuffer("image/png"));
        }
      }
      finishGolden(key, observed, run);
    },
  );
});
