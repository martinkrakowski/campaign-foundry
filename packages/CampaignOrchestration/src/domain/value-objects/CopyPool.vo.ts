export type CopyPoolEntryStatus = "approved" | "rejected";

export interface CopyPoolEntry {
  readonly id: string;
  readonly text: string;
  readonly status: CopyPoolEntryStatus;
  readonly reason?: string;
}

export interface CopyPool {
  readonly briefId: string;
  /** ISO timestamp supplied by the caller — the domain does not read a clock. */
  readonly generatedAt: string;
  readonly model: string;
  readonly entries: readonly CopyPoolEntry[];
}

/** Trim, collapse internal whitespace, lower-case — the merge identity. */
function normalisedText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function approvedTexts(pool: CopyPool): readonly string[] {
  return pool.entries.filter((entry) => entry.status === "approved").map((entry) => entry.text);
}

/**
 * Pure merge: de-duplicate by normalised text. Existing entries win on a match
 * (id/status/reason kept); incoming-only texts are appended. Metadata comes from
 * incoming when it has entries, otherwise from existing — no clock is invented.
 */
export function mergePool(existing: CopyPool, incoming: CopyPool): CopyPool {
  const taken = new Set(existing.entries.map((entry) => normalisedText(entry.text)));
  const extra: CopyPoolEntry[] = [];
  for (const entry of incoming.entries) {
    const key = normalisedText(entry.text);
    if (taken.has(key)) continue;
    taken.add(key);
    extra.push(entry);
  }
  const useIncomingMeta = incoming.entries.length > 0;
  return {
    briefId: existing.briefId,
    generatedAt: useIncomingMeta ? incoming.generatedAt : existing.generatedAt,
    model: useIncomingMeta ? incoming.model : existing.model,
    entries: [...existing.entries, ...extra],
  };
}
