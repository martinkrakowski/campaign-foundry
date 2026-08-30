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

  // Four states, four colours (UE-D11) — the tint, the text and the border all come
  // from the same token, so a theme carries the whole chip. The third used to be a
  // stock `yellow-400`; it read as a second `warning` and had no light-theme value at
  // all, so it is now `--color-modified`, a state colour of its own.
  // 🔴 draft not applied (new, never applied)
  // 🟠 applied, never saved (applied but new)
  // 🟣 applied, unsaved edits (applied and saved, but dirty)
  // 🟢 saved & applied (applied and not dirty)

  let label: string;
  let color: string;

  if (!hasApplied) {
    label = "Draft not applied";
    color = "bg-error/20 text-error border-error/50";
  } else if (isNew) {
    label = "Applied, never saved";
    color = "bg-warning/20 text-warning border-warning/50";
  } else if (dirtySave || dirtyApply) {
    label = "Applied, unsaved edits";
    color = "bg-modified/20 text-modified border-modified/50";
  } else {
    label = "Saved & applied";
    color = "bg-success/20 text-success border-success/50";
  }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${color}`}>
      <span aria-hidden="true" className="w-2 h-2 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}
