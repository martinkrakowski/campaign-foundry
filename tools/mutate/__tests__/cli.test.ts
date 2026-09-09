import { describe, expect, test, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, realDeps, type MutateCliIo } from "../cli.js";
import { EXIT_CAUGHT, EXIT_SURVIVED, EXIT_REFUSAL, RefusalError } from "../lib/mutate.js";
import type { MutationDeps } from "../lib/types.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mutate-cli-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCliIo(argv: readonly string[], overrides: Partial<MutateCliIo> = {}) {
  const log = vi.fn((_text: string): void => undefined);
  const logError = vi.fn((_text: string): void => undefined);
  const io: MutateCliIo = { argv, log, logError, ...overrides };
  return { io, log, logError };
}

describe("runCli", () => {
  test("returns EXIT_CAUGHT (0) when mutation is caught", async () => {
    const deps: MutationDeps = {
      readFile: vi.fn(async () => "mutated"),
      readFileBuffer: vi.fn(async () => Buffer.from("original")),
      writeFileBuffer: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ exitCode: 1, stdout: "test failed", stderr: "" })),
    };

    const { io, log, logError } = makeCliIo(
      [
        "--file",
        "file.ts",
        "--before",
        "before.txt",
        "--after",
        "after.txt",
        "--because",
        "cause failure",
        "--",
        "yarn",
        "test",
      ],
      {
        deps: {
          ...deps,
          readFile: vi.fn(async (p: string) => {
            if (p === "before.txt") return "orig";
            if (p === "after.txt") return "mut";
            return "mutated";
          }),
        },
      },
    );

    const code = await runCli(io);
    expect(code).toBe(EXIT_CAUGHT);
    expect(logError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const printed = log.mock.calls[0]?.[0] as string;
    expect(printed.startsWith("exit code: 1\nverdict: caught\nbecause: cause failure")).toBe(true);
  });

  test("returns EXIT_SURVIVED (1) when mutation survives", async () => {
    const { io, log, logError } = makeCliIo(
      [
        "--file",
        "file.ts",
        "--before",
        "before.txt",
        "--after",
        "after.txt",
        "--because",
        "verify survival",
        "--",
        "yarn",
        "test",
      ],
      {
        deps: {
          readFileBuffer: vi.fn(async () => Buffer.from("original")),
          writeFileBuffer: vi.fn(async () => undefined),
          readFile: vi.fn(async (p: string) => {
            if (p === "before.txt") return "orig";
            if (p === "after.txt") return "mut";
            return "mutated";
          }),
          execute: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
        },
      },
    );

    const code = await runCli(io);
    expect(code).toBe(EXIT_SURVIVED);
    expect(logError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const printed = log.mock.calls[0]?.[0] as string;
    expect(printed.startsWith("exit code: 0\nverdict: survived\nbecause: verify survival")).toBe(true);
  });

  test("returns Refusal exit code and logs to logError on RefusalError", async () => {
    const { io, log, logError } = makeCliIo(["--file", "f.ts", "--"]);
    const code = await runCli(io);
    expect(code).toBe(EXIT_REFUSAL);
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("Refusal"));
  });

  test("returns EXIT_REFUSAL on unexpected non-Error throw", async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const badIo = {
      get argv(): readonly string[] {
        throw "raw string throw";
      },
      log,
      logError,
    };

    const code = await runCli(badIo as unknown as MutateCliIo);
    expect(code).toBe(EXIT_REFUSAL);
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("raw string throw");
  });

  test("returns EXIT_REFUSAL on non-Refusal Error instance", async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const badIo = {
      get argv(): readonly string[] {
        throw new Error("generic error");
      },
      log,
      logError,
    };

    const code = await runCli(badIo as unknown as MutateCliIo);
    expect(code).toBe(EXIT_REFUSAL);
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("generic error");
  });
});

describe("realDeps integration", () => {
  test("executes real command, performs file mutation and unconditional restoration", async () => {
    const dir = tempDir();
    const targetFile = join(dir, "target.ts");
    const beforeFile = join(dir, "before.txt");
    const afterFile = join(dir, "after.txt");

    const originalContent = "export function add(a: number, b: number) { return a + b; }\n";
    writeFileSync(targetFile, originalContent);
    writeFileSync(beforeFile, "return a + b;");
    writeFileSync(afterFile, "return a - b;");

    const { io, log } = makeCliIo([
      "--file",
      targetFile,
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--because",
      "operator mutation changes addition to subtraction",
      "--",
      process.execPath,
      "-e",
      "process.exit(1)",
    ]);

    const code = await runCli(io);
    expect(code).toBe(EXIT_CAUGHT);

    // Target file must be byte-identical to original
    expect(readFileSync(targetFile, "utf8")).toBe(originalContent);
    const printed = log.mock.calls[0]?.[0] as string;
    expect(printed).toContain("exit code: 1");
    expect(printed).toContain("verdict: caught");
  });

  test("realDeps execute handles child process error when command cannot be spawned", async () => {
    const dir = tempDir();
    const targetFile = join(dir, "target.ts");
    const beforeFile = join(dir, "before.txt");
    const afterFile = join(dir, "after.txt");

    writeFileSync(targetFile, "const x = 1;\n");
    writeFileSync(beforeFile, "1");
    writeFileSync(afterFile, "2");

    const { io, logError } = makeCliIo([
      "--file",
      targetFile,
      "--before",
      beforeFile,
      "--after",
      afterFile,
      "--because",
      "command fails to spawn",
      "--",
      "/nonexistent/command/cannot/be/found",
    ]);

    const code = await runCli(io);
    expect(code).toBe(EXIT_REFUSAL);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
    expect(readFileSync(targetFile, "utf8")).toBe("const x = 1;\n");
  });

  test("realDeps execute rejects on empty command", async () => {
    await expect(realDeps.execute([])).rejects.toThrow("empty command");
  });

  test("realDeps execute captures stdout and stderr and handles normal exit", async () => {
    const res = await realDeps.execute([
      process.execPath,
      "-e",
      "process.stdout.write('hello stdout\\n'); process.stderr.write('hello stderr\\n'); process.exit(0)",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello stdout\n");
    expect(res.stderr).toBe("hello stderr\n");
  });

  test("realDeps execute defaults null exit code to 1 when killed by signal", async () => {
    const res = await realDeps.execute([
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    expect(res.exitCode).toBe(1);
  });

  test("realDeps readFile, readFileBuffer, and writeFileBuffer operate on disk", async () => {
    const dir = tempDir();
    const filePath = join(dir, "sample.txt");
    await realDeps.writeFileBuffer(filePath, Buffer.from("sample bytes", "utf8"));
    const text = await realDeps.readFile(filePath);
    const buf = await realDeps.readFileBuffer(filePath);
    expect(text).toBe("sample bytes");
    expect(buf.equals(Buffer.from("sample bytes"))).toBe(true);
  });

  test("realDeps onSignal registers, triggers handler and unregisters signal listeners", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const dummyCleanup = vi.fn(async () => undefined);
    const unregister = realDeps.onSignal!(dummyCleanup);
    expect(typeof unregister).toBe("function");

    // Emit SIGINT to exercise the signal handler
    process.emit("SIGINT");
    await vi.waitFor(() => expect(dummyCleanup).toHaveBeenCalled());
    expect(exitSpy).toHaveBeenCalledWith(130);

    unregister();
    exitSpy.mockRestore();
  });
});
