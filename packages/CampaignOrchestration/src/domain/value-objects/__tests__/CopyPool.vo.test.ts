import { describe, test, expect } from "vitest";
import {
  approvedTexts,
  mergePool,
  type CopyPool,
  type CopyPoolEntry,
} from "../CopyPool.vo.js";

const entry = (over: Partial<CopyPoolEntry> & Pick<CopyPoolEntry, "id" | "text">): CopyPoolEntry => ({
  status: "approved",
  ...over,
});

const pool = (over: Partial<CopyPool> = {}): CopyPool => ({
  briefId: "camp",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "openai/gpt-4o-mini",
  entries: [],
  ...over,
});

describe("approvedTexts", () => {
  test("returns only approved entry texts in pool order", () => {
    expect(
      approvedTexts(
        pool({
          entries: [
            entry({ id: "h1", text: "Stay wild", status: "approved" }),
            entry({ id: "h2", text: "miracle hydration", status: "rejected", reason: "prohibited" }),
            entry({ id: "h3", text: "Stay hydrated", status: "approved" }),
          ],
        }),
      ),
    ).toEqual(["Stay wild", "Stay hydrated"]);
  });

  test("returns an empty list when nothing is approved", () => {
    expect(approvedTexts(pool())).toEqual([]);
    expect(
      approvedTexts(pool({ entries: [entry({ id: "h1", text: "x", status: "rejected" })] })),
    ).toEqual([]);
  });
});

describe("mergePool", () => {
  const existing = pool({
    generatedAt: "2026-01-01T00:00:00.000Z",
    model: "old-model",
    entries: [
      entry({ id: "h1", text: "Stay wild", status: "approved" }),
      entry({ id: "h2", text: "miracle hydration", status: "rejected", reason: "prohibited" }),
    ],
  });

  test("keeps existing id/status/reason when normalised text matches", () => {
    const incoming = pool({
      generatedAt: "2026-06-01T00:00:00.000Z",
      model: "new-model",
      entries: [
        entry({ id: "n1", text: "  stay   WILD  ", status: "rejected", reason: "duplicate" }),
        entry({ id: "n2", text: "Fresh take" }),
      ],
    });
    const merged = mergePool(existing, incoming);
    expect(merged.entries).toEqual([
      existing.entries[0],
      existing.entries[1],
      entry({ id: "n2", text: "Fresh take" }),
    ]);
    expect(merged.generatedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(merged.model).toBe("new-model");
    expect(merged.briefId).toBe("camp");
  });

  test("de-duplicates incoming-only texts against each other", () => {
    const incoming = pool({
      entries: [entry({ id: "a", text: "Hello" }), entry({ id: "b", text: "hello" })],
    });
    expect(mergePool(pool(), incoming).entries).toEqual([entry({ id: "a", text: "Hello" })]);
  });

  test("keeps existing generatedAt and model when incoming has no entries", () => {
    const incoming = pool({
      generatedAt: "2026-06-01T00:00:00.000Z",
      model: "new-model",
      entries: [],
    });
    const merged = mergePool(existing, incoming);
    expect(merged.generatedAt).toBe(existing.generatedAt);
    expect(merged.model).toBe(existing.model);
    expect(merged.entries).toEqual(existing.entries);
  });
});
