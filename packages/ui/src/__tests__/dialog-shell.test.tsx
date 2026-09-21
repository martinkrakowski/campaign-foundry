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
  getFocusableDialogElements,
  dialogHoldsFocus,
} from "../dialog-shell";
import { exerciseFocusTrap } from "./helpers";
import { useRef, useState } from "react";

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
        <DialogHead title="Dialog Title" description="Dialog Description" onClose={onClose} />
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

    // Corrected, not deleted: this asserted the name "Custom Close" on a button whose
    // visible word is "Close Drawer" — a WCAG 2.5.3 (Label in Name) violation, and the
    // exact pairing DialogHead now refuses. The visible text wins.
    await user.click(screen.getByRole("button", { name: "Close Drawer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the icon close control is a 32px IconButton named by closeLabel, Close by default", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(
      <DialogShell open onClose={onClose} ariaLabel="Icon Close">
        <DialogHead title="Icon Close" onClose={onClose} />
      </DialogShell>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("size-8");
    await user.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    // A caller may still name it more precisely — several overlays read
    // "Close drawer", and the suite queries that name.
    const onNamedClose = vi.fn();
    render(
      <DialogShell open onClose={onNamedClose} ariaLabel="Named Icon Close">
        <DialogHead title="Named Icon Close" onClose={onNamedClose} closeLabel="Close drawer" />
      </DialogShell>,
    );
    expect(screen.getByRole("button", { name: "Close drawer" }).className).toContain("size-8");
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

  test("one Escape closes only the topmost overlay, not the overlay beneath it", async () => {
    const user = userEvent.setup();
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    render(
      <div>
        <DialogShell open onClose={onCloseOuter} ariaLabel="Outer Overlay">
          <button type="button">Outer button</button>
        </DialogShell>
        <DialogShell open onClose={onCloseInner} ariaLabel="Inner Overlay">
          <button type="button">Inner button</button>
        </DialogShell>
      </div>,
    );

    const inner = screen.getByRole("dialog", { name: "Inner Overlay" });
    // The inner trap took focus when it opened, so it holds it — the setup the
    // guard relies on.
    expect(dialogHoldsFocus(inner)).toBe(true);

    await user.keyboard("{Escape}");

    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  test("Tab and Shift-Tab cycle between reachable controls when disabled ones bracket the list", () => {
    const onClose = vi.fn();

    render(
      <DialogShell open onClose={onClose} ariaLabel="Disabled Boundaries">
        <button type="button" disabled>
          Disabled first
        </button>
        <button type="button">Real first</button>
        <button type="button">Real last</button>
        <button type="button" disabled>
          Disabled last
        </button>
      </DialogShell>,
    );

    const first = screen.getByRole("button", { name: "Real first" });
    const last = screen.getByRole("button", { name: "Real last" });

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("a dialog whose only controls are disabled ignores Tab without breaking the trap", () => {
    const onClose = vi.fn();

    render(
      <DialogShell open onClose={onClose} ariaLabel="Disabled Only">
        <button type="button" disabled>
          Only control
        </button>
      </DialogShell>,
    );

    fireEvent.keyDown(window, { key: "Tab" });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Only control" }));
  });

  test("Tab on an open shell with no focusable descendants does not throw", () => {
    render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Empty Shell">
        <p>No controls</p>
      </DialogShell>,
    );

    expect(() => fireEvent.keyDown(window, { key: "Tab" })).not.toThrow();
  });

  test("re-rendering with a fresh inline onClose does not re-run the trap and move focus", () => {
    const Controlled = () => {
      const [open, setOpen] = useState(true);
      return (
        <DialogShell open={open} onClose={() => setOpen(false)} ariaLabel="Fresh Callback">
          <button type="button">First</button>
          <button type="button">Second</button>
        </DialogShell>
      );
    };

    const { rerender } = render(<Controlled />);

    const second = screen.getByRole("button", { name: "Second" });
    second.focus();
    expect(document.activeElement).toBe(second);

    // A fresh callback identity (and state round-trip) while the dialog stays open
    // must not tear the trap down: focus stays where the user put it.
    rerender(<Controlled />);
    expect(document.activeElement).toBe(second);

    // And the latest callback is still the one the trap invokes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Fresh Callback" })).toBeNull();
  });

  test("a Tab whose focus is on document.body is contained back into the dialog's first control", () => {
    render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Stray Focus">
        <DialogBody>
          <p>Body text the user may click</p>
        </DialogBody>
        <DialogFoot>
          <button type="button">Solo first</button>
          <button type="button">Solo last</button>
        </DialogFoot>
      </DialogShell>,
    );

    // A click on the panel's non-focusable body text leaves activeElement here.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Solo first" }));
  });

  test("a Shift-Tab whose focus is on document.body is contained back into the dialog's last control", () => {
    render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Stray Shift Focus">
        <button type="button">Solo first</button>
        <button type="button">Solo last</button>
      </DialogShell>,
    );

    (document.activeElement as HTMLElement).blur();
    // Pin the precondition this test exists for: if the blur failed to land on the body,
    // focus would still be on "Solo first" and Shift-Tab there is the pre-existing boundary
    // wrap — green with no containment branch at all.
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Solo last" }));
  });

  test("with two overlays open, a stray Tab lands in the topmost and the lower's first control never receives focus", () => {
    render(
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower first</button>
          <button type="button">Lower last</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper first</button>
          <button type="button">Upper last</button>
        </DialogShell>
      </div>,
    );

    (document.activeElement as HTMLElement).blur();
    const lowerFirst = screen.getByRole("button", { name: "Lower first" });
    const lowerFocus = vi.spyOn(lowerFirst, "focus");

    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Upper first" }));
    // Final position alone cannot discriminate the naive "every trap pulls stray
    // focus into itself" rule — both handlers run, the lower claims for one tick,
    // the upper reclaims. The lower must not claim at all.
    expect(lowerFocus).not.toHaveBeenCalled();
  });

  test("with focus already inside the topmost overlay, the lower does not claim the Tab keystroke", () => {
    render(
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower first</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper first</button>
          <button type="button">Upper middle</button>
          <button type="button">Upper last</button>
        </DialogShell>
      </div>,
    );

    // Park focus on a middle control of the upper: no boundary cycle applies, so the
    // only handler that could preventDefault this event is the lower's — and with
    // the open-order registry rule, none does.
    const middle = screen.getByRole("button", { name: "Upper middle" });
    middle.focus();

    // `cancelable: true` is load-bearing, not decoration. happy-dom's Event constructor
    // defaults `cancelable` to false and `preventDefault()` is a no-op on a non-cancelable
    // event, so without this flag `defaultPrevented` reads false even when a handler DID
    // claim the keystroke — the assertion below could never go red. Verified directly:
    // a handler calling preventDefault on a non-cancelable KeyboardEvent still leaves
    // defaultPrevented false.
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  test("open order, not DOM order, decides which overlay claims a stray Tab", () => {
    const Stacked = ({ upperOpen }: { upperOpen: boolean }) => (
      <div>
        <DialogShell open={upperOpen} onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper first</button>
          <button type="button">Upper last</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower first</button>
          <button type="button">Lower last</button>
        </DialogShell>
      </div>
    );

    // The lower opened first; flipping the upper open makes it the most recently
    // opened overlay — while its dialog element sits BEFORE the lower's in the
    // document, so a DOM-order rule would hand the stray Tab to the lower.
    const { rerender } = render(<Stacked upperOpen={false} />);
    rerender(<Stacked upperOpen={true} />);

    (document.activeElement as HTMLElement).blur();
    const lowerFirst = screen.getByRole("button", { name: "Lower first" });
    const lowerFocus = vi.spyOn(lowerFirst, "focus");

    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Upper first" }));
    expect(lowerFocus).not.toHaveBeenCalled();
  });

  test("a lower trap that still has reachable controls does not claim Tab from the topmost", () => {
    // A kit shell would be inert, so getFocusableDialogElements would be empty
    // and the Tab handler would return before the open-order registry check.
    const LowerTrap = () => {
      const dialogRef = useRef<HTMLDivElement>(null);
      useDialogFocusTrap({ open: true, onClose: vi.fn(), dialogRef });
      return (
        <div ref={dialogRef}>
          <button type="button">Lower first</button>
        </div>
      );
    };

    render(
      <div>
        <LowerTrap />
        <DialogShell open onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper first</button>
        </DialogShell>
      </div>,
    );

    (document.activeElement as HTMLElement).blur();
    const lowerFirst = screen.getByRole("button", { name: "Lower first" });
    const lowerFocus = vi.spyOn(lowerFirst, "focus");

    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Upper first" }));
    expect(lowerFocus).not.toHaveBeenCalled();
  });

  test("a trap whose dialog element never mounts registers nothing and leaves earlier overlays in charge", () => {
    render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Real Overlay">
        <button type="button">Real first</button>
        <button type="button">Real last</button>
      </DialogShell>,
    );

    // Opened after the real overlay — it would be the registry's last entry (and so
    // the one claiming stray Tabs) if the hook registered a trap with no element.
    const Phantom = () => {
      const dialogRef = useRef<HTMLDivElement>(null);
      useDialogFocusTrap({ open: true, onClose: vi.fn(), dialogRef });
      return null;
    };
    render(<Phantom />);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Real first" }));
  });
});

describe("getFocusableDialogElements", () => {
  test("keeps only elements a keyboard user can actually reach", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <button type="button">plain</button>
      <button type="button" disabled>disabled</button>
      <input aria-hidden="true" />
      <span hidden><button type="button">hidden-subtree</button></span>
      <a href="#x">link</a>
      <div tabindex="-1">programmatic-only</div>
      <div tabindex="0">tab-stop</div>
      <p>not focusable</p>
      <div aria-hidden="true"><button type="button">aria-hidden-subtree</button></div>
    `;

    expect(getFocusableDialogElements(container).map((el) => el.textContent)).toEqual([
      "plain",
      "link",
      "tab-stop",
    ]);
  });

  test("skips controls inside an inert subtree", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <button type="button">reachable</button>
      <div inert><button type="button">inert-child</button></div>
    `;
    expect(getFocusableDialogElements(container).map((el) => el.textContent)).toEqual([
      "reachable",
    ]);
  });

  test("returns an empty list for an absent container", () => {
    expect(getFocusableDialogElements(null)).toEqual([]);
  });
});

describe("overlay depth (D84)", () => {
  const overlayNamed = (name: string) =>
    document.querySelector(`[role="dialog"][aria-label="${name}"]`) as HTMLElement | null;

  const effectiveZ = (el: HTMLElement): number => {
    if (el.style.zIndex !== "") return Number(el.style.zIndex);
    const arbitrary = el.className.match(/z-\[(\d+)\]/);
    if (arbitrary) return Number(arbitrary[1]);
    const scale = el.className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
    return scale ? Number(scale[1]) : 0;
  };

  test("closing a lone overlay restores focus to the control that opened it", async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Opener
          </button>
          <DialogShell open={open} onClose={() => setOpen(false)} ariaLabel="From Opener">
            <button type="button">Inside</button>
          </DialogShell>
        </div>
      );
    };

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    expect(screen.getByRole("dialog", { name: "From Opener" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Opener" }));
  });

  test("a single shell is aria-modal, not inert, and keeps its className z", () => {
    const { unmount } = render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Solo Dialog">
        <button type="button">Inside</button>
      </DialogShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "Solo Dialog" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.hasAttribute("inert")).toBe(false);
    expect(dialog.style.zIndex).toBe("");
    expect(dialog.className).toContain("z-[70]");
    unmount();

    render(
      <DrawerShell open onClose={vi.fn()} ariaLabel="Solo Drawer">
        <button type="button">Inside</button>
      </DrawerShell>,
    );
    const drawer = screen.getByRole("dialog", { name: "Solo Drawer" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(drawer.style.zIndex).toBe("");
    expect(drawer.className).toContain("z-50");
  });

  test("a lone shell with a z-[80] override keeps the class and gets no inline z", () => {
    render(
      <DialogShell open onClose={vi.fn()} ariaLabel="Raised Dialog" containerClassName="z-[80]">
        <button type="button">Inside</button>
      </DialogShell>,
    );
    const dialog = screen.getByRole("dialog", { name: "Raised Dialog" });
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.style.zIndex).toBe("");
  });

  test("a buried z-[80] shell cannot tie the upper overlay's paint order", () => {
    render(
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Raised Lower" containerClassName="z-[80]">
          <button type="button">Lower</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Plain Upper">
          <button type="button">Upper</button>
        </DialogShell>
      </div>,
    );

    const lower = overlayNamed("Raised Lower");
    const upper = overlayNamed("Plain Upper");
    expect(lower).toBeTruthy();
    expect(upper).toBeTruthy();
    expect(lower?.className).toContain("z-[80]");
    expect(upper?.style.zIndex).not.toBe("");
    expect(Number(upper?.style.zIndex)).toBeGreaterThan(effectiveZ(lower!));
  });

  test("with two shells open the lower is inert and has no aria-modal, the upper has it", () => {
    render(
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper</button>
        </DialogShell>
      </div>,
    );

    const lower = overlayNamed("Lower Overlay");
    const upper = overlayNamed("Upper Overlay");
    expect(lower).toBeTruthy();
    expect(upper).toBeTruthy();
    expect(lower?.hasAttribute("inert")).toBe(true);
    expect(lower?.hasAttribute("aria-modal")).toBe(false);
    expect(upper?.hasAttribute("inert")).toBe(false);
    expect(upper?.getAttribute("aria-modal")).toBe("true");
  });

  test("closing the upper overlay restores the lower's Escape handler", () => {
    const onCloseLower = vi.fn();
    const Harness = () => {
      const [upperOpen, setUpperOpen] = useState(true);
      return (
        <div>
          <DialogShell open onClose={onCloseLower} ariaLabel="Lower Overlay">
            <button type="button">Lower</button>
          </DialogShell>
          <DialogShell
            open={upperOpen}
            onClose={() => setUpperOpen(false)}
            ariaLabel="Upper Overlay"
          >
            <button type="button">Upper</button>
          </DialogShell>
        </div>
      );
    };

    render(<Harness />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(overlayNamed("Upper Overlay")).toBeNull();
    expect(onCloseLower).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Lower" }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseLower).toHaveBeenCalledTimes(1);
  });

  test("closing the upper overlay restores the lower", () => {
    const Stacked = ({ upperOpen }: { upperOpen: boolean }) => (
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower</button>
        </DialogShell>
        <DialogShell open={upperOpen} onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper</button>
        </DialogShell>
      </div>
    );

    const { rerender } = render(<Stacked upperOpen={true} />);
    expect(overlayNamed("Lower Overlay")?.hasAttribute("inert")).toBe(true);

    rerender(<Stacked upperOpen={false} />);

    const lower = overlayNamed("Lower Overlay");
    expect(overlayNamed("Upper Overlay")).toBeNull();
    expect(lower?.hasAttribute("inert")).toBe(false);
    expect(lower?.getAttribute("aria-modal")).toBe("true");
  });

  test("closing the upper overlay over a lower with no focusable controls does not throw", () => {
    const Harness = () => {
      const [upperOpen, setUpperOpen] = useState(true);
      return (
        <div>
          <DialogShell open onClose={vi.fn()} ariaLabel="Lower Overlay">
            <button type="button" disabled>
              Lower
            </button>
          </DialogShell>
          <DialogShell
            open={upperOpen}
            onClose={() => setUpperOpen(false)}
            ariaLabel="Upper Overlay"
          >
            <button type="button">Upper</button>
          </DialogShell>
        </div>
      );
    };

    render(<Harness />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(overlayNamed("Upper Overlay")).toBeNull();
    expect(overlayNamed("Lower Overlay")?.hasAttribute("inert")).toBe(false);
  });

  test("closing the lower overlay does not steal focus from the upper", () => {
    const Stacked = ({ lowerOpen }: { lowerOpen: boolean }) => (
      <div>
        <DialogShell open={lowerOpen} onClose={vi.fn()} ariaLabel="Lower Overlay">
          <button type="button">Lower</button>
        </DialogShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Upper Overlay">
          <button type="button">Upper</button>
        </DialogShell>
      </div>
    );

    const { rerender } = render(<Stacked lowerOpen={true} />);
    const upperBtn = screen.getByRole("button", { name: "Upper" });
    expect(document.activeElement).toBe(upperBtn);

    rerender(<Stacked lowerOpen={false} />);
    expect(document.activeElement).toBe(upperBtn);
    expect(overlayNamed("Upper Overlay")?.hasAttribute("inert")).toBe(false);
  });

  test("a drawer opened over a dialog paints above it and is the modal layer", () => {
    render(
      <div>
        <DialogShell open onClose={vi.fn()} ariaLabel="Under Dialog">
          <button type="button">Dialog</button>
        </DialogShell>
        <DrawerShell open onClose={vi.fn()} ariaLabel="Over Drawer">
          <button type="button">Drawer</button>
        </DrawerShell>
      </div>,
    );

    const dialog = overlayNamed("Under Dialog");
    const drawer = overlayNamed("Over Drawer");
    expect(dialog?.hasAttribute("inert")).toBe(true);
    expect(dialog?.hasAttribute("aria-modal")).toBe(false);
    expect(drawer?.hasAttribute("inert")).toBe(false);
    expect(drawer?.getAttribute("aria-modal")).toBe("true");
    expect(Number(drawer?.style.zIndex)).toBeGreaterThan(effectiveZ(dialog!));
  });

  test("a dialog opened over a drawer paints above it and is the modal layer", () => {
    render(
      <div>
        <DrawerShell open onClose={vi.fn()} ariaLabel="Under Drawer">
          <button type="button">Drawer</button>
        </DrawerShell>
        <DialogShell open onClose={vi.fn()} ariaLabel="Over Dialog">
          <button type="button">Dialog</button>
        </DialogShell>
      </div>,
    );

    const drawer = overlayNamed("Under Drawer");
    const dialog = overlayNamed("Over Dialog");
    expect(drawer?.hasAttribute("inert")).toBe(true);
    expect(dialog?.hasAttribute("inert")).toBe(false);
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.style.zIndex).not.toBe("");
    expect(Number(dialog?.style.zIndex)).toBeGreaterThan(effectiveZ(drawer!));
  });
});

describe("dialogHoldsFocus", () => {
  test("is true only when focus is inside the passed dialog element", () => {
    const holder = document.createElement("div");
    holder.innerHTML = `<button type="button">inside</button>`;
    document.body.appendChild(holder);
    const inside = holder.querySelector("button");
    const cleanup = () => {
      holder.remove();
    };
    try {
      inside?.focus();
      expect(dialogHoldsFocus(holder)).toBe(true);

      inside?.blur();
      expect(dialogHoldsFocus(holder)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("is false for an absent dialog element", () => {
    expect(dialogHoldsFocus(null)).toBe(false);
  });
});

describe("DialogHead — Label in Name (WCAG 2.5.3)", () => {
  test("a closeLabel that contains the visible word is used as the name", () => {
    render(<DialogHead title="T" onClose={() => {}} closeText="Close" closeLabel="Close drawer" />);
    expect(screen.getByRole("button", { name: "Close drawer" })).toBeTruthy();
  });

  test("a closeLabel that would hide the visible word is ignored", () => {
    // Announcing "Close drawer" on a button reading "Done" makes voice control fail:
    // the user says what they see and nothing happens. The visible text wins instead.
    render(<DialogHead title="T" onClose={() => {}} closeText="Done" closeLabel="Close drawer" />);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close drawer" })).toBeNull();
  });
});
