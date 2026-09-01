"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
 * Focus needs no imperative restoration: opening never moves focus off the trigger,
 * so closing has nothing to give back. That holds precisely because this is a
 * popup and not a focus-trapping dialog — for those, use `DialogShell`.
 */
export function OverflowMenu({ label, items }: OverflowMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `click`: the menu must be gone by the time the press
    // lands, so the control the user aimed at receives its own click normally.
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /** Close first, then act: a chosen item must not leave the panel over the result. */
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative">
      <IconButton
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </IconButton>
      {open ? (
        <div
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
