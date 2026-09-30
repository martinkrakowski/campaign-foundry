import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
});
