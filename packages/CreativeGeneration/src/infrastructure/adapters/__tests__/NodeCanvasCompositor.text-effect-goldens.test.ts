import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import {
  AspectRatio,
  TEXT_EFFECT_VALUES,
  type CompositeRequest,
  type CopyTimeline,
  type TextEffectKind,
} from "@campaignfoundry/CampaignOrchestration";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import {
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
 * Text-effect goldens (K3 gap, found by a reviewer and by K3's own mutation
 * manifest after K3 shipped): K3's own gate claimed "per-frame byte-identity
 * for every text effect across the canonical templates", but no golden suite
 * ever set `prepared.textEffect` — `NodeCanvasCompositor.motion-goldens.test.ts`
 * (the 48 motion cells), `CanvasFfmpegVideoCompositor.byte-golden.test.ts` (the
 * mp4 byte golden) and `NodeCanvasCompositor.layer-order.test.ts` (the HL3
 * raster suite) all leave `style.textEffect` unset. K3's own mutation manifest
 * proved this empirically: neither of its two mutations moved a byte golden,
 * only the domain equivalence test and the drawn-output (`toBe`-pose) suite
 * caught them. This suite closes that gap: one cell per
 * (effect, draw path, frame) — the ones K3's mutations should now move too.
 *
 * Four `TEXT_EFFECT_VALUES` × two draw paths × two frames (`entrance`: inside
 * the entrance window, `settled`: past it) = 16 cells, on one canonical
 * template (the `image-text` layer set `prepare` falls back to when no
 * `template` is supplied — the same default every other golden suite here
 * uses).
 *
 * The `legacy` path is the CLIP shape with no timeline at all —
 * `draw(ctx, prepared, t, undefined)` — so `effectT` falls back to `t`
 * (K-D8's legacy unification, `effectT ?? t`). The `timeline` path is the
 * CLIP shape too, but with a real two-beat `cut` timeline (unequal weight,
 * mirroring `motion-goldens.test.ts`'s own `TIMELINE`) and `effectT` left
 * UNDEFINED — `draw(ctx, prepared, t, undefined)`, nothing else — so the
 * effect clock falls back to the beat-LOCAL progress `resolveTracks` computes
 * internally (`effectT ?? local`), not to a caller-supplied clock. Both
 * `entrance` and `settled` sample the SECOND beat's own window (`t` derived
 * from `prepared.timeline[1]`'s `startT`/`endT` at runtime, the way
 * `motion-goldens.test.ts` derives its own poster `copyT`), so a mutation
 * that only breaks the beat-local fallback — as opposed to an explicit
 * `effectT` — has somewhere to be caught, and the two draw paths paint
 * different beat text (proof, on the raster itself, that the timeline path
 * was actually taken, not merely that some hash was computed).
 *
 * Recorded from `origin/main` (pre-K3, `textEffectPose`'s own switch) as the
 * baseline, per the PR body: these bytes prove K3's expansion did not move a
 * single pixel on either draw path, not merely that K3's own code produces
 * internally consistent numbers.
 */

const EFFECT = CREATIVE_GEOMETRY.textEffect;
/**
 * Half the entrance window, as a LOCAL progress in [0, 1] — the legacy path's
 * `t` (its own local, since `effectT ?? t`) and the timeline path's fraction
 * of the second beat's own span (its own local, via `effectT ?? local`) mean
 * the same thing here: both paths sample the same local progress.
 */
const LOCAL_ENTRANCE = EFFECT.entranceFraction / 2;
/** Past the entrance window, on either path's own local clock. */
const LOCAL_SETTLED = 1;

/** 4 effects × 2 draw paths × 2 frames (entrance, settled). */
export const TEXT_EFFECT_GOLDEN_CELL_COUNT = 16;

const MESSAGE_LEGACY = "Stay wild, stay hydrated";
const BRAND = "#1473E6";
const LOGO = "assets/inputs/hydra-logo.png";

const ratio = () => {
  const r = AspectRatio.create("1:1");
  if (!r.success) throw r.error;
  return r.value;
};

// A gradient, not a flat fill (matching motion-goldens.test.ts's own reason):
// a solid colour is invariant under some effects' composed alpha, so a
// gradient is what actually shows a pose difference on the raster.
const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#1473E6");
  grad.addColorStop(1, "#F4C400");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

const baseRequest = (textEffect: TextEffectKind): CompositeRequest => ({
  background: background(),
  message: MESSAGE_LEGACY,
  brandColor: BRAND,
  logoPath: LOGO,
  canvas: { ratio: ratio().value },
  layout: "headline-bottom",
  tone: "bold",
  style: { textEffect },
});

// Unequal weight (2:1), like motion-goldens.test.ts's own TIMELINE, so the
// second beat's window is not a trivial half-split.
const TIMELINE: CopyTimeline = {
  beats: [
    { text: "Stay wild", weight: 2 },
    { text: "stay hydrated", weight: 1 },
  ],
  transition: "cut",
  keyBeat: 1,
};

type TimelineRequest = CompositeRequest & {
  readonly durationSec: number;
  readonly timeline: CopyTimeline;
};

const timelineRequest = (textEffect: TextEffectKind): TimelineRequest => ({
  ...baseRequest(textEffect),
  durationSec: 6,
  timeline: TIMELINE,
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The legacy (timeline-less) CLIP path: `t` drives pose, copy (there is none)
 * and effect together; `effectT` is omitted, so it falls back to `t`
 * (`effectT ?? t`, the legacy unification).
 */
async function legacyFrame(effect: TextEffectKind, t: number): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(baseRequest(effect));
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, undefined);
  return canvas.toBuffer("image/png");
}

/**
 * The timeline CLIP path, sampled inside the SECOND beat's own window: `t`
 * drives pose, copy (`copyT ?? t` selects the beat) and effect together, with
 * `effectT` OMITTED — the effect clock falls back to the beat-local progress
 * `resolveTracks` computes internally (`effectT ?? local`), which is the
 * fallback K1b/K3 actually added, not a caller-supplied settled clock.
 */
async function timelineFrame(effect: TextEffectKind, windowFraction: number): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(timelineRequest(effect));
  const timeline = prepared.timeline;
  if (timeline === undefined) {
    throw new Error("expected prepare() to resolve a timeline for this request");
  }
  const secondBeat = timeline[1];
  if (secondBeat === undefined) {
    throw new Error("expected a second beat in the resolved timeline");
  }
  const t = secondBeat.startT + (secondBeat.endT - secondBeat.startT) * windowFraction;
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, undefined);
  return canvas.toBuffer("image/png");
}

const cellKey = (
  effect: TextEffectKind,
  path: "legacy" | "timeline",
  frame: "entrance" | "settled",
) => `${effect}/${path}/${frame}`;

const fixturesDir =
  process.env.COMPOSITOR_GOLDEN_FIXTURE_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldensPath = join(fixturesDir, "compositor-goldens-text-effect.json");
const fixture = JSON.parse(readFileSync(goldensPath, "utf8")) as GoldenFixture;

const finishGolden = (key: string, observed: Record<string, string>, run: GoldenRun): void => {
  if (run.kind === "record") {
    recordGoldenMap(goldensPath, key, observed, TEXT_EFFECT_GOLDEN_CELL_COUNT);
    return;
  }
  expect(observed).toEqual(run.map);
};

describe("NodeCanvasCompositor text-effect goldens (K3 gap)", () => {
  const key = compositorGoldenKey();
  const recording = isRecordingGoldens();
  const goldens = resolveGoldenMap(fixture, key);
  const missingMessage = missingGoldenMapMessage(key, goldenPlatformKeys(fixture), {
    fixtureFile: "compositor-goldens-text-effect.json",
    cellsHint: `${TEXT_EFFECT_GOLDEN_CELL_COUNT} sha256 cells (four text effects × two draw paths × an entrance and a settled frame)`,
  });

  test("each text effect's entrance and settled frames match the committed matrix, per path (K3)", async () => {
    const run = goldenRun(goldens, recording, missingMessage);
    const observed: Record<string, string> = {};
    for (const effect of TEXT_EFFECT_VALUES) {
      observed[cellKey(effect, "legacy", "entrance")] = sha256(
        await legacyFrame(effect, LOCAL_ENTRANCE),
      );
      observed[cellKey(effect, "legacy", "settled")] = sha256(
        await legacyFrame(effect, LOCAL_SETTLED),
      );
      observed[cellKey(effect, "timeline", "entrance")] = sha256(
        await timelineFrame(effect, LOCAL_ENTRANCE),
      );
      observed[cellKey(effect, "timeline", "settled")] = sha256(
        await timelineFrame(effect, LOCAL_SETTLED),
      );
    }
    finishGolden(key, observed, run);
  });
});
