"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow, IconButton, ThemeToggle } from "@/components/ui";
import { modelChanged, telemetryButton } from "@/components/campaign/messages";
import { useRun } from "@/lib/run-context";
import { getCapabilities, type HostCapabilities } from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";
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
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);

  useEffect(() => {
    let active = true;
    void getCapabilities()
      .then((caps) => {
        if (active) setCapabilities(caps);
      })
      .catch(() => {
        /* No auth chrome without capabilities — the rest of the header still works. */
      });
    return () => {
      active = false;
    };
  }, []);

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
        {capabilities?.auth?.mode === "better-auth" && <BetterAuthSection />}
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

      <MobileMenu
        open={menuOpen}
        onClose={closeMenu}
        tabs={TABS}
        authControls={
          menuOpen && capabilities?.auth?.mode === "better-auth" ? (
            <BetterAuthMobileControls />
          ) : null
        }
      />
    </header>
  );
}

export function UserMenu({
  email,
  onSignOut,
}: {
  readonly email?: string;
  readonly onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="User menu"
        className="flex h-8 items-center gap-1.5 rounded-md border border-border-control bg-surface-2 px-2.5 font-mono text-xs text-text-primary transition-colors hover:bg-surface-3"
      >
        <span className="max-w-[140px] truncate">{email ?? "Account"}</span>
        <svg
          className={cn("size-3 text-text-muted transition-transform", open && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="User menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {email && (
            <div className="truncate border-b border-border px-3 py-1.5 text-xs text-text-secondary">
              {email}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="flex w-full items-center rounded px-3 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-surface-2 hover:text-error"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The mobile menu's auth block — user email, sign-out, and (with more than one
 * organisation) the org switcher. A plain component, not a portal: it is handed to
 * `MobileMenu` through its `authControls` slot (PT-1b2 item 5) rather than reaching
 * for the dialog by querying `[role="dialog"][aria-label="Menu"]` — a portal keyed on
 * a CSS selector is one Header markup change away from silently finding nothing.
 */
export function MobileAuthSection({
  email,
  organizations,
  activeOrgId,
  authError,
  onSwitchOrg,
  onSignOut,
}: {
  readonly email?: string;
  readonly organizations?: Array<{ id: string; name: string }> | null;
  readonly activeOrgId?: string;
  readonly authError?: string | null;
  readonly onSwitchOrg: (orgId: string) => void;
  readonly onSignOut: () => void;
}) {
  const hasMultipleOrgs = Boolean(organizations && organizations.length > 1);

  return (
    <div data-testid="mobile-auth-controls" className="border-t border-border bg-surface p-4">
      {authError && (
        <p role="alert" className="mb-3 text-xs text-error">
          {authError}
        </p>
      )}
      {hasMultipleOrgs && (
        <div className="mb-3">
          <label
            htmlFor="mobile-org-select"
            className="mb-1 block text-xs font-medium text-text-muted"
          >
            Organization
          </label>
          <select
            id="mobile-org-select"
            aria-label="Switch organization"
            value={activeOrgId}
            onChange={(e) => onSwitchOrg(e.target.value)}
            className="h-8 w-full rounded border border-border bg-surface-2 px-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
          >
            {organizations?.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center justify-between text-xs">
        <span className="truncate font-mono text-text-secondary">{email}</span>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded px-2 py-1 text-text-muted transition-colors hover:text-error"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * The session/org state and handlers `BetterAuthSection` (desktop) and
 * `BetterAuthMobileControls` (handed to `MobileMenu`) both need. Each is its own
 * component, mounted only under better-auth mode, so each calling this — and so
 * `authClient`'s own hooks — from its own top level never risks a conditional hook
 * call; the two independent subscriptions this costs are the trade for not lifting
 * the state through Header (which would call these hooks unconditionally, defeating
 * item 4's "not under local auth" contract).
 */
function useBetterAuthState() {
  const session = authClient.useSession();
  const orgs = authClient.useListOrganizations();
  const activeOrg = authClient.useActiveOrganization();
  // Better Auth's client actions resolve `{ data, error }` rather than throwing (the
  // same shape `handleMagicLink` already reads on the sign-in page) — a rejected
  // fetch is the other, rarer failure path, so both are caught here. Neither may
  // reload or navigate: the previous organisation/session is still the live one.
  const [authError, setAuthError] = useState<string | null>(null);

  const email = session?.data?.user?.email;
  const organizations = orgs?.data;
  const activeOrgId = activeOrg?.data?.id ?? organizations?.[0]?.id;

  const handleSwitchOrg = async (orgId: string) => {
    try {
      const res = await authClient.organization.setActive({ organizationId: orgId });
      if (res?.error) {
        setAuthError(res.error.message || "Could not switch organisation.");
        return;
      }
      setAuthError(null);
      window.location.reload();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Could not switch organisation.");
    }
  };

  const handleSignOut = async () => {
    try {
      const res = await authClient.signOut();
      if (res?.error) {
        setAuthError(res.error.message || "Could not sign out.");
        return;
      }
      setAuthError(null);
      window.location.assign("/sign-in");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Could not sign out.");
    }
  };

  return { email, organizations, activeOrgId, authError, handleSwitchOrg, handleSignOut };
}

/** Desktop-only: the org switcher (when there's more than one) and the user menu. */
export function BetterAuthSection() {
  const { email, organizations, activeOrgId, authError, handleSwitchOrg, handleSignOut } =
    useBetterAuthState();
  const hasMultipleOrgs = Boolean(organizations && organizations.length > 1);

  return (
    <div className="hidden items-center gap-3 lg:flex">
      {authError && (
        <span role="alert" className="text-xs text-error">
          {authError}
        </span>
      )}
      {hasMultipleOrgs && (
        <select
          aria-label="Switch organization"
          value={activeOrgId}
          onChange={(e) => void handleSwitchOrg(e.target.value)}
          className="h-8 rounded-md border border-border-control bg-surface-2 px-2 font-mono text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
        >
          {organizations?.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      )}
      <UserMenu email={email} onSignOut={() => void handleSignOut()} />
    </div>
  );
}

/** The `authControls` Header hands `MobileMenu` under better-auth mode. */
export function BetterAuthMobileControls() {
  const { email, organizations, activeOrgId, authError, handleSwitchOrg, handleSignOut } =
    useBetterAuthState();

  return (
    <MobileAuthSection
      email={email}
      organizations={organizations}
      activeOrgId={activeOrgId}
      authError={authError}
      onSwitchOrg={(id) => void handleSwitchOrg(id)}
      onSignOut={() => void handleSignOut()}
    />
  );
}
