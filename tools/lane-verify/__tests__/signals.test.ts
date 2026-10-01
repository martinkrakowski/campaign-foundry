import { describe, expect, test } from "vitest";
import {
  EXIT_SIGINT,
  EXIT_SIGTERM,
  newSignalState,
  onSignal,
  type SignalState,
} from "../lib/signals.js";
import { BRANCH, HEAD, WORKTREE, fail, ok, runnerFor } from "./fixtures.js";
import type { SignalIo } from "../lib/signals.js";

/**
 * Item 6. Every decision the entry wrapper's `process.on` block makes lives in
 * `onSignal`, so this file is where the Ctrl-C behaviour is actually pinned:
 * whether the child is waited for, whether the restore happens once or twice,
 * and what the process exits with.
 */

const RECORDED = { head: HEAD, branch: BRANCH } as const;

/** A state as the entry publishes it: the worktree known, nothing recorded. */
const fresh = (): SignalState => {
  const state = newSignalState();
  state.cwd = WORKTREE;
  return state;
};

const harness = (
  script: Parameters<typeof runnerFor>[0],
  over: Partial<SignalIo> = {},
  state: SignalState = fresh(),
) => {
  const { run, calls } = runnerFor(script);
  const out: string[] = [];
  const err: string[] = [];
  const waited: number[] = [];
  const io: SignalIo = {
    run,
    log: (text) => out.push(text),
    logError: (text) => err.push(text),
    waitForExit: async (pid) => {
      waited.push(pid);
    },
    ...over,
  };
  return { state, io, calls, out, err, waited };
};

describe("onSignal", () => {
  test("SIGINT restores the recorded BRANCH, waits for the child, and returns 130", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    state.child = { pid: 4242, cwd: WORKTREE };
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls.map((c) => c.args)).toEqual([["checkout", "-q", BRANCH]]);
    expect(h.calls[0]?.cwd).toBe(WORKTREE);
    expect(h.waited).toEqual([4242]);
    expect(h.out).toEqual([
      "lane:verify: SIGINT — waiting for the running command to exit",
      "restore       0  (SIGINT)",
    ]);
  });

  test("SIGTERM returns 143 and restores the same way", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    expect(await onSignal("SIGTERM", h.state, h.io)).toBe(EXIT_SIGTERM);
    expect(h.out).toEqual(["restore       0  (SIGTERM)"]);
  });

  test("a worktree that was already DETACHED goes back to the recorded sha", async () => {
    const state = fresh();
    state.recorded = { head: HEAD, branch: null };
    const h = harness({ [`git checkout -q --detach ${HEAD}`]: ok() }, {}, state);
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls[0]?.args).toEqual(["checkout", "-q", "--detach", HEAD]);
  });

  test("the child is waited for BEFORE the restore, never raced", async () => {
    // A coverage run writes its report directory as it exits. A checkout that
    // raced it would restore a tree underneath a process about to write to it.
    const state = fresh();
    state.recorded = RECORDED;
    state.child = { pid: 7, cwd: WORKTREE };
    const order: string[] = [];
    const h = harness(
      { [`git checkout -q ${BRANCH}`]: ok() },
      {
        waitForExit: async (pid) => {
          order.push(`waited ${pid}`);
        },
        run: async (command, args, options) => {
          order.push(`checkout ${args.join(" ")}`);
          return runnerFor({ [`git checkout -q ${BRANCH}`]: ok() }).run(command, args, options);
        },
      },
      state,
    );
    await onSignal("SIGINT", h.state, h.io);
    expect(order).toEqual(["waited 7", `checkout checkout -q ${BRANCH}`]);
  });

  test("the restore happens EXACTLY once when the finally also runs", async () => {
    // Installing this handler means the process no longer dies on the signal, so
    // the in-flight run's `finally` is reachable and would restore too. The latch
    // is what makes the second one a no-op.
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    await onSignal("SIGINT", h.state, h.io);
    expect(state.latch.restored).toBe(true);
    expect(h.calls).toHaveLength(1);
    // And the run's own restore sees the latch set and skips.
    expect(state.latch.restored).toBe(true);
  });

  test("a restore already done reports that, and does not do it again", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    state.latch.restored = true;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls).toEqual([]);
    expect(h.out).toEqual(["lane:verify: SIGINT — the worktree had already been restored"]);
  });

  test("nothing recorded means nothing was checked out, and there is nothing to do", async () => {
    const h = harness({});
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls).toEqual([]);
    expect(h.out).toEqual([
      "lane:verify: SIGINT — nothing had been checked out, so there is nothing to restore",
    ]);
  });

  test("a recorded HEAD with no worktree is refused the same way", async () => {
    const state = fresh();
    state.cwd = null;
    state.recorded = RECORDED;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls).toEqual([]);
  });

  test("no child in flight means no wait, which is a signal between two commands", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    await onSignal("SIGINT", h.state, h.io);
    expect(h.waited).toEqual([]);
  });

  test("a restore that exits non-zero is reported, and the signal's code still stands", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness(
      { [`git checkout -q ${BRANCH}`]: fail(1, "", "pathspec did not match\n") },
      {},
      state,
    );
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.out).toEqual(["restore FAILED 1  (SIGINT)"]);
    expect(h.err).toEqual([
      `lane:verify: the restore exited 1 — ${WORKTREE} may still be on the lane branch`,
    ]);
  });

  test("a restore that cannot be run at all is reported, and is still 130", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness({}, { run: async () => Promise.reject(new Error("git is not here")) }, state);
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.err).toEqual([
      `lane:verify: the restore could not be run: git is not here — ${WORKTREE} may still be on the lane branch`,
    ]);
  });

  test("a second signal while the first is working ends the process, and says what that costs", async () => {
    const state = fresh();
    state.recorded = RECORDED;
    const h = harness({ [`git checkout -q ${BRANCH}`]: ok() }, {}, state);
    // The first handler is left mid-flight: it has claimed `handling` and not yet
    // reached the restore. The second must not start a second restore.
    state.handling = true;
    expect(await onSignal("SIGINT", h.state, h.io)).toBe(EXIT_SIGINT);
    expect(h.calls).toEqual([]);
    expect(h.err[0]).toMatch(/ending the process now; the restore in flight is abandoned/);
  });
});

describe("newSignalState", () => {
  test("opens with nothing known, nothing restored and no handler running", () => {
    expect(newSignalState()).toEqual({
      cwd: null,
      recorded: null,
      child: null,
      latch: { restored: false },
      handling: false,
    });
  });
});
