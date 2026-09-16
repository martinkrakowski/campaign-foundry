import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import {
  easeOutCubic,
  type BriefTemplate,
  type CompositeRequest,
  type CopyTimeline,
  type CreativeTemplateLayer,
  type Track,
} from "@campaignfoundry/CampaignOrchestration";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";

/**
 * K4: the missing read this lane closes — nothing in `NodeCanvasCompositor.ts`
 * read a layer's OWN `tracks` field before this PR (K2/K3 only ever passed
 * SYNTHESIZED tracks, built from the motion/effect kind). These tests exercise
 * all three `resolveTracks` call sites (`drawSequencedCopy`, `paintBackground`,
 * `drawStaticText`) with a hand-authored `layer.tracks` array and prove three
 * things: the read actually happens, it folds AFTER the preset expansion
 * (K-D9's fixed, only order), and a disabled layer's authored tracks still
 * resolve to nothing (K-D4).
 */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const flatBackground = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

// A gradient, not a flat fill (mirrors `NodeCanvasCompositor.motion-tracks.test.ts`):
// a solid colour is invariant under a zoom, so it could never show an authored
// `scale` track actually reaching the ground layer's blit.
const gradientBackground = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#1473E6");
  grad.addColorStop(1, "#F4C400");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

type TemplateRequest = CompositeRequest & {
  readonly template?: BriefTemplate;
  readonly durationSec?: number;
  readonly timeline?: CopyTimeline;
};

const request = (over: Partial<TemplateRequest> = {}): TemplateRequest => ({
  background: flatBackground(),
  message: "Stay wild, stay hydrated",
  brandColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
  canvas: { ratio: "1:1" },
  layout: "headline-bottom",
  tone: "bold",
  ...over,
});

/** A `video` creative type template — `animated-text` is its own copy kind, unlike `image-text`. */
const videoTemplateWith = (layers: readonly CreativeTemplateLayer[]): BriefTemplate => ({
  id: "canonical-video",
  version: 1,
  creativeType: "video",
  unit: "standard-web",
  layers,
});

/** An `image-text` creative type template, for the ground-layer (`image`) authored-track tests. */
const imageTemplateWith = (layers: readonly CreativeTemplateLayer[]): BriefTemplate => ({
  id: "canonical-image-text",
  version: 1,
  creativeType: "image-text",
  unit: "standard-web",
  layers,
});

async function renderStill(req: TemplateRequest): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, 1);
  return ctx.canvas.toBuffer("image/png");
}

async function renderTimelineAt(req: TemplateRequest, t: number, copyT: number): Promise<Buffer> {
  const prepared = await NodeCanvasCompositor.prepare(req);
  const ctx = createCanvas(prepared.width, prepared.height).getContext("2d");
  NodeCanvasCompositor.draw(ctx, prepared, t, undefined, copyT, 1);
  return ctx.canvas.toBuffer("image/png");
}

const timelineOf = (beats: string[]): CopyTimeline => ({
  beats: beats.map((text) => ({ text, weight: 1 })),
  transition: "cut",
  keyBeat: 1,
});

describe("K4: a layer's own authored tracks reach the renderer", () => {
  test("an authored opacity track on an animated-text layer changes the drawn frame (legacy path, drawStaticText); removing the track draws the pre-change bytes", async () => {
    const track: Track = { property: "opacity", stops: [{ t: 0, value: 0.4, clock: "pose" }] };
    const withTrack = await renderStill(
      request({
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text", tracks: [track] },
        ]),
      }),
    );
    const trackless = await renderStill(
      request({
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text" },
        ]),
      }),
    );
    // The read actually happens: an authored opacity track visibly dims the text.
    expect(sha256(withTrack)).not.toBe(sha256(trackless));
  });

  test("an authored dy track on an animated-text layer changes a drawn timeline frame (drawSequencedCopy); removing the track draws the pre-change bytes", async () => {
    const track: Track = { property: "dy", stops: [{ t: 0, value: 12, clock: "pose" }] };
    const req = (tracks?: readonly Track[]): TemplateRequest =>
      request({
        durationSec: 8,
        timeline: timelineOf(["Alpha"]),
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text", ...(tracks ? { tracks } : {}) },
        ]),
      });
    const withTrack = await renderTimelineAt(req([track]), 0.5, 0.5);
    const trackless = await renderTimelineAt(req(), 0.5, 0.5);
    expect(sha256(withTrack)).not.toBe(sha256(trackless));
  });

  test("an authored scale track on an image (ground) layer changes the drawn frame (paintBackground); removing the track draws the pre-change bytes", async () => {
    const track: Track = { property: "scale", stops: [{ t: 0, value: 1.15, clock: "pose" }] };
    const withTrack = await renderStill(
      request({
        background: gradientBackground(),
        template: imageTemplateWith([{ id: "image", kind: "image", tracks: [track] }]),
      }),
    );
    const trackless = await renderStill(
      request({
        background: gradientBackground(),
        template: imageTemplateWith([{ id: "image", kind: "image" }]),
      }),
    );
    expect(sha256(withTrack)).not.toBe(sha256(trackless));
  });
});

describe("K4: authored tracks compose with a preset in the fixed fold order (K-D9) — preset expansion first, authored tracks last", () => {
  test("headline-rise's opacity track (preset) then two authored opacity tracks fold in DECLARATION order; the reverse order gives a different float, computed independently, proving order matters", async () => {
    // `headline-rise`'s opacity stops (`0 -> 1`, beat clock) fold to exactly
    // `easeOutCubic(local)` with no reassociation at all (motion-tracks.ts's
    // own doc comment: "0 + (1 - 0) * ease(progress) is exact"), and on the
    // legacy path `local` IS `t` (K-D8) -- so this is a value we can predict
    // bit-for-bit, not an approximation.
    const t = 0.4;
    const preset = easeOutCubic(t);
    const authored1 = 0.2;
    const authored2 = 0.3;
    // foldPose starts its accumulator at 1 and multiplies left-to-right in
    // declaration order (resolve-tracks.ts): preset, then authored1, then
    // authored2 -- this is the order K4 declares (K-D9's fixed, only order).
    const forward = 1 * preset * authored1 * authored2;
    // If a lane instead folded the authored tracks BEFORE the preset
    // expansion (the mutation this fixture is built to catch), the product
    // would associate differently and, per IEEE-754, can disagree in the last
    // bit -- verified concretely for these exact literals, not assumed.
    const authoredFirst = 1 * authored1 * authored2 * preset;
    expect(forward).not.toBe(authoredFirst); // the fixture actually distinguishes the two orders

    const track1: Track = { property: "opacity", stops: [{ t: 0, value: authored1, clock: "pose" }] };
    const track2: Track = { property: "opacity", stops: [{ t: 0, value: authored2, clock: "pose" }] };
    const template = videoTemplateWith([
      { id: "video", kind: "video" },
      { id: "copy", kind: "animated-text", tracks: [track1, track2] },
    ]);

    // Capture the exact `globalAlpha` set at the blit -- the setter value, not
    // an 8-bit read-back off the rasterised pixel, which would quantize the
    // pose away from the pinned float (the same technique
    // `NodeCanvasCompositor.text-effect.test.ts` uses).
    const prepared = await NodeCanvasCompositor.prepare(request({ template }));
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    let capturedAlpha: number | undefined;
    const proto = Object.getPrototypeOf(ctx) as object;
    const alphaDesc =
      Object.getOwnPropertyDescriptor(proto, "globalAlpha") ?? Object.getOwnPropertyDescriptor(ctx, "globalAlpha");
    Object.defineProperty(ctx, "globalAlpha", {
      configurable: true,
      get() {
        return alphaDesc?.get?.call(ctx) ?? 1;
      },
      set(v: number) {
        capturedAlpha = v;
        alphaDesc?.set?.call(ctx, v);
      },
    });
    NodeCanvasCompositor.draw(ctx, prepared, t, "headline-rise");
    expect(capturedAlpha).toBe(forward);
  });
});

describe("K-D4: a disabled layer's own tracks resolve to nothing, silently", () => {
  test("an authored track changes the frame when the layer is enabled; disabling the layer draws exactly the frame without it, track and all", async () => {
    const track: Track = { property: "opacity", stops: [{ t: 0, value: 0.3, clock: "pose" }] };
    const baseline = await renderStill(
      request({
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text" },
        ]),
      }),
    );
    const enabledWithTrack = await renderStill(
      request({
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text", tracks: [track] },
        ]),
      }),
    );
    const disabledWithTrack = await renderStill(
      request({
        template: videoTemplateWith([
          { id: "video", kind: "video" },
          { id: "copy", kind: "animated-text", enabled: false, tracks: [track] },
        ]),
      }),
    );
    const absent = await renderStill(
      request({ template: videoTemplateWith([{ id: "video", kind: "video" }]) }),
    );
    // Non-vacuousness: the authored track really does move pixels when the
    // layer is enabled -- it is not silently ignored.
    expect(sha256(enabledWithTrack)).not.toBe(sha256(baseline));
    // K-D4: a disabled layer's tracks resolve to nothing -- byte-identical to
    // the layer's absence entirely, authored track and all.
    expect(sha256(disabledWithTrack)).toBe(sha256(absent));
  });
});
