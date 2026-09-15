import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest as hexagenLoadManifest } from "@hexagen-monaco/sync";
import type { Manifest as HexManifest, Result } from "@hexagen-monaco/sync";
import {
  DEFAULT_WORKSPACE_ROOT,
  EXIT_CLEAN,
  EXIT_DRIFT,
  EXIT_MALFORMED,
  runCli,
  type ArchInventoryIo,
} from "../cli.js";

const HEX_MANIFEST: HexManifest = {
  generator: {
    sync: {
      layers: { domain: { folder: "src/domain" } },
      stubs: { enabled: true },
    },
  },
  bounded_contexts: [{ name: "Demo", layers: { domain: { entities: ["Widget"] } } }],
};

const CLEAN_TREE: Record<string, readonly string[]> = {
  "packages/Demo/src/domain/entities": ["Widget.ts"],
};

const ok = (value: HexManifest): Result<HexManifest, Error> => ({ success: true, value });
const err = (error: Error): Result<HexManifest, Error> => ({ success: false, error });

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
      loadManifest: async () => ok(HEX_MANIFEST),
      listDir: async (dir: string) => CLEAN_TREE[dir] ?? [],
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

  test("exits 1 and names the stale entry on the default workspace root", async () => {
    const { io: i, log } = io({
      loadManifest: async (root) => {
        expect(root).toBe(DEFAULT_WORKSPACE_ROOT);
        return ok(HEX_MANIFEST);
      },
      listDir: async () => [],
    });
    expect(await runCli(i)).toBe(EXIT_DRIFT);
    const text = log.mock.calls.map(([line]) => line).join("\n");
    expect(text).toContain("Demo entities");
    expect(text).toContain("stale 1: Widget");
    expect(text).toContain("0 missing, 1 stale, 0 duplicate");
  });

  test("exits 1 and names the missing module", async () => {
    const { io: i, log } = io({
      loadManifest: async () =>
        ok({ ...HEX_MANIFEST, bounded_contexts: [{ name: "Demo", layers: { domain: { entities: [] } } }] }),
      listDir: async () => ["Widget.ts"],
    });
    expect(await runCli(i)).toBe(EXIT_DRIFT);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("missing 1: Widget");
  });

  test("takes the workspace root from argv", async () => {
    const { io: i } = io({
      argv: ["elsewhere"],
      loadManifest: async (root) => {
        expect(root).toBe("elsewhere");
        return ok(HEX_MANIFEST);
      },
    });
    expect(await runCli(i)).toBe(EXIT_CLEAN);
  });

  test("a manifest hexagen's own loader could not load is malformed, not drift", async () => {
    const { io: i, logError } = io({
      loadManifest: async () => err(new Error(".architecture/manifest.yaml not found")),
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("cannot load the manifest");
  });

  test("keeps a non-Error rejection from hexagen's loader", async () => {
    const { io: i, logError } = io({
      loadManifest: async () => err("disk on fire" as unknown as Error),
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("disk on fire");
  });

  test("an unknown error while resolving the manifest exits malformed, not uncaught", async () => {
    // A stub naming template with no {name} is a NamingError from this
    // tool's own naming resolution (not something hexagen's loader would
    // reject) — the CLI must not distinguish it from any other failure and
    // must never let it escape as an uncaught rejection.
    const { io: i, logError } = io({
      loadManifest: async () =>
        ok({
          generator: { sync: { stubs: { naming: { entity: "fixed.ts" } } } },
          bounded_contexts: [{ name: "Demo", layers: { domain: { entities: ["Widget"] } } }],
        }),
    });
    expect(await runCli(i)).toBe(EXIT_MALFORMED);
    expect(logError.mock.calls[0]?.[0]).toContain("manifest: ");
  });

  test("a summary line counts contexts and lists checked", async () => {
    const { io: i, log } = io();
    await runCli(i);
    const text = log.mock.calls.map(([line]) => line).join("\n");
    expect(text).toMatch(/1 context.*7 list/s);
  });
});

describe("runCli against hexagen's real loadManifest", () => {
  test("a YAML anchor/alias inside bounded_contexts resolves for both contexts", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-inventory-"));
    try {
      mkdirSync(join(root, ".architecture"), { recursive: true });
      writeFileSync(
        join(root, ".architecture", "manifest.yaml"),
        [
          "bounded_contexts:",
          "  - name: Demo",
          "    layers: &shared",
          "      domain:",
          "        entities: [Widget]",
          "  - name: DemoTwin",
          "    layers: *shared",
          "",
        ].join("\n"),
        "utf8",
      );
      const log = vi.fn((_t: string): void => undefined);
      const logError = vi.fn((_t: string): void => undefined);
      const listDir = async (dir: string) =>
        dir.endsWith("entities") ? ["Widget.ts"] : [];
      const exitCode = await runCli({
        argv: [root],
        log,
        logError,
        loadManifest: hexagenLoadManifest,
        listDir,
      });
      expect(exitCode).toBe(EXIT_CLEAN);
      const text = log.mock.calls.map(([line]) => line).join("\n");
      expect(text).toContain("2 context(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
