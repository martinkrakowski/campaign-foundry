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

/**
 * New describe for the mutation fan-out (CI2-mutation-fanout). The aggregate's
 * needs already contain the three new job keys via the existing test above; this
 * pins the new jobs' structure so a regression is caught locally.
 */
describe("the mutation fan-out jobs (.github/workflows/ci.yml)", () => {
  const byKey = new Map(all.map(([key, block]) => [key, block]));

  test("the ci aggregate needs mutations-plan, mutations-anchors and mutations", () => {
    expect(aggregate).toBeDefined();
    const needsLine = aggregate![1].find((l) => /^ {4}needs:\s*\[/.test(l));
    expect(needsLine).toBeDefined();
    for (const name of ["mutations-plan", "mutations-anchors", "mutations"]) {
      expect(needsLine!).toContain(name);
    }
  });

  test("the mutations job has no job-level if: (would skip on empty list)", () => {
    const block = byKey.get("mutations");
    expect(block).toBeDefined();
    const hasJobLevelIf = block!.some((l) => /^ {4}if:/.test(l));
    expect(hasJobLevelIf).toBe(false);
  });

  test("the mutations job takes its matrix from the plan and needs mutations-plan", () => {
    const block = byKey.get("mutations");
    expect(block).toBeDefined();
    expect(block!).toContain("    needs: mutations-plan");
    expect(block!).toContain("      matrix: ${{ fromJSON(needs.mutations-plan.outputs.matrix) }}");
  });

  test("the mutations-plan job exposes matrix and count outputs", () => {
    const block = byKey.get("mutations-plan");
    expect(block).toBeDefined();
    expect(block!.some((l) => l.includes("matrix:"))).toBe(true);
    expect(block!.some((l) => l.includes("count:"))).toBe(true);
  });

  test("every expression in the three new jobs is a real ${{ }} one", () => {
    const bare = /(?<![a-zA-Z_$])\$\{(?!\{)/;
    for (const key of ["mutations-plan", "mutations-anchors", "mutations"]) {
      const block = byKey.get(key);
      expect(block, `no block for ${key}`).toBeDefined();
      for (const line of block!) {
        if (/^\s*run:/.test(line)) continue;
        if (bare.test(line)) {
          const msg = key + " has a bare ${...} (not ${{ ... }}): " + line.trim();
          throw new Error(msg);
        }
      }
    }
  });

  test("the if: lines trimming to ${{ matrix.manifests ... }} are exact", () => {
    const block = byKey.get("mutations");
    expect(block).toBeDefined();
    const ifs = block!.filter((l) => /^\s+if:/.test(l));
    for (const l of ifs) {
      const trimmed = l.trim();
      expect(
        trimmed === "if: ${{ matrix.manifests != '' }}" ||
          trimmed === "if: ${{ matrix.manifests == '' }}",
      ).toBe(true);
    }
    const emptyChecks = ifs.filter((l) => l.trim() === "if: ${{ matrix.manifests == '' }}");
    expect(emptyChecks).toHaveLength(1);
  });

  test("the mutations job block contains sh scripts/verify-manifests.sh --replay", () => {
    const block = byKey.get("mutations");
    expect(block).toBeDefined();
    expect(block!.some((l) => l.includes("scripts/verify-manifests.sh --replay"))).toBe(true);
  });
});

describe("the workflow-level concurrency group (.github/workflows/ci.yml)", () => {
  const group = lines.find((line) => /^ {2}group:\s/.test(line));

  test("every expression in it is a real one", () => {
    expect(group).toBeDefined();
    expect(group!.match(/\$\{\{/g)).toHaveLength(4);
    expect(group!.replace(/\$\{\{.*?\}\}/g, "")).not.toMatch(/[${}]/);
  });

  test("it carries the per-commit suffix on main and the run-id suffix for the recorder", () => {
    expect(group).toContain(
      "${{ github.ref == 'refs/heads/main' && format('-{0}', github.sha) || '' }}",
    );
    expect(group).toContain(
      "${{ github.event.inputs.record_goldens == 'true' && format('-record-{0}', github.run_id) || '' }}",
    );
  });
});
