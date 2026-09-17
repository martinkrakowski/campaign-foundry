import { describe, test, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  type BriefTemplate,
  type CompositeRequest,
  type HtmlElement,
  type AnchorKind,
} from "@campaignfoundry/CampaignOrchestration";
import { assembleHtml } from "@campaignfoundry/CampaignOrchestration/markup-assembler";
import {
  htmlElementFont,
  htmlTextGeometry,
} from "@campaignfoundry/CampaignOrchestration/html-element";
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

    test.each(cases)("anchor $anchor, frame $frame, tone $tone", ({ anchor, frame, tone }) => {
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
    });
  });
});

/* ── HL5e ─────────────────────────────────────────────────────────────────── */

import { createHash } from "node:crypto";

/**
 * HL5e (HL-D4, HL-D8): an element's `style` override must reach BOTH renderers
 * identically — the markup's inline `font-weight`/`font-family` and the canvas's
 * actual `ctx.font` at the moment the element's text is painted. The canvas side
 * is asserted on what was DRAWN (a `fillText` spy capturing `ctx.font`), never
 * on configuration, the way the style suite pins its own font state.
 */
describe("HL5e — per-element style overrides reach both renderers identically", () => {
  interface FontOp {
    text: string;
    font: string;
  }

  interface Paint {
    ops: FontOp[];
    raster: Buffer;
  }

  async function paintElements(
    elements: readonly HtmlElement[],
    tone: "bold" | "subtle",
    style?: { fontWeight?: 400 | 700; fontFamily?: "Inter" | "Lora" },
  ): Promise<Paint> {
    const req: CompositeRequest & { template: BriefTemplate } = {
      background: background(),
      message: "m",
      brandColor: "#1473E6",
      logoPath: "assets/inputs/hydra-logo.png",
      canvas: { ratio: "1:1" },
      layout: "headline-bottom",
      tone,
      style,
      template: templateWith(elements),
    };
    const prepared = await NodeCanvasCompositor.prepare(req);
    const canvas = createCanvas(prepared.width, prepared.height);
    const ctx = canvas.getContext("2d");
    const ops: FontOp[] = [];
    const origFill = ctx.fillText.bind(ctx);
    ctx.fillText = ((text: string, x: number, y: number, maxWidth?: number) => {
      ops.push({ text, font: ctx.font });
      return origFill(text, x, y, maxWidth);
    }) as typeof ctx.fillText;
    NodeCanvasCompositor.draw(ctx, prepared, 1);
    return { ops, raster: canvas.toBuffer("image/png") };
  }

  /** `"<weight> <size>px <family>, sans-serif"` → the weight and family tokens. */
  function canvasFontTokens(font: string): { fontWeight: string; fontFamily: string } {
    const m = /^(\S+) \d+(?:\.\d+)?px ([^,]+),/.exec(font);
    if (m === null) throw new Error(`unparsable ctx.font: ${font}`);
    return { fontWeight: m[1]!, fontFamily: m[2]! };
  }

  /** The inline style of the markup element whose text is `needle`. */
  function markupFont(html: string, needle: string): { fontWeight: string; fontFamily: string } {
    const m = new RegExp(`style="([^"]*)">(?:${needle})</(?:div|button)>`).exec(html);
    expect(m, `no markup element for ${needle}`).not.toBeNull();
    const style = m![1]!;
    const fontWeight = /font-weight: ([^;]+);/.exec(style)?.[1];
    const fontFamily = /font-family: ([^,]+),/.exec(style)?.[1];
    expect(fontWeight).toBeDefined();
    expect(fontFamily).toBeDefined();
    return { fontWeight: fontWeight!, fontFamily: fontFamily! };
  }

  const frame = { x: 0.1, y: 0.2, w: 0.6, h: 0.2, anchor: "top" } as const;

  test("one element's override changes only that element — in markup and on the canvas", async () => {
    const plain: HtmlElement = { kind: "text", text: "Plain", frame };
    const overridden: HtmlElement = {
      kind: "text",
      text: "Light",
      frame: { ...frame, y: 0.5 },
      style: { fontWeight: 400, fontFamily: "Lora" },
    };
    const button: HtmlElement = {
      kind: "button",
      text: "Go",
      frame: { ...frame, y: 0.8, h: 0.1 },
      style: { fontWeight: 700 },
    };
    // `subtle` gives the brief-level weight "500" and Inter — the values the
    // two elements WITHOUT a family override must keep rendering.
    const { ops } = await paintElements([plain, overridden, button], "subtle");
    const assembled = assembleHtml({
      elements: [plain, overridden, button],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
      tone: "subtle",
    });

    const byText = new Map(ops.map((op) => [op.text, op.font]));
    expect(byText.get("Plain")).toBeDefined();
    expect(byText.get("Light")).toBeDefined();
    expect(byText.get("Go")).toBeDefined();
    for (const [needle, expectedWeight] of [
      ["Plain", "500"],
      ["Light", "400"],
      ["Go", "700"],
    ] as const) {
      const canvasFont = canvasFontTokens(byText.get(needle)!);
      const markup = markupFont(assembled.html, needle);
      const expectedFamily = needle === "Light" ? "Lora" : "Inter";
      expect(canvasFont).toEqual({ fontWeight: expectedWeight, fontFamily: expectedFamily });
      expect(markup).toEqual(canvasFont);
    }
  });

  test("a brief-level style and an element override compose field by field", async () => {
    const element: HtmlElement = {
      kind: "text",
      text: "Half",
      frame,
      style: { fontFamily: "Lora" },
    };
    const { ops } = await paintElements([element], "bold", { fontWeight: 400 });
    const assembled = assembleHtml({
      elements: [element],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
      tone: "bold",
      style: { fontWeight: 400 },
    });
    const canvasFont = canvasFontTokens(ops.find((op) => op.text === "Half")!.font);
    expect(canvasFont).toEqual({ fontWeight: "400", fontFamily: "Lora" });
    expect(markupFont(assembled.html, "Half")).toEqual(canvasFont);
  });

  test("no element carries an override: the rasters and the markup are byte-identical to a style-less list", async () => {
    const plain: HtmlElement = { kind: "text", text: "Same", frame };
    const explicitEmpty: HtmlElement = { kind: "text", text: "Same", frame, style: {} };
    const withRender = await paintElements([plain], "subtle");
    const emptyRender = await paintElements([explicitEmpty], "subtle");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sha(emptyRender.raster)).toBe(sha(withRender.raster));
    const a = assembleHtml({
      elements: [plain],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
      tone: "subtle",
    });
    const b = assembleHtml({
      elements: [explicitEmpty],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
      tone: "subtle",
    });
    expect(b.html).toBe(a.html);
  });

  test("the one resolution is what both renderers read: htmlElementFont drives each element", () => {
    // The shared function's contract, asserted through the same shapes the
    // renderers call it with: absent override = the brief-level resolved font
    // (weight already tone-derived), present override wins per field.
    const briefFont = { fontWeight: "500", fontFamily: "Inter" };
    expect(htmlElementFont({ kind: "text", text: "x", frame }, briefFont)).toEqual(briefFont);
    expect(
      htmlElementFont({ kind: "text", text: "x", frame, style: { fontFamily: "Lora" } }, briefFont),
    ).toEqual({ fontWeight: "500", fontFamily: "Lora" });
  });
});
