import { describe, test, expect } from "vitest";
import {
  BriefPlaceholderPrefixError,
  collectVideoPlaceholderSources,
  findVideoPlaceholders,
  InvalidVideoPlaceholderError,
  InvalidVideoSelectorError,
  PUBLISH_PLACEHOLDER_URL_PREFIX,
  refusePlaceholderPrefix,
  videoPlaceholderUrl,
} from "../video-placeholders.js";
import type { CreativeTemplateLayer } from "../creative-templates.js";

const videoLayer = (over: Partial<CreativeTemplateLayer> = {}): CreativeTemplateLayer => ({
  id: "video-1",
  kind: "video",
  props: { render: "shoe/1x1/v0.mp4" },
  ...over,
});

/** The `<video src="…">` element the assembler itself emits. */
const videoSrc = (selector: string): string =>
  `<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}${selector}" muted autoplay></video>`;

describe("videoPlaceholderUrl", () => {
  test("prefixes the selector verbatim — slashes are never percent-encoded", () => {
    expect(videoPlaceholderUrl("shoe/1x1/v0.mp4")).toBe("https://publish.invalid/shoe/1x1/v0.mp4");
    expect(videoPlaceholderUrl("hero-brand/9x16/v12.mp4")).toBe(
      "https://publish.invalid/hero-brand/9x16/v12.mp4",
    );
  });

  test.each([
    ["an empty selector", ""],
    ["a non-string selector", 42 as unknown as string],
    ["a selector missing the ratio segment", "shoe/v0.mp4"],
    ["a selector missing the version", "shoe/1x1/v.mp4"],
    ["a URL-encoded selector", "shoe/1x1/v0%2F.mp4"],
    ["a selector with a bad extension", "shoe/1x1/v0.mov"],
  ])("refuses %s with InvalidVideoSelectorError", (_label, selector) => {
    expect(() => videoPlaceholderUrl(selector)).toThrow(InvalidVideoSelectorError);
  });
});

describe("collectVideoPlaceholderSources", () => {
  test("keys each enabled video layer's render selector to the SLOT's own placeholder URL", () => {
    // CFAR6-slot: the URL carries the slot's clip key (passed by the caller),
    // never the brief's render — both layers here resolve to the same slot.
    const sources = collectVideoPlaceholderSources(
      [videoLayer({ id: "v-1" }), videoLayer({ id: "v-2", props: { render: "shoe/9x16/v1.mp4" } })],
      "shoe/1x1/v0.mp4",
    );
    expect(sources).toEqual({
      "shoe/1x1/v0.mp4": "https://publish.invalid/shoe/1x1/v0.mp4",
      "shoe/9x16/v1.mp4": "https://publish.invalid/shoe/1x1/v0.mp4",
    });
  });

  test("the render selector never influences the URL, however path-like it is", () => {
    // A brief pointing at another mp4 of the same campaign cannot make the
    // bundle reference that other clip: only the slot's own key is embedded.
    const sources = collectVideoPlaceholderSources(
      [videoLayer({ props: { render: "other/9x16/v7.mp4" } })],
      "shoe/1x1/v0.mp4",
    );
    expect(sources).toEqual({
      "other/9x16/v7.mp4": "https://publish.invalid/shoe/1x1/v0.mp4",
    });
  });

  test("refuses a slot selector the render pattern does not accept", () => {
    for (const slotSelector of ["", "shoe/1x1/v0.mov", "shoe/1x1/v.mp4", "../etc/passwd.mp4"]) {
      expect(() => collectVideoPlaceholderSources([videoLayer()], slotSelector)).toThrow(
        InvalidVideoSelectorError,
      );
    }
  });

  test("refuses a non-string slot selector", () => {
    expect(() => collectVideoPlaceholderSources([videoLayer()], 42 as unknown as string)).toThrow(
      InvalidVideoSelectorError,
    );
  });

  test("returns undefined when no layer is a video layer", () => {
    expect(
      collectVideoPlaceholderSources(
        [
          { id: "image", kind: "image" },
          { id: "shade", kind: "shade" },
        ],
        "shoe/1x1/v0.mp4",
      ),
    ).toBeUndefined();
  });

  test("returns undefined when every video layer is disabled — a disabled layer is skipped, not collected", () => {
    expect(
      collectVideoPlaceholderSources([videoLayer({ enabled: false })], "shoe/1x1/v0.mp4"),
    ).toBeUndefined();
  });

  test("skips disabled video layers but keeps the enabled ones", () => {
    const sources = collectVideoPlaceholderSources(
      [
        videoLayer({ id: "off", enabled: false }),
        videoLayer({ id: "on", props: { render: "shoe/16x9/v2.mp4" } }),
      ],
      "shoe/1x1/v0.mp4",
    );
    expect(sources).toEqual({
      "shoe/16x9/v2.mp4": "https://publish.invalid/shoe/1x1/v0.mp4",
    });
  });

  test("propagates a throwing props getter rather than returning a partial map", () => {
    const hostile = { id: "hostile", kind: "video" } as CreativeTemplateLayer;
    Object.defineProperty(hostile, "props", {
      get() {
        throw new Error("props getter exploded");
      },
    });
    expect(() => collectVideoPlaceholderSources([hostile], "shoe/1x1/v0.mp4")).toThrow(
      "props getter exploded",
    );
  });

  test("throws InvalidVideoSelectorError on an invalid render rather than returning undefined", () => {
    expect(() =>
      collectVideoPlaceholderSources(
        [videoLayer({ props: { render: "shoe/1x1/v0.mov" } })],
        "shoe/1x1/v0.mp4",
      ),
    ).toThrow(InvalidVideoSelectorError);
  });
});

describe("findVideoPlaceholders", () => {
  test("returns an empty list when no prefix is present", () => {
    expect(findVideoPlaceholders('<html><body><img src="fallback.png" /></body></html>')).toEqual(
      [],
    );
    expect(findVideoPlaceholders("")).toEqual([]);
  });

  test("extracts the selector from the src attribute of an emitted video element", () => {
    const html = `<html><body>${videoSrc("shoe/1x1/v0.mp4")}</body></html>`;
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4"]);
  });

  test("returns distinct selectors in order of first appearance, deduping repeats", () => {
    const html = [
      videoSrc("shoe/1x1/v0.mp4"),
      videoSrc("shoe/9x16/v1.mp4"),
      videoSrc("shoe/1x1/v0.mp4"),
    ].join("\n");
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4", "shoe/9x16/v1.mp4"]);
  });

  test("scans ONLY the src attribute of emitted video elements — a bare token is never scanned", () => {
    // The fix's core: the finder trusts only what the assembler itself emitted.
    expect(findVideoPlaceholders(`${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4`)).toEqual([]);
    expect(
      findVideoPlaceholders(`text ${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4 trailing`),
    ).toEqual([]);
    expect(
      findVideoPlaceholders(`<img src="${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4" />`),
    ).toEqual([]);
  });

  test("an escaped &lt;video src=… in text is never scanned — brief text cannot inject a video element", () => {
    // The assembler HTML-escapes brief text (HL-D7), so a headline carrying
    // `<video src="https://publish.invalid/…">` reaches the bundle as
    // `&lt;video src=…` — markup, not an element. Nothing is published.
    const headline = `<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4"></video>`;
    const escaped = headline
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    expect(escaped).not.toContain("<video");
    expect(findVideoPlaceholders(`<span>${escaped}</span>`)).toEqual([]);
  });

  test("a placeholder URL in alt text, a clickTag declaration or a link is never scanned", () => {
    const html = [
      `<img src="fallback.png" alt="${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4" />`,
      `<script>var clickTag = "https://example.com/?u=${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4";</script>`,
      `<a href="${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4">landing</a>`,
      videoSrc("shoe/1x1/v0.mp4"),
    ].join("\n");
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4"]);
  });

  test("a placeholder URL in another element's src attribute is never scanned", () => {
    const html = `<img src="${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4" />${videoSrc("shoe/1x1/v0.mp4")}`;
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4"]);
  });

  test.each([
    ["an empty token (prefix at end of string)", videoSrc("")],
    ["a malformed selector", videoSrc("bad-selector")],
    ["a selector with a bad extension", videoSrc("shoe/1x1/v0.mov")],
  ])("refuses %s with InvalidVideoPlaceholderError", (_label, html) => {
    expect(() => findVideoPlaceholders(html)).toThrow(InvalidVideoPlaceholderError);
  });

  test.each([
    ["null", null as unknown as string],
    ["undefined", undefined as unknown as string],
  ])("refuses non-string input (%s) instead of returning an empty scan", (_label, html) => {
    expect(() => findVideoPlaceholders(html)).toThrow(InvalidVideoPlaceholderError);
  });
});

describe("refusePlaceholderPrefix", () => {
  test("refuses brief-authored text carrying the prefix, naming the field", () => {
    const field = 'Campaign brief field "campaignMessage"';
    const text = `Buy now ${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4`;
    expect(() => refusePlaceholderPrefix(field, text)).toThrow(BriefPlaceholderPrefixError);
    expect(() => refusePlaceholderPrefix(field, text)).toThrowError(/campaignMessage/);
    expect(() => refusePlaceholderPrefix(field, text)).toThrowError(/publish\.invalid/);
  });

  test("prefix-free text is accepted", () => {
    expect(() =>
      refusePlaceholderPrefix('Campaign brief field "campaignMessage"', "Buy now"),
    ).not.toThrow();
    expect(() => refusePlaceholderPrefix("alt", "")).not.toThrow();
  });
});
