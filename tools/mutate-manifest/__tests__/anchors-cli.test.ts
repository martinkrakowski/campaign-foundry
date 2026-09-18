import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_MANIFEST_DIR,
  EXIT_UNUSABLE,
  runAnchorCli,
  type AnchorCliIo,
} from "../anchors-cli.js";

const manifestText = JSON.stringify({
  version: 1,
  lane: "W4",
  mutations: [
    {
      file: "src/target.ts",
      before: "const gate = true;",
      after: "const gate = false;",
      because: "the guard must red",
      command: ["yarn", "t"],
      verdict: "caught",
    },
  ],
});

const io = (over: Partial<AnchorCliIo> = {}): AnchorCliIo & { logs: string[] } => {
  const logs: string[] = [];
  return {
    logs,
    argv: [],
    log: (text) => logs.push(text),
    logError: (text) => logs.push(text),
    listManifests: async () => ["d/m.json"],
    deps: {
      readText: async (path) => (path.endsWith(".json") ? manifestText : "const gate = true;\n"),
    },
    ...over,
  };
};

describe("runAnchorCli", () => {
  test("passes a tree whose anchors all resolve", async () => {
    const cli = io();
    expect(await runAnchorCli(cli)).toBe(0);
    expect(cli.logs.join("\n")).toContain("Every live anchor resolves exactly once");
  });

  test("fails, non-zero, on a dead anchor", async () => {
    const cli = io({ deps: { readText: async (p) => (p.endsWith(".json") ? manifestText : "") } });
    expect(await runAnchorCli(cli)).toBe(1);
    expect(cli.logs.join("\n")).toContain("DEAD ANCHOR  d/m.json#0");
  });

  test("walks the whole directory, never a diff — that is the hole it exists to close", async () => {
    const listManifests = vi.fn(async () => ["d/m.json"]);
    await runAnchorCli(io({ listManifests }));
    expect(listManifests).toHaveBeenCalledWith(DEFAULT_MANIFEST_DIR);
  });

  test("checks the directory it is given when one is named", async () => {
    const listManifests = vi.fn(async () => ["d/m.json"]);
    await runAnchorCli(io({ argv: ["elsewhere/manifests"], listManifests }));
    expect(listManifests).toHaveBeenCalledWith("elsewhere/manifests");
  });

  test("refuses to call a directory it cannot list 'nothing to check'", async () => {
    const cli = io({
      listManifests: async () => {
        throw new Error("EACCES");
      },
    });
    expect(await runAnchorCli(cli)).toBe(EXIT_UNUSABLE);
    expect(cli.logs.join("\n")).toContain("refusing to report that as nothing to check");
  });

  test("names a non-Error listing failure rather than printing [object Object]", async () => {
    const cli = io({
      listManifests: async () => {
        throw "EPERM";
      },
    });
    expect(await runAnchorCli(cli)).toBe(EXIT_UNUSABLE);
    expect(cli.logs.join("\n")).toContain("EPERM");
  });

  test("says so, out loud, when the directory holds no manifests at all", async () => {
    const cli = io({ listManifests: async () => [] });
    expect(await runAnchorCli(cli)).toBe(0);
    expect(cli.logs.join("\n")).toContain("no manifests in .agents/manifests; nothing to check");
  });
});
