"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
 * Known gap: `role="menu"` conventionally promises Arrow/Home/End navigation, which
 * this does not implement — the items are ordinary tabbable buttons, so the menu is
 * operable by Tab but does not behave as the ARIA authoring practices describe.
 */
export function OverflowMenu({ label, items }: OverflowMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = `overflow-menu-${useId()}`;

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
   * Close and restore focus BEFORE acting: the action may mount a dialog, and that
   * dialog's trap reads `document.activeElement` to know where to send focus back.
   */
  const choose = (action: () => void) => {
    close();
    action();
  };

  return (
    <div ref={root} className="relative">
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
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
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
