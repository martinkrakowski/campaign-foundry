import { expect, test } from "vitest";

// PROOF PLANT for PR #715 (step 2): a deliberately failing test. It must turn its shard, and
// therefore the aggregate check, red. Removed before merge.
test("ci1 proof plant: a failing test turns the aggregate red", () => {
  expect(1).toBe(2);
});
