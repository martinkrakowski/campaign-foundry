import { describe, expect, test, vi } from "vitest";
import { PLAN_DIR, runCli, type PlanVerifyIo } from "../cli.js";

const io = (over: Partial<PlanVerifyIo> = {}): { io: PlanVerifyIo; log: ReturnType<typeof vi.fn> } => {
  const log = vi.fn((_t: string): void => undefined);
  return {
    log,
    io: {
      argv: [],
      log,
      readFile: async () => "```premise W1\ntrue\n```",
      listPlanDir: async (): Promise<readonly string[]> => ["a.md"],
      deps: { execute: async () => ({ exitCode: 0, output: "" }) },
      ...over,
    },
  };
};

describe("runCli", () => {
  test("exits 0 and says so when every premise holds", async () => {
    const { io: i, log } = io();
    expect(await runCli(i)).toBe(0);
    expect(log).toHaveBeenCalledWith("1 premise(s) hold; no lane is stale.");
  });

  test("exits 1 and names the lane when a premise is stale", async () => {
    const { io: i, log } = io({ deps: { execute: async () => ({ exitCode: 1, output: "" }) } });
    expect(await runCli(i)).toBe(1);
    expect(log.mock.calls[0]?.[0]).toContain("STALE  W1");
  });

  test("with no arguments it reads the planning directory, ignoring non-markdown", async () => {
    const readFile = vi.fn(async (_p: string) => "```premise X\ntrue\n```");
    const listPlanDir = async (): Promise<readonly string[]> => ["b.md", "notes.txt", "a.md"];
    await runCli(io({ listPlanDir, readFile }).io);
    expect(readFile.mock.calls.map((c) => c[0])).toEqual([
      `${PLAN_DIR}/a.md`,
      `${PLAN_DIR}/b.md`,
    ]);
  });

  test("given paths, it checks exactly those and never lists the directory", async () => {
    const listPlanDir = vi.fn(async (): Promise<readonly string[]> => []);
    const readFile = vi.fn(async (_p: string) => "```premise X\ntrue\n```");
    await runCli(io({ argv: ["one.md", "two.md"], listPlanDir, readFile }).io);
    expect(listPlanDir).not.toHaveBeenCalled();
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(["one.md", "two.md"]);
  });

  test("a plan with no premises is not an error", async () => {
    const { io: i, log } = io({ readFile: async () => "# just prose" });
    expect(await runCli(i)).toBe(0);
    expect(log).toHaveBeenCalledWith("0 premise(s) hold; no lane is stale.");
  });

  test("an emptied premise fails the run, naming the plan and the lane", async () => {
    const { io: i } = io({ readFile: async () => "```premise W9\n   \n```" });
    await expect(runCli(i)).rejects.toThrow(/EMPTY\s+W9\s+\(docs\/planning\/a\.md\)/);
  });
});
