import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D184's merge gate (`scripts/merge-prs.sh` — the spec and refusal). The
 * script is zsh, and GitHub's Linux runners do not ship zsh (`hasZsh`
 * guards every test here); the gate's own decision logic is fully covered
 * in `tools/plan-review/lib/__tests__/pre-pr.test.ts` and `risk.test.ts` —
 * what belongs here is only the wiring: the 5-field spec parse, and that a
 * refusal happens BEFORE the script touches git or the forge at all.
 *
 * `yarn` on PATH is stubbed so `pre-pr-check` never really runs — its own
 * behaviour is somebody else's test — and so no test here needs a real
 * origin remote, `gh`, or a network call.
 */

const mergePrsSh = fileURLToPath(new URL("../../../scripts/merge-prs.sh", import.meta.url));

function hasZsh(): boolean {
  const result = spawnSync("zsh", ["-c", "exit 0"]);
  return result.status === 0;
}

interface Harness {
  readonly repoDir: string;
  readonly markerFile: string;
  readonly stubBinDir: string;
  cleanup(): void;
}

/** A throwaway git repo (REPO, via `git rev-parse --show-toplevel`) plus a stubbed `yarn` on PATH. */
function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "merge-prs-test-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: repoDir });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr?.toString()}`);
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });

  const stubBinDir = join(root, "bin");
  mkdirSync(stubBinDir, { recursive: true });
  const markerFile = join(root, "marker.log");
  const stub = [
    "#!/bin/sh",
    'if [ "$1" = "plan:review" ] && [ "$2" = "pre-pr-check" ]; then',
    '  echo "$@" >> "$MARKER_FILE"',
    '  exit "${STUB_PREPR_EXIT:-0}"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const stubPath = join(stubBinDir, "yarn");
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);

  return {
    repoDir,
    markerFile,
    stubBinDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runMergePrs(
  harness: Harness,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  return spawnSync("zsh", [mergePrsSh, ...args], {
    cwd: harness.repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${harness.stubBinDir}:${process.env.PATH ?? ""}`,
      MARKER_FILE: harness.markerFile,
      ...env,
    },
  });
}

function marker(harness: Harness): string {
  return existsSync(harness.markerFile) ? readFileSync(harness.markerFile, "utf8") : "";
}

describe.skipIf(!hasZsh())("merge-prs.sh — D184's pre-PR-review gate", () => {
  test("a refused lane dies before the script prints anything about the PR at all", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42|wt|feat/x|HX1-route-segments-reserved|w06"], {
        STUB_PREPR_EXIT: "1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("pre-PR-review gate refused the merge");
      expect(result.stdout).not.toContain("=== PR #42");
      expect(marker(harness)).toContain("pre-pr-check HX1-route-segments-reserved --wave w06");
    } finally {
      harness.cleanup();
    }
  });

  test("an empty lane field keeps today's behaviour: the gate is never consulted", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42||fix/typo"]);
      // The script proceeds past the (skipped) gate and prints the PR banner —
      // whatever it fails on next (no origin remote here) is not the gate's doing.
      expect(result.stdout).toContain("=== PR #42");
      expect(result.stderr).not.toContain("pre-PR-review gate");
      expect(marker(harness)).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  test("a genuinely 3-field spec (no lane/wave fields at all, not just empty ones) keeps today's behaviour", () => {
    // S2: "42||fix/typo" already proves an EMPTY lane field is skipped. This
    // proves the shorter, pre-D184 spec shape itself — a caller that never
    // learned about the two new fields — parses the same way.
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42|wt|feat/x"]);
      expect(result.stdout).toContain("=== PR #42");
      expect(result.stderr).not.toContain("pre-PR-review gate");
      expect(marker(harness)).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  test("a gate exit other than 0/1 (usage error or a broken run) is distinguished from a refusal", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42|wt|feat/x|HX1-route-segments-reserved|w06"], {
        STUB_PREPR_EXIT: "2",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not run (exit 2)");
      expect(result.stderr).not.toContain("refused the merge");
      expect(result.stdout).not.toContain("=== PR #42");
    } finally {
      harness.cleanup();
    }
  });

  test("a lane with no wave dies immediately, naming both, without calling the gate", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42|wt|feat/x|HX1-route-segments-reserved|"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("HX1-route-segments-reserved");
      expect(result.stderr).toContain("no wave");
      expect(result.stdout).not.toContain("=== PR #42");
      expect(marker(harness)).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  test("a passing gate lets the script proceed to the PR's own work", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["42|wt|feat/x|HX4-pre-pr-review-gate|w06"], {
        STUB_PREPR_EXIT: "0",
      });
      expect(result.stdout).toContain("=== PR #42");
      expect(result.stderr).not.toContain("pre-PR-review gate refused");
      expect(marker(harness)).toContain("pre-pr-check HX4-pre-pr-review-gate --wave w06");
    } finally {
      harness.cleanup();
    }
  });

  test("--logdir is forwarded to pre-pr-check only when the script itself was given one", () => {
    const harness = makeHarness();
    try {
      runMergePrs(harness, ["--logdir", "/tmp/some-wave-log", "42|wt|feat/x|HX1|w06"], {
        STUB_PREPR_EXIT: "0",
      });
      expect(marker(harness)).toContain("--logdir /tmp/some-wave-log");
    } finally {
      harness.cleanup();
    }
  });

  test("without --logdir, pre-pr-check is left to resolve its own default", () => {
    const harness = makeHarness();
    try {
      runMergePrs(harness, ["42|wt|feat/x|HX1|w06"], { STUB_PREPR_EXIT: "0" });
      const line = marker(harness);
      expect(line).toContain("pre-pr-check HX1 --wave w06");
      expect(line).not.toContain("--logdir");
    } finally {
      harness.cleanup();
    }
  });

  test("a bare --logdir with no directory value dies with a usage message", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, ["--logdir"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--logdir requires a directory");
    } finally {
      harness.cleanup();
    }
  });
});
