"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";
import { ModelSelector } from "./ModelSelector";
import { MobileMenu } from "./MobileMenu";

const TABS = [
  { href: "/grid", label: "Grid" },
  { href: "/compliance", label: "Compliance" },
  { href: "/export", label: "Export" },
  { href: "/runs", label: "Runs" },
] as const;

/** Top application bar: brand, centered tab nav (desktop), model selector, mobile menu. */
export function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // Stable identity so MobileMenu's focus/scroll-lock effect only runs on open/close,
  // not on unrelated Header re-renders.
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <header className="relative z-50 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center space-x-4">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-primary text-xs font-bold text-white">
          CF
        </div>
        <div className="flex cursor-default items-center space-x-2 text-text-primary">
          <span className="hidden text-sm font-medium sm:inline">Campaign Pipeline</span>
        </div>
      </div>

      {/* Centered tab nav — desktop only; collapses into the mobile menu below lg. */}
      <nav className="absolute left-1/2 hidden h-full -translate-x-1/2 space-x-6 text-sm font-medium lg:flex">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex h-full items-center border-b-2 px-1 transition-colors",
                active
                  ? "border-white text-white"
                  : "border-transparent text-text-muted hover:text-white",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3 text-sm sm:gap-4">
        <ModelSelector />
        <span className="hidden font-mono text-[10px] uppercase tracking-widest text-text-muted lg:inline">
          HITL Mode Active
        </span>
        {/* Hamburger — mobile only. */}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className="text-text-muted transition-colors hover:text-white lg:hidden"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <MobileMenu open={menuOpen} onClose={closeMenu} tabs={TABS} />
    </header>
  );
}
