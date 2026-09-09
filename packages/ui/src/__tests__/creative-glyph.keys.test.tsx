import { describe, test, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

/**
 * The render-side half of the L8a key fix. The group-splitting order is
 * injected with `vi.doMock` + a dynamic import: in this setup a hoisted
 * `vi.mock` reaches the test's own imports but not the component's, while a
 * `doMock` registered before the import reaches both.
 */
describe("CreativeGlyph keys its animation-group runs by position (L8a)", () => {
  afterEach(() => {
    vi.doUnmock("../preview-layers");
    vi.restoreAllMocks();
  });

  test("an order that splits an animation group renders four distinct runs and no duplicate-key warning", async () => {
    vi.resetModules();
    vi.doMock("../preview-layers", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../preview-layers")>();
      return {
        ...actual,
        // L2b's defect, deferred to L8a because it was unreachable until
        // `moveLayer` existed: an order that SPLITS the ground group — image,
        // accent, shade — makes `groupRuns` emit two runs with the same
        // className, siblings whose className keys would collide. The mocked
        // order is exactly that split.
        PREVIEW_LAYER_ORDER: ["image", "accent", "shade", "static-text", "logo"] as unknown as typeof actual.PREVIEW_LAYER_ORDER,
      };
    });
    const { CreativeGlyph } = await import("../creative-glyph");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const { container } = render(<CreativeGlyph />);
    // The split order's runs, in document order: ground, band, ground, text —
    // then the always-rendered cue group. The two ground runs share a className
    // and are exactly the pair a className key would collide.
    const classes = Array.from(container.querySelectorAll("g")).map((g) => g.getAttribute("class"));
    expect(classes).toEqual([
      "glyph-anim glyph-ground",
      "glyph-band-group",
      "glyph-anim glyph-ground",
      "glyph-anim glyph-text",
      "glyph-cue",
    ]);
    expect(errors.join("\n")).not.toMatch(/same key/);
  });
});
