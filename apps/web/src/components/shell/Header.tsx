"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { cn } from "@/lib/cn";
import { Button, DialogBody, DialogFoot, DialogHead, DialogShell, Eyebrow, IconButton, ThemeToggle } from "@/components/ui";
import {
  confirmCancel,
  generate,
  generateDraftBlocked,
  generateDraftRunThis,
  generateDraftRunThisHint,
  generateDraftSaveRun,
  generateDraftSaveRunHint,
  generateDraftTitle,
  generateNoBrief,
  modelChanged,
  telemetryButton,
} from "@/components/campaign/messages";
import { SECTION_TITLES, type SectionId } from "@/components/campaign/sections";
import { useRun } from "@/lib/run-context";
import { ModelSelector } from "./ModelSelector";
import { TELEMETRY_DRAWER_ID } from "./TelemetryDrawer";
import { MobileMenu } from "./MobileMenu";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
import type { DraftRunHandoff } from "@/lib/editor-dirty-context";

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

/**
 * D35 — the three-way question, rendered only from a published handoff. The handoff
 * arrives as a prop (never read from context at press time), so the answers close
 * over a `DraftRunHandoff` that exists — the null case was removed from the handoff's
 * draft type, so there is no unreachable "dialog outlived its draft" branch to
 * exclude from coverage.
 */
function DraftRunDialog({
  handoff,
  onClose,
  onRun,
  onRefuse,
}: {
  handoff: DraftRunHandoff;
  onClose: () => void;
  onRun: (brief: CampaignBrief) => void;
  onRefuse: (blocked: SectionId, refuse: () => boolean) => void;
}) {
  /** "Run this draft" — POST the on-screen draft, write nothing, commit nothing. */
  const runThisDraft = useCallback(() => {
    // Read the draft and the editor's verdict before closing: the editor unpublishes
    // the handoff exactly when its draft stops differing, and that unmounts this
    // dialog with it.
    const draft = handoff.draftRef.current;
    const blocked = handoff.blockedRef.current;
    onClose();
    if (blocked !== null) {
      // GB-D3: never a dead button. An invalid draft refuses the way Save refuses —
      // attempted, reveal, state the first issue — so the press sends the user to the
      // blocking section instead of charging them for a run the server would refuse.
      // The editor's own refusal rides along, captured at press time; running it is
      // one commit away (see `refuseDraftRun`), so the focus restore that comes with
      // closing cannot steal the reveal.
      onRefuse(blocked, handoff.refuseInvalid);
      return;
    }
    onRun(draft);
  }, [handoff, onClose, onRun, onRefuse]);

  /**
   * "Save and run" — write through the editor's save path, then run what was written.
   * The gate is the SAME verdict "Run this draft" reads — `blockedRef` is the editor's
   * `blockedAt`, and `refuseInvalid` is the editor's own — so this answer inherits the
   * save path's refusal by construction rather than carrying a second one that could
   * disagree. A refused press takes the same two-phase path as "Run this draft": close
   * first, refuse after the trap's focus restore, so the reveal keeps focus (H2).
   */
  const saveAndRun = useCallback(async () => {
    const blocked = handoff.blockedRef.current;
    onClose();
    if (blocked !== null) {
      onRefuse(blocked, handoff.refuseInvalid);
      return;
    }
    // A failed write answers null: the editor has already spoken the refusal, so
    // there is nothing for the header to add and nothing to run.
    const saved = await handoff.saveAndRun();
    if (saved === null) return;
    onRun(saved);
  }, [handoff, onClose, onRefuse, onRun]);

  // W10.5 — one dialog anatomy. DialogShell carries the scrim, the focus trap,
  // Escape and the backdrop click, and restores focus on close; Escape answers
  // "Cancel" (DESIGN §7) by construction, not by a second hand-rolled listener.
  return (
    <DialogShell open onClose={onClose} ariaLabel={generateDraftTitle} className="max-w-md">
      <DialogHead title={generateDraftTitle} />
      <DialogBody>
        <div className="flex flex-col gap-2 p-4">
          <button
            type="button"
            onClick={runThisDraft}
            className="flex w-full flex-col items-start rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-surface-2"
          >
            <span className="text-[13px] font-medium text-text-primary">{generateDraftRunThis}</span>
            <span className="text-[11px] text-text-muted">{generateDraftRunThisHint}</span>
          </button>
          <button
            type="button"
            onClick={() => void saveAndRun()}
            className="flex w-full flex-col items-start rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-surface-2"
          >
            <span className="text-[13px] font-medium text-text-primary">{generateDraftSaveRun}</span>
            <span className="text-[11px] text-text-muted">{generateDraftSaveRunHint}</span>
          </button>
        </div>
      </DialogBody>
      <DialogFoot className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-border-control px-4 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text-emphasis"
        >
          {confirmCancel}
        </button>
      </DialogFoot>
    </DialogShell>
  );
}

/** Top application bar: brand, centered tab nav (desktop), model selector, mobile menu. */
export function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // The header's one status line: what a verb it owns answered when it was pressed.
  const [notice, setNotice] = useState<string | null>(null);
  // D35: the three-way question, open only while the editor has a differing draft.
  const [draftConfirmOpen, setDraftConfirmOpen] = useState(false);
  // A refused "Run this draft" (GB-D3): the section the editor named, plus the
  // editor's refusal itself captured at press time. Spent one commit later — see
  // the effect below for why the refusal cannot run inside the press.
  const [pendingRefusal, setPendingRefusal] = useState<{ blocked: SectionId; refuse: () => boolean } | null>(null);
  const { guardedPush, guardedAction, isDirty, draftRun } = useGuardedNavigation();
  const router = useRouter();
  const { briefApplied, execute, telemetryOpen, toggleTelemetry } = useRun();
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

  // D3 / DESIGN.md §5: Generate is never disabled, so with nothing committed it answers
  // out loud instead of sitting dead — the status line says what is missing, and the
  // route is the reveal: the editor, where a brief can be written, does not exist
  // anywhere else. `refuseInvalid`'s third act (BriefEditor.tsx — attempted, reveal,
  // scroll) belongs to the section that is mounted, and the header cannot scroll a
  // section it does not render, so it routes to the view that can.
  // Applying a brief answers the refusal, so the refusal must stop standing. Scoped to
  // that one string: a model-change notice is about something else and should survive.
  useEffect(() => {
    if (briefApplied) setNotice((current) => (current === generateNoBrief ? null : current));
  }, [briefApplied]);

  // The editor unmounting (or saving, or reverting) takes its handoff with it — the
  // question must never outlive the draft it asks about.
  useEffect(() => {
    if (draftRun === null) setDraftConfirmOpen(false);
  }, [draftRun]);

  // The refused press, spent one commit after it landed. The dialog's focus trap
  // restores focus when it unmounts, so a refusal run inside the press would have
  // its reveal (the section focus, H2) immediately stolen by that restore. Closing
  // first and refusing here — after the trap's cleanup has run — lands focus on the
  // revealed section, exactly where Save's refusal leaves it.
  useEffect(() => {
    if (pendingRefusal === null) return;
    setPendingRefusal(null);
    pendingRefusal.refuse();
    setNotice(generateDraftBlocked(SECTION_TITLES[pendingRefusal.blocked]));
  }, [pendingRefusal]);

  // GB-D3 — the refusal names the blocking section and defers the editor's reveal
  // (attempted → reveal → focus) to the effect above. The refusal itself arrives from
  // the dialog — the handoff prop it renders from — so it is the editor's own, captured
  // at press time.
  const refuseDraftRun = useCallback(
    (blocked: SectionId, refuse: () => boolean) => {
      setPendingRefusal({ blocked, refuse });
    },
    [],
  );

  const handleGenerate = useCallback(() => {
    // D35: while the editor is mounted and its on-screen draft differs from the shell
    // brief, Generate asks which brief to run. The three-way REPLACES the guard's
    // prompt for the whole gesture — one question, never the guard's and the
    // confirm's — so its answers navigate without a second prompt.
    if (draftRun !== null) {
      setDraftConfirmOpen(true);
      return;
    }
    if (!briefApplied) {
      setNotice(generateNoBrief);
      if (!pathname.startsWith("/brief")) guardedPush("/brief");
      return;
    }
    // Hand the guard the *whole* gesture, not just the route change. `guardedPush`
    // defers only its push, so on a dirty draft the user would answer "Leave", land on
    // the grid, and find nothing running — the verb they pressed silently dropped.
    // Leave is consent to Generate; Stay still cancels both, because a refused action
    // never fires at all.
    guardedAction(() => {
      router.push(HOME);
      setNotice(null);
      void execute();
    });
  }, [draftRun, briefApplied, guardedPush, guardedAction, router, pathname, execute]);

  // The shared tail of both three-way answers: the run is the whole gesture's
  // consent, so it navigates and speaks once, at home.
  const runBrief = useCallback(
    (brief: CampaignBrief) => {
      router.push(HOME);
      setNotice(null);
      void execute(brief);
    },
    [router, execute],
  );

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
          <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-primary text-xs font-bold text-white">
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
        <Button type="button" size="sm" onClick={handleGenerate}>
          {generate}
        </Button>
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

      {/* D35 — the three-way question. Open only while the editor publishes a differing
          draft; Escape and the backdrop both answer "Cancel" (nothing happens) — the
          shared DialogShell's trap guarantees both, and restores focus on close. The
          two run answers are the whole gesture's consent, so neither asks again. The
          dialog renders only from the non-null handoff, so its answers close over a
          draft that exists — there is no "the dialog outlived its handoff" case to
          guard. */}
      {draftConfirmOpen && draftRun !== null && (
        <DraftRunDialog
          handoff={draftRun}
          onClose={() => setDraftConfirmOpen(false)}
          onRun={runBrief}
          onRefuse={refuseDraftRun}
        />
      )}

      <MobileMenu open={menuOpen} onClose={closeMenu} tabs={TABS} />
    </header>
  );
}
