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

  test("the context value keeps its identity across a provider re-render that changes no flag", async () => {
    // The value is what every consumer re-renders ON, and this app's tree hangs
    // off it almost entirely — the nav guard, the unload guard, every editor. A
    // fresh object on each provider render re-renders all of them for a change
    // none of them reads, and the one render in this app that does exactly that
    // is `pendingAction`: the confirm dialog opening and closing is state this
    // provider holds and does not publish.
    const user = userEvent.setup();
    const seen: ReturnType<typeof useEditorDirty>[] = [];
    const Identity = ({ tick }: { tick: number }) => {
      const { isDirty, setDirty, guardedAction } = useEditorDirty();
      seen.push(useEditorDirty());
      return (
        <>
          <span data-testid="tick">{tick}</span>
          <button type="button" onClick={() => setDirty(!isDirty)}>
            {isDirty ? "dirty" : "clean"}
          </button>
          <button type="button" onClick={() => guardedAction(() => undefined)}>
            guard-action
          </button>
        </>
      );
    };
    const Tree = ({ tick }: { tick: number }) => (
      <EditorDirtyProvider>
        <Identity tick={tick} />
      </EditorDirtyProvider>
    );
    const view = render(<Tree tick={0} />);
    await user.click(screen.getByText("clean")); // set dirty
    const afterDirty = seen.at(-1)!;

    // The dialog opens: `pendingAction` moves, `isDirty` does not. The provider
    // re-renders, and with nothing published changed its consumers must not.
    const beforeDialog = seen.length;
    await user.click(screen.getByText("guard-action"));
    expect(await screen.findByRole("dialog", { name: "Unsaved edits" })).toBeTruthy();
    expect(seen.length).toBe(beforeDialog);

    // Re-render the consumer on its own account, to read the value it is
    // handed when something other than the provider moved: same published
    // flags, so the same object.
    view.rerender(<Tree tick={1} />);
    expect(seen.length).toBe(beforeDialog + 1);
    expect(seen.at(-1)).toBe(afterDirty);
  });
});
