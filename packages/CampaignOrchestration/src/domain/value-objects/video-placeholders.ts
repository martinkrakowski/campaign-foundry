import { VIDEO_RENDER_PATTERN, type VideoProps } from "./brief-template.js";
import type { CreativeTemplateLayer } from "./creative-templates.js";

/**
 * Generate-time video placeholder URLs (CFAR6C2).
 *
 * An `image-html` bundle with an enabled `video` layer needs a `src` the
 * browser can parse at generate time, but the packaged renditions do not
 * exist until publish. The bundle therefore carries a **placeholder** URL —
 * deterministic, non-resolvable (`publish.invalid` never resolves), and
 * keyed by the layer's own `render` selector. Publish-time tooling swaps the
 * placeholders for real CDN URLs; nothing here publishes or exports.
 *
 * The selector is embedded **verbatim** — no percent-encoding — so the
 * placeholder is exactly `prefix + selector` and the selector survives a
 * byte-for-byte round trip through `findVideoPlaceholders`. The render
 * pattern already forbids every delimiter the finder stops at, so the two
 * directions cannot disagree about where a token ends.
 */

/** Every placeholder URL starts with this non-resolvable prefix. */
export const PUBLISH_PLACEHOLDER_URL_PREFIX = "https://publish.invalid/";

/** A `video` layer's `render` selector is not a string the pattern accepts. */
export class InvalidVideoSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoSelectorError";
  }
}

/**
 * A brief-authored free-text field carries the publish placeholder prefix
 * (CFAR6 fix2). The prefix is the assembler's own token — the only thing that
 * may ever carry it into a bundle is the `<video src>` the assembler itself
 * emits. A headline, alt or clickTag that names it is a brief trying to route
 * text through the publish path, so it is refused with the field named, never
 * silently stripped.
 */
export class BriefPlaceholderPrefixError extends Error {
  constructor(field: string) {
    super(
      `${field} must not contain the video placeholder prefix "${PUBLISH_PLACEHOLDER_URL_PREFIX}" — a placeholder URL belongs to the assembler's own video markup, never to brief-authored text.`,
    );
    this.name = "BriefPlaceholderPrefixError";
  }
}

/**
 * Refuse a brief-authored free-text value that carries the publish placeholder
 * prefix. `field` names the field in the error — the caller spells it the way
 * its own messages do (`template.layers[0].props.alt`, `campaignMessage`, …).
 */
export function refusePlaceholderPrefix(field: string, value: string): void {
  if (typeof value === "string" && value.includes(PUBLISH_PLACEHOLDER_URL_PREFIX)) {
    throw new BriefPlaceholderPrefixError(field);
  }
}

/** A placeholder token found in generated HTML is not a valid selector. */
export class InvalidVideoPlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoPlaceholderError";
  }
}

/**
 * The placeholder URL for a `render` selector: prefix + selector, verbatim.
 * Refuses anything the render pattern does not accept — the finder reads the
 * selector back out of the HTML, so a sloppy selector here would come back
 * as an unparseable token there.
 */
export function videoPlaceholderUrl(selector: string): string {
  if (typeof selector !== "string" || !VIDEO_RENDER_PATTERN.test(selector)) {
    throw new InvalidVideoSelectorError(
      `videoPlaceholderUrl: selector must match <product>/<ratio>/v<n>.mp4 (e.g. "shoe/1x1/v0.mp4"), got ${JSON.stringify(selector)}`,
    );
  }
  return PUBLISH_PLACEHOLDER_URL_PREFIX + selector;
}

/**
 * The `videoSources` map for the enabled `video` layers of a template: each
 * enabled layer's `render` selector keyed to the SLOT's own placeholder URL.
 *
 * **The URL never derives from the brief's `render` (CFAR6-slot).** Every
 * slot renders exactly one clip of its own — `<product>/<ratio>/v<n>.mp4` —
 * and that is what `slotSelector` carries, derived by the caller from the
 * slot itself. The brief's `render` only selects WHICH layer is the video:
 * it keys the map (the assembler looks each layer up by it) but is validated
 * and otherwise ignored, so a render pointing at another mp4 of the campaign
 * cannot make the bundle reference — and export cannot publish — anything
 * but this slot's own clip.
 *
 * `slotSelector` must itself match the render pattern: `findVideoPlaceholders`
 * reads the URL back out of the generated HTML, so a malformed one is a
 * refusal here, never a bundle that publish-time tooling cannot parse. Absent
 * — `undefined` — when no enabled `video` layer is present, so callers spread
 * it conditionally and non-video bundles stay byte-identical to the
 * pre-video assembler. A disabled `video` layer contributes nothing (the
 * assembler skips it too). Invalid selectors throw — a bad render is a
 * refusal, never a silent omission or a partial map.
 */
export function collectVideoPlaceholderSources(
  layers: readonly CreativeTemplateLayer[],
  slotSelector: string,
): Readonly<Record<string, string>> | undefined {
  const url = videoPlaceholderUrl(slotSelector);
  const sources: Record<string, string> = {};
  let sawVideo = false;
  for (const layer of layers) {
    if (layer.kind !== "video" || layer.enabled === false) continue;
    sawVideo = true;
    const render = (layer.props as VideoProps | undefined)?.render;
    // `render` is typed `string` but a programmatic layer can carry anything;
    // the pattern check refuses it rather than trusting the type. It keys the
    // map only — the URL above carries the slot's own clip key (CFAR6-slot).
    if (typeof render !== "string" || !VIDEO_RENDER_PATTERN.test(render)) {
      throw new InvalidVideoSelectorError(
        `collectVideoPlaceholderSources: video layer render must match <product>/<ratio>/v<n>.mp4 (e.g. "shoe/1x1/v0.mp4"), got ${JSON.stringify(render)}`,
      );
    }
    sources[render] = url;
  }
  if (!sawVideo) return undefined;
  return sources;
}

/**
 * The `render` selectors whose placeholders appear in the `<video src>`
 * attributes a bundle carries, in order of first appearance, deduped. The
 * complement of {@link collectVideoPlaceholderSources} — publish-time tooling
 * reads the bundle, finds every placeholder, and swaps it. Malformed tokens (a
 * wrong prefix tail, a selector the render pattern refuses) throw rather than
 * returning a partial list, and non-string input is a refusal, not an empty
 * scan.
 *
 * **Only the `src` of a `<video>` element is scanned — never the whole
 * bundle (CFAR6 fix2).** Headline, alt and clickTag text are brief-authored,
 * so a bundle-wide scan let a brief that put a placeholder URL in its copy
 * have that OTHER clip published. The assembler HTML-escapes every
 * brief-authored interpolation (HL-D7), so brief text cannot inject a literal
 * `<video` tag or a `src` attribute into the markup — an escaped
 * `&lt;video src=…` in text, or a placeholder URL in an `alt`, a `clickTag`
 * declaration or a link, is not a video element and is never scanned. The
 * scan is therefore a strict, parser-free read of the exact shape the
 * assembler emits: `<video` … `src="…"`, with the token's vocabulary
 * (`[a-z0-9-]`, `/`, `.`) excluding whitespace, quotes, angle brackets and
 * `&`, so the attribute value ends exactly at the closing quote.
 */
export function findVideoPlaceholders(html: string): readonly string[] {
  if (typeof html !== "string") {
    throw new InvalidVideoPlaceholderError(
      `findVideoPlaceholders: html must be a string, got ${typeof html}`,
    );
  }
  const videoSrcPattern = /<video\b[^>]*?\bsrc="([^"]*)"/g;
  const selectors: string[] = [];
  for (const match of html.matchAll(videoSrcPattern)) {
    const src = match[1]!;
    if (!src.startsWith(PUBLISH_PLACEHOLDER_URL_PREFIX)) continue;
    const selector = src.slice(PUBLISH_PLACEHOLDER_URL_PREFIX.length);
    if (selector === "" || !VIDEO_RENDER_PATTERN.test(selector)) {
      throw new InvalidVideoPlaceholderError(
        `findVideoPlaceholders: malformed video placeholder token ${JSON.stringify(selector)} after ${PUBLISH_PLACEHOLDER_URL_PREFIX}`,
      );
    }
    if (!selectors.includes(selector)) selectors.push(selector);
  }
  return selectors;
}
