import { resolve } from "node:path";
import { LaneVerifyRefusal } from "./errors.js";
import type { ProcessRunner, RunResult } from "./types.js";

/**
 * The git half of `lane:verify`: the four refusals, the two records, the one
 * checkout, and the restore.
 *
 * Every function here takes the runner and the worktree and reaches for nothing
 * else. That is what makes the refusals testable without a repository: a fake
 * runner that answers each `git rev-parse` is a main worktree, one that answers
 * `git status --porcelain` with a tracked line is a dirty one, and neither
 * needed a `git init` to prove it.
 */

/** What the run recorded about the worktree BEFORE it checked anything out. */
export interface Recorded {
  /** `git rev-parse HEAD` at the moment the operator was standing here. */
  readonly head: string;
  /**
   * `git symbolic-ref -q --short HEAD`, or null on a detached HEAD.
   *
   * It is null on a detached HEAD because `symbolic-ref -q` exits 1 there, and
   * that exit is an ANSWER — "there is no branch here" — rather than a failure.
   * It has to be kept because a `--detach` restore would strand a worktree that
   * was sitting on a branch: the branch is still the one the operator named, but
   * nothing points at it any more, and the next `git status` in that directory
   * opens on a detached HEAD they did not ask for.
   */
  readonly branch: string | null;
}

/**
 * Runs a git READ and returns its trimmed stdout, or null when git refused.
 *
 * The two are different answers and are kept apart by returning `null` rather
 * than throwing: "git said there is no such file" is a refusal this tool reports
 * with a named reason, and it is not an exception in the middle of a table.
 */
async function gitOut(
  run: ProcessRunner,
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  const result: RunResult = await run("git", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Whether this is the repository's MAIN worktree, and is refused when it is.
 *
 * The test is the pair `git rev-parse --git-dir` / `--git-common-dir`, both
 * resolved to absolute. They are the same directory in the main checkout and
 * different in a linked worktree, which is the distinction git itself draws and
 * the only one that does not depend on where the operator is standing or on how
 * the repository was created.
 *
 * The refusal names the reason rather than just declining, because the reason is
 * not obvious and getting it wrong is expensive: this repository's test
 * environment reads the operator's `.env.local`, so a coverage run in the main
 * checkout reads the credentials and the environment of whoever is sitting at
 * that keyboard, on whatever branch they last had open, and reports on it.
 */
export async function refuseMainWorktree(cwd: string, run: ProcessRunner): Promise<void> {
  const gitDir = await gitOut(run, ["rev-parse", "--git-dir"], cwd);
  const commonDir = await gitOut(run, ["rev-parse", "--git-common-dir"], cwd);
  if (gitDir === null || commonDir === null) {
    throw new LaneVerifyRefusal(
      `${cwd} is not inside a git worktree — 'git rev-parse --git-dir' failed, so there is nothing to check out and restore`,
    );
  }
  if (resolve(cwd, gitDir) === resolve(cwd, commonDir)) {
    throw new LaneVerifyRefusal(
      `${cwd} is this repository's MAIN worktree, not a linked one, and it is refused: ` +
        `this repository's test environment reads the operator's .env.local, so a coverage run here ` +
        `measures the main checkout under the credentials of whoever is sitting at that keyboard`,
    );
  }
}

/**
 * The tracked changes in the worktree, or a refusal when git could not say.
 *
 * `??` lines are untracked files and are deliberately NOT a refusal. A lane's
 * worktree carries untracked build output and scratch files as a matter of
 * course, and the tool that checks out a branch over them must not be the thing
 * that refuses to run because a coverage directory is in the way. A TRACKED
 * change is the operator's work, and checking out over it is git's decision to
 * make loudly rather than this tool's to make quietly.
 */
export async function refuseDirtyWorktree(cwd: string, run: ProcessRunner): Promise<void> {
  const status = await run("git", ["status", "--porcelain"], { cwd });
  if (status.code !== 0) {
    throw new LaneVerifyRefusal(
      `${cwd}: 'git status --porcelain' exited ${status.code}, so whether this worktree is dirty is unknown and the run is refused`,
    );
  }
  const tracked = status.stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("??"));
  if (tracked.length > 0) {
    throw new LaneVerifyRefusal(
      `${cwd} has ${tracked.length} tracked change(s) and is refused: ` +
        `checking out over an operator's work is not this tool's decision to make. First: ` +
        tracked.map((line) => line.trim()).join(" | "),
    );
  }
}

/**
 * Refuses when `yarn.lock` differs between where the worktree is and where the
 * branch is, because the installed `node_modules` cannot answer for both.
 *
 * A lock file is the one file whose difference makes every OTHER result of this
 * run a lie: the tests would execute against the dependencies of one commit
 * while reporting on the source of another, and a green run would say nothing
 * about the branch it claims to have verified. A refusal is the only honest
 * answer, and the operator's fix is a `yarn install`, which is a decision that
 * belongs to them.
 *
 * A missing lock file on either side cannot be compared, so it is refused with
 * its own reason rather than treated as "unchanged".
 */
export async function refuseStaleLock(
  cwd: string,
  run: ProcessRunner,
  head: string,
  branch: string,
): Promise<void> {
  const ref = `origin/${branch}`;
  const here = await gitOut(run, ["show", `${head}:yarn.lock`], cwd);
  const there = await gitOut(run, ["show", `${ref}:yarn.lock`], cwd);
  if (here === null || there === null) {
    throw new LaneVerifyRefusal(
      `yarn.lock could not be read from ${here === null ? head : ref}, so it is unknown whether this worktree's node_modules is stale — the run is refused`,
    );
  }
  if (here !== there) {
    throw new LaneVerifyRefusal(
      `yarn.lock differs between ${head.slice(0, 8)} and ${ref}, so this worktree's node_modules is stale: ` +
        `the tests would run against one commit's dependencies and report on another's. Run 'yarn install' in ${cwd} first`,
    );
  }
}

/** The `git fetch` that precedes every check. Origin only, and one branch only. */
export function fetchBranch(cwd: string, run: ProcessRunner, branch: string): Promise<RunResult> {
  return run("git", ["fetch", "-q", "origin", branch], { cwd });
}

/** The HEAD and the branch (if any) the worktree is sitting on right now. */
export async function recordHead(cwd: string, run: ProcessRunner): Promise<Recorded> {
  const head = await gitOut(run, ["rev-parse", "HEAD"], cwd);
  if (head === null) {
    throw new LaneVerifyRefusal(
      `${cwd}: 'git rev-parse HEAD' failed, so there is nothing to restore and the run is refused`,
    );
  }
  const symbol = await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd });
  return { head, branch: symbol.code === 0 ? symbol.stdout.trim() : null };
}

/** Checks out the fetched branch detached, so the operator's branch never moves. */
export function checkoutDetached(
  cwd: string,
  run: ProcessRunner,
  branch: string,
): Promise<RunResult> {
  return run("git", ["checkout", "-q", "--detach", `origin/${branch}`], { cwd });
}

/**
 * Puts the worktree back where it was found — the BRANCH when there was one.
 *
 * This is the `finally` of the whole run and it is why the branch was recorded
 * and not just the sha: `git checkout -q --detach <sha>` on a worktree that was
 * sitting on `feat/lane-verify` leaves it detached, with the branch still
 * existing but pointed at by nothing, and the operator's next command is a
 * commit onto a detached HEAD. Restoring the recorded branch by name is the
 * only form of this that returns the directory to its previous state.
 */
export function restore(cwd: string, run: ProcessRunner, recorded: Recorded): Promise<RunResult> {
  return recorded.branch === null
    ? run("git", ["checkout", "-q", "--detach", recorded.head], { cwd })
    : run("git", ["checkout", "-q", recorded.branch], { cwd });
}
