import { describe, test, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { WorldMap } from "../world-map";
import { REGION_FOOTPRINTS } from "../geo/footprints";

// The map is painted from the kit's own footprint table (§2.3). Labels are
// caller-supplied — the distinctive prefix proves the hub and caption read
// `labelFor(value)`, not a kit literal.
const HINT = "or use the chips below";
const labelFor = (value: string) => `lbl:${value}`;

function renderMap(overrides: Partial<Parameters<typeof WorldMap>[0]> = {}) {
  const onSelect = vi.fn();
  const props = {
    footprints: REGION_FOOTPRINTS,
    value: null,
    onSelect,
    fallbackHint: HINT,
    labelFor,
    ...overrides,
  };
  const view = render(<WorldMap {...props} />);
  return { onSelect, ...view };
}

const svgOf = (container: HTMLElement) => container.querySelector("svg") as SVGSVGElement;
const regionOf = (container: HTMLElement, value: string) =>
  container.querySelector(`[data-region="${value}"]`) as SVGGElement;
const SELECTED_FILL = "fill-brand-primary/20";

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

  test("value=GLOBAL, clicking DE reaches DE — the selected footprint is not a pointer target", () => {
    const { onSelect, container } = renderMap({ value: "GLOBAL" });
    // GLOBAL paints last (so its fill is visible) but must not swallow the hit:
    // its whole group is hit-transparent, so the event falls through to DE.
    expect(regionOf(container, "GLOBAL").getAttribute("pointer-events")).toBe("none");
    expect(regionOf(container, "DE").getAttribute("pointer-events")).not.toBe("none");
    fireEvent.click(regionOf(container, "DE"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("DE");
  });

  test("value=EU, clicking DE reaches DE — overlapping selected paint does not swallow the hit", () => {
    const { onSelect, container } = renderMap({ value: "EU" });
    expect(regionOf(container, "EU").getAttribute("pointer-events")).toBe("none");
    expect(regionOf(container, "DE").getAttribute("pointer-events")).not.toBe("none");
    fireEvent.click(regionOf(container, "DE"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("DE");
  });

  test("value=null, every footprint is a pointer target", () => {
    const { onSelect, container } = renderMap({ value: null });
    for (const g of container.querySelectorAll("[data-region]")) {
      expect(g.getAttribute("pointer-events")).not.toBe("none");
    }
    fireEvent.click(regionOf(container, "GLOBAL"));
    expect(onSelect).toHaveBeenCalledWith("GLOBAL");
    fireEvent.click(regionOf(container, "DE"));
    expect(onSelect).toHaveBeenCalledWith("DE");
  });

  test.each(["EU", "GLOBAL", "DE"] as const)(
    "value=%s paints that footprint last and only it carries the selected fill",
    (value) => {
      const { container } = renderMap({ value });
      const selected = container.querySelectorAll("[data-selected]");
      expect(selected.length).toBe(1);
      expect(selected[0]?.getAttribute("data-region")).toBe(value);
      expect(selected[0]?.parentElement?.lastElementChild).toBe(selected[0]);
      for (const g of container.querySelectorAll("[data-region]")) {
        const region = g.getAttribute("data-region");
        const paths = g.querySelectorAll("path");
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const cls = path.getAttribute("class") ?? "";
          if (region === value) {
            expect(cls).toContain(SELECTED_FILL);
            expect(cls).toContain("stroke-brand-primary/55");
          } else {
            expect(cls).not.toContain(SELECTED_FILL);
          }
        }
      }
    },
  );

  test("null paints no footprint selected — a free-text region has no map", () => {
    const { container } = renderMap({ value: null });
    expect(container.querySelectorAll("[data-selected]").length).toBe(0);
  });

  test.each(["Other…", "not-a-region"] as const)(
    "value=%s paints nothing selected and does not throw",
    (value) => {
      const { container } = renderMap({ value });
      expect(container.querySelectorAll("[data-selected]").length).toBe(0);
      expect(regionOf(container, "GLOBAL").getAttribute("data-selected")).toBeNull();
      for (const path of container.querySelectorAll("[data-region] path")) {
        expect(path.getAttribute("class")).not.toContain(SELECTED_FILL);
      }
    },
  );

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
      <WorldMap footprints={REGION_FOOTPRINTS} value="EU" onSelect={() => {}} fallbackHint={HINT} labelFor={labelFor} />,
    );
    const dots = regionOf(container, "EU").querySelectorAll("circle[r='1.5']");
    expect(dots.length).toBeGreaterThan(0);
    const first = dots[0] as SVGCircleElement;
    expect(first.getAttribute("class")).toContain("scale-100");
    expect(first.getAttribute("class")).not.toContain("scale-0");
    expect(first.style.transitionDelay).toMatch(/^0\.\d+s$/);
    rerender(
      <WorldMap footprints={REGION_FOOTPRINTS} value={null} onSelect={() => {}} fallbackHint={HINT} labelFor={labelFor} />,
    );
    expect((dots[0] as SVGCircleElement).getAttribute("class")).toContain("scale-0");
  });

  test("the dot reveal is motion-safe and not a pointer target", () => {
    const { container } = renderMap({ value: "EU" });
    const dot = regionOf(container, "EU").querySelector("circle[r='1.5']") as SVGCircleElement;
    const classes = Array.from(dot.classList);
    expect(classes).toContain("motion-safe:transition-transform");
    expect(classes).toContain("motion-safe:duration-fast");
    expect(classes).not.toContain("transition-transform");
    expect(classes).not.toContain("duration-fast");
    expect(dot.getAttribute("pointer-events")).toBe("none");
  });

  test("the hub dot is absent until a footprint with a hub is selected", () => {
    const { container, rerender } = renderMap({ value: null });
    expect(container.querySelectorAll("circle[r='2.5']").length).toBe(0);
    rerender(
      <WorldMap footprints={REGION_FOOTPRINTS} value="EU" onSelect={() => {}} fallbackHint={HINT} labelFor={labelFor} />,
    );
    expect(container.querySelectorAll("circle[r='2.5']").length).toBe(1);
    expect(regionOf(container, "DE").querySelectorAll("circle[r='2.5']").length).toBe(0);
    rerender(
      <WorldMap footprints={REGION_FOOTPRINTS} value={null} onSelect={() => {}} fallbackHint={HINT} labelFor={labelFor} />,
    );
    expect(container.querySelectorAll("circle[r='2.5']").length).toBe(0);
  });

  test("a selected footprint with a hub gains the solid hub dot and a mono label at the hub", () => {
    const { container } = renderMap({ value: "EU" });
    const eu = regionOf(container, "EU");
    const hub = eu.querySelector("circle[cx='540'][cy='235']") as SVGCircleElement;
    expect(hub).toBeTruthy();
    expect(hub.getAttribute("class")).toContain("fill-brand-primary");
    const label = eu.querySelector("text") as SVGTextElement;
    expect(label.textContent).toBe("lbl:EU");
    expect(label.getAttribute("x")).toBe("546");
    expect(label.getAttribute("y")).toBe("229");
  });

  test("GLOBAL's label sits at the map's centre, where it has no hub", () => {
    const { container } = renderMap({ value: "GLOBAL" });
    const label = regionOf(container, "GLOBAL").querySelector("text") as SVGTextElement;
    expect(label.textContent).toBe("lbl:GLOBAL");
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

  test("hovering a footprint fills the mono caption from labelFor", () => {
    const { container } = renderMap();
    const caption = container.querySelector("p.font-mono") as HTMLParagraphElement;
    expect(caption.textContent).toBe("");
    fireEvent.mouseEnter(regionOf(container, "EU"));
    expect(caption.textContent).toBe("lbl:EU");
    fireEvent.mouseEnter(regionOf(container, "APAC"));
    expect(caption.textContent).toBe("lbl:APAC");
    fireEvent.mouseLeave(svgOf(container));
    expect(caption.textContent).toBe("");
  });

  test("labelFor is the sole source of hub text and caption copy", () => {
    const { container } = renderMap({ labelFor: (value) => `Region: ${value}` });
    const caption = container.querySelector("p.font-mono") as HTMLParagraphElement;
    fireEvent.mouseEnter(regionOf(container, "UK"));
    expect(caption.textContent).toBe("Region: UK");
  });

  test("renders the visually-hidden fallback hint and merges the caller's className", () => {
    const { container } = renderMap({ className: "w-72" });
    const hint = container.querySelector("p.sr-only") as HTMLParagraphElement;
    const svg = svgOf(container);
    expect(hint.textContent).toBe(HINT);
    expect(hint.closest("[aria-hidden]")).not.toBe(svg);
    const wrapper = container.querySelector("div") as HTMLDivElement;
    expect(wrapper.className).toContain("w-72");
    expect(wrapper.className).toContain("space-y-1");
  });
});
