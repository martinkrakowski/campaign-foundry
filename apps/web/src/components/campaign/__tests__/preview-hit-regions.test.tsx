import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import {
  FULL_CANVAS_RECT,
  GROUND_LAYER_KINDS,
  type CanvasRect,
} from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import { PreviewHitRegions, hitRegionStyle, previewHitRegions } from "../PreviewHitRegions";
import * as messages from "../messages";

/**
 * Whole-layer hit regions for the ground kinds. An html layer paints nothing
 * on the raster, so it declares no region — copy is markup, and the layer
 * list remains the way to pick it.
 */

const htmlTemplate = (layers: BriefTemplate["layers"]): BriefTemplate => ({
  id: "canonical-image-html",
  version: 1,
  creativeType: "image-html",
  unit: "standard-web",
  layers,
});

const briefOf = (template: BriefTemplate): CampaignBrief => ({
  schemaVersion: 1,
  template,
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hello",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
});

const ids = (regions: readonly { layerId: string }[]) => regions.map((region) => region.layerId);

describe("previewHitRegions — grounds fill the canvas; other kinds do not", () => {
  test("a shade layer declares no region", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "shade", kind: "shade" },
            { id: "logo", kind: "logo" },
          ]),
        ),
      ),
    ).toEqual([]);
  });

  test("the canonical image-text template has one region: its ground layer, over the whole canvas", () => {
    const regions = previewHitRegions(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE));
    expect(ids(regions)).toEqual(["image"]);
    expect(regions[0]!.layerKind).toBe("image");
    expect(regions[0]!.rect).toEqual(FULL_CANVAS_RECT);
    expect(regions[0]!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  test("a video ground gets the same whole-canvas region a picture does", () => {
    const regions = previewHitRegions(templateFromCanonical("short-video"));
    expect(ids(regions)).toEqual(["video"]);
    expect(regions[0]!.rect).toEqual(FULL_CANVAS_RECT);
  });

  test("every frameless kind gets nothing: shade, accent, text and logo are list-only", () => {
    expect(
      previewHitRegions(
        htmlTemplate([
          { id: "shade", kind: "shade" },
          { id: "accent", kind: "accent" },
          { id: "static-text", kind: "static-text" },
          { id: "animated-text", kind: "animated-text" },
          { id: "logo", kind: "logo" },
          { id: "fill", kind: "fill" },
        ]),
      ),
    ).toEqual([]);
  });

  test("a disabled ground layer is not clickable", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "image", kind: "image", enabled: false },
            { id: "shade", kind: "shade" },
          ]),
        ),
      ),
    ).toEqual([]);
  });

  test("an enabled ground beside a disabled one is the only region", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "image", kind: "image" },
            { id: "video", kind: "video", enabled: false },
          ]),
        ),
      ),
    ).toEqual(["image"]);
  });
});

describe("regions are emitted in the template's z-order (D128)", () => {
  test("two grounds keep the template's order, and a shade layer between them adds nothing", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "back", kind: "image" },
            { id: "shade", kind: "shade" },
            { id: "front", kind: "video" },
          ]),
        ),
      ),
    ).toEqual(["back", "front"]);
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "front", kind: "video" },
            { id: "shade", kind: "shade" },
            { id: "back", kind: "image" },
          ]),
        ),
      ),
    ).toEqual(["front", "back"]);
  });
});

describe("hitRegionStyle — the whole of the mapping", () => {
  const frame = (rect: CanvasRect): CanvasRect => rect;

  test("a frame becomes percentages of the image box, axis for axis", () => {
    expect(hitRegionStyle(frame({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 }))).toEqual({
      left: "10%",
      top: "20%",
      width: "50%",
      height: "30%",
    });
  });

  test("a full-bleed frame is the whole box; a zero-origin frame starts at the corner", () => {
    expect(hitRegionStyle(frame({ x: 0, y: 0, w: 1, h: 1 }))).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
  });

  test("the axes do not commute", () => {
    const style = hitRegionStyle(frame({ x: 0.25, y: 0.75, w: 0.4, h: 0.6 }));
    expect(style.left).toBe("25%");
    expect(style.top).toBe("75%");
    expect(style.width).toBe("40%");
    expect(style.height).toBe("60%");
  });
});

describe("PreviewHitRegions — the ground layer's whole-canvas button", () => {
  const defaultBrief = briefOf(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE));

  test("the default template renders one region: the picture, named by its layer id", () => {
    const { container } = render(
      <PreviewHitRegions brief={defaultBrief} onSelectLayer={() => {}} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "image",
        description: messages.previewWholeLayerRegionDescription("Image"),
      }),
    ).toBeTruthy();
  });

  test("it covers the box edge to edge", () => {
    render(<PreviewHitRegions brief={defaultBrief} onSelectLayer={() => {}} />);
    const region = screen.getByRole("button", { name: "image" });
    expect(region.style.left).toBe("0%");
    expect(region.style.top).toBe("0%");
    expect(region.style.width).toBe("100%");
    expect(region.style.height).toBe("100%");
  });

  test("a click on it reports its layer, and the pick reads back as pressed", () => {
    const onSelectLayer = vi.fn();
    const { rerender } = render(
      <PreviewHitRegions brief={defaultBrief} onSelectLayer={onSelectLayer} />,
    );
    const region = () => screen.getByRole("button", { name: "image" });
    expect(region().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(region());
    expect(onSelectLayer.mock.calls).toEqual([["image"]]);

    rerender(
      <PreviewHitRegions brief={defaultBrief} selectedLayerId="image" onSelectLayer={() => {}} />,
    );
    expect(region().getAttribute("aria-pressed")).toBe("true");
  });

  test("two grounds keep template order and none carries a z-index", () => {
    const { container, rerender } = render(
      <PreviewHitRegions
        brief={briefOf(
          htmlTemplate([
            { id: "back", kind: "image" },
            { id: "shade", kind: "shade" },
            { id: "front", kind: "video" },
          ]),
        )}
        onSelectLayer={() => {}}
      />,
    );
    const buttons = () => [...container.querySelectorAll("button")];
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual(["back", "front"]);
    expect(buttons()[0]!.getAttribute("aria-describedby")).toContain("-back-layer");
    for (const button of buttons()) {
      expect(button.style.zIndex).toBe("");
      expect(button.className).not.toContain("z-");
      expect(button.className).toContain("ring-inset");
    }
    rerender(
      <PreviewHitRegions
        brief={briefOf(
          htmlTemplate([
            { id: "back", kind: "image" },
            { id: "front", kind: "video" },
          ]),
        )}
        selectedLayerId="back"
        onSelectLayer={() => {}}
      />,
    );
    expect(buttons()[0]!.getAttribute("aria-pressed")).toBe("true");
    for (const button of buttons()) {
      expect(button.style.zIndex).toBe("");
    }
  });

  test("a template with nothing to click renders no overlay at all", () => {
    const { container } = render(
      <PreviewHitRegions
        brief={briefOf(
          htmlTemplate([
            { id: "shade", kind: "shade" },
            { id: "accent", kind: "accent" },
            { id: "static-text", kind: "static-text" },
            { id: "logo", kind: "logo" },
          ]),
        )}
        onSelectLayer={() => {}}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("a withheld brief renders nothing", () => {
    const { container } = render(<PreviewHitRegions onSelectLayer={() => {}} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("no size is ever read: not at mount, not on the click", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const onSelectLayer = vi.fn();
    render(<PreviewHitRegions brief={defaultBrief} onSelectLayer={onSelectLayer} />);
    fireEvent.click(screen.getByRole("button", { name: "image" }));
    expect(onSelectLayer).toHaveBeenCalledWith("image");
    expect(rect).not.toHaveBeenCalled();
  });

  test("two ground layers get two regions with distinct descriptions", () => {
    const { container } = render(
      <PreviewHitRegions
        brief={briefOf(
          htmlTemplate([
            { id: "image", kind: "image" },
            { id: "image-2", kind: "image" },
          ]),
        )}
        onSelectLayer={() => {}}
      />,
    );
    const described = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-describedby"),
    );
    expect(described).toHaveLength(2);
    expect(new Set(described).size).toBe(2);
    expect(container.querySelectorAll(".sr-only")).toHaveLength(2);
  });

  test("every member of GROUND_LAYER_KINDS is clickable, by the domain's own list", () => {
    expect(GROUND_LAYER_KINDS.length).toBeGreaterThan(1);
    for (const kind of GROUND_LAYER_KINDS) {
      expect(ids(previewHitRegions(htmlTemplate([{ id: `l-${kind}`, kind }])))).toEqual([
        `l-${kind}`,
      ]);
    }
  });
});
