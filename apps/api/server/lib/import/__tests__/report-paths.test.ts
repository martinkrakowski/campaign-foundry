import { describe, expect, test } from "vitest";
import { reportRenderPaths } from "../report-paths.js";

describe("reportRenderPaths", () => {
  test("the paths come from the object rows of assets[], each distinct field and path once, in first-seen order", () => {
    const report = {
      halted: false,
      assets: [
        { productId: "p1", outputPath: "camp/p1/1x1/v0.png", proofPath: "camp/proofs/p1.pdf" },
        {
          productId: "p1",
          outputPath: "camp/p1/9x16/v0.png",
          videoPath: "camp/p1/9x16/v0.mp4",
          proofPath: "camp/proofs/p1.pdf",
        },
        { htmlBundlePath: "camp/p1/html/index.html", htmlFallbackPath: "camp/p1/1x1/v0.png" },
      ],
      log: [],
    };
    expect(reportRenderPaths(report)).toEqual([
      { field: "outputPath", path: "camp/p1/1x1/v0.png" },
      { field: "proofPath", path: "camp/proofs/p1.pdf" },
      { field: "outputPath", path: "camp/p1/9x16/v0.png" },
      { field: "videoPath", path: "camp/p1/9x16/v0.mp4" },
      { field: "htmlFallbackPath", path: "camp/p1/1x1/v0.png" },
      { field: "htmlBundlePath", path: "camp/p1/html/index.html" },
    ]);
  });

  test("a path on the report object itself is not returned", () => {
    expect(reportRenderPaths({ outputPath: "camp/top.png", assets: [] })).toEqual([]);
    expect(reportRenderPaths({ outputPath: "camp/top.png", proofPath: "camp/p.pdf" })).toEqual([]);
  });
  test("a report that is not an object, or whose assets is not an array, names no render", () => {
    const row = { outputPath: "camp/a.png" };
    for (const report of [null, undefined, "camp/a.png", 7, ["camp/a.png"], [row]]) {
      expect(reportRenderPaths(report)).toEqual([]);
    }
    for (const assets of [null, "camp/a.png", row, 7]) {
      expect(reportRenderPaths({ assets })).toEqual([]);
    }
  });

  test("a row that is not an object is skipped, and so is a value that is not a non-empty string", () => {
    const report = {
      assets: [
        null,
        "camp/a.png",
        ["camp/b.png"],
        7,
        { outputPath: "", videoPath: 7, proofPath: null, htmlBundlePath: ["camp/c.html"] },
        { outputUrl: "https://example.test/x.png", path: "camp/d.png" },
        { outputPath: "camp/kept.png" },
      ],
    };
    expect(reportRenderPaths(report)).toEqual([{ field: "outputPath", path: "camp/kept.png" }]);
  });
});
