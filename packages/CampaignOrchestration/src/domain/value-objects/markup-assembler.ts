/**
 * The markup assembler (HL4, HL-D3, HL-D5, HL-D6).
 *
 * Produces a self-contained HTML creative unit server-side from the same
 * `html` layer element list that HL3's `drawHtml` paints on the canvas fallback.
 *
 * Key invariants:
 * 1. `clickDestination` (HL-D3): When present, emits a standard `var clickTag`
 *    variable declaration in the `<head>` script, NEVER an `<a href>`. Interactive
 *    elements navigate via `window.open(window.clickTag)`. When absent, no `clickTag`
 *    variable is emitted and no navigation handler is wired.
 * 2. Weight budget (HL-D6): Measured against `profile.maxBytes` when a profile
 *    is provided; refused over budget with an error naming both the budget and the overage.
 * 3. Element vocabulary (HL-D2): Expresses `button`, `text`, and `image` elements
 *    matching the canvas rendition geometry and styling.
 * 4. Content safety (HL-D7): Every interpolation is escaped for its context —
 *    HTML text and quoted attributes are HTML-escaped, the clickTag script
 *    declaration uses `\uXXXX` escapes (entities would corrupt the JS string),
 *    and the brand colour is additionally refused unless it is the documented
 *    6-digit hex shape.
 */

import { resolveCanvas, scaleBasis, type CanvasSpec } from "./aspect-ratios.js";
import { CLICK_TAG_VARIABLE } from "./click-destination.js";
import { DEFAULT_STYLE, resolveStyle, toneFontWeight, type Style } from "./creative-style.js";
import { htmlTextGeometry, htmlButtonFontSize, htmlTextPaddingTop, type HtmlElement } from "./html-element.js";
import { DEFAULT_TREATMENT, type ToneKind } from "./Treatment.vo.js";

/** HTML-escape user-authored strings for the HTML text / quoted-attribute contexts (HL-D7). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape the output of `JSON.stringify` for the **JS string-in-`<script>`** context (HL-D7).
 *
 * HTML-escaping is the wrong tool here: entities inside a JS string literal would
 * corrupt the value. The parser instead ends a script element at the first literal
 * `</script>` (or begins a comment at `<!--`) regardless of JS string context, so a
 * crafted destination could close the declaration and append executable markup.
 * `\uXXXX` escapes keep the JS value byte-exact while making HTML syntax impossible
 * to appear literally. None of the replacements introduces `&`, `<` or `>`, so the
 * order is safe.
 */
function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

/** The documented brand colour shape: a 6-digit hex colour, e.g. `#1473E6`. */
const BRAND_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * Whether `brandColor` is the documented 6-digit hex shape (HL-D7). Exported so a
 * caller that must NOT trip the assembler's refusal — the editor's weight meter,
 * which would otherwise swallow every assembly error to hide this one case — can
 * check the shape the assembler itself checks, against the one pattern it owns,
 * rather than restating it.
 */
export function isBrandColor(brandColor: string): boolean {
  return BRAND_COLOR_PATTERN.test(brandColor);
}

/**
 * Gate the brand colour by **shape** and escape it for the **quoted style-attribute**
 * context (HL-D7). A verbatim `background-color: ${brandColor}` lets a value carrying
 * a quote close the attribute and attach its own handler (e.g. `autofocus onfocus=…`),
 * which runs when the ad loads. The shape refusal is the layer escaping alone cannot
 * be: inside a style attribute even an escaped value may still chain CSS declarations
 * with `;`. Every legitimate caller already passes hex; anything else is a defect.
 */
function safeBrandColor(brandColor: string): string {
  if (!isBrandColor(brandColor)) {
    throw new Error(
      `assembleHtml: brandColor must be a 6-digit hex colour like "#1473E6", got ${JSON.stringify(brandColor)}`,
    );
  }
  return escapeHtml(brandColor);
}

export interface AssembleHtmlOptions {
  readonly elements?: readonly HtmlElement[];
  readonly canvas: CanvasSpec;
  readonly brandColor: string;
  readonly style?: Style;
  /**
   * The variant's tone (HL5f, HL-D8): drives the default font weight exactly
   * as `NodeCanvasCompositor.prepare` derives it for the canvas fallback
   * (`toneFontWeight`) — a style-supplied `fontWeight` still overrides it.
   * Absent → `DEFAULT_TREATMENT.tone` ("bold"), the pre-HL5f literal, so an
   * omitted tone renders exactly what this function always rendered.
   */
  readonly tone?: ToneKind;
  readonly clickDestination?: string;
  /** Platform profile or budget. When present, weight is verified against profile.maxBytes (HL-D6). */
  readonly profile?: { readonly maxBytes: number };
  /** Relative path to fallback image for image elements (defaults to "fallback.png"). */
  readonly fallbackImageSrc?: string;
}

export interface AssembledHtml {
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

/**
 * Assembles an HTML creative unit from an element list and brand styling.
 */
export function assembleHtml(options: AssembleHtmlOptions): AssembledHtml {
  const { width, height } = resolveCanvas(options.canvas);
  // HL5f: the default weight is tone-derived, exactly as the canvas fallback
  // derives it — not the hard-coded "bold" this line used to read regardless
  // of tone (HL-D8's gap). Absent tone → DEFAULT_TREATMENT.tone, the same
  // "bold" this function always defaulted to.
  const resolvedStyle = resolveStyle(
    options.style,
    toneFontWeight(options.tone ?? DEFAULT_TREATMENT.tone),
    DEFAULT_STYLE.fontFamily,
  );
  const elements = options.elements ?? [];
  const brandColor = safeBrandColor(options.brandColor);
  const clickDestination = options.clickDestination;
  const profile = options.profile;
  const fallbackImageSrc = options.fallbackImageSrc ?? "fallback.png";

  const headScripts: string[] = [];
  if (clickDestination !== undefined) {
    headScripts.push(
      `<script>var ${CLICK_TAG_VARIABLE} = ${escapeScriptJson(JSON.stringify(clickDestination))};</script>`,
    );
  }

  const elementMarkup: string[] = [];

  for (const element of elements) {
    const boxX = element.frame.x * width;
    const boxY = element.frame.y * height;
    const boxW = element.frame.w * width;
    const boxH = element.frame.h * height;

    const baseStyle = `position: absolute; left: ${boxX}px; top: ${boxY}px; width: ${boxW}px; height: ${boxH}px; box-sizing: border-box;`;

    switch (element.kind) {
      case "button": {
        const radius = Math.min(8, boxH / 2, boxW / 2);
        // HL5f: the same function the canvas drawer calls — `htmlButtonFontSize`.
        const fontSize = htmlButtonFontSize(boxH, scaleBasis(options.canvas, width, height));
        const navAttr =
          clickDestination !== undefined
            ? ` onclick="window.open(window.${CLICK_TAG_VARIABLE})"`
            : "";
        const cursor = clickDestination !== undefined ? "cursor: pointer;" : "";
        const buttonStyle = `${baseStyle} background-color: ${brandColor}; border-radius: ${radius}px; color: #ffffff; font-family: ${resolvedStyle.fontFamily}, sans-serif; font-weight: ${resolvedStyle.fontWeight}; font-size: ${fontSize}px; text-align: center; display: flex; align-items: center; justify-content: center; border: none; padding: 0; overflow: hidden; ${cursor}`;
        const text = escapeHtml(element.text ?? "");
        elementMarkup.push(
          `<button type="button" style="${buttonStyle}"${navAttr}>${text}</button>`,
        );
        break;
      }
      case "text": {
        // HL5f: font size, line height (px) and letter spacing (px) come from
        // the same function the canvas drawer calls — `htmlTextGeometry`.
        const { fontSize, lineHeight, letterSpacing } = htmlTextGeometry({
          boxH,
          canvasBasis: scaleBasis(options.canvas, width, height),
          sizeScale: resolvedStyle.sizeScale,
          lineHeight: resolvedStyle.lineHeight,
          letterSpacing: resolvedStyle.letterSpacing,
        });
        // HL5f: an explicit `padding-top`, not CSS flex `justify-content` —
        // the same shared offset the canvas drawer places its baseline from
        // (`htmlTextFirstLineOffset`), converted to a padding by
        // `htmlTextPaddingTop`. The markup cannot wrap text itself (no
        // browser, D122), so it always passes a line count of 1 — exact for
        // `top`, the single-line case for `middle`/`bottom` (see
        // `htmlTextFirstLineOffset`'s doc comment for the residual on
        // multi-line wrapped text).
        const paddingTop = htmlTextPaddingTop(element.frame.anchor, boxH, fontSize, lineHeight, 1);
        const textStyle = `${baseStyle} color: #ffffff; font-family: ${resolvedStyle.fontFamily}, sans-serif; font-weight: ${resolvedStyle.fontWeight}; font-size: ${fontSize}px; letter-spacing: ${letterSpacing}px; line-height: ${lineHeight}px; text-align: ${resolvedStyle.align}; padding-top: ${paddingTop}px; overflow: hidden;`;
        const text = escapeHtml(element.text ?? "");
        elementMarkup.push(`<div style="${textStyle}">${text}</div>`);
        break;
      }
      case "image": {
        const imgStyle = "display: block; width: 100%; height: 100%; object-fit: cover;";
        const src = escapeHtml(fallbackImageSrc);
        elementMarkup.push(
          `<div style="${baseStyle}"><img src="${src}" style="${imgStyle}" alt="" /></div>`,
        );
        break;
      }
    }
  }

  const scriptSection = headScripts.length > 0 ? `\n    ${headScripts.join("\n    ")}` : "";

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">${scriptSection}
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
      }
      #ad-container {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="ad-container">
      ${elementMarkup.join("\n      ")}
    </div>
  </body>
</html>\n`;

  const bytes = new TextEncoder().encode(html);

  if (profile !== undefined && bytes.length > profile.maxBytes) {
    const overage = bytes.length - profile.maxBytes;
    throw new Error(
      `HTML bundle weight (${bytes.length} bytes) exceeds profile.maxBytes budget (${profile.maxBytes} bytes) with overage of ${overage} bytes`,
    );
  }

  return {
    html,
    bytes,
    byteLength: bytes.length,
  };
}
