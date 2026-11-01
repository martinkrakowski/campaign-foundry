import { describe, test, expect } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  canonicalTemplate,
  editorReducer,
  initialEditorState,
  toBrief,
  type EditorState,
} from "../editor-state";

const CANONICAL = CANONICAL_TEMPLATES["video"];

/** The canonical `video` template: video, shade, animated-text, logo. */
const template = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): BriefTemplate => ({
  id: "canonical-video",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers,
});

const stateWith = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): EditorState => ({
  ...initialEditorState(),
  template: template(layers),
});

const layer = (state: EditorState, id: string): CreativeTemplateLayer =>
  state.template.layers.find((candidate) => candidate.id === id)!;

const setSpan = (state: EditorState, layerId: string, startT: number, endT: number): EditorState =>
  editorReducer(state, { type: "setVideoSpan", layerId, startT, endT });

const defaultSpannedState = (): EditorState => setSpan(stateWith(), "video", 0.25, 0.75);

const stateWithVideoSpan = (span: { startT: number; endT: number }): EditorState =>
  stateWith([
    { id: "video", kind: "video", span },
    { id: "shade", kind: "shade" },
    { id: "animated-text", kind: "animated-text" },
    { id: "logo", kind: "logo" },
  ]);

describe("setVideoSpan — locating the layer (the setLayerEnabled shape)", () => {
  test("a partial span writes the span, and toBrief includes it with no seconds key", () => {
    const next = defaultSpannedState();
    expect(layer(next, "video").span).toEqual({ startT: 0.25, endT: 0.75 });
    const briefLayer = toBrief(next).template.layers.find((candidate) => candidate.id === "video")!;
    expect(briefLayer.span).toEqual({ startT: 0.25, endT: 0.75 });
    for (const key of ["start", "end", "dur", "startSec", "endSec"]) {
      expect(Object.keys(briefLayer)).not.toContain(key);
    }
  });

  test("a full-duration candidate leaves span absent", () => {
    const next = setSpan(stateWith(), "video", 0, 1);
    expect(layer(next, "video").span).toBeUndefined();
  });

  test("a full-duration candidate clears a stored partial span", () => {
    const withSpan = defaultSpannedState();
    expect(layer(withSpan, "video").span).toEqual({ startT: 0.25, endT: 0.75 });
    const cleared = setSpan(withSpan, "video", 0, 1);
    expect(layer(cleared, "video").span).toBeUndefined();
  });

  test("an ulp-near full span candidate clears a stored partial span", () => {
    const withSpan = defaultSpannedState();
    const cleared = setSpan(withSpan, "video", 1e-10, 1);
    expect(layer(cleared, "video").span).toBeUndefined();
  });

  test("the same partial span again returns the same state object — no history entry", () => {
    const first = defaultSpannedState();
    const second = setSpan(first, "video", 0.25, 0.75);
    expect(second).toBe(first);
  });

  test("a candidate within 1e-9 of the stored span returns the same state object", () => {
    const stored = setSpan(stateWith(), "video", 0.35, 0.75);
    const again = setSpan(stored, "video", (0.35 * 6) / 6, 0.75);
    expect(again).toBe(stored);
  });

  test.each([
    ["a non-video kind is a no-op", "shade", 0.25, 0.75],
    ["a span the domain refuses is a no-op — never clamped", "video", 2, 0.75],
    ["an unknown layer id is a no-op", "nope", 0.25, 0.75],
  ])("%s", (_name, layerId, startT, endT) => {
    const before = stateWith();
    const next = setSpan(before, layerId, startT, endT);
    expect(next).toBe(before);
  });
});

describe("setVideoSpan against addLayer and canonicalTemplate", () => {
  test("addLayer still pushes { id, kind } with no span", () => {
    const next = editorReducer(stateWith(), { type: "addLayer", kind: "video" });
    expect(next.template.layers.find((candidate) => candidate.id === "video-2")).toEqual({
      id: "video-2",
      kind: "video",
    });
  });

  test("canonicalTemplate deletes a full [0, 1] span and keeps a partial one", () => {
    const full = stateWithVideoSpan({ startT: 0, endT: 1 });
    const canonicalFull = canonicalTemplate(full.template);
    expect(canonicalFull.layers.find((candidate) => candidate.id === "video")).toEqual({
      id: "video",
      kind: "video",
    });

    const partial = stateWithVideoSpan({ startT: 0.25, endT: 0.75 });
    const canonicalPartial = canonicalTemplate(partial.template);
    expect(canonicalPartial.layers.find((candidate) => candidate.id === "video")).toEqual({
      id: "video",
      kind: "video",
      span: { startT: 0.25, endT: 0.75 },
    });
  });
});
