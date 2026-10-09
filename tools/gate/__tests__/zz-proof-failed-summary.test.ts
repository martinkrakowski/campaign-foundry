import { expect, test } from "vitest";

// THROW-AWAY PROOF, never merged: a passing test whose output holds vitest's
// failed summary at the start of a line. Vitest exits 0; the step must go red.
test("a passing test prints a failed summary", () => {
  process.stdout.write("\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 10 passed (11)\n");
  expect(1).toBe(1);
});
