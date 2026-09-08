import { afterEach, describe, test, expect, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resolveRoot } from "../bin.js";
import { WAVE_LOG_ROOT } from "../lib/collect.js";

type ExecCallback = (error: Error | null, stdout: string) => void;
(execFile as unknown as Mock).mockImplementation(
  (
    file: string,
    _args: readonly string[],
    optionsOrCallback: ExecCallback | Record<string, unknown>,
    maybeCallback?: ExecCallback,
  ) => {
    const callback = (
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
    ) as ExecCallback;
    queueMicrotask(() => callback(null, file === "gh" ? "[]" : ""));
    return undefined;
  },
);

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-status-bin-"));
  roots.push(root);
  return root;
}

describe("resolveRoot", () => {
  test("root wins, then WAVE_LOG_ROOT, then the process default", () => {
    expect(resolveRoot({ root: "/injected" })).toBe("/injected");
    expect(resolveRoot({ WAVE_LOG_ROOT: "/from-env" })).toBe("/from-env");
    expect(resolveRoot({})).toBe(WAVE_LOG_ROOT);
  });
});

describe("bin main", () => {
  test("starts the server on an ephemeral port and prints the URL once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handle = await main({ PORT: "0", root: await emptyRoot() });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain(`wave-status serving ${handle.url}`);
    } finally {
      await handle.close();
      log.mockRestore();
    }
  });

  test("WAVE_LOG_ROOT is the env-var injection path when root is omitted", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handle = await main({ PORT: "0", WAVE_LOG_ROOT: await emptyRoot() });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await handle.close();
      log.mockRestore();
    }
  });

  test("refuses the operator's ports by construction (D105)", async () => {
    await expect(main({ PORT: "3000" })).rejects.toThrow(/D105/);
    await expect(main({ PORT: "3001" })).rejects.toThrow(/D105/);
  });
});
