import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionConflictError, type DecisionStorePort } from "../ports/decision-store.port.js";
import {
  RETIRE_ATTEMPTS,
  MAX_DECISIONS,
  applyVerdicts,
  retireDecisions,
  verdictsProblem,
  withDecisionLock,
  type DecisionRecord,
} from "../decisions.js";
import { getDecisionStore, getJobStore, resetDecisionStore } from "../ports/index.js";
import { JobLeaseLostError } from "../ports/job-store.port.js";
import { LOCAL_TENANT } from "../tenant.js";


const at1 = "2026-09-01T00:00:00.000Z";
const rec = (verdict: "approved" | "rejected"): DecisionRecord => ({
  verdict,
  actor: "alice",
  at: at1,
  run: "run-1",
});

describe("applyVerdicts (D173)", () => {
  const previous = { kept: rec("approved"), flipped: rec("approved"), dropped: rec("rejected") };

  test("an unchanged verdict keeps who, when and run; a changed or new one is stamped; an absent key drops out", () => {
    const next = applyVerdicts(
      previous,
      { kept: "approved", flipped: "rejected", fresh: "approved" },
      "bob",
      "2026-09-24T12:00:00.000Z",
      "run-2",
    );
    const stamped = { actor: "bob", at: "2026-09-24T12:00:00.000Z", run: "run-2" };
    expect({ ...next }).toEqual({
      kept: previous.kept,
      flipped: { verdict: "rejected", ...stamped },
      fresh: { verdict: "approved", ...stamped },
    });
  });

  test("a `__proto__` or `toString` key is a review key, stored as its own entry", () => {
    const verdicts = JSON.parse('{"__proto__":"approved","toString":"rejected"}') as Record<
      string,
      "approved" | "rejected"
    >;
    const next = applyVerdicts({}, verdicts, "bob", at1, "run-1");
    expect(Object.keys(next).sort()).toEqual(["__proto__", "toString"]);
    expect(next["__proto__"]).toEqual({ verdict: "approved", actor: "bob", at: at1, run: "run-1" });
    expect(JSON.stringify(next)).toContain('"__proto__":{"verdict":"approved"');
    expect(next.toString).toEqual({ verdict: "rejected", actor: "bob", at: at1, run: "run-1" });
  });
});

describe("retireDecisions (D173)", () => {
  let root: string;
  const orig = process.env.OUTPUT_DIR;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-retire-"));
    process.env.OUTPUT_DIR = root;
    resetDecisionStore();
  });
  afterEach(() => {
    resetDecisionStore();
    if (orig === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = orig;
    rmSync(root, { recursive: true, force: true });
  });

  test("named keys go back to review and the rest keep their records; no keys retires all", async () => {
    const store = getDecisionStore(LOCAL_TENANT);
    await store.writeDecisions("camp", { a: rec("approved"), b: rec("rejected") });
    await retireDecisions(store, "camp", new Set(["a", "absent"]));
    expect({ ...(await store.readDecisions("camp")).decisions }).toEqual({ b: rec("rejected") });
    await retireDecisions(store, "camp");
    expect({ ...(await store.readDecisions("camp")).decisions }).toEqual({});
  });

  test("retiring nothing writes nothing", async () => {
    await retireDecisions(getDecisionStore(LOCAL_TENANT), "camp");
    expect((await getDecisionStore(LOCAL_TENANT).readDecisions("camp")).revision).toBeNull();
  });

  test("work under one campaign's lock runs in turn, a failure does not block the next, and campaigns do not wait on each other", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withDecisionLock(LOCAL_TENANT, "camp", async () => {
      order.push("first:start");
      await held;
      order.push("first:end");
      throw new Error("first failed");
    });
    const second = withDecisionLock(LOCAL_TENANT, "camp", async (store) => {
      order.push("second");
      return store;
    });
    const other = withDecisionLock(LOCAL_TENANT, "other", async () => {
      order.push("other");
    });
    await other;
    expect(order).toEqual(["first:start", "other"]); // "second" waits; "other" does not
    release();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(getDecisionStore(LOCAL_TENANT));
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });
});

describe("verdictsProblem", () => {
  test("accepts a map of review keys to approved or rejected", () => {
    expect(
      verdictsProblem({ "alpha/v0": "approved", "alpha/1:1/default": "rejected" }),
    ).toBeUndefined();
    expect(verdictsProblem({})).toBeUndefined();
  });

  test("refuses anything else, naming what is wrong", () => {
    expect(verdictsProblem(null)).toMatch(/must be an object/);
    expect(verdictsProblem(["a"])).toMatch(/must be an object/);
    expect(verdictsProblem("x")).toMatch(/must be an object/);
    expect(verdictsProblem({ k: "maybe" })).toMatch(/must be "approved" or "rejected"/);
    expect(verdictsProblem({ "": "approved" })).toMatch(/is not a review key/);
    expect(verdictsProblem({ ["x".repeat(201)]: "approved" })).toMatch(/is not a review key/);
    expect(verdictsProblem({ "a\nb": "approved" })).toMatch(/is not a review key/);
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_DECISIONS + 1 }, (_, i) => [`k${i}`, "approved"]),
    );
    expect(verdictsProblem(tooMany)).toMatch(/at most/);
  });
});

describe("retireDecisions against a concurrent save (PT-3)", () => {
  const stored = { a: rec("approved"), b: rec("rejected") };
  const racing = (conflicts: number) => {
    const writes: (string | null | undefined)[] = [];
    let reads = 0;
    const store: DecisionStorePort = {
      readDecisions: async () => ({ decisions: stored, revision: `rev-${(reads += 1)}` }),
      writeDecisions: async (campaignId, _decisions, expected) => {
        writes.push(expected);
        if (writes.length <= conflicts) throw new DecisionConflictError(campaignId, "moved");
        return "done";
      },
    };
    return { store, writes };
  };

  test("writes against the revision it read, and re-reads after losing to a save", async () => {
    const { store, writes } = racing(2);
    await retireDecisions(store, "camp", new Set(["a"]));
    expect(writes).toEqual(["rev-1", "rev-2", "rev-3"]);
  });

  test("gives up after RETIRE_ATTEMPTS conflicts, and any other failure at once", async () => {
    const { store, writes } = racing(RETIRE_ATTEMPTS);
    await expect(retireDecisions(store, "camp")).rejects.toBeInstanceOf(DecisionConflictError);
    expect(writes).toHaveLength(RETIRE_ATTEMPTS);
    const broken: DecisionStorePort = {
      ...store,
      writeDecisions: async () => {
        throw new Error("disk full");
      },
    };
    await expect(retireDecisions(broken, "camp")).rejects.toThrow("disk full");
  });

  test("retireDecisions is refused after failJob when fence is provided", async () => {
    const jobStore = getJobStore(LOCAL_TENANT);
    const jobId = await jobStore.createJob("camp");
    await jobStore.failJob(jobId, "deadline exceeded");

    const store = getDecisionStore(LOCAL_TENANT);
    await store.writeDecisions("camp", { a: rec("approved") });
    await expect(
      retireDecisions(store, "camp", undefined, { runId: jobId }),
    ).rejects.toBeInstanceOf(JobLeaseLostError);
  });
});

