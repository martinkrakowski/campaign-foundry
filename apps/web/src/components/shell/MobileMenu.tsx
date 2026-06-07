"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { SidebarContent } from "./Sidebar";

interface NavTab {
  href: string;
  label: string;
}

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  tabs: readonly NavTab[];
}

/**
 * Fullscreen navigation + brief panel for small screens (the desktop sidebar and the
 * header's centered tabs collapse into this below `lg`). Portalled to <body> so it
 * sits above the whole shell. Closes on a link tap, the × button, or Escape; traps
 * focus and locks body scroll while open.
 */
export function MobileMenu({ open, onClose, tabs }: MobileMenuProps) {
  const pathname = usePathname();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Lock background scroll while the menu owns the viewport.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  // Close on navigation so any in-menu link (the tabs, but also the brief "Edit"
  // link inside SidebarContent) dismisses the overlay rather than leaving it open
  // over the new route. Skips the initial render (the path the menu opened on).
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (open && pathname !== openedAt.current) onClose();
    openedAt.current = pathname;
  }, [pathname, open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[60] flex flex-col bg-background lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Menu</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="text-text-muted transition-colors hover:text-white"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <nav className="flex flex-col border-b border-border p-2">
          {tabs.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                onClick={onClose}
                className={cn(
                  "rounded-lg px-3 py-3 text-[15px] font-medium transition-colors",
                  active ? "bg-surface-2 text-white" : "text-text-muted hover:bg-surface hover:text-white",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <SidebarContent />
      </div>
    </div>,
    document.body,
  );
}
