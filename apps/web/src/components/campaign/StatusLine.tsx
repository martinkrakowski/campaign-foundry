"use client";

import { useMemo } from "react";
import type { EditorState } from "./editor-state";
import { getTotalErrorCount, validateState } from "./validate";
import * as messages from "./messages";
import { isDirtySinceApply } from "./editor-state";

// The label a user reads is not always the section's id: the policy panel is titled
// "Variety" in the bar but its element is data-section="policy".
const SECTION_TARGETS: Record<string, string> = { Variety: "policy" };

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

  // The sentence is a shape, not a string: the section names inside it ARE the scroll
  // links (D3). Rendering the joined names as text and then appending buttons with the
  // same names says every name twice, to the eye and to a screen reader.
  const sentence = useMemo((): { lead: string; sections: string[]; tail: string } => {
    const plain = (text: string) => ({ lead: text, sections: [], tail: "" });
    // A failed write is the most recent thing that happened — it outranks the rest.
    if (persistError) return plain(persistError);
    // Applied, but this host cannot run it: D7's "persistable but not runnable",
    // said as information rather than blame (Appendix A `status.applyRefusal`).
    if (applyRefusal) return plain(messages.statusApplyRefusal);
    if (totalErrors > 0 && attempted) {
      return { ...messages.statusNotApplied(totalErrors), sections: incompleteSections };
    }
    if (applied) return plain(messages.statusApplied(state.briefId));
    if (isLoaded) return plain(messages.statusLoaded(state.briefId));
    if (incompleteSections.length === 0) return plain(messages.statusReady);
    return {
      ...(incompleteSections.length === 1 ? messages.statusAlmostThere() : messages.statusNewBrief()),
      sections: incompleteSections,
    };
  }, [totalErrors, attempted, applied, isLoaded, state.briefId, incompleteSections, applyRefusal, persistError]);

  return (
    <p role="status" className="text-[13px] text-text-primary">
      {sentence.lead}
      {sentence.sections.map((section, i) => (
        <span key={section}>
          {i === 0 ? " " : ", "}
          <button
            type="button"
            className="text-brand-primary hover:underline"
            onClick={() => onScrollToSection(SECTION_TARGETS[section] ?? section.toLowerCase())}
          >
            {section}
          </button>
        </span>
      ))}
      {sentence.tail}
    </p>
  );
}
