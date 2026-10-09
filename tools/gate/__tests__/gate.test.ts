import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import vitestConfig from "../../../vitest.config";
import { gateEnv } from "./gate-env.js";
import { scaled } from "./wait-scale.js";

// D183 (lane HX3-gate-in-repo) — `yarn gate`. Every test drives the real
// script with CF_GATE_STEPS (one name<TAB>command line per step) and a fresh
// TMPDIR, so no test runs the real suite and no test ever touches the real
// lock. The row's behaviours are pinned: the lock covers ONLY test:cov and
// verify-manifests; a failing step releases it and leaves no heartbeat
// process; a coverage threshold failure fails the gate even when vitest
// exits 0; busy propagates as 75.

const gateSh = fileURLToPath(new URL("../../../scripts/gate.sh", import.meta.url));
const gateLockSh = fileURLToPath(new URL("../../../scripts/gate-lock.sh", import.meta.url));
const packageJson = fileURLToPath(new URL("../../../package.json", import.meta.url));

/**
 * Today's steps, pinned here so a profile can be shown to change one cell and
 * nothing else. This is the list the default gate builds from scratch — the one
 * CI's own steps, in CI's order — and `--print-steps` is how a test reads it
 * without running any of it.
 */
const DEFAULT_STEPS = [
  "check:env\tgate_check_env",
  "build\tyarn build",
  "typecheck\tyarn typecheck",
  "lint\tyarn lint",
  "format:check\tyarn format:check",
  "lint:arch\tyarn lint:arch",
  "sync:check\tyarn sync:check",
  "lint:bytes\tyarn lint:bytes",
  "plan:verify\tyarn plan:verify",
  "arch:inventory\tyarn arch:inventory",
  "nitro-route-scan\tgate_nitro_guard",
  "test:cov\tyarn test:cov",
  'verify-manifests\tsh "$HERE/verify-manifests.sh"',
];

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
    // The shared environment (tools/gate/__tests__/gate-env.ts): CF_GATE_SLOTS is
    // pinned to 1 and the three pool variables are deleted, because all four are
    // host-wide. D188 sets the first (/etc/environment) and a host that has
    // adopted the shared pool exports the rest, and a test that inherits any of
    // them either plants a slot in the operator's real pool or is handed slot 1
    // where the test is asserting about busy. A test that means more slots, or a
    // different pool, still says so in its own env, which is spread last.
    env: gateEnv(dir, env),
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
      // The same shared environment as runGate above — see there for why.
      env: gateEnv(dir, env),
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
async function waitForFile(path: string, timeoutMs = scaled(10_000)): Promise<void> {
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

/** The step lines `--print-steps` resolved, as an array. */
function printedSteps(args: string[], env: Record<string, string> = {}): string[] {
  const r = runGate([...args, "--print-steps"], env);
  if (r.status !== 0) {
    throw new Error(`--print-steps exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout.replace(/\n$/, "").split("\n");
}

/** The `--tagsFilter` expression a step command carries, or "" if it has none. */
function tagsFilterOf(step: string): string {
  return /--tagsFilter '([^']*)'/.exec(step)?.[1] ?? "";
}

/** The tag names a `--tagsFilter` expression mentions, with the `!` markers dropped. */
function tagsInFilter(expression: string): string[] {
  return (expression.match(/!?[A-Za-z][\w-]*/g) ?? []).map((tag) => tag.replace(/^!/, ""));
}

/** The profile names the gate knows, read from the script's own PROFILES list. */
function knownProfiles(): string[] {
  return (/^PROFILES="([^"]*)"/m.exec(readFileSync(gateSh, "utf8"))?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
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

  test("a test step that exits 0 while its output reports failed tests fails the gate with code 96", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        [
          "test:cov",
          'printf " Test Files  1 failed | 3 passed (4)\\n      Tests  1 failed | 10 passed (11)\\n"',
        ],
      ]),
    );
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stderr).toContain(
      "gate: FAILED — step 'test:cov' exited 0 but its output reports failed tests",
    );
    expect(r.stderr).toContain("1 failed | 3 passed (4)");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("a failed summary and a coverage failure on one exit-0 step are both reported, with code 96", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        [
          "test:cov",
          'printf " Test Files  1 failed | 3 passed (4)\\nERROR: Coverage for statements does not meet global threshold\\n"',
        ],
      ]),
    );
    expect(r.status).toBe(96);
    expect(r.stderr).toContain(
      "gate: FAILED — step 'test:cov' exited 0 but its output reports failed tests",
    );
    expect(r.stderr).toContain("a coverage threshold failure was reported");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("a test step that exits 0 while vitest reports unhandled errors fails the gate with code 96", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        [
          "test:cov",
          'printf "Vitest caught 1 unhandled error during the test run.\\nThis might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.\\n"',
        ],
      ]),
    );
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stderr).toContain(
      "gate: FAILED — step 'test:cov' exited 0 but its output reports unhandled errors",
    );
    expect(r.stderr).toContain("Vitest caught 1 unhandled error during the test run.");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("a clean summary and a title that holds the word failed do not fail the gate", () => {
    const r = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        [
          "test:cov",
          'printf " Test Files  3 passed (3)\\n      Tests  0 failed | 12 passed (12)\\n \\xe2\\x9c\\x93 a refund that failed is retried  12ms\\nstdout | x > Tests 3 failed earlier in this log line\\n[h3] [unhandled] H3Error: boom\\nUnhandled Rejection is handled by the app\\n"',
        ],
      ]),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stderr).not.toContain("exited 0 but its output reports");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("a failing test step fails the gate with its own code whatever the scan finds", () => {
    // The scan runs on test:cov (so the summary is present and matched), but a
    // non-zero exit keeps today's path and the step's own code — the scan can
    // never override a step that already failed (N1).
    const withSummary = runGate(
      ["--lane", "lane-b"],
      stepsEnv([
        [
          "test:cov",
          "sh -c 'printf \" Test Files  1 failed | 3 passed (4)\\n      Tests  1 failed | 10 passed (11)\\n\"; exit 3'",
        ],
      ]),
    );
    expect(withSummary.status).toBe(3);
    expect(withSummary.stderr).toContain("FAILED at step 'test:cov' (exit 3)");
    expect(withSummary.stderr).not.toContain("exited 0 but its output reports");

    // No summary, same exit code: identical result.
    const withoutSummary = runGate(
      ["--lane", "lane-b"],
      stepsEnv([["test:cov", 'sh -c "exit 3"']]),
    );
    expect(withoutSummary.status).toBe(3);
    expect(withoutSummary.stderr).toContain("FAILED at step 'test:cov' (exit 3)");
    expect(withoutSummary.stderr).not.toContain("exited 0 but its output reports");
  });

  test("the failed summary is found through ANSI colour codes", () => {
    // Vitest colour-wraps its summary; the ESC bytes are real, the newlines are
    // printf escapes, so the gate must strip colour before anchoring (N2/N3).
    const C = "\u001b";
    const cmd = `printf '${C}[31m Test Files  1 failed | 3 passed (4)${C}[0m\\n${C}[32m      Tests  1 failed | 10 passed (11)${C}[0m\\n'`;
    const r = runGate(["--lane", "lane-b"], stepsEnv([["test:cov", cmd]]));
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("<== test:cov: exit 0");
    expect(r.stderr).toContain("exited 0 but its output reports failed tests");
    expect(existsSync(join(r.dir, "cf-gate.lock"))).toBe(false);
  });

  test("the output scan applies under a profile as well", () => {
    // The profile keeps the step's NAME, so run_test_cov still wraps whatever
    // command the profile resolved to — the scan must fire there too.
    const r = runGate(["--lane", "lane-b", "--profile", "midnight"], {
      ...stepsEnv([
        [
          "test:cov",
          'printf " Test Files  1 failed | 3 passed (4)\\n      Tests  1 failed | 10 passed (11)\\n"',
        ],
      ]),
      CF_GATE_TEST_PRINT_LISTING: "1",
    });
    expect(r.status).toBe(96);
    expect(r.stderr).toContain("exited 0 but its output reports failed tests");
  });

  test("a scan that cannot run fails the gate and is not read as clean", () => {
    // Copy gate.sh and gate-lock.sh into a temp dir WITHOUT test-output-scan.sh,
    // so run_test_cov's scan call cannot find the script. The gate must exit 2
    // (never 0, never 96) and the lock must be released.
    const scriptDir = mkdtempSync(join(tmpdir(), "cf-gate-temp-"));
    dirs.push(scriptDir);
    const tempGate = join(scriptDir, "gate.sh");
    const tempLock = join(scriptDir, "gate-lock.sh");
    copyFileSync(gateSh, tempGate);
    copyFileSync(gateLockSh, tempLock);
    chmodSync(tempGate, 0o755);
    chmodSync(tempLock, 0o755);

    const dir = scratch();
    const r = spawnSync("sh", [tempGate, "--lane", "lane-b"], {
      encoding: "utf8",
      env: gateEnv(dir, stepsEnv([["test:cov", "true"]])),
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("the test output scan could not run");
    expect(existsSync(join(dir, "cf-gate.lock"))).toBe(false);
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
      CF_GATE_NITRO_PREPARE:
        'printf "export const nitroRoutes = {}\\n" > "$CF_GATE_NITRO_MANIFEST"',
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

  test(
    "a lock lost during a locked step fails the gate as lock lost",
    () => {
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
    },
    scaled(15_000),
  );

  test(
    "a lock replaced by another holder fails the gate as lock lost, and the replacement survives cleanup",
    () => {
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
    },
    scaled(15_000),
  );

  test(
    "a lock lost between locked steps fails the gate at the next step's boundary",
    async () => {
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
    },
    scaled(15_000),
  );

  test(
    "a failed release is reported by the gate, which does not report green",
    () => {
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
    },
    scaled(15_000),
  );

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

/**
 * D187 (lane MH1-gate-profiles) — `yarn gate --profile <name>` and
 * `--print-steps`. A profile is for a host whose suite cannot be all green: it
 * swaps the test step's command for one that filters the host-sensitive tests
 * by tag, and it names what it left out. What it must NOT do is change anything
 * else quietly, so the default list is pinned whole and the profiled list is
 * pinned as that same list with exactly one cell replaced. The tag
 * declarations are read from the config OBJECT rather than from its text, so a
 * declaration that exists only in a comment cannot satisfy this.
 */
describe("yarn gate --profile", () => {
  test("no profile runs today's steps, unchanged", () => {
    expect(printedSteps([])).toEqual(DEFAULT_STEPS);
  });

  test("the midnight profile replaces exactly one step, and runs no coverage", () => {
    const profiled = printedSteps(["--profile", "midnight"]);
    expect(profiled).toEqual(
      DEFAULT_STEPS.map((line) =>
        line.startsWith("test:cov\t")
          ? "test:cov\tyarn vitest run --tagsFilter '!golden-bytes && !cpu-bound' --testTimeout 20000"
          : line,
      ),
    );
    // No --coverage under a profile: a filtered suite cannot cover what it did
    // not run, so a local threshold would be a number this run did not earn.
    // GitHub CI enforces 100% on the full run, with nothing filtered.
    expect(profiled.join("\n")).not.toContain("--coverage");
  });

  test("an unknown profile is refused, not run as the default gate", () => {
    // CF_GATE_STEPS is injected as every other case here does, so a mutant that
    // falls through to the default gate runs one `true` step rather than the
    // real suite — and still fails this test, which is the whole point.
    const r = runGate(["--profile", "no-such-profile"], stepsEnv([["build", "true"]]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown profile: no-such-profile");
    // It names the profile it does know, so the refusal is an answer.
    expect(r.stderr).toContain("midnight");
    expect(r.stdout).not.toContain("==> [1/1] build");
  });

  test("a --profile without a value, and one that is not a name, are refused", () => {
    const missing = runGate(["--profile"], stepsEnv([["build", "true"]]));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("missing value for --profile");

    // The name is matched as a shell pattern, so `*` would otherwise match any
    // profile at all — a typo silently resolving to a run the caller did not ask
    // for is the failure the refusal exists to prevent.
    const glob = runGate(["--profile", "*"], stepsEnv([["build", "true"]]));
    expect(glob.status).toBe(2);
    expect(glob.stderr).toContain("invalid profile name");

    // An EMPTY value is the same fall-through wearing a profile's clothes: every
    // check downstream reads an empty PROFILE as no profile at all, so
    // `--profile ''` ran the DEFAULT gate — filtering nothing, enforcing
    // coverage — under a flag that promised a filtered, timeout-carrying run.
    const empty = runGate(["--profile", ""], stepsEnv([["build", "true"]]));
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("invalid profile name");
    expect(empty.stdout).not.toContain("==> [1/1] build");

    // And it is refused even when a real profile came first: the flag's meaning
    // is whatever came LAST, so `--profile midnight --profile ''` is an empty
    // profile asked for, not a profile named by the pair.
    const reset = runGate(
      ["--profile", "midnight", "--profile", ""],
      stepsEnv([["build", "true"]]),
    );
    expect(reset.status).toBe(2);
    expect(reset.stderr).toContain("invalid profile name");
    expect(reset.stdout).not.toContain("==> [1/1] build");
  });

  test("--print-steps prints the resolved steps and runs nothing", () => {
    const dir = scratch();
    const stepMarker = join(dir, "step-ran");
    const listMarker = join(dir, "list-ran");
    const r = runGate(["--profile", "midnight", "--print-steps"], {
      TMPDIR: dir,
      CF_GATE_LIST_EXCLUDED: `touch ${listMarker}`,
      ...stepsEnv([["build", `touch ${stepMarker}`]]),
    });
    expect(r.status).toBe(0);
    // It reports the step that WOULD run — the injected one, whatever it is.
    expect(r.stdout).toBe(`build\ttouch ${stepMarker}\n`);
    // And it neither ran a step nor listed a test: asking what runs must not
    // cost a collection, and must not take the lock.
    expect(existsSync(stepMarker)).toBe(false);
    expect(existsSync(listMarker)).toBe(false);
    expect(existsSync(join(dir, "cf-gate.lock"))).toBe(false);
  });

  test("a profiled run says coverage is not enforced, and names what it excluded", () => {
    const r = runGate(["--profile", "midnight"], {
      ...stepsEnv([["test:cov", 'printf "the tests ran\\n"']]),
      CF_GATE_LIST_EXCLUDED: 'printf "excluded: one golden\\n"',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "coverage thresholds are not enforced under a profile; GitHub CI enforces 100% on the full run",
    );
    expect(r.stdout).toContain("EXCLUDES");
    expect(r.stdout).toContain("excluded: one golden");
    // Before the tests, not after: the names describe the run about to happen,
    // which is the only moment a reader is still in time to want them.
    expect(r.stdout.indexOf("excluded: one golden")).toBeLessThan(
      r.stdout.indexOf("the tests ran"),
    );
    // The caveat is the PROFILE's to carry: the default gate says neither,
    // because it does enforce coverage.
    const plain = runGate(["--lane", "lane-b"], stepsEnv([["test:cov", "true"]]));
    expect(plain.stdout).not.toContain("not enforced under a profile");
  });

  test("the exclusion listing is derived from the profile's own filter, not a second list of tags", () => {
    // The banner has to name the tests the run actually skips. Spelled out as its
    // own `'golden-bytes || cpu-bound'`, it is a second list to forget: add a tag
    // to the profile's filter, or a second profile, and the run stays green while
    // the "excluded" line names tests this run did not skip — the one drift a
    // reader cannot detect, because they are reading the run's own output.
    // CF_GATE_TEST_PRINT_LISTING reports the resolved command instead of running
    // it, so the derived filter is readable without a collection.
    const listingOf = (profile: string): string => {
      const r = runGate(["--profile", profile], {
        ...stepsEnv([["test:cov", "true"]]),
        CF_GATE_TEST_PRINT_LISTING: "1",
      });
      expect(r.status).toBe(0);
      return tagsFilterOf(/yarn vitest list --tagsFilter '[^']*'/.exec(r.stdout)?.[0] ?? "");
    };
    const runFilterOf = (profile: string): string =>
      tagsFilterOf(
        printedSteps(["--profile", profile]).find((line) => line.startsWith("test:cov\t")) ?? "",
      );

    // The profiles come from the script's own PROFILES list, so one added later is
    // covered without touching this test — and midnight is asserted to be in it,
    // so a reworded PROFILES line fails here rather than skipping the sweep.
    const profiles = knownProfiles();
    expect(profiles).toContain("midnight");
    for (const profile of profiles) {
      const listed = listingOf(profile);
      const runs = runFilterOf(profile);
      // The exact complement of what the test step runs — derived where the
      // profile is, not written out again here or in the script.
      expect(listed).toBe(`!(${runs})`);
      // The same tag set on both sides, so the listing and the run cannot have
      // parted company even if the negation were ever rewritten by hand.
      expect(tagsInFilter(listed).sort()).toEqual(tagsInFilter(runs).sort());
    }
    // What that means today, pinned on the profile that exists. The `!( … )` is
    // vitest's own grammar, not an approximation of it: parseUnaryExpression
    // takes a NOT over parsePrimaryExpression's parenthesised group.
    expect(runFilterOf("midnight")).toBe("!golden-bytes && !cpu-bound");
    expect(listingOf("midnight")).toBe("!(!golden-bytes && !cpu-bound)");
  });

  test("a profiled run that fails before the test step never pays for the collection", () => {
    // Naming the exclusions means collecting the suite, which measured 18.5 s
    // and about 10 cores on this host. A gate that fails at build must not pay
    // it for a test step it never reaches — so the listing belongs inside the
    // test step, not at the top of the run.
    const dir = scratch();
    const listMarker = join(dir, "list-ran");
    const r = runGate(["--profile", "midnight"], {
      TMPDIR: dir,
      ...stepsEnv([
        ["build", 'sh -c "exit 1"'],
        ["test:cov", "true"],
      ]),
      CF_GATE_LIST_EXCLUDED: `touch ${listMarker}`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAILED at step 'build' (exit 1)");
    expect(existsSync(listMarker)).toBe(false);
    expect(r.stdout).not.toContain("EXCLUDES");
  });

  test("a listing that cannot run does not fail a profiled gate", () => {
    // Informational output must not become a step: a gate whose test step fails
    // on the naming of its exclusions fails for the wrong reason, and the
    // exclusion names are a courtesy, not a result.
    const r = runGate(["--profile", "midnight"], {
      ...stepsEnv([["test:cov", "true"]]),
      CF_GATE_LIST_EXCLUDED: 'sh -c "exit 3"',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("could not list the tests this profile excludes");
  });
});

describe("the tags the midnight profile filters", () => {
  const tags = vitestConfig.test?.tags ?? [];

  test("golden-bytes and cpu-bound are declared, each naming the host fact", () => {
    // The descriptions are the record of WHY a host needs a profile: which
    // instruction set the bytes depend on, and which deadline is internal.
    expect(tags.map((tag) => tag.name)).toEqual(["golden-bytes", "cpu-bound"]);
    const byName = new Map(tags.map((tag) => [tag.name, tag.description ?? ""]));
    expect(byName.get("golden-bytes")).toContain("AVX2");
    expect(byName.get("golden-bytes")).toContain("BYTES");
    expect(byName.get("cpu-bound")).toContain("deadline");
    expect(byName.get("cpu-bound")).toContain("--testTimeout");
  });

  test("no config turns strictTags off", () => {
    // strictTags defaults to TRUE, and that default is the only thing making an
    // undeclared tag a failure rather than a name that quietly means nothing.
    // Checked on the root AND on every project block, because a project
    // inherits the rest of the config and can lose this one key on its own.
    const blocks = [vitestConfig.test, ...(vitestConfig.test?.projects ?? [])];
    for (const block of blocks) {
      const turnedOff =
        typeof block === "object" &&
        block !== null &&
        (block as { strictTags?: unknown }).strictTags;
      expect(turnedOff).toBeUndefined();
    }
  });

  test("every tag the gate's filter names is declared in the config", () => {
    // The filter lives in gate.sh and the declarations here: a tag added to one
    // and not the other would filter a name vitest refuses to run under. The
    // exclusion listing is the same filter negated, so one check covers both.
    const step = printedSteps(["--profile", "midnight"]).find((line) =>
      line.startsWith("test:cov\t"),
    );
    const filtered = tagsInFilter(tagsFilterOf(step ?? ""));
    expect(filtered).toEqual(["golden-bytes", "cpu-bound"]);
    for (const tag of filtered) {
      expect(tags.map((declared) => declared.name)).toContain(tag);
    }
  });
});
