import { createHash } from "node:crypto";

/** The reserved lane token a plan review is emitted under — never a real lane's name. */
export const PLAN_REVIEW_LANE = "_plan";

/**
 * The leading cell of a plan's lane-table row, exactly as plans write it:
 * `| **<id>** | …`. The rest of the line is never parsed into cells, so a row
 * whose text carries a `|` inside backticks matches and hashes whole.
 */
function rowPrefix(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|`);
}

/**
 * The sha256 hex of one plan-table row, normalised: trimmed, with every run of
 * whitespace collapsed to one space, so a whitespace-only reflow of a row keeps
 * its hash and a one-word change breaks it. The id names the row by its first
 * cell — a lane id (`| **PT-5a** | …`) or a decision id (`| **D177** | …`) —
 * and the row must be unambiguous: zero matches or more than one is an error
 * naming the id and the count, never a hash of the wrong line.
 */
export function rowHash(markdown: string, id: string): string {
  const prefix = rowPrefix(id);
  const matches = markdown.split("\n").filter((line) => prefix.test(line));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one plan row for ${id}, found ${matches.length}`);
  }
  const normalised = matches[0].trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/** A plan row's risk tier (D184): `high`, or `normal` for everything else. */
export type Risk = "high" | "normal";

/**
 * `rowPrefix`'s own prefix, continued by everything up to the next `|` (or
 * end of line, for a row with no further cells), captured as group 1 — the
 * row's second cell. The capture is unconditional (`[^|]*` matches even zero
 * characters), so a line this pattern's prefix matches always matches the
 * whole pattern too: there is no "matched the prefix, then failed to
 * re-match" state, which is why `rowRisk` never needs a second, separate
 * `exec` the way an `exec`-after-`test` pair would.
 */
function rowSecondCellPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|([^|]*)`);
}

/**
 * A row's risk tier, read from its SECOND cell: `**high**` marks it high;
 * anything else — the literal word `normal`, or a table with no Risk column
 * at all, whose second cell holds the "Delivers" prose instead, as in the
 * platform plan — reads as `normal`. The match is exact: the plan's own
 * convention bolds every tier word the same way it bolds every lane id
 * (`| **<id>** | **high** | …`), so an unbolded `high` is not the marker
 * either, and defaults to `normal` rather than being guessed at.
 */
export function rowRisk(markdown: string, id: string): Risk {
  const pattern = rowSecondCellPattern(id);
  const matches: RegExpExecArray[] = [];
  for (const line of markdown.split("\n")) {
    const match = pattern.exec(line);
    if (match !== null) matches.push(match);
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one plan row for ${id}, found ${matches.length}`);
  }
  // Non-null: the capture group above is unconditional, so a match here
  // always carries one — see rowSecondCellPattern's own comment.
  const secondCell = matches[0][1]!.trim();
  return secondCell === "**high**" ? "high" : "normal";
}

/** The hash map a plan-review event's detail carries, or `undefined` for anything else. */
export function asHashRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    record[key] = item;
  }
  return record;
}
