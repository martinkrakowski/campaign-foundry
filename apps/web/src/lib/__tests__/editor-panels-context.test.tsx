import { describe, test, expect, vi } from "vitest";
import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import {
  EditorPanelsProvider,
  useEditorPanels,
  useEditorPanelPublisher,
} from "../editor-panels-context";

const Publish = ({ node }: { node: React.ReactNode }) => {
  const { setPanels } = useEditorPanelPublisher();
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

  /**
   * Both halves, because there are two contexts now (RS2): the slots and the
   * publisher. A publisher that answered `undefined` outside a provider would
   * leave an editor silently publishing into nothing — the panel and the rail
   * would simply never appear, with no error anywhere to say why.
   */
  test("so does the publisher half, which is a second context", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Publish node={<p>policy</p>} />)).toThrow(
      /useEditorPanelPublisher must be used within an EditorPanelsProvider/,
    );
    error.mockRestore();
  });
});
