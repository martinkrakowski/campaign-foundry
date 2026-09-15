import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type HtmlElement,
  type AnchorKind,
} from "@campaignfoundry/CampaignOrchestration";
import { assembleHtml } from "@campaignfoundry/CampaignOrchestration/markup-assembler";
import { htmlTextGeometry } from "@campaignfoundry/CampaignOrchestration/html-element";
import { DEFAULT_STYLE } from "@campaignfoundry/CampaignOrchestration/creative-style";
import { NodeCanvasCompositor } from "../NodeCanvasCompositor.js";
import { registerBundledFonts } from "../../fonts.js";

/**
 * HL5f (HL-D5, HL-D8): the canvas and the markup must agree on what they
 * already draw. Two separate claims, two separate test groups:
 *
 * 1. Font weight — compared against a REAL `NodeCanvasCompositor.prepare()`
 *    result, not against the shared `toneFontWeight` helper directly: a test
 *    that only calls the helper would pass even if the compositor stopped
 *    calling it (comparing the assembler to itself, not to the canvas).
 * 2. Text placement — the markup positions text with CSS flex
 *    `justify-content` per anchor (orchestrator fix round: a `padding-top`
 *    computed for one line regressed multi-line text — the browser must lay
 *    out however many lines the text actually wraps to, which the
 *    server-side assembler cannot know without a browser, D122). The exact
 *    numbers both renderers CAN share for any line count — font size, line
 *    height, letter spacing — are pinned via the one shared
 *    `htmlTextGeometry` function, parsed back out of the assembled markup's
 *    own inline style, for a grid of frames x anchors x tones.
 */

registerBundledFonts();

const background = (): Uint8Array => {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#333333";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
};

function templateWith(elements: readonly HtmlElement[]): BriefTemplate {
  return {
    id: "canonical-image-html",
    version: 1,
    creativeType: "image-html",
    unit: "standard-web",
    layers: [{ id: "html", kind: "html", elements }],
  };
}

describe("HL5f — canvas/markup renderer fidelity", () => {
  describe("font weight: the markup's tone-derived default matches the canvas's own", () => {
    test.each(["bold", "subtle"] as const)(
      "tone %s, no brief style: markup font-weight equals prepared.fontWeight",
      async (tone) => {
        const element: HtmlElement = {
          kind: "text",
          text: "Hi",
          frame: { x: 0, y: 0, w: 1, h: 0.2, anchor: "top" },
        };
        const req: CompositeRequest & { template: BriefTemplate } = {
          background: background(),
          message: "m",
          brandColor: "#1473E6",
          logoPath: "assets/inputs/hydra-logo.png",
          canvas: { ratio: "1:1" },
          layout: "headline-bottom",
          tone,
          template: templateWith([element]),
        };
        const prepared = await NodeCanvasCompositor.prepare(req);

        const assembled = assembleHtml({
          elements: [element],
          canvas: { ratio: "1:1" },
          brandColor: "#1473E6",
          tone,
        });

        expect(assembled.html).toContain(`font-weight: ${prepared.fontWeight};`);
      },
    );

    test("a style-supplied fontWeight overrides tone on both renderers identically", async () => {
      const element: HtmlElement = {
        kind: "text",
        text: "Hi",
        frame: { x: 0, y: 0, w: 1, h: 0.2, anchor: "top" },
      };
      const req: CompositeRequest & { template: BriefTemplate } = {
        background: background(),
        message: "m",
        brandColor: "#1473E6",
        logoPath: "assets/inputs/hydra-logo.png",
        canvas: { ratio: "1:1" },
        layout: "headline-bottom",
        tone: "subtle",
        style: { fontWeight: 700 },
        template: templateWith([element]),
      };
      const prepared = await NodeCanvasCompositor.prepare(req);
      expect(prepared.fontWeight).toBe("700");

      const assembled = assembleHtml({
        elements: [element],
        canvas: { ratio: "1:1" },
        brandColor: "#1473E6",
        tone: "subtle",
        style: { fontWeight: 700 },
      });
      expect(assembled.html).toContain(`font-weight: ${prepared.fontWeight};`);
    });
  });

  describe("text placement: flex justify-content per anchor, shared geometry numbers", () => {
    const anchors: readonly AnchorKind[] = ["top", "middle", "bottom"];
    const justifyFor: Readonly<Record<AnchorKind, string>> = {
      top: "flex-start",
      middle: "center",
      bottom: "flex-end",
    };
    const frames = [
      { x: 0.1, y: 0.1, w: 0.5, h: 0.3 },
      { x: 0.0, y: 0.4, w: 1.0, h: 0.12 },
    ];
    const tones = ["bold", "subtle"] as const;
    const CANVAS_PX = 1080; // "1:1" resolves to 1080x1080 (ratio family: scaleBasis === width).

    const cases = anchors.flatMap((anchor) =>
      frames.flatMap((frame) => tones.map((tone) => ({ anchor, frame, tone }))),
    );

    test.each(cases)(
      "anchor $anchor, frame $frame, tone $tone",
      ({ anchor, frame, tone }) => {
        const element: HtmlElement = {
          kind: "text",
          text: "Short label",
          frame: { ...frame, anchor },
        };
        const assembled = assembleHtml({
          elements: [element],
          canvas: { ratio: "1:1" },
          brandColor: "#1473E6",
          tone,
        });

        const styleMatch = /<div style="([^"]*)">Short label<\/div>/.exec(assembled.html);
        expect(styleMatch).not.toBeNull();
        const style = styleMatch![1]!;

        // CSS flex, not a padding-top computed for one line: the browser
        // must be free to centre/end-align however many lines this text
        // actually wraps to.
        expect(style).toContain("display: flex");
        expect(style).toContain(`justify-content: ${justifyFor[anchor]};`);
        expect(style).not.toContain("padding-top");

        const fontSize = Number(/font-size: ([\d.]+)px/.exec(style)?.[1]);
        const lineHeightPx = Number(/line-height: ([\d.]+)px/.exec(style)?.[1]);
        const letterSpacingPx = Number(/letter-spacing: ([\d.]+)px/.exec(style)?.[1]);
        const fontWeight = /font-weight: ([a-z0-9]+);/.exec(style)?.[1];
        const widthPx = Number(/width: ([\d.]+)px/.exec(style)?.[1]);

        const boxH = frame.h * CANVAS_PX;
        const boxW = frame.w * CANVAS_PX;
        // Line-wrapping input: both renderers wrap/lay out at the frame's own
        // width verbatim (`drawHtml` calls `wrapText(ctx, text, boxW)`;
        // `assembleHtml`'s baseStyle sets `width: ${boxW}px`) — no separate
        // number to share, so pin the one that already must agree.
        expect(widthPx).toBe(boxW);

        // The numbers that ARE independent of line count — font size, line
        // height, letter spacing, weight — still come from the one shared
        // function and must be equal for any line count.
        const geometry = htmlTextGeometry({
          boxH,
          canvasBasis: CANVAS_PX,
          sizeScale: DEFAULT_STYLE.sizeScale,
          lineHeight: DEFAULT_STYLE.lineHeight,
          letterSpacing: DEFAULT_STYLE.letterSpacing,
        });
        expect(fontSize).toBe(geometry.fontSize);
        expect(lineHeightPx).toBe(geometry.lineHeight);
        expect(letterSpacingPx).toBe(geometry.letterSpacing);
        expect(fontWeight).toBe(tone === "subtle" ? "500" : "bold");
      },
    );
  });
});
