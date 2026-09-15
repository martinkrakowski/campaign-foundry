import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_MANIFEST_PATH,
  EXIT_CLEAN,
  EXIT_DRIFT,
  EXIT_MALFORMED,
  runCli,
  type ArchInventoryIo,
} from "../cli.js";

const MANIFEST = [
  "generator:",
  "  sync:",
  "    layers:",
  "      domain: { folder: src/domain, subfolders: [entities] }",
  "    stubs: { enabled: true }",
  "bounded_contexts:",
  "  - name: Demo",
  "    layers:",
  "      domain:",
  "        entities: [Widget]",
  "",
].join("\n");

const CLEAN_TREE = {
  "packages/Demo/src/domain/entities": ["Widget.ts"],
};

const io = (over: Partial<ArchInventoryIo> = {}) => {
  const log = vi.fn((_t: string): void => undefined);
  const logError = vi.fn((_t: string): void => undefined);
  return {
    log,
    logError,
    io: {
      argv: [],
      log,
      logError,
      readFile: async () => MANIFEST,
      listDir: async (dir: string) => CLEAN_TREE[dir as keyof typeof CLEAN_TREE] ?? [],
      ...over,
    } as ArchInventoryIo,
  };
};

describe("runCli", () => {
  test("exits 0 and says so when the inventories match the tree", async () => {
    const { io: i, log } = io();
    expect(await runCli(i)).toBe(EXIT_CLEAN);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("no drift");
  });

  test("exits 1 and names the stale entry on the default manifest path", async () => {
    const { io: i, log } = io({
      readFile: async (path) => {
        expect(path).toBe(DEFAULT_MANIFEST_PATH);
        return MANIFEST;
      },
      listDir: async () => [],
    });
    expect(await runCli(i)).toBe(EXIT_DRIFT);
    const text = log.mock.calls.map(([line]) => line).join("\n");
    expect(text).toContain("Demo entities");
    expect(text).toContain("stale 1: Widget");
    expect(text).toContain("0 missing, 1 stale");
  });

  test("exits 1 and names the missing module", async () => {
    const { io: i, log } = io({
      readFile: async () =>
        MANIFEST.replace("entities: [Widget]", "entities: []"),
      listDir: async () => ["Widget.ts"],
    });
    expect(await runCli(i)).toBe(EXIT_DRIFT);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("missing 1: Widget");
  });

  test("takes the manifest path from argv", async () => {
    const { io: i } = io({
      argv: ["elsewhere/manifest.yaml"],
      readFile: async (path) => {
        expect(path).toBe("elsewhere/manifest.yaml");
        return MANIFEST;
      },
    });
    expect(await runCli(i)).toBe(EXIT_CLEAN);
  });

  test("an unreadable manifest is malformed, not drift", async () => {
    const { io: i, logError } = io({
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("cannot read");
  });

  test("keeps a non-Error throw from readFile", async () => {
    const { io: i, logError } = io({
      readFile: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "disk on fire";
      },
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("disk on fire");
  });

  test("a malformed manifest reports its reason with the path", async () => {
    const { io: i, logError } = io({ readFile: async () => "bounded_contexts: notalist\n" });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("manifest.yaml: ");
  });

  test("a summary line counts contexts and lists checked", async () => {
    const { io: i, log } = io();
    await runCli(i);
    const text = log.mock.calls.map(([line]) => line).join("\n");
    expect(text).toMatch(/1 context.*7 list/s);
  });
});
