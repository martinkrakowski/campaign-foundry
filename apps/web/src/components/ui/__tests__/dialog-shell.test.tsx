import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DialogShell,
  DrawerShell,
  DialogHead,
  DialogBody,
  DialogFoot,
  useDialogFocusTrap,
} from "../dialog-shell";
import { exerciseFocusTrap } from "@/__tests__/helpers";
import { useRef } from "react";

describe("DialogShell and DrawerShell anatomy", () => {
  test("DialogShell and DrawerShell render nothing when open is false", () => {
    const { container: dialogContainer } = render(
      <DialogShell open={false} onClose={vi.fn()}>
        <div>Content</div>
      </DialogShell>,
    );
    expect(dialogContainer.firstChild).toBeNull();

    const { container: drawerContainer } = render(
      <DrawerShell open={false} onClose={vi.fn()}>
        <div>Drawer Content</div>
      </DrawerShell>,
    );
    expect(drawerContainer.firstChild).toBeNull();
  });

  test("DialogShell renders modal dialog with accessible label, traps focus, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <DialogShell open={true} onClose={onClose} ariaLabel="Test Dialog">
        <DialogHead
          title="Dialog Title"
          description="Dialog Description"
          onClose={onClose}
        />
        <DialogBody>
          <button type="button">Inside Button</button>
        </DialogBody>
        <DialogFoot>
          <button type="button">Footer Action</button>
        </DialogFoot>
      </DialogShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "Test Dialog" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Dialog Title")).toBeTruthy();
    expect(screen.getByText("Dialog Description")).toBeTruthy();

    exerciseFocusTrap(dialog);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("DialogShell backdrop click triggers onClose, but clicking dialog content does not", () => {
    const onClose = vi.fn();

    render(
      <DialogShell open={true} onClose={onClose} ariaLabel="Backdrop Dialog">
        <DialogHead title="Backdrop Test" />
        <DialogBody>
          <div>Inner Text</div>
        </DialogBody>
      </DialogShell>,
    );

    const dialog = screen.getByRole("dialog");
    const inner = screen.getByText("Inner Text");

    fireEvent.click(inner);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("DrawerShell renders side drawer, traps focus, and supports closeText and closeLabel in DialogHead", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <DrawerShell open={true} onClose={onClose} ariaLabel="Test Drawer">
        <DialogHead
          title="Drawer Title"
          onClose={onClose}
          closeLabel="Custom Close"
          closeText="Close Drawer"
          actions={<span>Action</span>}
        />
        <DialogBody>
          <button type="button">Drawer Item</button>
        </DialogBody>
      </DrawerShell>,
    );

    const drawer = screen.getByRole("dialog", { name: "Test Drawer" });
    expect(drawer).toBeTruthy();
    expect(screen.getByText("Drawer Title")).toBeTruthy();
    expect(screen.getByText("Action")).toBeTruthy();

    exerciseFocusTrap(drawer);

    await user.click(screen.getByRole("button", { name: "Custom Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("DrawerShell backdrop click triggers onClose", () => {
    const onClose = vi.fn();

    const { container } = render(
      <DrawerShell open={true} onClose={onClose} ariaLabel="Drawer Backdrop">
        <div>Drawer Content</div>
      </DrawerShell>,
    );

    const scrim = container.querySelector(".bg-scrim\\/80");
    expect(scrim).toBeTruthy();
    if (scrim) fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("useDialogFocusTrap supports initialFocusRef", () => {
    const Harness = () => {
      const dialogRef = useRef<HTMLDivElement>(null);
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      useDialogFocusTrap({
        open: true,
        onClose: vi.fn(),
        dialogRef,
        initialFocusRef,
      });

      return (
        <div ref={dialogRef}>
          <button type="button">First</button>
          <button ref={initialFocusRef} type="button">
            Target Focus
          </button>
        </div>
      );
    };

    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Target Focus" }));
  });
});
