"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow, IconButton, ThemeToggle } from "@/components/ui";
import { ModelSelector } from "./ModelSelector";
import { MobileMenu } from "./MobileMenu";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";

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
  const { guardedPush, isDirty } = useGuardedNavigation();
  // Stable identity so MobileMenu's focus/scroll-lock effect only runs on open/close,
  // not on unrelated Header re-renders.
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleTabClick = useCallback(
    (e: React.MouseEvent, href: string) => {
      if (isDirty) {
        e.preventDefault();
        guardedPush(href);
      }
    },
    [isDirty, guardedPush]
  );

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
              onClick={(e) => handleTabClick(e, tab.href)}
              className={cn(
                "flex h-full items-center border-b-2 px-1 transition-colors",
                active
                  ? "border-text-emphasis text-text-emphasis"
                  : "border-transparent text-text-muted hover:text-text-emphasis",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-3 text-sm sm:gap-4">
        <ModelSelector />
        <Eyebrow as="span" className="hidden text-[10px] lg:inline">
          HITL Mode Active
        </Eyebrow>
        <ThemeToggle />
        {/* Hamburger — mobile only. */}
        <IconButton
          label="Open menu"
          onClick={() => setMenuOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className="lg:hidden"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </IconButton>
      </div>

      <MobileMenu open={menuOpen} onClose={closeMenu} tabs={TABS} />
    </header>
  );
}
