"use client";

import { useMemo, type ReactNode } from "react";
import { IconButton, LogPanel, type LogPanelEntry } from "@/components/ui";
import {
  ErrorStrip,
  MOTION_ERROR_KEY,
  MOTION_HOST_SECTION,
  MOTION_LABEL,
  SECTION_BY_ERROR_KEY,
} from "./ErrorStrip";
import { SECTION_TITLES, sectionOrder, type SectionId } from "./sections";
import { getTotalErrorCount, type FieldErrors } from "./validate";
import * as messages from "./messages";

export interface ValidationViewProps {
  /**
   * `validateState(state)`'s buckets, **ungated** — the full `errors`, never the
   * touch-gated `visibleErrors`. The owner asked for *"all errors … including the
   * ones that were inlined"*, and `visibleErrors` is by construction a subset: it
   * hides the errors of fields the operator has not been to yet (L1.1). Handing
   * this view the gated set would make an untouched invalid draft read as clean
   * here while the toolbar refused to validate it — the two surfaces disagreeing
   * about the same document, which is the defect the collected list exists to end.
   */
  readonly errors: Record<string, FieldErrors>;
  /** Orders the rows the way the operator walks the brief (M1). */
  readonly mode: "brief" | "variation";
  /** `isValidationFresh(validatedState, state)` — the GATE, not the finding. */
  readonly validated: boolean;
  /** The editor's own `reveal`: flips back to the form and scrolls the section. */
  readonly onRevealSection: (section: string) => void;
  /** SG-D14's refresh, which is the `Validate` action itself. See the note below. */
  readonly onRevalidate: () => void;
}

/**
 * One bucket's label, spelled by the one `SECTION_TITLES` vocabulary with motion
 * by its own — exactly as `ErrorStrip` spells its chips, and never a `||`
 * fallback. An undeclared bucket cannot occur (the W6.7 totality test pins the
 * map both ways), so it is dropped rather than rendered as a raw key.
 */
function labelForBucket(bucket: string): string | undefined {
  if (bucket === MOTION_ERROR_KEY) return MOTION_LABEL;
  return SECTION_TITLES[SECTION_BY_ERROR_KEY[bucket as SectionId]];
}

/**
 * The rows, in the order the operator walks the brief.
 *
 * `validateState`'s key order puts `policy` before `output`, and M1 already paid
 * for trusting it once: the refusal used to bounce to Variation Policy on a draft
 * whose first *walked* failure was Output. A list read top to bottom has the same
 * problem in slower motion, so the buckets are sorted by `sectionOrder` with motion
 * at its host's position — the same mapping `reveal` and `blockedAt` use.
 *
 * **No `meta` and no `level` beyond `error`** — SG-D21/D26. A `LogPanelEntry`'s
 * `meta` is the drawer's formatted clock and its `label` the run's stage; a
 * validation error has neither, because no run produced it. Filling those columns
 * with an invented time or stage would make the panel's Copy control emit a log
 * claiming a run that never happened, which is the fabrication D26 forbids and
 * which `log-panel.test.tsx`'s "validation-shaped rows render, with no invented
 * time or stage" pins from the other side.
 */
function toEntries(
  errors: Record<string, FieldErrors>,
  mode: "brief" | "variation",
): LogPanelEntry[] {
  const walk = sectionOrder(mode);
  const walkIndex = (bucket: string): number =>
    walk.indexOf((bucket === MOTION_ERROR_KEY ? MOTION_HOST_SECTION : bucket) as SectionId);
  return Object.entries(errors)
    .filter(([, fields]) => Object.keys(fields).length > 0)
    .filter(([bucket]) => labelForBucket(bucket) !== undefined)
    .sort(([a], [b]) => walkIndex(a) - walkIndex(b))
    .flatMap(([bucket, fields]) =>
      Object.entries(fields).map(([, message]) => ({
        label: labelForBucket(bucket) as string,
        message,
        level: "error" as const,
      })),
    );
}

/**
 * SG10 — the validation view: every error the document has, collected in one
 * place, wearing LP1's log-panel chrome (SG-D21).
 *
 * **It is a projection of `errors`, not a stored result, and that is the whole
 * design.** `validateState` is a pure synchronous function of editor state and
 * there is no server validate endpoint, so there is nothing to recompute and
 * nothing to wait for: rendering the live value is both simpler and *more*
 * correct than snapshotting one. An operator who jumps to a section from a chip
 * here, fixes the field and comes back must see the fixed error gone; a stored
 * result would still be showing it, and the refresh button would exist only to
 * repair the staleness this component chose to create.
 *
 * **What the refresh control actually refreshes is the GATE, not the list.**
 * SG-D14 asks for a refresh icon and it is wired to `handleValidate` — the same
 * handler the toolbar's `Validate` verb uses, the only writer of `validatedState`
 * (SG-D12/SG-D15, §8.4). Pressing it is what makes `Generate` appear. Two
 * consequences worth stating rather than discovering:
 *
 * - **Arriving here validates nothing.** This component has no effect, no mount
 *   hook and no call to `onRevalidate` it did not receive from a press. If merely
 *   navigating to the segment took the snapshot, the consent the gate records
 *   would fire on a tab click and `Generate` would stand on a document the
 *   operator never approved — which spends their GenAI credits.
 * - **Pressing refresh on an INVALID document leaves this view.** `handleValidate`
 *   calls `refuseInvalid`, whose refusal reveals the first blocking section and
 *   hands it focus (H2), and `reveal` flips the column back to the form. That is
 *   SG9's committed refusal landing, and the alternative — a second, quieter
 *   refusal path for this one caller — is what `handleValidate`'s own docstring
 *   refuses. So the press answers by taking the operator to the problem.
 *
 * **The rows are not themselves controls, and that is a property of LP1's type,
 * not a choice.** `LogPanelEntry.message` is a `string` rendered into a bare
 * `<span>`; there is no slot for a handler and no `ReactNode` to put a button in.
 * The panel is out of this lane's scope (consume, do not edit), so the reveal
 * affordance is the one the editor already has — `ErrorStrip`'s per-section chips
 * (F6's `JumpStrip`), wired to the same `reveal` the action bar's strip uses.
 * That gives every erroring section a one-click target without a second
 * navigation concept; per-ROW targeting would need `LogPanelEntry` to change.
 */
export function ValidationView({
  errors,
  mode,
  validated,
  onRevealSection,
  onRevalidate,
}: ValidationViewProps): ReactNode {
  const entries = useMemo(() => toEntries(errors, mode), [errors, mode]);
  // `getTotalErrorCount`, never a second count: the toolbar's gate, the status
  // sentence and this view must agree about how many problems the document has,
  // and they agree by reading the one function rather than by each summing the
  // same object its own way (`validate.ts:542`).
  const total = getTotalErrorCount(errors);

  return (
    <div data-testid="column-validate" className="flex flex-col gap-4">
      <LogPanel
        title={messages.validationViewTitle}
        entries={entries}
        // Red fault 5: clean is not the same fact as unvalidated, and this repo
        // has collapsed the two before. The view is live, so the FINDING is the
        // same sentence in both; what differs is what the gate knows.
        emptyMessage={
          validated ? messages.validationCleanValidated : messages.validationCleanUnvalidated
        }
        copyLabel={messages.validationCopy}
        // A height, because a panel that collapses to its header when the document
        // is clean reads as a control that failed to load rather than as a report
        // that found nothing. Not the drawer's `absolute bottom-24 left-1/2` —
        // position belongs to the instance (LP1), and this instance is a column
        // view that sits where `editor` and `yaml` sit.
        className="min-h-64"
        actions={
          <IconButton label={messages.validationRefresh} onClick={onRevalidate}>
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h5M20 20v-5h-5M19.4 9A7.6 7.6 0 0 0 6.3 6.3L4 9m16 6-2.3 2.7A7.6 7.6 0 0 1 4.6 15"
              />
            </svg>
          </IconButton>
        }
      />
      {total > 0 ? (
        <div role="group" aria-label={messages.validationJumps}>
          <ErrorStrip errors={errors} onErrorClick={onRevealSection} />
        </div>
      ) : null}
    </div>
  );
}
