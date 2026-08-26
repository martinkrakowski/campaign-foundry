"use client";

import type { EditorState } from "./editor-state";
import { isDirtySinceSave, isDirtySinceApply } from "./editor-state";

interface StatusChipProps {
  state: EditorState;
}

export function StatusChip({ state }: StatusChipProps) {
  const dirtySave = isDirtySinceSave(state);
  const dirtyApply = isDirtySinceApply(state);
  const isNew = state.source.kind === "new";
  const hasApplied = state.appliedSnapshot !== null;

  // Four states:
  // 🔴 draft not applied (new, never applied)
  // 🟠 applied, never saved (applied but new)
  // 🟡 applied, unsaved edits (applied and saved, but dirty)
  // 🟢 saved & applied (applied and not dirty)

  let label: string;
  let color: string;
  let icon: string;

  if (!hasApplied) {
    label = "Draft not applied";
    color = "bg-red-500/20 text-red-400 border-red-500/50";
    icon = "🔴";
  } else if (isNew) {
    label = "Applied, never saved";
    color = "bg-orange-500/20 text-orange-400 border-orange-500/50";
    icon = "🟠";
  } else if (dirtySave || dirtyApply) {
    label = "Applied, unsaved edits";
    color = "bg-yellow-500/20 text-yellow-400 border-yellow-500/50";
    icon = "🟡";
  } else {
    label = "Saved & applied";
    color = "bg-green-500/20 text-green-400 border-green-500/50";
    icon = "🟢";
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${color}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}
