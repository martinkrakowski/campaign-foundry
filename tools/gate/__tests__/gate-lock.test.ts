import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

// D183 (lane HX3-gate-in-repo) — the in-repo gate lock. Drives the real script
// the way page.test.ts drives wave-event.sh: a fresh TMPDIR per test, so no
// test ever touches the real lock at the host's own tmp; a pid the test chose
// deliberately inside that lock, since the lock's whole contract is judged
// from what it records (owner, pid, started, beat).
//
// Exit 75 = busy is the contract this lane defines; every reclaim path — dead
// pid, stale beat — must say so on stdout before it takes the lock.
//
// M3 (lane HX3b-lock-a-command) — `run <lane> -- <command>`, which holds the
// lock around a command as the command's own holder. The tests below drive the
// real process and the real signals: the pid the lock names is `run` itself,
// INT/TERM reach the command and not just the wrapper, and the lock is gone
// when `run` is. The signal cases run under /bin/sh AND under dash when the
// host has it, because dash is CI's /bin/sh and it is the shell in which the
// trap-on-a-foreground-child deferral was measured.

const gateLockSh = fileURLToPath(new URL("../../../scripts/gate-lock.sh", import.meta.url));

/**
 * The shells the signal tests drive. CI's /bin/sh IS dash; a macOS host's is
 * bash in POSIX mode. A behaviour that differs between them is the whole risk
 * in a script that forwards signals, so both are run wherever both exist.
 */
const SIGNAL_SHELLS: string[] = existsSync("/bin/dash") ? ["sh", "/bin/dash"] : ["sh"];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate-lock-"));
  dirs.push(dir);
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  pid?: number;
}

function runLockIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 15_000,
): RunResult {
  const result = spawnSync("sh", [gateLockSh, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, ...env },
    timeout,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    pid: result.pid,
  };
}

/** The lock directory a test's TMPDIR maps to, and a writer for its four files. */
function lockDir(dir: string): string {
  return join(dir, "cf-gate.lock");
}

function seedLock(
  dir: string,
  holder: { owner?: string; pid?: number; started?: number; beat?: number },
): string {
  const lock = lockDir(dir);
  mkdirSync(lock, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(lock, "owner"), `${holder.owner ?? "other-lane"}\n`);
  writeFileSync(join(lock, "started"), `${holder.started ?? now}\n`);
  writeFileSync(join(lock, "pid"), `${holder.pid ?? process.pid}\n`);
  writeFileSync(join(lock, "beat"), `${holder.beat ?? now}\n`);
  return lock;
}

/** A pid that is not alive: spawn a short child, reap it, use its pid. */
function reapedPid(): number {
  const child = spawnSync("true");
  if (child.pid === undefined) throw new Error("spawnSync produced no pid");
  return child.pid;
}

function lockFile(dir: string, name: string): string {
  return readFileSync(join(lockDir(dir), name), "utf8");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the lock script without waiting for it, and hand back the live child:
 * a test that signals a `run` needs its pid, and the lock's own `pid` file is
 * the claim under test, so the two are compared rather than one standing in
 * for the other.
 */
function startLockIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  shell = "sh",
): { child: ChildProcess; done: Promise<RunResult> } {
  const child = spawn(shell, [gateLockSh, ...args], {
    env: { ...process.env, TMPDIR: dir, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ status: code ?? -1, stdout, stderr, pid: child.pid ?? undefined }),
    );
  });
  return { child, done };
}

/** Run the lock script without waiting for it — for tests that race it. */
function runLockAsyncIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return startLockIn(dir, args, env).done;
}

/** Poll until the path exists — the handshake for the script's test pauses. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Poll until the lock exists at the name — which is also when it is complete. */
async function waitForLock(dir: string): Promise<void> {
  await waitForFile(lockDir(dir));
}

/**
 * Poll until a pid is gone. A process told to die needs a moment, and a test
 * that asserted instantly would be reading scheduling luck; one that waited
 * out the whole process would be hiding the very failure it is looking for —
 * `sleep 30` outlives any timeout a test may set, so a command that was not
 * signalled reads as alive, not as slow.
 */
async function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The pid of the heartbeat `run` started, from the line it printed. */
function heartbeatPidOf(stdout: string): number {
  const match = /gate-lock: heartbeat pid (\d+)/.exec(stdout);
  if (!match) throw new Error(`no heartbeat pid line in:\n${stdout}`);
  return Number(match[1]);
}

function leftoverCands(dir: string): string[] {
  return readdirSync(dir).filter((entry) => entry.startsWith("cf-gate.lock.cand."));
}

describe("gate-lock.sh", () => {
  test("parses as POSIX sh", () => {
    const result = spawnSync("sh", ["-n", gateLockSh], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("acquire records the caller's pid when CF_GATE_CALLER_PID is given", () => {
    const dir = scratch();
    const result = runLockIn(dir, ["acquire", "lane-a"], { CF_GATE_CALLER_PID: "424242" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acquired by lane-a");
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    expect(lockFile(dir, "pid").trim()).toBe("424242");
    expect(Number(lockFile(dir, "started"))).toBeGreaterThan(0);
    expect(Number(lockFile(dir, "beat"))).toBeGreaterThan(0);
  });

  test("a bare acquire is refused, naming run, and so is one made while the lock is held", () => {
    // M3: a bare `acquire` can only record the pid of the `sh` that is running
    // it, and that process is gone the moment acquire returns — so the lock it
    // wrote is reclaimable before the caller has run a step, and the caller is
    // told it succeeded. There is no way to make that call safe, so it is
    // refused instead.
    const dir = scratch();
    const free = runLockIn(dir, ["acquire", "lane-a"]);
    expect(free.status).toBe(2);
    expect(free.stderr).toContain("CF_GATE_CALLER_PID");
    expect(free.stderr).toContain("run");
    // Nothing was written: a refused acquire must not leave a lock nobody holds.
    expect(existsSync(lockDir(dir))).toBe(false);

    // Held as well: "busy" would be an answer to a call that cannot work, and
    // 75 would send a caller off to retry something that can never succeed.
    seedLock(dir, { pid: process.pid, owner: "lane-a" });
    const held = runLockIn(dir, ["acquire", "lane-b"]);
    expect(held.status).toBe(2);
    expect(held.stderr).toContain("run");
    // The holder's lock is untouched — refused, not busy, and certainly not
    // reclaimed.
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    expect(lockFile(dir, "pid").trim()).toBe(String(process.pid));
  });

  test("a live holder makes acquire exit 75", () => {
    const dir = scratch();
    seedLock(dir, { pid: process.pid, owner: "lane-a" });
    const result = runLockIn(dir, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: "424242",
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("busy");
    expect(result.stderr).toContain("lane-a");
    // A busy acquire leaves the holder's lock exactly as it found it.
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
  });

  test("a lock whose pid is not alive is reclaimed, and acquire says so", () => {
    const dir = scratch();
    const dead = reapedPid();
    expect(isAlive(dead)).toBe(false);
    seedLock(dir, { pid: dead, owner: "lane-a" });
    const result = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_CALLER_PID: "424242" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reclaiming");
    expect(result.stdout).toContain("not alive");
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");
    expect(lockFile(dir, "pid").trim()).toBe("424242");
  });

  test("a lock whose beat is older than 10 minutes is reclaimed, and acquire says so", () => {
    const dir = scratch();
    const stale = Math.floor(Date.now() / 1000) - 700;
    seedLock(dir, { pid: process.pid, owner: "lane-a", beat: stale });
    const result = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_CALLER_PID: "424242" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reclaiming");
    expect(result.stdout).toContain("stale");
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");
  });

  test("CF_GATE_STALE_SECONDS overrides the 10-minute threshold", () => {
    const dir = scratch();
    const old = Math.floor(Date.now() / 1000) - 700;
    seedLock(dir, { pid: process.pid, owner: "lane-a", beat: old });
    // Under a widened threshold the same beat is fresh, so the lock is busy…
    const widened = runLockIn(dir, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_STALE_SECONDS: "3600",
    });
    expect(widened.status).toBe(75);
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    // …and a tightened threshold reclaims a beat the default would call fresh.
    const tightened = runLockIn(dir, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_STALE_SECONDS: "60",
    });
    expect(tightened.status).toBe(0);
    expect(tightened.stdout).toContain("reclaiming");
  });

  test("a reclaimer that renamed its replacement restores it, never deletes it", async () => {
    // The reclaim race: the reclaimer judges a stale lock, pauses (test hook),
    // and in that window the stale holder is replaced by a fresh acquirer.
    // The rename then moves the REPLACEMENT, which was never judged — it must
    // be restored (the name is free) and never deleted.
    const dir = scratch();
    const marker = join(dir, "paused-after-inspect");
    seedLock(dir, {
      owner: "lane-old",
      pid: reapedPid(),
      beat: Math.floor(Date.now() / 1000) - 700,
    });
    const pending = runLockAsyncIn(dir, ["acquire", "lane-new"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_TEST_PAUSE_AFTER_INSPECT: marker,
    });
    await waitForFile(marker);
    const replacement = seedLock(dir, { owner: "lane-replacement", pid: process.pid });
    rmSync(marker);
    const result = await pending;
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("busy");
    expect(result.stderr).toContain("reclaim aborted");
    // The replacement is back at the name, byte for byte as its holder wrote it.
    expect(lockFile(dir, "owner").trim()).toBe("lane-replacement");
    expect(lockFile(dir, "pid").trim()).toBe(String(process.pid));
    expect(existsSync(replacement)).toBe(true);
    expect(readdirSync(dir).some((e) => e.startsWith("cf-gate.lock.reclaim."))).toBe(false);
  }, 15_000);

  test("a reclaimer whose replacement was moved while the name is taken leaves it aside, never deletes it", async () => {
    const dir = scratch();
    const markerInspect = join(dir, "paused-after-inspect");
    const markerRestore = join(dir, "paused-before-restore");
    seedLock(dir, {
      owner: "lane-old",
      pid: reapedPid(),
      beat: Math.floor(Date.now() / 1000) - 700,
    });
    const pending = runLockAsyncIn(dir, ["acquire", "lane-new"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_TEST_PAUSE_AFTER_INSPECT: markerInspect,
      CF_GATE_TEST_PAUSE_BEFORE_RESTORE: markerRestore,
    });
    await waitForFile(markerInspect);
    seedLock(dir, { owner: "lane-replacement", pid: process.pid });
    rmSync(markerInspect);
    // The reclaimer has now moved the replacement aside and is paused again,
    // before restoring it; the name is free. A third acquirer takes it.
    await waitForFile(markerRestore);
    seedLock(dir, { owner: "lane-late", pid: process.pid });
    rmSync(markerRestore);
    const result = await pending;
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("never deleted");
    // The name holds the third acquirer's lock, intact…
    expect(lockFile(dir, "owner").trim()).toBe("lane-late");
    // …and the moved replacement is still aside, untouched by the reclaimer.
    expect(readdirSync(dir).filter((e) => e.startsWith("cf-gate.lock.reclaim."))).toHaveLength(1);
    const aside = readdirSync(dir).find((entry) => entry.startsWith("cf-gate.lock.reclaim."));
    if (!aside) throw new Error("the moved replacement was deleted rather than left aside");
    expect(readFileSync(join(dir, aside, "owner"), "utf8").trim()).toBe("lane-replacement");
  }, 15_000);

  test("a non-numeric stale threshold is refused", () => {
    const dir = scratch();
    // Order matters, and this call has two things wrong with it: a bad
    // CF_GATE_STALE_SECONDS is a broken invocation whichever subcommand it
    // arrived on, so it is reported as itself — not as the bare-acquire
    // refusal that comes next — and the caller is told about the variable it
    // actually set wrong.
    const result = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_STALE_SECONDS: "soon" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CF_GATE_STALE_SECONDS");
    expect(result.stderr).not.toContain("refused — the only pid");
  });

  test("a lock with no pid or beat at all is reclaimed", () => {
    // An abandoned half-written lock: a directory with an owner and nothing
    // else. The read-waits bound the patience, then it is reclaimed.
    const dir = scratch();
    const lock = lockDir(dir);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "lane-a\n");
    const result = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_CALLER_PID: "424242" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reclaiming");
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");
  });

  test("a creator paused before the rename leaves no lock at the name, then completes atomically", async () => {
    // Creation writes the candidate aside and renames it onto the name, so a
    // contender can never observe a half-written lock — only an abandoned one.
    const dir = scratch();
    const marker = join(dir, "paused-before-mv");
    const pending = runLockAsyncIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_TEST_PAUSE_BEFORE_MV: marker,
    });
    await waitForFile(marker);
    expect(existsSync(lockDir(dir))).toBe(false);
    const candDir = leftoverCands(dir).at(0);
    if (!candDir) throw new Error("no candidate directory while the creator is paused");
    expect(readFileSync(join(dir, candDir, "owner"), "utf8").trim()).toBe("lane-a");
    expect(readFileSync(join(dir, candDir, "pid"), "utf8").trim()).toBe("424242");
    expect(Number(readFileSync(join(dir, candDir, "beat"), "utf8"))).toBeGreaterThan(0);
    rmSync(marker);
    const result = await pending;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acquired by lane-a");
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    expect(lockFile(dir, "pid").trim()).toBe("424242");
    expect(leftoverCands(dir)).toEqual([]);
  }, 15_000);

  test("a creator paused before the rename loses the name to a contender and reports busy", async () => {
    const dir = scratch();
    const marker = join(dir, "paused-before-mv");
    const pending = runLockAsyncIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_TEST_PAUSE_BEFORE_MV: marker,
    });
    await waitForFile(marker);
    // The contender takes the name while the first is paused before its rename.
    const contender = runLockIn(dir, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(contender.status).toBe(0);
    rmSync(marker);
    const result = await pending;
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("busy");
    expect(result.stderr).toContain("lane-b");
    // The winner's lock is intact, and no candidate directories leak.
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");
    expect(leftoverCands(dir)).toEqual([]);
  }, 15_000);

  test("heartbeat refreshes the beat, and fails loudly without a lock", () => {
    const dir = scratch();
    seedLock(dir, { pid: process.pid, beat: 1000 });
    const result = runLockIn(dir, ["heartbeat"], { CF_GATE_CALLER_PID: String(process.pid) });
    expect(result.status).toBe(0);
    expect(Number(lockFile(dir, "beat"))).toBeGreaterThan(1000);

    const empty = scratch();
    const orphan = runLockIn(empty, ["heartbeat"]);
    expect(orphan.status).not.toBe(0);
    expect(orphan.stderr).toContain("no lock");
  });

  test("a heartbeat from a pid that does not hold the lock is refused and touches nothing", () => {
    const dir = scratch();
    seedLock(dir, { pid: 424242, beat: 1000 });
    const result = runLockIn(dir, ["heartbeat"], { CF_GATE_CALLER_PID: "999999" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("heartbeat refused");
    expect(lockFile(dir, "beat").trim()).toBe("1000");
  });

  test("status reports free, and reports the holder with its liveness", () => {
    const empty = scratch();
    const free = runLockIn(empty, ["status"]);
    expect(free.status).toBe(0);
    expect(free.stdout).toContain("free");

    const dir = scratch();
    seedLock(dir, { pid: process.pid, owner: "lane-a" });
    const held = runLockIn(dir, ["status"]);
    expect(held.status).toBe(0);
    expect(held.stdout).toContain("lane-a");
    expect(held.stdout).toContain("alive");

    const dead = reapedPid();
    seedLock(dir, { pid: dead, owner: "lane-a" });
    const lifeless = runLockIn(dir, ["status"]);
    expect(lifeless.stdout).toContain("not alive");
  });

  test("release removes the holder's own lock and is idempotent when it is already gone", () => {
    const dir = scratch();
    seedLock(dir, { pid: process.pid, owner: "lane-a" });
    const result = runLockIn(dir, ["release", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("released");
    expect(existsSync(lockDir(dir))).toBe(false);

    const again = runLockIn(dir, ["release", "lane-a"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to release");
  });

  test("a release from a holder whose lock was reclaimed is refused and leaves the new lock intact", () => {
    // The original holder's pid is a reaped one: another gate reclaimed its
    // stale lock (dead pid) and now owns it. The old holder's cleanup must
    // not delete the replacement.
    const dir = scratch();
    const dead = reapedPid();
    seedLock(dir, { pid: dead, owner: "lane-a" });
    const reclaim = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_CALLER_PID: "434343" });
    expect(reclaim.status).toBe(0);
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");

    // The old gate's release: right owner name is not enough on its own…
    const wrongPid = runLockIn(dir, ["release", "lane-b"], { CF_GATE_CALLER_PID: String(dead) });
    expect(wrongPid.status).not.toBe(0);
    expect(wrongPid.stderr).toContain("release refused");
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");

    // …and the wrong lane name is refused even with a matching pid.
    const wrongOwner = runLockIn(dir, ["release", "lane-a"], { CF_GATE_CALLER_PID: "434343" });
    expect(wrongOwner.status).not.toBe(0);
    expect(wrongOwner.stderr).toContain("release refused");
    expect(lockFile(dir, "owner").trim()).toBe("lane-b");

    // The rightful holder still releases it.
    const right = runLockIn(dir, ["release", "lane-b"], { CF_GATE_CALLER_PID: "434343" });
    expect(right.status).toBe(0);
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test("a release that cannot remove the lock reports failure and leaves it in place", () => {
    // A read-only lock directory defeats rm: the removal must fail loudly,
    // not be announced as released while the lock lingers.
    const dir = scratch();
    const lock = seedLock(dir, { pid: process.pid, owner: "lane-a" });
    chmodSync(lock, 0o555);
    const result = runLockIn(dir, ["release", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release failed");
    expect(existsSync(lock)).toBe(true);
    // Let the cleanup remove the scratch dir again.
    chmodSync(lock, 0o755);
  });

  test("an unknown subcommand exits 2 with the usage", () => {
    const dir = scratch();
    const result = runLockIn(dir, ["grab", "lane-a"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});

// The command the lock exists for. Everything here is about one claim: the pid
// in the lock is a process that is alive for as long as the command runs, so
// the lock cannot be taken from under it and the command cannot outlive the
// signal that was meant to stop it.
describe("gate-lock.sh run <lane> -- <command>", () => {
  test("holds the lock under its own pid while the command runs, and is busy to everyone else", async () => {
    const dir = scratch();
    // The command waits for the test to let it finish, so the lock is
    // provably held for the whole window in which the contender looks at it —
    // not merely held at some point during a run that may already be over.
    const { child, done } = startLockIn(
      dir,
      ["run", "lane-a", "--", "sh", "-c", 'while [ ! -f "$TMPDIR/go" ]; do sleep 1; done'],
      // An inherited caller pid is exactly what `run` must ignore: it belongs
      // to whatever launched this script, and that is free to exit mid-command.
      { CF_GATE_CALLER_PID: "424242" },
    );
    await waitForLock(dir);
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));

    const contender = runLockIn(dir, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(contender.status).toBe(75);
    expect(contender.stderr).toContain("busy");
    // The refusal leaves the holder's lock — and its pid — exactly as it was.
    expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");

    writeFileSync(join(dir, "go"), "");
    const result = await done;
    expect(result.status).toBe(0);
    // Released the moment the command is done: a lock outliving its run is a
    // lock the next lane trips over for no reason.
    expect(existsSync(lockDir(dir))).toBe(false);
  }, 15_000);

  test("its heartbeat keeps the beat fresh for as long as the command runs", () => {
    const dir = scratch();
    // A 1s tick must land inside a deliberate 2s hold; date +%s is second
    // granularity, so anything shorter is a coin flip, not a test. The 15s
    // timeout is calibrated to that hold, not raised to hide a flake.
    const result = runLockIn(
      dir,
      [
        "run",
        "lane-a",
        "--",
        "sh",
        "-c",
        'sleep 2; test "$(cat "$TMPDIR/cf-gate.lock/beat")" -gt "$(cat "$TMPDIR/cf-gate.lock/started")"',
      ],
      { CF_GATE_HEARTBEAT_SECONDS: "1" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("heartbeat pid");
  }, 15_000);

  test("TERM on run exits 143, releases the lock, and takes the command and the heartbeat with it", async () => {
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      // The command reports the pid it will be — it execs, so the pid it
      // publishes IS the sleep's — because "run exited" is not the claim under
      // test: "the command died with it" is, and only its own pid can show it.
      const commandPidFile = join(dir, "command.pid");
      const { child, done } = startLockIn(
        dir,
        [
          "run",
          "lane-a",
          "--",
          "sh",
          "-c",
          `printf '%s\\n' "$$" > "${commandPidFile}"; exec sleep 30`,
        ],
        { CF_GATE_HEARTBEAT_SECONDS: "1" },
        shell,
      );
      await waitForFile(commandPidFile);
      const commandPid = Number(readFileSync(commandPidFile, "utf8").trim());
      expect(commandPid).toBeGreaterThan(0);
      expect(isAlive(commandPid)).toBe(true);
      // Signal the holder the way a person or a CI timeout would: the process
      // the lock names, which the tests above pin to `run` itself.
      expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
      process.kill(Number(lockFile(dir, "pid").trim()), "SIGTERM");

      const result = await done;
      // 143 is TERM's own convention, so a caller can tell a signalled run from
      // a command that failed — and the EXIT trap still ran.
      expect({ shell, status: result.status }).toEqual({ shell, status: 143 });
      expect(result.stdout).toContain("released by lane-a");
      expect(existsSync(lockDir(dir))).toBe(false);
      // The heartbeat is reaped, not merely orphaned: nothing may outlive the
      // run, or a later lock refreshes on a pid the test can no longer account for.
      await waitForDead(heartbeatPidOf(result.stdout));
      // The command died with the wrapper. A trap on a foreground child is
      // deferred until that child exits — measured at the full 30s under dash —
      // so the signal has to be forwarded, or this sleep outlives the run.
      await waitForDead(commandPid);
    }
  }, 20_000);

  test("exits with the command's own status, and still releases the lock", () => {
    const dir = scratch();
    // A builtin: under `&` it runs in the job's subshell, so `exit 3` is the
    // command's status and not this script's.
    const result = runLockIn(dir, ["run", "lane-a", "--", "exit", "3"]);
    expect(result.status).toBe(3);
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test("a command that replaces the lock fails the run, and the replacement survives", () => {
    const dir = scratch();
    // The reclaim seen in w06, from the other end: the lock is taken by someone
    // else while the command runs. `run` must not delete what replaced it, and
    // must not report the command's success over a lock it can no longer prove
    // it held.
    const replace = [
      'rm -rf "$TMPDIR/cf-gate.lock"',
      'mkdir "$TMPDIR/cf-gate.lock"',
      'printf "lane-c\\n" > "$TMPDIR/cf-gate.lock/owner"',
      `printf "${process.pid}\\n" > "$TMPDIR/cf-gate.lock/pid"`,
      'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/started"',
      'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/beat"',
    ].join("; ");
    const result = runLockIn(dir, ["run", "lane-a", "--", "sh", "-c", replace]);
    expect(result.status).not.toBe(0);
    // Verify first: with the lock simply deleted, release reports "nothing to
    // release" and succeeds, and a run that checked nothing else would exit 0
    // over a command that ran unprotected.
    expect(result.stderr).toContain("verify failed");
    expect(result.stderr).toContain("FAILED to release the lock");
    expect(result.stderr).toContain("release refused");
    expect(lockFile(dir, "owner").trim()).toBe("lane-c");
  });

  test("a lock deleted under it fails the run too, though the release has nothing to remove", () => {
    const dir = scratch();
    const result = runLockIn(dir, [
      "run",
      "lane-a",
      "--",
      "sh",
      "-c",
      'rm -rf "$TMPDIR/cf-gate.lock"',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("verify — no lock");
    expect(result.stderr).toContain("FAILED to release the lock");
  });

  test("a nested run is refused 75, never starts its command, and leaves no lock", () => {
    const dir = scratch();
    const marker = join(dir, "inner-ran");
    // Same host lock, so a nested run is not a second holder: it must lose
    // rather than deadlock or, worse, take the name from the run above it.
    const result = runLockIn(dir, [
      "run",
      "lane-a",
      "--",
      "sh",
      gateLockSh,
      "run",
      "lane-b",
      "--",
      "touch",
      marker,
    ]);
    expect(result.status).toBe(75);
    // The busy line is what tells a nested refusal from a command that merely
    // exited 75 — and it is on stderr, where a busy answer belongs.
    expect(result.stderr).toContain("busy");
    expect(result.stderr).toContain("lane-a");
    expect(existsSync(marker)).toBe(false);
    // The outer run still cleans up after itself.
    expect(existsSync(lockDir(dir))).toBe(false);
  }, 15_000);

  test("passes the command through quoted, and a -- inside it is just an argument", () => {
    const dir = scratch();
    const out = join(dir, "args");
    // Two arguments that contain spaces must arrive as two arguments, and the
    // -- that separates them must be the FIRST one only: read as a separator
    // again, the command would lose both.
    const result = runLockIn(dir, [
      "run",
      "lane-a",
      "--",
      "sh",
      "-c",
      'printf "%s\\n" "$@" > "$TMPDIR/args"',
      "args",
      "--",
      "a b",
      "c d",
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["--", "a b", "c d"]);
  });

  test("a missing -- or an empty command is a usage error, and takes no lock", () => {
    const dir = scratch();
    const noSeparator = runLockIn(dir, ["run", "lane-a", "true"]);
    expect(noSeparator.status).toBe(2);
    expect(noSeparator.stderr).toContain("usage");

    const empty = runLockIn(dir, ["run", "lane-a", "--"]);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("usage");

    const noLane = runLockIn(dir, ["run"]);
    expect(noLane.status).toBe(2);
    expect(noLane.stderr).toContain("usage");
    // Nothing was locked on the way to the usage error.
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test("a non-numeric heartbeat interval is refused before the lock is taken", () => {
    const dir = scratch();
    const result = runLockIn(dir, ["run", "lane-a", "--", "true"], {
      CF_GATE_HEARTBEAT_SECONDS: "soon",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CF_GATE_HEARTBEAT_SECONDS");
    // Refused before the acquire, not after: a run that took the lock and then
    // died on its own validation would leave a lock with no holder to release it.
    expect(existsSync(lockDir(dir))).toBe(false);
  });
});
