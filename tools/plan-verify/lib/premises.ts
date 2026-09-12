import type { Premise } from "./types.js";

/**
 * Reads the ```premise <lane>``` blocks out of a planning document.
 *
 * A premise is a POSIX `sh` script that exits 0 while the gap its lane
 * describes is still open. Three lanes were dispatched in one day against gaps
 * that had already been closed — the plans had drifted from the code and
 * nothing could tell. A premise makes the claim falsifiable, and
 * `plan:verify` falsifies it.
 *
 * Fences are matched at the start of a line so that a fence quoted inside a
 * larger example block cannot be mistaken for a real one.
 *
 * A premise whose script trims to empty is an error, not something to skip:
 * blanking a block would otherwise remove the lane from the check entirely,
 * turning "silence the drift detector" into a valid edit.
 */
const FENCE = /^```premise[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export function parsePremises(plan: string, markdown: string): readonly Premise[] {
  const found: Premise[] = [];
  // `matchAll` needs a fresh lastIndex: FENCE is module-scoped and global.
  FENCE.lastIndex = 0;
  for (const match of markdown.matchAll(FENCE)) {
    const lane = match[1];
    const script = match[2].trim();
    if (script === "") {
      throw new Error(
        `EMPTY  ${lane}  (${plan})\n` +
          `  a premise fence with no script hides the lane instead of failing it.\n` +
          `  Restore the claim, or delete the whole fence and retire the lane.`,
      );
    }
    found.push({ plan, lane, script });
  }
  return found;
}
