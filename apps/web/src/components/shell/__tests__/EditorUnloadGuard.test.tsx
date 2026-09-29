import { describe, test, expect, vi, type MockInstance } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorDirtyProvider, useEditorDirty } from "@/lib/editor-dirty-context";
import { EditorUnloadGuard } from "../EditorUnloadGuard";

/**
 * D185 — the shell's leave guard, on its own: what it registers, when, and what
 * it does to the event. What the editor PUBLISHES into this context is
 * `brief-editor.drafts.test.tsx`'s half, and the two meet end to end in the
 * "a 500 keeps the tab guarded" test in that file.
 */
const Probe = () => {
  const { setDirty, setPendingWrite, setFailedWrite } = useEditorDirty();
  return (
    <>
      <button type="button" onClick={() => setDirty(true)}>
        make-dirty
      </button>
      <button type="button" onClick={() => setDirty(false)}>
        make-clean
      </button>
      <button type="button" onClick={() => setPendingWrite(true)}>
        make-pending
      </button>
      <button type="button" onClick={() => setFailedWrite(false)}>
        clear-failure
      </button>
      <button type="button" onClick={() => setFailedWrite(true)}>
        make-failed
      </button>
    </>
  );
};

const renderGuard = () =>
  render(
    <EditorDirtyProvider>
      <EditorUnloadGuard />
      <Probe />
    </EditorDirtyProvider>,
  );

/**
 * Built by hand rather than through a helper because `cancelable` decides
 * whether this test can fail at all: happy-dom defaults every event to
 * `cancelable: false`, and on such an event `preventDefault()` is a no-op, so a
 * guard that registered nothing would pass an assertion written against it.
 */
const unload = (): Event => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

/** Registrations of THIS event type, ignoring everything else on the window. */
const guardCalls = (spy: MockInstance) =>
  spy.mock.calls.filter(([type]) => type === "beforeunload");

describe("EditorUnloadGuard", () => {
  test("a clean editor registers no beforeunload listener at all", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    renderGuard();

    // The whole point of the gate: a listener present at all makes the page
    // ineligible for the back/forward cache, so "clean" has to cost nothing.
    expect(guardCalls(add)).toHaveLength(0);
    expect(guardCalls(remove)).toHaveLength(0);
    expect(unload().defaultPrevented).toBe(false);
  });

  test("a dirty editor prevents the unload and sets returnValue", async () => {
    const user = userEvent.setup();
    renderGuard();
    await user.click(screen.getByText("make-dirty"));

    const event = unload();
    expect(event.defaultPrevented).toBe(true);
    // The legacy half of the same signal: an engine honouring only this one is
    // exactly the case where a handler that set just `preventDefault` is inert.
    expect(event.returnValue).toBe("");
  });

  test("a draft write still on the chain prevents the unload", async () => {
    // A clean editor whose autosave has not landed yet has the operator's edits
    // nowhere but the wire — `isDirty` is not the only kind of unsaved work.
    const user = userEvent.setup();
    renderGuard();
    await user.click(screen.getByText("make-pending"));

    expect(unload().defaultPrevented).toBe(true);
  });

  test("a draft write that failed prevents the unload", async () => {
    // Nothing is pending any more and the editor may well be clean; the write
    // did not land, so the edits are on the screen and nowhere else.
    const user = userEvent.setup();
    renderGuard();
    await user.click(screen.getByText("make-failed"));

    expect(unload().defaultPrevented).toBe(true);
  });

  test("the listener is released as soon as the dirty editor goes clean", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    renderGuard();

    await user.click(screen.getByText("make-dirty"));
    expect(guardCalls(add)).toHaveLength(1);
    expect(unload().defaultPrevented).toBe(true);

    await user.click(screen.getByText("make-clean"));
    expect(guardCalls(remove)).toHaveLength(1);
    expect(unload().defaultPrevented).toBe(false);
  });

  test("a later PUT that lands releases the listener a failed write armed", async () => {
    // The editor's own half of this is `brief-editor.drafts.test.tsx`: a PUT
    // answering 500 sets the flag, and the next one that lands clears it. This
    // is what that clearing does to the listener.
    const user = userEvent.setup();
    renderGuard();
    await user.click(screen.getByText("make-failed"));
    expect(unload().defaultPrevented).toBe(true);

    await user.click(screen.getByText("clear-failure"));
    expect(unload().defaultPrevented).toBe(false);
  });
});
