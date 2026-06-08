import { describe, test, expect } from "vitest";
import { ok, err } from "../result.js";

describe("Result kernel", () => {
  test("ok wraps a value as a success result", () => {
    const r = ok(42);
    expect(r.success).toBe(true);
    if (r.success) expect(r.value).toBe(42);
  });

  test("err wraps an error as a failure result", () => {
    const boom = new Error("boom");
    const r = err(boom);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(boom);
  });
});
