import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { gateEnv } from "./gate-env.js";
import { scaled } from "./wait-scale.js";

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

/**
 * A scratch directory, RESOLVED.
 *
 * The resolution is not tidiness, it is the pool path rule. A pool must have no
 * symlinked ancestor, and every pool in this file is built inside a scratch — so a
 * scratch reached through a link hands every pool test a path the lock refuses.
 * `os.tmpdir()` is not a resolved path on either of the two hosts that matter: a
 * Mac's is `/var/folders/…` and `/var` is a symlink to `/private/var`, while a
 * Linux seat may export TMPDIR through one itself. 26 of these tests failed on the
 * Mac for that reason alone, and a Linux run could not see it because
 * `/tmp` and `/mnt/pool` are real directories here.
 *
 * So the scratch is resolved once, here, where it is made — which is also the only
 * place a test can fix it. `realpathSync` on a path `mkdtempSync` just created is
 * the same answer `cd "$dir" && pwd -P` gives, and it is what the refusal message
 * tells an operator to name their pool by.
 *
 * Deliberately NOT applied to the symlinks this file builds on purpose: those are
 * refused for being symlinks, and resolving them would resolve away the case. They
 * are made INSIDE a resolved scratch, so the link is the only link in the path.
 */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cf-gate-lock-")));
  dirs.push(dir);
  return dir;
}

/**
 * A scratch that is a git worktree of its own, so `git rev-parse
 * --show-toplevel` has a root to print and `acquire` takes its git branch
 * rather than the `pwd -P` one. The lock parent is ${TMPDIR:-/tmp}, which is
 * not inside a repository, so a plain scratch here really is outside one.
 */
function gitScratch(): string {
  const dir = scratch();
  const init = spawnSync("git", ["init", "--quiet", dir], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed for ${dir}: ${init.stderr}`);
  return dir;
}

/**
 * What `acquire` reads as the caller's worktree for a cwd that is not inside a
 * repository: `pwd -P`, which resolves symlinks, so it is `realpathSync` and
 * not the path the test happened to build.
 */
function plainWorktree(cwd: string): string {
  return realpathSync(cwd);
}

/** runLockIn from a cwd of its own — the worktree half of the TMPDIR/cwd pair. */
function acquireFrom(
  dir: string,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): RunResult {
  return runLockIn(dir, args, env, 15_000, "sh", cwd);
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  pid?: number;
}

/**
 * `dir` is the TMPDIR — where the LOCK lives. `cwd` is where the script is
 * STANDING, which is a different thing and is only ever read as the caller's
 * worktree (MH4). A lane takes a slot in the lock parent and runs its steps in
 * its own checkout, so a test that gives two acquirers one TMPDIR and one cwd
 * each is a host with two slots and two worktrees; a test that gives them two
 * TMPDIRs is two hosts.
 *
 * The environment itself comes from gateEnv — every spawn site in this
 * directory goes through it, because CF_GATE_SLOTS is host-wide and so are the
 * three pool variables, and a test that inherits either takes a seat out of the
 * operator's host while it runs.
 */
function runLockIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  timeout = 15_000,
  shell = "sh",
  cwd?: string,
): RunResult {
  const result = spawnSync(shell, [gateLockSh, ...args], {
    encoding: "utf8",
    env: gateEnv(dir, env),
    timeout,
    cwd,
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
  cwd?: string,
): { child: ChildProcess; done: Promise<RunResult> } {
  // The same shared environment as runLockIn above — see there for why.
  const child = spawn(shell, [gateLockSh, ...args], {
    env: gateEnv(dir, env),
    cwd,
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
  shell = "sh",
): Promise<RunResult> {
  return startLockIn(dir, args, env, shell).done;
}

/** Poll until the path exists — the handshake for the script's test pauses. */
async function waitForFile(path: string, timeoutMs = scaled(10_000)): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Poll until the path exists AND holds something. A file appears when it is
 * opened, which is before anything is written into it, so a pause marker and a
 * pid a command published are not the same wait: waiting for the marker means
 * waiting for the file, and waiting for the pid means waiting for the value.
 * Reading the pid out of a file that exists but is not yet written gives 0.
 */
async function waitForContent(path: string, timeoutMs = scaled(10_000)): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path) && readFileSync(path, "utf8").trim() !== "") return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to have content`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Poll until the lock exists at the name — which is also when it is complete. */
async function waitForLock(dir: string): Promise<void> {
  await waitForFile(lockDir(dir));
}

/**
 * Poll until a condition holds, and say what it was waiting for when it does
 * not. A bare `await done` cannot tell a run that reacted from one still
 * waiting out the command it never signalled: the promise simply does not
 * settle, and the failure a reader gets is the test's own timeout, naming the
 * timeout rather than the claim.
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

/**
 * Poll until a pid is gone. A process told to die needs a moment, and a test
 * that asserted instantly would be reading scheduling luck; one that waited
 * out the whole process would be hiding the very failure it is looking for —
 * `sleep 30` outlives any timeout a test may set, so a command that was not
 * signalled reads as alive, not as slow.
 */
async function waitForDead(pid: number, timeoutMs = scaled(5_000)): Promise<void> {
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

/**
 * Proof, on the host, that a wait helper lets its deadline be stretched by the
 * scale before it gives up — without needing a slow runner. The path never
 * appears, the deadline is 40 ms, and the scale is stubbed to 3, so the helper
 * must not give up until at least 120 ms (40 * 3); under 1 s rules out a poll
 * loop that forgot to scale and gave up near-instantly.
 */
test("a wait helper allows its deadline times the scale before it gives up", async () => {
  const missing = join(scratch(), "never-appears");
  vi.stubEnv("CF_GATE_TEST_WAIT_SCALE", "3");
  vi.resetModules();
  const { scaled: deadlineFor } = await import("./wait-scale.js");
  try {
    const start = Date.now();
    await expect(waitForFile(missing, deadlineFor(40))).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(1_000);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

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

  test("an acquire from a directory that no longer exists is refused, having taken nothing", () => {
    // One gate per worktree is enforced by comparing worktrees, and an EMPTY
    // worktree compares equal to nothing: worktree_holder skips a slot whose
    // worktree file is empty, so a lock that recorded "" would be invisible to
    // the next acquire from the same directory, and two gates would each hold a
    // slot in one worktree. So the identity is required, and the refusal is
    // CLOSED — before the slot loop, not after a slot is won and given back.
    //
    // The shape here is the portable one. Handing spawnSync a `cwd` that is not
    // there fails inside libuv with ENOENT before any shell starts, on every
    // platform, so the child is asked to delete its OWN cwd and then exec: the
    // shell is already running when the directory goes. `cd` succeeds, `rmdir`
    // succeeds because the directory is empty, and from the `exec` on there is
    // no path back to it — `git rev-parse` cannot answer, and `pwd -P` prints
    // nothing at all (measured here under /bin/sh, which is dash, and under
    // bash: both give an empty string, with the getcwd failure on stderr).
    const dir = scratch();
    const doomed = scratch();
    const result = spawnSync(
      "sh",
      ["-c", 'cd "$1" && rmdir "$1" && exec sh "$2" acquire lane-gone', "sh", doomed, gateLockSh],
      {
        encoding: "utf8",
        // The shared builder, like every other spawn site here: this child's
        // TMPDIR is `dir` and its slot count is one, and the three pool
        // variables are deleted rather than inherited.
        env: gateEnv(dir, { CF_GATE_CALLER_PID: String(process.pid) }),
      },
    );
    // Exit 2 and not 75: the host is not busy, and retrying cannot help while
    // the caller's own directory is gone.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot determine the caller's worktree");
    // Nothing was taken, and nothing was half-taken: no lock at the name, and
    // no candidate left behind by a try_create the loop never had to enter.
    expect(existsSync(lockDir(dir))).toBe(false);
    expect(leftoverCands(dir)).toEqual([]);
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

  test(
    "a reclaimer that renamed its replacement restores it, never deletes it",
    async () => {
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
    },
    scaled(15_000),
  );

  test(
    "a reclaimer whose replacement was moved while the name is taken leaves it aside, never deletes it",
    async () => {
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
    },
    scaled(15_000),
  );

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

  test(
    "a creator paused before the rename leaves no lock at the name, then completes atomically",
    async () => {
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
    },
    scaled(15_000),
  );

  test(
    "a creator paused before the rename loses the name to a contender and reports busy",
    async () => {
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
    },
    scaled(15_000),
  );

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
  test(
    "holds the lock under its own pid while the command runs, and is busy to everyone else",
    async () => {
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
    },
    scaled(15_000),
  );

  test("its heartbeat keeps the beat fresh for as long as the command runs", () => {
    const dir = scratch();
    // A 1s tick has to land while the command is still running, and the
    // command polls for it in a bounded loop rather than reading once after a
    // fixed sleep: `date +%s` is second granularity, so a single read is a
    // coin flip on a loaded host, and a coin flip in a test is a flake. The
    // bound is the assertion — the command exits non-zero if the beat never
    // moves — and the 20s timeout is calibrated to the bound, not raised to
    // hide one.
    const result = runLockIn(
      dir,
      [
        "run",
        "lane-a",
        "--",
        "sh",
        "-c",
        'i=0; while [ "$i" -lt 10 ]; do if [ "$(cat "$TMPDIR/cf-gate.lock/beat" 2>/dev/null)" -gt "$(cat "$TMPDIR/cf-gate.lock/started" 2>/dev/null)" ] 2>/dev/null; then exit 0; fi; i=$((i + 1)); sleep 1; done; exit 1',
      ],
      { CF_GATE_HEARTBEAT_SECONDS: "1" },
    );
    // stderr is part of the assertion, not decoration: a run whose beat moved
    // has nothing to report, so anything on stderr here is the reason the beat
    // did not — the lock-lost message, a failed release — and it belongs in
    // the failure a reader has to diagnose.
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("heartbeat pid");
  }, 20_000);

  test(
    "a reader never catches the beat empty while the heartbeat refreshes it",
    async () => {
      // Under both shells, like the signal tests: the beat is written by a
      // subshell that sleeps and forks, and the two shells differ in what they
      // defer and when, so a property of the beat that holds under one of them is
      // a property of that shell until it has been run under the other.
      for (const shell of SIGNAL_SHELLS) {
        const dir = scratch();
        // `acquire` and `status` read the beat, and an empty one reads as STALE:
        // a reader that caught a heartbeat mid-write would judge a live,
        // heartbeating holder's lock reclaimable, and take it. The beat is
        // replaced by a rename, so a reader sees the previous beat or the next one
        // and never nothing. Hammering the file for the life of a run that
        // heartbeats every second is the only way to look at that window; the
        // sample count is asserted too, so a reader that stalled cannot pass this
        // by having read nothing.
        const { child, done } = startLockIn(
          dir,
          ["run", "lane-a", "--", "sleep", "7"],
          {
            CF_GATE_HEARTBEAT_SECONDS: "1",
          },
          shell,
        );
        await waitForLock(dir);
        const beat = join(lockDir(dir), "beat");
        let reads = 0;
        let empty = 0;
        let missing = 0;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          let value: string;
          try {
            value = readFileSync(beat, "utf8");
          } catch {
            // Counted, not skipped: the beat is replaced by a rename, so it is
            // never absent, and a read that fails is a defect this test would
            // otherwise step over — on the way to passing on the reads that worked.
            missing += 1;
            continue;
          }
          reads += 1;
          if (value === "") empty += 1;
          // Yield periodically, so the child's stdout and stderr keep being drained
          // while this loop runs. Nothing here fills a pipe today — `run` prints two
          // lines and the heartbeat's stdio is detached — but a reader that starves
          // the writer it is measuring is a measurement that can stop measuring.
          if (reads % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        // All three, and the sample count with them: a reader that stalled, or one
        // whose reads were all failures, must not be able to pass.
        expect({ shell, reads: reads > 1000, empty, missing }).toEqual({
          shell,
          reads: true,
          empty: 0,
          missing: 0,
        });
        process.kill(child.pid as number, "SIGTERM");
        const result = await done;
        expect({ shell, status: result.status }).toEqual({ shell, status: 143 });
      }
    },
    scaled(30_000),
  );

  /**
   * One signal, from outside, at a `run` that is holding the lock around a
   * command which is not going to stop on its own. Everything asserted here is
   * about the command, not the wrapper: the wrapper's exit code says it reacted,
   * and only the command's own pid says it stopped.
   *
   * `times` is how many signals are sent, 500ms apart — a second one landing
   * while the first is still being handled is what a CI timeout does, and the
   * two shells answered it differently enough to cost a lock (see the notes on
   * forward_signal). A `times: 2` signal may find `run` already gone, which is
   * the exec-mode case below: `exec sleep 30` dies on the forwarded TERM at
   * once, so there is no window for a second signal to fall into, and a signal
   * to a dead pid is a fact about the test's timing, not a failure to report.
   */
  async function signalRun(
    shell: string,
    signal: "SIGINT" | "SIGTERM",
    expectedStatus: number,
    times = 1,
  ): Promise<void> {
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
        // The sleep's own stdio is dropped so that a signal this wrapper
        // FORWARDED closes the pipe with it. A sleep that survives holds
        // `run`'s stdout open, and the test's result would then arrive when
        // the sleep did — half a minute later, as a timeout naming the wrong
        // thing, instead of as the command that outlived its wrapper.
        `printf '%s\\n' "$$" > "${commandPidFile}"; exec sleep 30 >/dev/null 2>&1`,
      ],
      { CF_GATE_HEARTBEAT_SECONDS: "1" },
      shell,
    );
    await waitForContent(commandPidFile);
    const commandPid = Number(readFileSync(commandPidFile, "utf8").trim());
    expect(commandPid).toBeGreaterThan(0);
    expect(isAlive(commandPid)).toBe(true);
    // Signal the holder the way a person or a CI timeout would: the process
    // the lock names, which the tests above pin to `run` itself.
    expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
    const signalledAt = Date.now();
    for (let i = 0; i < times; i++) {
      try {
        if (child.exitCode === null) {
          process.kill(Number(lockFile(dir, "pid").trim()), signal);
        }
      } catch {
        // Already gone, which is the exec-mode outcome described above.
      }
      if (i + 1 < times) await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Bounded, because `await done` on its own cannot tell a run that reacted
    // from one that is still waiting out the command it never signalled: a
    // dropped forwarding shows up as this promise not settling for the full
    // 30s, and the test's own timeout fires and names the timeout instead of
    // the wrapper. The manifest's mutation — no TERM forwarding — must fail
    // here, on a claim about elapsed time, and not on the clock running out.
    const settled = await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      scaled(5_000),
      `run did not exit within 5000ms of ${signal}`,
    );
    expect({ shell, times, settled }).toEqual({ shell, times, settled: true });
    const elapsed = Date.now() - signalledAt;
    expect({ shell, withinBudget: elapsed < scaled(5_000) }).toEqual({ shell, withinBudget: true });

    const result = await done;
    // 130/143 are INT/TERM's own conventions, so a caller can tell a signalled
    // run from a command that failed — and the EXIT trap still ran.
    expect({ shell, status: result.status }).toEqual({ shell, status: expectedStatus });
    expect(result.stdout).toContain("released by lane-a");
    expect(existsSync(lockDir(dir))).toBe(false);
    // The heartbeat is reaped, not merely orphaned: nothing may outlive the
    // run, or a later lock refreshes on a pid the test can no longer account for.
    await waitForDead(heartbeatPidOf(result.stdout));
    // The command died with the wrapper. A trap on a foreground child is
    // deferred until that child exits — measured at the full 30s under dash —
    // so the signal has to be forwarded, or this sleep outlives the run. And
    // for INT it has to be forwarded as TERM: a command started as an
    // asynchronous list inherits SIG_IGN for INT and QUIT (POSIX 2.11), so an
    // INT sent to a `sh` command is a no-op and the command outlives the run
    // by the whole 30 seconds — after the lock is already gone.
    await waitForDead(commandPid);
  }

  test(
    "TERM on run exits 143, releases the lock, and takes the command and the heartbeat with it",
    async () => {
      for (const shell of SIGNAL_SHELLS) {
        await signalRun(shell, "SIGTERM", 143);
      }
    },
    scaled(30_000),
  );

  test(
    "INT on run exits 130, releases the lock, and stops the command too",
    async () => {
      for (const shell of SIGNAL_SHELLS) {
        await signalRun(shell, "SIGINT", 130);
      }
    },
    scaled(30_000),
  );

  test(
    "TERM twice on run still releases the lock and reaps the heartbeat",
    async () => {
      for (const shell of SIGNAL_SHELLS) {
        await signalRun(shell, "SIGTERM", 143, 2);
      }
    },
    scaled(30_000),
  );

  test(
    "INT twice on run still releases the lock and reaps the heartbeat",
    async () => {
      for (const shell of SIGNAL_SHELLS) {
        await signalRun(shell, "SIGINT", 130, 2);
      }
    },
    scaled(30_000),
  );

  /**
   * The same two signals again against a command that is still ALIVE when the
   * second one lands, which is where the two shells parted company: bash
   * deferred the second TERM and re-entered forward_signal at exit, after the
   * command had been reaped, so the EXIT trap never ran and the lock stayed on
   * disk with the heartbeat still looping under a dead pid. Measured 6 runs in
   * 6 under /bin/sh before forward_signal ignored both signals; dash never had
   * the fault, which is why this runs under both.
   */
  async function teardownRun(
    shell: string,
    signal: "SIGINT" | "SIGTERM",
    expectedStatus: number,
    times: number,
  ): Promise<void> {
    const dir = scratch();
    // A command that is NOT dead the moment it is signalled: it catches TERM
    // and takes two seconds to tear down, marking the fact. A `run` that
    // killed and exited in the same breath would have handed the lock to the
    // next lane while this was still running — and the commands `run` wraps
    // (a test run, a mutate replay, verify-manifests) all write to the tree.
    const stopped = join(dir, "stopped");
    const { child, done } = startLockIn(
      dir,
      [
        "run",
        "lane-a",
        "--",
        "sh",
        "-c",
        // `exec >/dev/null 2>&1` first: the command must not hold this test's
        // pipe open, or the result below would arrive when the COMMAND
        // finished rather than when `run` did, and the ordering under test
        // would be observed from the wrong end. `wait` (not a foreground
        // sleep) so the trap runs the moment the signal arrives, and the
        // orphan it leaves behind — the sleep, which has outlived its own
        // shell — is the reason the redirect is here as well.
        `exec >/dev/null 2>&1; trap 'sleep 2; echo stopped > "${stopped}"; exit 0' TERM; printf '%s\\n' "$$" > "${join(dir, "command.pid")}"; sleep 30 >/dev/null 2>&1 & wait`,
      ],
      { CF_GATE_HEARTBEAT_SECONDS: "1" },
      shell,
    );
    await waitForContent(join(dir, "command.pid"));
    const commandPid = Number(readFileSync(join(dir, "command.pid"), "utf8").trim());
    expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
    for (let i = 0; i < times; i++) {
      try {
        if (child.exitCode === null) process.kill(child.pid as number, signal);
      } catch {
        // Already gone: nothing left to signal.
      }
      if (i + 1 < times) await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const result = await done;
    expect({ shell, times, status: result.status }).toEqual({
      shell,
      times,
      status: expectedStatus,
    });
    // The ordering, which is the whole claim: the command had finished
    // tearing down by the time the lock went away.
    expect({ shell, stoppedBeforeTheLockWent: existsSync(stopped) }).toEqual({
      shell,
      stoppedBeforeTheLockWent: true,
    });
    expect(existsSync(lockDir(dir))).toBe(false);
    expect(isAlive(commandPid)).toBe(false);
  }

  test("a signalled run holds the lock until the command has actually stopped", async () => {
    // INT and TERM share this path — both traps forward TERM — so both are
    // named: a run that only ever saw TERM here was never tested for the half
    // of its signal handling that a Ctrl-C takes.
    for (const shell of SIGNAL_SHELLS) {
      await teardownRun(shell, "SIGTERM", 143, 1);
      await teardownRun(shell, "SIGINT", 130, 1);
    }
  }, 60_000);

  test("a second signal during the teardown still releases the lock and reaps the heartbeat", async () => {
    for (const shell of SIGNAL_SHELLS) {
      await teardownRun(shell, "SIGTERM", 143, 2);
      await teardownRun(shell, "SIGINT", 130, 2);
    }
  }, 60_000);

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

  test("a command that takes the lock away is stopped, not left running without one", async () => {
    // Both shells: the loop that does the stopping is the one whose deferral
    // and re-entry behaviour differ, so the claim is only made once each shell
    // has been asked to keep it.
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      // The heartbeat refreshes only a lock that still names this run, so a lock
      // that names someone else makes the refresh fail — and a failed refresh is
      // how the loop learns the lock is gone, since the foreground is blocked in
      // `wait` and cannot see it. The command must be stopped there and then: it
      // is running against a lock this run no longer holds, and letting it
      // finish is the failure the heartbeat exists to prevent.
      const completed = join(dir, "completed");
      const commandPidFile = join(dir, "command.pid");
      const replace = [
        'rm -rf "$TMPDIR/cf-gate.lock"',
        'mkdir "$TMPDIR/cf-gate.lock"',
        'printf "lane-c\\n" > "$TMPDIR/cf-gate.lock/owner"',
        `printf "${process.pid}\\n" > "$TMPDIR/cf-gate.lock/pid"`,
        'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/started"',
        'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/beat"',
        `printf '%s\\n' "$$" > "${commandPidFile}"`,
        // `wait`, not a foreground sleep, so the shell answers a TERM at once
        // instead of deferring it for the length of the sleep; the sleep's own
        // stdio is dropped so the orphan it leaves cannot hold this test's pipe.
        "sleep 8 >/dev/null 2>&1 & wait",
        `touch "${completed}"`,
      ].join("; ");
      const result = await runLockAsyncIn(
        dir,
        ["run", "lane-a", "--", "sh", "-c", replace],
        { CF_GATE_HEARTBEAT_SECONDS: "1" },
        shell,
      );
      expect(result.status).not.toBe(0);
      // It says so, and says why the command ended: a 143 on its own is
      // indistinguishable from a caller that signalled the run.
      expect(result.stderr).toContain("the lock was lost while the command ran");
      const commandPid = Number(readFileSync(commandPidFile, "utf8").trim());
      // Stopped, not merely reported on: a command that reaches its own end
      // leaves the marker it wrote on the way out.
      expect({ shell, stopped: isAlive(commandPid) }).toEqual({ shell, stopped: false });
      expect({ shell, completed: existsSync(completed) }).toEqual({ shell, completed: false });
      // The replacement is still the replacement's: this run never deletes a
      // lock it does not hold, however it ends.
      expect(lockFile(dir, "owner").trim()).toBe("lane-c");
      expect(existsSync(lockDir(dir))).toBe(true);
    }
  }, 40_000);

  test("a release waits for a heartbeat refresh that is in flight, not past it", async () => {
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      // The race this closes is between the loop's `rm -rf` of the lock and an
      // in-flight `sh gate-lock.sh heartbeat` grandchild whose `mv` lands on
      // $LOCK/beat in the middle of it. Unforced, it is a 13-in-200 kind of
      // thing under /bin/sh and 18-in-200 under dash — every one a false
      // "release failed — could not remove … Directory not empty", a lock left
      // at the name, and a non-zero exit for a command that succeeded. A test
      // that only ran short runs would therefore be a test that fails one time
      // in fifteen and passes the rest, which is not a test.
      //
      // So the window is pinned open instead. The hook holds ONE refresh
      // between staging its beat and renaming it onto the lock — inside the
      // grandchild, which is the only place the race lives: the old code killed
      // this loop, went straight on to `rm -rf` the lock, and that grandchild
      // then renamed a file into the directory being emptied.
      const marker = join(dir, "paused-before-beat-mv");
      const { child, done } = startLockIn(
        dir,
        ["run", "lane-a", "--", "sleep", "30"],
        { CF_GATE_HEARTBEAT_SECONDS: "1", CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV: marker },
        shell,
      );
      await waitForLock(dir);
      await waitForFile(marker);
      // A refresh is now sitting in the hook with its beat staged. Signalled
      // while it is there, the cleanup has to wait for it: that is the claim.
      expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
      process.kill(child.pid as number, "SIGTERM");

      // Give the run long enough to have released the lock if it were going to.
      // A run that ignores the in-flight refresh removes the lock here, and the
      // test fails on the next line — deterministically, with no reliance on
      // the race happening.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const waited = existsSync(lockDir(dir));

      // Let the refresh finish and the run finish with it, either way: leaving
      // the marker in place would strand a grandchild that keeps touching this
      // TMPDIR after the test has moved on.
      rmSync(marker);
      const result = await done;
      // The whole failure this test exists for, named as one assertion: a
      // "Directory not empty" release failure is a false failure for a command
      // that succeeded, and it leaves a lock behind for the next lane.
      expect({ shell, waited, stderr: result.stderr, status: result.status }).toEqual({
        shell,
        waited: true,
        stderr: "",
        status: 143,
      });
      expect(result.stdout).toContain("released by lane-a");
      expect(existsSync(lockDir(dir))).toBe(false);
      // The loop is a child of the run and the refresh a child of the loop:
      // nothing either of them left behind.
      await waitForDead(heartbeatPidOf(result.stdout));
    }
  }, 60_000);

  test("a second signal while the release is waiting on the loop still releases the lock", async () => {
    // The one-TERM case above parks a heartbeat refresh and sends one signal;
    // the cleanup then blocks in `wait` for the loop that owns it, which is the
    // only window in which a SECOND signal can do damage. It did: run_cleanup
    // reset INT/TERM to their DEFAULT action (`trap - INT TERM EXIT`) before doing
    // anything else, so a TERM arriving there killed the shell outright — exit
    // 143, no "released by", and the lock left at the name with all four of its
    // files and a heartbeat grandchild still refreshing it. Measured on both
    // shells before the fix, and this is the test that holds the order in place.
    //
    // 500ms is not a guess about how long the first signal takes: both answers
    // are safe. If cleanup has started, TERM is already ignored; if the run is
    // still inside forward_signal, TERM was ignored there before the first
    // signal was answered. Either way the second one has nothing to kill.
    for (const shell of SIGNAL_SHELLS) {
      const dir = scratch();
      const marker = join(dir, "paused-before-beat-mv");
      const { child, done } = startLockIn(
        dir,
        ["run", "lane-a", "--", "sleep", "30"],
        { CF_GATE_HEARTBEAT_SECONDS: "1", CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV: marker },
        shell,
      );
      await waitForLock(dir);
      await waitForFile(marker);
      expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
      process.kill(child.pid as number, "SIGTERM");
      // What a CI timeout does: TERM, then TERM again half a second later.
      await new Promise((resolve) => setTimeout(resolve, 500));
      process.kill(child.pid as number, "SIGTERM");
      // …and `survived` is read AFTER that wait, not on the line below the kill.
      // A process told to die needs a moment, and reading it the instant the
      // signal was sent is reading scheduling luck: a run that the second TERM
      // killed would still be alive at that instant and pass this line, and the
      // three assertions that follow — the release line, the lock's absence, the
      // heartbeat's death — are what actually catch it. gate-signals.test.ts
      // reads its `survived` the same way, and for the same reason.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const survived = isAlive(child.pid as number);
      // The lock is still there — the run is inside its cleanup, not gone.
      expect(existsSync(lockDir(dir))).toBe(true);

      rmSync(marker);
      const result = await done;
      // Survived the second signal, released the lock, and said so: the release
      // line is the proof, because a run killed mid-cleanup cannot print it.
      expect({ shell, survived, stderr: result.stderr, status: result.status }).toEqual({
        shell,
        survived: true,
        stderr: "",
        status: 143,
      });
      expect(result.stdout).toContain("released by lane-a");
      expect(existsSync(lockDir(dir))).toBe(false);
      await waitForDead(heartbeatPidOf(result.stdout));
    }
  }, 60_000);

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

  test(
    "a nested run is refused 75, never starts its command, and leaves no lock",
    () => {
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
    },
    scaled(15_000),
  );

  test(
    "passes the command through quoted, and a -- inside it is just an argument",
    () => {
      // Under both shells, because `"$@"` is the shell's own and the two differ:
      // two arguments that contain spaces must arrive as two arguments, and the
      // -- that separates them must be the FIRST one only: read as a separator
      // again, the command would lose both.
      for (const shell of SIGNAL_SHELLS) {
        const dir = scratch();
        const out = join(dir, "args");
        const result = runLockIn(
          dir,
          [
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
          ],
          {},
          15_000,
          shell,
        );
        expect({ shell, status: result.status }).toEqual({ shell, status: 0 });
        expect({ shell, args: readFileSync(out, "utf8").trim().split("\n") }).toEqual({
          shell,
          args: ["--", "a b", "c d"],
        });
      }
    },
    scaled(15_000),
  );

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

    // A word where the separator belongs is a usage error, not a guess. The
    // separator used to be searched for, so everything before it was shifted
    // away in silence: `run lane-a extra -- sh -c … one two` started the
    // command with `two` and said nothing at all.
    const stray = runLockIn(dir, ["run", "lane-a", "extra", "--", "true"]);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain("usage");

    // Nothing was locked on the way to the usage error.
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test(
    "a run signalled between taking the lock and recording it still gives it back",
    async () => {
      const dir = scratch();
      // The window the test hook exists for: the lock is on disk and names this
      // run, but `run` has not yet recorded that it holds it. A signal here used
      // to leave the lock behind with a pid that was about to die — reclaimable
      // by the next lane, in the meantime, and never released by the only process
      // that could.
      const marker = join(dir, "paused-after-acquire");
      const { child, done } = startLockIn(dir, ["run", "lane-a", "--", "sleep", "30"], {
        CF_GATE_TEST_PAUSE_AFTER_ACQUIRE: marker,
      });
      await waitForFile(marker);
      expect(lockFile(dir, "owner").trim()).toBe("lane-a");
      expect(lockFile(dir, "pid").trim()).toBe(String(child.pid));
      process.kill(child.pid as number, "SIGTERM");
      rmSync(marker);

      const result = await done;
      expect(result.status).toBe(143);
      // No command was running under it — the command is started after this
      // window — so nothing else is holding the lock, and `run` is gone.
      expect(existsSync(lockDir(dir))).toBe(false);
    },
    scaled(15_000),
  );

  test("a zero heartbeat interval is refused: a spin is not a heartbeat", () => {
    const dir = scratch();
    // `sleep 0` returns at once, so a zero interval is not a fast heartbeat —
    // it is no sleep at all: a loop forking a shell per iteration to write a
    // beat with the same second-resolution value. Measured over three seconds
    // of a run, 619 events in the lock directory at 0 against 6 at the intended
    // one-second tick.
    const result = runLockIn(dir, ["run", "lane-a", "--", "true"], {
      CF_GATE_HEARTBEAT_SECONDS: "0",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CF_GATE_HEARTBEAT_SECONDS");
    expect(result.stderr).toContain("at least one second");
    // Refused before the acquire, on the same grounds as a non-numeric one.
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

// D188 (lane MH2-gate-lock-slots) — the lock is a per-host semaphore of
// CF_GATE_SLOTS slots. Slot 0 keeps the unsuffixed name, so every test above runs
// unchanged at the default; these are the cases that only exist with more than
// one, and the one that proves a slot's own transients are not slots.
describe("gate-lock.sh CF_GATE_SLOTS", () => {
  /** Slot n's directory: slot 0 is the historical unsuffixed lock. */
  function slotDir(dir: string, n: number): string {
    return n === 0 ? lockDir(dir) : join(dir, `cf-gate.lock.${n}`);
  }

  /** seedLock, for a name of this test's choosing — a slot's name, or one that is not. */
  function seedNamed(
    dir: string,
    name: string,
    holder: { owner?: string; pid?: number; started?: number; beat?: number; worktree?: string },
  ): string {
    const slot = join(dir, name);
    mkdirSync(slot, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(slot, "owner"), `${holder.owner ?? "other-lane"}\n`);
    writeFileSync(join(slot, "started"), `${holder.started ?? now}\n`);
    writeFileSync(join(slot, "pid"), `${holder.pid ?? process.pid}\n`);
    writeFileSync(join(slot, "beat"), `${holder.beat ?? now}\n`);
    // The FIFTH file is written only when a test asks for it, so every seeded
    // slot above is still exactly the four files a pre-MH4 holder left behind —
    // which is the point of one of the tests below.
    if (holder.worktree !== undefined)
      writeFileSync(join(slot, "worktree"), `${holder.worktree}\n`);
    return slot;
  }

  /** seedLock, for a numbered slot instead of slot 0. */
  function seedSlot(
    dir: string,
    n: number,
    holder: { owner?: string; pid?: number; started?: number; beat?: number; worktree?: string },
  ): string {
    return seedNamed(dir, n === 0 ? "cf-gate.lock" : `cf-gate.lock.${n}`, holder);
  }

  function slotFile(slot: string, name: string): string {
    return readFileSync(join(slot, name), "utf8");
  }

  test("a busy acquire leaves nothing inside the holder's lock, however often it retries", () => {
    // acquire always tries the create first, and `mv cand lock` onto an existing
    // directory nests the candidate INSIDE it and exits 0. Each refused attempt
    // must take its own candidate back out, or a lane retrying on 75 grows a
    // directory per retry in someone else's lock — one per busy slot per try.
    const dir = scratch();
    const holders = [0, 1].map((n) => seedSlot(dir, n, { owner: `holder-${n}` }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const busy = runLockIn(dir, ["acquire", "lane-late"], {
        CF_GATE_CALLER_PID: String(424242 + attempt),
        CF_GATE_SLOTS: "2",
      });
      expect(busy.status).toBe(75);
    }
    for (const [n, slot] of holders.entries()) {
      expect(readdirSync(slot).sort()).toEqual(["beat", "owner", "pid", "started"]);
      expect(slotFile(slot, "owner").trim()).toBe(`holder-${n}`);
    }
  });

  test("a slot count that is not a count, or is zero, is refused before any lock is taken", () => {
    // Validated exactly like CF_GATE_STALE_SECONDS, on the same grounds: a value
    // that cannot be a count is a broken invocation whichever subcommand it
    // arrived on, and it is reported as itself.
    const dir = scratch();
    const nonNumeric = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "many",
    });
    expect(nonNumeric.status).toBe(2);
    expect(nonNumeric.stderr).toContain("CF_GATE_SLOTS");
    expect(existsSync(lockDir(dir))).toBe(false);

    // Zero is not a host with no gates; it is a host where every caller is
    // silently unprotected, so it is refused like an interval of zero seconds.
    const none = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "0",
    });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("at least one slot");
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test("a slot count past the ceiling is a broken invocation, and is never reported as busy", () => {
    const dir = scratch();
    // The ceiling is 64, and a value over it is refused as what it is: a
    // misconfiguration. Busy is a claim about the host — something else holds
    // something — and a caller told busy sleeps and retries, so a seat with a
    // count of 99999999999999999999 in its environment would retry an idle host
    // for ever and never find out why.
    //
    // The last two are the values that motivated the ceiling, and the reason the
    // check is made on DIGITS rather than by arithmetic: a shell's `[` cannot
    // compare 99999999999999999999 with 64 (it answers false and complains), so
    // a range test on that value does not bound it — it falls through into the
    // slot loop, and an idle host is reported busy.
    for (const tooMany of ["65", "065", "99999999999999999999", "123456789012345678901234567890"]) {
      const refused = runLockIn(dir, ["acquire", "lane-a"], {
        CF_GATE_CALLER_PID: "424242",
        CF_GATE_SLOTS: tooMany,
      });
      expect({ tooMany, status: refused.status, stderr: refused.stderr }).toEqual({
        tooMany,
        status: 2,
        // No busy line and no shell arithmetic diagnostic: both of those are
        // answers this host must not give. And the value is named AS GIVEN —
        // the caller's environment holds `065`, and a message about `65` sends
        // it looking for a spelling it never set.
        stderr: `gate-lock: CF_GATE_SLOTS must be at most 64 slots: ${tooMany}\n`,
      });
      // Refused before the acquire, like every other invalid count.
      expect(existsSync(lockDir(dir))).toBe(false);
    }

    // The boundary itself is a legal host, and takes its slot like any other.
    const ceiling = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "64",
    });
    expect(ceiling.status).toBe(0);
    expect(ceiling.stdout).toContain("acquired by lane-a");
    expect(slotFile(lockDir(dir), "pid").trim()).toBe("424242");

    // Leading zeros are a spelling, not a count, and are stripped before the
    // ceiling is judged: `064` is sixty-four slots and must be accepted, where
    // the digit-length test alone would read it as the three-digit value it
    // refuses. That it is accepted AS sixty-four and not merely as "some
    // number" is the slot 1 below: slot 0 is held by a live holder here, so a
    // caller that read this as one slot would answer busy and a caller that read
    // it as any count above one takes the next slot.
    const padded = scratch();
    seedSlot(padded, 0, { owner: "lane-live", pid: process.pid });
    const paddedCount = runLockIn(padded, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "064",
    });
    expect(paddedCount.status).toBe(0);
    expect(slotFile(slotDir(padded, 1), "pid").trim()).toBe("424242");
    expect(slotFile(slotDir(padded, 0), "owner").trim()).toBe("lane-live");

    // And zero, however it is spelled, is the "at least one slot" refusal rather
    // than an empty string no `[` can compare — named as given.
    for (const none of ["0", "00"]) {
      const refused = runLockIn(scratch(), ["acquire", "lane-a"], {
        CF_GATE_CALLER_PID: "424242",
        CF_GATE_SLOTS: none,
      });
      expect({ none, status: refused.status, stderr: refused.stderr }).toEqual({
        none,
        status: 2,
        stderr: `gate-lock: CF_GATE_SLOTS must be at least one slot: ${none}\n`,
      });
    }
  });

  test(
    "three runs hold three slots at once, and a fourth is busy",
    async () => {
      const dir = scratch();
      // Each command waits for a file of its own, so all three are provably parked
      // at once — three locks on the host at the same moment, not three runs that
      // happened to overlap.
      //
      // A cwd each, under the one TMPDIR. Three lanes in ONE checkout is three
      // gates against one tree, which is exactly what the lock exists to prevent:
      // `verify-manifests` mutates the tree it verifies, so two of them at once
      // write manifests the other is reading. Before that rule existed this test
      // ran all three from the vitest process's own cwd and was three gates in one
      // worktree; the host lock did not notice and the row review caught it. Three
      // plain scratch cwds are three worktrees that differ under `pwd -P`, which is
      // the branch a directory outside any repository takes.
      const lanes = ["lane-a", "lane-b", "lane-c"];
      const cwds = lanes.map(() => scratch());
      const started = lanes.map((lane, n) =>
        startLockIn(
          dir,
          ["run", lane, "--", "sh", "-c", `while [ ! -f "$TMPDIR/go-${lane}" ]; do sleep 1; done`],
          { CF_GATE_SLOTS: "3" },
          "sh",
          cwds[n],
        ),
      );
      try {
        for (let n = 0; n < lanes.length; n++) {
          await waitForFile(join(slotDir(dir, n), "pid"));
        }
        // WHICH run wins which slot is a race — three acquirers are three
        // concurrent mkdirs, and spawn order decides nothing — so the claim is
        // about the set of holders and about each slot naming the pid of the run
        // that owns it, not about which lane landed where.
        const owners = lanes.map((_, n) => slotFile(slotDir(dir, n), "owner").trim());
        expect([...owners].sort()).toEqual([...lanes].sort());
        for (let n = 0; n < lanes.length; n++) {
          const holder = started[lanes.indexOf(owners[n])];
          // The holder is the run itself, exactly as at SLOTS=1.
          expect(slotFile(slotDir(dir, n), "pid").trim()).toBe(String(holder.child.pid));
          // …and it recorded the worktree it is standing in, which is the one
          // thing that lets the next acquirer see it. The set is the set of cwds,
          // matched as a set because the slot-to-run mapping above is a race: if
          // these were not three different worktrees the whole host would be
          // answering about one tree and this test would be passing for the wrong
          // reason.
          expect(slotFile(slotDir(dir, n), "worktree").trim()).toBe(
            plainWorktree(cwds[lanes.indexOf(owners[n])]),
          );
        }
        expect(lanes.map((_, n) => slotFile(slotDir(dir, n), "worktree").trim()).sort()).toEqual(
          cwds.map(plainWorktree).sort(),
        );

        // A fourth caller, with the host's full three slots busy.
        const fourth = runLockIn(
          dir,
          ["run", "lane-d", "--", "true"],
          { CF_GATE_SLOTS: "3" },
          15_000,
          "sh",
          scratch(),
        );
        expect(fourth.status).toBe(75);
        expect(fourth.stderr).toContain("busy");
        // It names the first holder, which is the one a retrying caller waits for
        // — and the first slot is whichever run happened to win it.
        expect(fourth.stderr).toContain(slotFile(slotDir(dir, 0), "owner").trim());
        // Refused, not damaging: all three locks are intact and no fourth appeared.
        expect(existsSync(join(dir, "cf-gate.lock.3"))).toBe(false);
        for (let n = 0; n < lanes.length; n++) {
          expect(slotFile(slotDir(dir, n), "owner").trim()).toBe(owners[n]);
        }

        for (const lane of lanes) writeFileSync(join(dir, `go-${lane}`), "");
        for (const run of started) {
          const result = await run.done;
          expect(result.status).toBe(0);
        }
        // Each holder gave back its own slot and nobody else's.
        for (let n = 0; n < lanes.length; n++) {
          expect(existsSync(slotDir(dir, n))).toBe(false);
        }
      } finally {
        // A failed assertion must not leave three runs parked on files in a TMPDIR
        // the afterEach has already removed — they would loop forever with nobody
        // left to release their slots. Releasing again is harmless: the go files
        // are writes, and `done` is one promise however many callers await it.
        for (const lane of lanes) writeFileSync(join(dir, `go-${lane}`), "");
        await Promise.all(started.map((run) => run.done));
      }
    },
    scaled(30_000),
  );

  test("a dead holder's slot is reclaimed, and the live slot beside it is left alone", () => {
    const dir = scratch();
    // Slot 0 is held by a live holder, so the acquirer must move on; slot 1's
    // holder is a reaped pid, so that slot is reclaimed. The point of both facts
    // is the same claim: the judgement is per slot.
    seedSlot(dir, 0, { owner: "lane-live", pid: process.pid });
    const dead = reapedPid();
    seedSlot(dir, 1, { owner: "lane-dead", pid: dead });

    const result = runLockIn(dir, ["acquire", "lane-new"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "3",
    });
    expect(result.status).toBe(0);
    // It says which slot it judged and why, before it takes it.
    expect(result.stdout).toContain("reclaiming");
    expect(result.stdout).toContain("not alive");
    expect(result.stdout).toContain("cf-gate.lock.1");
    // The dead holder's slot is the acquirer's now…
    expect(slotFile(slotDir(dir, 1), "owner").trim()).toBe("lane-new");
    expect(slotFile(slotDir(dir, 1), "pid").trim()).toBe("424242");
    // …and the live holder's slot is untouched, still naming its own holder.
    expect(slotFile(slotDir(dir, 0), "owner").trim()).toBe("lane-live");
    expect(slotFile(slotDir(dir, 0), "pid").trim()).toBe(String(process.pid));
    // The third slot was free and was not needed: slots are tried in order.
    expect(existsSync(slotDir(dir, 2))).toBe(false);
  });

  test("status lists every slot that exists, and no transient", () => {
    const dir = scratch();
    seedSlot(dir, 0, { owner: "lane-a", pid: process.pid });
    seedSlot(dir, 1, { owner: "lane-b", pid: process.pid });
    // Four transients, planted as real directories holding all four lock files,
    // because that is what a paused creator, a paused reclaim and an interrupted
    // holder actually leave behind. Two of them start with a DIGIT after the
    // base name, so a `cf-gate.lock.[0-9]*` glob would list them as slots.
    const transients = [
      "cf-gate.lock.cand.999",
      "cf-gate.lock.reclaim.999.x",
      "cf-gate.lock.1.cand.999",
      "cf-gate.lock.1.reclaim.999.x",
    ];
    for (const name of transients) {
      const dirPath = join(dir, name);
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "owner"), "lane-transient\n");
      writeFileSync(join(dirPath, "pid"), "999\n");
      writeFileSync(join(dirPath, "started"), "1\n");
      writeFileSync(join(dirPath, "beat"), "1\n");
    }

    // Deliberately at the DEFAULT slot count: a status that only looked at slot 0
    // would report a host with one holder on it, and one that globbed would
    // report four more.
    const result = runLockIn(dir, ["status"], { CF_GATE_SLOTS: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${slotDir(dir, 0)} held by lane-a`);
    expect(result.stdout).toContain(`${slotDir(dir, 1)} held by lane-b`);
    for (const name of transients) {
      expect({ name, listed: result.stdout.includes(`${join(dir, name)} `) }).toEqual({
        name,
        listed: false,
      });
    }
    // Nothing was touched on the way past: a status is a read.
    expect(existsSync(join(dir, "cf-gate.lock.1.cand.999"))).toBe(true);
  });

  test("release, verify and heartbeat act on the caller's own slot only", () => {
    const dir = scratch();
    seedSlot(dir, 0, { owner: "lane-other", pid: 515151, beat: 1000 });
    seedSlot(dir, 1, { owner: "lane-a", pid: 424242, beat: 1000 });

    // verify: each holder finds its own slot and is refused on the other's.
    const mine = runLockIn(dir, ["verify", "lane-a"], { CF_GATE_CALLER_PID: "424242" });
    expect(mine.status).toBe(0);
    const theirs = runLockIn(dir, ["verify", "lane-other"], {
      CF_GATE_CALLER_PID: "515151",
    });
    expect(theirs.status).toBe(0);
    // A caller whose pid names no slot at all cannot verify through another
    // holder's lock, whichever slot that lock is in.
    const stranger = runLockIn(dir, ["verify", "lane-other"], {
      CF_GATE_CALLER_PID: "616161",
    });
    expect(stranger.status).not.toBe(0);
    expect(stranger.stderr).toContain("verify failed");

    // heartbeat takes no lane, so it scans by pid: the beat that moves is the
    // caller's own slot's, and the other holder's is left exactly as it was.
    const beat = runLockIn(dir, ["heartbeat"], { CF_GATE_CALLER_PID: "424242" });
    expect(beat.status).toBe(0);
    expect(Number(slotFile(slotDir(dir, 1), "beat"))).toBeGreaterThan(1000);
    expect(slotFile(slotDir(dir, 0), "beat").trim()).toBe("1000");

    // release removes the caller's slot and names it, leaving the other holder's.
    const released = runLockIn(dir, ["release", "lane-a"], { CF_GATE_CALLER_PID: "424242" });
    expect(released.status).toBe(0);
    expect(released.stdout).toContain("released by lane-a");
    expect(released.stdout).toContain(slotDir(dir, 1));
    expect(existsSync(slotDir(dir, 1))).toBe(false);
    expect(existsSync(slotDir(dir, 0))).toBe(true);
    expect(slotFile(slotDir(dir, 0), "pid").trim()).toBe("515151");

    // And a release from a pid that names no slot is refused, not satisfied by
    // another holder's lock being there to delete.
    const refused = runLockIn(dir, ["release", "lane-other"], {
      CF_GATE_CALLER_PID: "717171",
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("release refused");
    expect(existsSync(slotDir(dir, 0))).toBe(true);
  });

  test("a SLOTS=1 caller never sees or touches a numbered slot", () => {
    // The disagreement this refuses to have: a seat that believes in one slot
    // while the host has three. Slot 0 is free here, so the single-slot caller
    // takes it — and a lock in slot 1 must not make it answer busy, because
    // status would then be the only place that lock is visible.
    const dir = scratch();
    seedSlot(dir, 1, { owner: "lane-b", pid: process.pid });
    const taken = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "1",
    });
    expect(taken.status).toBe(0);
    expect(slotFile(lockDir(dir), "owner").trim()).toBe("lane-a");
    expect(slotFile(slotDir(dir, 1), "owner").trim()).toBe("lane-b");

    // Its release drops slot 0 and only slot 0.
    const released = runLockIn(dir, ["release", "lane-a"], { CF_GATE_CALLER_PID: "424242" });
    expect(released.status).toBe(0);
    expect(existsSync(lockDir(dir))).toBe(false);
    expect(existsSync(slotDir(dir, 1))).toBe(true);
  });

  // ONE GATE PER WORKTREE, even at SLOTS>1. The lock is per HOST and not per
  // checkout, and at SLOTS>1 a second gate in the same checkout is simply handed
  // the next slot and both proceed — while `verify-manifests`, one of the two
  // steps the lock exists to serialise, MUTATES the tree it is verifying. So two
  // gates beside each other in one worktree each write manifests the other is
  // reading. Until now that rule was prose in the script's header and nothing
  // else; these tests are the rule.
  test("a second acquire in the same worktree is refused, and it is the WORKTREE that is compared", () => {
    const dir = scratch();
    const worktree = gitScratch();
    // The holder acquires for real, so the `worktree` file in its slot is
    // written by try_create rather than by this test, and it names the
    // repository ROOT — the worktree, not the directory the lane happened to be
    // standing in.
    const held = acquireFrom(dir, worktree, ["acquire", "lane-holder"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_SLOTS: "2",
    });
    expect(held.status).toBe(0);
    expect(slotFile(slotDir(dir, 0), "worktree").trim()).toBe(realpathSync(worktree));

    // The second caller stands in a SUBDIRECTORY of that same worktree, which is
    // the case a comparison of directories would wave through: the directories
    // differ, the worktree does not.
    const nested = join(worktree, "packages");
    mkdirSync(nested);
    const refused = acquireFrom(dir, nested, ["acquire", "lane-late"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "2",
    });
    expect(refused.status).toBe(75);
    expect(refused.stderr).toContain("same worktree");
    // It names the holder it yielded to, the slot that holder is in, and the
    // worktree they share: `busy` on its own sends a caller looking for a host
    // with no room left rather than for another gate in its own checkout.
    expect(refused.stderr).toContain("lane-holder");
    expect(refused.stderr).toContain(slotDir(dir, 0));
    expect(refused.stderr).toContain(realpathSync(worktree));

    // Its own slot is gone again. It won one and gave it back, rather than
    // holding a slot it is not using under a beat nothing refreshes.
    expect(existsSync(slotDir(dir, 1))).toBe(false);
    // And the holder's lock is exactly as it was — its six files, none of them
    // the refused acquirer's. `project` is the sixth: the basename of the
    // repository the holder was standing in, which is what `status` prints so a
    // slot held by another project in a shared pool reads as one.
    expect(readdirSync(slotDir(dir, 0)).sort()).toEqual([
      "beat",
      "owner",
      "pid",
      "project",
      "started",
      "worktree",
    ]);
    expect(slotFile(slotDir(dir, 0), "pid").trim()).toBe(String(process.pid));
  });

  test("two acquires in two worktrees both succeed, and each records its own", () => {
    // The other branch of the identity, and the reason the rule is not a
    // "one gate per host" rule wearing a worktree's name: these two share a lock
    // parent and are in two plain directories, which are two worktrees.
    const dir = scratch();
    const first = scratch();
    const second = scratch();
    // The FIRST caller records a pid that is really alive — this test process —
    // because it has to still be holding slot 0 when the second one arrives, or
    // the second reclaims it as a dead pid and the slots below say nothing about
    // worktrees at all. The second records a dead one on purpose: nothing judges
    // it, because it wins a free slot and returns.
    const one = acquireFrom(dir, first, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_SLOTS: "2",
    });
    const two = acquireFrom(dir, second, ["acquire", "lane-b"], {
      CF_GATE_CALLER_PID: "515151",
      CF_GATE_SLOTS: "2",
    });
    expect(one.status).toBe(0);
    expect(two.status).toBe(0);
    // One slot each, which is what the second slot is FOR.
    expect(slotFile(slotDir(dir, 0), "owner").trim()).toBe("lane-a");
    expect(slotFile(slotDir(dir, 1), "owner").trim()).toBe("lane-b");
    // Neither recorded the other's worktree: outside any repository the
    // identity is `pwd -P`, and these two paths differ.
    expect(slotFile(slotDir(dir, 0), "worktree").trim()).toBe(plainWorktree(first));
    expect(slotFile(slotDir(dir, 1), "worktree").trim()).toBe(plainWorktree(second));
  });

  test("a live same-worktree holder in a HIGHER slot blocks too", () => {
    // ANY OTHER slot, not only a lower one. Yielding only to a lower slot looks
    // equivalent and is not: a third holder releasing slot 0 between the two
    // acquires leaves the later acquirer below the earlier one, after the
    // earlier one has already checked and found nothing above it. Two gates then
    // run in one worktree and the rule is enforced nowhere.
    const dir = scratch();
    const worktree = scratch();
    // Slot 1 is held, live and fresh, in this worktree, while slot 0 is free —
    // so the slot loop takes slot 0 and never looks at slot 1 at all, and the
    // only thing that can refuse this acquire is the worktree check.
    const holder = seedSlot(dir, 1, {
      owner: "lane-holder",
      pid: process.pid,
      worktree: plainWorktree(worktree),
    });
    const refused = acquireFrom(dir, worktree, ["acquire", "lane-late"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "2",
    });
    expect(refused.status).toBe(75);
    expect(refused.stderr).toContain("same worktree");
    expect(refused.stderr).toContain("lane-holder");
    expect(refused.stderr).toContain(holder);
    // The slot it had won went back, and the holder above it is untouched.
    expect(existsSync(lockDir(dir))).toBe(false);
    expect(slotFile(holder, "owner").trim()).toBe("lane-holder");
    expect(slotFile(holder, "pid").trim()).toBe(String(process.pid));
  });

  test("a same-worktree holder that is dead or stale does not block", () => {
    // The judgement is the slot loop's own — the pid alive AND the beat not
    // stale — and nothing stricter than it. A holder the loop would have
    // reclaimed is not running any more, and refusing on one would leave a
    // worktree nobody is gating unable to gate itself for as long as the
    // abandoned lock sits in the lock parent.
    const worktree = scratch();
    const staleBeat = Math.floor(Date.now() / 1000) - 700;
    for (const dead of [
      { why: "a dead pid", holder: { owner: "lane-dead", pid: reapedPid() } },
      { why: "a stale beat", holder: { owner: "lane-stale", pid: process.pid, beat: staleBeat } },
    ]) {
      const dir = scratch();
      seedSlot(dir, 0, { ...dead.holder, worktree: plainWorktree(worktree) });
      const taken = acquireFrom(dir, worktree, ["acquire", "lane-new"], {
        CF_GATE_CALLER_PID: "424242",
        CF_GATE_SLOTS: "2",
      });
      expect({ why: dead.why, status: taken.status }).toEqual({ why: dead.why, status: 0 });
      // The corpse is reclaimed on the way, and the slot is this caller's.
      expect(slotFile(lockDir(dir), "owner").trim()).toBe("lane-new");
    }
  });

  test("a same-worktree holder that is dead or stale in ANOTHER slot does not block, and is left where it is", () => {
    // The liveness filter itself, and it needs the corpse somewhere the slot
    // loop will NOT walk over. Seeded at slot 0 — as the test above does — the
    // loop reclaims slot 0 before try_create wins, and by the time
    // worktree_holder scans, the only slot left is the acquirer's own, which the
    // scan skips by path. Every liveness line in worktree_holder can be deleted
    // and that test stays green: it was measuring the reclaim path, not the
    // filter. (Measured: the mutation read `survived` before this test existed.)
    //
    // So the corpse goes in SLOT 1, which is a slot the loop never looks at
    // because it wins the free slot 0 first. Nothing is reclaimed, nothing is
    // judged, and the only thing that can answer this acquire is the pair of
    // filters: pid alive AND beat not stale, the slot loop's own judgement and
    // nothing stricter. Over-blocking is its own bug — a crashed holder's
    // abandoned lock must not lock a worktree nobody is gating out of gating
    // itself.
    const worktree = scratch();
    const staleBeat = Math.floor(Date.now() / 1000) - 700;
    for (const dead of [
      { why: "a dead pid", owner: "lane-dead", holder: { pid: reapedPid() } },
      { why: "a stale beat", owner: "lane-stale", holder: { pid: process.pid, beat: staleBeat } },
    ]) {
      const dir = scratch();
      const corpse = seedSlot(dir, 1, {
        owner: dead.owner,
        ...dead.holder,
        worktree: plainWorktree(worktree),
      });
      // From the seeded worktree, or the seed's worktree file matches nothing
      // and the case passes for the wrong reason.
      const taken = acquireFrom(dir, worktree, ["acquire", "lane-new"], {
        CF_GATE_CALLER_PID: "424242",
        CF_GATE_SLOTS: "2",
      });
      expect({ why: dead.why, status: taken.status }).toEqual({ why: dead.why, status: 0 });
      // It took the free slot 0, which is all the loop had to do.
      expect(slotFile(lockDir(dir), "owner").trim()).toBe("lane-new");
      // The corpse is STILL there, untouched: worktree_holder reads slots, it
      // never reclaims them. Reclaiming is the loop's job and it never saw this
      // one, which is also what "not reclaiming" in the output says.
      expect(existsSync(corpse)).toBe(true);
      expect(slotFile(corpse, "owner").trim()).toBe(dead.owner);
      expect(taken.stdout).not.toContain("reclaiming");
    }
  });

  test(
    "a same-worktree refusal that has lost its own slot leaves the replacement alone",
    async () => {
      // `rm -rf "$LOCK"` is a statement about the NAME, and by the time a refused
      // acquire gives its slot back the name may not be the one it created. The
      // window is real, not theoretical: MH5's acquire window is gate.sh being
      // TERMed while the acquire child carries on, so the recorded caller pid is
      // gone mid-acquire and the next contender judges the slot reclaimable on
      // its first pass. The refused acquire then deletes the replacement — a lock
      // it never held and never named, belonging to a gate that is running now.
      //
      // So the give-back re-reads owner and pid and removes only while both are
      // still this invocation's, the contract release already uses. Driving it
      // needs the scan and the removal parked apart from each other, which
      // CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM is for: the two are
      // microseconds apart in production, and a test that raced them would be
      // racing luck.
      const dir = scratch();
      const worktree = scratch();
      // A live same-worktree holder in slot 0, so this acquirer cannot take slot
      // 0, wins slot 1, and is then refused — the only path that reaches a
      // give-back at all.
      const holder = seedSlot(dir, 0, {
        owner: "lane-holder",
        pid: process.pid,
        worktree: plainWorktree(worktree),
      });
      const hook = join(dir, "paused-before-same-worktree-rm");
      const { done } = startLockIn(
        dir,
        ["acquire", "lane-late"],
        {
          CF_GATE_CALLER_PID: "424242",
          CF_GATE_SLOTS: "2",
          CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM: hook,
        },
        "sh",
        worktree,
      );
      try {
        // Parked between the scan and the give-back, holding slot 1.
        await waitForFile(hook);
        expect(existsSync(slotDir(dir, 1))).toBe(true);
        // The name is taken over while it waits: the slot is removed and a
        // contender's lock, with another owner and another pid, is seeded there.
        rmSync(slotDir(dir, 1), { recursive: true, force: true });
        const replacement = seedSlot(dir, 1, {
          owner: "lane-replacement",
          pid: process.pid,
          worktree: plainWorktree(worktree),
        });
        rmSync(hook, { force: true });

        const result = await done;
        // Still the same refusal: the guard changes what is removed, not the
        // answer the caller gets.
        expect(result.status).toBe(75);
        expect(result.stderr).toContain("same worktree");
        // The replacement is intact — both halves of the identity disagree with
        // this invocation's, and the give-back removed nothing.
        expect(slotFile(replacement, "owner").trim()).toBe("lane-replacement");
        expect(slotFile(replacement, "pid").trim()).toBe(String(process.pid));
        // And the holder it yielded to in the first place never moved.
        expect(slotFile(holder, "owner").trim()).toBe("lane-holder");
      } finally {
        // A failed assertion must not leave the child parked on a hook file in a
        // TMPDIR the afterEach has already removed: it would sleep forever with
        // nobody left to release its slot. Removing the file releases it, and
        // awaiting `done` is safe however many callers await it.
        rmSync(hook, { force: true });
        await done;
      }
    },
    scaled(30_000),
  );

  test("a holder with no worktree file never blocks: it never claimed one", () => {
    // Compatibility, and not optional: locks outlive the script that wrote
    // them. A slot taken before this rule existed carries four files and no
    // worktree, and a check that read that empty answer as "the same worktree"
    // would block every acquire on that host against a lock that never claimed
    // a worktree at all — the seeded slots in this file included.
    const dir = scratch();
    const holder = seedSlot(dir, 0, { owner: "lane-old", pid: process.pid });
    expect(readdirSync(holder).sort()).toEqual(["beat", "owner", "pid", "started"]);
    const taken = runLockIn(dir, ["acquire", "lane-new"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOTS: "2",
    });
    // Slot 0 is held live, so this caller is answered at slot 1 — which it only
    // ever reaches because the four-file holder in slot 0 did not block it.
    expect(taken.status).toBe(0);
    expect(slotFile(slotDir(dir, 1), "owner").trim()).toBe("lane-new");
    expect(slotFile(holder, "owner").trim()).toBe("lane-old");
  });

  test("a same-worktree refusal records no slot in CF_GATE_SLOT_OUT", () => {
    // The pin is what the caller's heartbeat, verify and release are handed, and
    // what a cleanup fallback reads when a gate dies without releasing. A slot
    // given back on a same-worktree refusal must never reach that file: a pin to
    // a slot that no longer exists is a holder that verifies a lock nobody holds
    // and releases whatever has taken the name since. So the check runs BEFORE
    // the pin is written, and a caller answered 75 here has no pin at all.
    const control = scratch();
    const controlPin = join(scratch(), "slot-out-control");
    // The control first, so the refusal below is about ORDER and not about a
    // variable nothing reads: on a host with no same-worktree holder, the pin is
    // written and holds the slot that was taken.
    const allowed = runLockIn(control, ["acquire", "lane-elsewhere"], {
      CF_GATE_CALLER_PID: "424242",
      CF_GATE_SLOT_OUT: controlPin,
    });
    expect(allowed.status).toBe(0);
    expect(readFileSync(controlPin, "utf8").trim()).toBe(lockDir(control));

    const dir = scratch();
    const worktree = scratch();
    seedSlot(dir, 0, {
      owner: "lane-holder",
      pid: process.pid,
      worktree: plainWorktree(worktree),
    });
    const pin = join(scratch(), "slot-out-refused");
    const refused = acquireFrom(dir, worktree, ["acquire", "lane-late"], {
      CF_GATE_CALLER_PID: "515151",
      CF_GATE_SLOTS: "2",
      CF_GATE_SLOT_OUT: pin,
    });
    expect(refused.status).toBe(75);
    expect(refused.stderr).toContain("same worktree");
    expect(existsSync(pin)).toBe(false);
    // Nothing for a pin to name even if one had been written.
    expect(existsSync(slotDir(dir, 1))).toBe(false);
    expect(slotFile(lockDir(dir), "owner").trim()).toBe("lane-holder");
  });
});

// The lock parent is ${TMPDIR:-/tmp}, and /tmp is 1777 — so at SLOTS>1 the set of
// directories that LOOK like a caller's own slot is a set somebody else can write
// to. Two filters and one pin close that, and each is held in place by its own
// test below:
//
//   canonical  a slot is `cf-gate.lock` or `cf-gate.lock.<n>` for 1 <= n <= 64.
//              `.0`, `.007` and `.64` are not slot names — and neither is a slot's
//              own `.cand.` / `.reclaim.` transient, which the earlier round
//              already refused;
//   provenance a slot must be a directory this user owns, and NOT a symlink
//              (`find` on a symlink start point reports the LINK's owner, so a
//              symlink into another user's tree passes a uid test);
//   the pin    a holder that came from an acquire is TOLD which slot it took and
//              acts on that one path, never on a scan — so a planted directory
//              cannot answer on its behalf however it is named.
describe("gate-lock.sh slots: what a caller will act on", () => {
  /** Slot n's directory: slot 0 is the historical unsuffixed lock. */
  function slotDir(dir: string, n: number): string {
    return n === 0 ? join(dir, "cf-gate.lock") : join(dir, `cf-gate.lock.${n}`);
  }

  /** A lock directory under a name of this test's choosing. */
  function seedNamed(
    dir: string,
    name: string,
    holder: { owner?: string; pid?: number; started?: number; beat?: number },
  ): string {
    const slot = join(dir, name);
    mkdirSync(slot, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(slot, "owner"), `${holder.owner ?? "other-lane"}\n`);
    writeFileSync(join(slot, "started"), `${holder.started ?? now}\n`);
    writeFileSync(join(slot, "pid"), `${holder.pid ?? process.pid}\n`);
    writeFileSync(join(slot, "beat"), `${holder.beat ?? now}\n`);
    return slot;
  }

  /** seedNamed, for slot n. */
  function seedSlot(
    dir: string,
    n: number,
    holder: { owner?: string; pid?: number; started?: number; beat?: number },
  ): string {
    return seedNamed(dir, n === 0 ? "cf-gate.lock" : `cf-gate.lock.${n}`, holder);
  }

  function fileIn(slot: string, name: string): string {
    return readFileSync(join(slot, name), "utf8").trim();
  }

  /**
   * A uid that is definitely not ours: CF_GATE_TEST_EXPECT_UID overrides the uid
   * a slot must be owned by, and a test that judged its own planted slots by an
   * unknown uid would prove nothing. `nobody` where this host runs as root (0
   * being the wrong answer there), root everywhere else.
   */
  const notOurUid = process.getuid?.() === 0 ? 65534 : 0;

  test("a planted slot name that is not canonical is invisible to status and to an unpinned caller", () => {
    const dir = scratch();
    // Two names that look like slots and are not: `.0` is not slot 0 (that is the
    // unsuffixed name) and `.007` is not slot 7. Both carry the REAL holder's
    // owner and pid, because a forgery that did not match would never get far —
    // the point is that the name alone is what stops it. Both sort before slot 1,
    // which is what a scan takes first.
    const planted0 = seedNamed(dir, "cf-gate.lock.0", {
      owner: "lane-a",
      pid: process.pid,
      beat: 1000,
    });
    const planted007 = seedNamed(dir, "cf-gate.lock.007", {
      owner: "lane-a",
      pid: process.pid,
      beat: 1000,
    });
    const mine = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });

    // Deliberately unpinned — CF_GATE_CALLER_PID only, which is what every caller
    // that did not come from an acquire looks like — and at the default slot
    // count, so the only thing that can surface a numbered path is the scan's own
    // filters.
    const status = runLockIn(dir, ["status"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`${mine} held by lane-a`);
    for (const planted of [planted0, planted007]) {
      expect({ planted, listed: status.stdout.includes(`${planted} `) }).toEqual({
        planted,
        listed: false,
      });
    }

    // An unpinned heartbeat refreshes the real slot: with the planted names read
    // as slots, the scan takes `.0` (it sorts first), its beat moves instead and
    // the holder's own lock goes stale.
    const beat = runLockIn(dir, ["heartbeat"], { CF_GATE_CALLER_PID: String(process.pid) });
    expect(beat.status).toBe(0);
    expect(Number(fileIn(mine, "beat"))).toBeGreaterThan(1000);
    expect(fileIn(planted0, "beat")).toBe("1000");
    expect(fileIn(planted007, "beat")).toBe("1000");

    // And an unpinned verify answers about the real slot. It would pass either way
    // — the planted names carry the same owner and pid — so it is the beat above
    // that is the claim about which slot was chosen.
    const verify = runLockIn(dir, ["verify", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(verify.status).toBe(0);
    // Nothing was removed or rewritten on the way past.
    for (const planted of [planted0, planted007]) expect(existsSync(planted)).toBe(true);
  });

  test("a symlinked slot is invisible to status and to an unpinned caller", () => {
    const dir = scratch();
    // A symlink AT a canonical slot name, pointing at a directory this user owns
    // and that holds a lock nobody wrote — the cheapest forgery there is, because
    // `find` on a symlink start point reports the LINK's owner and never looks at
    // what it points at. The symlink test has to come first for that reason.
    const behind = seedNamed(dir, "not-a-slot", { owner: "lane-a", pid: process.pid, beat: 1000 });
    const link = join(dir, "cf-gate.lock.1");
    symlinkSync(behind, link);
    const real = seedSlot(dir, 2, { owner: "lane-a", pid: process.pid, beat: 1000 });

    const status = runLockIn(dir, ["status"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`${real} held by lane-a`);
    expect(status.stdout).not.toContain(`${link} `);

    const beat = runLockIn(dir, ["heartbeat"], { CF_GATE_CALLER_PID: String(process.pid) });
    expect(beat.status).toBe(0);
    expect(Number(fileIn(real, "beat"))).toBeGreaterThan(1000);
    // The directory behind the link is not a lock and was not touched by it.
    expect(fileIn(behind, "beat")).toBe("1000");
  });

  test("a slot that is not owned by the expected uid is invisible", () => {
    const dir = scratch();
    const one = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });
    const two = seedSlot(dir, 2, { owner: "lane-b", pid: process.pid, beat: 1000 });
    // Both slots are this user's, and the seam says the expected owner is
    // somebody else: neither may be read as a holder's lock. Provenance is what
    // makes a planted directory unusable, and a planted directory this user owns
    // passes every test except that one.
    const underSeam = runLockIn(dir, ["status"], { CF_GATE_TEST_EXPECT_UID: String(notOurUid) });
    expect(underSeam.status).toBe(0);
    expect(underSeam.stdout).toContain("free");
    for (const slot of [one, two]) expect(underSeam.stdout).not.toContain(`${slot} `);

    // A heartbeat that finds nothing refuses rather than reaching for one of them.
    const beat = runLockIn(dir, ["heartbeat"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_TEST_EXPECT_UID: String(notOurUid),
    });
    expect(beat.status).not.toBe(0);
    expect(beat.stderr).toContain("no lock");
    expect(fileIn(one, "beat")).toBe("1000");
    expect(fileIn(two, "beat")).toBe("1000");

    // With no seam set, the same two slots are plainly visible — the seam is what
    // removed them, not a filter that removed everything.
    const plain = runLockIn(dir, ["status"]);
    expect(plain.stdout).toContain(`${one} held by lane-a`);
    expect(plain.stdout).toContain(`${two} held by lane-b`);
  });

  test("a pinned heartbeat refreshes its own slot, not a decoy that names the same owner and pid", () => {
    const dir = scratch();
    // The attack this closes, planted rather than described. A holder's slot is 1;
    // slot 0 — which sorts first, and is a perfectly canonical name — carries the
    // same owner and the same pid with a beat nobody refreshes, and slot 2 does
    // too. A scan takes whichever it meets first, so the real slot's beat goes
    // stale, the next acquire reclaims it, and the holder carries on against a
    // lock nobody holds. The pin takes slot 1 because slot 1 is what it was given.
    const decoyFirst = seedSlot(dir, 0, { owner: "lane-a", pid: process.pid, beat: 1000 });
    const mine = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });
    const decoyLast = seedSlot(dir, 2, { owner: "lane-a", pid: process.pid, beat: 1000 });

    const beat = runLockIn(dir, ["heartbeat"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_SLOT_PATH: mine,
    });
    expect(beat.status).toBe(0);
    expect(Number(fileIn(mine, "beat"))).toBeGreaterThan(1000);
    expect(fileIn(decoyFirst, "beat")).toBe("1000");
    expect(fileIn(decoyLast, "beat")).toBe("1000");
  });

  test("a pin that is not a slot, or not this user's lock, is refused by name", () => {
    const dir = scratch();
    const mine = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });
    const behind = seedNamed(dir, "not-a-slot", { owner: "lane-a", pid: process.pid, beat: 1000 });
    symlinkSync(behind, join(dir, "cf-gate.lock.2"));
    // A pin is a path in the environment, so it is a claim and not a fact. Each of
    // these is refused the same way — exit 2, naming the path — and NONE of the
    // three subcommands may act on one: the refusal is the whole answer, so a
    // release that deleted through a pin nobody could vouch for would be the worst
    // outcome available.
    const refused = [
      { why: "not a slot name", pin: join(dir, "cf-gate.lock.0") },
      { why: "not a slot name", pin: join(dir, "cf-gate.lock.64") },
      { why: "not ours (a symlink)", pin: join(dir, "cf-gate.lock.2") },
      { why: "not ours (the uid seam)", pin: mine, seam: String(notOurUid) },
    ];
    for (const { why, pin, seam } of refused) {
      for (const args of [["verify", "lane-a"], ["heartbeat"], ["release", "lane-a"]]) {
        const result = runLockIn(dir, args, {
          CF_GATE_CALLER_PID: String(process.pid),
          CF_GATE_SLOT_PATH: pin,
          ...(seam ? { CF_GATE_TEST_EXPECT_UID: seam } : {}),
        });
        expect({
          why,
          subcommand: args[0],
          status: result.status,
          namesThePin: result.stderr.includes(pin),
        }).toEqual({
          why,
          subcommand: args[0],
          status: 2,
          namesThePin: true,
        });
      }
      // Untouched, whichever subcommand asked: the real slot is still there with
      // the beat it was seeded with, and the directory behind the symlink is
      // still there too.
      expect(fileIn(mine, "beat")).toBe("1000");
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(behind)).toBe(true);
    }
  });

  test("the command under the lock inherits no pin, and the run keeps its own", () => {
    const dir = scratch();
    // A launcher with CF_GATE_SLOT_PATH in its EXPORTED environment — a previous
    // holder's gate, or a seat's own export — hands `run` a pin it did not earn.
    // `run` clears it before its acquire and sets its own afterwards, and that
    // second assignment must not re-export it: a variable that arrives exported
    // KEEPS the attribute when it is assigned to, so `CF_GATE_SLOT_PATH=""`
    // followed by `CF_GATE_SLOT_PATH="$LOCK"` published this run's slot to the
    // command under the lock and to everything that command starts. A claim to
    // somebody's lock that the holder of it cannot police is exactly what the
    // pin exists to prevent, so it must not travel out of here at all.
    const inherited = join(dir, "cf-gate.lock.1");
    const seen = join(dir, "seen");
    const result = runLockIn(
      dir,
      [
        "run",
        "lane-a",
        "--",
        "sh",
        "-c",
        'printf "%s\\n" "${CF_GATE_SLOT_PATH-unset}" > "$TMPDIR/seen"',
      ],
      // SLOTS=3 so the inherited path is a name this host really has slots for,
      // and the acquire below is free to take a different one.
      { CF_GATE_SLOT_PATH: inherited, CF_GATE_SLOTS: "3" },
    );
    expect(result.status).toBe(0);
    // The command sees no pin at all — not the inherited one, and not this run's.
    expect(readFileSync(seen, "utf8").trim()).toBe("unset");
    // The slot it took is its own, slot 0, and the inherited path was never one.
    expect(result.stdout).toContain(`at ${lockDir(dir)}`);
    expect(existsSync(join(dir, "cf-gate.lock.1"))).toBe(false);
    // Released on the way out, so nothing here is left holding anything.
    expect(existsSync(lockDir(dir))).toBe(false);
  });

  test("a uid seam that is set but empty is inert, not a filter that hides every slot", () => {
    const dir = scratch();
    const mine = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });
    // An exported-but-empty override is what a wrapper that always sets the
    // variable produces on a host where it has nothing to say. With `-` rather
    // than `:-` the expansion handed `find` an empty uid, `-user ""` matched
    // nothing, and every slot on the host read as invisible — a free host, on a
    // host with a holder in it. Set-but-empty must mean what never-set means.
    const status = runLockIn(dir, ["status"], { CF_GATE_TEST_EXPECT_UID: "" });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`${mine} held by lane-a`);
  });

  test("a heartbeat on a pid that holds two slots refreshes only the pinned one", () => {
    const dir = scratch();
    // One pid, two lock directories, one of them the holder's own. Nothing in the
    // filesystem stops this — a pid is a recycled number, a forged directory can
    // carry any pid at all — and a scan by pid has no way to choose, so it takes
    // the name that sorts first and refreshes THAT. The pin is the answer, and it
    // is the same answer for `run`'s heartbeat loop, which is pinned to the slot
    // its own acquire took.
    const first = seedSlot(dir, 0, { owner: "lane-a", pid: process.pid, beat: 1000 });
    const mine = seedSlot(dir, 1, { owner: "lane-a", pid: process.pid, beat: 1000 });

    const beat = runLockIn(dir, ["heartbeat"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_SLOT_PATH: mine,
    });
    expect(beat.status).toBe(0);
    expect(Number(fileIn(mine, "beat"))).toBeGreaterThan(1000);
    expect(fileIn(first, "beat")).toBe("1000");
  });

  test("an acquire from a pid that already holds a live, fresh slot is refused, and that slot is untouched", () => {
    const dir = scratch();
    // One pid holds one slot, and this pid already holds one: a live holder with a
    // beat that says it is still answering for it. Acquiring again would leave the
    // first with nothing to refresh it, so the next acquire would reclaim it and
    // this caller would carry on against a lock nobody holds. Exit 2 and not 75:
    // the host is not busy, this caller is.
    const held = seedSlot(dir, 0, { owner: "lane-a", pid: process.pid });
    const refused = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
      CF_GATE_SLOTS: "3",
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("already holds");
    expect(refused.stderr).toContain(held);
    // Nothing was taken — not slot 0, and not the free slot 1 either: the refusal
    // happens before the slot loop, which is what makes it cheap and total.
    expect(fileIn(held, "owner")).toBe("lane-a");
    expect(fileIn(held, "pid")).toBe(String(process.pid));
    expect(existsSync(slotDir(dir, 1))).toBe(false);
    expect(existsSync(slotDir(dir, 2))).toBe(false);
  });

  test("the same pid's slot with a stale beat is reclaimed instead", () => {
    const dir = scratch();
    // The other half of that refusal, and the reason it is not written as "this
    // pid already has a slot": a slot with a STALE beat is a holder that has
    // stopped answering for it, which is exactly what a recycled pid looks like
    // from the outside. Refusing there would deadlock the new holder into waiting
    // for a lock of its own that nobody is going to refresh.
    const stale = Math.floor(Date.now() / 1000) - 700;
    seedSlot(dir, 0, { owner: "lane-a", pid: process.pid, beat: stale });
    const reclaimed = runLockIn(dir, ["acquire", "lane-a"], {
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(reclaimed.status).toBe(0);
    expect(reclaimed.stdout).toContain("reclaiming");
    expect(reclaimed.stdout).toContain("stale");
    expect(fileIn(slotDir(dir, 0), "owner")).toBe("lane-a");
    expect(Number(fileIn(slotDir(dir, 0), "beat"))).toBeGreaterThan(stale);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE_LOCK_DIR — the host-wide pool, and format 1 of it.
//
// Everything below is one project's view of a lock that is the HOST's: a
// directory of slots several projects share, named `gate.lock` and
// `gate.lock.<n>` because the name has to be the same in each of them, marked
// with a `.format` file so two projects cannot share a pool whose lock
// semantics they disagree about, and carrying a `project` file so `status` can
// say whose seat a slot is.
//
// The env every one of these drives comes from gateEnv, which pins
// CF_GATE_SLOTS=1 — and that pin is VISIBLE here, in a way it is not in the
// suite above: under a pool a CF_GATE_SLOTS that disagrees with the host's count
// is refused (row item 4), so a test that means a pool of N slots has to SAY N
// in both variables. That is not boilerplate, it is the contract — and the
// refusal test further down is the same rule from the other side.
// ─────────────────────────────────────────────────────────────────────────────
describe("gate-lock.sh: GATE_LOCK_DIR, the host-wide pool", () => {
  /**
   * A pool directory under `parent`, ABSENT unless `mode` is given. Absent is the
   * interesting default: it is the state every host's pool is in the first time
   * a gate looks at it, and the state two acquirers can race into.
   */
  function poolAt(parent: string, mode?: number): string {
    const pool = join(parent, "pool");
    if (mode !== undefined) {
      mkdirSync(pool);
      // chmodSync and NOT mkdirSync's `mode`: umask 022 filters the requested
      // 0777 down to 0755, so the mode the lock checks would never be the mode
      // this test asked for, and the world-writable case would silently become
      // the merely group-writable one. 0700 is the default a pool is expected to
      // have, so every pool this file makes by hand carries it explicitly.
      chmodSync(pool, mode);
    }
    return pool;
  }

  /** A pool that already exists, at the mode a host's pool is supposed to have. */
  function madePool(mode = 0o700): string {
    return poolAt(scratch(), mode);
  }

  /** Slot n inside a pool — `gate.lock`, or `gate.lock.<n>`. */
  function poolSlot(pool: string, n: number): string {
    return n === 0 ? join(pool, "gate.lock") : join(pool, `gate.lock.${n}`);
  }

  /** A slot as ANOTHER project's holder left it, including its `project` file. */
  function seedPoolSlot(
    pool: string,
    n: number,
    holder: { owner?: string; pid?: number; beat?: number; project?: string },
  ): string {
    const slot = poolSlot(pool, n);
    // mkdirSync's `mode` would be filtered by the umask, so the mode is set after
    // the fact: a pool this test plants slots into has to be one a host's pool
    // would be, or the slot checks below would be answering about a pool the lock
    // had already refused.
    mkdirSync(slot, { recursive: true });
    chmodSync(pool, 0o700);
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(slot, "owner"), `${holder.owner ?? "other-lane"}\n`);
    writeFileSync(join(slot, "started"), `${now}\n`);
    writeFileSync(join(slot, "pid"), `${holder.pid ?? process.pid}\n`);
    writeFileSync(join(slot, "beat"), `${holder.beat ?? now}\n`);
    if (holder.project !== undefined) writeFileSync(join(slot, "project"), `${holder.project}\n`);
    return slot;
  }

  /** A live pid that belongs to nobody in this suite: a `sleep` child, killed after. */
  function livePid(seconds = "60"): { pid: number; stop: () => void } {
    const child = spawn("sleep", [seconds], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("sleep produced no pid");
    return { pid: child.pid, stop: () => child.kill("SIGKILL") };
  }

  /**
   * Stop a started lock child and reap it, whatever an assertion did.
   *
   * TERM first, and that is the whole content of this function: a `run` forwards
   * a TERM to the command it is holding the lock for and reaps it, while a
   * SIGKILL leaves that command alive holding this suite's pipes — so `close`
   * never arrives and the test reads as HUNG rather than as a leftover process.
   */
  async function stopLock(child: ChildProcess, done: Promise<unknown>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const gone = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    if (!gone) child.kill("SIGKILL");
    await done;
  }

  /** The pool in this test's environment, plus whatever the test adds. */
  const poolEnv = (pool: string, extra: Record<string, string> = {}): Record<string, string> => ({
    GATE_LOCK_DIR: pool,
    ...extra,
  });

  /** A held slot in a test's own TMPDIR — `cf-gate.lock`, or `cf-gate.lock.<n>`. */
  function seedTmpSlot(
    dir: string,
    n: number,
    holder: { owner?: string; pid?: number; beat?: number },
  ): string {
    const slot = n === 0 ? lockDir(dir) : join(dir, `cf-gate.lock.${n}`);
    mkdirSync(slot, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(slot, "owner"), `${holder.owner ?? "other-lane"}\n`);
    writeFileSync(join(slot, "started"), `${now}\n`);
    writeFileSync(join(slot, "pid"), `${holder.pid ?? process.pid}\n`);
    writeFileSync(join(slot, "beat"), `${holder.beat ?? now}\n`);
    return slot;
  }

  test("every slot lives in GATE_LOCK_DIR, under the pool's own names, and none under TMPDIR", () => {
    const dir = scratch();
    const pool = poolAt(dir);
    const first = scratch();
    const second = scratch();
    const twoSlots = { GATE_HOST_SLOTS: "2", CF_GATE_SLOTS: "2", GATE_LOCK_DIR: pool };
    const one = acquireFrom(dir, first, ["acquire", "lane-a"], {
      ...twoSlots,
      CF_GATE_CALLER_PID: String(process.pid),
    });
    const two = acquireFrom(dir, second, ["acquire", "lane-b"], {
      ...twoSlots,
      CF_GATE_CALLER_PID: String(reapedPid()),
    });
    expect({ one: one.status, two: two.status }).toEqual({ one: 0, two: 0 });

    // Slot 0 keeps the unsuffixed name and the next slot is `.1`, both inside the
    // pool — these names are the pool's, and they are the same in every project
    // that draws from it.
    expect(readFileSync(join(poolSlot(pool, 0), "owner"), "utf8").trim()).toBe("lane-a");
    expect(readFileSync(join(poolSlot(pool, 1), "owner"), "utf8").trim()).toBe("lane-b");
    // Nothing at all in TMPDIR: the whole point is that this project's lock
    // parent is no longer where its locks live.
    expect(readdirSync(dir).filter((entry) => entry.startsWith("cf-gate.lock"))).toEqual([]);
    expect(existsSync(lockDir(dir))).toBe(false);
    // The sixth file is there too, naming this repository for `status`.
    expect(readdirSync(poolSlot(pool, 0)).sort()).toEqual([
      "beat",
      "owner",
      "pid",
      "project",
      "started",
      "worktree",
    ]);
  });

  test("a missing pool directory is created 0700, and its .format is written 1", () => {
    const dir = scratch();
    const pool = poolAt(dir);
    expect(existsSync(pool)).toBe(false);
    const result = runLockIn(dir, ["acquire", "lane-a"], {
      ...poolEnv(pool),
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(result.status).toBe(0);
    // 0700 and nothing looser: a pool directory another user can write is a
    // directory another user's gate can take a slot in. `statSync` is the TEST's
    // business — the prohibition on `stat` is the script's, because POSIX sh has
    // no portable one.
    expect(statSync(pool).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(pool, ".format"), "utf8").trim()).toBe("1");
    // And no temp file beside it: the marker is published with `ln`, so the only
    // entry the name can have is the finished one.
    expect(readdirSync(pool).filter((entry) => entry.startsWith(".format"))).toEqual([".format"]);
  });

  test("a .format holding 1 is accepted, and is not rewritten", () => {
    const dir = scratch();
    const pool = madePool();
    writeFileSync(join(pool, ".format"), "1\n");
    const result = runLockIn(dir, ["status"], poolEnv(pool));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    // Not rewritten because a publisher that replaced the marker would let two
    // projects with different semantics overwrite each other's answer, and every
    // later comparison would then be against whichever wrote last.
    expect(readFileSync(join(pool, ".format"), "utf8")).toBe("1\n");
  });

  test.each([
    ["2", "another version of this format"],
    ["", "a marker that was truncated to nothing"],
  ])("a .format holding '%s' is refused, naming the number", (format, why) => {
    const dir = scratch();
    const pool = madePool();
    writeFileSync(join(pool, ".format"), format);
    const result = runLockIn(dir, ["status"], poolEnv(pool));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`GATE_LOCK_DIR holds lock format ${format || "nothing"}`);
    expect(result.stderr).toContain("this gate speaks 1");
    // Nothing was taken on the way past, which is what makes this refusal safe
    // to leave in place of a pool: no seat is spent on a pool nobody can read.
    expect(readdirSync(pool).sort()).toEqual([".format"]);
    expect(why.length).toBeGreaterThan(0);
  });

  test("a pool owned by somebody else is refused, through the uid seam a slot is judged by", () => {
    // The seam is the whole mechanism: `find -user` is how this lock decides who
    // owns a directory it will rename into, and the pool and its parent are two
    // separate claims — so they have two seams, and each test moves one. This one
    // moves the POOL's, and pins the parent's claim to the real uid, because the
    // parent is judged FIRST: with one variable for both, every case that made a
    // pool foreign also made its parent foreign, the parent's refusal answered
    // first, and the pool's own owner check became unreachable from a test. That
    // is the defect this test exists to prevent, and CF_GATE_TEST_PARENT_UID is
    // what makes it reachable.
    const dir = scratch();
    // The pool exists first, so the mkdir above the check is a no-op: a refusal
    // then leaves the directory exactly as it was, with no `.format` published
    // into a pool this user does not own.
    const pool = madePool();
    const result = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      CF_GATE_TEST_EXPECT_UID: "65534",
      CF_GATE_TEST_PARENT_UID: String(process.getuid?.() ?? 0),
    });
    expect(result.status).toBe(2);
    // The refusal names the POOL, not the parent: that is the directory the
    // operator has to change here, and the uid is the one the seam named.
    expect(result.stderr).toContain(`GATE_LOCK_DIR=${pool}`);
    expect(result.stderr).toContain("owned by uid 65534");
    expect(result.stderr).not.toContain("'s parent");
    // And it is untouched: no marker, no slot, nothing published.
    expect(readdirSync(pool)).toEqual([]);
  });

  test("a group- or world-writable pool is refused", () => {
    // Both modes, because they are two different ways for a second user to reach
    // the pool: group membership on one host, any user on a shared one. `test -w`
    // would answer "yes, its owner can write it" for both, which is why the mode
    // is read through `find` rather than through the shell.
    const dir = scratch();
    for (const mode of [0o775, 0o777]) {
      const pool = poolAt(scratch(), mode);
      const result = runLockIn(dir, ["status"], poolEnv(pool));
      expect({ mode: mode.toString(8), status: result.status }).toEqual({
        mode: mode.toString(8),
        status: 2,
      });
      expect(result.stderr).toContain("neither group- nor world-writable");
      expect(readdirSync(pool)).toEqual([]);
    }
  });

  test("a symlinked or relative GATE_LOCK_DIR is refused by name", () => {
    const dir = scratch();
    const real = madePool();
    const link = join(scratch(), "pool-link");
    symlinkSync(real, link);
    const symlinked = runLockIn(dir, ["status"], poolEnv(link));
    expect(symlinked.status).toBe(2);
    expect(symlinked.stderr).toContain(`GATE_LOCK_DIR=${link}`);
    expect(symlinked.stderr).toContain("not a symlink");
    // A symlink at the pool's name is a pool somebody else can re-point at a
    // directory of their own between one acquire and the next.
    expect(readdirSync(real)).toEqual([]);

    const relative = runLockIn(dir, ["status"], { GATE_LOCK_DIR: "relative/pool" });
    expect(relative.status).toBe(2);
    expect(relative.stderr).toContain("must be an absolute path");
    expect(relative.stderr).toContain("relative/pool");
  });

  test("a pool path that is not plain, or that runs through a symlink above it, is refused", () => {
    // Four ways past a check that only ever looks at the last component of a path.
    // The first three are SPELLINGS: `//`, `/./` and `/../` all name a directory
    // that is somewhere else, and `${GATE_LOCK_DIR%/*}` leaves the parent as
    // `<link>/`, `<link>/.` or `<link>/..` — paths whose `[ -L ]` is false and
    // whose `find` descends through the link, so the pool and its parent would be
    // judged through whatever the link points at and accepted. The fourth is not a
    // spelling at all: a real pool two levels below a symlinked ancestor, which no
    // spelling rule can catch and which every check below the ancestor misses,
    // because that directory really is ours and really is 0700.
    //
    // The links live INSIDE a mkdtemp scratch, which is RESOLVED (see scratch) and
    // therefore has no symlink of its own in it — so each of these is refused for
    // the component it names, and not for whatever the host's TMPDIR is reached
    // through. A Mac's /var is itself a link, which is the case the next test
    // guards; putting these links under an unresolved scratch would have made all
    // four fail for the host's reasons instead of their own.
    const dir = scratch();
    const host = scratch();
    const target = join(host, "real");
    mkdirSync(target);
    const link = join(host, "link");
    symlinkSync(target, link);
    const below = join(target, "below");
    mkdirSync(below);
    chmodSync(below, 0o700);

    for (const name of [
      `${link}//pool`,
      `${link}/./pool`,
      `${link}/../pool`,
      join(link, "below", "pool"),
    ]) {
      const result = runLockIn(dir, ["status"], { GATE_LOCK_DIR: name });
      expect({ name, status: result.status }).toEqual({ name, status: 2 });
      // Every refusal names the value the caller passed, so the operator can see
      // which of the four was the one that did not run.
      expect(result.stderr).toContain(name);
      // Nothing was created anywhere on the way past, in the target or beside the
      // link: all four are refused before the mkdir.
      expect(existsSync(join(target, "pool"))).toBe(false);
      expect(existsSync(join(below, "pool"))).toBe(false);
      expect(readdirSync(target).sort()).toEqual(["below"]);
    }
    // The ancestor refusal says WHICH component was the link; the plain-path one
    // says what a pool path may not contain. Two answers because they are two
    // faults, and the operator cannot act on "refused" alone.
    const walked = runLockIn(dir, ["status"], { GATE_LOCK_DIR: join(link, "below", "pool") });
    expect(walked.stderr).toContain(link);
    expect(walked.stderr).toContain("is a symlink");
    // And it says what to do about it, because the link is very often the
    // caller's own TMPDIR rather than somebody else's pool: the answer is the
    // resolved path, and an operator who is not told that has nothing to change.
    expect(walked.stderr).toContain("name the pool by its resolved path (cd <dir> && pwd -P)");
    const spelled = runLockIn(dir, ["status"], { GATE_LOCK_DIR: `${link}/./pool` });
    expect(spelled.stderr).toContain("plain absolute path");

    // And a REAL nested pool still works: two real levels down, no link, nothing
    // to refuse. A path walk that refused ordinary directories would be as wrong
    // as one that accepts links.
    const ok = runLockIn(dir, ["status"], { GATE_LOCK_DIR: join(below, "pool") });
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: "" });
    expect(existsSync(join(below, "pool", ".format"))).toBe(true);
  });

  test("a symlinked ancestor is refused with the hint, and its resolved path is accepted", () => {
    // The regression guard for a failure a Linux-only run cannot see. scratch() is
    // RESOLVED (see it), so on this host every pool above is already a plain path
    // and every ancestor-walk test proves only what it says. It was not true on a
    // Mac: os.tmpdir() there is /var/folders/…, /var is a symlink, so every pool
    // built from scratch() — and every pool a mac test seeds — was refused by the
    // walk, 26 cases of them, and 13 of the lane's mutations could not be checked
    // because the unmutated suite was already red.
    //
    // So the shape is built by hand here, inside a resolved scratch: one real
    // directory with a link to a sibling, and the SAME pool addressed through
    // each. The rule is not weakened — the link is still refused — and the
    // refusal now carries the hint that says how to name a pool reached through
    // one.
    //
    // One real level below the link, so the LINK is an ancestor rather than the
    // parent and the WALK is what answers. A link AT the parent is a different
    // refusal with a different message, covered in the parent test above, and this
    // case is the Mac's: /var/folders/… puts the link two levels above the pool,
    // which is why every one of those 26 failures came out of the walk and not
    // out of the parent's own check.
    const dir = scratch();
    const target = join(dir, "real");
    const alias = join(dir, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);
    const below = join(target, "below");
    mkdirSync(below);
    chmodSync(below, 0o700);

    const through = join(alias, "below", "pool");
    const refused = runLockIn(dir, ["status"], { GATE_LOCK_DIR: through });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(through);
    expect(refused.stderr).toContain(alias);
    expect(refused.stderr).toContain("is a symlink");
    expect(refused.stderr).toContain("name the pool by its resolved path (cd <dir> && pwd -P)");
    // Nothing was created through the link: the refusal is asked before the mkdir,
    // so the pool does not exist on the far side either.
    expect(existsSync(join(target, "below", "pool"))).toBe(false);

    // The same pool, named by its resolved path — what the hint tells an operator
    // to do, and what a caller whose TMPDIR is reached through a link must set.
    const resolved = join(below, "pool");
    // `below` is already a resolved path — the scratch is, and everything made
    // inside it inherits that — so this name needs no resolution to be the
    // resolved one. (`realpathSync` on the POOL itself would throw: it does not
    // exist yet, which is the point.)
    expect(below).toBe(realpathSync(below));
    const accepted = runLockIn(dir, ["status"], { GATE_LOCK_DIR: resolved });
    expect({ status: accepted.status, stderr: accepted.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(existsSync(join(resolved, ".format"))).toBe(true);
  });

  test("a symlinked pool cannot be smuggled in behind a trailing slash", () => {
    // A trailing slash is not a SPELLING of the same pool here — it is a way past
    // every check this file makes. Measured on this host, for a symlink pointing
    // at a 0700 directory this user owns: `[ -L "$d/link/" ]` is FALSE, because
    // the trailing slash makes the shell resolve the link, and `find "$d/link/"`
    // descends through it and reports the TARGET's uid and mode. So the link is
    // judged through what it points at, passes, and a pool another user can
    // re-point at any time is accepted. All three spellings of the same name are
    // refused here, and the target is left with nothing in it.
    for (const suffix of ["", "/", "//"]) {
      const parent = scratch();
      const target = madePool();
      const link = join(parent, "pool-link");
      symlinkSync(target, link);
      const result = runLockIn(scratch(), ["status"], { GATE_LOCK_DIR: `${link}${suffix}` });
      expect({ suffix, status: result.status }).toEqual({ suffix, status: 2 });
      // The refusal names the pool as the reduced path, and says it is a symlink:
      // one slash must not turn the answer into a different one.
      expect(result.stderr).toContain(`GATE_LOCK_DIR=${link} is`);
      expect(result.stderr).toContain("not a symlink");
      expect(readdirSync(target)).toEqual([]);
    }
  });

  test("a real pool keeps the very same paths when its name carries a trailing slash", () => {
    // The other half of that: reducing the slash must not move anything. The slot
    // names a holder pins (CF_GATE_SLOT_OUT) and a busy message quotes are the
    // same byte for byte with and without it, because the slash is not part of the
    // name — it is punctuation the caller typed.
    const dir = scratch();
    const pool = madePool();
    const taken = runLockIn(dir, ["acquire", "lane-a"], {
      GATE_LOCK_DIR: `${pool}/`,
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(taken.status).toBe(0);
    expect(taken.stdout).toContain(`at ${poolSlot(pool, 0)}`);
    expect(existsSync(poolSlot(pool, 0))).toBe(true);
    // And the busy answer names that same path, spelled the way the second caller
    // asked for it.
    const busy = runLockIn(dir, ["acquire", "lane-b"], {
      GATE_LOCK_DIR: `${pool}//`,
      CF_GATE_CALLER_PID: String(reapedPid()),
    });
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain(poolSlot(pool, 0));
    // The root is not a pool anybody may take a slot in, and it is the one value
    // the reduction cannot produce a shorter form of.
    const root = runLockIn(dir, ["status"], { GATE_LOCK_DIR: "/" });
    expect(root.status).toBe(2);
    expect(root.stderr).toContain("not the filesystem root");
  });

  test("a pool whose parent another user can write is refused", () => {
    // The check the leaf's own mode cannot make. The pool's 0700 protects the
    // NAMES inside it and nothing about the name itself, which is a directory
    // entry in the parent: a parent another user can write lets them rename the
    // pool away between one acquirer's mkdir and the next one's rename, onto a
    // directory they own holding a `.format` they wrote and slots they seeded —
    // and by then the pool has moved, so nothing at the leaf can say so.
    //
    // Three ways the parent is not this user's alone, and one way it is. Every
    // refusal names the PARENT, because the parent is what has to change and the
    // pool is not what is wrong with it.
    const dir = scratch();
    for (const mode of [0o775, 0o777]) {
      const parent = scratch();
      chmodSync(parent, mode);
      const pool = join(parent, "pool");
      const result = runLockIn(dir, ["status"], { GATE_LOCK_DIR: pool });
      expect({ mode: mode.toString(8), status: result.status }).toEqual({
        mode: mode.toString(8),
        status: 2,
      });
      expect(result.stderr).toContain(`GATE_LOCK_DIR's parent ${parent}`);
      expect(result.stderr).toContain("not writable by group or others");
      // Nothing was created on the way past: a pool under a parent nobody may
      // write is not a pool this user can hold, so no marker is published into it.
      expect(existsSync(pool)).toBe(false);
    }

    // Somebody else's parent, through the PARENT's own seam — so a case that moves
    // one claim cannot answer for the other. The pool is created first here too,
    // and the pool's own uid claim is left alone: this case is about the parent.
    const ours = scratch();
    const foreign = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: join(ours, "pool"),
      CF_GATE_TEST_PARENT_UID: "65534",
    });
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain(`GATE_LOCK_DIR's parent ${ours}`);
    expect(foreign.stderr).toContain("owned by uid 65534");
    // The parent's check is asked BEFORE the mkdir, so a refusal here leaves no
    // directory behind in a parent nobody may write — which is the whole reason
    // it is asked first.
    expect(existsSync(join(ours, "pool"))).toBe(false);

    // A symlinked parent, for the same reason a symlinked pool is refused: the
    // entry above the pool is then somebody else's link.
    const host = scratch();
    const target = madePool();
    const link = join(host, "parent-link");
    symlinkSync(target, link);
    const symlinked = runLockIn(dir, ["status"], { GATE_LOCK_DIR: join(link, "pool") });
    expect(symlinked.status).toBe(2);
    expect(symlinked.stderr).toContain(`GATE_LOCK_DIR's parent ${link}`);

    // And the ordinary case: mkdtemp gives 0700, so every other pool test in this
    // file runs under a parent this check has just accepted — midnight's
    // /run/user/1000 is the same shape, a per-user tmpfs the user owns.
    const mine = scratch();
    const ok = runLockIn(dir, ["status"], { GATE_LOCK_DIR: join(mine, "pool") });
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: "" });
    expect(existsSync(join(mine, "pool", ".format"))).toBe(true);
  });

  test("an EMPTY GATE_LOCK_DIR is unset, and the lock lands where it always has", () => {
    const dir = scratch();
    // A wrapper that exports the variable unconditionally on a host that has
    // nothing to say about it is not a broken host. This is the shape the CI and
    // the Mac runners produce, and it has to keep today's name byte for byte.
    const result = runLockIn(dir, ["acquire", "lane-a"], {
      GATE_LOCK_DIR: "",
      CF_GATE_CALLER_PID: String(process.pid),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`at ${lockDir(dir)}`);
    expect(lockFile(dir, "owner").trim()).toBe("lane-a");
    // No `.format` anywhere: today's path has no format marker, because there is
    // no pool to be compatible with.
    expect(readdirSync(dir).filter((entry) => entry.startsWith(".format"))).toEqual([]);
  });

  test("GATE_HOST_SLOTS alone is the pool's count, and it is read the way a slot count is", () => {
    const dir = scratch();
    // Midnight's configuration: an explicit 6 rather than the derived count, so
    // that a change in the host's thread count does not silently change how many
    // gates it runs. The refusals are asked for with CF_GATE_SLOTS left at its
    // agreeing default, so what answers is the HOST variable's own validation
    // rather than the disagreement check further down — and the count it is read
    // through is the same code, so `006` is six slots' spelling, not a
    // three-digit value.
    for (const [given, accepted] of [
      ["6", true],
      ["006", true], // a leading zero is a spelling, not a count
      ["", true], // an empty value is an unset one, so CF_GATE_SLOTS decides
      ["0", false],
      ["65", false],
      ["x", false],
    ] as Array<[string, boolean]>) {
      const pool = madePool();
      const result = runLockIn(dir, ["status"], {
        GATE_LOCK_DIR: pool,
        GATE_HOST_SLOTS: given,
        CF_GATE_SLOTS: accepted ? given || "1" : "1",
      });
      expect({ given, status: result.status, accepted }).toEqual({
        given,
        status: accepted ? 0 : 2,
        accepted,
      });
      if (!accepted) expect(result.stderr).toContain("GATE_HOST_SLOTS");
    }
  });

  test.each([
    ["24", "4", "6"], // midnight: 24 threads, 4 workers a run — six gates
    ["24", "5", "4"],
    ["3", "4", "1"], // fewer threads than one worker's worth is still ONE gate
  ])("nproc %s with GATE_HOST_WORKERS=%s derives %s slots", (nproc, workers, slots) => {
    const dir = scratch();
    const pool = madePool();
    // A host that names GATE_HOST_WORKERS names the run cap beside it — midnight
    // sets both to 4 — and the pool refuses the two when they differ. So
    // CF_TEST_MAX_WORKERS is stated here rather than left to whatever the seat
    // exports: this suite's env builder deletes the pool variables but inherits
    // the per-project ones, and on a seat that exports CF_TEST_MAX_WORKERS=4
    // every case below would refuse for a reason that has nothing to do with the
    // derivation.
    //
    // The derivation is read back through the ONLY place a count is observable
    // without taking seats: a CF_GATE_SLOTS that matches it is accepted, and one
    // either side of it is refused naming both. So "derives 6" is proved by 6
    // being accepted while 5 and 7 are not — a single-sided check could only
    // say "not 5".
    for (const said of [
      slots, // the derived count, accepted
      String(Number(slots) + 1), // one too many: refused as a disagreement
      ...(Number(slots) > 1 ? [String(Number(slots) - 1)] : []),
      // Zero, for the one-slot case: it is refused too, but as a value that is
      // not a count of slots rather than as a disagreement, and it never reaches
      // the comparison at all.
      ...(Number(slots) === 1 ? ["0"] : []),
    ]) {
      const result = runLockIn(dir, ["status"], {
        GATE_LOCK_DIR: pool,
        GATE_HOST_WORKERS: workers,
        CF_TEST_MAX_WORKERS: workers,
        CF_GATE_TEST_NPROC: nproc,
        CF_GATE_SLOTS: said,
      });
      expect({ nproc, workers, said, status: result.status }).toEqual({
        nproc,
        workers,
        said,
        status: said === slots ? 0 : 2,
      });
      if (said !== slots) {
        expect(result.stderr).toContain("CF_GATE_SLOTS");
        if (Number(said) > 0) expect(result.stderr).toContain("GATE_HOST_WORKERS");
      }
    }
  });

  test("a pool of six derived slots really does run six gates at once, and refuses the seventh", () => {
    // The disagreement check above pins the number; this pins what the number is
    // FOR. Six live holders in six worktrees, one shared pool, and a seventh
    // caller told busy — with each holder a real live pid, because a pid this
    // process has already used is refused as a second slot for one holder, and a
    // reaped pid would be reclaimed instead of respected.
    const dir = scratch();
    const pool = poolAt(scratch());
    const holders: Array<{ pid: number; stop: () => void }> = [];
    try {
      for (let n = 0; n < 6; n++) {
        const live = livePid();
        holders.push(live);
        const result = acquireFrom(dir, scratch(), ["acquire", `lane-${n}`], {
          GATE_LOCK_DIR: pool,
          GATE_HOST_WORKERS: "4",
          CF_GATE_TEST_NPROC: "24",
          CF_GATE_SLOTS: "6",
          CF_TEST_MAX_WORKERS: "4",
          CF_GATE_CALLER_PID: String(live.pid),
        });
        expect({ n, status: result.status }).toEqual({ n, status: 0 });
      }
      // Six slots taken, so the pool's sixth is the last that can be handed out:
      // the seventh caller is refused by COUNT, not by worktree and not by a
      // crash, which is what a semaphore is for.
      const seventh = livePid();
      holders.push(seventh);
      const refused = acquireFrom(dir, scratch(), ["acquire", "lane-six"], {
        GATE_LOCK_DIR: pool,
        GATE_HOST_WORKERS: "4",
        CF_GATE_TEST_NPROC: "24",
        CF_GATE_SLOTS: "6",
        CF_TEST_MAX_WORKERS: "4",
        CF_GATE_CALLER_PID: String(seventh.pid),
      });
      expect(refused.status).toBe(75);
      expect(refused.stderr).toContain("busy");
      expect(refused.stderr).toContain("lane-0");
      // Six slots and the marker: nothing else has appeared in the pool.
      expect(readdirSync(pool).sort()).toEqual([
        ".format",
        "gate.lock",
        "gate.lock.1",
        "gate.lock.2",
        "gate.lock.3",
        "gate.lock.4",
        "gate.lock.5",
      ]);
    } finally {
      for (const holder of holders) holder.stop();
    }
  });

  test("the pool's slots and its workers must multiply out to the host's processors", () => {
    // The one refusal here that needs nobody's second opinion, because both
    // numbers are the host's own and their product is checkable against the
    // host's own thread count. Seven gates of four workers is 28 runnable workers
    // asked of 24 threads, and the failure mode is not a message: tens of
    // gigabytes of RSS against ~40 free, and false timeouts on the CPU-bound tests
    // that fail on their own internal deadlines and cannot be saved by a larger
    // --testTimeout. Lock correctness survives an oversubscribed budget; the tests
    // it is there to protect do not.
    const dir = scratch();
    const pool = madePool();
    // CF_TEST_MAX_WORKERS beside the host's own cap, because the worker comparison
    // runs first and this suite inherits the seat's — on a 7x3 host the inherited
    // value would refuse every case here for a reason that is not this test's.
    for (const [slots, workers, accepted] of [
      ["6", "4", true], // midnight: exactly the thread count
      ["7", "4", false], // 28 > 24
      ["6", "5", false], // 30 > 24 — the other way round
    ] as Array<[string, string, boolean]>) {
      const result = runLockIn(dir, ["status"], {
        GATE_LOCK_DIR: pool,
        GATE_HOST_SLOTS: slots,
        CF_GATE_SLOTS: slots,
        GATE_HOST_WORKERS: workers,
        CF_TEST_MAX_WORKERS: workers,
        CF_GATE_TEST_NPROC: "24",
      });
      expect({ slots, workers, status: result.status, accepted }).toEqual({
        slots,
        workers,
        status: accepted ? 0 : 2,
        accepted,
      });
      if (!accepted) {
        // All three numbers named: the two the operator set and the one they are
        // being measured against, which is the one they may not have known.
        expect(result.stderr).toContain(`GATE_HOST_SLOTS=${slots}`);
        expect(result.stderr).toContain(`GATE_HOST_WORKERS=${workers}`);
        expect(result.stderr).toContain("24 processors");
      }
    }
    // A processor count that is not a number refuses here too, exactly as it does
    // in the derivation: the budget cannot be checked without it, and a guessed
    // one would be a guessed budget.
    const noCount = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_SLOTS: "6",
      CF_GATE_SLOTS: "6",
      GATE_HOST_WORKERS: "4",
      CF_TEST_MAX_WORKERS: "4",
      CF_GATE_TEST_NPROC: "many",
    });
    expect(noCount.status).toBe(2);
    expect(noCount.stderr).toContain("_NPROCESSORS_ONLN");
    // And it names the DECISION that wanted the count, which is not the derivation
    // and is fixed differently: this one is answered by lowering the slot count or
    // raising the worker cap, not by setting GATE_HOST_SLOTS.
    expect(noCount.stderr).toContain("GATE_HOST_SLOTS=6 with GATE_HOST_WORKERS=4");
    expect(noCount.stderr).toContain("checked against");

    // GATE_HOST_SLOTS ALONE stays allowed, as the row says — and it leaves the
    // vitest worker count uncapped, which is the operator's trade: a host that
    // names only its gate count is a host that has decided vitest's own default is
    // the cap, and this check cannot object to a decision it has no second number
    // for. That trade is documented at the variable rather than enforced here,
    // because the alternative is refusing a configuration the row describes as
    // valid (midnight names both; a smaller pool may name one).
    const slotsOnly = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_SLOTS: "24",
      CF_GATE_SLOTS: "24",
      CF_GATE_TEST_NPROC: "24",
    });
    expect({ status: slotsOnly.status, stderr: slotsOnly.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
  });

  test("a processor count that is not a number refuses the derivation, naming both", () => {
    const dir = scratch();
    const pool = poolAt(scratch());
    const result = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "4",
      // Beside the host's own cap, because this suite inherits
      // CF_TEST_MAX_WORKERS from the seat and the pool compares the two FIRST:
      // on a 7x3 host the inherited 3 would refuse this invocation before the
      // processor count was ever read, and the case would be asserting about the
      // wrong refusal.
      CF_TEST_MAX_WORKERS: "4",
      CF_GATE_TEST_NPROC: "many",
    });
    expect(result.status).toBe(2);
    // Naming GATE_HOST_WORKERS and the count it needs: without nproc the only
    // answers are a guessed budget or no pool at all, and a guessed one is how a
    // host ends up oversubscribed by a factor nobody wrote down. And it names the
    // DERIVATION as the decision that wanted the count, which the budget check's
    // own refusal above does not — the two are answered differently and an
    // operator who cannot tell them apart fixes the wrong one.
    expect(result.stderr).toContain("GATE_HOST_WORKERS=4");
    expect(result.stderr).toContain("_NPROCESSORS_ONLN");
    expect(result.stderr).toContain("derive a slot count");
  });

  test("CF_GATE_SLOTS=3 beside GATE_HOST_SLOTS=6 is refused under a pool, naming both", () => {
    const dir = scratch();
    const pool = poolAt(scratch());
    // A seat that believes the host has three gates on a host that says six does
    // not get three gates: it gets a seat that takes a gate beside four holders
    // it cannot see, and a thread budget multiplied out of a wrong number.
    const refused = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_SLOTS: "6",
      GATE_HOST_WORKERS: "4",
      // The seat's own cap, agreeing with the host's: this case is about the SLOT
      // counts, and the worker comparison runs first, so an inherited
      // CF_TEST_MAX_WORKERS=3 on a 7x3 host would refuse here and the test would
      // be reading a worker refusal as a slot one.
      CF_TEST_MAX_WORKERS: "4",
      // And the host this pool claims to be, because the budget check runs on both
      // counts BEFORE the slot disagreement: 6 × 4 is exactly midnight's 24
      // threads, and a 16-thread Mac or a 4-core runner would refuse this
      // invocation as oversubscribed before reaching the refusal under test. Every
      // pool case that names BOTH host counts pins this, so no result here depends
      // on the machine it runs on.
      CF_GATE_TEST_NPROC: "24",
      CF_GATE_SLOTS: "3",
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CF_GATE_SLOTS=3");
    expect(refused.stderr).toContain("GATE_HOST_SLOTS");
    expect(refused.stderr).toContain(pool);
    // No seat was taken on the way past, which is what makes the refusal safe to
    // leave in place of a pool. The marker IS there: `.format` is published
    // before the counts are compared, so a pool that is correctly marked and
    // holds nobody is what this leaves behind.
    expect(readdirSync(pool)).toEqual([".format"]);

    // The SAME numbers with no pool are today's precedence exactly: CF_GATE_SLOTS
    // wins, the host's variables are not consulted, and there is no refusal. The
    // one release in which an operator may still have the old settings exported
    // depends on this, so it is a case rather than a remark — and the claim is
    // checked by COUNT: three slots are all held here, so a host that believed
    // GATE_HOST_SLOTS=6 would hand this acquirer slot 3 and let it run.
    const withoutPool = scratch();
    seedLock(withoutPool, { pid: process.pid, owner: "lane-a" });
    seedTmpSlot(withoutPool, 1, { pid: process.pid, owner: "lane-c" });
    seedTmpSlot(withoutPool, 2, { pid: process.pid, owner: "lane-e" });
    const ok = runLockIn(withoutPool, ["acquire", "lane-b"], {
      GATE_HOST_SLOTS: "6",
      GATE_HOST_WORKERS: "4",
      CF_GATE_SLOTS: "3",
      CF_GATE_CALLER_PID: String(reapedPid()),
    });
    expect(ok.status).toBe(75);
    expect(ok.stderr).toContain("busy");
    expect(ok.stderr).not.toContain("does not match");
    // Still three slots' worth of holders and nothing taken: the fourth name in a
    // six-slot host would say so.
    expect(readdirSync(withoutPool).sort()).toEqual([
      "cf-gate.lock",
      "cf-gate.lock.1",
      "cf-gate.lock.2",
    ]);
  });

  test("CF_TEST_MAX_WORKERS that disagrees with GATE_HOST_WORKERS is refused under a pool", () => {
    const dir = scratch();
    const pool = poolAt(scratch());
    const refused = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "4",
      CF_TEST_MAX_WORKERS: "3",
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CF_TEST_MAX_WORKERS=3");
    expect(refused.stderr).toContain("GATE_HOST_WORKERS=4");
    // The same two numbers agreeing is the normal case: midnight sets both.
    const agreed = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "4",
      GATE_HOST_SLOTS: "6",
      CF_GATE_SLOTS: "6",
      CF_TEST_MAX_WORKERS: "4",
      // The host these two counts describe: 6 × 4 is 24, which the budget check
      // compares against the processor count, and it would refuse on a 16-thread
      // Mac or a 4-core runner — the agreeing case would read as a disagreement.
      CF_GATE_TEST_NPROC: "24",
    });
    expect(agreed.status).toBe(0);
  });

  test("two spellings of one worker cap are one cap, not a disagreement", () => {
    // `04` is four workers, exactly as `006` is six slots above and as
    // max-workers.ts already accepts it. Compared as strings, the seat that writes
    // `CF_TEST_MAX_WORKERS=04` beside a host's `GATE_HOST_WORKERS=4` is refused
    // for a disagreement that does not exist — and it is the worst kind of
    // refusal, because neither value is wrong and there is nothing the operator
    // can change to satisfy it except the spelling, which is not what they asked
    // about.
    const dir = scratch();
    const pool = madePool();
    const sixSlots = { GATE_HOST_SLOTS: "6", CF_GATE_SLOTS: "6" };
    // The host those six slots and four workers are six-and-four OF: 24 threads.
    // Unpinned, the budget check reads this machine's real count and the whole
    // case becomes a statement about the runner — refused on a 16-thread Mac and
    // a 4-core one, accepted on midnight.
    const on24 = { ...sixSlots, CF_GATE_TEST_NPROC: "24" };
    const spelled = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "4",
      CF_TEST_MAX_WORKERS: "04",
      ...on24,
    });
    expect({ status: spelled.status, stderr: spelled.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    // And the normalisation is on the SPELLING, not a widening of what counts as
    // agreement: a cap of three beside four is still refused, and still named.
    const refused = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "4",
      CF_TEST_MAX_WORKERS: "3",
      ...on24,
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CF_TEST_MAX_WORKERS=3");
    expect(refused.stderr).toContain("GATE_HOST_WORKERS=4");
    // Leading zeros the other way round are the same agreement, and the strip is
    // the same loop read_slot_count uses for a slot count.
    const other = runLockIn(dir, ["status"], {
      GATE_LOCK_DIR: pool,
      GATE_HOST_WORKERS: "04",
      CF_TEST_MAX_WORKERS: "4",
      ...on24,
    });
    expect(other.status).toBe(0);
  });

  test("CF_GATE_STALE_SECONDS below 600 is refused under a pool, and free without one", () => {
    const dir = scratch();
    const pool = poolAt(scratch());
    // 600s is part of format 1, not a default: every reader judges every other
    // project's holder by this number, so one seat lowering it reclaims locks
    // that are alive — and it reclaims them out of a pool, where the holder it
    // reclaims belongs to somebody else.
    const refused = runLockIn(dir, ["status"], poolEnv(pool, { CF_GATE_STALE_SECONDS: "60" }));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CF_GATE_STALE_SECONDS=60");
    expect(refused.stderr).toContain("600s");
    // Without a pool the override is a per-project decision and works as it always
    // has — the whole suite above depends on that.
    const perProject = runLockIn(dir, ["status"], { CF_GATE_STALE_SECONDS: "60" });
    expect(perProject.status).toBe(0);
    // And 600 itself is accepted, so the floor is the number and not "any value".
    expect(runLockIn(dir, ["status"], poolEnv(pool, { CF_GATE_STALE_SECONDS: "600" })).status).toBe(
      0,
    );
  });

  test("status names the project in a slot, and unknown for a slot that has no project file", () => {
    const dir = scratch();
    const pool = poolAt(scratch());
    // Two slots in one pool, written as two different projects would leave them,
    // and one of them from before `project` existed. The question an operator has
    // about a shared pool is "whose seat is this", and the owner alone cannot
    // answer it: two projects both call their lane "lane-a".
    const theirs = seedPoolSlot(pool, 0, {
      owner: "lane-a",
      pid: process.pid,
      project: "hexagen-monaco",
    });
    const older = seedPoolSlot(pool, 1, { owner: "lane-a", pid: process.pid });
    const result = runLockIn(dir, ["status"], poolEnv(pool));
    expect(result.status).toBe(0);
    // The holder's own line is unchanged up to the owner, so everything that
    // matches `<slot> held by <lane>` contiguously still matches.
    expect(result.stdout).toContain(`${theirs} held by lane-a project hexagen-monaco`);
    // And a slot with no `project` file is listed rather than skipped: the file is
    // display only, and a lock written before it existed is not a forgery.
    expect(result.stdout).toContain(`${older} held by lane-a project unknown`);
  });

  test(
    "at the beat pause the staged beat is inside the pool, and never on TMPDIR",
    async () => {
      // The reason the beat is staged where it is. This used to write
      // ${TMPDIR}/cf-gate.beatnew.$$ and rename it onto $LOCK/beat, which was one
      // directory for as long as the lock's parent WAS TMPDIR — and stops being one
      // the moment the pool moves: on midnight the pool is tmpfs and TMPDIR is
      // mergerfs, so the rename becomes copy-then-unlink, the beat is briefly
      // absent at the name, and beat_is_stale reads an absent beat as stale. The
      // next acquirer then reclaims a lock whose holder is alive and heartbeating.
      //
      // Two scratch directories, deliberately DIFFERENT ones: with TMPDIR and the
      // pool in the same directory the assertion could not tell a beat staged
      // beside the lock from one that happened to land in the right place.
      const tmp = scratch();
      const pool = poolAt(scratch());
      const hooks = scratch();
      const marker = join(hooks, "paused-before-beat-mv");
      const { child, done } = startLockIn(
        tmp,
        ["run", "lane-a", "--", "sleep", "30"],
        {
          GATE_LOCK_DIR: pool,
          CF_GATE_HEARTBEAT_SECONDS: "1",
          CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV: marker,
        },
        "sh",
        scratch(),
      );
      try {
        await waitForFile(poolSlot(pool, 0));
        await waitForFile(marker);
        // A refresh is parked with its beat staged, and the staged file is a
        // SIBLING of the slot: in the pool, named after the heartbeat's own pid.
        const staged = readdirSync(pool).filter((entry) =>
          /^gate\.lock\.beatnew\.\d+$/.test(entry),
        );
        expect(staged).toEqual([expect.stringMatching(/^gate\.lock\.beatnew\.\d+$/)]);
        // And nothing at all on TMPDIR: no beat staged for a rename that would cross
        // a filesystem, and no lock of this project's own.
        expect(readdirSync(tmp).filter((entry) => entry.startsWith("cf-gate.beatnew"))).toEqual([]);
        expect(readdirSync(tmp).filter((entry) => entry.startsWith("cf-gate.lock"))).toEqual([]);
      } finally {
        rmSync(marker, { force: true });
        await stopLock(child, done);
      }
      // The staged file goes with the lock it belonged to: the run released that
      // lock, the heartbeat's rename delivered the beat, and what is left in the
      // pool is the marker and nothing else.
      expect(readdirSync(pool).sort()).toEqual([".format"]);
    },
    scaled(30_000),
  );

  test("two acquirers racing into an absent pool both take a slot, and one .format is published", async () => {
    // The `ln` is what makes this safe, and two SEQUENTIAL runs would prove
    // nothing about it. The claim is that the loser of the `ln` reads the winner's
    // marker back and proceeds, rather than refusing a pool it has just written
    // into itself — so both acquirers are held inside the window, between the
    // temp file and the `ln`, and released together.
    const parent = scratch();
    const pool = poolAt(parent);
    const hooks = scratch();
    const twoSlots = { GATE_HOST_SLOTS: "2", CF_GATE_SLOTS: "2" };
    const first = startLockIn(
      parent,
      ["run", "lane-a", "--", "sleep", "1"],
      { ...twoSlots, GATE_LOCK_DIR: pool, CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN: join(hooks, "a") },
      "sh",
      scratch(),
    );
    const second = startLockIn(
      parent,
      ["run", "lane-b", "--", "sleep", "1"],
      { ...twoSlots, GATE_LOCK_DIR: pool, CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN: join(hooks, "b") },
      "sh",
      scratch(),
    );
    try {
      // Two different marker paths and two different cwds, because the point is
      // that they OVERLAP: one shared marker releases them one at a time, and one
      // shared cwd has the second refused as the same worktree before it ever
      // reaches the pool.
      await waitForFile(join(hooks, "a"));
      await waitForFile(join(hooks, "b"));
      // Both are inside the window, which means both have already passed the
      // `mkdir` — so the second one's `mkdir -m 0700` failed with EEXIST against
      // a directory the first one created, and it went on to JUDGE the directory
      // rather than to trust or reject its own mkdir.
      rmSync(join(hooks, "a"), { force: true });
      rmSync(join(hooks, "b"), { force: true });
      const [one, two] = await Promise.all([first.done, second.done]);
      expect({ one: one.status, two: two.status }).toEqual({ one: 0, two: 0 });
      // One slot each, and one slot each is what "both proceed" means for a pool
      // of two: neither was refused for the pool, and neither took the other's.
      const slots = [one, two]
        .map((result) => /at (\S+)/.exec(result.stdout)?.[1] ?? "none")
        .sort();
      expect(slots).toEqual([poolSlot(pool, 0), poolSlot(pool, 1)]);
      // Exactly one marker, holding 1, and no temp file left beside it: the loser
      // of the `ln` deleted its own temp and read the winner's answer back.
      expect(readdirSync(pool).filter((entry) => entry.startsWith(".format"))).toEqual([".format"]);
      expect(readFileSync(join(pool, ".format"), "utf8").trim()).toBe("1");
      // And both slots RELEASED: `sleep 1` ended and each `run` took its lock with
      // it, so what is left in the pool is the marker and nothing else. Neither
      // acquirer is left holding a seat, and no slot is left for the next caller
      // to reclaim.
      expect(readdirSync(pool).sort()).toEqual([".format"]);
    } finally {
      rmSync(join(hooks, "a"), { force: true });
      rmSync(join(hooks, "b"), { force: true });
      await stopLock(first.child, first.done);
      await stopLock(second.child, second.done);
    }
  }, 60_000);
});
