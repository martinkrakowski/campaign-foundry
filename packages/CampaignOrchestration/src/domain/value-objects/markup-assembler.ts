/**
 * The markup assembler (HL4, AR2).
 *
 * Produces a self-contained HTML creative unit from the template's layers.
 * Copy is a `static-text` layer, pictures are `image` and `logo` layers, and
 * a linked layer is a `<button>` that opens `window.clickTag`. Every other
 * kind stays in the raster and emits nothing here.
 *
 * Key invariants:
 * 1. `clickDestination`: absent or `""` emits no `clickTag` and no onclick.
 *    A present value that is not an absolute http(s) URL is refused. A valid
 *    one emits one `var clickTag` declaration in the head, never an `<a href>`.
 * 2. Weight budget (HL-D6): measured against `profile.maxBytes` when a profile
 *    is provided; refused over budget with an error naming both the budget and
 *    the overage.
 * 3. Content safety (HL-D7): every interpolation is escaped for its context —
 *    HTML text and quoted attributes are HTML-escaped, the clickTag script
 *    declaration uses `\uXXXX` escapes (entities would corrupt the JS string),
 *    and the brand colour is additionally refused unless it is the documented
 *    6-digit hex shape.
 */

import { resolveCanvas, type CanvasSpec } from "./aspect-ratios.js";
import { CLICK_TAG_VARIABLE, isAbsoluteUrl } from "./click-destination.js";
import type { Style } from "./creative-style.js";
import type { CreativeTemplateLayer } from "./creative-templates.js";
import type { ToneKind } from "./Treatment.vo.js";

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
  return json.replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/&/g, "\\u0026");
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
  readonly layers: readonly CreativeTemplateLayer[];
  /** The campaign copy a `static-text` layer emits. Absent is an empty string. */
  readonly headline?: string;
  readonly canvas: CanvasSpec;
  readonly brandColor: string;
  readonly style?: Style;
  /**
   * Kept on the options so a caller that already resolved a treatment tone
   * can pass it through. Layer markup does not interpolate a font from it.
   */
  readonly tone?: ToneKind;
  readonly clickDestination?: string;
  /** Platform profile or budget. When present, weight is verified against profile.maxBytes (HL-D6). */
  readonly profile?: { readonly maxBytes: number };
  /** Relative path to the image a picture layer emits (defaults to "fallback.png"). */
  readonly fallbackImageSrc?: string;
}

export interface AssembledHtml {
  readonly html: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

const CLICK_OPEN = ` onclick="window.open(window.${CLICK_TAG_VARIABLE})"`;

/** `alt` is the image prop when it is a string; every other shape is empty. */
function layerAlt(layer: CreativeTemplateLayer): string {
  const props = layer.props;
  if (props !== undefined && "alt" in props && typeof props.alt === "string") {
    return escapeHtml(String(props.alt));
  }
  return "";
}

/**
 * The positioned box. A declared frame is canvas fractions in px. Absent, an
 * image fills the canvas and a logo or static-text layer uses the percentage
 * block — still `position: absolute`.
 */
function layerBoxStyle(layer: CreativeTemplateLayer, width: number, height: number): string {
  if (layer.frame !== undefined) {
    const left = layer.frame.x * width;
    const top = layer.frame.y * height;
    const boxW = layer.frame.w * width;
    const boxH = layer.frame.h * height;
    return `position: absolute; left: ${left}px; top: ${top}px; width: ${boxW}px; height: ${boxH}px;`;
  }
  if (layer.kind === "image") {
    return `position: absolute; left: 0px; top: 0px; width: ${width}px; height: ${height}px;`;
  }
  return `position: absolute; left: 5%; top: 10%; width: 90%; height: 30%;`;
}

function pictureMarkup(
  layer: CreativeTemplateLayer,
  box: string,
  src: string,
  hasClick: boolean,
): string {
  const img = `<img src="${src}" alt="${layerAlt(layer)}" />`;
  if (layer.link === true && hasClick) {
    return `<div style="${box}"><button type="button"${CLICK_OPEN}>${img}</button></div>`;
  }
  return `<div style="${box}">${img}</div>`;
}

/**
 * Assembles an HTML creative unit from the template's layers and brand styling.
 */
export function assembleHtml(options: AssembleHtmlOptions): AssembledHtml {
  const { width, height } = resolveCanvas(options.canvas);
  // The shape gate stays even though layer markup does not interpolate the
  // colour: a non-hex value is a defect, not a string to escape into CSS.
  safeBrandColor(options.brandColor);
  const destination = options.clickDestination;
  let scriptSection = "";
  if (destination !== undefined && destination !== "") {
    if (!isAbsoluteUrl(destination)) {
      throw new Error(
        `assembleHtml: clickDestination must be an absolute http(s) URL, got ${JSON.stringify(destination)}`,
      );
    }
    scriptSection = `\n    <script>var ${CLICK_TAG_VARIABLE} = ${escapeScriptJson(JSON.stringify(destination))};</script>`;
  }
  const hasClick = scriptSection !== "";
  const fallbackImageSrc = options.fallbackImageSrc ?? "fallback.png";
  const src = escapeHtml(fallbackImageSrc);
  const copy = escapeHtml(options.headline ?? "");

  const layerMarkup: string[] = [];
  for (const layer of options.layers) {
    if (layer.enabled === false) continue;
    if (layer.kind === "image" || layer.kind === "logo") {
      layerMarkup.push(pictureMarkup(layer, layerBoxStyle(layer, width, height), src, hasClick));
      continue;
    }
    if (layer.kind === "static-text") {
      const box = layerBoxStyle(layer, width, height);
      if (layer.link === true) {
        const nav = hasClick ? CLICK_OPEN : "";
        layerMarkup.push(`<button type="button" style="${box}"${nav}>${copy}</button>`);
      } else {
        layerMarkup.push(`<p style="${box}">${copy}</p>`);
      }
    }
  }

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
      ${layerMarkup.join("\n      ")}
    </div>
  </body>
</html>\n`;

  const bytes = new TextEncoder().encode(html);
  const profile = options.profile;

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
