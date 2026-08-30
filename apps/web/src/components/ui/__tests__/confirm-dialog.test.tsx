import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "../confirm-dialog";
import { exerciseFocusTrap } from "@/__tests__/helpers";

describe("ConfirmDialog", () => {
  test("renders nothing when open is false", () => {
    render(
      <ConfirmDialog
        open={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders custom title, message, labels, and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        title="Custom Title"
        message="Custom warning message"
        confirmLabel="Proceed"
        cancelLabel="Abort"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Custom Title" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Custom warning message")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Proceed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abort" })).toBeTruthy();

    exerciseFocusTrap(dialog);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking confirm triggers onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("clicking cancel triggers onClose", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("clicking Close icon triggers onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking scrim triggers onClose, but clicking dialog content does not", () => {
    const onClose = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const content = screen.getByText("Unsaved edits");

    fireEvent.click(content);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
