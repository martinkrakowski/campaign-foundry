"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { SECTION_TITLES, sectionOrder } from "@/components/campaign/sections";
import type { CampaignMode } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { ErrorPill } from "./error-pill";
import * as messages from "@/components/campaign/messages";

/**
 * The brief's sections as an outline in the sidebar (D25): one numbered row per
 * section from `sectionOrder(mode)` — the one ordered list of sections (GB-D18) —
 * the current row carrying a brand rail, an `ErrorPill` per row fed from the
 * editor's visible errors, and a no-issues / N-things-to-fix aside. It sits below
 * the mode panels, because mode stays the first decision a brief makes (GB-D4),
 * and it is published through EditorPanelsProvider so the mobile menu shares it.
 *
 * In Everything mode the current row is a scroll-spy. W6 will steer it from the
 * guided step index too, and the row's activation becomes `revealSection` — that
 * works because the editor owns `onActivate` as the one place an outline navigates.
 */
export function SectionOutline({
  mode,
  visibleErrors,
  onActivate,
}: {
  mode: CampaignMode;
  visibleErrors: Record<string, FieldErrors>;
  onActivate?: (section: string) => void;
}) {
  const order = sectionOrder(mode);
  const [current, setCurrent] = useState<string>(order[0]);

  // Everything-mode scroll-spy: the current row is the section whose top has just
  // crossed the top of the reading column. Sections live in the shell's main
  // container, whose scroll events do not bubble to `window` but do travel the
  // capture phase — so a capturing listener catches every inner scroller.
  useEffect(() => {
    const SCROLL_THRESHOLD = 24;
    const compute = () => {
      const ids = sectionOrder(mode);
      let found = ids[0];
      for (const id of ids) {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(`#${id}, [data-section="${id}"]`),
        );
        const el = candidates.find((c) => c.getClientRects().length > 0);
        // `height` guards the test DOM: happy-dom lays nothing out, so every rect is
        // a zeroed box and would otherwise make the *last* section current on mount.
        if (!el || el.getBoundingClientRect().height <= 0) continue;
        if (el.getBoundingClientRect().top <= SCROLL_THRESHOLD) found = id;
      }
      setCurrent((prev) => (prev === found ? prev : found));
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [mode]);

  const total = order.reduce((sum, id) => sum + Object.keys(visibleErrors[id] ?? {}).length, 0);

  return (
    <div className="space-y-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          {messages.outlineLegend}
        </span>
        <span className="text-[11px] text-text-muted">{messages.outlineIssueCount(total)}</span>
      </div>
      {order.map((id, index) => {
        const title = SECTION_TITLES[id];
        const numeral = String(index + 1).padStart(2, "0");
        const count = Object.keys(visibleErrors[id] ?? {}).length;
        const isCurrent = current === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={title}
            aria-current={isCurrent ? "location" : undefined}
            onClick={() => onActivate?.(id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border-l-2 px-2 py-1.5 text-left transition-colors",
              isCurrent ? "border-brand-primary bg-surface-2" : "border-transparent hover:bg-surface-2",
            )}
          >
            <span
              className={cn("font-mono text-[11px]", isCurrent ? "text-brand-primary" : "text-text-muted")}
            >
              {numeral}
            </span>
            <span className={cn("text-[13px]", isCurrent ? "text-text-emphasis" : "text-text-primary")}>
              {title}
            </span>
            {count > 0 ? (
              <span className="ml-auto">
                <ErrorPill count={count} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
