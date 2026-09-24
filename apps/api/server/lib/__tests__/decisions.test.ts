import { describe, test, expect } from "vitest";
import { MAX_DECISIONS, applyVerdicts, verdictsProblem } from "../decisions.js";

describe("applyVerdicts (D173)", () => {
  const previous = {
    kept: { verdict: "approved" as const, actor: "alice", at: "2026-09-01T00:00:00.000Z" },
    flipped: { verdict: "approved" as const, actor: "alice", at: "2026-09-01T00:00:00.000Z" },
    dropped: { verdict: "rejected" as const, actor: "alice", at: "2026-09-01T00:00:00.000Z" },
  };

  test("an unchanged verdict keeps who and when; a changed or new one is stamped; an absent key drops out", () => {
    const next = applyVerdicts(
      previous,
      { kept: "approved", flipped: "rejected", fresh: "approved" },
      "bob",
      "2026-09-24T12:00:00.000Z",
    );
    expect(next).toEqual({
      kept: previous.kept,
      flipped: { verdict: "rejected", actor: "bob", at: "2026-09-24T12:00:00.000Z" },
      fresh: { verdict: "approved", actor: "bob", at: "2026-09-24T12:00:00.000Z" },
    });
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
