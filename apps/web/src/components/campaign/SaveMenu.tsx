"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import {
  saveMenuLabel,
  saveMenuItemSave,
  saveMenuItemSaveHint,
  saveMenuItemSaveAs,
  saveMenuItemSaveAsHint,
} from "./messages";

/**
 * D3: there is no validity `disabled` here. An invalid draft must still be able to open
 * this menu, because choosing an item is how the user asks for the refusal — only an
 * in-flight write (`saving`) closes the control off.
 *
 * D35: the two ways to persist a draft — in place, or as a copy — behind one control,
 * so the action bar stays short. "Apply" is no longer part of the copy: both items
 * commit the brief to the shell as well as write the file, because every persist path
 * does, and saying so twice was the four-verbs-for-two-ideas problem this menu's
 * vocabulary collapse exists to end. Opens upward (it sits in a footer).
 */
export function SaveMenu({
  saving,
  onSave,
  onSaveAs,
}: {
  saving: boolean;
  onSave: () => void;
  onSaveAs: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative">
      <Button
        variant="secondary"
        disabled={saving}
        isLoading={saving}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {saveMenuLabel}
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label={saveMenuLabel}
          className="absolute bottom-full right-0 z-50 mb-2 min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onSave)}
            className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-surface-2"
          >
            <span className="text-[13px] text-text-primary">{saveMenuItemSave}</span>
            <span className="text-[11px] text-text-muted">{saveMenuItemSaveHint}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onSaveAs)}
            className="flex w-full flex-col items-start border-t border-border px-3 py-2 text-left transition-colors hover:bg-surface-2"
          >
            <span className="text-[13px] text-text-primary">{saveMenuItemSaveAs}</span>
            <span className="text-[11px] text-text-muted">{saveMenuItemSaveAsHint}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
