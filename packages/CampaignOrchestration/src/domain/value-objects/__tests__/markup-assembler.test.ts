import { describe, expect, test } from "vitest";
import type { CreativeTemplateLayer } from "../creative-templates.js";
import { assembleHtml, type AssembleHtmlOptions } from "../markup-assembler.js";

const base = (over: Partial<AssembleHtmlOptions> = {}): AssembleHtmlOptions => ({
  layers: [],
  canvas: { ratio: "1:1" },
  brandColor: "#1473E6",
  ...over,
});

const layer = (
  over: Partial<CreativeTemplateLayer> & Pick<CreativeTemplateLayer, "id" | "kind">,
): CreativeTemplateLayer => over;

const linkedCopy = layer({ id: "copy", kind: "static-text", link: true });

describe("assembleHtml", () => {
  test("a linked static-text layer with an absolute destination emits clickTag and never an anchor", () => {
    const result = assembleHtml(
      base({
        layers: [linkedCopy],
        headline: "Shop",
        clickDestination: "https://example.com/landing-page",
      }),
    );

    expect(result.html).toContain('var clickTag = "https://example.com/landing-page";');
    expect(result.html).toContain("window.open(window.clickTag)");
    expect(result.html).not.toContain("<a");
    expect(result.html).toContain('<button type="button"');
    expect((result.html.match(/<script/g) ?? []).length).toBe(1);
  });

  test("the same layers with no clickDestination emit no clickTag and no window.open", () => {
    const result = assembleHtml(base({ layers: [linkedCopy], headline: "Shop" }));

    expect(result.html).not.toContain("clickTag");
    expect(result.html).not.toContain("window.open");
    expect(result.html).toContain('<button type="button"');
    expect(result.html).not.toContain("onclick");
  });

  test("an empty clickDestination is the same absence: no script and no onclick", () => {
    const result = assembleHtml(
      base({ layers: [linkedCopy], headline: "Shop", clickDestination: "" }),
    );

    expect(result.html).not.toContain("clickTag");
    expect(result.html).not.toContain("window.open");
  });

  test("a javascript clickDestination is refused as a non-absolute http(s) URL", () => {
    expect(() =>
      assembleHtml(base({ layers: [linkedCopy], clickDestination: "javascript:alert(1)" })),
    ).toThrow(
      'assembleHtml: clickDestination must be an absolute http(s) URL, got "javascript:alert(1)"',
    );
  });

  test("a headline that looks like a script is escaped and never raw", () => {
    const result = assembleHtml(
      base({
        layers: [layer({ id: "copy", kind: "static-text" })],
        headline: '<script>alert("xss")</script>',
      }),
    );

    expect(result.html).not.toContain('<script>alert("xss")</script>');
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("<p ");
  });

  test("a clickDestination containing a script close still round-trips through escapeScriptJson", () => {
    const destination = "https://example.com/</script><script>alert(1)</script>";
    const result = assembleHtml(
      base({
        layers: [linkedCopy],
        clickDestination: destination,
      }),
    );

    expect((result.html.match(/<script/g) ?? []).length).toBe(1);
    expect((result.html.match(/<\/script>/g) ?? []).length).toBe(1);
    expect(result.html).toContain("\\u003C/script\\u003E");
    const declaration = /var clickTag = (".*");/.exec(result.html);
    expect(declaration).not.toBeNull();
    expect(JSON.parse(declaration![1] as string)).toBe(destination);
  });

  test("an over-budget bundle names the budget and the overage", () => {
    const within = assembleHtml(base({ layers: [linkedCopy], profile: { maxBytes: 1024 * 1024 } }));
    const maxBytes = 100;
    expect(() => assembleHtml(base({ layers: [linkedCopy], profile: { maxBytes } }))).toThrow(
      `HTML bundle weight (${within.byteLength} bytes) exceeds profile.maxBytes budget (${maxBytes} bytes) with overage of ${within.byteLength - maxBytes} bytes`,
    );
  });

  test("an image layer emits one img of the fallback, and a logo does not repeat that raster", () => {
    const result = assembleHtml(
      base({
        layers: [
          layer({ id: "picture", kind: "image" }),
          layer({ id: "mark", kind: "logo" }),
          layer({ id: "copy", kind: "static-text" }),
        ],
        headline: "Shop",
      }),
    );

    expect(result.html.match(/<img/g)?.length).toBe(1);
    expect(result.html).toContain("fallback.png");
    expect(result.html).toContain("left: 0px; top: 0px; width: 1080px; height: 1080px;");
    expect(result.html).toContain("left: 5%; top: 10%; width: 90%; height: 30%;");
    expect(result.html).toContain(">Shop</p>");
  });

  test("a display-size frame overlay wins over the base fractions", () => {
    const result = assembleHtml(
      base({
        canvas: { size: "300x250" },
        layers: [
          layer({
            id: "picture",
            kind: "image",
            frame: {
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              anchor: "top",
              byFamily: { size: { "300x250": { x: 0.25 } } },
            },
          }),
        ],
      }),
    );

    expect(result.html).toContain("left: 75px;");
    expect(result.html).not.toContain("left: 0px;");
  });

  test("static-text uses the resolved face, not the browser's paragraph defaults", () => {
    const result = assembleHtml(
      base({
        layers: [layer({ id: "copy", kind: "static-text" })],
        headline: "Shop",
        tone: "subtle",
        style: {
          fontFamily: "Lora",
          fontWeight: 700,
          align: "left",
          letterSpacing: 0,
          lineHeight: 1.2,
          sizeScale: 1,
        },
      }),
    );

    expect(result.html).toContain("font-family: Lora, sans-serif");
    expect(result.html).toContain("font-weight: 700");
    expect(result.html).toContain("margin: 0");
    expect(result.html).toContain("color: #ffffff");
  });

  test("a picture layer honours an override src and a string alt, and a non-string alt is empty", () => {
    const named = assembleHtml(
      base({
        layers: [layer({ id: "picture", kind: "image", props: { alt: 'say "hi" <b>' } })],
        fallbackImageSrc: "custom.png",
      }),
    );
    expect(named.html).toContain('src="custom.png"');
    expect(named.html).toContain('alt="say &quot;hi&quot; &lt;b&gt;"');

    const unnamed = assembleHtml(
      base({
        layers: [
          layer({
            id: "picture",
            kind: "image",
            props: { alt: 1 } as CreativeTemplateLayer["props"],
          }),
          layer({ id: "mark", kind: "logo", props: { width: 0.2 } }),
        ],
      }),
    );
    expect(unnamed.html).toContain('alt=""');
    expect(unnamed.html).not.toContain('alt="1"');
  });

  test("a shade layer emits nothing, and so does a disabled picture", () => {
    const empty = assembleHtml(base());
    const shaded = assembleHtml(
      base({
        layers: [
          layer({ id: "scrim", kind: "shade" }),
          layer({ id: "picture", kind: "image", enabled: false }),
          layer({ id: "html", kind: "html" }),
        ],
      }),
    );
    expect(shaded.html).toBe(empty.html);
    expect(shaded.html).not.toContain("<img");
  });

  test("a declared frame is canvas fractions in px, and a linked image opens clickTag", () => {
    const result = assembleHtml(
      base({
        layers: [
          layer({
            id: "picture",
            kind: "image",
            link: true,
            frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.25, anchor: "top" },
          }),
          layer({
            id: "copy",
            kind: "static-text",
            frame: { x: 0, y: 0, w: 1, h: 0.2, anchor: "top" },
          }),
        ],
        headline: "Hi",
        clickDestination: "https://example.com/landing-page",
      }),
    );

    expect(result.html).toContain("left: 108px; top: 216px; width: 540px; height: 270px;");
    expect(result.html).toContain(
      '<div style="position: absolute; left: 108px; top: 216px; width: 540px; height: 270px;"><button type="button" onclick="window.open(window.clickTag)"><img',
    );
    expect(result.html).toContain('<p style="position: absolute; left: 0px;');
    expect(result.html).toContain(">Hi</p>");
  });

  test("a linked image without a destination is not wrapped in a button", () => {
    const result = assembleHtml(
      base({ layers: [layer({ id: "picture", kind: "image", link: true })] }),
    );
    expect(result.html).toContain("<img");
    expect(result.html).not.toContain("<button");
  });

  test("an absent headline on static-text emits an empty paragraph", () => {
    const result = assembleHtml(base({ layers: [layer({ id: "copy", kind: "static-text" })] }));
    expect(result.html).toContain("<p ");
    expect(result.html).toContain("></p>");
  });

  test("a brandColor that is not the documented 6-digit hex shape is refused", () => {
    expect(() =>
      assembleHtml(base({ brandColor: '#fff" autofocus onfocus="alert(1)' })),
    ).toThrowError(/assembleHtml: brandColor must be a 6-digit hex colour/);
  });

  test("a bundle within budget returns html whose byteLength matches the encoded bytes", () => {
    const result = assembleHtml(base({ profile: { maxBytes: 1024 * 1024 } }));
    expect(result.bytes.length).toBe(result.byteLength);
    expect(result.byteLength).toBeLessThanOrEqual(1024 * 1024);
  });
});
