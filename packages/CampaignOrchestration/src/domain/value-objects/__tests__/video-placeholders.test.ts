import { describe, test, expect } from "vitest";
import {
  collectVideoPlaceholderSources,
  findVideoPlaceholders,
  InvalidVideoPlaceholderError,
  InvalidVideoSelectorError,
  PUBLISH_PLACEHOLDER_URL_PREFIX,
  videoPlaceholderUrl,
} from "../video-placeholders.js";
import type { CreativeTemplateLayer } from "../creative-templates.js";

const videoLayer = (over: Partial<CreativeTemplateLayer> = {}): CreativeTemplateLayer => ({
  id: "video-1",
  kind: "video",
  props: { render: "shoe/1x1/v0.mp4" },
  ...over,
});

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

  test("extracts the selector from a placeholder embedded in an attribute, stopping at the quote", () => {
    const html = `<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4" muted autoplay></video>`;
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4"]);
  });

  test("returns distinct selectors in order of first appearance, deduping repeats", () => {
    const html = [
      `src="${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4"`,
      `src="${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/9x16/v1.mp4"`,
      `src="${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4"`,
    ].join(" ");
    expect(findVideoPlaceholders(html)).toEqual(["shoe/1x1/v0.mp4", "shoe/9x16/v1.mp4"]);
  });

  test("stops a bare token at whitespace and at end of string", () => {
    expect(
      findVideoPlaceholders(`${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mp4 trailing`),
    ).toEqual(["shoe/1x1/v0.mp4"]);
    expect(findVideoPlaceholders(`${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/9x16/v1.mp4`)).toEqual([
      "shoe/9x16/v1.mp4",
    ]);
  });

  test.each([
    ["an empty token (prefix at end of string)", `${PUBLISH_PLACEHOLDER_URL_PREFIX}`],
    ["a malformed selector", `${PUBLISH_PLACEHOLDER_URL_PREFIX}bad-selector`],
    ["a selector with a bad extension", `${PUBLISH_PLACEHOLDER_URL_PREFIX}shoe/1x1/v0.mov`],
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
