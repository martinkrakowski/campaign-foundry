import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  AspectRatio,
  resolveTimeline,
  type CompositeRequest,
  type CopyTimeline,
  type MotionKind,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

type TimelineRequest = CompositeRequest & { readonly durationSec?: number; readonly timeline?: CopyTimeline };

const request = (over: Partial<CompositeRequest> = {}): TimelineRequest => ({
  background: background(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  ratio: ratio("1:1"),
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

const copyTimeline = (
  beats: readonly { readonly text: string; readonly weight?: number }[],
  over: Partial<CopyTimeline> = {},
): CopyTimeline => ({
  beats: beats.map((beat) => ({ text: beat.text, weight: beat.weight ?? 1 })),
  transition: "cut",
  keyBeat: 1,
  ...over,
});

/** Present a value or fail the test — matches the repo's defensive-throw style. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

interface TextOp {
  text: string;
  alpha: number;
  dy: number;
  font: string;
}

/** Draw one frame and record what copy was painted (text, alpha, rise offset, type style). */
async function timelineSpy(req: TimelineRequest, t: number, motion?: MotionKind, copyT?: number) {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  const texts: TextOp[] = [];
  // Mirror the canvas transform stack instead of recording the last translate. The copy
  // path translates only when it has an offset or an alpha to apply, so a spy that stored
  // the last y would attribute the background's ken-burns recentre (-height / 2, inside a
  // save/restore) to any beat painted opaque and un-risen.
  let dy = 0;
  const dyStack: number[] = [];
  const origFill = ctx.fillText.bind(ctx);
  const origTranslate = ctx.translate.bind(ctx);
  const origSave = ctx.save.bind(ctx);
  const origRestore = ctx.restore.bind(ctx);
  ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
    texts.push({ text, alpha: ctx.globalAlpha, dy, font: ctx.font });
    return origFill(text, x, y, maxWidth);
  }) as typeof ctx.fillText;
  ctx.translate = ((x: number, y: number) => {
    dy += y;
    return origTranslate(x, y);
  }) as typeof ctx.translate;
  ctx.save = (() => {
    dyStack.push(dy);
    return origSave();
  }) as typeof ctx.save;
  ctx.restore = (() => {
    dy = dyStack.pop() ?? 0;
    return origRestore();
  }) as typeof ctx.restore;
  NodeCanvasCompositor.draw(ctx, prepared, t, motion, copyT);
  return { prepared, texts };
}

interface LogoFrame {
  /** [x, y, width, height] of the final drawImage (the brand logo). */
  position: readonly [number, number, number, number];
  prepared: Awaited<ReturnType<typeof NodeCanvasCompositor.prepare>>;
}

/** Draw one frame and capture the final drawImage (the brand logo) plus its prepared geometry. */
async function logoFrame(req: TimelineRequest, copyT: number): Promise<LogoFrame> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  let position: LogoFrame["position"] | undefined;
  const origDraw = ctx.drawImage.bind(ctx);
  ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
    position = [Number(args[1]), Number(args[2]), Number(args[3]), Number(args[4])];
    return origDraw(...args);
  }) as typeof ctx.drawImage;
  NodeCanvasCompositor.draw(ctx, prepared, 0.5, undefined, copyT);
  if (!position) throw new Error("missing drawImage blit");
  return { position, prepared };
}

const SHORT = "Hi";
const LONG =
  "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today and tomorrow";

describe("NodeCanvasCompositor sequenced copy (copy.timeline)", () => {
  test("prepares one layout per distinct beat text, at a common type size (D6), with the key beat as the anchor", async () => {
    const insets = { top: 480, right: 0, bottom: 480, left: 0 };
    const base = request({ safeInsets: insets });
    const pReq = { ...base, durationSec: 8, timeline: copyTimeline([{ text: SHORT }, { text: LONG }], { keyBeat: 2 }) };

    const singleShort = await NodeCanvasCompositor.prepare({
      ...base,
      durationSec: 8,
      timeline: copyTimeline([{ text: SHORT }]),
    });
    const singleLong = await NodeCanvasCompositor.prepare({
      ...base,
      durationSec: 8,
      timeline: copyTimeline([{ text: LONG }]),
    });
    const pair = await NodeCanvasCompositor.prepare(pReq);

    const shortAlone = must(singleShort.beatLayouts, "single-short beatLayouts").get(SHORT);
    const longAlone = must(singleLong.beatLayouts, "single-long beatLayouts").get(LONG);
    if (!shortAlone || !longAlone) throw new Error("missing natural layout");

    // SHORT fits at its natural size; LONG must shrink on this deep-inset cell.
    expect(shortAlone.fontSize).toBe(Math.round(1080 * 0.06));
    expect(longAlone.fontSize).toBeLessThan(shortAlone.fontSize);

    // D6: the sequence is laid at the LONG text's smaller natural size — SHORT
    // steps down to it, never up, and nobody re-fits per frame.
    const pairLayouts = must(pair.beatLayouts, "pair beatLayouts");
    expect(pairLayouts.size).toBe(2);
    const pairShort = must(pairLayouts.get(SHORT), "pair SHORT");
    const pairLong = must(pairLayouts.get(LONG), "pair LONG");
    expect(pairShort.fontSize).toBe(longAlone.fontSize);
    expect(pairLong.fontSize).toBe(longAlone.fontSize);
    expect(pair.anchorLayout).toBe(pairLayouts.get(LONG));

    // AND draw blits both beats at that common type size, never the naturals.
    const resolved = must(pair.timeline, "pair timeline");
    for (let i = 0; i < resolved.length; i += 1) {
      const mid = (resolved[i].startT + resolved[i].endT) / 2;
      const painted = await timelineSpy(pReq, 0.5, undefined, mid);
      expect(painted.texts.length).toBeGreaterThan(0);
      for (const op of painted.texts) {
        expect(op.font).toContain(`${longAlone.fontSize}px`);
      }
    }
  });

  test("memoizes layouts by text so a repeated beat shares its layout (D9)", async () => {
    const insets = { top: 480, right: 0, bottom: 480, left: 0 };
    const timeline = copyTimeline([{ text: LONG }, { text: SHORT }, { text: LONG }], { keyBeat: 2 });
    const pReq = { ...request({ safeInsets: insets, message: LONG }), durationSec: 8, timeline };
    const prepared = await NodeCanvasCompositor.prepare(pReq);
    const layouts = must(prepared.beatLayouts, "beatLayouts");
    expect(layouts.size).toBe(2);

    // Every window renders its own memoized text; a repeated beat reuses one layout
// (a wrapped beat paints one fillText per line — exactly the layout's lines).
    const resolved = must(prepared.timeline, "timeline");
    for (const beat of resolved) {
      const mid = (beat.startT + beat.endT) / 2;
      const painted = await timelineSpy(pReq, mid, undefined, mid);
      const layout = must(must(painted.prepared.beatLayouts, "beatLayouts").get(beat.text), `${beat.text} layout`);
      expect(painted.texts.map((op) => op.text)).toEqual(layout.lines);
      for (const op of painted.texts) {
        expect(op.font).toContain(`${layout.fontSize}px`);
      }
    }
  });

  test("a timeline without durationSec never resolves, so stills stay on the legacy path (D10)", async () => {
    const prepared = await NodeCanvasCompositor.prepare({
      ...request(),
      timeline: copyTimeline([{ text: SHORT }, { text: LONG }]),
    });
    expect(prepared.timeline).toBeUndefined();
    expect(prepared.beatLayouts).toBeUndefined();
    expect(prepared.anchorLayout).toBeUndefined();

    const canvas = createCanvas(prepared.width, prepared.height);
    const legacy = createCanvas(prepared.width, prepared.height);
    NodeCanvasCompositor.draw(canvas.getContext("2d"), prepared, 1);
    NodeCanvasCompositor.drawLegacy(legacy.getContext("2d"), prepared, 1);
    expect(canvas.toBuffer("image/png").equals(legacy.toBuffer("image/png"))).toBe(true);
  });

  test("prepare throws for an empty beat list — the compositor cannot fit nothing", async () => {
    await expect(
      NodeCanvasCompositor.prepare({
        ...request(),
        durationSec: 8,
        timeline: copyTimeline([]),
      }),
    ).rejects.toThrow(/empty copy\.timeline/);
  });

  test("selects the beat by the copy clock (copyT) when it is given (D2)", async () => {
    const timeline: CopyTimeline = copyTimeline(
      [{ text: "Alpha" }, { text: "Beta" }, { text: "Gamma" }],
      { keyBeat: 2 },
    );
    const durationSec = 8;
    const req = { ...request(), durationSec, timeline };
    const resolved = resolveTimeline(timeline, durationSec);

    for (let i = 0; i < resolved.length; i += 1) {
      const mid = (resolved[i].startT + resolved[i].endT) / 2;
      const painted = await timelineSpy(req, 0.5, undefined, mid);
      expect(painted.texts).toEqual([expect.objectContaining({ text: resolved[i].text })]);
    }
  });

  test("falls back to the pose clock for copy when no copyT is given, frame by frame", async () => {
    const timeline: CopyTimeline = copyTimeline([{ text: "Alpha" }, { text: "Beta" }, { text: "Gamma" }]);
    const durationSec = 8;
    const req = { ...request(), durationSec, timeline };
    const resolved = resolveTimeline(timeline, durationSec);

    // Equal weights → windows [0,1/3) [1/3,2/3) [2/3,1]; t = 0.55 sits in Beta.
    const painted = await timelineSpy(req, 0.55, undefined);
    expect(painted.texts).toEqual([expect.objectContaining({ text: resolved[1].text })]);
  });

  test("crossfades between beats over a fade window: current at 1-mix, incoming at mix", async () => {
    const timeline: CopyTimeline = copyTimeline(
      [{ text: "Alpha", weight: 2 }, { text: "Beta", weight: 3 }],
      { transition: "fade", keyBeat: 1 },
    );
    const durationSec = 5;
    const req = { ...request(), durationSec, timeline };
    const resolved = resolveTimeline(timeline, durationSec);
    const copyT = resolved[1].startT + resolved[1].fadeInT * 0.25;

    const painted = await timelineSpy(req, copyT, "ken-burns-in", copyT);
    // Stage alpha is stored 8-bit on the canvas backend, so compare with tolerance.
    expect(painted.texts.map((op) => op.text)).toEqual([resolved[0].text, resolved[1].text]);
    expect(painted.texts[0]?.alpha).toBeCloseTo(0.75, 2);
    expect(painted.texts[1]?.alpha).toBeCloseTo(0.25, 2);
    expect(painted.texts[0]?.dy).toBe(0);
    expect(painted.texts[1]?.dy).toBe(0);
  });

  test("an opaque un-risen beat is painted at zero offset under a zooming background", async () => {
    // ken-burns zooms the background inside a save/restore, and a cut transition paints the
    // beat at layerAlpha 1 with no rise — so the copy path skips its own translate entirely.
    // Whatever this reports is the transform the text was actually painted under.
    const timeline: CopyTimeline = copyTimeline(
      [{ text: "Alpha", weight: 2 }, { text: "Beta", weight: 3 }],
      { transition: "cut", keyBeat: 1 },
    );
    const durationSec = 5;
    const req = { ...request(), durationSec, timeline };

    const painted = await timelineSpy(req, 0.6, "ken-burns-in", 0.6);
    expect(painted.texts).toHaveLength(1);
    expect(painted.texts[0]?.alpha).toBe(1);
    expect(painted.texts[0]?.dy).toBe(0);
  });

  test("a cut transition never crossfades, even mid-window", async () => {
    const timeline: CopyTimeline = copyTimeline(
      [{ text: "Alpha", weight: 2 }, { text: "Beta", weight: 3 }],
      { keyBeat: 1 },
    );
    const durationSec = 5;
    const req = { ...request(), durationSec, timeline };
    const resolved = resolveTimeline(timeline, durationSec);
    const cutPoint = resolved[0].startT + (resolved[0].endT - resolved[0].startT) / 2;

    const painted = await timelineSpy(req, cutPoint, "ken-burns-in", cutPoint);
    expect(painted.texts).toEqual([expect.objectContaining({ text: resolved[0].text, alpha: 1 })]);
  });

  test("headline-rise advances each beat on its own window, not the whole clip (Q1)", async () => {
    const timeline: CopyTimeline = copyTimeline([{ text: "Alpha" }, { text: "Beta" }, { text: "Gamma" }]);
    const durationSec = 6;
    const req = { ...request(), durationSec, timeline };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const resolved = must(prepared.timeline, "timeline");

    // At exactly Beta's start (t = 1/3), its local progress is 0: the beat must be
    // un-risen. A rise driven against the whole clip would already be ~0.703 here.
    const start = await timelineSpy(req, resolved[1].startT, "headline-rise", resolved[1].startT);
    expect(start.texts.map((op) => op.text)).toEqual(["Beta"]);
    expect(start.texts[0]?.alpha).toBe(0);
    expect(start.texts[0]?.dy).toBe(0.12 * prepared.height);

    // A quarter into Beta's own window, the rise is easeOutCubic(0.25) ≈ 0.578 —
    // sensitivity to stage-alpha rounding aside, nowhere near the clip-fraction.
    const mid = resolved[1].startT + (resolved[1].endT - resolved[1].startT) / 4;
    const quarter = await timelineSpy(req, mid, "headline-rise", mid);
    const local = (mid - resolved[1].startT) / (resolved[1].endT - resolved[1].startT);
    const eased = 1 - (1 - local) ** 3;
    expect(quarter.texts[0]?.alpha).toBeCloseTo(eased, 1);
    expect(quarter.texts[0]?.dy).toBeCloseTo((1 - eased) * 0.12 * prepared.height, 3);
  });

  test("the logo rests against the key beat's layout on every frame (D7 anchor)", async () => {
    // headline-top / 16:9 / deep-but-narrow insets: the LONG beat's block reaches
    // the bottom-logo band while SHORT clears it — so the anchor decides whether
    // the snap fires, and the logo cannot move just because the on-screen beat did.
    const insets = { top: 200, right: 0, bottom: 50, left: 0 };
    const r = ratio("16:9");
    const durationSec = 8;
    const keyedLong = {
      ...request({ layout: "headline-top", ratio: r, safeInsets: insets }),
      durationSec,
      timeline: copyTimeline([{ text: SHORT }, { text: LONG }], { keyBeat: 2 }),
    };
    const keyedShort = {
      ...request({ layout: "headline-top", ratio: r, safeInsets: insets }),
      durationSec,
      timeline: copyTimeline([{ text: SHORT }, { text: LONG }], { keyBeat: 1 }),
    };
    const resolved = resolveTimeline(keyedLong.timeline, durationSec);

    const longWindow = await logoFrame(keyedLong, (resolved[1].startT + resolved[1].endT) / 2);
    const shortWindow = await logoFrame(keyedLong, (resolved[0].startT + resolved[0].endT) / 2);
    const shortKey = await logoFrame(keyedShort, (resolved[0].startT + resolved[0].endT) / 2);

    // The key beat's (LONG) box overlaps the logo line, so the snap fires and the
    // logo is nailed to the opposite flush edge — identically in every beat window.
    const preparedLogo = must(shortWindow.prepared.logo, "prepared logo");
    expect(longWindow.position).toEqual(shortWindow.position);
    expect(shortWindow.position[1]).toBe(r.height - insets.bottom - preparedLogo.height);

    // With the SHORT beat as the key, its smaller box clears the logo band and the
    // legacy in-place geometry stands — same windows, different anchor (D7).
    const shortPrepared = must(shortKey.prepared.logo, "short-key prepared logo");
    expect(shortKey.position).toEqual([shortPrepared.x, shortPrepared.y, shortPrepared.width, shortPrepared.height]);
    expect(shortKey.position[1]).not.toBe(r.height - insets.bottom - shortPrepared.height);
  });

  test("the draw throws when a beat has no fitted layout (an invariant break is loud)", async () => {
    const timeline: CopyTimeline = copyTimeline([{ text: "Alpha" }, { text: "Beta" }], { keyBeat: 1 });
    const durationSec = 8;
    const req = { ...request(), durationSec, timeline };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const layouts = must(prepared.beatLayouts, "beatLayouts");
    (layouts as Map<string, unknown>).delete("Beta");

    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    expect(() => NodeCanvasCompositor.draw(ctx, prepared, 0.5, undefined, 0.5)).toThrow(
      /no fitted layout for beat "Beta"/,
    );
  });

  test("a beat renders without a brand logo (the logo layer is optional)", async () => {
    const timeline: CopyTimeline = copyTimeline([{ text: "Alpha" }, { text: "Beta" }], { keyBeat: 1 });
    const durationSec = 8;
    const req = { ...request({ logoPath: undefined }), durationSec, timeline };

    const painted = await timelineSpy(req, 0.3, undefined, 0.3);
    expect(painted.prepared.logo).toBeUndefined();
    expect(painted.texts).toEqual([expect.objectContaining({ text: "Alpha" })]);
  });

  test("accent-wipe starts from a clean solid band at t=0: the fade rect is withheld", async () => {
    const timeline: CopyTimeline = copyTimeline([{ text: "Alpha" }], { keyBeat: 1 });
    const durationSec = 5;
    const req = { ...request({ layout: "headline-top" }), durationSec, timeline };

    const paintedZero = await timelineSpy(req, 0, "accent-wipe", 0);
    expect(paintedZero.texts).toEqual([expect.objectContaining({ text: "Alpha", alpha: 1 })]);
    // At t=0 the eased wipe is 0, so accent paint omits the gradient-fade rect:
    // the frame paints fewer rectangles than a half-wiped (or complete) one.
    expect(await countRects(req, 0)).toBeLessThan(await countRects(req, 0.5));
  });
});

/** Rebuild the request, spy on fillRect, and return how many rectangles the frame painted. */
async function countRects(req: TimelineRequest, t: number): Promise<number> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const canvas = createCanvas(prepared.width, prepared.height);
  const ctx = canvas.getContext("2d");
  let rects = 0;
  const origFillRect = ctx.fillRect.bind(ctx);
  ctx.fillRect = ((...args: Parameters<typeof ctx.fillRect>) => {
    rects += 1;
    return origFillRect(...args);
  }) as typeof ctx.fillRect;
  NodeCanvasCompositor.draw(ctx, prepared, t, "accent-wipe", t);
  return rects;
}
describe("a key beat outside the timeline fails by name", () => {
  test("prepare says which index is wrong instead of throwing a bare TypeError", async () => {
    // The parser rejects an out-of-range keyBeat, so this cannot arrive through the
    // pipeline — but a direct adapter call can carry one, and indexing past the end used
    // to throw from deep inside the canvas work, several frames from the actual cause.
    const bad: TimelineRequest = {
      ...request(),
      timeline: copyTimeline([{ text: "one" }, { text: "two" }], { keyBeat: 5 }),
      durationSec: 6,
    };
    await expect(NodeCanvasCompositor.prepare(bad)).rejects.toThrow(/keyBeat is 5, outside \[1, 2\]/);
  });
});
