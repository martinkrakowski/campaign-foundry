import { describe, expect, test, vi } from "vitest";
import type { MutationDeps } from "../../../mutate/lib/types.js";
import {
  EXIT_MISMATCH,
  EXIT_VERIFIED,
  exitCodeFor,
  formatChecks,
  replayManifest,
  type ScratchDeps,
} from "../replay.js";
import type { Manifest } from "../types.js";

const manifest = (over: Partial<Manifest["mutations"][number]> = {}): Manifest => ({
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
      ...over,
    },
  ],
});

/**
 * A fake target file plus a command whose exit code the test chooses. The
 * mutation engine is real — that is the point of the replay — so the file must
 * genuinely contain the `before` text exactly once.
 */
const deps = (commandExit: number, content = "alpha"): MutationDeps => {
  let current = Buffer.from(content, "utf8");
  return {
    readFile: async (path) => (path.endsWith(".before") ? "alpha" : "beta"),
    readFileBuffer: async () => current,
    writeFileBuffer: async (_path, buffer) => {
      current = Buffer.from(buffer);
    },
    execute: async () => ({ exitCode: commandExit, stdout: "", stderr: "" }),
  };
};

const scratch = (): ScratchDeps => ({
  makeDir: async () => "/scratch",
  writeText: async () => undefined,
  removeDir: async () => undefined,
  join: (...parts) => parts.join("/"),
});

describe("replayManifest", () => {
  test("verifies a claim when the mutation is caught, as recorded", async () => {
    const checks = await replayManifest(manifest(), deps(1), scratch());
    expect(checks[0]).toMatchObject({ status: "verified", observed: "caught" });
  });

  test("reports a mismatch when the claimed catch does not reproduce", async () => {
    const checks = await replayManifest(manifest(), deps(0), scratch());
    expect(checks[0]).toMatchObject({ status: "mismatch", observed: "survived" });
  });

  test("writes each mutation's texts to its own scratch pair", async () => {
    const writeText = vi.fn(async (_path: string, _text: string) => undefined);
    await replayManifest(manifest(), deps(1), { ...scratch(), writeText });
    expect(writeText.mock.calls.map((c) => c[0])).toEqual([
      "/scratch/0.before",
      "/scratch/0.after",
    ]);
  });

  test("removes the scratch directory even when a mutation throws", async () => {
    const removeDir = vi.fn(async () => undefined);
    const broken: MutationDeps = {
      ...deps(1),
      readFileBuffer: async () => {
        throw new Error("unreadable");
      },
    };
    await expect(replayManifest(manifest(), broken, { ...scratch(), removeDir })).rejects.toThrow();
    expect(removeDir).toHaveBeenCalledWith("/scratch");
  });
});

describe("formatChecks", () => {
  test("says plainly when every verdict reproduced", async () => {
    const checks = await replayManifest(manifest(), deps(1), scratch());
    expect(formatChecks("W4", checks)).toBe("W4: 1 mutation(s) re-run, every verdict reproduced.");
  });

  test("names the file, both verdicts, and what the mismatch means", async () => {
    const checks = await replayManifest(manifest(), deps(0), scratch());
    const text = formatChecks("W4", checks);
    expect(text).toContain("MISMATCH  target.ts");
    expect(text).toContain("claimed: caught    observed: survived");
    expect(text).toContain("the guard must red");
    expect(text).toContain("tests do not catch");
    expect(text).toContain("W4: 1 of 1 mutation(s) did not reproduce.");
  });
});

describe("exitCodeFor", () => {
  test("is non-zero on a mismatch, so CI can refuse the claim", async () => {
    expect(exitCodeFor(await replayManifest(manifest(), deps(0), scratch()))).toBe(EXIT_MISMATCH);
  });

  test("is zero when every claim reproduced", async () => {
    expect(exitCodeFor(await replayManifest(manifest(), deps(1), scratch()))).toBe(EXIT_VERIFIED);
  });
});
