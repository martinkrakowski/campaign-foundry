import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const mainMock = vi.hoisted(() => vi.fn());
vi.mock("../auth.js", () => ({ main: mainMock }));

describe("the auth:bootstrap entry point (bin/auth-cli.ts)", () => {
  const savedArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    mainMock.mockReset();
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  test("calls main with argv[2] and prints nothing when it resolves", async () => {
    process.argv = [...savedArgv.slice(0, 2), "owner@example.com"];
    mainMock.mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../auth-cli.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(mainMock).toHaveBeenCalledWith("owner@example.com");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    errorSpy.mockRestore();
  });

  test("prints the error and sets exitCode 1 when main rejects", async () => {
    process.argv = [...savedArgv.slice(0, 2)];
    mainMock.mockRejectedValue(new Error("usage: yarn auth:bootstrap <email>"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../auth-cli.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith("  x  usage: yarn auth:bootstrap <email>");
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  test("prints a string error as-is when main rejects with a non-Error", async () => {
    process.argv = [...savedArgv.slice(0, 2)];
    mainMock.mockRejectedValue("boom");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../auth-cli.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith("  x  boom");
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });
});
