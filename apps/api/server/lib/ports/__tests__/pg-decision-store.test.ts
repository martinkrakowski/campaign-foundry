import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { DecisionConflictError, type DecisionRecord } from "../decision-store.port.js";
import { FsDecisionStore } from "../fs-decision-store.js";
import { PgDecisionStore } from "../pg-decision-store.js";

const rec = (verdict: "approved" | "rejected", run = "run-1"): DecisionRecord => ({
  verdict,
  actor: "local",
  at: "2026-09-24T12:34:56.789Z",
  run,
});

describe("PgDecisionStore (PT-3, D173)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("a campaign with no decisions reads as none, at a null revision", async () => {
    const store = new PgDecisionStore(db, "local");
    await expect(store.readDecisions("camp")).resolves.toEqual({ decisions: {}, revision: null });
  });

  test("decisions round-trip, and a read answers the revision the write did", async () => {
    const store = new PgDecisionStore(db, "local");
    const revision = await store.writeDecisions("camp", {
      "alpha/1:1/default": rec("approved"),
      "beta/v2": rec("rejected", "run-2"),
    });
    const read = await store.readDecisions("camp");
    expect({ ...read.decisions }).toEqual({
      "alpha/1:1/default": rec("approved"),
      "beta/v2": rec("rejected", "run-2"),
    });
    expect(read.revision).toBe(revision);
  });

  test("the same decisions have the same revision as in the file store, so an import keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-pg-decisions-"));
    try {
      const map = { "beta/v2": rec("rejected"), "alpha/1:1/default": rec("approved") };
      const onFiles = await new FsDecisionStore(dir).writeDecisions("camp", map);
      expect(await new PgDecisionStore(db, "local").writeDecisions("camp", map)).toBe(onFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write replaces the campaign's decisions: a key left out is gone, and none still has a revision", async () => {
    const store = new PgDecisionStore(db, "local");
    await store.writeDecisions("camp", { a: rec("approved"), b: rec("rejected") });
    await store.writeDecisions("camp", { b: rec("rejected") });
    expect(Object.keys((await store.readDecisions("camp")).decisions)).toEqual(["b"]);
    const emptied = await store.writeDecisions("camp", {});
    expect(await store.readDecisions("camp")).toEqual({ decisions: {}, revision: emptied });
    expect(emptied).not.toBeNull();
  });

  test("a `__proto__` key is a key, and nothing is inherited", async () => {
    const store = new PgDecisionStore(db, "local");
    const map = JSON.parse(`{"__proto__": ${JSON.stringify(rec("approved"))}}`) as Record<
      string,
      DecisionRecord
    >;
    await store.writeDecisions("camp", map);
    const { decisions } = await store.readDecisions("camp");
    expect(Object.keys(decisions)).toEqual(["__proto__"]);
    expect((decisions as Record<string, unknown>).toString).toBeUndefined();
  });

  test("another org's decisions are invisible, and its own are separate", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    const local = new PgDecisionStore(db, "local");
    const acme = new PgDecisionStore(db, "acme");
    await local.writeDecisions("camp", { a: rec("approved") });
    await expect(acme.readDecisions("camp")).resolves.toEqual({ decisions: {}, revision: null });
    await acme.writeDecisions("camp", { b: rec("rejected") });
    expect(Object.keys((await local.readDecisions("camp")).decisions)).toEqual(["a"]);
  });

  test("an unsafe campaign id reads as none and cannot be written", async () => {
    const store = new PgDecisionStore(db, "local");
    await expect(store.readDecisions("../evil")).resolves.toEqual({
      decisions: {},
      revision: null,
    });
    await expect(store.writeDecisions("../evil", {})).rejects.toThrow(/is not a safe id/);
  });

  test("a write that fails changes nothing: the campaign keeps its decisions and revision", async () => {
    const store = new PgDecisionStore(db, "local");
    const revision = await store.writeDecisions("camp", { a: rec("approved") });
    const bad = { b: { ...rec("approved"), verdict: "maybe" } } as unknown as Record<
      string,
      DecisionRecord
    >;
    await expect(store.writeDecisions("camp", bad)).rejects.toThrow();
    const read = await store.readDecisions("camp");
    expect(Object.keys(read.decisions)).toEqual(["a"]);
    expect(read.revision).toBe(revision);
  });

  test("a map reads back in the order it was written, so rewriting it keeps its revision", async () => {
    const store = new PgDecisionStore(db, "local");
    const revision = await store.writeDecisions("camp", {
      zeta: rec("approved"),
      alpha: rec("rejected"),
      mid: rec("approved"),
    });
    const read = await store.readDecisions("camp");
    expect(Object.keys(read.decisions)).toEqual(["zeta", "alpha", "mid"]);
    expect(await store.writeDecisions("camp", read.decisions)).toBe(revision);
  });

  test("a time is kept exactly, and one not in toISOString's form is refused", async () => {
    const store = new PgDecisionStore(db, "local");
    await store.writeDecisions("camp", {
      a: { ...rec("approved"), at: "2026-01-02T03:04:05.000Z" },
    });
    expect((await store.readDecisions("camp")).decisions.a!.at).toBe("2026-01-02T03:04:05.000Z");
    for (const at of ["2026-01-02T03:04:05Z", "2026-01-02T04:04:05.000+01:00", "yesterday"]) {
      await expect(store.writeDecisions("camp", { a: { ...rec("approved"), at } })).rejects.toThrow(
        /not an ISO-8601 UTC instant/,
      );
    }
  });

  test("a write naming the revision it read lands; a stale or wrongly-absent one is a conflict carrying the current revision", async () => {
    const store = new PgDecisionStore(db, "local");
    const first = await store.writeDecisions("camp", { a: rec("approved") }, null);
    const second = await store.writeDecisions("camp", { b: rec("rejected") }, first);
    const stale = store.writeDecisions("camp", { c: rec("approved") }, first);
    await expect(stale).rejects.toBeInstanceOf(DecisionConflictError);
    await expect(stale).rejects.toMatchObject({ code: "ECONFLICT", revision: second });
    await expect(store.writeDecisions("camp", { c: rec("approved") }, null)).rejects.toMatchObject({
      revision: second,
    });
    await expect(
      store.writeDecisions("fresh", { c: rec("approved") }, "no-such-revision"),
    ).rejects.toMatchObject({ revision: null });
    // Nothing a refused write carried landed.
    expect(await store.readDecisions("camp")).toMatchObject({ revision: second });
    expect(Object.keys((await store.readDecisions("camp")).decisions)).toEqual(["b"]);
    expect((await store.readDecisions("fresh")).revision).toBeNull();
  });

  test("an org with no row cannot hold decisions", async () => {
    await expect(
      new PgDecisionStore(db, "ghost").writeDecisions("camp", { a: rec("approved") }),
    ).rejects.toThrow();
  });
});
