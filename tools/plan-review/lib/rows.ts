import { createHash } from "node:crypto";

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
