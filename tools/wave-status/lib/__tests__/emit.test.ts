import { describe, test, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
    execFileSync("zsh", [waveEventSh, dir, "W3", "l1", "dispatch", "started"]);
    const written = readFileSync(join(dir, "events.jsonl"), "utf8");
    const ts = JSON.parse(written).ts as string;
    expect(written).toBe(
      formatEvent({ ts, wave: "W3", lane: "l1", stage: "dispatch", event: "started" }, clock),
    );
  });

  test("an event with --pr, --round and --detail", () => {
    const dir = tempDir();
    const detail = '{"fixed":5,"refuted":2,"mutations":3,"mutationsBit":3}';
    execFileSync("zsh", [
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
      execFileSync("zsh", [waveEventSh, dir, "W3", "l1", "deploy", "started"]);
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
      execFileSync("zsh", [waveEventSh, dir, "W3", "l1", "gate", "skipped"]);
    } catch (error) {
      const err = error as { status: number | undefined; stderr: Buffer };
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("started settled failed");
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
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

  test("a lane whose CLI exits zero emits dispatch started, then implement settled", () => {
    const logdir = join(tempDir(), "waveT");
    runDispatch("true", logdir);
    const { events } = readEvents(readFileSync(join(logdir, "events.jsonl"), "utf8"));
    expect(events).toEqual([
      { ts: expect.any(String), wave: "W3T", lane: "l1", stage: "dispatch", event: "started" },
      { ts: expect.any(String), wave: "W3T", lane: "l1", stage: "implement", event: "settled" },
    ]);
  });

  test("a lane whose CLI exits non-zero emits implement failed", () => {
    const logdir = join(tempDir(), "waveF");
    runDispatch("false", logdir);
    const { events } = readEvents(readFileSync(join(logdir, "events.jsonl"), "utf8"));
    expect(events.map((event) => [event.stage, event.event])).toEqual([
      ["dispatch", "started"],
      ["implement", "failed"],
    ]);
  });

  test("without WAVE set, the wave id defaults to the log dir's basename", () => {
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
  });
});
