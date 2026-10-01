import { describe, expect, test } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * D184's merge gate (`scripts/merge-prs.sh` — the spec, the refusal, the
 * `--continue` skip and the run lock). The script is zsh, and GitHub's Linux
 * runners do not ship zsh (`hasZsh` guards every test here); the gate's own
 * decision logic is fully covered in `tools/plan-review/lib/__tests__/
 * pre-pr.test.ts` and `risk.test.ts` — what belongs here is only the wiring:
 * the 5-field spec parse, that a refusal happens BEFORE the script touches git
 * or the forge at all, and that a refused PR is neither merged nor deleted.
 *
 * `yarn` and `gh` on PATH are stubbed, so `pre-pr-check` never really runs —
 * its own behaviour is somebody else's test — and no test here needs a real
 * origin remote, a network call or the GitHub API. Nothing in this file
 * reaches github.com: the stubs answer `pr view --json headRefOid` from the
 * harness's own bare origin, answer the check-runs API with one completed
 * successful `Build` run (so a PR settles on the first poll and the test never
 * waits out a 15s sleep), and let `sweep gate --pr <n>` refuse exactly the PR
 * named in `STUB_REFUSE_PR` — which is how a refusal lands in the MIDDLE of a
 * run and nowhere else.
 *
 * `TMPDIR` is the harness's own root, and that is load-bearing rather than
 * tidy: the run lock is a directory at `${TMPDIR}/cf-merge-prs.lock`, so a
 * test that inherited the ambient TMPDIR would take the lock real runs on this
 * host are using, and two tests would be each other's holder. The temp worktrees
 * a refresh creates live under it too, for the same reason.
 */

const mergePrsSh = fileURLToPath(new URL("../../../scripts/merge-prs.sh", import.meta.url));

function hasZsh(): boolean {
  const result = spawnSync("zsh", ["-c", "exit 0"]);
  return result.status === 0;
}

/** The three PRs the multi-PR tests merge: the first, the refused one, the last. */
const PR_ONE = { pr: "101", branch: "feat/one" };
const PR_MIDDLE = { pr: "102", branch: "feat/two" };
const PR_THREE = { pr: "103", branch: "feat/three" };

/** A 3-field spec with an EMPTY worktree, so the refresh goes through a temp one. */
function specOf(PR: { pr: string; branch: string }): string {
  return `${PR.pr}||${PR.branch}`;
}

interface Harness {
  readonly root: string;
  readonly repoDir: string;
  readonly originPath: string;
  readonly stateDir: string;
  readonly lockDir: string;
  readonly markerFile: string;
  readonly stubBinDir: string;
  cleanup(): void;
}

/** git in a directory of its own, so a failing setup step names itself. */
function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
}

/**
 * A throwaway git repo (REPO, via `git rev-parse --show-toplevel`) with a bare
 * `origin` on `main` and one branch per test PR, plus stubbed `yarn` and `gh`
 * on PATH. `main` is named by the init on both sides, not left to whatever the
 * host's `init.defaultBranch` happens to be: the epilogue ends in
 * `git checkout -q main`, so a repo whose default branch were `master` would
 * fail every run at the very last line.
 */
function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "merge-prs-test-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "seeded\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);

  // The bare origin, and the branches. All three PR branches sit on main's
  // commit, so a refresh is a no-op merge and a push is "everything up to
  // date" — this harness is about the gate, the skip and the cleanup, and a
  // real merge conflict would only make it test git.
  const originPath = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", "main", originPath]);
  git(repoDir, ["remote", "add", "origin", originPath]);
  git(repoDir, ["push", "-q", "origin", "main"]);
  for (const branch of [PR_ONE.branch, PR_MIDDLE.branch, PR_THREE.branch]) {
    git(repoDir, ["branch", branch]);
    git(repoDir, ["push", "-q", "origin", branch]);
  }

  const stubBinDir = join(root, "bin");
  mkdirSync(stubBinDir, { recursive: true });
  const markerFile = join(root, "marker.log");
  // What the stubs need to know that the script does not pass them: which
  // branch each PR number is, and where the bare origin and their own notes
  // live. `merged` is the stub's own record of what it was asked to merge.
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "branches"),
    [PR_ONE, PR_MIDDLE, PR_THREE].map((PR) => `${PR.pr} ${PR.branch}`).join("\n") + "\n",
  );

  const yarnStub = [
    "#!/bin/sh",
    'if [ "$1" = "plan:review" ] && [ "$2" = "pre-pr-check" ]; then',
    '  echo "$@" >> "$MARKER_FILE"',
    '  exit "${STUB_PREPR_EXIT:-0}"',
    "fi",
    'if [ "$1" = "sweep" ] && [ "$2" = "gate" ]; then',
    "  # `sweep gate --pr <n> --sha <sha>` is the merge condition: 0 merges, 1",
    "  # refuses. One PR refuses, so the refusal can be placed in the middle of",
    "  # a run instead of ending it.",
    '  pr=""',
    "  shift 2",
    "  while [ $# -gt 0 ]; do",
    '    if [ "$1" = "--pr" ]; then pr="$2"; break; fi',
    "    shift",
    "  done",
    '  if [ -n "$pr" ] && [ "$pr" = "${STUB_REFUSE_PR:-}" ]; then',
    '    echo "sweep gate: 1 unresolved review thread on #$pr (author: qodo)"',
    "    exit 1",
    "  fi",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const yarnStubPath = join(stubBinDir, "yarn");
  writeFileSync(yarnStubPath, yarnStub);
  chmodSync(yarnStubPath, 0o755);

  const ghStub = [
    "#!/bin/sh",
    "set -u",
    "# STUB_GH_SLEEP parks the first gh call, so a test can signal a run that is",
    "# provably mid-flight. The lock is taken before any gh call happens, so a",
    "# parked gh is a run holding it.",
    '[ -z "${STUB_GH_SLEEP:-}" ] || sleep "$STUB_GH_SLEEP"',
    "branch_of() {",
    '  awk -v pr="$1" \'$1 == pr { print $2 }\' "$STUB_STATE/branches"',
    "}",
    'case "${1:-} ${2:-}" in',
    '  "pr view")',
    '    br=$(branch_of "${3:-}")',
    '    [ -n "$br" ] || { echo "gh stub: no branch for PR ${3:-}" >&2; exit 1; }',
    "    # The head is read out of the bare origin rather than invented, so the",
    "    # script's head-moved guard is asked a real question and answers it.",
    '    git --git-dir="$STUB_ORIGIN" rev-parse "refs/heads/$br"',
    "    ;;",
    '  "pr checks")',
    "    # stdout only. --continue captures this PR's stderr to find the reason",
    "    # it was refused, and a stub's noise there would be read as that reason.",
    "    printf 'Build\\tpass\\t1m0s\\thttps://example.invalid/build/%s\\n' \"${3:-0}\"",
    "    ;;",
    '  "pr merge")',
    '    printf "%s\\n" "${3:-}" >>"$STUB_STATE/merged"',
    "    ;;",
    '  "api "*)',
    "    # `gh --jq` projects the API's own field names, and the script then",
    "    # reads .n/.s/.c rather than .name/.status/.conclusion — so this answers",
    "    # each of the two questions the script asks with what that projection",
    "    # WOULD have produced: the count the registration poll wants, and the",
    "    # projected run list the conclusion poll wants. A raw API body here",
    "    # reads as zero checks registered and zero required, and the run then",
    "    # waits out 10 minutes of polling before refusing the PR.",
    '    jq=""',
    "    while [ $# -gt 0 ]; do",
    '      if [ "$1" = "--jq" ]; then jq="${2:-}"; break; fi',
    "      shift",
    "    done",
    '    case "$jq" in',
    "      *length*) printf '1\\n' ;;",
    '      *) printf \'[{"n":"Build","s":"completed","c":"success"}]\\n\' ;;',
    "    esac",
    "    ;;",
    "  *)",
    '    echo "gh stub: unhandled: $*" >&2',
    "    exit 1",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const ghStubPath = join(stubBinDir, "gh");
  writeFileSync(ghStubPath, ghStub);
  chmodSync(ghStubPath, 0o755);

  return {
    root,
    repoDir,
    originPath,
    stateDir,
    lockDir: join(root, "cf-merge-prs.lock"),
    markerFile,
    stubBinDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mergePrsEnv(harness: Harness, env: Readonly<Record<string, string>> = {}) {
  return {
    ...process.env,
    PATH: `${harness.stubBinDir}:${process.env.PATH ?? ""}`,
    MARKER_FILE: harness.markerFile,
    // See the file header: the lock is at ${TMPDIR}/cf-merge-prs.lock, so this
    // is what keeps a test's lock off the host's and every test off every other.
    TMPDIR: harness.root,
    // Both stubs answer at once, so the settle wait is the only thing left to
    // sit through — and a test that waited out 120s per PR would time out
    // rather than assert.
    REVIEW_SETTLE_SECONDS: "0",
    STUB_STATE: harness.stateDir,
    STUB_ORIGIN: harness.originPath,
    ...env,
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
    env: mergePrsEnv(harness, env),
    // A stub that answers wrong does not make the script fail — it makes the
    // script WAIT, on its 10-minute registration poll or its 30-minute
    // conclusion poll, and vitest's testTimeout cannot interrupt a synchronous
    // spawn. The bound is here so that failure is a named timeout on this
    // call rather than a hung job; a run that legitimately needs longer than
    // this is not a run this harness can host.
    timeout: 60_000,
  });
}

function marker(harness: Harness): string {
  return existsSync(harness.markerFile) ? readFileSync(harness.markerFile, "utf8") : "";
}

/** Does this branch still exist on the bare origin? The epilogue deletes it. */
function branchExistsOnOrigin(harness: Harness, branch: string): boolean {
  return (
    spawnSync("git", [
      "--git-dir",
      harness.originPath,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).status === 0
  );
}

/** The PRs the `gh pr merge` stub was actually asked to merge. */
function mergedByStub(harness: Harness): string {
  const log = join(harness.stateDir, "merged");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

/** A lock directory held by `pid`, planted the way a live holder leaves it. */
function seedLock(harness: Harness, pid: number): void {
  mkdirSync(harness.lockDir, { recursive: true });
  writeFileSync(join(harness.lockDir, "pid"), `${pid}\n`);
}

/** A pid that is not alive: spawn a short child, reap it, use its pid. */
function reapedPid(): number {
  const child = spawnSync("true");
  if (child.pid === undefined) throw new Error("spawnSync produced no pid");
  return child.pid;
}

/**
 * Poll until a condition holds, and say what it was waiting for when it does
 * not. A bare `await` on the child's exit cannot tell a run that reacted from
 * one still waiting out the `sleep 30` it was signalled into: the failure a
 * reader gets is then the test's own timeout, naming the timeout rather than
 * the claim.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
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

/**
 * One refusal must not cost the run, and one run at a time must mean one.
 *
 * The refusal here is `sweep gate` on the MIDDLE of three PRs, because that is
 * the shape the row is about: #642's unresolved threads held back #643–#645
 * twice, so the PRs after a refusal are the whole point. The interesting
 * assertions are the two that are about what the epilogue must NOT do — a
 * refused PR's branch deleted on the forge is a lane's work gone, and no exit
 * code reports that.
 */
describe.skipIf(!hasZsh())("merge-prs.sh — --continue and the run lock", () => {
  test("--continue merges the first and third PRs, reports the second, exits 1, and keeps the refused branch", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(
        harness,
        ["--continue", specOf(PR_ONE), specOf(PR_MIDDLE), specOf(PR_THREE)],
        { STUB_REFUSE_PR: PR_MIDDLE.pr },
      );

      // The PRs on either side of the refusal both went all the way through.
      expect(result.stdout).toContain("merged #101");
      expect(result.stdout).toContain("merged #103");
      expect(mergedByStub(harness)).toBe("101\n103\n");

      // The refused one is reported as it happens, with the reason the merge
      // condition gave, and is never merged.
      expect(result.stderr).toContain("#102 REFUSED");
      expect(result.stderr).toContain("merge condition unmet for #102 — not merging");
      expect(mergedByStub(harness)).not.toContain("102");

      // The closing summary is the run's verdict: every PR accounted for, one
      // exit code for the whole run, and no ALL DONE over a refusal.
      expect(result.stdout).toContain("#101 (feat/one): merged");
      expect(result.stdout).toContain("#102 (feat/two): REFUSED");
      expect(result.stdout).toContain("#103 (feat/three): merged");
      expect(result.stdout).toContain("=== 2 merged, 1 refused");
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("ALL DONE");

      // The epilogue cleaned up the two that merged...
      expect(result.stdout).toContain("deleted origin/feat/one");
      expect(result.stdout).toContain("deleted origin/feat/three");
      expect(branchExistsOnOrigin(harness, PR_ONE.branch)).toBe(false);
      expect(branchExistsOnOrigin(harness, PR_THREE.branch)).toBe(false);
      // ...and left the one that did not exactly as it found it. The refused
      // work is the only copy of that PR left anywhere, and a branch deleted
      // here is gone from the forge for good.
      expect(result.stdout).not.toContain("deleted origin/feat/two");
      expect(branchExistsOnOrigin(harness, PR_MIDDLE.branch)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test("without --continue the same three PRs still stop at the second, and clean up nothing", () => {
    const harness = makeHarness();
    try {
      const result = runMergePrs(harness, [specOf(PR_ONE), specOf(PR_MIDDLE), specOf(PR_THREE)], {
        STUB_REFUSE_PR: PR_MIDDLE.pr,
      });

      // Today's behaviour, unchanged: the first merges, the second ends the run.
      expect(result.stdout).toContain("merged #101");
      expect(result.stdout).not.toContain("merged #102");
      expect(result.stdout).not.toContain("merged #103");
      expect(result.stderr).toContain("merge condition unmet for #102 — not merging");
      expect(result.status).toBe(1);
      // No summary: this run never got past a refusal, so there is no set of
      // PRs to report on, and the epilogue never ran either — which is why the
      // first PR's branch is still there too. Both are today's behaviour, and
      // both are the reason --continue exists.
      expect(result.stdout).not.toContain("=== summary");
      expect(result.stdout).not.toContain("ALL DONE");
      expect(result.stdout).not.toContain("deleted origin/");
      expect(branchExistsOnOrigin(harness, PR_ONE.branch)).toBe(true);
      expect(branchExistsOnOrigin(harness, PR_MIDDLE.branch)).toBe(true);
      expect(branchExistsOnOrigin(harness, PR_THREE.branch)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test("a run that finds a live holder's lock exits 75, names the holder, and does no work", () => {
    const harness = makeHarness();
    try {
      // A holder that is this test process: alive, so the lock is busy. No
      // second run is needed to prove that, and none is started — a concurrent
      // run would make the test about timing rather than about the contract.
      seedLock(harness, process.pid);

      const result = runMergePrs(harness, [specOf(PR_ONE)]);

      expect(result.status).toBe(75);
      expect(result.stderr).toContain(`merge-prs: another run holds the lock (pid ${process.pid})`);
      // Nothing was merged, and the script never printed a PR banner: 75 is
      // answered before any git and before any forge call.
      expect(result.stdout).not.toContain("=== PR #101");
      expect(mergedByStub(harness)).toBe("");
      // And the holder's lock is still intact. A run that was REFUSED the lock
      // must not take it on its way out — that is the one way a second runner
      // could break the first.
      expect(existsSync(harness.lockDir)).toBe(true);
      expect(readFileSync(join(harness.lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
    } finally {
      harness.cleanup();
    }
  });

  test("a lock whose pid is gone is reclaimed, and the run releases it when it finishes", () => {
    const harness = makeHarness();
    try {
      // A pid that has been reaped: the crashed holder the row says must be
      // reclaimable, rather than a lock somebody has to remove by hand.
      const dead = reapedPid();
      seedLock(harness, dead);

      const result = runMergePrs(harness, [specOf(PR_ONE)]);

      expect(result.stderr).not.toContain("another run holds the lock");
      // It really did the work rather than refusing early on somebody's corpse:
      // the PR merged, so the epilogue deleted its branch.
      expect(result.stdout).toContain("merged #101");
      expect(branchExistsOnOrigin(harness, PR_ONE.branch)).toBe(false);
      // And it gave the lock back. A lock left behind by a run that finished
      // is a lock every later run has to reclaim before it can do anything.
      expect(existsSync(harness.lockDir)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  test("INT during a run releases the lock", async () => {
    const harness = makeHarness();
    // STUB_GH_SLEEP parks the run inside a `gh` call, which is the only way to
    // signal a run that is provably mid-flight: the lock is taken before any
    // gh call, so a parked run is a run holding it.
    const child: ChildProcess = spawn("zsh", [mergePrsSh, specOf(PR_ONE)], {
      cwd: harness.repoDir,
      env: mergePrsEnv(harness, { STUB_GH_SLEEP: "30" }),
      // Its own process group, so the signal below reaches the gh stub's
      // `sleep 30` as well. zsh defers an INT trap until its foreground child
      // is gone, so signalling only the shell would leave the trap waiting out
      // the whole 30s — and a lock released after 30s is not what this asserts.
      detached: true,
      stdio: "ignore",
    });
    try {
      expect(await waitFor(() => existsSync(harness.lockDir), 3_000, "the lock to be taken")).toBe(
        true,
      );

      process.kill(-(child.pid as number), "SIGINT");

      expect(
        await waitFor(() => !existsSync(harness.lockDir), 3_000, "the lock to be released on INT"),
      ).toBe(true);
    } finally {
      // The run is on its way out; make sure it is gone either way, and reap it
      // so nothing outlives the test.
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        // Already gone, which is the case this test wants.
      }
      harness.cleanup();
    }
  });
});
