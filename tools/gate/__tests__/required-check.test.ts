import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * D187 (lane MH1-gate-profiles), part (4) — the merge gate's REQUIRED_CHECK and
 * CI's job name are one contract held in two files, by two tools that never
 * meet: `scripts/merge-prs.sh` decides a merge is verified when a check-run
 * matches a regex, and `.github/workflows/ci.yml` decides what the check-run is
 * called. Nothing but a test connects them.
 *
 * Break the link and the failure is not a red CI. It is a wave that waits out
 * REVIEW_SETTLE_SECONDS on every PR and then refuses to merge, with the real
 * build green on the PR page the whole time — the one failure mode that looks
 * exactly like a stuck queue. Renaming the `ci` job is a plausible edit
 * (someone tidying a workflow), so the coupling is pinned here.
 *
 * The default is read, never a copy of it: a test that hardcoded `^Build` would
 * keep passing after the real default drifted away from CI, which is the drift
 * this file exists to catch.
 */

const mergePrsSh = fileURLToPath(new URL("../../../scripts/merge-prs.sh", import.meta.url));
const ciWorkflow = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

/** The pattern merge-prs.sh falls back to when REQUIRED_CHECK is not exported. */
function requiredCheckDefault(): string {
  const text = readFileSync(mergePrsSh, "utf8");
  const match = /^REQUIRED_CHECK=\$\{REQUIRED_CHECK:-'([^']*)'\}/m.exec(text);
  if (match === null) {
    throw new Error("no REQUIRED_CHECK default in scripts/merge-prs.sh");
  }
  return match[1];
}

/**
 * The `name:` of the `ci` job, read from the job's own block.
 *
 * Walked from the job's key rather than matched globally, because `name:` also
 * appears on individual steps — a `steps[].name` is a label, never a check-run
 * name, and reading one of those would make this test agree with anything. The
 * walk stops at the next job, so a second job's `name:` cannot be reached.
 */
function ciJobName(): string {
  const lines = readFileSync(ciWorkflow, "utf8").split("\n");
  const start = lines.indexOf("  ci:");
  if (start === -1) {
    throw new Error("no `ci:` job in .github/workflows/ci.yml");
  }
  for (const line of lines.slice(start + 1)) {
    // Two spaces of indent and a key: the next job in the jobs block.
    if (/^ {2}\S/.test(line)) break;
    // Four spaces of indent and `name:`: this job's own name. A step's name is
    // deeper (`      - name:`), so it cannot match.
    const match = /^ {4}name:\s*(\S.*?)\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  throw new Error("the `ci` job in .github/workflows/ci.yml has no name:");
}

describe("the required check (scripts/merge-prs.sh ↔ .github/workflows/ci.yml)", () => {
  test("the default pattern matches the ci job's name", () => {
    const pattern = requiredCheckDefault();
    const name = ciJobName();
    // Search semantics, the same ones merge-prs.sh gets from jq's `test()`:
    // the pattern is a substring rule, not a full match. (It used to be
    // python3's `re.search` here and in the script; the conclusion read is jq
    // now, and both languages search rather than match.)
    expect(new RegExp(pattern).test(name)).toBe(true);
  });

  test("both halves were found, so the assertion above read real values", () => {
    // The helpers throw on a missing half, so a rename of either line fails
    // them — but a vacuous pass (an empty string matching an empty pattern) is
    // the failure worth naming explicitly.
    expect(requiredCheckDefault()).not.toBe("");
    expect(ciJobName()).not.toBe("");
  });
});
