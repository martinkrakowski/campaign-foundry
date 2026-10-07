import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * CI3 follow-up: a nightly sweep that replays every mutation manifest, not only
 * the ones a change touches. CI (ci.yml) replays the changed subset via
 * `scripts/verify-manifests.sh --list`; a manifest that rots on an untouched
 * file is therefore never replayed. This workflow lists every manifest with
 * `find .agents/manifests -name '*.json' -type f` and replays all of them. It is
 * outside the merge gate. This test pins its shape the way ci-aggregate.test.ts
 * pins ci.yml: read the text, split jobs, assert lines. The workflow is read
 * from its file path (never imported into the runner).
 */
const text = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/mutation-sweep.yml", import.meta.url)),
  "utf8",
);
const lines = text.split("\n");

/** [key, its block of lines] for each job under `jobs:`: a two-space key alone on its line. */
function jobs(): Array<[string, string[]]> {
  const start = lines.indexOf("jobs:");
  if (start === -1) throw new Error("no `jobs:` block in .github/workflows/mutation-sweep.yml");
  const found: Array<[string, string[]]> = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (key !== null) found.push([key[1], []]);
    else if (found.length > 0) found[found.length - 1][1].push(line);
  }
  return found;
}

const byKey = new Map(jobs().map(([key, block]) => [key, block]));

describe("the mutation sweep workflow (.github/workflows/mutation-sweep.yml)", () => {
  test("the workflow file .github/workflows/mutation-sweep.yml exists", () => {
    expect(text.length).toBeGreaterThan(0);
  });

  test("the on block contains schedule and workflow_dispatch, and no other trigger", () => {
    const onLine = lines.indexOf("on:");
    const jobsLine = lines.findIndex((l, i) => i >= onLine && /^jobs:/.test(l));
    const onText = lines.slice(onLine, jobsLine).join("\n");
    expect(onText).toContain("schedule");
    expect(onText).toContain("workflow_dispatch");
    expect(onText).not.toContain("pull_request");
    expect(onText).not.toContain("push:");
    expect(onText).not.toContain("workflow_call");
  });

  test("the cron is 06:00 UTC", () => {
    expect(text).toContain("0 6 * * *");
  });

  test("the file invokes the manifest replay and the matrix builder", () => {
    expect(text).toContain("scripts/verify-manifests.sh --replay");
    expect(text).toContain("scripts/mutation-matrix.sh");
  });

  test("the file lists every manifest and never calls verify-manifests.sh --list", () => {
    expect(text).toContain("find .agents/manifests -name '*.json' -type f");
    expect(text).not.toContain("verify-manifests.sh --list");
  });

  test("the file never special-cases fi1 or any manifest allow-list", () => {
    expect(text).not.toContain("fi1");
    expect(text).not.toContain("allow-list");
    expect(text).not.toContain("allowlist");
  });

  test("the concurrency group is mutation-sweep based and never cancels in progress", () => {
    const group = lines.find((l) => /^ {2}group:/.test(l));
    expect(group).toBeDefined();
    expect(group!).toContain("mutation-sweep");
    expect(group!).not.toContain("ci-${{");
    expect(text).toContain("cancel-in-progress: false");
  });
});

describe("the sweep jobs", () => {
  test("plan, replay and summary jobs all exist", () => {
    expect(byKey.has("plan")).toBe(true);
    expect(byKey.has("replay")).toBe(true);
    expect(byKey.has("summary")).toBe(true);
  });

  test("replay needs plan and summary needs plan and replay", () => {
    const replay = byKey.get("replay");
    const summary = byKey.get("summary");
    expect(replay).toBeDefined();
    expect(replay!.some((l) => l.includes("needs: plan"))).toBe(true);
    expect(summary).toBeDefined();
    expect(summary!.some((l) => l.includes("needs: [plan, replay]"))).toBe(true);
  });

  test("summary runs always, even when a replay leg fails", () => {
    const summary = byKey.get("summary");
    expect(summary).toBeDefined();
    expect(summary!.some((l) => l.trim() === "if: always()")).toBe(true);
  });

  test("the replay job is not cancelled early and allows forty-five minutes", () => {
    const replay = byKey.get("replay");
    expect(replay).toBeDefined();
    expect(replay!.some((l) => l.includes("fail-fast: false"))).toBe(true);
    expect(replay!.some((l) => l.includes("timeout-minutes: 45"))).toBe(true);
  });

  test("no bare ${VAR} expression escapes into a ${{ }} one", () => {
    const bare = /\$\{(?!\{)/;
    for (const line of lines) {
      if (/^\s*run:/.test(line)) continue;
      expect(bare.test(line)).toBe(false);
    }
  });

  test("every matrix.manifests if: line is exact, and the upload step runs always", () => {
    const manifestIfs = lines
      .filter((l) => /^\s+if:/.test(l))
      .map((l) => l.trim())
      .filter((t) => t.includes("matrix.manifests"));
    for (const t of manifestIfs) {
      expect(
        t === "if: ${{ matrix.manifests != '' }}" || t === "if: ${{ matrix.manifests == '' }}",
      ).toBe(true);
    }
    expect(text).toContain("if: always()");
  });

  test("the upload and download steps use v4 with the one-file-per-leg shape", () => {
    expect(text).toContain("actions/upload-artifact@v4");
    expect(text).toContain("path: sweep-failures/${{ matrix.name }}.txt");
    expect(text).not.toContain("sweep-failures/leg.txt");
    expect(text).toContain("actions/download-artifact@v4");
    expect(text).toContain("merge-multiple: true");
    expect(text).toContain("continue-on-error: true");
  });
});
