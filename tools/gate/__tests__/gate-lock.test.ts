import { spawn, spawnSync } from "node:child_process";
import {
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

const gateLockSh = fileURLToPath(new URL("../../../scripts/gate-lock.sh", import.meta.url));

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

function runLockIn(dir: string, args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync("sh", [gateLockSh, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, ...env },
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

/** Run the lock script without waiting for it — for tests that race it. */
function runLockAsyncIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [gateLockSh, ...args], {
      env: { ...process.env, TMPDIR: dir, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

/** Poll until the path exists — the handshake for the script's test pauses. */
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

  test("acquire falls back to its own pid without CF_GATE_CALLER_PID", () => {
    const dir = scratch();
    const result = runLockIn(dir, ["acquire", "lane-a"]);
    expect(result.status).toBe(0);
    expect(lockFile(dir, "pid").trim()).toBe(String(result.pid));
  });

  test("a live holder makes acquire exit 75", () => {
    const dir = scratch();
    seedLock(dir, { pid: process.pid, owner: "lane-a" });
    const result = runLockIn(dir, ["acquire", "lane-b"]);
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
    const widened = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_STALE_SECONDS: "3600" });
    expect(widened.status).toBe(75);
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    // …and a tightened threshold reclaims a beat the default would call fresh.
    const tightened = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_STALE_SECONDS: "60" });
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
    const result = runLockIn(dir, ["acquire", "lane-b"], { CF_GATE_STALE_SECONDS: "soon" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CF_GATE_STALE_SECONDS");
  });

  test("a lock with no pid or beat at all is reclaimed", () => {
    // An abandoned half-written lock: a directory with an owner and nothing
    // else. The read-waits bound the patience, then it is reclaimed.
    const dir = scratch();
    const lock = lockDir(dir);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "lane-a\n");
    const result = runLockIn(dir, ["acquire", "lane-b"]);
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

  test("an unknown subcommand exits 2 with the usage", () => {
    const dir = scratch();
    const result = runLockIn(dir, ["grab", "lane-a"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});
