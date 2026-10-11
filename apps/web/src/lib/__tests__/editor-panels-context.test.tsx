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
const Refs = () => <output data-testid="refs">{JSON.stringify(useEditorPanels().assetRefs)}</output>;
const PublishRefs = ({ refs }: { refs: readonly string[] }) => {
  const { setAssetRefs } = useEditorPanelPublisher();
  useEffect(() => {
    setAssetRefs(refs);
    return () => setAssetRefs([]);
  }, [refs, setAssetRefs]);
  return null;
};
const PublishRefsOnly = ({ refs }: { refs: readonly string[] }) => {
  const { setAssetRefs } = useEditorPanelPublisher();
  useEffect(() => {
    setAssetRefs(refs);
  }, [refs, setAssetRefs]);
  return null;
};
const REFS = ["assets/inputs/c1/logo.png", "11111111-2222-4333-8444-555555555555"];

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

  test("carries the asset refs an editor publishes, and clears them when the editor unmounts", () => {
    const { rerender } = render(
      <EditorPanelsProvider>
        <Refs />
      </EditorPanelsProvider>,
    );
    expect(screen.getByTestId("refs").textContent).toBe("[]");
    rerender(
      <EditorPanelsProvider>
        <PublishRefs refs={REFS} />
        <Refs />
      </EditorPanelsProvider>,
    );
    expect(screen.getByTestId("refs").textContent).toBe(JSON.stringify(REFS));
    rerender(
      <EditorPanelsProvider>
        <Refs />
      </EditorPanelsProvider>,
    );
    expect(screen.getByTestId("refs").textContent).toBe("[]");
  });

  test("publishing the same asset refs again keeps the same array, so the sidebar does not re-render", () => {
    const seen: (readonly string[])[] = [];
    const Capture = () => {
      seen.push(useEditorPanels().assetRefs);
      return null;
    };
    const { rerender } = render(
      <EditorPanelsProvider>
        <PublishRefsOnly refs={[...REFS]} />
        <Capture />
      </EditorPanelsProvider>,
    );
    const published = seen[seen.length - 1];
    expect(published).toEqual(REFS);
    rerender(
      <EditorPanelsProvider>
        <PublishRefsOnly refs={[...REFS]} />
        <Capture />
      </EditorPanelsProvider>,
    );
    expect(seen[seen.length - 1]).toBe(published);
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
