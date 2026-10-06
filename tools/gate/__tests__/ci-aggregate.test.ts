import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * CI1: `ci` is the one check merge-prs.sh waits for (REQUIRED_CHECK, pinned by
 * required-check.test.ts) and, since the single job was split, it is also the
 * only place that notices a job that did not succeed. This test pins that it
 * names every other job, runs when a need failed, and counts what it checked.
 */
const text = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);
const mergePrsText = readFileSync(
  fileURLToPath(new URL("../../../scripts/merge-prs.sh", import.meta.url)),
  "utf8",
);
const lines = text.split("\n");

/** [key, its block of lines] for each job under `jobs:`: a two-space key alone on its line. */
function jobs(): Array<[string, string[]]> {
  const start = lines.indexOf("jobs:");
  if (start === -1) throw new Error("no `jobs:` block in .github/workflows/ci.yml");
  const found: Array<[string, string[]]> = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (key !== null) found.push([key[1], []]);
    else if (found.length > 0) found[found.length - 1][1].push(line);
  }
  return found;
}

const all = jobs();
const aggregate = all.find(([key]) => key === "ci");

describe("the ci aggregate job (.github/workflows/ci.yml)", () => {
  test("it exists and names every other job, except the dispatch-only recorder", () => {
    expect(aggregate).toBeDefined();
    const needs = aggregate![1]
      .map((line) => /^ {4}needs:\s*\[([^\]]*)\]\s*$/.exec(line))
      .find((match) => match !== null);
    expect(needs).toBeDefined();
    const named = needs![1]
      .split(",")
      .map((name) => name.trim())
      .sort();
    const others = all
      .map(([key]) => key)
      .filter((key) => key !== "ci" && key !== "record-goldens")
      .sort();
    expect(others.length).toBeGreaterThan(1);
    expect(named).toEqual(others);
  });

  test("it runs when a needed job failed, and is not skipped with them", () => {
    expect(aggregate![1]).toContain("    if: ${{ !cancelled() }}");
  });

  test("the count it checks is the number of jobs it needs", () => {
    const count = /\[ "\$count" -ne (\d+) \]/.exec(aggregate![1].join("\n"));
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBe(all.length - 2);
  });

  test("no other job's name matches the required-check pattern", () => {
    const pattern = /^REQUIRED_CHECK=\$\{REQUIRED_CHECK:-'([^']*)'\}/m.exec(mergePrsText);
    expect(pattern).not.toBeNull();
    const matching = all
      .filter(([key]) => key !== "record-goldens")
      .filter(([, block]) =>
        block.some((line) => {
          const name = /^ {4}name:\s*(\S.*?)\s*$/.exec(line);
          return name !== null && new RegExp(pattern![1]).test(name[1]);
        }),
      )
      .map(([key]) => key);
    expect(matching).toEqual(["ci"]);
  });
});
