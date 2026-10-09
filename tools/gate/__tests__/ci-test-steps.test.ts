import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ciYml = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

const prefix = "sh scripts/run-test-step.sh ";

describe("ci.yml test steps", () => {
  test("the shard test step and the Postgres backend step run through run-test-step and nothing else in the workflow changed", () => {
    const src = readFileSync(ciYml, "utf8");

    // exactly the two intended steps gained the wrapper prefix ...
    expect(src).toContain(prefix + "yarn test:cov");
    expect(src).toContain(prefix + "yarn vitest run --project api");
    expect(src.split(prefix).length - 1).toBe(2);

    // ... and stripping those two prefixes leaves no run-test-step reference
    const stripped = src.split(prefix).join("");
    expect(stripped).not.toContain("run-test-step");

    // the underlying commands are still present, un-prefixed (lossless)
    expect(stripped).toContain("yarn test:cov");
    expect(stripped).toContain("yarn vitest run --project api");
  });

  test("no workflow expression in ci.yml lost a brace", () => {
    const src = readFileSync(ciYml, "utf8");
    const opens = (src.match(/\$\{\{/g) || []).length;
    const closes = (src.match(/\}\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});
