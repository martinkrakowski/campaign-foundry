import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DECISIONS,
  applyVerdicts,
  retireDecisions,
  verdictsProblem,
  type DecisionRecord,
} from "../decisions.js";
import { getDecisionStore, resetDecisionStore } from "../ports/index.js";
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
    await retireDecisions(LOCAL_TENANT, "camp", new Set(["a", "absent"]));
    expect({ ...(await store.readDecisions("camp")).decisions }).toEqual({ b: rec("rejected") });
    await retireDecisions(LOCAL_TENANT, "camp");
    expect({ ...(await store.readDecisions("camp")).decisions }).toEqual({});
  });

  test("retiring nothing writes nothing", async () => {
    await retireDecisions(LOCAL_TENANT, "camp");
    expect((await getDecisionStore(LOCAL_TENANT).readDecisions("camp")).revision).toBeNull();
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
