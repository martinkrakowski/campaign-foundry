import { describe, expect, test } from "vitest";
import { assembleHtml } from "../markup-assembler.js";
import type { HtmlElement } from "../html-element.js";

describe("assembleHtml (HL4, HL-D3, HL-D6)", () => {
  const sampleElements: readonly HtmlElement[] = [
    {
      kind: "button",
      text: "Shop Now",
      frame: { x: 0.1, y: 0.7, w: 0.3, h: 0.1, anchor: "middle" },
    },
    {
      kind: "text",
      text: "Summer Collection",
      frame: { x: 0.05, y: 0.1, w: 0.8, h: 0.2, anchor: "top" },
    },
    {
      kind: "image",
      frame: { x: 0.1, y: 0.3, w: 0.8, h: 0.4, anchor: "middle" },
    },
  ];

  test("a brief with a clickDestination produces a unit declaring var clickTag and NO <a href (HL-D3)", () => {
    const destination = "https://example.com/landing-page";
    const result = assembleHtml({
      elements: sampleElements,
      canvas: { ratio: "1:1" },
      brandColor: "#ff0000",
      clickDestination: destination,
    });

    // 1. Must emit var clickTag in script
    expect(result.html).toContain(`var clickTag = "${destination}";`);
    // 2. Must NEVER emit an <a href
    expect(result.html).not.toContain("<a href");
    expect(result.html).not.toContain("<a ");
    // 3. Interactive elements (button) navigate via window.open(window.clickTag)
    expect(result.html).toContain("window.open(window.clickTag)");
  });

  test("a brief without clickDestination produces no clickTag variable and no navigation handler (HL-D3)", () => {
    const result = assembleHtml({
      elements: sampleElements,
      canvas: { ratio: "1:1" },
      brandColor: "#ff0000",
    });

    expect(result.html).not.toContain("clickTag");
    expect(result.html).not.toContain("window.open");
    expect(result.html).not.toContain("<a ");
  });

  test("an over-budget bundle is refused against profile.maxBytes for that platform, naming budget and overage (HL-D6)", () => {
    // Set a tiny budget to guarantee failure
    const maxBytes = 100;
    expect(() =>
      assembleHtml({
        elements: sampleElements,
        canvas: { ratio: "1:1" },
        brandColor: "#ff0000",
        profile: { maxBytes },
      }),
    ).toThrowError(/exceeds.*budget/i);

    try {
      assembleHtml({
        elements: sampleElements,
        canvas: { ratio: "1:1" },
        brandColor: "#ff0000",
        profile: { maxBytes },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("100"); // Names the budget
      expect(msg).toMatch(/overage|over/i); // Names the overage
    }
  });

  test("a bundle within budget succeeds and returns html and bytes", () => {
    const result = assembleHtml({
      elements: sampleElements,
      canvas: { ratio: "1:1" },
      brandColor: "#ff0000",
      profile: { maxBytes: 10 * 1024 * 1024 }, // 10 MB
    });

    expect(result.html).toBeTruthy();
    expect(result.bytes.length).toBe(result.byteLength);
    expect(result.bytes.length).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  test("escapes user-authored copy in text and buttons against XSS (HL-D7)", () => {
    const maliciousElements: readonly HtmlElement[] = [
      {
        kind: "text",
        text: '<script>alert("xss")</script>',
        frame: { x: 0, y: 0, w: 1, h: 0.5, anchor: "top" },
      },
      {
        kind: "button",
        text: '"><img src=x onerror=alert(1)>',
        frame: { x: 0, y: 0.6, w: 0.5, h: 0.2, anchor: "middle" },
      },
    ];

    const result = assembleHtml({
      elements: maliciousElements,
      canvas: { ratio: "1:1" },
      brandColor: "#0000ff",
    });

    expect(result.html).not.toContain('<script>alert("xss")</script>');
    expect(result.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(result.html).not.toContain('"><img src=x');
  });

  test("renders display sizes (e.g. 728x90) and honors style typography", () => {
    const result = assembleHtml({
      elements: sampleElements,
      canvas: { size: "728x90" },
      brandColor: "#22c55e",
      style: {
        fontFamily: "Lora",
        fontWeight: 700,
        align: "right",
        letterSpacing: 0.05,
        lineHeight: 1.2,
        sizeScale: 0.5,
      },
      fallbackImageSrc: "custom-fallback.png",
    });

    expect(result.html).toContain("width: 728px");
    expect(result.html).toContain("height: 90px");
    expect(result.html).toContain("Lora");
    expect(result.html).toContain("custom-fallback.png");
  });

  test("handles text anchor middle, bottom, and undefined element text", () => {
    const elements: readonly HtmlElement[] = [
      {
        kind: "text",
        text: "Middle text",
        frame: { x: 0, y: 0, w: 1, h: 0.3, anchor: "middle" },
      },
      {
        kind: "text",
        text: "Bottom text",
        frame: { x: 0, y: 0.3, w: 1, h: 0.3, anchor: "bottom" },
      },
      {
        kind: "text",
        frame: { x: 0, y: 0.6, w: 1, h: 0.2, anchor: "top" },
      },
      {
        kind: "button",
        frame: { x: 0, y: 0.8, w: 1, h: 0.2, anchor: "middle" },
      },
    ];

    const result = assembleHtml({
      elements,
      canvas: { ratio: "1:1" },
      brandColor: "#000000",
    });

    expect(result.html).toContain("justify-content: center;");
    expect(result.html).toContain("justify-content: flex-end;");
  });

  test("a clickDestination containing </script> cannot break out of the script element (HL-D7)", () => {
    const destination = "https://example.com/</script><script>alert(1)</script>";
    const result = assembleHtml({
      elements: sampleElements,
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
      clickDestination: destination,
    });

    // Exactly one script element: the crafted value cannot close the
    // declaration and append executable markup.
    expect((result.html.match(/<script/g) ?? []).length).toBe(1);
    expect((result.html.match(/<\/script>/g) ?? []).length).toBe(1);
    // `<`/`>` survive only as \uXXXX escapes — no literal HTML syntax in the JS string.
    expect(result.html).toContain("\\u003C/script\\u003E");
    // The value stays a correct JS string: decoding the literal yields the original destination.
    const declaration = /var clickTag = (".*");/.exec(result.html);
    expect(declaration).not.toBeNull();
    expect(JSON.parse(declaration![1] as string)).toBe(destination);
  });

  test("a brandColor that is not the documented 6-digit hex shape is refused (HL-D7)", () => {
    expect(() =>
      assembleHtml({
        elements: sampleElements,
        canvas: { ratio: "1:1" },
        brandColor: '#fff" autofocus onfocus="alert(1)',
      }),
    ).toThrowError(/brandColor/);
  });

  test("a valid brandColor renders unchanged in the button style attribute", () => {
    const result = assembleHtml({
      elements: [
        { kind: "button", text: "Go", frame: { x: 0, y: 0, w: 1, h: 1, anchor: "middle" } },
      ],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
    });

    expect(result.html).toContain("background-color: #1473E6;");
  });

  test("handles empty elements options", () => {
    const result = assembleHtml({
      canvas: { ratio: "1:1" },
      brandColor: "#000000",
    });

    expect(result.html).toContain('<div id="ad-container">\n      \n    </div>');
  });

  test("a button element's style contains overflow: hidden (X10)", () => {
    const result = assembleHtml({
      elements: [
        {
          kind: "button",
          text: "Click Me",
          frame: { x: 0.1, y: 0.7, w: 0.3, h: 0.1, anchor: "middle" },
        },
      ],
      canvas: { ratio: "1:1" },
      brandColor: "#1473E6",
    });

    const buttonMatch = /<button[^>]*style="([^"]*)"/.exec(result.html);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch![1]).toContain("overflow: hidden;");
  });
});
