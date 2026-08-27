import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { EditorOutline } from "../EditorOutline";
import { EditorOutlineProvider, useEditorOutline, type EditorOutline as Outline } from "@/lib/editor-outline-context";

/** Publishes an outline the way the brief page does while mounted. */
const Publish = ({ outline }: { outline: Outline }) => {
  const { setOutline } = useEditorOutline();
  useEffect(() => {
    setOutline(outline);
    return () => setOutline(null);
  }, [outline, setOutline]);
  return null;
};

const outline = (navigate = vi.fn()): Outline => ({
  navigate,
  sections: [
    { id: "identity", label: "Identity", errorCount: 2 },
    { id: "copy", label: "Copy", errorCount: 0 },
    { id: "policy", label: "Variation policy", errorCount: 1 },
  ],
});

describe("EditorOutline", () => {
  test("renders nothing when no editor is publishing an outline", () => {
    const { container } = render(
      <EditorOutlineProvider>
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  test("lists the sections with their error badges and a total", () => {
    render(
      <EditorOutlineProvider>
        <Publish outline={outline()} />
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(screen.getByText("Sections")).toBeTruthy();
    expect(screen.getByText("3 issues")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Identity/ }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Variation policy/ }).textContent).toContain("1");
  });

  test("a clean draft shows no issue count and no badges", () => {
    const clean: Outline = {
      navigate: vi.fn(),
      sections: [
        { id: "identity", label: "Identity", errorCount: 0 },
        { id: "copy", label: "Copy", errorCount: 0 },
      ],
    };
    render(
      <EditorOutlineProvider>
        <Publish outline={clean} />
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(screen.getByText("Sections")).toBeTruthy();
    expect(screen.queryByText(/issue/)).toBeNull();
    expect(screen.getByRole("button", { name: /Identity/ }).textContent).toBe("Identity");
  });

  test("a single issue is singular", () => {
    const one: Outline = { navigate: vi.fn(), sections: [{ id: "copy", label: "Copy", errorCount: 1 }] };
    render(
      <EditorOutlineProvider>
        <Publish outline={one} />
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(screen.getByText("1 issue")).toBeTruthy();
  });

  test("clicking a section navigates, and tells the host it did (so the mobile menu can close)", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    render(
      <EditorOutlineProvider>
        <Publish outline={outline(navigate)} />
        <EditorOutline onNavigate={onNavigate} />
      </EditorOutlineProvider>,
    );
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    expect(navigate).toHaveBeenCalledWith("copy");
    expect(onNavigate).toHaveBeenCalled();
  });

  test("the outline disappears when the editor unmounts", () => {
    const { rerender, container } = render(
      <EditorOutlineProvider>
        <Publish outline={outline()} />
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(screen.getByText("Sections")).toBeTruthy();
    rerender(
      <EditorOutlineProvider>
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  test("renders the sections the editor places in the bar, under the list", () => {
    const withPanels: Outline = { ...outline(), panels: <p>policy controls live here</p> };
    render(
      <EditorOutlineProvider>
        <Publish outline={withPanels} />
        <EditorOutline />
      </EditorOutlineProvider>,
    );
    expect(screen.getByText("Sections")).toBeTruthy();
    expect(screen.getByText("policy controls live here")).toBeTruthy();
  });

  test("using the hook outside the provider fails loudly", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const Probe = () => {
      useEditorOutline();
      return null;
    };
    expect(() => render(<Probe />)).toThrow(/within an EditorOutlineProvider/);
    error.mockRestore();
  });
});
