import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorDirtyProvider, useEditorDirty } from "../editor-dirty-context";

const Probe = () => {
  const { isDirty, setDirty } = useEditorDirty();
  return (
    <button type="button" onClick={() => setDirty(!isDirty)}>
      {isDirty ? "dirty" : "clean"}
    </button>
  );
};

describe("EditorDirtyProvider", () => {
  test("starts clean and toggles", async () => {
    const user = userEvent.setup();
    render(
      <EditorDirtyProvider>
        <Probe />
      </EditorDirtyProvider>,
    );
    expect(screen.getByText("clean")).toBeTruthy();
    await user.click(screen.getByText("clean"));
    expect(screen.getByText("dirty")).toBeTruthy();
  });

  test("a consumer outside the provider fails loudly rather than silently losing the guard", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within an EditorDirtyProvider/);
    error.mockRestore();
  });
});
