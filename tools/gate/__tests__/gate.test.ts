import { spawn, spawnSync } from "node:child_process";
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
import { afterEach, describe, expect, test } from "vitest";

// D183 (lane HX3-gate-in-repo) — `yarn gate`. Every test drives the real
// script with CF_GATE_STEPS (one name<TAB>command line per step) and a fresh
// TMPDIR, so no test runs the real suite and no test ever touches the real
// lock. The row's behaviours are pinned: the lock covers ONLY test:cov and
// verify-manifests; a failing step releases it and leaves no heartbeat
// process; a coverage threshold failure fails the gate even when vitest
// exits 0; busy propagates as 75.

const gateSh = fileURLToPath(new URL("../../../scripts/gate.sh", import.meta.url));
const packageJson = fileURLToPath(new URL("../../../package.json", import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-gate-run-"));
  dirs.push(dir);
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** The TMPDIR this run's lock lived under. */
  dir: string;
}

function stepsEnv(entries: Array<[string, string]>): Record<string, string> {
  return { CF_GATE_STEPS: entries.map(([name, cmd]) => `${name}\t${cmd}`).join("\n") };
}

function runGate(args: string[], env: Record<string, string> = {}, timeout = 15_000): RunResult {
  const dir = scratch();
  const result = spawnSync("sh", [gateSh, ...args], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, ...env },
    timeout,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    dir,
  };
}

/** Seeds a live, fresh lock into the given TMPDIR, as another lane would hold it. */
function seedBusyLock(dir: string, owner = "lane-a"): string {
  const lock = join(dir, "cf-gate.lock");
  mkdirSync(lock, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(lock, "owner"), `${owner}\n`);
  writeFileSync(join(lock, "started"), `${now}\n`);
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  writeFileSync(join(lock, "beat"), `${now}\n`);
  return lock;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run the gate without waiting for it — for tests that race its boundaries. */
function runGateAsyncIn(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [gateSh, ...args], {
      env: { ...process.env, TMPDIR: dir, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr, dir }));
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

function heartbeatPidOf(stdout: string): number {
  const match = /gate: heartbeat pid (\d+)/.exec(stdout);
  if (!match) throw new Error(`no heartbeat pid line in:\n${stdout}`);
  return Number(match[1]);
}

describe("yarn gate", () => {
  test("parses as POSIX sh", () => {
    const result = spawnSync("sh", ["-n", gateSh], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("package.json wires gate to the script", () => {
    expect(JSON.parse(readFileSync(packageJson, "utf8")).scripts.gate).toBe("sh scripts/gate.sh");
  });

  test("names yarn install --immutable as the CI step the gate does not run, and the TEST_DATABASE_URL-only suites", () => {
    const r = runGate(["--lane", "lane-b"], stepsEnv([["build", "true"]]));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yarn install --immutable");
    expect(r.stdout).toContain("does not run");
    // The two real-Postgres concurrency suites skip themselves without
    // TEST_DATABASE_URL (CI sets it on its Test step); the gate says so
    // rather than letting a green run read as CI-equivalent.
    expect(r.stdout).toContain("TEST_DATABASE_URL");
    expect(r.stdout).toContain("skip themselves");
  });

  test("a busy lock makes the gate exit 75 and leaves the holder's lock alone", () => {
    const dir = scratch();
    const lock = seedBusyLock(dir, "lane-a");
    const r = runGate(["--lane", "lane-b"], { TMPDIR: dir, ...stepsEnv([["test:cov", "true"]]) });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain("busy");
    expect(r.stderr).toContain("lane-a");
    expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("lane-a");
  });

  test("the lock is not held during build, and is held during the locked steps", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        ["build", 'test ! -d "$TMPDIR/cf-gate.lock"'],
        ["test:cov", 'test -d "$TMPDIR/cf-gate.lock"'],
        ["verify-manifests", 'test -d "$TMPDIR/cf-gate.lock"'],
      ]),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("<== build: exit 0");
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stdout).toContain("<== verify-manifests: exit 0");
    // The lock is released as soon as the last locked step passes.
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
    expect(r.stdout).toContain("gate: lock released, heartbeat stopped");
    expect(r.stdout).toContain("heartbeat pid");
  });

  test("a failing locked step releases the lock and leaves no heartbeat process", () => {
    const r = runGate(["--lane", "lane-b"], stepsEnv([["test:cov", 'sh -c "exit 3"']]));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("FAILED at step 'test:cov' (exit 3)");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
    const hb = heartbeatPidOf(r.stdout);
    expect(isAlive(hb)).toBe(false);
  });

  test("a coverage threshold failure fails the gate even when vitest exits 0", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        ["test:cov", 'printf "ERROR: Coverage for statements does not meet global threshold\\n"'],
      ]),
    );
    expect(r.status).toBe(1);
    // The real exit code is printed even though the gate fails on the scan.
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stdout).toContain("ERROR: Coverage");
    expect(r.stderr).toContain("coverage threshold failure");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("a failing nitro prepare fails the guard, even with a stale manifest present", () => {
    const dir = scratch();
    const manifest = join(dir, "nitro-routes.d.ts");
    // A stale manifest from an earlier prepare, sitting where the guard will
    // look: the failure must not leave it there for the scan to bless.
    writeFileSync(manifest, "export const nitroRoutes = { maybeStale: '__tests__/old.ts' }\n");
    const r = runGate(["--lane", "lane-b"], {
      TMPDIR: dir,
      CF_GATE_NITRO_MANIFEST: manifest,
      CF_GATE_NITRO_PREPARE: 'sh -c "exit 5"',
      ...stepsEnv([["nitro-route-scan", "gate_nitro_guard"]]),
    });
    expect(r.status).toBe(5);
    expect(r.stdout).toContain("::error::nitro prepare failed");
    expect(r.stderr).toContain("FAILED at step 'nitro-route-scan' (exit 5)");
    // The stale manifest was removed before preparing, and never scanned.
    expect(existsSync(manifest)).toBe(false);
  });

  test("a passing prepare rescans the manifest it rebuilt", () => {
    const dir = scratch();
    const manifest = join(dir, "nitro-routes.d.ts");
    const r = runGate(["--lane", "lane-b"], {
      TMPDIR: dir,
      CF_GATE_NITRO_MANIFEST: manifest,
      CF_GATE_NITRO_PREPARE: 'printf "export const nitroRoutes = {}\\n" > "$CF_GATE_NITRO_MANIFEST"',
      ...stepsEnv([["nitro-route-scan", "gate_nitro_guard"]]),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nitro route manifest is free of test files.");
  });

  test("a rebuilt manifest naming a test file fails the scan", () => {
    const dir = scratch();
    const manifest = join(dir, "nitro-routes.d.ts");
    const r = runGate(["--lane", "lane-b"], {
      TMPDIR: dir,
      CF_GATE_NITRO_MANIFEST: manifest,
      CF_GATE_NITRO_PREPARE:
        'printf "export const nitroRoutes = { x: \\"__tests__/ smuggled.ts\\" }\\n" > "$CF_GATE_NITRO_MANIFEST"',
      ...stepsEnv([["nitro-route-scan", "gate_nitro_guard"]]),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::A test file was scanned as a Nitro route");
    expect(r.stderr).toContain("FAILED at step 'nitro-route-scan' (exit 1)");
  });

  test("a prepare that succeeds without writing a manifest fails closed", () => {
    const dir = scratch();
    const manifest = join(dir, "nitro-routes.d.ts");
    const r = runGate(["--lane", "lane-b"], {
      TMPDIR: dir,
      CF_GATE_NITRO_MANIFEST: manifest,
      CF_GATE_NITRO_PREPARE: "true",
      ...stepsEnv([["nitro-route-scan", "gate_nitro_guard"]]),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::Nitro route manifest not found");
    expect(r.stderr).toContain("FAILED at step 'nitro-route-scan' (exit 1)");
  });

  test("the gate stops at the first failing step by name, and later steps never run", () => {
    const dir = scratch();
    const marker = join(dir, "later-ran");
    const r = runGate(["--lane", "lane-b"], {
      TMPDIR: dir,
      ...stepsEnv([
        ["lint", "true"],
        ["typecheck", 'sh -c "exit 2"'],
        ["lint:bytes", `touch ${marker}`],
      ]),
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("<== lint: exit 0");
    expect(r.stdout).toContain("<== typecheck: exit 2");
    expect(r.stderr).toContain("FAILED at step 'typecheck' (exit 2)");
    expect(existsSync(marker)).toBe(false);
  });

  test("the heartbeat refreshes the beat while the lock is held", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      {
        CF_GATE_HEARTBEAT_SECONDS: "1",
        ...stepsEnv([
          // The fake step holds the lock for a deliberate 2s so a 1s tick must
          // land inside it; date +%s makes anything shorter flaky at second
          // granularity. The 15s timeout is calibrated to that hold, not
          // raised to hide a flake.
          ["test:cov", "sleep 2"],
          [
            "verify-manifests",
            'test "$(cat "$TMPDIR/cf-gate.lock/beat")" -gt "$(cat "$TMPDIR/cf-gate.lock/started")"',
          ],
        ]),
      },
      15_000,
    );
    expect(r.status).toBe(0);
  });

  test("a lock lost during a locked step fails the gate as lock lost", () => {
    // The step removes the lock out from under the gate; the heartbeat's next
    // tick fails, the loop dies leaving its marker, and the boundary check
    // after the step must fail the gate — not release a phantom and go green.
    const r = runGate(
      ["--lane", "lane-b"],
      {
        CF_GATE_HEARTBEAT_SECONDS: "1",
        ...stepsEnv([["test:cov", 'rm -rf "$TMPDIR/cf-gate.lock"; sleep 2']]),
      },
      15_000,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lock lost after step 'test:cov'");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  }, 15_000);

  test("a lock replaced by another holder fails the gate as lock lost, and the replacement survives cleanup", () => {
    // The reclaim scenario end to end: the lock is replaced by a fresh holder
    // while the gate is mid-step. The gate must fail as lock lost, and its
    // cleanup must leave the replacement's lock exactly as it found it.
    const dir = scratch();
    const lock = join(dir, "cf-gate.lock");
    const replace = [
      'rm -rf "$TMPDIR/cf-gate.lock"',
      'mkdir "$TMPDIR/cf-gate.lock"',
      'printf "lane-c\\n" > "$TMPDIR/cf-gate.lock/owner"',
      `printf "${process.pid}\\n" > "$TMPDIR/cf-gate.lock/pid"`,
      'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/started"',
      'printf "$(date +%s)\\n" > "$TMPDIR/cf-gate.lock/beat"',
      "sleep 2",
    ].join("; ");
    const r = runGate(
      ["--lane", "lane-b"],
      {
        TMPDIR: dir,
        CF_GATE_HEARTBEAT_SECONDS: "1",
        ...stepsEnv([["test:cov", replace]]),
      },
      15_000,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lock lost after step 'test:cov'");
    expect(readFileSync(join(lock, "owner"), "utf8").trim()).toBe("lane-c");
    expect(existsSync(lock)).toBe(true);
  }, 15_000);

  test("a lock lost between locked steps fails the gate at the next step's boundary", async () => {
    // The pause hook holds the gate before each locked step; the handshake
    // removes the lock in exactly the between-steps window the check covers.
    const dir = scratch();
    const marker = join(dir, "paused-before-step");
    const pending = runGateAsyncIn(dir, ["--lane", "lane-b"], {
      ...stepsEnv([
        ["test:cov", "true"],
        ["verify-manifests", "true"],
      ]),
      CF_GATE_TEST_PAUSE_BEFORE_STEP: marker,
    });
    await waitForFile(marker);
    rmSync(marker);
    await waitForFile(marker);
    rmSync(join(dir, "cf-gate.lock"), { recursive: true, force: true });
    rmSync(marker);
    const r = await pending;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lock lost before step 'verify-manifests'");
    expect(existsSync(join(dir, "cf-gate.lock"))).toBe(false);
  }, 15_000);

  test("a failed release is reported by the gate, which does not report green", () => {
    // The last locked step makes the lock directory read-only, so the gate's
    // release cannot remove it: the gate must report the failed release and
    // exit non-zero, never print the tally over a lingering lock.
    const dir = scratch();
    const lock = join(dir, "cf-gate.lock");
    const r = runGate(
      ["--lane", "lane-b"],
      {
        TMPDIR: dir,
        ...stepsEnv([
          ["test:cov", "true"],
          ["verify-manifests", 'chmod 555 "$TMPDIR/cf-gate.lock"'],
        ]),
      },
      15_000,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAILED to release the lock");
    expect(existsSync(lock)).toBe(true);
    // Let the cleanup remove the scratch dir again.
    chmodSync(lock, 0o755);
  }, 15_000);

  test("a run where every step passes prints the full tally", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        ["lint", "true"],
        ["lint:bytes", "true"],
      ]),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("gate: 2/2 steps passed");
  });

  test("check:env stays the conditional no-op when no script exists", () => {
    const r = runGate(["--lane", "lane-b"], stepsEnv([["check:env", "gate_check_env"]]));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no check:env script — skipping");
  });

  test("an unknown flag exits 2, and so does a --lane without a value", () => {
    const unknown = runGate(["--wat"], stepsEnv([["build", "true"]]));
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("usage");

    const missing = runGate(["--lane"], stepsEnv([["build", "true"]]));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("missing value for --lane");
  });

  test("an invalid lane id is refused", () => {
    const r = runGate(["--lane", "bad lane!"], stepsEnv([["build", "true"]]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("invalid lane id");
  });

  test("a malformed or empty CF_GATE_STEPS is refused before step one", () => {
    const noCommand = runGate(["--lane", "lane-b"], stepsEnv([["build", ""]]));
    expect(noCommand.status).toBe(2);
    expect(noCommand.stderr).toContain("has no command");

    const empty = runGate(["--lane", "lane-b"], { CF_GATE_STEPS: "" });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("no steps to run");
  });

  test("a non-numeric heartbeat interval is refused", () => {
    const r = runGate(["--lane", "lane-b"], {
      CF_GATE_HEARTBEAT_SECONDS: "soon",
      ...stepsEnv([["build", "true"]]),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CF_GATE_HEARTBEAT_SECONDS");
  });
});
