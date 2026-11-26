import { describe, expect, test } from "vitest";
import { defaultLayerRect } from "../creative-geometry.js";
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

    const defaultRect = defaultLayerRect("static-text");
    expect(result.html).toContain(`top: ${defaultRect.y * 1080}px;`);
    expect(result.html).toContain(`height: ${defaultRect.h * 1080}px;`);
    expect(result.html).toContain("<span");
    expect(result.html).toContain("overflow: hidden;");
    expect(result.html).not.toContain(">Shop</button>");
    expect(result.html).not.toContain("5%");
  });

  test("the same layers with no clickDestination emit no clickTag and no window.open", () => {
    const result = assembleHtml(base({ layers: [linkedCopy], headline: "Shop" }));

    expect(result.html).not.toContain("clickTag");
    expect(result.html).not.toContain("window.open");
    expect(result.html).toContain('<button type="button"');
    expect(result.html).not.toContain("onclick");

    const defaultRect = defaultLayerRect("static-text");
    expect(result.html).toContain(`top: ${defaultRect.y * 1080}px;`);
    expect(result.html).toContain(`height: ${defaultRect.h * 1080}px;`);
    expect(result.html).toContain("<span");
    expect(result.html).toContain("overflow: hidden;");
    expect(result.html).not.toContain(">Shop</button>");
    expect(result.html).not.toContain("5%");
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
        layers: [
          layer({ id: "picture", kind: "image" }),
          layer({ id: "copy", kind: "static-text" }),
        ],
        headline: '<script>alert("xss")</script>',
      }),
    );

    expect(result.html).not.toContain('<script>alert("xss")</script>');
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toContain("<p");
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
    expect(result.html).toContain('alt="Shop"');
    expect(result.html).not.toContain("<p");
    expect(result.html).not.toContain("5%");
    expect(result.html).not.toContain(">Shop</p>");
  });

  test("unlinked static-text emits no paragraph", () => {
    const result = assembleHtml(
      base({
        layers: [
          layer({ id: "picture", kind: "image" }),
          layer({ id: "copy", kind: "static-text" }),
        ],
        headline: "Shop",
      }),
    );

    expect(result.html).not.toContain("<p");
    expect(result.html).not.toContain(">Shop</p>");
  });

  test("linked image with unlinked copy has one button", () => {
    const result = assembleHtml(
      base({
        layers: [
          layer({ id: "picture", kind: "image", link: true }),
          layer({ id: "copy", kind: "static-text" }),
        ],
        headline: "Shop",
        clickDestination: "https://example.com/landing-page",
      }),
    );

    expect((result.html.match(/<button/g) ?? []).length).toBe(1);
    expect(result.html).toContain(
      '<button type="button" onclick="window.open(window.clickTag)"><img',
    );
    expect(result.html).not.toContain("<p");
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

  test("linked static-text uses a display-size frame overlay", () => {
    const result = assembleHtml(
      base({
        canvas: { size: "300x250" },
        clickDestination: "https://example.com/landing-page",
        layers: [
          layer({
            id: "copy",
            kind: "static-text",
            link: true,
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
        headline: "Shop",
      }),
    );

    expect(result.html).toContain("left: 75px;");
    expect(result.html).not.toContain("top: 108px");
    expect(result.html).not.toContain("5%");
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

    expect(result.html).not.toContain("<p");
    expect(result.html).not.toContain("Lora");
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

  test("image alt wins over the headline", () => {
    const result = assembleHtml(
      base({
        layers: [layer({ id: "picture", kind: "image", props: { alt: "Pack" } })],
        headline: "Shop",
      }),
    );

    expect(result.html).toContain('alt="Pack"');
    expect(result.html).not.toContain('alt="Shop"');
  });

  test("a shade layer emits nothing, and so does a disabled picture", () => {
    const empty = assembleHtml(base());
    const shaded = assembleHtml(
      base({
        layers: [
          layer({ id: "scrim", kind: "shade" }),
          layer({ id: "picture", kind: "image", enabled: false }),
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
    expect(result.html).toContain('alt="Hi"');
    expect(result.html).not.toContain("<p");
    expect(result.html).not.toContain(">Hi</p>");
  });

  test("a linked image without a destination is not wrapped in a button", () => {
    const result = assembleHtml(
      base({ layers: [layer({ id: "picture", kind: "image", link: true })] }),
    );
    expect(result.html).toContain("<img");
    expect(result.html).not.toContain("<button");
  });

  test("an absent headline on static-text emits no paragraph and image alt is empty", () => {
    const result = assembleHtml(
      base({
        layers: [
          layer({ id: "picture", kind: "image" }),
          layer({ id: "copy", kind: "static-text" }),
        ],
      }),
    );
    expect(result.html).not.toContain("<p");
    expect(result.html).toContain('alt=""');
  });

  test("box pixels are rounded to hundredths, so 0.82 of 250 prints as 205, not 205.00000000000003", () => {
    const { html } = assembleHtml(
      base({
        canvas: { size: "300x250" },
        layers: [layer({ id: "copy", kind: "static-text", link: true })],
        headline: "Hi",
      }),
    );
    expect(html).toContain("top: 25px; width: 300px; height: 205px;");
    expect(html).not.toMatch(/\d\.\d{3,}px/);
  });

  test("the head declares the resolved canvas as ad.size, which Google Ads requires", () => {
    for (const [size, width, height] of [
      ["300x250", 300, 250],
      ["728x90", 728, 90],
      ["160x600", 160, 600],
    ] as const) {
      const { html } = assembleHtml(base({ canvas: { size } }));
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head.match(/<meta name="ad\.size"[^>]*>/g), size).toEqual([
        `<meta name="ad.size" content="width=${width},height=${height}">`,
      ]);
    }
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

describe("assembleHtml video layer (D134's video half)", () => {
  const videoLayer = (over: Partial<CreativeTemplateLayer> = {}): CreativeTemplateLayer =>
    layer({
      id: "video",
      kind: "video",
      props: { render: "hero/1x1/v1.mp4" },
      ...over,
    });

  test("a video layer emits a muted autoplaying video with the poster fallback", () => {
    const result = assembleHtml(
      base({
        layers: [videoLayer()],
        videoSources: { "hero/1x1/v1.mp4": "https://cdn.example.com/hero/1x1/v1.mp4" },
      }),
    );
    expect(result.html).toContain(
      '<video src="https://cdn.example.com/hero/1x1/v1.mp4" muted autoplay playsinline poster="fallback.png"></video>',
    );
    expect(result.html).toContain("left: 0px; top: 0px; width: 1080px; height: 1080px;");
  });

  test("a loop prop emits the loop attribute", () => {
    const result = assembleHtml(
      base({
        layers: [videoLayer({ props: { render: "hero/1x1/v1.mp4", loop: true } })],
        videoSources: { "hero/1x1/v1.mp4": "https://cdn.example.com/hero/1x1/v1.mp4" },
      }),
    );
    expect(result.html).toContain("muted autoplay playsinline loop");
  });

  test("a loop prop that is not exactly true emits no loop attribute", () => {
    const result = assembleHtml(
      base({
        layers: [videoLayer({ props: { render: "hero/1x1/v1.mp4", loop: false } })],
        videoSources: { "hero/1x1/v1.mp4": "https://cdn.example.com/hero/1x1/v1.mp4" },
      }),
    );
    expect(result.html).toContain("muted autoplay playsinline poster=");
  });

  test("videoPreview emits nothing and requires neither render nor videoSources", () => {
    const result = assembleHtml(
      base({
        layers: [videoLayer({ props: undefined }), videoLayer({ id: "video-2", props: undefined })],
        videoPreview: true,
      }),
    );
    expect(result.html).not.toContain("<video");
  });

  test("a video layer with no render selector is refused", () => {
    expect(() =>
      assembleHtml(
        base({
          layers: [videoLayer({ props: undefined })],
          videoSources: { "hero/1x1/v1.mp4": "https://cdn.example.com/hero/1x1/v1.mp4" },
        }),
      ),
    ).toThrow('assembleHtml: video layer "video" is missing a render selector');
    expect(() =>
      assembleHtml(
        base({
          layers: [videoLayer({ props: { render: "" } })],
          videoSources: { "hero/1x1/v1.mp4": "https://cdn.example.com/hero/1x1/v1.mp4" },
        }),
      ),
    ).toThrow('assembleHtml: video layer "video" is missing a render selector');
  });

  test("a video layer with no videoSources entry for its render is refused", () => {
    expect(() =>
      assembleHtml(
        base({
          layers: [videoLayer()],
        }),
      ),
    ).toThrow(
      'assembleHtml: video layer "video" has no entry in videoSources for "hero/1x1/v1.mp4"',
    );
    expect(() =>
      assembleHtml(
        base({
          layers: [videoLayer()],
          videoSources: { "other/1x1/v1.mp4": "https://cdn.example.com/other/1x1/v1.mp4" },
        }),
      ),
    ).toThrow(
      'assembleHtml: video layer "video" has no entry in videoSources for "hero/1x1/v1.mp4"',
    );
  });

  test("a videoSources entry that is not an absolute http(s) URL is refused", () => {
    for (const url of ["javascript:alert(1)", "data:video/mp4;base64,AAAA", "/hero/1x1/v1.mp4"]) {
      expect(
        () =>
          assembleHtml(
            base({
              layers: [videoLayer()],
              videoSources: { "hero/1x1/v1.mp4": url },
            }),
          ),
        url,
      ).toThrow(
        `assembleHtml: videoSources["hero/1x1/v1.mp4"] must be an absolute http(s) URL, got ${JSON.stringify(url)}`,
      );
    }
  });

  test("a quote in a videoSources URL is escaped in the markup", () => {
    const result = assembleHtml(
      base({
        layers: [videoLayer()],
        videoSources: {
          "hero/1x1/v1.mp4": 'https://cdn.example.com/hero/1x1/v1.mp4?token="x"',
        },
      }),
    );
    expect(result.html).toContain(
      '<video src="https://cdn.example.com/hero/1x1/v1.mp4?token=&quot;x&quot;"',
    );
  });

  test("a video layer is measured against the byte budget exactly like any other markup", () => {
    const options = base({
      layers: [videoLayer()],
      videoSources: {
        "hero/1x1/v1.mp4":
          "https://cdn.example.com/creatives/renditions/hero/1x1/v1.mp4?token=abc123&sig=deadbeefdeadbeef",
      },
    });
    const result = assembleHtml(options);
    expect(result.byteLength).toBeLessThanOrEqual(150 * 1024);
    expect(() =>
      assembleHtml({ ...options, profile: { maxBytes: result.byteLength - 1 } }),
    ).toThrow(
      `HTML bundle weight (${result.byteLength} bytes) exceeds profile.maxBytes budget (${result.byteLength - 1} bytes) with overage of 1 bytes`,
    );
    expect(() =>
      assembleHtml({ ...options, profile: { maxBytes: result.byteLength } }),
    ).not.toThrow();
  });
});
