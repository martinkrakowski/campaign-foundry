"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow, IconButton, ThemeToggle } from "@/components/ui";
import { modelChanged, telemetryButton } from "@/components/campaign/messages";
import { useRun } from "@/lib/run-context";
import { ModelSelector } from "./ModelSelector";
import { TELEMETRY_DRAWER_ID } from "./TelemetryDrawer";
import { MobileMenu } from "./MobileMenu";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";

/** Where the app opens, and where the brand mark goes back to. */
const HOME = "/grid";

/**
 * The route tabs, in the order a campaign meets them: the brief is written first, then
 * reviewed on the grid, then checked, exported and re-run. No `href` here is a prefix
 * of another, which is what makes `startsWith` a safe test for the current tab.
 */
const TABS = [
  { href: "/brief", label: "Brief" },
  { href: "/grid", label: "Grid" },
  { href: "/compliance", label: "Compliance" },
  { href: "/export", label: "Export" },
  { href: "/runs", label: "Runs" },
] as const;

/** Top application bar: brand, centered tab nav (desktop), model selector, mobile menu. */
export function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // The header's one status line: what a verb it owns answered when it was pressed.
  // SG-D10 left it exactly one owner — the model selector, whose choice has no
  // visible effect until the next run, so the header states what that run will use.
  const [notice, setNotice] = useState<string | null>(null);
  const { guardedPush, isDirty } = useGuardedNavigation();
  const { telemetryOpen, toggleTelemetry } = useRun();
  // Stable identity so MobileMenu's focus/scroll-lock effect only runs on open/close,
  // not on unrelated Header re-renders.
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleTabClick = useCallback(
    (e: React.MouseEvent, href: string) => {
      // A modified or non-primary click is the browser's to handle — new tab, new
      // window, download. Lane W1 fixed exactly this in `MobileMenu`; the guard was
      // never mirrored here, so a dirty Cmd-click opened the unsaved-edits flow
      // instead of a new tab. Clean clicks need no branch: these are `next/link`
      // anchors, which already honour a modified click themselves.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      if (isDirty) {
        e.preventDefault();
        guardedPush(href);
      }
    },
    [isDirty, guardedPush],
  );

  // SG-D10 — Generate has LEFT this header, and with it three pieces of machinery
  // that existed only because the verb lived outside the editor:
  //
  //  * D35's three-way question ("run this draft, or save and run?"). The editor's
  //    own Generate hands `execute` the on-screen projection as its target, so there
  //    are no longer two candidate briefs to choose between.
  //  * The `briefApplied` refusal and its ROUTING reveal. The comment this replaces
  //    said it out loud: "the header cannot scroll a section it does not render, so
  //    it routes to the view that can." The editor renders those sections, so its
  //    Validate reveals them in place — there is nothing to route to.
  //  * GB-D3's `refuseDraftRun` handoff and its deferred-refusal effect, which
  //    existed so this header's dialog could carry the editor's refusal upward, one
  //    commit late, around its own focus trap. Nothing carries upward now.
  //
  // What survives is D3's principle, in SG-D11's narrower form: the editor's slot is
  // never a dead button either — it offers Validate until the document has validated
  // clean, and a failing validation answers out loud where the fields are.

  return (
    <header className="relative z-50 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center space-x-4">
        {/* Home, through the same guard the tabs use — one prompt, never a second
            one, and a plain link otherwise so a new-tab click still works. */}
        <Link
          href={HOME}
          onClick={(e) => handleTabClick(e, HOME)}
          className="flex items-center space-x-2 rounded-sm"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-primary text-xs font-bold text-brand-on-primary">
            CF
          </div>
          <div className="flex cursor-default items-center space-x-2 text-text-primary">
            <span className="hidden text-sm font-medium sm:inline">Campaign Pipeline</span>
          </div>
        </Link>
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
              aria-current={active ? "page" : undefined}
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

      {/* `min-w-0` so the model label can truncate instead of pushing the row past a
          320px viewport — this cluster gained two controls in this lane. */}
      <div className="flex min-w-0 items-center gap-3 text-sm sm:gap-4">
        <ModelSelector onModelChange={(label) => setNotice(modelChanged(label))} />
        <Eyebrow as="span" className="hidden text-[10px] lg:inline">
          HITL Mode Active
        </Eyebrow>
        {/* Telemetry: a panel, not a dialog, and no draft change — so it asks the
            unsaved-changes guard nothing at all. */}
        <IconButton
          label={telemetryButton}
          onClick={toggleTelemetry}
          aria-expanded={telemetryOpen}
          aria-controls={TELEMETRY_DRAWER_ID}
        >
          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M4 15V9a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2z"
            />
          </svg>
        </IconButton>
        <ThemeToggle />
        {/* SG-D10: the run verb stood here. It is in the editor's own action bar now,
            in one slot with Validate — the placement the owner retracted as an error. */}
        {/* Hamburger — mobile only. */}
        <IconButton
          label="Open menu"
          onClick={() => setMenuOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className="lg:hidden"
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </IconButton>
      </div>

      {/* The header's status line. Absolutely placed under the bar rather than inside
          it: the bar's row is full and its height is fixed. */}
      {notice !== null && (
        <p
          role="status"
          className="absolute right-4 top-full z-50 mt-2 w-72 max-w-[calc(100vw_-_2rem)] rounded-md border border-border bg-surface px-3 py-2 text-[11px] leading-4 text-text-secondary shadow-2xl"
        >
          {notice}
        </p>
      )}

      <MobileMenu open={menuOpen} onClose={closeMenu} tabs={TABS} />
    </header>
  );
}
