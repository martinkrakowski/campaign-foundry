import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { Frame, HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import {
  FULL_CANVAS_RECT,
  GROUND_LAYER_KINDS,
} from "@campaignfoundry/CampaignOrchestration/creative-geometry";
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

/** `[layerId, elementIndex]` per region, in emission order — the z-order the array IS (D128). */
const ids = (regions: readonly { layerId: string; elementIndex?: number }[]) =>
  regions.map((r) => [r.layerId, r.elementIndex] as const);

describe("previewHitRegions — the elements, and the layers that fill the canvas", () => {
  test("one region per element of an html layer, in the layer's own order", () => {
    const regions = previewHitRegions(
      htmlTemplate([
        {
          id: "html",
          kind: "html",
          elements: [element(), element({ kind: "button", text: "Go" })],
        },
        { id: "logo", kind: "logo" },
      ]),
    );
    expect(regions.map((r) => [r.layerId, r.elementIndex, r.element!.kind])).toEqual([
      ["html", 0, "text"],
      ["html", 1, "button"],
    ]);
    expect(regions[0].layerKind).toBe("html");
    // The element's declared frame IS the rect — nothing in between.
    expect(regions[0].rect).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" });
  });

  /**
   * **CE2's whole premise.** The default campaign type resolves to canonical
   * `image-text`, which carries no `html` layer, so under CE1 this returned
   * nothing at all and the feature was inert on every new campaign. Its
   * `image` layer is a ground layer, and a ground layer's box is the canvas by
   * `paintBackground`'s own draw call.
   */
  test("the canonical image-text template has one region: its ground layer, over the whole canvas", () => {
    const regions = previewHitRegions(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE));
    expect(ids(regions)).toEqual([["image", undefined]]);
    expect(regions[0].layerKind).toBe("image");
    expect(regions[0].element).toBeUndefined();
    expect(regions[0].rect).toEqual(FULL_CANVAS_RECT);
    expect(regions[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  /**
   * `video` is the other member of `GROUND_LAYER_KINDS` — the same drawer, so
   * the same box. A template with a clip for a ground is clickable exactly as
   * one with a picture is; testing only `image` would let the set shrink to one
   * unnoticed.
   */
  test("a video ground gets the same whole-canvas region a picture does", () => {
    const regions = previewHitRegions(templateFromCanonical("short-video"));
    expect(ids(regions)).toEqual([["video", undefined]]);
    expect(regions[0].rect).toEqual(FULL_CANVAS_RECT);
  });

  /**
   * The exclusions, asserted rather than described, on a template that carries
   * every one of them and no ground at all — so an accidental region for any of
   * them shows up as a non-empty array rather than hiding behind the image's.
   *
   * `static-text`'s block comes out of `anchorFirstY` over a MEASURED span and
   * type size, and the logo's corner is snapped against a decoded file's own
   * aspect ratio and then clamped; `shade`'s rect is the whole canvas and is
   * declined anyway (it is an all-alpha veil that would swallow the ground's
   * clicks); `accent`'s edge follows the resolved anchor and its fade follows
   * the playhead, so there is no one rectangle; `fill` has no drawer at all.
   */
  test("the frameless kinds get nothing: shade, accent, text and logo are list-only", () => {
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

  test("a disabled html layer is not drawn, so it is not clickable either (X9, D129)", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "image", kind: "image" },
            { id: "html", kind: "html", enabled: false, elements: [element()] },
          ]),
        ),
      ),
    ).toEqual([["image", undefined]]);
  });

  /** The same rule for the kind CE2 added: a disabled ground draws nothing, so it is not clickable. */
  test("a disabled ground layer is not clickable either", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "image", kind: "image", enabled: false },
            { id: "html", kind: "html", elements: [element()] },
          ]),
        ),
      ),
    ).toEqual([["html", 0]]);
  });

  test("an html layer with no elements declares nothing — the canonical image-html state", () => {
    expect(
      ids(
        previewHitRegions(
          htmlTemplate([
            { id: "image", kind: "image" },
            { id: "html", kind: "html" },
          ]),
        ),
      ),
    ).toEqual([["image", undefined]]);
  });
});

/**
 * **Red fault 2 — overlap resolves by z-order.**
 *
 * A ground region covers everything, so its position in the emitted array is
 * the whole question: these are positioned siblings with no `z-index`, and
 * positioned siblings with an auto z-index paint — and hit-test — in DOM
 * order, so the LAST region at a point is the one that takes the click.
 *
 * Asserted in both directions on purpose. An implementation that emitted the
 * ground regions first, or sorted them by size, passes the first case and
 * fails the second: a template that puts its `html` layer BELOW the ground
 * must put the html region below too, because that is what the compositor
 * draws and what the layer list shows.
 */
describe("regions are emitted in the template's z-order (D128)", () => {
  const withOrder = (layers: BriefTemplate["layers"]) =>
    ids(previewHitRegions(htmlTemplate(layers)));

  const imageLayer = { id: "image", kind: "image" } as const;
  const htmlLayer = { id: "html", kind: "html", elements: [element(), element()] } as const;

  test("a ground below an html layer is emitted first, so the elements sit over it", () => {
    expect(withOrder([imageLayer, htmlLayer])).toEqual([
      ["image", undefined],
      ["html", 0],
      ["html", 1],
    ]);
  });

  test("a ground ABOVE an html layer is emitted last — the order follows the template, not the size", () => {
    expect(withOrder([htmlLayer, imageLayer])).toEqual([
      ["html", 0],
      ["html", 1],
      ["image", undefined],
    ]);
  });
});

describe("hitRegionStyle — the whole of the mapping", () => {
  /**
   * A declared frame carries the vertical `anchor` the mapping does not read,
   * so the fixtures are typed as `Frame`: the call sites below hand the
   * function the real shape an element carries, and the widened `CanvasRect`
   * parameter (CE2, so a whole-canvas rect needs no invented anchor) still
   * accepts it.
   */
  const frame = (f: Frame): Frame => f;

  /**
   * The frame's fractions, restated as percentages of the box, and nothing
   * else. A pixel form — or anything multiplied by a rendered width — fails
   * here before it can fail at a second size.
   */
  test("a frame becomes percentages of the image box, axis for axis", () => {
    expect(hitRegionStyle(frame({ x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" }))).toEqual({
      left: "10%",
      top: "20%",
      width: "50%",
      height: "30%",
    });
  });

  test("a full-bleed frame is the whole box; a zero-origin frame starts at the corner", () => {
    expect(hitRegionStyle(frame({ x: 0, y: 0, w: 1, h: 1, anchor: "bottom" }))).toEqual({
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
    const style = hitRegionStyle(frame({ x: 0.25, y: 0.75, w: 0.4, h: 0.6, anchor: "middle" }));
    expect(style.left).toBe("25%");
    expect(style.top).toBe("75%");
    expect(style.width).toBe("40%");
    expect(style.height).toBe("60%");
  });
});

/** A ground under an html layer with two elements: three regions, in that z-order. */
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

describe("PreviewHitRegions — a button per declared frame (D18)", () => {
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
   * No regions, no surface. An empty overlay over the creative would be an
   * invisible element with nothing behind it to mean. The fixture is a stack of
   * frameless kinds with no ground, because the canonical `image-text`
   * template — what this test used to use — now has a region of its own.
   */
  test("a template with nothing to click renders no overlay at all", () => {
    const { container } = render(
      <PreviewHitRegions
        brief={briefOf(
          htmlTemplate([
            { id: "shade", kind: "shade" },
            { id: "static-text", kind: "static-text" },
            { id: "logo", kind: "logo" },
          ]),
        )}
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

/**
 * CE2's own button: the ground layer's region, over the whole canvas.
 *
 * It is the same control as an element's — a real `<button>`, named by the raw
 * layer id (D18), reporting the layer — differing only in what it covers and
 * in the words that say so, because there is no element to name.
 */
describe("PreviewHitRegions — the ground layer's whole-canvas button (CE2)", () => {
  const defaultBrief = briefOf(templateFromCanonical(DEFAULT_CAMPAIGN_TYPE));

  /**
   * A ground and a two-element html layer, stacked in the order given, with
   * layer IDS that are deliberately not kind names: the regions report the id,
   * and a fixture whose id doubles as its kind cannot tell the two apart.
   */
  const stackedBrief = (order: readonly ["ground" | "markup", "ground" | "markup"]) =>
    briefOf(
      htmlTemplate(
        order.map((id) =>
          id === "ground"
            ? { id, kind: "image" as const }
            : { id, kind: "html" as const, elements: [element(), element()] },
        ),
      ),
    );

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

  test("it covers the box edge to edge, through the same mapping an element uses", () => {
    render(<PreviewHitRegions brief={defaultBrief} onSelectLayer={() => {}} />);
    const region = screen.getByRole("button", { name: "image" });
    expect(region.style.left).toBe("0%");
    expect(region.style.top).toBe("0%");
    expect(region.style.width).toBe("100%");
    expect(region.style.height).toBe("100%");
    expect(hitRegionStyle(FULL_CANVAS_RECT)).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
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

  /**
   * **Red fault 2, in the form happy-dom can actually witness.** No layout runs
   * here, so firing a click at a coordinate proves nothing about stacking: the
   * event lands on whatever element the test names. What DOES decide the real
   * overlap is exactly two things, and both are asserted — the DOM order of the
   * regions, which for positioned siblings with an auto z-index is the paint
   * and hit-test order, and the absence of any `z-index` that would override
   * it. Together they say: the smaller region over the picture takes the click,
   * because it is painted after the picture's region and nothing lifts the
   * picture's above it.
   */
  test("the ground's button precedes the element buttons it sits under, and none carries a z-index", () => {
    const { container, rerender } = render(
      <PreviewHitRegions brief={stackedBrief(["ground", "markup"])} onSelectLayer={() => {}} />,
    );
    const buttons = () => [...container.querySelectorAll("button")];
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "ground",
      "markup",
      "markup",
    ]);
    // The ground's is first in DOM order, so it paints first and is hit LAST.
    expect(buttons()[0].getAttribute("aria-describedby")).toContain("-ground-layer");
    // Nothing lifts itself out of that order — inline or by class.
    for (const b of buttons()) {
      expect(b.style.zIndex).toBe("");
      expect(b.className).not.toContain("z-");
      // And every ring is INSET. A ring is a box-shadow outside the border
      // box, and the whole-canvas region fills its `overflow-hidden`
      // container exactly, so an outset one is clipped away entirely —
      // leaving a keyboard user with no focus indicator and a picked picture
      // with no highlight. No layout runs here, so the class is the claim.
      expect(b.className).toContain("ring-inset");
    }
    // And picking one must not lift it either: a selected region that floated
    // above the stack would put a layer's hit box somewhere the layer is not,
    // which is the one thing a highlight is never allowed to change.
    rerender(
      <PreviewHitRegions
        brief={stackedBrief(["ground", "markup"])}
        selectedLayerId="ground"
        onSelectLayer={() => {}}
      />,
    );
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
    for (const b of buttons()) {
      expect(b.style.zIndex).toBe("");
      expect(b.className).not.toContain("z-");
    }
  });

  /**
   * And the other direction, rendered: a template that stacks its ground ABOVE
   * the html layer renders the ground's button LAST, so the ground swallows the
   * element clicks — which is what the compositor draws and what the layer list
   * shows. An implementation that emitted whole-layer regions first would read
   * identically on the fixture above and fail here.
   */
  test("a ground stacked above an html layer renders its button last", () => {
    const { container } = render(
      <PreviewHitRegions brief={stackedBrief(["markup", "ground"])} onSelectLayer={() => {}} />,
    );
    expect(
      [...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["markup", "markup", "ground"]);
  });

  /**
   * A template may carry more than one ground layer, and each gets its OWN
   * region and its own description span — one whole-canvas region is not
   * emitted per template. (The ids are distinct because the LAYER ID is in
   * them; the `-layer` slot is spelling, not uniqueness, and is pinned by the
   * order test above.)
   */
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
    const described = [...container.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-describedby"),
    );
    expect(described).toHaveLength(2);
    expect(new Set(described).size).toBe(2);
    expect(container.querySelectorAll(".sr-only")).toHaveLength(2);
  });

  /**
   * The set itself, read from the domain rather than restated: every ground
   * kind gets a region, and the web carries no list of its own saying which
   * kinds those are (D121 forbids one, and the scanner in `derive.test.ts`
   * enforces it). A component that hard-coded one kind fails here. WHICH kinds
   * belong to the set is pinned where it can be checked against the compositor
   * — `NodeCanvasCompositor.ground-kinds.test.ts`, against `LAYER_DRAWERS`.
   */
  test("every member of GROUND_LAYER_KINDS is clickable, by the domain's own list", () => {
    expect(GROUND_LAYER_KINDS.length).toBeGreaterThan(1);
    for (const kind of GROUND_LAYER_KINDS) {
      expect(ids(previewHitRegions(htmlTemplate([{ id: `l-${kind}`, kind }])))).toEqual([
        [`l-${kind}`, undefined],
      ]);
    }
  });
});
