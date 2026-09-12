import { describe, test, expect, afterEach } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { formatEvent, appendEvent } from "../emit.js";
import { readEvents } from "../events.js";

const clock = (): string => "2026-09-07T16:55:43Z";

const waveEventSh = fileURLToPath(
  new URL("../../../../scripts/wave-event.sh", import.meta.url),
);
const dispatchLaneSh = fileURLToPath(
  new URL("../../../../.claude/skills/orchestrate-wave/scripts/dispatch-lane.sh", import.meta.url),
);

// dispatch-lane.sh is the operator's zsh tool (quoting relies on zsh). GitHub
// Linux runners do not ship zsh; skip those tests rather than spawnSync ENOENT.
// wave-event.sh (the product writer it calls) is POSIX sh and is fully tested.
const hasZsh = spawnSync("zsh", ["-c", "true"], { stdio: "ignore" }).status === 0;
const zshSkip = hasZsh
  ? undefined
  : "zsh is not on PATH — dispatch-lane.sh stays zsh (operator tool; quoting relies on zsh); CI Linux runners do not ship it";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wave-emit-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("formatEvent (plan §2.1, D103)", () => {
  test("round-trips through W1's readEvents to the same object, stamping ts from the injected clock", () => {
    const input = {
      wave: "S",
      lane: "s4",
      stage: "remediate" as const,
      event: "settled" as const,
      pr: 218,
      round: 1,
      detail: { fixed: 5, refuted: 2, mutations: 3, mutationsBit: 3 },
    };
    const line = formatEvent(input, clock);
    expect(line.endsWith("\n")).toBe(true);
    expect(readEvents(line)).toEqual({
      events: [{ ...input, ts: "2026-09-07T16:55:43Z" }],
      truncated: false,
      rejected: [],
    });
  });

  test("a ts present on the input is kept verbatim, not re-stamped", () => {
    const line = formatEvent(
      {
        ts: "2000-01-01T00:00:00Z",
        wave: "S",
        lane: "s4",
        stage: "dispatch",
        event: "started",
      },
      clock,
    );
    expect(readEvents(line).events[0]?.ts).toBe("2000-01-01T00:00:00Z");
  });

  test("omits the optional fields when absent — nothing is defaulted", () => {
    const line = formatEvent(
      { wave: "S", lane: "s4", stage: "dispatch", event: "started" },
      clock,
    );
    expect(JSON.parse(line)).toEqual({
      ts: "2026-09-07T16:55:43Z",
      wave: "S",
      lane: "s4",
      stage: "dispatch",
      event: "started",
    });
  });

  test("an unknown stage throws with the vocabulary in the message", () => {
    const input = { wave: "S", lane: "s4", stage: "deploy", event: "started" };
    expect(() => formatEvent(input as never, clock)).toThrow(
      /stage is one of: dispatch\|implement\|gate\|review\|remediate\|sweep\|merge\|record/,
    );
  });

  test("an unknown event kind throws with the vocabulary in the message", () => {
    const input = { wave: "S", lane: "s4", stage: "gate", event: "skipped" };
    expect(() => formatEvent(input as never, clock)).toThrow(/event is one of: started\|settled\|failed/);
  });
});

describe("appendEvent (the thin impure edge)", () => {
  test("writes formatEvent's line through the injected appendFile, never touching disk itself", async () => {
    const appended: { path: string; data: string }[] = [];
    await appendEvent(
      "/nonexistent/events.jsonl",
      { wave: "S", lane: "s4", stage: "merge", event: "settled" },
      { appendFile: async (path, data) => void appended.push({ path, data }), clock },
    );
    expect(appended).toEqual([
      {
        path: "/nonexistent/events.jsonl",
        data: formatEvent({ wave: "S", lane: "s4", stage: "merge", event: "settled" }, clock),
      },
    ]);
  });

  test("an invalid input throws before appendFile is called", async () => {
    let calls = 0;
    await expect(
      appendEvent(
        "/tmp/events.jsonl",
        { wave: "S", lane: "s4", stage: "deploy" } as never,
        { appendFile: async () => void calls++, clock },
      ),
    ).rejects.toThrow(/invalid wave event/);
    expect(calls).toBe(0);
  });
});

describe("scripts/wave-event.sh agrees with formatEvent byte-for-byte", () => {
  test("a minimal event", () => {
    const dir = tempDir();
    execFileSync("sh", [waveEventSh, dir, "W3", "l1", "dispatch", "started"]);
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent({ ts, wave: "W3", lane: "l1", stage: "dispatch", event: "started" }, clock),
    );
  });

  test("an event with --pr, --round and --detail", () => {
    const dir = tempDir();
    const detail = '{"fixed":5,"refuted":2,"mutations":3,"mutationsBit":3}';
    execFileSync("sh", [
      waveEventSh,
      dir,
      "W3",
      "l1",
      "remediate",
      "settled",
      "--pr",
      "12",
      "--round",
      "2",
      "--detail",
      detail,
    ]);
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent(
        {
          ts,
          wave: "W3",
          lane: "l1",
          stage: "remediate",
          event: "settled",
          pr: 12,
          round: 2,
          detail: { fixed: 5, refuted: 2, mutations: 3, mutationsBit: 3 },
        },
        clock,
      ),
    );
  });

  test("an unknown stage exits 2 with the vocabulary on stderr and appends nothing", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "events.jsonl");
    writeFileSync(log, "sentinel\n");
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, dir, "W3", "l1", "deploy", "started"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("dispatch implement gate review remediate sweep merge record");
    expect(readFileSync(log, "utf8")).toBe("sentinel\n");
  });

  test("an unknown event exits 2 and the log file is not even created", () => {
    const dir = tempDir();
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, dir, "W3", "l1", "gate", "skipped"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("started settled failed");
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
  });

  test("a lane name with a quote exits 2 and the log file is unchanged", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "events.jsonl");
    writeFileSync(log, "sentinel\n");
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, dir, "W3", 'l"1', "dispatch", "started"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
    expect(readFileSync(log, "utf8")).toBe("sentinel\n");
  });

  test("--detail '[1]' exits 2 and the log file is unchanged", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "events.jsonl");
    writeFileSync(log, "sentinel\n");
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, dir, "W3", "l1", "dispatch", "started", "--detail", "[1]"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("--detail must be a JSON object");
    expect(readFileSync(log, "utf8")).toBe("sentinel\n");
  });

  test("--detail '{bad' exits 2 and the log file is unchanged", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "events.jsonl");
    writeFileSync(log, "sentinel\n");
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, dir, "W3", "l1", "dispatch", "started", "--detail", "{bad"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("--detail must be a JSON object");
    expect(readFileSync(log, "utf8")).toBe("sentinel\n");
  });

  test("standalone invocation with 4 args and LOGDIR environment variable", () => {
    const dir = tempDir();
    execFileSync("sh", [waveEventSh, "W3", "l1", "dispatch", "started"], {
      env: { ...process.env, LOGDIR: dir },
    });
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent({ ts, wave: "W3", lane: "l1", stage: "dispatch", event: "started" }, clock),
    );
  });

  test("standalone invocation with --logdir flag", () => {
    const dir = tempDir();
    execFileSync("sh", [waveEventSh, "--logdir", dir, "W3", "l1", "implement", "settled", "--pr", "99"]);
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent({ ts, wave: "W3", lane: "l1", stage: "implement", event: "settled", pr: 99 }, clock),
    );
  });

  test("standalone invocation with default logdir derived from wave name", () => {
    const waveName = `WTest${Date.now()}`;
    const expectedDir = join(homedir(), ".waves", `wave-${waveName}`);
    dirs.push(expectedDir);
    execFileSync("sh", [waveEventSh, waveName, "l1", "dispatch", "started"], {
      env: { ...process.env, LOGDIR: "" },
    });
    expect(existsSync(join(expectedDir, "events.jsonl"))).toBe(true);
    const written = readFileSync(join(expectedDir, "events.jsonl"), "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.wave).toBe(waveName);
    expect(parsed.lane).toBe("l1");
    expect(parsed.stage).toBe("dispatch");
    expect(parsed.event).toBe("started");
  });

  test("standalone invocation respects WAVE_LOG_ROOT env var", () => {
    const customRoot = tempDir();
    const waveName = `WTestEnv${Date.now()}`;
    const expectedDir = join(customRoot, `wave-${waveName}`);
    execFileSync("sh", [waveEventSh, waveName, "l1", "dispatch", "started"], {
      env: { ...process.env, LOGDIR: "", WAVE_LOG_ROOT: customRoot },
    });
    expect(existsSync(join(expectedDir, "events.jsonl"))).toBe(true);
  });

  test("standalone invocation appends to existing in-flight wave in /tmp", () => {
    const waveName = `WLegacy${Date.now()}`;
    const legacyDir = join("/tmp", `wave-${waveName}`);
    mkdirSync(legacyDir, { recursive: true });
    dirs.push(legacyDir);
    execFileSync("sh", [waveEventSh, waveName, "l1", "dispatch", "started"], {
      env: { ...process.env, LOGDIR: "" },
    });
    expect(existsSync(join(legacyDir, "events.jsonl"))).toBe(true);
    const written = readFileSync(join(legacyDir, "events.jsonl"), "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.wave).toBe(waveName);
  });

  test("invocation with fewer than 4 arguments exits 2 with usage", () => {
    let status: number | undefined = -1;
    let stderr = "";
    try {
      execFileSync("sh", [waveEventSh, "W3", "l1"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("usage:");
  });
});

describe("scripts/dispatch-lane.sh emits its events", () => {
  const runDispatch = (cli: string, logdir: string, env: NodeJS.ProcessEnv = {}): void => {
    const wt = tempDir();
    const brief = join(tempDir(), "brief.md");
    writeFileSync(brief, "do the thing\n");
    // A lane that fails its marker makes the script exit 1 by design; the events
    // are what this test asserts, so a non-zero exit is not a test failure.
    try {
      execFileSync("zsh", [dispatchLaneSh, logdir, `l1:${wt}:${brief}`], {
        timeout: 20_000,
        env: { ...process.env, STAGGER: "0", POLL: "1", WAVE: "W3T", LANE_CMD: cli, ...env },
      });
    } catch {
      /* expected for failing lanes */
    }
  };

  test.skipIf(!hasZsh)(
    zshSkip ?? "a lane whose CLI exits zero emits dispatch started, then implement settled",
    () => {
      const logdir = join(tempDir(), "waveT");
      runDispatch("true", logdir);
      const { events } = readEvents(readFileSync(join(logdir, "events.jsonl"), "utf8"));
      expect(events).toEqual([
        { ts: expect.any(String), wave: "W3T", lane: "l1", stage: "dispatch", event: "started" },
        { ts: expect.any(String), wave: "W3T", lane: "l1", stage: "implement", event: "settled" },
      ]);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "a lane whose CLI exits non-zero emits implement failed",
    () => {
      const logdir = join(tempDir(), "waveF");
      runDispatch("false", logdir);
      const { events } = readEvents(readFileSync(join(logdir, "events.jsonl"), "utf8"));
      expect(events.map((event) => [event.stage, event.event])).toEqual([
        ["dispatch", "started"],
        ["implement", "failed"],
      ]);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "without WAVE set, the wave id defaults to the log dir's basename",
    () => {
      const logdir = join(tempDir(), "wavedefault");
      const wt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      execFileSync("zsh", [dispatchLaneSh, logdir, `l1:${wt}:${brief}`], {
        timeout: 20_000,
        env: { ...process.env, STAGGER: "0", POLL: "1", LANE_CMD: "true" },
      });
      const { events } = readEvents(readFileSync(join(logdir, "events.jsonl"), "utf8"));
      expect(events.map((event) => event.wave)).toEqual(["wavedefault", "wavedefault"]);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "dispatch-lane resolves wave name against existing in-flight /tmp wave",
    () => {
      const waveName = `WLegacyDisp${Date.now()}`;
      const legacyDir = join("/tmp", `wave-${waveName}`);
      mkdirSync(legacyDir, { recursive: true });
      dirs.push(legacyDir);
      const wt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      execFileSync("zsh", [dispatchLaneSh, waveName, `l1:${wt}:${brief}`], {
        timeout: 20_000,
        env: { ...process.env, STAGGER: "0", POLL: "1", LANE_CMD: "true" },
      });
      const { events } = readEvents(readFileSync(join(legacyDir, "events.jsonl"), "utf8"));
      expect(events.length).toBeGreaterThan(0);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "dispatch-lane resolves existing wave1-shaped directory (no dash) rather than duplicating it",
    () => {
      const id = `Num${Date.now()}`;
      const legacyDir = join("/tmp", `wave${id}`);
      mkdirSync(legacyDir, { recursive: true });
      dirs.push(legacyDir);
      const rootDir = join(tempDir(), "waves");
      mkdirSync(rootDir, { recursive: true });
      const wt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      execFileSync("zsh", [dispatchLaneSh, id, `l1:${wt}:${brief}`], {
        timeout: 20_000,
        env: { ...process.env, WAVE_LOG_ROOT: rootDir, STAGGER: "0", POLL: "1", LANE_CMD: "true" },
      });
      const { events } = readEvents(readFileSync(join(legacyDir, "events.jsonl"), "utf8"));
      expect(events.length).toBeGreaterThan(0);
      expect(existsSync(join(rootDir, `wave-${id}`))).toBe(false);
      expect(existsSync(join(rootDir, `wave${id}`))).toBe(false);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "dispatch-lane resolves existing wave1-shaped directory from WAVE env when logdir argument omitted",
    () => {
      const id = `EnvNum${Date.now()}`;
      const legacyDir = join("/tmp", `wave${id}`);
      mkdirSync(legacyDir, { recursive: true });
      dirs.push(legacyDir);
      const rootDir = join(tempDir(), "waves");
      mkdirSync(rootDir, { recursive: true });
      const wt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      execFileSync("zsh", [dispatchLaneSh, `l1:${wt}:${brief}`], {
        timeout: 20_000,
        env: { ...process.env, WAVE: id, WAVE_LOG_ROOT: rootDir, STAGGER: "0", POLL: "1", LANE_CMD: "true" },
      });
      const { events } = readEvents(readFileSync(join(legacyDir, "events.jsonl"), "utf8"));
      expect(events.length).toBeGreaterThan(0);
      expect(existsSync(join(rootDir, `wave-${id}`))).toBe(false);
      expect(existsSync(join(rootDir, `wave${id}`))).toBe(false);
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "documented launch example creates log directory from a fresh root and logs EXIT marker",
    () => {
      const freshRoot = join(tempDir(), "fresh-waves");
      expect(existsSync(freshRoot)).toBe(false);
      const waveId = `fresh-${Date.now()}`;
      const lane = "l1";
      const logDir = join(freshRoot, `wave-${waveId}`);
      const logFile = join(logDir, `${lane}.log`);

      execFileSync(
        "zsh",
        [
          "-c",
          `mkdir -p "${logDir}" && nohup zsh -c 'echo "lane running" > "${logFile}" 2>&1; echo "EXIT $?" >> "${logFile}"' >/dev/null 2>&1`,
        ],
        { timeout: 10_000 },
      );

      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("lane running");
      expect(content).toContain("EXIT 0");
    },
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "a fast lane's implement settled is appended before a slow lane's marker exists",
    async () => {
      const logdir = join(tempDir(), "waveOrder");
      mkdirSync(logdir, { recursive: true });
      const wtFast = tempDir();
      const wtSlow = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      writeFileSync(join(wtFast, "lane-cmd"), "true\n");
      writeFileSync(join(wtSlow, "lane-cmd"), "sleep 3; false\n");

      const child = spawn(
        "zsh",
        [dispatchLaneSh, logdir, `fast:${wtFast}:${brief}`, `slow:${wtSlow}:${brief}`],
        {
          env: {
            ...process.env,
            STAGGER: "0",
            POLL: "1",
            WAVE: "W3T",
            LANE_CMD: "zsh ./lane-cmd",
          },
          stdio: ["ignore", "ignore", "ignore"],
        },
      );

      try {
        const eventsPath = join(logdir, "events.jsonl");
        const slowLog = join(logdir, "slow.log");
        const deadline = Date.now() + 8_000;
        let settledBeforeSlowMarker = false;
        while (Date.now() < deadline) {
          if (existsSync(eventsPath)) {
            const { events } = readEvents(readFileSync(eventsPath, "utf8"));
            const fastSettled = events.some(
              (event) =>
                event.lane === "fast" && event.stage === "implement" && event.event === "settled",
            );
            if (fastSettled) {
              const slowText = existsSync(slowLog) ? readFileSync(slowLog, "utf8") : "";
              expect(/^EXIT [0-9]+$/m.test(slowText)).toBe(false);
              settledBeforeSlowMarker = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(settledBeforeSlowMarker).toBe(true);
      } finally {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 15_000);
          child.on("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        try {
          execFileSync("pkill", ["-f", wtSlow], { stdio: "ignore" });
        } catch {
          /* leftover sleep already gone */
        }
      }
    },
    20_000,
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "a timed-out lane emits implement failed with reason timeout as the second line",
    () => {
      const logdir = join(tempDir(), "waveTimeout");
      const wt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "x\n");
      try {
        execFileSync("zsh", [dispatchLaneSh, logdir, `l1:${wt}:${brief}`], {
          timeout: 20_000,
          env: {
            ...process.env,
            STAGGER: "0",
            POLL: "1",
            WAVE: "W3T",
            WAIT_TIMEOUT: "2",
            LANE_CMD: "sleep 30",
          },
        });
      } catch {
        /* expected: timeout → exit 1 */
      }
      try {
        execFileSync("pkill", ["-f", wt], { stdio: "ignore" });
      } catch {
        /* leftover sleep already gone */
      }
      const lines = readFileSync(join(logdir, "events.jsonl"), "utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toEqual({
        ts: expect.any(String),
        wave: "W3T",
        lane: "l1",
        stage: "implement",
        event: "failed",
        detail: { reason: "timeout" },
      });
    },
    20_000,
  );

  const gitExplicit = (
    args: readonly string[],
    cwd: string,
    options: { encoding?: "utf8"; stdio?: "ignore" | "pipe" } = { stdio: "ignore" },
  ): string =>
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      { cwd, encoding: "utf8", ...options },
    );

  test.skipIf(!hasZsh)(
    zshSkip ?? "reports commits since recorded tip and plainly says none when a lane committed nothing",
    () => {
      const logdir = join(tempDir(), "waveTip");
      const wtCommitted = tempDir();
      const wtEmpty = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "work\n");

      // Setup git worktree for wtCommitted
      gitExplicit(["init"], wtCommitted);
      gitExplicit(["config", "commit.gpgsign", "false"], wtCommitted);
      gitExplicit(["config", "user.name", "Test"], wtCommitted);
      gitExplicit(["config", "user.email", "test@example.com"], wtCommitted);
      writeFileSync(join(wtCommitted, "init.txt"), "initial\n");
      gitExplicit(["add", "."], wtCommitted);
      gitExplicit(["commit", "-m", "initial commit"], wtCommitted);
      const tipCommitted = gitExplicit(["rev-parse", "HEAD"], wtCommitted, { stdio: "pipe" }).trim();

      // Setup git worktree for wtEmpty with earlier commits to verify it does not compare to origin/main
      gitExplicit(["init"], wtEmpty);
      gitExplicit(["config", "commit.gpgsign", "false"], wtEmpty);
      gitExplicit(["config", "user.name", "Test"], wtEmpty);
      gitExplicit(["config", "user.email", "test@example.com"], wtEmpty);
      writeFileSync(join(wtEmpty, "earlier1.txt"), "1\n");
      gitExplicit(["add", "."], wtEmpty);
      gitExplicit(["commit", "-m", "earlier 1"], wtEmpty);
      writeFileSync(join(wtEmpty, "earlier2.txt"), "2\n");
      gitExplicit(["add", "."], wtEmpty);
      gitExplicit(["commit", "-m", "earlier 2"], wtEmpty);
      const tipEmpty = gitExplicit(["rev-parse", "HEAD"], wtEmpty, { stdio: "pipe" }).trim();

      // Lane 1 makes a commit during execution; Lane 2 runs true without committing
      writeFileSync(
        join(wtCommitted, "lane.sh"),
        'echo "new change" >> init.txt && git add init.txt && git commit -m "new commit"\n',
      );

      const stdout = execFileSync(
        "zsh",
        [
          dispatchLaneSh,
          logdir,
          `committed:${wtCommitted}:${brief}`,
          `uncommitted:${wtEmpty}:${brief}`,
        ],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            STAGGER: "0",
            POLL: "1",
            WAVE: "W3T",
            LANE_CMD: "if [[ -f lane.sh ]]; then zsh lane.sh; else true; fi",
          },
          encoding: "utf8",
        },
      );

      expect(stdout).toContain(`commits since tip (${tipCommitted.slice(0, 7)}): 1`);
      expect(stdout).toContain(`commits since tip (${tipEmpty.slice(0, 7)}): none`);
    },
    20_000,
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "reports unknown (tip missing) when starting tip was not recorded",
    () => {
      const logdir = join(tempDir(), "waveTipMissing");
      const wtNoTip = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "work\n");

      const stdout = execFileSync(
        "zsh",
        [dispatchLaneSh, logdir, `notip:${wtNoTip}:${brief}`],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            STAGGER: "0",
            POLL: "1",
            WAVE: "W3T",
            LANE_CMD: "true",
          },
          encoding: "utf8",
        },
      );

      expect(stdout).toContain("commits since tip: unknown (tip missing)");
    },
    20_000,
  );

  test.skipIf(!hasZsh)(
    zshSkip ?? "reports unknown (rev-list failed) when git rev-list fails in worktree",
    () => {
      const logdir = join(tempDir(), "waveRevListFailed");
      const wtCorrupt = tempDir();
      const brief = join(tempDir(), "brief.md");
      writeFileSync(brief, "work\n");

      gitExplicit(["init"], wtCorrupt);
      gitExplicit(["config", "commit.gpgsign", "false"], wtCorrupt);
      gitExplicit(["config", "user.name", "Test"], wtCorrupt);
      gitExplicit(["config", "user.email", "test@example.com"], wtCorrupt);
      writeFileSync(join(wtCorrupt, "init.txt"), "initial\n");
      gitExplicit(["add", "."], wtCorrupt);
      gitExplicit(["commit", "-m", "initial commit"], wtCorrupt);
      const tip = gitExplicit(["rev-parse", "HEAD"], wtCorrupt, { stdio: "pipe" }).trim();

      // Lane script removes .git so rev-list fails when dispatch-lane checks after execution
      writeFileSync(join(wtCorrupt, "lane.sh"), "rm -rf .git\n");

      const stdout = execFileSync(
        "zsh",
        [dispatchLaneSh, logdir, `corrupt:${wtCorrupt}:${brief}`],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            STAGGER: "0",
            POLL: "1",
            WAVE: "W3T",
            LANE_CMD: "if [[ -f lane.sh ]]; then zsh lane.sh; else true; fi",
          },
          encoding: "utf8",
        },
      );

      expect(stdout).toContain(`commits since tip (${tip.slice(0, 7)}): unknown (rev-list failed)`);
    },
    20_000,
  );
});
