import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorDirtyProvider, useEditorDirty } from "../editor-dirty-context";
import { nextMock } from "@/__tests__/helpers";

const Probe = () => {
  const { isDirty, setDirty, guardedAction, guardedPush } = useEditorDirty();
  return (
    <div>
      <button type="button" onClick={() => setDirty(!isDirty)}>
        {isDirty ? "dirty" : "clean"}
      </button>
      <button type="button" onClick={() => guardedAction(() => nextMock().router.push("/action"))}>
        trigger-action
      </button>
      <button type="button" onClick={() => guardedPush("/push")}>
        trigger-push
      </button>
    </div>
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

  test("runs guardedAction and guardedPush immediately when clean", async () => {
    const user = userEvent.setup();
    render(
      <EditorDirtyProvider>
        <Probe />
      </EditorDirtyProvider>,
    );

    await user.click(screen.getByText("trigger-action"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/action");

    await user.click(screen.getByText("trigger-push"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/push");
  });

  test("intercepts guardedAction and guardedPush when dirty, prompting with ConfirmDialog", async () => {
    const user = userEvent.setup();
    render(
      <EditorDirtyProvider>
        <Probe />
      </EditorDirtyProvider>,
    );

    await user.click(screen.getByText("clean")); // set dirty
    await user.click(screen.getByText("trigger-action"));

    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    // cancel
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());

    // trigger push and confirm
    await user.click(screen.getByText("trigger-push"));
    const dialog2 = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog2).getByRole("button", { name: "Leave" }));
    expect(nextMock().router.push).toHaveBeenCalledWith("/push");
  });

  test("a consumer outside the provider fails loudly rather than silently losing the guard", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within an EditorDirtyProvider/);
    error.mockRestore();
  });
});
