import { describe, test, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { WorldMap } from "../world-map";
import { REGION_FOOTPRINTS } from "../geo/footprints";

// The map is painted from the kit's own footprint table (§2.3); the strings below
// are test vocabulary for the values and labels that table carries.
const HINT = "or use the chips below";

function renderMap(overrides: Partial<Parameters<typeof WorldMap>[0]> = {}) {
  const onSelect = vi.fn();
  const props = {
    footprints: REGION_FOOTPRINTS,
    value: null,
    onSelect,
    fallbackHint: HINT,
    ...overrides,
  };
  const view = render(<WorldMap {...props} />);
  return { onSelect, ...view };
}

const svgOf = (container: HTMLElement) => container.querySelector("svg") as SVGSVGElement;
const regionOf = (container: HTMLElement, value: string) =>
  container.querySelector(`[data-region="${value}"]`) as SVGGElement;

describe("WorldMap", () => {
  test("renders one g per footprint with its smoothed paths and a graticule", () => {
    const { container } = renderMap();
    expect(container.querySelectorAll("[data-region]").length).toBe(6);
    // GLOBAL paints every landmass the mockup drew.
    expect(regionOf(container, "GLOBAL").querySelectorAll("path").length).toBe(24);
    expect(regionOf(container, "APAC").querySelectorAll("path").length).toBe(15);
    expect(svgOf(container).querySelectorAll("line").length).toBe(11);
  });

  test("clicking a footprint's g calls onSelect with its value", () => {
    const { onSelect, container } = renderMap();
    fireEvent.click(regionOf(container, "EU"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("EU");
  });

  test("value paints exactly one footprint selected", () => {
    const { container } = renderMap({ value: "DE" });
    const selected = container.querySelectorAll("[data-selected]");
    expect(selected.length).toBe(1);
    expect(selected[0]?.getAttribute("data-region")).toBe("DE");
    const painted = regionOf(container, "DE").querySelectorAll("path");
    expect(painted.length).toBeGreaterThan(0);
    for (const path of painted) {
      expect(path.getAttribute("class")).toContain("fill-brand-primary/20");
      expect(path.getAttribute("class")).toContain("stroke-brand-primary/55");
    }
  });

  test("null paints no footprint selected — a free-text region has no map", () => {
    const { container } = renderMap({ value: null });
    expect(container.querySelectorAll("[data-selected]").length).toBe(0);
  });

  test("GLOBAL selected paints its own g — every landmass — with no hub dot", () => {
    const { container } = renderMap({ value: "GLOBAL" });
    const selected = container.querySelectorAll("[data-selected]");
    expect(selected.length).toBe(1);
    expect(selected[0]?.getAttribute("data-region")).toBe("GLOBAL");
    expect(regionOf(container, "GLOBAL").querySelectorAll("circle[r='2.5']").length).toBe(0);
    expect(regionOf(container, "GLOBAL").querySelectorAll("circle").length).toBeGreaterThan(0);
  });

  test("the dot matrix reveals on selection, staggered by distance from the hub", () => {
    const { container, rerender } = render(
      <WorldMap footprints={REGION_FOOTPRINTS} value="EU" onSelect={() => {}} fallbackHint={HINT} />,
    );
    const dots = regionOf(container, "EU").querySelectorAll("circle");
    expect(dots.length).toBeGreaterThan(0);
    const first = dots[0] as SVGCircleElement;
    expect(first.getAttribute("class")).toContain("scale-100");
    expect(first.getAttribute("class")).not.toContain("scale-0");
    expect(first.style.transitionDelay).toMatch(/^0\.\d+s$/);
    rerender(<WorldMap footprints={REGION_FOOTPRINTS} value={null} onSelect={() => {}} fallbackHint={HINT} />);
    expect((dots[0] as SVGCircleElement).getAttribute("class")).toContain("scale-0");
  });

  test("a selected footprint with a hub gains the solid hub dot and a mono label at the hub", () => {
    const { container } = renderMap({ value: "EU" });
    const eu = regionOf(container, "EU");
    const hub = eu.querySelector("circle[cx='540'][cy='235']") as SVGCircleElement;
    expect(hub).toBeTruthy();
    expect(hub.getAttribute("class")).toContain("fill-brand-primary");
    const label = eu.querySelector("text") as SVGTextElement;
    expect(label.textContent).toBe("Europe");
    expect(label.getAttribute("x")).toBe("546");
    expect(label.getAttribute("y")).toBe("229");
  });

  test("GLOBAL's label sits at the map's centre, where it has no hub", () => {
    const { container } = renderMap({ value: "GLOBAL" });
    const label = regionOf(container, "GLOBAL").querySelector("text") as SVGTextElement;
    expect(label.getAttribute("x")).toBe("480");
    expect(label.getAttribute("y")).toBe("250");
  });

  test("the SVG is aria-hidden with no focusable descendant — the chips stay the keyboard path", () => {
    const { container } = renderMap({ value: "EU" });
    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.querySelectorAll("[tabindex], button, a").length).toBe(0);
  });

  test("nothing inside the SVG carries an animate- class — no loops by any route (D96)", () => {
    const { container } = renderMap({ value: "EU" });
    for (const el of svgOf(container).querySelectorAll("*")) {
      for (const cls of Array.from(el.classList)) {
        expect(cls.startsWith("animate-")).toBe(false);
      }
    }
  });

  test("hovering a footprint fills the mono caption with its label by default", () => {
    const { container } = renderMap();
    const caption = container.querySelector("p.font-mono") as HTMLParagraphElement;
    expect(caption.textContent).toBe("");
    fireEvent.mouseEnter(regionOf(container, "EU"));
    expect(caption.textContent).toBe("Europe");
    fireEvent.mouseEnter(regionOf(container, "APAC"));
    expect(caption.textContent).toBe("Asia-Pacific");
    fireEvent.mouseLeave(svgOf(container));
    expect(caption.textContent).toBe("");
  });

  test("hoverLabel replaces the default caption text", () => {
    const { container } = renderMap({ hoverLabel: (value) => `Region: ${value}` });
    const caption = container.querySelector("p.font-mono") as HTMLParagraphElement;
    fireEvent.mouseEnter(regionOf(container, "UK"));
    expect(caption.textContent).toBe("Region: UK");
  });

  test("renders the visually-hidden fallback hint and merges the caller's className", () => {
    const { container } = renderMap({ className: "w-72" });
    const hint = container.querySelector("p.sr-only") as HTMLParagraphElement;
    expect(hint.textContent).toBe(HINT);
    const wrapper = container.querySelector("div") as HTMLDivElement;
    expect(wrapper.className).toContain("w-72");
    expect(wrapper.className).toContain("space-y-1");
  });
});
