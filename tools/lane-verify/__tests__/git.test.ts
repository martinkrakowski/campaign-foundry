import { describe, expect, test } from "vitest";
import {
  checkoutDetached,
  fetchBranch,
  recordHead,
  refuseDirtyWorktree,
  refuseMainWorktree,
  refuseStaleLock,
  restore,
} from "../lib/git.js";
import { LaneVerifyRefusal } from "../lib/errors.js";
import { BRANCH, HEAD, LOCK, WORKTREE, fail, ok, runnerFor } from "./fixtures.js";

describe("refuseMainWorktree", () => {
  test("a linked worktree passes: its git-dir and common-dir differ", async () => {
    const { run } = runnerFor({
      "git rev-parse --git-dir": ok("/repo/.git/worktrees/lane"),
      "git rev-parse --git-common-dir": ok("/repo/.git"),
    });
    await expect(refuseMainWorktree(WORKTREE, run)).resolves.toBeUndefined();
  });

  test("relative answers are resolved, so `.git` and `.git` are the same directory", async () => {
    const { run } = runnerFor({
      "git rev-parse --git-dir": ok(".git\n"),
      "git rev-parse --git-common-dir": ok(".git\n"),
    });
    await expect(refuseMainWorktree("/repo", run)).rejects.toBeInstanceOf(LaneVerifyRefusal);
  });

  test("the main checkout is refused, and the reason names .env.local", async () => {
    const { run } = runnerFor({
      "git rev-parse --git-dir": ok("/repo/.git"),
      "git rev-parse --git-common-dir": ok("/repo/.git"),
    });
    await expect(refuseMainWorktree("/repo", run)).rejects.toThrow(
      /MAIN worktree[\s\S]*\.env\.local/,
    );
  });

  test("a directory that is not a worktree at all is refused, not treated as a linked one", async () => {
    const { run } = runnerFor({
      "git rev-parse --git-dir": fail(128, "", "not a git repository"),
      "git rev-parse --git-common-dir": fail(128, "", "not a git repository"),
    });
    await expect(refuseMainWorktree("/tmp", run)).rejects.toThrow(/not inside a git worktree/);
  });
});

describe("refuseDirtyWorktree", () => {
  test("untracked files are not a refusal: a lane's worktree is full of them", async () => {
    const { run } = runnerFor({
      "git status --porcelain": ok("?? coverage/\n?? .agents/briefs/scratch/notes.md\n"),
    });
    await expect(refuseDirtyWorktree(WORKTREE, run)).resolves.toBeUndefined();
  });

  test("a tracked change is refused, and every one of them is named", async () => {
    const { run } = runnerFor({
      "git status --porcelain": ok("?? coverage/\n M package.json\nA  tools/lane-verify/cli.ts\n"),
    });
    await expect(refuseDirtyWorktree(WORKTREE, run)).rejects.toThrow(
      /2 tracked change\(s\)[\s\S]*M package\.json \| A  tools\/lane-verify\/cli\.ts/,
    );
  });

  test("a status git could not produce leaves the tree's state unknown, which is a refusal", async () => {
    const { run } = runnerFor({ "git status --porcelain": fail(128) });
    await expect(refuseDirtyWorktree(WORKTREE, run)).rejects.toThrow(
      /exited 128, so whether this worktree is dirty is unknown/,
    );
  });
});

describe("refuseStaleLock", () => {
  test("an identical lock file on both sides passes", async () => {
    const { run } = runnerFor({
      [`git show ${HEAD}:yarn.lock`]: ok(LOCK),
      [`git show origin/${BRANCH}:yarn.lock`]: ok(LOCK),
    });
    await expect(refuseStaleLock(WORKTREE, run, HEAD, BRANCH)).resolves.toBeUndefined();
  });

  test("a differing lock file is refused, and the fix is named", async () => {
    const { run } = runnerFor({
      [`git show ${HEAD}:yarn.lock`]: ok(LOCK),
      [`git show origin/${BRANCH}:yarn.lock`]: ok("tsx@4.20.0:\n"),
    });
    await expect(refuseStaleLock(WORKTREE, run, HEAD, BRANCH)).rejects.toThrow(
      /yarn\.lock differs[\s\S]*node_modules is stale[\s\S]*yarn install/,
    );
  });

  test("a lock file missing on THIS side names the recorded HEAD", async () => {
    const { run } = runnerFor({
      [`git show ${HEAD}:yarn.lock`]: fail(128, "", "path does not exist"),
      [`git show origin/${BRANCH}:yarn.lock`]: ok(LOCK),
    });
    await expect(refuseStaleLock(WORKTREE, run, HEAD, BRANCH)).rejects.toThrow(
      /yarn\.lock could not be read from 11111111/,
    );
  });

  test("a lock file missing on the BRANCH side names the branch", async () => {
    const { run } = runnerFor({
      [`git show ${HEAD}:yarn.lock`]: ok(LOCK),
      [`git show origin/${BRANCH}:yarn.lock`]: fail(128, "", "path does not exist"),
    });
    await expect(refuseStaleLock(WORKTREE, run, HEAD, BRANCH)).rejects.toThrow(
      /yarn\.lock could not be read from origin\/feat\/lane/,
    );
  });
});

describe("recordHead", () => {
  test("records the sha and the branch the worktree is sitting on", async () => {
    const { run } = runnerFor({
      "git rev-parse HEAD": ok(`${HEAD}\n`),
      "git symbolic-ref -q --short HEAD": ok(`${BRANCH}\n`),
    });
    expect(await recordHead(WORKTREE, run)).toEqual({ head: HEAD, branch: BRANCH });
  });

  test("symbolic-ref -q exiting 1 is an ANSWER: there is no branch here", async () => {
    const { run } = runnerFor({
      "git rev-parse HEAD": ok(`${HEAD}\n`),
      "git symbolic-ref -q --short HEAD": fail(1),
    });
    expect(await recordHead(WORKTREE, run)).toEqual({ head: HEAD, branch: null });
  });

  test("a HEAD that cannot be read leaves nothing to restore, which is a refusal", async () => {
    const { run } = runnerFor({ "git rev-parse HEAD": fail(128) });
    await expect(recordHead(WORKTREE, run)).rejects.toThrow(/nothing to restore/);
  });
});

describe("the calls that move the worktree", () => {
  test("the fetch is origin, one branch, and nothing else", async () => {
    const { run, calls } = runnerFor({ "git fetch -q origin feat/lane": ok() });
    await fetchBranch(WORKTREE, run, BRANCH);
    expect(calls[0]?.args).toEqual(["fetch", "-q", "origin", BRANCH]);
    expect(calls[0]?.cwd).toBe(WORKTREE);
  });

  test("the checkout is DETACHED at origin/<branch>, so the operator's branch never moves", async () => {
    const { run, calls } = runnerFor({ "git checkout -q --detach origin/feat/lane": ok() });
    await checkoutDetached(WORKTREE, run, BRANCH);
    expect(calls[0]?.args).toEqual(["checkout", "-q", "--detach", `origin/${BRANCH}`]);
  });

  test("a worktree that was on a BRANCH is restored by name, not left detached", async () => {
    const { run, calls } = runnerFor({ "git checkout -q feat/lane": ok() });
    const result = await restore(WORKTREE, run, { head: HEAD, branch: BRANCH });
    expect(calls[0]?.args).toEqual(["checkout", "-q", BRANCH]);
    expect(result.code).toBe(0);
  });

  test("a worktree that was already DETACHED is restored by sha", async () => {
    const { run, calls } = runnerFor({ [`git checkout -q --detach ${HEAD}`]: ok() });
    await restore(WORKTREE, run, { head: HEAD, branch: null });
    expect(calls[0]?.args).toEqual(["checkout", "-q", "--detach", HEAD]);
  });
});
