import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// D188 (lane MH2-gate-lock-slots) — a SECOND signal arriving while scripts/gate.sh
// is releasing the gate lock. `cleanup` used to reset INT/TERM to their DEFAULT
// action before it released anything, so a TERM in that window killed the gate
// where it stood.
//
// Lock absence is NOT the evidence for this, and the reason is worth stating
// once: the release is a child process, and a child outlives a parent that is
// signal-killed. On the unfixed script the parent was killed before it printed
// anything, and the parked release child then removed the lock on its own — a
// gate that lost its lock AND its report of having lost it. So what is asserted
// here is the parent's own line, `gate: lock released, heartbeat stopped`, which
// a signalled-to-death gate cannot print.
//
// The window is held open by CF_GATE_TEST_PAUSE_BEFORE_RELEASE, a pause inside
// gate-lock.sh's release between the owner/pid check and the removal. Parking
// the heartbeat cannot do it: this gate's heartbeat loop has TERM at default
// (gate.sh), so it dies at once and nothing blocks in the cleanup for a signal
// to land in. The step itself is `sleep 3` because a trap on a foreground child
// does not run until that child exits — the first TERM is deferred by exactly
// that, which is what puts the release in a state a second signal can find.
//
// Both shells: CI's /bin/sh IS dash, and a behaviour that differs between them is
// the whole risk in a script that forwards signals. bash is on the list wherever
// it exists because a macOS host's /bin/sh is bash in POSIX mode, and this case
// was measured FAILING 13 runs out of 27 under bash-as-sh before the step it
// signals during was changed (see the test's own comment). Without a bash on the
// host the case still runs under the shells it has, rather than skipping.
//
// The second describe here is not about signals: it is the other gate.sh finding
// of this round, and gate.test.ts belongs to MH1, so this file — already the
// lane's own file for driving scripts/gate.sh as a process — carries it.
//
// D189 (lane MH5-gate-sh-signal-hygiene) — the two signal-path defects this file
// now also pins, both measured on this host before the fix and both invisible to
// a lock-absence check, because in both the lock IS released and what is lost is
// the gate's own account of it:
//
//   (1) A TERM delivered while the acquire CHILD runs is deferred until that
//       child exits, and the child is not signalled: it completes its rename and
//       writes the slot it took, and only then does `exit 143` run — with
//       LOCK_HELD still 0, so release_lock had nothing to give back and the lock
//       was left naming a dead pid. Recovered from the slot file the child wrote.
//   (2) Under bash-as-sh the trap runs while run_test_cov's `> "$COVLOG" 2>&1`
//       is still in effect, so the release lines landed in the coverage log,
//       which cleanup then deleted: the gate released the lock and said nothing.
//       Measured 3 lines lost under bash, 0 under dash, in the same second.
//
// Both cases are driven under SIGNAL_SHELLS, and (2) is the reason bash is on it:
// a test that only ever ran under dash would have passed against the unfixed
// script, which is how a swallowed message looked deterministic for a whole round.

const gateSh = fileURLToPath(new URL("../../../scripts/gate.sh", import.meta.url));

/**
 * The shells every case here is driven under. CI's /bin/sh IS dash; a macOS
 * host's is bash in POSIX mode, which is where the swallowed-line failure below
 * was found. So: `sh` whatever it is, `/bin/dash` where it exists, and `bash`
 * where it exists — a shell that cannot be found is left out of the list rather
 * than failing the run, since nothing here is about a shell being present.
 */
const HAS_BASH = ["/bin/bash", "/usr/bin/bash"].some((path) => existsSync(path));

const SIGNAL_SHELLS: string[] = [
  "sh",
  ...(existsSync("/bin/dash") ? ["/bin/dash"] : []),
  ...(HAS_BASH ? ["bash"] : []),
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate-signals-"));
  dirs.push(dir);
  return dir;
}

interface GateRun {
  child: ChildProcess;
  /** Everything the gate has printed so far — the step line is the handshake. */
  stdoutSoFar: () => string;
  done: Promise<{ status: number; stdout: string; stderr: string }>;
}

/** Start the gate without waiting for it, so a test can signal it in a window. */
function startGate(dir: string, env: Record<string, string>, shell: string): GateRun {
  const child = spawn(shell, [gateSh, "--lane", "lane-a"], {
    env: { ...process.env, TMPDIR: dir, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      // A signalled-to-death child closes with code null, and `?? -1` keeps that
      // distinguishable from a 143 the gate chose to exit with.
      child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
    },
  );
  return { child, stdoutSoFar: () => stdout, done };
}

/** Poll until the path exists — the handshake for the script's test pauses. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** How many times `needle` appears — "exactly once" is an assertion, not a `toContain`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Never leave a gate running, whatever an assertion did: a parked acquire child
 * holds its parent's stdout open, so a test that abandons one also abandons a
 * process for as long as the pause it is parked in allows. The marker goes first
 * for exactly that reason — a paused `while [ -f … ]; do sleep 1; done` would
 * otherwise never let the child, and so never let `close`, arrive.
 */
async function stopGate(
  child: ChildProcess,
  done: Promise<unknown>,
  markers: string[] = [],
): Promise<void> {
  for (const marker of markers) rmSync(marker, { force: true });
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await done;
}

/**
 * Await a promise, and name the wait that failed if it takes longer than it
 * should. Used where the thing being asserted is a TIMING: a child that outlived
 * the gate still holding the caller's stdout keeps the pipe open, so the gate's
 * `close` arrives a whole heartbeat interval late even though the gate itself
 * exited at once — and a reader waiting on that pipe cannot tell the two apart.
 */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} — still not finished after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Every lock-shaped name left in `dir`, whatever slot of the semaphore it is. */
function locksLeftIn(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.startsWith("cf-gate.lock"));
}

/**
 * A live, fresh lock in `dir`, as another lane would be holding it. The gate's
 * host here is pinned to ONE slot (see the case that uses this): CF_GATE_SLOTS
 * is host-wide, and a host with a semaphore would read a single seeded slot as
 * free and hand the acquirer the next one — which is right there and wrong here.
 */
function seedBusyLock(dir: string, owner = "lane-a"): void {
  mkdirSync(join(dir, "cf-gate.lock"));
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, "cf-gate.lock", "owner"), `${owner}\n`);
  writeFileSync(join(dir, "cf-gate.lock", "started"), `${now}\n`);
  writeFileSync(join(dir, "cf-gate.lock", "pid"), `${process.pid}\n`);
  writeFileSync(join(dir, "cf-gate.lock", "beat"), `${now}\n`);
}

/**
 * Poll until the gate has printed the line that starts its heartbeat loop. That
 * line is the only safe place from which to signal: gate.sh prints it once the
 * acquire has returned AND `LOCK_HELD` is 1, immediately before the locked step's
 * command runs, and the `sleep 3` step then buys three whole seconds of "cleanup
 * has not started yet".
 *
 * Neither of the two earlier candidates works, and both were measured here.
 * Waiting for the lock DIRECTORY to appear is too early: it lands at the
 * acquire's rename, while the gate is still inside that child with LOCK_HELD
 * still 0, so a signal there runs `exit 143` with nothing to release — 25 runs
 * in 25, each leaving the lock behind with no release attempted. Waiting for the
 * step's own `==> [1/1] verify-manifests` line is too EARLY for the same reason:
 * gate.sh prints it at the top of the loop, before it acquires.
 */
async function waitForOutput(
  stdout: () => string,
  needle: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stdout().includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${needle} in:\n${stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("gate.sh signals", () => {
  test("a second TERM while the release is parked still releases the lock and says so", async () => {
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      const releaseMarker = join(dir, "paused-before-release");
      // verify-manifests is a LOCKED step, so the gate takes the lock, runs the
      // step under it, and releases afterwards — and it is the OTHER of the two
      // locked steps on purpose. The first TERM below is deferred until the step
      // exits, and under bash the trap then runs while the step's redirections
      // are still in effect, so EVERYTHING cleanup prints — including the release
      // line this test asserts — goes into whatever the step captured, which
      // cleanup then deletes. test:cov captures its output into $COVLOG and this
      // case lost the line 13 runs out of 27 under bash-as-sh for exactly that
      // reason, against 0 in 7 under dash, which is why it looked deterministic
      // on a dash host and was not: the lost message was never about the second
      // signal at all. Three seconds, not one: a step that ended inside a second
      // of the heartbeat line could have that TERM land after the whole gate was
      // gone, which is a failure of the test's timing, not of the fix.
      const { child, stdoutSoFar, done } = startGate(
        dir,
        {
          CF_GATE_STEPS: "verify-manifests\tsleep 3",
          CF_GATE_TEST_PAUSE_BEFORE_RELEASE: releaseMarker,
        },
        shell,
      );
      // Wait for the gate to announce its heartbeat: past the acquire, past the
      // point where it records that it HOLDS the lock, and with the step still
      // to come.
      await waitForOutput(stdoutSoFar, "gate: heartbeat pid");
      expect(existsSync(join(dir, "cf-gate.lock"))).toBe(true);

      // The first TERM, during the step: a trap on a foreground child does not
      // run until that child exits, so this is deferred rather than answered.
      process.kill(child.pid as number, "SIGTERM");
      // …and answered as soon as the step is done, which leaves the gate inside
      // its cleanup with the release about to run.
      await waitForFile(releaseMarker);
      // The second TERM, in exactly the window the fix is about: the release is
      // parked between its owner/pid check and the removal.
      process.kill(child.pid as number, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Still there. An unfixed gate is dead by now, and no amount of waiting
      // would bring the release line back.
      const survived = child.exitCode === null && child.signalCode === null;

      rmSync(releaseMarker);
      const result = await done;
      // 143 is TERM's own convention, preserved through the cleanup: the signal
      // was answered and the gate still reported it, rather than dying where it
      // stood and letting a child finish the job.
      expect({ shell, survived, status: result.status }).toEqual({
        shell,
        survived: true,
        status: 143,
      });
      // The proof that matters, and the one lock absence cannot stand in for.
      expect(result.stdout).toContain("gate: lock released, heartbeat stopped");
      // And the lock is genuinely gone, now because the gate said so.
      expect(existsSync(join(dir, "cf-gate.lock"))).toBe(false);
    }
  }, 60_000);

  test("a TERM while the acquire child runs still releases the lock that child won", async () => {
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      // The existing hook, inside gate-lock.sh's try_create, between the fully
      // written candidate and its rename. The acquire child INHERITS it, so it
      // parks there with the lock taken and not yet named: which is the whole
      // window this case is about.
      const mvMarker = join(dir, "paused-before-mv");
      const { child, done } = startGate(
        dir,
        {
          CF_GATE_STEPS: "verify-manifests\tsleep 1",
          CF_GATE_TEST_PAUSE_BEFORE_MV: mvMarker,
        },
        shell,
      );
      try {
        // The handshake is the file, not the output: until the child parks, the
        // gate has not run anything a TERM could be deferred against.
        await waitForFile(mvMarker);
        // The parent only, and that is the point rather than a limitation. A
        // signal sent to a pid is not delivered to its children, so the acquire
        // child is not signalled: it finishes its rename and writes the slot it
        // won, and only then does the parent's deferred `exit 143` run — with
        // LOCK_HELD still 0, before the line that reads the slot file back. This
        // is the ONLY pid that ends up with a lock nobody will give back.
        process.kill(child.pid as number, "SIGTERM");
        rmSync(mvMarker);
        const result = await done;
        expect({ shell, status: result.status }).toEqual({ shell, status: 143 });
        // Both lines, because both are load-bearing: the lock script's says WHICH
        // lock went back, and the gate's is the one a signalled-to-death gate
        // could never have printed.
        expect(result.stdout).toContain("gate-lock: released by lane-a");
        expect(result.stdout).toContain("gate: lock released, heartbeat stopped");
        // …and nothing of it is left, in any slot of the host's semaphore.
        expect({ shell, left: locksLeftIn(dir) }).toEqual({ shell, left: [] });
      } finally {
        await stopGate(child, done, [mvMarker]);
      }
    }
  }, 60_000);

  test("a TERM during the test:cov step reports the release on the caller's stdout", async () => {
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      // The step's own trace, written from INSIDE the capture run_test_cov wraps
      // it in. The heartbeat line is NOT a handshake for this: it is printed
      // before the step starts, so a TERM sent on it can land in the few
      // milliseconds before the redirect exists — where the release lines go to
      // the caller's stdout anyway and the case proves nothing. (Measured: that
      // is exactly what it did, 3 shells out of 3, against a script the row says
      // is broken.) A `touch` the eval runs is the only proof available that the
      // capture is now in effect.
      const inStep = join(dir, "in-test-cov-step");
      const { child, done } = startGate(
        dir,
        {
          CF_GATE_STEPS: `test:cov\ttouch "${inStep}"; sleep 3`,
          // The interval is this case's, not the host's, and the bound below is
          // measured against it: the orphan the `exec 3>&- 4>&-` line prevents
          // holds the pipe for as long as this sleep. On a host whose
          // CF_GATE_HEARTBEAT_SECONDS were at or under the bound, a script
          // WITHOUT that line would pass here — the assertion would be measuring
          // the host's configuration rather than the script.
          CF_GATE_HEARTBEAT_SECONDS: "60",
        },
        shell,
      );
      try {
        // test:cov is the step that CAPTURES its output, and under bash the trap
        // fires with that capture still in effect — the gate released the lock and
        // every word of it went into $COVLOG, which cleanup then deleted. dash is
        // unaffected, which is why this case must run under bash too.
        await waitForFile(inStep);
        process.kill(child.pid as number, "SIGTERM");
        // And it must be OVER, not merely reported. The heartbeat loop's own sleep
        // is orphaned by the kill; if it still held the caller's saved stdout, the
        // pipe would stay open for a whole interval and this `close` would arrive
        // a minute late — long after the gate said it was gone. So the wait is
        // itself the assertion, and it is bounded well under that interval.
        const result = await within(done, 20_000, `the gate under ${shell} never closed`);
        expect({ shell, status: result.status }).toEqual({ shell, status: 143 });
        expect(result.stdout).toContain("gate-lock: released by lane-a");
        expect(result.stdout).toContain("gate: lock released, heartbeat stopped");
        // stderr, not stdout: the gate's FAILED line is written to its own saved
        // fd 4, so asserting on stdout here asserted nothing a script could do.
        // On the caller's stderr it is a real assertion — a release that failed
        // or was refused prints there, under every shell, whatever the step was
        // doing with fd 1.
        expect(result.stderr).not.toContain("FAILED to release");
        expect(locksLeftIn(dir)).toEqual([]);
      } finally {
        await stopGate(child, done);
      }
    }
  }, 60_000);
});

describe("gate.sh lock", () => {
  /** Run the gate to completion, the way the cases that send no signal do. */
  function runGate(
    dir: string,
    env: Record<string, string>,
    shell: string,
    timeout = 15_000,
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(shell, [gateSh, "--lane", "lane-a"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: dir, ...env },
      timeout,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  test("a lock it took but could not name is released anyway", () => {
    // The acquire succeeded and recorded nothing — a gate that cannot say which
    // slot it holds refuses to carry on, and that refusal is right. What it must
    // NOT do is walk away holding the lock: with LOCK_HELD still 0 at the exit,
    // cleanup's release_lock did nothing at all and the name sat there until some
    // later acquire judged it abandoned. The comment beside the check already
    // promised the opposite — that the cleanup's release falls back to scanning
    // for this gate's own lock — and the promise is only true once LOCK_HELD is
    // set above the check, which is what this asserts.
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      const result = runGate(
        dir,
        {
          // The gate exits before running any step, so this one never executes; it
          // is here because a gate with no locked step takes no lock at all.
          CF_GATE_STEPS: "verify-manifests\tsleep 1",
          CF_GATE_TEST_NO_SLOT_RECORDED: "1",
        },
        shell,
      );
      // The refusal is unchanged: exit 1, naming the file that came back empty.
      expect({ shell, status: result.status }).toEqual({ shell, status: 1 });
      expect(result.stderr).toContain("no slot was recorded");
      // Unpinned now — the pin is empty — so the release scans for the owner and
      // pid this gate acquired under, finds its own slot and drops it.
      expect(result.stdout).toContain("gate-lock: released by lane-a");
      expect(result.stdout).toContain("gate: lock released, heartbeat stopped");
      expect(existsSync(join(dir, "cf-gate.lock"))).toBe(false);
    }
  }, 60_000);

  test("a green gate reports the release once, and never a refusal", () => {
    // The one release per gate, which is what keeps a healthy run's output
    // unchanged. Two callers can reach release_lock — the end-of-run release and
    // cleanup's — and the second one still finds the slot file naming the slot the
    // first gave back: without the flag it announces a second release of a lock
    // that is gone, and on a host where another gate has since taken that name it
    // reports a REFUSAL, on stderr, for a gate that did nothing wrong. Both are
    // the same defect seen twice, and both are what this pins shut.
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      const result = runGate(dir, { CF_GATE_STEPS: "verify-manifests\ttrue" }, shell);
      expect({ shell, status: result.status }).toEqual({ shell, status: 0 });
      expect(occurrences(result.stdout, "gate-lock: released by lane-a")).toBe(1);
      expect(occurrences(result.stdout, "gate: lock released, heartbeat stopped")).toBe(1);
      expect(result.stdout).not.toContain("nothing to release");
      expect(result.stdout).not.toContain("release refused");
      expect(result.stderr).not.toContain("FAILED to release");
      expect(locksLeftIn(dir)).toEqual([]);
    }
  }, 60_000);

  test("a busy acquire still prints one line and nothing else", () => {
    // The acquire-window recovery reads the slot file, and a busy acquire leaves
    // it EMPTY — it took nothing, so there is nothing of this gate's to give
    // back. The recovery must therefore be silent: a busy gate's output is what
    // every other lane on this host reads to decide whether to sleep and retry,
    // and a second "released" line under a 75 would be read as a released lock.
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      seedBusyLock(dir, "lane-a");
      const result = runGate(dir, { CF_GATE_STEPS: "test:cov\ttrue", CF_GATE_SLOTS: "1" }, shell);
      expect({ shell, status: result.status }).toEqual({ shell, status: 75 });
      // The holder's line and the gate's: two, and no third.
      const said = result.stderr.split("\n").filter((line) => line !== "");
      expect(said).toHaveLength(2);
      expect(result.stderr).toContain("busy");
      expect(result.stderr).toContain("lane-a");
      expect(result.stdout).not.toContain("released by");
      expect(result.stdout).not.toContain("lock released");
      // And the holder's lock is untouched, which is the other half of busy.
      expect(readdirSync(join(dir, "cf-gate.lock"))).toContain("owner");
    }
  }, 60_000);
});
