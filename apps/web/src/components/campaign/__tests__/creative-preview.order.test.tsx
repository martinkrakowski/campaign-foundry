import { describe, test, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { CreativePreview } from "../CreativePreview";

/**
 * C2 — `CreativePreview` no longer hardcodes its own stack order: it paints
 * `PREVIEW_LAYER_ORDER`, the same list the glyph iterates and the compositor
 * resolves through (D121). This is the render-side proof, the same shape as
 * `creative-glyph.keys.test.tsx`'s: mock the shared source and watch this
 * preview's draw order move with it, not just the glyph's.
 */
describe("CreativePreview paints the shared layer order (C2)", () => {
  afterEach(() => {
    vi.doUnmock("@/components/ui/preview-layers");
    vi.restoreAllMocks();
  });

  const logoOf = (svg: SVGSVGElement): SVGElement =>
    Array.from(svg.querySelectorAll("rect")).find((r) => r.getAttribute("fill") === "#ffffff")!;

  test("canonically, the headline paints before the logo — PREVIEW_LAYER_ORDER's own sequence", () => {
    const { container } = render(
      <CreativePreview primaryColor="#1473E6" headline="Hello there" />,
    );
    const svg = container.querySelector("svg")!;
    const text = svg.querySelector("text")!;
    const logo = logoOf(svg);
    // logo (later in PREVIEW_LAYER_ORDER) follows the headline in the DOM —
    // and DOM order is paint order, so the logo draws on top.
    expect(text.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("reordering the shared source moves this preview too — logo ahead of the headline", async () => {
    vi.resetModules();
    vi.doMock("@/components/ui/preview-layers", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/components/ui/preview-layers")>();
      return {
        ...actual,
        // The same kind of split the glyph's L8a test mocks: `logo` moved
        // ahead of `static-text` in the shared order — nothing local to
        // either preview.
        PREVIEW_LAYER_ORDER: [
          "image",
          "shade",
          "accent",
          "logo",
          "static-text",
        ] as unknown as typeof actual.PREVIEW_LAYER_ORDER,
      };
    });
    const { CreativePreview: MockedCreativePreview } = await import("../CreativePreview");
    const { container } = render(
      <MockedCreativePreview primaryColor="#1473E6" headline="Hello there" />,
    );
    const svg = container.querySelector("svg")!;
    const text = svg.querySelector("text")!;
    const logo = logoOf(svg);
    // Now the logo draws BEFORE the headline — the mirror of the canonical
    // assertion above, proving this preview reads the order rather than
    // owning one.
    expect(logo.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
