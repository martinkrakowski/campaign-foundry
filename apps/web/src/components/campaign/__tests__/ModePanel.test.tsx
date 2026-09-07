import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModePanel } from "../ModePanel";
import * as messages from "../messages";

describe("ModePanel", () => {
  test("each mode card captions itself with its display name (D4)", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    // The cards keep the raw value as the accessible name; the words under it
    // come from display-names, one map for every mode surface. Bound per card:
    // a swapped caption must fail here, not hide in a tree-wide getByText.
    expect(screen.getByRole("button", { name: "brief" }).textContent).toContain("Classic");
    expect(screen.getByRole("button", { name: "variation" }).textContent).toContain("Randomized");
  });

  test("each card shows the raw value as its name and the display name as its caption", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    const brief = screen.getByRole("button", { name: "brief" });
    const variation = screen.getByRole("button", { name: "variation" });
    expect(brief.textContent).toContain("brief");
    expect(brief.textContent).toContain("Classic");
    expect(variation.textContent).toContain("variation");
    expect(variation.textContent).toContain("Randomized");
  });

  test("the pressed card is the editor's current mode, and pressing dispatches setMode", async () => {
    const onSetMode = vi.fn();
    const user = userEvent.setup();
    render(<ModePanel mode="variation" onSetMode={onSetMode} />);
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "brief" }));
    expect(onSetMode).toHaveBeenCalledWith("brief");
  });
});

describe("ModePanel — the filled tiles (G2, F1/D93)", () => {
  /** The preview panel is the tile's one `bg-background` ground (F3), outside the padded body. */
  function previewOf(button: HTMLElement): HTMLElement {
    const panel = button.querySelector("div.bg-background");
    expect(panel).not.toBeNull();
    return panel as HTMLElement;
  }

  /**
   * pB draws a round avatar (a circle); pC centres its image (a second rounded
   * rect beyond the frame's own rounded border); pA is the remainder. Shared so
   * Classic's "one design" and Randomized's "three variants" classify the same way.
   */
  function posterVariantOf(frame: Element): "pA" | "pB" | "pC" {
    if (frame.querySelector("circle") !== null) return "pB";
    const rounded = Array.from(frame.querySelectorAll("rect")).filter((rect) => rect.getAttribute("rx"));
    return rounded.length >= 3 ? "pC" : "pA";
  }

  test("in the full form, each tile carries a preview panel, a tag and a blurb", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    for (const [option, tag, blurb] of [
      ["brief", messages.modeTileTagBrief, messages.modeTileBlurbBrief],
      ["variation", messages.modeTileTagVariation, messages.modeTileBlurbVariation],
    ] as const) {
      const tile = screen.getByRole("button", { name: option });
      expect(previewOf(tile)).not.toBeNull();
      expect(tile.textContent).toContain(tag);
      expect(tile.textContent).toContain(blurb);
    }
  });

  test("each tile's tag and blurb come from the one voice (messages.ts), per mode", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    const brief = screen.getByRole("button", { name: "brief" });
    const variation = screen.getByRole("button", { name: "variation" });
    expect(brief.textContent).toContain(messages.modeTileTagBrief);
    expect(brief.textContent).toContain(messages.modeTileBlurbBrief);
    expect(variation.textContent).toContain(messages.modeTileTagVariation);
    expect(variation.textContent).toContain(messages.modeTileBlurbVariation);
    // Unique vs the full-form test, which only checks each tile CONTAINS its
    // own words: a copy-paste that puts both tags on both tiles still passes
    // that test, and fails here.
    expect(brief.textContent).not.toContain(messages.modeTileTagVariation);
    expect(brief.textContent).not.toContain(messages.modeTileBlurbVariation);
    expect(variation.textContent).not.toContain(messages.modeTileTagBrief);
    expect(variation.textContent).not.toContain(messages.modeTileBlurbBrief);
  });

  test("Classic's panel holds six identical frames of one design, captioned", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    const panel = previewOf(screen.getByRole("button", { name: "brief" }));
    const frames = panel.querySelectorAll("svg");
    expect(frames).toHaveLength(6);
    const shapes = new Set(
      Array.from(frames).map((frame) => `${frame.getAttribute("width")}x${frame.getAttribute("height")}`),
    );
    expect(shapes.size).toBe(1);
    const variants = new Set(Array.from(frames).map(posterVariantOf));
    expect(variants.size).toBe(1);
    const caption = Array.from(panel.querySelectorAll("span")).find((span) =>
      span.className.includes("font-mono"),
    );
    expect(caption?.textContent).toBe(messages.modeTileCaptionBrief);
  });

  test("Randomized's panel holds six frames across three variants and mixed ratios", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    const panel = previewOf(screen.getByRole("button", { name: "variation" }));
    const frames = panel.querySelectorAll("svg");
    expect(frames).toHaveLength(6);
    const variants = new Set(Array.from(frames).map(posterVariantOf));
    expect(variants.size).toBe(3);
    const shapes = new Set(
      Array.from(frames).map((frame) => `${frame.getAttribute("width")}x${frame.getAttribute("height")}`),
    );
    expect(shapes.size).toBe(3);
    const caption = Array.from(panel.querySelectorAll("span")).find((span) =>
      span.className.includes("font-mono"),
    );
    expect(caption?.textContent).toBe(messages.modeTileCaptionVariation);
  });

  test("compact renders today's glyph-only look: no panel, no tag, no blurb", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} compact />);
    const brief = screen.getByRole("button", { name: "brief" });
    const variation = screen.getByRole("button", { name: "variation" });
    for (const tile of [brief, variation]) {
      expect(tile.querySelector("div.bg-background")).toBeNull();
      expect(tile.querySelector("svg")).not.toBeNull();
      expect(tile.textContent).not.toContain(messages.modeTileBlurbBrief);
      expect(tile.textContent).not.toContain(messages.modeTileBlurbVariation);
      expect(tile.textContent).not.toContain(messages.modeTileTagBrief);
      expect(tile.textContent).not.toContain(messages.modeTileTagVariation);
    }
  });

  test("nothing the previews render animates (D88) — the check badge's one-shot is the tile's own", () => {
    const { container } = render(<ModePanel mode="variation" onSetMode={() => {}} />);
    for (const picture of container.querySelectorAll("div.bg-background, svg[viewBox='0 0 46 46']")) {
      expect(picture.innerHTML.includes("animate-")).toBe(false);
      expect(picture.className).not.toContain("animate-");
    }
  });

  test("each preview frame wrapper is capped to its cell so a landscape frame cannot overflow a narrow tile", () => {
    // happy-dom performs no layout, so this is a class assertion on the wrapper,
    // not a pixel measurement of the cell.
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    for (const name of ["brief", "variation"] as const) {
      const panel = previewOf(screen.getByRole("button", { name }));
      const grid = panel.querySelector(".grid");
      expect(grid).not.toBeNull();
      const wrappers = Array.from((grid as HTMLElement).children);
      expect(wrappers).toHaveLength(6);
      for (const wrap of wrappers) {
        expect(wrap.tagName).toBe("DIV");
        expect(wrap.className).toContain("max-w-full");
        expect(wrap.className).toContain("[&>svg]:max-w-full");
        expect(wrap.querySelector("svg")).not.toBeNull();
      }
    }
  });
});

describe("ModePanel — the flip's dropped-format notice (S4/D99)", () => {
  test("says the drop once, in a status line beside the tiles, when the flip removed Video", () => {
    const { container } = render(<ModePanel mode="brief" onSetMode={() => {}} compact formatDropped />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe(messages.modeDroppedVideo);
  });

  test("no drop, no live region — the compact sidebar stays silent", () => {
    const { container } = render(<ModePanel mode="variation" onSetMode={() => {}} compact />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test("the full dialog form stays silent too — the dialog's mode tiles cannot drop a format", () => {
    const { container } = render(<ModePanel mode="brief" onSetMode={() => {}} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
