"use client";

import type { EditorState } from "./editor-state";
import { isDirtySinceSave, isPristine } from "./editor-state";

interface StatusChipProps {
  state: EditorState;
}

export function StatusChip({ state }: StatusChipProps) {
  // D41: two states, not four — the chip answers "written or not", never "applied or
  // not". With every persist path committing the brief to the shell (D35), the
  // applied/saved distinction the old four states drew cannot diverge any more, so
  // the "Draft not applied" badge the distinction produced stops existing rather than
  // being hidden. This amends UE-D11 (four colour-distinct states), which governed
  // states that no longer exist.
  // A pristine editor is a blank, untouched form: there are no changes to be unsaved,
  // and "Saved" would claim a write that never happened. The chip has nothing to
  // report, so it says nothing — absence is not a third state on the written-or-not
  // axis, it is the axis declining to speak until there is a draft to describe.
  if (isPristine(state)) return null;

  const dirty = isDirtySinceSave(state);

  const label = dirty ? "Unsaved changes" : "Saved";
  const color = dirty
    ? "bg-modified/20 text-modified border-modified/50"
    : "bg-success/20 text-success border-success/50";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${color}`}>
      <span aria-hidden="true" className="w-2 h-2 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}
