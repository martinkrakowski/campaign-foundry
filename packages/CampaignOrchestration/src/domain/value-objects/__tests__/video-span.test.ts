import { describe, test, expect } from "vitest";
import {
  layerSpanProblem,
  layerTimeFieldProblem,
  videoSpanCovers,
  videoSpansOverlap,
  type VideoSpan,
} from "../video-span.js";

const makeSpan = (startT: number, endT: number): VideoSpan => ({ startT, endT });
const videoSpanProblem = (span: unknown) => layerSpanProblem("video", span);

describe("videoSpanCovers — the half-open window (VT-D2, VT2)", () => {
  const span: VideoSpan = makeSpan(0.25, 0.75);

  test("inside is [startT, endT): true at the left edge and between, false before and at the right edge", () => {
    expect(videoSpanCovers(span, 0)).toBe(false);
    expect(videoSpanCovers(span, 0.25)).toBe(true);
    expect(videoSpanCovers(span, 0.5)).toBe(true);
    expect(videoSpanCovers(span, 0.75)).toBe(false);
  });

  test("a span ending at 1 is closed at t = 1 — the encoded last frame belongs to it", () => {
    const toEnd: VideoSpan = makeSpan(0.5, 1);
    expect(videoSpanCovers(toEnd, 0)).toBe(false);
    expect(videoSpanCovers(toEnd, 0.5)).toBe(true);
    expect(videoSpanCovers(toEnd, 1)).toBe(true);
  });
});

describe("videoSpansOverlap — adjacent spans do not overlap (VT-D3)", () => {
  test("adjacent [0, 0.5] and [0.5, 1] do not overlap", () => {
    expect(videoSpansOverlap(makeSpan(0, 0.5), makeSpan(0.5, 1))).toBe(false);
  });

  test("[0, 0.5] and [0.4, 1] overlap", () => {
    expect(videoSpansOverlap(makeSpan(0, 0.5), makeSpan(0.4, 1))).toBe(true);
  });

  test("non-overlapping [0.5, 1] and [0, 0.5] do not overlap (left comparison false)", () => {
    expect(videoSpansOverlap(makeSpan(0.5, 1), makeSpan(0, 0.5))).toBe(false);
  });
});

describe("layerSpanProblem — the one span decision both boundaries read", () => {
  test("absent span is always fine, on every kind", () => {
    expect(videoSpanProblem(undefined)).toBeUndefined();
    expect(layerSpanProblem("shade", undefined)).toBeUndefined();
  });

  test("a valid partial span, and the full [0, 1] boundary span, are fine on video", () => {
    expect(videoSpanProblem(makeSpan(0.25, 0.75))).toBeUndefined();
    expect(videoSpanProblem(makeSpan(0, 1))).toBeUndefined();
  });

  test("the same span is refused on any non-video kind", () => {
    const problem = layerSpanProblem("shade", makeSpan(0, 1));
    expect(problem?.must).toBe('be absent for layer kind "shade"');
  });

  test("a non-object span is refused", () => {
    for (const bad of [null, 7, "nope", []]) {
      expect(videoSpanProblem(bad)).toBeDefined();
    }
  });

  test("an extra key names the key", () => {
    const problem = videoSpanProblem({
      ...makeSpan(0.25, 0.75),
      foo: 1,
    });
    expect(problem?.path).toBe(".foo");
    expect(problem?.must).toBe('be one of "startT", "endT"');
  });

  test("a non-unit startT or endT names the field", () => {
    expect(videoSpanProblem({ startT: 1.5, endT: 0.75 })?.path).toBe(".startT");
    expect(videoSpanProblem({ startT: -0.1, endT: 0.75 })?.path).toBe(".startT");
    expect(videoSpanProblem({ startT: Number.NaN, endT: 0.75 })?.path).toBe(".startT");
    expect(videoSpanProblem({ startT: "0.2", endT: 0.75 })?.path).toBe(".startT");
    expect(videoSpanProblem({ startT: 0.25 })?.path).toBe(".endT");
    expect(videoSpanProblem({ startT: 0.25, endT: 2 })?.path).toBe(".endT");
  });

  test("startT === endT is refused", () => {
    const problem = videoSpanProblem(makeSpan(0.5, 0.5));
    expect(problem?.must).toBe("have startT < endT");
  });
});

describe("layerTimeFieldProblem — the keys around the span (VT2)", () => {
  test("an own spans property is refused in every case, with the one must-text", () => {
    const spans = [makeSpan(0, 0.6), makeSpan(0.4, 1)];
    const problem = layerTimeFieldProblem({ spans });
    expect(problem?.path).toBe("spans");
    expect(problem?.must).toBe("be absent; a video layer holds one span");
    expect(problem?.must).not.toContain("not overlap");
  });

  test("each seconds key is refused, never converted", () => {
    for (const key of ["start", "end", "dur", "startSec", "endSec"]) {
      const problem = layerTimeFieldProblem({ [key]: 1 });
      expect(problem?.path).toBe(key);
      expect(problem?.must).toContain("never seconds");
    }
  });

  test("no time-shaped own key means no problem", () => {
    expect(layerTimeFieldProblem({ id: "video", kind: "video" })).toBeUndefined();
  });
});
