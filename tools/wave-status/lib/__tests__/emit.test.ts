import { describe, test, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { formatEvent, appendEvent } from "../emit.js";
import { readEvents } from "../events.js";

const clock = (): string => "2026-09-07T16:55:43Z";

// `scripts/wave-event.sh` is the only emitter left, and it is POSIX sh: every
// test in this file runs on macOS and on the Linux runners alike. The zsh
// launcher that used to be exercised here — and the `skipIf(!hasZsh)` guard it
// needed — went with it, so there is no longer a set of tests that only the
// operator's machine runs.
const waveEventSh = fileURLToPath(new URL("../../../../scripts/wave-event.sh", import.meta.url));

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
    const line = formatEvent({ wave: "S", lane: "s4", stage: "dispatch", event: "started" }, clock);
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
    expect(() => formatEvent(input as never, clock)).toThrow(
      /event is one of: started\|settled\|failed/,
    );
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
      appendEvent("/tmp/events.jsonl", { wave: "S", lane: "s4", stage: "deploy" } as never, {
        appendFile: async () => void calls++,
        clock,
      }),
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
    execFileSync("sh", [
      waveEventSh,
      "--logdir",
      dir,
      "W3",
      "l1",
      "implement",
      "settled",
      "--pr",
      "99",
    ]);
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent(
        { ts, wave: "W3", lane: "l1", stage: "implement", event: "settled", pr: 99 },
        clock,
      ),
    );
  });

  // X38 (plan §41, second finding): this test proves the script's *default*
  // derivation — no LOGDIR, no WAVE_LOG_ROOT — which the script reads as
  // `${HOME:-/tmp}/.waves`. Exercising that path used to mean the real
  // `~/.waves`, the operator's own monitor, and left a `wave-WTest…`
  // directory there whenever the test crashed or the platform reordered
  // cleanup ahead of the read. `HOME` is itself the input under test, so
  // pointing it at a temp directory keeps the default-fallback behaviour
  // honest while giving the write nowhere but a directory `tempDir()` already
  // registers for teardown.
  test("standalone invocation with default logdir derived from wave name", () => {
    const fakeHome = tempDir();
    const waveName = `WTest${Date.now()}`;
    const expectedDir = join(fakeHome, ".waves", `wave-${waveName}`);
    execFileSync("sh", [waveEventSh, waveName, "l1", "dispatch", "started"], {
      env: { ...process.env, LOGDIR: "", WAVE_LOG_ROOT: "", HOME: fakeHome },
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
