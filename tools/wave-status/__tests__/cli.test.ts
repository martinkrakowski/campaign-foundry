import { describe, expect, test, vi } from "vitest";
import { parseArgs, runCli, type CliIo } from "../cli.js";
import { WAVE_LOG_ROOT } from "../lib/collect.js";
import type { WaveStatus } from "../lib/types.js";

const status: WaveStatus = {
  generatedAt: "2026-09-09T00:00:00Z",
  waves: [
    { id: "T", lanes: [{ wave: "T", lane: "t1", derived: { alive: true }, disagreements: [] }] },
  ],
};

function makeIo(argv: readonly string[], overrides: Partial<CliIo> = {}) {
  const log = vi.fn((_text: string): void => undefined);
  const collect = vi.fn(async (_root: string): Promise<WaveStatus> => status);
  const schedule = vi.fn((_fn: () => void, _ms: number): void => undefined);
  const io: CliIo = { argv, isTTY: true, noColor: false, log, collect, schedule, ...overrides };
  return { io, log, collect, schedule };
}

describe("parseArgs", () => {
  test("no arguments is a one-shot render at the default root", () => {
    expect(parseArgs([])).toEqual({ watch: false, root: undefined });
  });

  test("--watch defaults to 10 seconds; --watch=N overrides it", () => {
    expect(parseArgs(["--watch"])).toEqual({ watch: 10, root: undefined });
    expect(parseArgs(["--watch=2"])).toEqual({ watch: 2, root: undefined });
  });

  test("--root takes a separate path or an = form", () => {
    expect(parseArgs(["--root", "/tmp/waves"])).toEqual({ watch: false, root: "/tmp/waves" });
    expect(parseArgs(["--root=/tmp/waves"])).toEqual({ watch: false, root: "/tmp/waves" });
  });

  test("flags combine", () => {
    expect(parseArgs(["--root", "/w", "--watch=5"])).toEqual({ watch: 5, root: "/w" });
  });

  test("a non-integer or non-positive --watch is refused", () => {
    expect(() => parseArgs(["--watch=0"])).toThrow(/invalid --watch/);
    expect(() => parseArgs(["--watch=abc"])).toThrow(/invalid --watch/);
    expect(() => parseArgs(["--watch=1.5"])).toThrow(/invalid --watch/);
    expect(() => parseArgs(["--watch="])).toThrow(/invalid --watch/);
  });

  test("--root without a path is refused", () => {
    expect(() => parseArgs(["--root"])).toThrow(/--root requires a path/);
  });

  test("anything else is refused", () => {
    expect(() => parseArgs(["--port=4317"])).toThrow(/unknown argument/);
  });
});

describe("runCli", () => {
  test("collects once, renders once, and does not schedule", async () => {
    const { io, log, collect, schedule } = makeIo([]);
    await runCli(io);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain("wave T");
    expect(printed).toContain("T/t1");
    expect(printed).toContain("alive");
  });

  test("colour is on only for a TTY with NO_COLOR unset", async () => {
    const tty = makeIo([]);
    await runCli(tty.io);
    expect(String(tty.log.mock.calls[0]?.[0])).toMatch(/\x1b\[/);

    const noColor = makeIo([], { noColor: true });
    await runCli(noColor.io);
    expect(String(noColor.log.mock.calls[0]?.[0])).not.toMatch(/\x1b/);

    const notTTY = makeIo([], { isTTY: false });
    await runCli(notTTY.io);
    expect(String(notTTY.log.mock.calls[0]?.[0])).not.toMatch(/\x1b/);
  });

  test("the root comes from --root, then WAVE_LOG_ROOT, then the shared default", async () => {
    const explicit = makeIo(["--root", "/from-flag"]);
    await runCli(explicit.io);
    expect(explicit.collect).toHaveBeenCalledWith("/from-flag");

    const fromEnv = makeIo([], { WAVE_LOG_ROOT: "/from-env" });
    await runCli(fromEnv.io);
    expect(fromEnv.collect).toHaveBeenCalledWith("/from-env");

    const fallback = makeIo([]);
    await runCli(fallback.io);
    expect(fallback.collect).toHaveBeenCalledWith(WAVE_LOG_ROOT);
  });

  test("--watch re-collects on the requested interval until interrupted", async () => {
    const { io, log, collect, schedule } = makeIo(["--watch=2"]);
    await runCli(io);
    expect(schedule).toHaveBeenCalledTimes(1);
    const [fn, ms] = schedule.mock.calls[0] as [() => void, number];
    expect(ms).toBe(2000);
    fn();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
  });

  test("--watch without a value uses the default interval", async () => {
    const { io, schedule } = makeIo(["--watch"]);
    await runCli(io);
    expect(schedule.mock.calls[0]?.[1]).toBe(10000);
  });

  test("an unknown argument rejects", async () => {
    const { io } = makeIo(["--nope"]);
    await expect(runCli(io)).rejects.toThrow(/unknown argument/);
  });
});
