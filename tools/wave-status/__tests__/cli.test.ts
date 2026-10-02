import { describe, expect, test, vi } from "vitest";
import { parseArgs, runCli, type CliIo } from "../cli.js";
import { WAVE_LOG_ROOT } from "../lib/collect.js";
import type { PushOptions } from "../lib/push.js";
import type { WaveStatus } from "../lib/types.js";

const status: WaveStatus = {
  generatedAt: "2026-09-09T00:00:00Z",
  waves: [
    { id: "T", lanes: [{ wave: "T", lane: "t1", derived: { alive: true }, disagreements: [] }] },
  ],
};

function makeIo(argv: readonly string[], overrides: Partial<CliIo> = {}) {
  const log = vi.fn((_text: string): void => undefined);
  const logError = vi.fn((_text: string): void => undefined);
  const collect = vi.fn(async (_root: string): Promise<WaveStatus> => status);
  const push = vi.fn(async (_status: WaveStatus, _options: PushOptions): Promise<number> => 1);
  const schedule = vi.fn((_fn: () => void, _ms: number): void => undefined);
  const io: CliIo = {
    argv,
    isTTY: true,
    noColor: false,
    log,
    logError,
    collect,
    push,
    schedule,
    ...overrides,
  };
  return { io, log, logError, collect, push, schedule };
}

/** The two fields `--push` adds to every parse. */
const NO_PUSH = { push: false, waves: [] } as const;

describe("parseArgs", () => {
  test("no arguments is a one-shot render at the default root", () => {
    expect(parseArgs([])).toEqual({ watch: false, root: undefined, ...NO_PUSH });
  });

  test("--watch defaults to 10 seconds; --watch=N overrides it", () => {
    expect(parseArgs(["--watch"])).toEqual({ watch: 10, root: undefined, ...NO_PUSH });
    expect(parseArgs(["--watch=2"])).toEqual({ watch: 2, root: undefined, ...NO_PUSH });
  });

  test("--root takes a separate path or an = form", () => {
    expect(parseArgs(["--root", "/tmp/waves"])).toEqual({
      watch: false,
      root: "/tmp/waves",
      ...NO_PUSH,
    });
    expect(parseArgs(["--root=/tmp/waves"])).toEqual({
      watch: false,
      root: "/tmp/waves",
      ...NO_PUSH,
    });
  });

  test("flags combine", () => {
    expect(parseArgs(["--root", "/w", "--watch=5"])).toEqual({
      watch: 5,
      root: "/w",
      ...NO_PUSH,
    });
  });

  test("--push is a flag, and --wave takes a separate id or an = form", () => {
    expect(parseArgs(["--push", "--wave", "T"])).toEqual({
      watch: false,
      root: undefined,
      push: true,
      waves: ["T"],
    });
    expect(parseArgs(["--push", "--wave=T"])).toEqual({
      watch: false,
      root: undefined,
      push: true,
      waves: ["T"],
    });
  });

  test("--wave may repeat, and the order it was given is kept", () => {
    expect(parseArgs(["--push", "--wave", "B", "--wave=A", "--wave=B"])).toEqual({
      watch: false,
      root: undefined,
      push: true,
      waves: ["B", "A", "B"],
    });
  });

  test("an 80-character id is the longest accepted", () => {
    const longest = "w" + "a".repeat(79);
    expect(parseArgs(["--push", `--wave=${longest}`]).waves).toEqual([longest]);
  });

  test("an id the service would refuse is refused, in either form", () => {
    const tooLong = "w" + "a".repeat(80);
    for (const argv of [
      ["--push", "--wave="],
      ["--push", "--wave", ""],
      ["--push", "--wave", "--push"],
      ["--push", `--wave=${tooLong}`],
      ["--push", "--wave", "a/b"],
      ["--push", "--wave=a.b"],
      ["--push", "--wave=-lead"],
      ["--push", `--wave=${"w".repeat(80)}/`],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(/invalid --wave id/);
    }
  });

  test("--wave as the last argument has nothing to read", () => {
    expect(() => parseArgs(["--push", "--wave"])).toThrow("--wave requires an id");
  });

  test("--wave without --push is refused — there is nothing for it to narrow", () => {
    expect(() => parseArgs(["--wave", "T"])).toThrow("--wave requires --push");
    expect(() => parseArgs(["--wave=T"])).toThrow("--wave requires --push");
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

  test("--root refuses a value that begins with '-' (e.g. a later flag) and an empty value", () => {
    expect(() => parseArgs(["--root", "--watch=2"])).toThrow(/--root requires a path/);
    expect(() => parseArgs(["--root="])).toThrow(/--root requires a path/);
    expect(() => parseArgs(["--root", ""])).toThrow(/--root requires a path/);
  });

  test("--root refuses a path that begins with '-' and the = form too", () => {
    expect(() => parseArgs(["--root", "-flag"])).toThrow(/--root/);
    expect(() => parseArgs(["--root=-flag"])).toThrow(/--root/);
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

  test("a collect that outlives the interval never overlaps the next refresh", async () => {
    const late: Array<() => void> = [];
    let calls = 0;
    const collect = vi.fn(async (_root: string): Promise<WaveStatus> => {
      calls += 1;
      if (calls >= 2) await new Promise<void>((resolve) => late.push(resolve));
      return status;
    });
    const { io, schedule } = makeIo(["--watch=2"], { collect });
    await runCli(io);
    expect(calls).toBe(1);
    const [fn] = schedule.mock.calls[0] as [() => void, number];
    fn();
    await vi.waitFor(() => expect(calls).toBe(2));
    fn(); // the interval fires again while the previous collect is still held open
    expect(calls).toBe(2); // no overlapping collect started
    late.shift()?.();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
  });

  test("an unknown argument rejects", async () => {
    const { io } = makeIo(["--nope"]);
    await expect(runCli(io)).rejects.toThrow(/unknown argument/);
  });

  test("a failed collect reports the error and the next tick still prints", async () => {
    let calls = 0;
    const collect = vi.fn(async (_root: string): Promise<WaveStatus> => {
      calls += 1;
      if (calls === 2) throw new Error("gh failed");
      if (calls === 3) throw "log file vanished";
      return status;
    });
    const { io, log, logError, schedule } = makeIo(["--watch=1"], { collect });
    await runCli(io);
    expect(log).toHaveBeenCalledTimes(1);
    const [fn] = schedule.mock.calls[0] as [() => void, number];
    fn();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith("gh failed"));
    const [fn2] = schedule.mock.calls[1] as [() => void, number];
    fn2();
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith("log file vanished"));
    const [fn3] = schedule.mock.calls[2] as [() => void, number];
    fn3();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
  });

  test("without --push the status is never sent", async () => {
    const { io, push } = makeIo([], { WAVES_URL: "https://waves.example" });
    await runCli(io);
    expect(push).not.toHaveBeenCalled();
  });

  test("--push sends the very status it printed, once per collection", async () => {
    const { io, push, collect } = makeIo(["--push", "--wave", "T"], {
      WAVES_URL: "https://waves.example",
    });
    await runCli(io);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(status, { waves: ["T"], watch: false });
  });

  test("one collection per tick: the printed and the pushed status are one status", async () => {
    const { io, collect, push, schedule } = makeIo(["--push", "--watch=2"], {
      WAVES_URL: "https://waves.example",
    });
    await runCli(io);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    const [fn] = schedule.mock.calls[0] as [() => void, number];
    fn();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith(status, { waves: [], watch: 2 });
  });

  test("no WAVES_URL pushes nothing and says so once for the whole run", async () => {
    const { io, logError, push, schedule } = makeIo(["--push", "--watch=1"]);
    await runCli(io);
    // Two more ticks on top of the first print, on the injected schedule only.
    for (let tick = 0; tick < 2; tick++) {
      const armed = schedule.mock.calls.length;
      const [fn] = schedule.mock.calls[armed - 1] as [() => void, number];
      fn();
      await vi.waitFor(() => expect(schedule.mock.calls.length).toBeGreaterThan(armed));
    }
    expect(push).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "wave:status --push: WAVES_URL is not set; nothing pushed",
    );
  });

  test("an empty WAVES_URL is no WAVES_URL at all", async () => {
    const { io, logError, push } = makeIo(["--push"], { WAVES_URL: "" });
    await runCli(io);
    expect(push).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("a push that rejects is logged, runCli still resolves, and the loop still ticks", async () => {
    const push = vi.fn(async (): Promise<number> => {
      throw new Error("waves push: W: exit 2: the envelope is not valid");
    });
    const { io, logError, collect, schedule } = makeIo(["--push", "--watch=1"], {
      WAVES_URL: "https://waves.example",
      push,
    });
    await expect(runCli(io)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("waves push: W: exit 2: the envelope is not valid");
    expect(collect).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    const [fn] = schedule.mock.calls[0] as [() => void, number];
    fn();
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
  });

  test("a rejection that is not an Error is still reported, with its text", async () => {
    const push = vi.fn(async (): Promise<number> => {
      throw "no waves binary";
    });
    const { io, logError } = makeIo(["--push"], {
      WAVES_URL: "https://waves.example",
      push,
    });
    await runCli(io);
    expect(logError).toHaveBeenCalledWith("no waves binary");
  });

  test("a pushed count is the client's business, not this run's exit code", async () => {
    const { io } = makeIo(["--push"], {
      WAVES_URL: "https://waves.example",
      push: vi.fn(async (): Promise<number> => 0),
    });
    await expect(runCli(io)).resolves.toBeUndefined();
  });
});
