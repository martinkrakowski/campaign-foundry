import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SectionOutline } from "../section-outline";

/**
 * The outline's rows come straight from `sectionOrder(mode)` — the one ordered
 * list of sections (GB-D18) — so the two modes' six rows differ only where the
 * plan says: classic gets Treatments, randomized gets Variation Policy. The
 * Layout step (T7) is the template's home, in both modes' orders.
 */
const briefRows = ["Identity", "Copy", "Products", "Treatments", "Layout", "Output"];
const variationRows = ["Identity", "Copy", "Products", "Layout", "Output", "Variation Policy"];

describe("SectionOutline", () => {
  test("the legend renders through Eyebrow on the tracking token", () => {
    render(<SectionOutline mode="brief" visibleErrors={{}} />);
    const legend = screen.getByText("Sections");
    expect(legend.tagName).toBe("SPAN");
    expect(legend.className).toContain("tracking-eyebrow");
    expect(legend.className).not.toContain("tracking-widest");
  });

  test("a classic outline lists the six classic sections in order", () => {
    render(<SectionOutline mode="brief" visibleErrors={{}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(briefRows);
    // numerals count from 01, padStart keeps the rows from shimmying when a tenth id lands
    expect(buttons[0].textContent).toContain("01");
    expect(buttons[4].textContent).toContain("05");
  });

  test("a randomized outline swaps Treatments for Variation Policy and keeps the Layout step", () => {
    render(<SectionOutline mode="variation" visibleErrors={{}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(variationRows);
  });

  test("an empty draft shows no pills and a 'No issues' aside", () => {
    render(<SectionOutline mode="brief" visibleErrors={{}} />);
    expect(screen.queryByLabelText(/issue/)).toBeNull();
    expect(screen.getByText("No issues")).toBeTruthy();
  });

  test("a row carries a pill for its own errors, counted and spelled", () => {
    render(
      <SectionOutline
        mode="brief"
        visibleErrors={{ copy: { headline: "required", tone: "choose one" } }}
      />,
    );
    // the Copy row's pill counts its two errors; the other rows have none
    expect(screen.getByLabelText("2 issues")).toBeTruthy();
    expect(screen.getAllByLabelText(/issue/)).toHaveLength(1);
    expect(screen.getByText("2 things to fix")).toBeTruthy();
  });

  test("a single issue is singular, across the whole outline", () => {
    render(
      <SectionOutline
        mode="variation"
        visibleErrors={{ policy: { seed: "bad seed" } }}
      />,
    );
    expect(screen.getByLabelText("1 issue")).toBeTruthy();
    expect(screen.getByText("1 thing to fix")).toBeTruthy();
  });

  test("activating a row hands its id to the editor's onActivate", async () => {
    const onActivate = vi.fn();
    render(<SectionOutline mode="brief" visibleErrors={{}} onActivate={onActivate} />);
    screen.getByRole("button", { name: "Products" }).click();
    expect(onActivate).toHaveBeenCalledWith("products");
  });

  test("in happy-dom the first row stays current — no window layout to spy on", () => {
    render(<SectionOutline mode="brief" visibleErrors={{}} />);
    // getBoundingClientRect returns zeroed boxes, so the scroll-spy's height guard
    // keeps the first section current rather than sliding to the last one.
    expect(screen.getByRole("button", { name: "Identity" }).getAttribute("aria-current")).toBe("location");
    expect(screen.getByRole("button", { name: "Output" }).getAttribute("aria-current")).toBeNull();
  });

  test("the scroll spy marks the section that has reached the top", () => {
    // happy-dom lays nothing out, so every rect is a zeroed box and the spy's
    // "this one is current" path is unreachable without stubbing geometry. Give two
    // sections real boxes — one above the threshold, one below — and the spy must
    // choose the one that has reached the top.
    const rects = new Map<string, { top: number; height: number }>([
      ["identity", { top: -200, height: 400 }],
      ["copy", { top: 10, height: 400 }],
      ["products", { top: 900, height: 400 }],
    ]);
    const original = Element.prototype.getBoundingClientRect;
    const originalRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
      return [{}] as unknown as DOMRectList;
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const key = this.id || this.getAttribute("data-section") || "";
      const r = rects.get(key) ?? { top: 0, height: 0 };
      return { ...r, bottom: r.top + r.height, left: 0, right: 0, width: 100, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      render(
        <>
          <section id="identity" />
          <section id="copy" />
          <section id="products" />
          <SectionOutline mode="brief" visibleErrors={{}} onActivate={() => {}} />
        </>,
      );
      fireEvent.scroll(window);
      // `copy` is the last section whose top has crossed the threshold, so it wins.
      const current = screen.getByRole("button", { name: /Copy/ });
      expect(current.getAttribute("aria-current")).toBe("location");
    } finally {
      Element.prototype.getBoundingClientRect = original;
      Element.prototype.getClientRects = originalRects;
    }
  });

});

/* W4.2 — the row's navigation handoff, exercised through the editor so the real
   `outlineActivate` runs: it must scroll the section into view and hand it focus. */
