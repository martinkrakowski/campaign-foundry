"use client";

import { useMemo } from "react";
import type { EditorState } from "./editor-state";
import { getTotalErrorCount, validateState } from "./validate";
import * as messages from "./messages";
import { isDirtySinceApply } from "./editor-state";

function getIncompleteSections(state: EditorState): string[] {
  const errors = validateState(state);
  const sections: string[] = [];
  if (getTotalErrorCount({ identity: errors.identity }) > 0) sections.push("Identity");
  if (getTotalErrorCount({ copy: errors.copy }) > 0) sections.push("Copy");
  if (getTotalErrorCount({ products: errors.products }) > 0) sections.push("Products");
  if (getTotalErrorCount({ output: errors.output, motion: errors.motion }) > 0) sections.push("Output");
  if (state.mode === "variation" && getTotalErrorCount({ policy: errors.policy }) > 0) sections.push("Variety");
  return sections;
}

export function StatusLine({
  state,
  attempted,
  applyRefusal,
  persistError,
  onScrollToSection,
}: {
  state: EditorState;
  attempted: boolean;
  applyRefusal?: string;
  persistError?: string;
  onScrollToSection: (section: string) => void;
}) {
  const totalErrors = getTotalErrorCount(validateState(state));
  const incompleteSections = getIncompleteSections(state);
  const applied = state.appliedSnapshot !== null && !isDirtySinceApply(state);
  const isLoaded = state.source.kind === "file";

  const sentence = useMemo(() => {
    // A failed write is the most recent thing that happened — it outranks the rest.
    if (persistError) return persistError;
    // Applied, but this host cannot run it: D7's "persistable but not runnable",
    // said as information rather than blame (Appendix A `status.applyRefusal`).
    if (applyRefusal) return messages.statusApplyRefusal;
    if (totalErrors > 0 && attempted) {
      const { lead, tail } = messages.statusNotApplied(totalErrors);
      return `${lead} ${incompleteSections.join(", ")}${tail}`;
    }
    if (applied) {
      return messages.statusApplied(state.briefId);
    }
    if (isLoaded) {
      return `Loaded ${state.briefId} — Apply to run to stage it.`;
    }
    if (incompleteSections.length === 0) {
      return "Ready — Apply to run, or Save & apply to keep it.";
    }
    const { lead, tail } =
      incompleteSections.length === 1 ? messages.statusAlmostThere() : messages.statusNewBrief();
    return `${lead} ${incompleteSections.join(", ")}${tail}`;
  }, [totalErrors, attempted, applied, isLoaded, state.briefId, incompleteSections, applyRefusal, persistError]);

  return (
    <p role="status" className="text-[13px] text-text-primary">
      {sentence}
      {(totalErrors > 0 && !persistError && !applyRefusal ? incompleteSections : []).map((section) => (
        <button
          key={section}
          type="button"
          className="ml-1 text-brand-primary hover:underline"
          onClick={() => onScrollToSection(section.toLowerCase())}
        >
          {section}
        </button>
      ))}
    </p>
  );
}
