import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, errorText } from "../cli.js";
import { asHashRecord, PLAN_REVIEW_LANE, rowHash } from "../lib/rows.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "plan-review-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const plan = [
  "# The plan",
  "",
  "| Lane | Delivers |",
  "|---|---|",
  "| **PT-5a** | The campaign id, exposed and resolvable. |",
  "| **D177** | Create is a server call. |",
].join("\n");

const writePlan = (dir: string, text = plan): string => {
  const path = join(dir, "plan.md");
  writeFileSync(path, text);
  return path;
};

interface ReviewDetail {
  readonly plan: string;
  readonly reviewer: string;
  readonly rows: Record<string, string>;
  readonly decisions?: Record<string, string>;
  readonly verdict: string;
}

const reviewLine = (wave: string, detail: ReviewDetail): string =>
  `${JSON.stringify({
    ts: "2026-09-28T10:00:00Z",
    wave,
    lane: PLAN_REVIEW_LANE,
    stage: "plan-review",
    event: "settled",
    detail,
  })}\n`;

const dispatchLine = (wave: string, lane: string): string =>
  `${JSON.stringify({
    ts: "2026-09-28T11:00:00Z",
    wave,
    lane,
    stage: "dispatch",
    event: "started",
  })}\n`;

const io = (log: string[] = [], errors: string[] = []) => ({
  argv: [] as readonly string[],
  log: (text: string): void => void log.push(text),
  logError: (text: string): void => void errors.push(text),
  readFile: async (path: string) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(path, "utf8");
  },
});

describe("runCli hashes", () => {
  test("prints the compact rows/decisions map for the given ids", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const log: string[] = [];
    const code = await runCli({
      ...io(log),
      argv: ["hashes", planPath, "PT-5a", "D177"],
    });
    expect(code).toBe(0);
    expect(log).toEqual([
      JSON.stringify({
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        decisions: { D177: rowHash(plan, "D177") },
      }),
    ]);
  });

  test("an id where the D is not followed by a digit is a lane row, per the ^D\\d+ rule", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir, `${plan}\n| **DECISION** | Not a decision row. |`);
    const log: string[] = [];
    await runCli({ ...io(log), argv: ["hashes", planPath, "DECISION"] });
    expect(JSON.parse(log[0])).toEqual({ rows: { DECISION: expect.any(String) }, decisions: {} });
  });

  test("no plan argument prints usage and exits 2", async () => {
    const errors: string[] = [];
    const code = await runCli({ ...io([], errors), argv: ["hashes"] });
    expect(code).toBe(2);
    expect(errors[0]).toContain("usage:");
  });

  test("an unreadable plan rejects — the entry guard turns it into exit 1", async () => {
    await expect(
      runCli({ ...io(), argv: ["hashes", "/nonexistent/plan.md", "PT-5a"] }),
    ).rejects.toThrow(/nonexistent/);
  });

  test("an id with zero rows rejects instead of hashing a neighbouring line", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    await expect(runCli({ ...io(), argv: ["hashes", planPath, "PT-9"] })).rejects.toThrow(
      /found 0/,
    );
  });

  test("an unknown subcommand prints usage and exits 2", async () => {
    const errors: string[] = [];
    const code = await runCli({ ...io([], errors), argv: ["fingerprint", "p.md"] });
    expect(code).toBe(2);
    expect(errors[0]).toContain("usage:");
  });
});

describe("runCli check", () => {
  const writeLog = (dir: string, lines: readonly string[]): string => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "events.jsonl");
    writeFileSync(path, lines.join(""));
    return dir;
  };

  test("exit 0 when the verdict is clear and every reviewed hash still matches", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        decisions: { D177: rowHash(plan, "D177") },
        verdict: "clear",
      }),
    ]);
    const code = await runCli({
      ...io(),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(0);
  });

  test("exit 1 names the rows and decisions that changed since the review", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        decisions: { D177: rowHash(plan, "D177") },
        verdict: "clear",
      }),
    ]);
    const edited = plan.replace("The campaign id, exposed", "The campaign id, hidden");
    writePlan(dir, edited);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("PT-5a");
  });

  test("exit 1 names a decision row that changed even when the lane row did not", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        decisions: { D177: rowHash(plan, "D177") },
        verdict: "clear",
      }),
    ]);
    writePlan(dir, plan.replace("Create is a server call.", "Create is a client call."));
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("D177");
  });

  test("exit 1 when the lane row vanished from the plan after the review", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "clear",
      }),
    ]);
    writePlan(dir, plan.replace("| **PT-5a** | The campaign id, exposed and resolvable. |\n", ""));
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no unambiguous row");
  });

  test("the latest review wins when a wave was reviewed twice", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const stale = rowHash(plan.replace("exposed and resolvable", "stale and unreviewed"), "PT-5a");
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "earlier",
        rows: { "PT-5a": stale },
        verdict: "clear",
      }),
      reviewLine("W", {
        plan: planPath,
        reviewer: "later",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "clear",
      }),
    ]);
    const code = await runCli({
      ...io(),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(0);
  });

  test("exit 3 on changes-required", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "changes-required",
      }),
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(3);
    expect(errors.join("\n")).toContain("changes-required");
  });

  test("exit 2 when no review was recorded for the wave", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [dispatchLine("W", "PT-5a")]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("no plan-review settled event");
  });

  test("exit 2 when the events log is missing", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", join(dir, "absent"), "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("could not read");
  });

  test("exit 2 when the lane is absent from the review's rows", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5b1": rowHash(plan, "PT-5a") },
        verdict: "clear",
      }),
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("absent from the review's rows");
  });

  test("exit 2 when the latest review's rows map is not a string map", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      `${JSON.stringify({
        ts: "2026-09-28T10:00:00Z",
        wave: "W",
        lane: PLAN_REVIEW_LANE,
        stage: "plan-review",
        event: "settled",
        detail: { rows: { "PT-5a": 7 }, verdict: "clear" },
      })}\n`,
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("no usable rows map");
  });

  test("exit 2 when the review carries no verdict", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      `${JSON.stringify({
        ts: "2026-09-28T10:00:00Z",
        wave: "W",
        lane: PLAN_REVIEW_LANE,
        stage: "plan-review",
        event: "settled",
        detail: { rows: { "PT-5a": rowHash(plan, "PT-5a") } },
      })}\n`,
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("no verdict");
  });

  test("exit 1 when the verdict is neither clear nor changes-required", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "unclear",
      }),
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("neither clear nor changes-required");
  });

  test("exit 2 when the plan cannot be read", async () => {
    const dir = tempDir();
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: join(dir, "plan.md"),
        reviewer: "plan-review-seat",
        rows: { "PT-5a": "aa" },
        verdict: "clear",
      }),
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", join(dir, "plan.md"), "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("could not read");
  });

  test.each([
    ["a missing --logdir value", ["check", "p.md", "--logdir"]],
    ["an unknown option", ["check", "p.md", "--logdir", "d", "--wave", "W", "--pr", "1", "PT-5a"]],
    ["too few positionals", ["check", "p.md", "--logdir", "d", "--wave", "W"]],
    ["flags without values", ["check", "p.md", "--wave", "W", "PT-5a"]],
    ["no --wave at all", ["check", "p.md", "--logdir", "d", "PT-5a"]],
  ])("usage error — %s — exits 2 with usage", async (_name, argv) => {
    const errors: string[] = [];
    const code = await runCli({ ...io([], errors), argv });
    expect(code).toBe(2);
    expect(errors[0]).toContain("usage:");
  });
});

describe("errorText", () => {
  test("an Error's message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  test("an Error with no message falls back to its name", () => {
    expect(errorText(new Error())).toBe("Error");
  });

  test("a thrown string is its own text", () => {
    expect(errorText("boom")).toBe("boom");
  });

  test("anything else is stringified", () => {
    expect(errorText(7)).toBe("7");
  });
});

describe("the entry guard", () => {
  const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));

  test("does nothing when the module is not the invoked script", async () => {
    vi.resetModules();
    const saved = process.argv;
    process.argv = [saved[0] ?? "node"];
    try {
      await import("../cli.js");
    } finally {
      process.argv = saved;
    }
  });

  test("runs the command and reports its exit code when invoked as the script", async () => {
    vi.resetModules();
    const dir = tempDir();
    const planPath = writePlan(dir);
    const saved = process.argv;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [saved[0] ?? "node", cliPath, "hashes", planPath, "PT-5a"];
    try {
      await import("../cli.js");
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("rows")));
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = saved;
      logSpy.mockRestore();
      process.exitCode = undefined;
    }
  });

  test("a failing command prints the error and exits 1", async () => {
    vi.resetModules();
    const saved = process.argv;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [saved[0] ?? "node", cliPath, "hashes", "/nonexistent/plan.md", "PT-5a"];
    try {
      await import("../cli.js");
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = saved;
      errorSpy.mockRestore();
      process.exitCode = undefined;
    }
  });

  test("a usage error through the entry sets the command's own exit code", async () => {
    vi.resetModules();
    const saved = process.argv;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [saved[0] ?? "node", cliPath, "hashes"];
    try {
      await import("../cli.js");
      await vi.waitFor(() => expect(process.exitCode).toBe(2));
    } finally {
      process.argv = saved;
      errorSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
