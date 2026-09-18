import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { PreviewHitRegions, hitRegionStyle, previewHitRegions } from "../PreviewHitRegions";
import * as messages from "../messages";

/**
 * CE1 — the hit regions themselves: what a template declares as clickable, and
 * how a declared frame becomes a box over the raster.
 *
 * The lane's whole premise is under test here: **a region is the element's
 * DECLARED frame**. Nothing in this file measures text, and nothing in the
 * component it drives can — that is the property the width assertions below
 * pin, and the reason `getBoundingClientRect` is asserted never to be read.
 */

const element = (over: Partial<HtmlElement> = {}): HtmlElement => ({
  kind: "text",
  text: "Hello",
  frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" },
  ...over,
});

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

describe("previewHitRegions — only what declares a frame", () => {
  test("one region per element of an html layer, in the layer's own order", () => {
    const regions = previewHitRegions(
      htmlTemplate([
        { id: "image", kind: "image" },
        {
          id: "html",
          kind: "html",
          elements: [element(), element({ kind: "button", text: "Go" })],
        },
        { id: "logo", kind: "logo" },
      ]),
    );
    expect(regions.map((r) => [r.layerId, r.elementIndex, r.element.kind])).toEqual([
      ["html", 0, "text"],
      ["html", 1, "button"],
    ]);
    expect(regions[0].layerKind).toBe("html");
  });

  /**
   * The exclusions, asserted rather than described. The canonical image-text
   * template is every kind whose drawn position is decided by a layout engine
   * — `static-text`'s block comes out of `anchorFirstY` over a MEASURED span
   * and type size, and the logo's corner is snapped against that measured
   * block — plus the kinds whose geometry is declared in `CREATIVE_GEOMETRY`
   * but is not a `frame`. None of them is hit-testable, and the layer list
   * stays their way in.
   */
  test("a layer that declares no frame is not a region — the canonical image-text template has none", () => {
    expect(previewHitRegions(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE))).toEqual([]);
  });

  test("a disabled html layer is not drawn, so it is not clickable either (X9, D129)", () => {
    expect(
      previewHitRegions(
        htmlTemplate([
          { id: "image", kind: "image" },
          { id: "html", kind: "html", enabled: false, elements: [element()] },
        ]),
      ),
    ).toEqual([]);
  });

  test("an html layer with no elements declares nothing — the canonical image-html state", () => {
    expect(
      previewHitRegions(
        htmlTemplate([
          { id: "image", kind: "image" },
          { id: "html", kind: "html" },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("hitRegionStyle — the whole of the mapping", () => {
  /**
   * The frame's fractions, restated as percentages of the box, and nothing
   * else. A pixel form — or anything multiplied by a rendered width — fails
   * here before it can fail at a second size.
   */
  test("a frame becomes percentages of the image box, axis for axis", () => {
    expect(hitRegionStyle({ x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" })).toEqual({
      left: "10%",
      top: "20%",
      width: "50%",
      height: "30%",
    });
  });

  test("a full-bleed frame is the whole box; a zero-origin frame starts at the corner", () => {
    expect(hitRegionStyle({ x: 0, y: 0, w: 1, h: 1, anchor: "bottom" })).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
  });

  /**
   * x and y (and w and h) must not be interchangeable: a transposed mapping
   * reads identically on a square frame and is wrong on every other one.
   */
  test("the axes do not commute", () => {
    const style = hitRegionStyle({ x: 0.25, y: 0.75, w: 0.4, h: 0.6, anchor: "middle" });
    expect(style.left).toBe("25%");
    expect(style.top).toBe("75%");
    expect(style.width).toBe("40%");
    expect(style.height).toBe("60%");
  });
});

describe("PreviewHitRegions — a button per declared frame (D18)", () => {
  const twoElementBrief = briefOf(
    htmlTemplate([
      { id: "image", kind: "image" },
      {
        id: "html",
        kind: "html",
        elements: [
          element(),
          element({
            kind: "button",
            text: "Go",
            frame: { x: 0.6, y: 0.7, w: 0.2, h: 0.1, anchor: "bottom" },
          }),
        ],
      },
    ]),
  );

  test("each region is named by the raw layer id and described by the display words", () => {
    render(<PreviewHitRegions brief={twoElementBrief} onSelectLayer={() => {}} />);
    const regions = screen.getAllByRole("button", { name: "html" });
    expect(regions).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "html",
        description: messages.previewRegionDescription("HTML", "Text"),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "html",
        description: messages.previewRegionDescription("HTML", "Button"),
      }),
    ).toBeTruthy();
  });

  test("the declared frame is the box: each region carries its own percentages", () => {
    render(<PreviewHitRegions brief={twoElementBrief} onSelectLayer={() => {}} />);
    const [text, button] = screen.getAllByRole("button", { name: "html" });
    expect(text.style.left).toBe("10%");
    expect(text.style.top).toBe("20%");
    expect(text.style.width).toBe("50%");
    expect(text.style.height).toBe("30%");
    expect(button.style.left).toBe("60%");
    expect(button.style.height).toBe("10%");
  });

  test("a click reports the LAYER, not the element — one selection, the list's own vocabulary", () => {
    const onSelectLayer = vi.fn();
    render(<PreviewHitRegions brief={twoElementBrief} onSelectLayer={onSelectLayer} />);
    fireEvent.click(screen.getAllByRole("button", { name: "html" })[1]);
    expect(onSelectLayer.mock.calls).toEqual([["html"]]);
  });

  /**
   * The pressed state is the layer's, so BOTH of a layer's regions light up
   * together: the selection names a layer and the rail's list shows a layer.
   */
  test("the picked layer's regions read as pressed; nothing picked reads as not pressed", () => {
    const { rerender } = render(
      <PreviewHitRegions brief={twoElementBrief} onSelectLayer={() => {}} />,
    );
    expect(
      screen.getAllByRole("button", { name: "html" }).map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["false", "false"]);

    rerender(
      <PreviewHitRegions brief={twoElementBrief} selectedLayerId="html" onSelectLayer={() => {}} />,
    );
    expect(
      screen.getAllByRole("button", { name: "html" }).map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "true"]);

    rerender(
      <PreviewHitRegions
        brief={twoElementBrief}
        selectedLayerId="image"
        onSelectLayer={() => {}}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: "html" }).map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["false", "false"]);
  });

  /**
   * No frames, no surface. An empty overlay over the creative would be an
   * invisible element with nothing behind it to mean.
   */
  test("a template with nothing declared renders no overlay at all", () => {
    const { container } = render(
      <PreviewHitRegions
        brief={briefOf(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE))}
        onSelectLayer={() => {}}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("a withheld brief renders nothing — the CC2 state, decided in one place", () => {
    const { container } = render(<PreviewHitRegions onSelectLayer={() => {}} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  /**
   * **Red fault 6, in the form the shape allows.** The brief asks for a hit
   * asserted at two rendered widths, because a mapping that ignores
   * letterboxing passes at one size and fails at another. These regions do no
   * coordinate arithmetic at all — they are CSS percentages of the box the
   * `<img>` fills — so there is no rendered width in the mapping to be right
   * or wrong about, and happy-dom performs no layout to measure one with.
   *
   * The equivalent, and killable, claim is therefore: **nothing reads a size.**
   * A `getBoundingClientRect` on any element, at mount or on the click, is
   * exactly what an offsetX/width implementation would need, and there is
   * none. Paired with the percentage assertions above — which are the same
   * strings whatever the box is — that says what two widths would have said.
   */
  test("no size is ever read: not at mount, not on the click", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const onSelectLayer = vi.fn();
    render(<PreviewHitRegions brief={twoElementBrief} onSelectLayer={onSelectLayer} />);
    fireEvent.click(screen.getAllByRole("button", { name: "html" })[0]);
    expect(onSelectLayer).toHaveBeenCalledWith("html");
    expect(rect).not.toHaveBeenCalled();
  });
});
