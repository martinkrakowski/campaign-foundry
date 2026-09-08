import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { OptionTile } from "../option-tile";
import { PreviewPanel } from "../preview-panel";

describe("OptionTile's preview slot (F3)", () => {
  test("the preview panel is a sibling before the padded body, its parent the button, not the body", () => {
    const { container } = render(
      <OptionTile
        value="brief"
        name="Classic"
        selected={false}
        onToggle={() => {}}
        preview={<span data-testid="preview" />}
      >
        <span data-testid="glyph" />
      </OptionTile>,
    );
    const button = container.firstElementChild as HTMLElement;
    const panel = button.querySelector("[data-testid='preview']") as HTMLElement;
    // The tile's dim wrapper around the panel — the wrapper's parent is the button.
    const wrapper = panel.parentElement as HTMLElement;
    const body = wrapper.nextElementSibling as HTMLElement;
    // Edge to edge: the wrapper's parent is the button, and the body — the only
    // thing carrying the padding — comes after it, not around it.
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.parentElement).toBe(button);
    expect(body.className).toContain("p-3.5");
    expect(button.className).not.toContain("p-3.5");
    // The children glyph slot stays inside the padded body.
    expect(button.querySelector("[data-testid='glyph']")?.parentElement?.parentElement).toBe(body);
  });

  test("the tile dims its own wrapper around the preview — the caller passes no dimmed", () => {
    const { container, rerender } = render(
      <OptionTile
        value="brief"
        name="Classic"
        selected={false}
        onToggle={() => {}}
        preview={<span data-testid="preview" />}
      >
        <span />
      </OptionTile>,
    );
    const unselected = container.querySelector("[data-testid='preview']")?.parentElement as HTMLElement;
    expect(unselected.getAttribute("aria-hidden")).toBe("true");
    expect(unselected.className).toContain("opacity-[0.55]");
    expect(unselected.className).toContain("saturate-[0.45]");
    expect(unselected.className).toContain("transition-[opacity,filter]");
    expect(unselected.className).not.toMatch(/animate-/);

    rerender(
      <OptionTile
        value="brief"
        name="Classic"
        selected
        onToggle={() => {}}
        preview={<span data-testid="preview" />}
      >
        <span />
      </OptionTile>,
    );
    const full = container.querySelector("[data-testid='preview']")?.parentElement as HTMLElement;
    expect(full.className).toContain("opacity-100");
    expect(full.className).toContain("saturate-100");
  });

  test("a PreviewPanel in the tile slot is dimmed exactly once — leave dimmed unset", () => {
    const { container } = render(
      <OptionTile
        value="brief"
        name="Classic"
        selected={false}
        onToggle={() => {}}
        preview={
          <PreviewPanel>
            <span data-testid="picture" />
          </PreviewPanel>
        }
      >
        <span />
      </OptionTile>,
    );
    const picture = container.querySelector("[data-testid='picture']") as HTMLElement;
    const panel = picture.parentElement as HTMLElement;
    const wrapper = panel.parentElement as HTMLElement;
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.className).toContain("opacity-[0.55]");
    expect(wrapper.className).toContain("saturate-[0.45]");
    // The panel itself stays undimmed: two wrappers both applying the pair
    // would double-dim. The children glyph has its own independent dim.
    expect(panel.className).toContain("opacity-100");
    expect(panel.className).not.toContain("opacity-[0.55]");
    const previewTree = [wrapper, ...Array.from(wrapper.querySelectorAll("*"))];
    const dimmed = previewTree.filter(
      (el) => typeof el.className === "string" && el.className.includes("opacity-[0.55]"),
    );
    expect(dimmed).toHaveLength(1);
  });

  test("without a preview the tile renders exactly the padded body", () => {
    const { container } = render(
      <OptionTile value="variation" name="Randomized" selected={false} onToggle={() => {}}>
        <span />
      </OptionTile>,
    );
    const button = container.firstElementChild as HTMLElement;
    expect(button.className).not.toContain("p-3.5");
    expect(button.children).toHaveLength(1);
    expect((button.firstElementChild as HTMLElement).className).toContain("p-3.5");
  });
});
