"use client";

import { useEffect, useState, useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

const STORAGE_PREFIX = "cf:disclosure:";

/** Reads the remembered open state; a blocked or absent store reads as closed. */
function readStoredOpen(id: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

/** Persists the open state; a blocked store must never break the toggle. */
function writeStoredOpen(id: string, open: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (open) localStorage.setItem(STORAGE_PREFIX + id, "1");
    else localStorage.removeItem(STORAGE_PREFIX + id);
  } catch {
    /* quota exceeded or storage disabled — the choice still holds for this render */
  }
}

/**
 * A collapsible region for the controls a first-timer does not need (D6): closed by
 * default, its open state remembered per section (`id`) in localStorage, so opening
 * Advanced once does not punish the user by closing it on every visit. The trigger
 * states its expansion via `aria-expanded`/`aria-controls`; the content is ordinary
 * flow, not a dialog — it never traps focus and needs no Escape handling.
 */
export function Disclosure({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  // Closed on the first render, always: the server has no storage, so reading it in the
  // initializer would render closed there and open here, and hydration would mismatch.
  // The remembered state is applied on mount instead.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (readStoredOpen(id)) setOpen(true);
  }, [id]);
  const panelId = `disclosure-panel-${useId()}`;
  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        // only while the panel exists: aria-controls pointing at nothing is a broken
        // relationship for assistive tech, and the panel is unmounted when closed.
        {...(open ? { "aria-controls": panelId } : {})}
        onClick={() => {
          const next = !open;
          setOpen(next);
          writeStoredOpen(id, next);
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        )}
      >
        <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">{title}</span>
        <svg
          viewBox="0 0 24 24"
          focusable="false"
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-text-muted transition-transform", open ? "rotate-180" : "")}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
            fill="none"
            stroke="currentColor"
          />
        </svg>
      </button>
      {open ? (
        <div id={panelId} className="space-y-6 border-t border-border p-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}
