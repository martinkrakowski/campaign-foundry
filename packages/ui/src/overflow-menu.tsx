"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { IconButton } from "./icon-button";

export interface OverflowMenuItem {
  /** The item's visible text, which is also its accessible name. */
  readonly label: string;
  readonly onSelect: () => void;
}

export interface OverflowMenuProps {
  /** Accessible name for the icon-only trigger, e.g. "More actions". */
  readonly label: string;
  readonly items: readonly OverflowMenuItem[];
}

/**
 * The `⋯` popup holding a row's secondary verbs (D40).
 *
 * This exists because a bare `<details>`/`<summary>` is NOT a menu: it closes only
 * when its own summary is clicked again, so a click anywhere else, an Escape, or
 * choosing an item all leave it hanging open over the content. #162 replaced the
 * old SaveMenu — which owned all three of those paths — with exactly that markup,
 * and the menu became impossible to dismiss. The dismissal logic below is that
 * component's, restored.
 *
 * The panel opens upward (`bottom-full`) because its only caller is the editor's
 * bottom-anchored action bar.
 *
 * Every close hands focus back to the trigger. That matters beyond tidiness: an item
 * is unmounted by the very click that activates it, so without this the keyboard user
 * who chose it lands on `document.body` — and when the item opens a dialog, the
 * dialog's focus trap captures that vanishing item as its restoration target and
 * returns focus to nothing on close.
 *
 * The menu behaves as the ARIA authoring practices describe for a menu button:
 * ArrowDown/ArrowUp on the trigger open it onto the first/last item (Enter and Space
 * open onto the first), the items hold roving focus — `tabIndex={-1}` and reachable
 * only from inside — moved with ArrowUp/ArrowDown (wrapping at both ends) and jumped
 * with Home/End, and Tab closes the menu and lets the browser move focus on. A mouse
 * click opens without moving focus, as a click anywhere does.
 */
export function OverflowMenu({ label, items }: OverflowMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = `overflow-menu-${useId()}`;
  // Bound the ref array to the current item count. React nulls a ref on unmount but
  // leaves the array's length alone, so a shrinking list would keep `navigate`'s
  // modulo reaching past the end and focus would land on nothing.
  itemRefs.current.length = items.length;

  /** Close, then put focus back where it can be seen. */
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `click`: the menu must be gone by the time the press
    // lands, so the control the user aimed at receives its own click normally.
    // A press outside is the user pointing elsewhere — it must NOT pull focus
    // back to the trigger, so it closes without restoring.
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Close and restore focus BEFORE acting, and *commit* that close first.
   *
   * Two reasons the ordinary batched `setOpen(false)` is not enough. An action may
   * mount a dialog, whose focus trap reads `document.activeElement` to learn where
   * to send focus back — it must not read a menu item about to unmount. And the
   * dialog opens from the click's own handler while the panel would still be
   * painted behind it: committing the close first means the panel is already gone
   * when the dialog's open handler runs. `flushSync` is the supported way to get
   * the DOM updated before the action takes over.
   */
  const choose = (action: () => void) => {
    flushSync(close);
    action();
  };

  /**
   * Open and land focus on an item, without waiting for a render.
   *
   * The items exist only once React commits, and a keydown handler runs before
   * that — so the open is flushed here, exactly like `choose` flushes the close,
   * and the focus lands on a ref the commit just filled.
   */
  const openAndFocus = (index: number) => {
    flushSync(() => setOpen(true));
    itemRefs.current[index]?.focus();
  };

  /** Move roving focus one step from the item it sits on, wrapping at both ends. */
  const navigate = (delta: number) => {
    const refs = itemRefs.current;
    const index = refs.findIndex((node) => node === document.activeElement);
    refs[(index + delta + refs.length) % refs.length]?.focus();
  };

  /**
   * The menu keyboard contract (APG). On the trigger: ArrowDown/ArrowUp open onto
   * the last/first item, Enter and Space toggle like the click they stand in for.
   * On the items: arrows move (wrapping), Home/End jump, Tab closes and — because
   * the items are out of the tab order — lets the browser carry focus past the
   * trigger. Escape is deliberately absent: the document listener below owns it.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target === trigger.current) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          openAndFocus(0);
          break;
        case "ArrowUp":
          event.preventDefault();
          openAndFocus(items.length - 1);
          break;
        case "Enter":
        case " ":
          // Stand in for the native click exactly: preventDefault keeps the
          // button's own activation from toggling a second time. The space bar
          // reports `key === " "`; a `"Space"` case would be dead code, and the
          // test must press it as `[Space]` (the code) or " " — userEvent's
          // `{Space}` means a key literally NAMED "Space", which no browser sends.
          event.preventDefault();
          if (open) close();
          else openAndFocus(0);
          break;
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        navigate(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        navigate(-1);
        break;
      case "Home":
        event.preventDefault();
        itemRefs.current[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        itemRefs.current[items.length - 1]?.focus();
        break;
      case "Tab":
        close();
        break;
    }
  };

  // A menu with nothing in it is not a control: rendering the trigger would offer a
  // press that can only open an empty panel.
  if (items.length === 0) return null;

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <IconButton
        ref={trigger}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        // Only while the panel exists: `aria-controls` pointing at nothing is a
        // broken relationship for assistive tech, the rule `Disclosure` documents.
        {...(open ? { "aria-controls": menuId } : {})}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </IconButton>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute bottom-full right-0 z-30 mb-2 min-w-[200px] overflow-hidden rounded-md border border-border bg-surface p-1 shadow-2xl"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              // Roving focus: Tab leaves the menu rather than walking it, so the
              // items are reachable only through the arrow keys.
              tabIndex={-1}
              className="w-full rounded-sm px-3 py-2 text-left text-[13px] text-text-primary hover:bg-surface-2"
              onClick={() => choose(item.onSelect)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
