import { describe, test, expect, vi } from "vitest";
import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { EditorPanelsProvider, useEditorPanels } from "../editor-panels-context";

const Publish = ({ node }: { node: React.ReactNode }) => {
  const { setPanels } = useEditorPanels();
  useEffect(() => {
    setPanels(node);
    return () => setPanels(null);
  }, [node, setPanels]);
  return null;
};
const Slot = () => <>{useEditorPanels().panels}</>;

describe("EditorPanelsProvider", () => {
  test("carries what an editor publishes, and clears it when the editor unmounts", () => {
    const { rerender } = render(
      <EditorPanelsProvider>
        <Publish node={<p>policy</p>} />
        <Slot />
      </EditorPanelsProvider>,
    );
    expect(screen.getByText("policy")).toBeTruthy();
    rerender(
      <EditorPanelsProvider>
        <Slot />
      </EditorPanelsProvider>,
    );
    expect(screen.queryByText("policy")).toBeNull();
  });

  test("using the hook outside the provider fails loudly", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Slot />)).toThrow(/within an EditorPanelsProvider/);
    error.mockRestore();
  });
});
