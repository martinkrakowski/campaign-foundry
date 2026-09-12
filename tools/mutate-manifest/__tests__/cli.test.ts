import { describe, expect, test, vi } from "vitest";
import { EXIT_MALFORMED, runCli, type ManifestCliIo } from "../cli.js";
import { EXIT_MISMATCH, EXIT_VERIFIED, type ScratchDeps } from "../lib/replay.js";
import type { MutationDeps } from "../../mutate/lib/types.js";

const manifestText = JSON.stringify({
  version: 1,
  lane: "W4",
  mutations: [
    {
      file: "target.ts",
      before: "alpha",
      after: "beta",
      because: "the guard must red",
      command: ["run", "tests"],
      verdict: "caught",
    },
  ],
});

const deps = (commandExit: number): MutationDeps => {
  let current = Buffer.from("alpha", "utf8");
  return {
    readFile: async (path) => (path.endsWith(".before") ? "alpha" : "beta"),
    readFileBuffer: async () => current,
    writeFileBuffer: async (_p, buffer) => {
      current = Buffer.from(buffer);
    },
    execute: async () => ({ exitCode: commandExit, stdout: "", stderr: "" }),
  };
};

const scratch: ScratchDeps = {
  makeDir: async () => "/scratch",
  writeText: async () => undefined,
  removeDir: async () => undefined,
  join: (...parts) => parts.join("/"),
};

const io = (over: Partial<ManifestCliIo> = {}) => {
  const log = vi.fn((_t: string): void => undefined);
  const logError = vi.fn((_t: string): void => undefined);
  return {
    log,
    logError,
    io: {
      argv: ["m.json"],
      log,
      logError,
      readFile: async () => manifestText,
      deps: deps(1),
      scratch,
      ...over,
    } as ManifestCliIo,
  };
};

describe("runCli", () => {
  test("exits 0 and reports when every claimed verdict reproduces", async () => {
    const { io: i, log } = io();
    expect(await runCli(i)).toBe(EXIT_VERIFIED);
    expect(log).toHaveBeenCalledWith("W4: 1 mutation(s) re-run, every verdict reproduced.");
  });

  test("exits 1 and names the mismatch when a claim does not reproduce", async () => {
    const { io: i, log } = io({ deps: deps(0) });
    expect(await runCli(i)).toBe(EXIT_MISMATCH);
    expect(log.mock.calls[0]?.[0]).toContain("MISMATCH  target.ts");
  });

  test("refuses with usage when given no manifest path", async () => {
    const { io: i, logError } = io({ argv: [] });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError).toHaveBeenCalledWith("usage: mutate:verify <manifest.json>");
  });

  test("refuses an empty path rather than reading the working directory", async () => {
    const { io: i } = io({ argv: [""] });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
  });

  test("reports an unreadable manifest as malformed, not as a mismatch", async () => {
    const { io: i, logError } = io({
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("cannot read m.json: ENOENT");
  });

  test("reports a non-Error throw from readFile without losing it", async () => {
    const { io: i, logError } = io({
      readFile: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "disk on fire";
      },
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("cannot read m.json: disk on fire");
  });

  test("reports a malformed manifest with the reason, prefixed by its path", async () => {
    const { io: i, logError } = io({ readFile: async () => '{"version":2}' });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("m.json: version must be 1");
  });
});
