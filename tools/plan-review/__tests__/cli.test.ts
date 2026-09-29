import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, errorText } from "../cli.js";
import { asHashRecord, PLAN_REVIEW_LANE, rowHash, rowRisk } from "../lib/rows.js";

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
  readdir: async (dir: string) => {
    const { readdir } = await import("node:fs/promises");
    return readdir(dir);
  },
  exists: (path: string): boolean => existsSync(path),
  env: {} as { readonly HOME?: string; readonly WAVE_LOG_ROOT?: string },
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
        risk: { "PT-5a": "normal" },
      }),
    ]);
  });

  test("an id where the D is not followed by a digit is a lane row, per the ^D\\d+ rule", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir, `${plan}\n| **DECISION** | Not a decision row. |`);
    const log: string[] = [];
    await runCli({ ...io(log), argv: ["hashes", planPath, "DECISION"] });
    expect(JSON.parse(log[0])).toEqual({
      rows: { DECISION: expect.any(String) },
      decisions: {},
      risk: { DECISION: "normal" },
    });
  });

  test("a row whose second cell is a bolded high reports risk high, alongside its hash", async () => {
    const dir = tempDir();
    const risky = [
      "| Lane | Risk | Delivers |",
      "|---|---|---|",
      "| **HX1** | **high** | Split the reserved list. |",
    ].join("\n");
    const planPath = writePlan(dir, risky);
    const log: string[] = [];
    await runCli({ ...io(log), argv: ["hashes", planPath, "HX1"] });
    expect(JSON.parse(log[0])).toEqual({
      rows: { HX1: rowHash(risky, "HX1") },
      decisions: {},
      risk: { HX1: "high" },
    });
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

  test("check reports the row's risk once the plan is read, per D184", async () => {
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
    const log: string[] = [];
    const code = await runCli({
      ...io(log),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(0);
    expect(log).toContain(`risk: ${rowRisk(plan, "PT-5a")}`);
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

  test("a review of a different plan is no review for this lane, even with identical rows", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const other = join(dir, "other.md");
    writeFileSync(other, plan);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: other,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "clear",
      }),
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("no review for this lane");
    expect(errors.join("\n")).toContain("other.md");
  });

  test("a review that names no plan file is no review for this lane", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      `${JSON.stringify({
        ts: "2026-09-28T10:00:00Z",
        wave: "W",
        lane: PLAN_REVIEW_LANE,
        stage: "plan-review",
        event: "settled",
        detail: {
          reviewer: "plan-review-seat",
          rows: { "PT-5a": rowHash(plan, "PT-5a") },
          verdict: "clear",
        },
      })}\n`,
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("names no plan file");
  });

  test("the plan compares resolved and cwd-relative, so an absolute command line matches a relative review", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: relative(process.cwd(), planPath),
        reviewer: "plan-review-seat",
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
        detail: { plan: planPath, rows: { "PT-5a": 7 }, verdict: "clear" },
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
        detail: { plan: planPath, rows: { "PT-5a": rowHash(plan, "PT-5a") } },
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

  test("a present but malformed decisions map is a broken record, not no decisions", async () => {
    // A non-string decision hash must not read as "the review recorded no
    // decisions": the gate would stop comparing a decision row that changed.
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      `${JSON.stringify({
        ts: "2026-09-28T10:00:00Z",
        wave: "W",
        lane: PLAN_REVIEW_LANE,
        stage: "plan-review",
        event: "settled",
        detail: {
          plan: planPath,
          reviewer: "plan-review-seat",
          rows: { "PT-5a": rowHash(plan, "PT-5a") },
          decisions: { D177: 7 },
          verdict: "clear",
        },
      })}\n`,
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("malformed decisions map");
  });

  test("a torn line newer than the review fails the gate, naming the line", async () => {
    // The review parsed, but the writer died mid-line after it: whatever the
    // tail held, the log cannot say the review is still the latest word.
    const dir = tempDir();
    const planPath = writePlan(dir);
    mkdirSync(join(dir, "waves"), { recursive: true });
    const logPath = join(dir, "waves", "events.jsonl");
    writeFileSync(
      logPath,
      `${reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "clear",
      })}{"ts":"2026-09-28T10:00:01Z","wave":"W"`,
    );
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", join(dir, "waves"), "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("unreadable line(s) 2");
  });

  test("a rejected line newer than the review fails the gate", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
        rows: { "PT-5a": rowHash(plan, "PT-5a") },
        verdict: "clear",
      }),
      `${JSON.stringify({
        ts: "2026-09-28T10:00:01Z",
        wave: "W",
        lane: PLAN_REVIEW_LANE,
        stage: "plan-review",
        event: "skipped",
      })}\n`,
    ]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["check", planPath, "--logdir", logdir, "--wave", "W", "PT-5a"],
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("unreadable line(s) 2");
  });

  test("an unreadable line older than the review does not block — the review supersedes it", async () => {
    const dir = tempDir();
    const planPath = writePlan(dir);
    const logdir = writeLog(join(dir, "waves"), [
      "\n",
      '{"ts":"2026-09-28T09:00:00Z","wave":"W"',
      "\n",
      reviewLine("W", {
        plan: planPath,
        reviewer: "plan-review-seat",
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

describe("runCli pre-pr-check", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  /** A temp repo root with an empty docs/planning/, made the process cwd (pre-pr-check's grep target is not injectable — this is the same trick a real invocation's own repo root gives it). */
  const chdirTemp = (): string => {
    const dir = tempDir();
    mkdirSync(join(dir, "docs", "planning"), { recursive: true });
    process.chdir(dir);
    return dir;
  };

  const writePlanningFile = (dir: string, name: string, text: string): void => {
    writeFileSync(join(dir, "docs", "planning", name), text);
  };

  const highPlan = [
    "| Lane | Risk | Delivers |",
    "|---|---|---|",
    "| **HX1** | **high** | Split the reserved list. |",
  ].join("\n");

  const writeLogdir = (dir: string, lines: readonly string[]): string => {
    const logdir = join(dir, "waves");
    mkdirSync(logdir, { recursive: true });
    writeFileSync(join(logdir, "events.jsonl"), lines.join(""));
    return logdir;
  };

  const preprReviewLine = (verdict: string): string =>
    `${JSON.stringify({
      ts: "2026-09-29T10:00:00Z",
      wave: "w06",
      lane: "HX1",
      stage: "review",
      event: "settled",
      detail: { verdict },
    })}\n`;

  const remediateLine = (): string =>
    `${JSON.stringify({
      ts: "2026-09-29T11:00:00Z",
      wave: "w06",
      lane: "HX1",
      stage: "remediate",
      event: "settled",
    })}\n`;

  test("a normal-risk lane passes without reading any wave log at all", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", plan); // PT-5a has no Risk column — normal
    const code = await runCli({
      ...io(),
      argv: ["pre-pr-check", "PT-5a", "--wave", "w06", "--logdir", join(dir, "absent")],
    });
    expect(code).toBe(0);
  });

  test("a lane found in no plan counts as normal and passes", async () => {
    const dir = chdirTemp();
    const code = await runCli({ ...io(), argv: ["pre-pr-check", "UNKNOWN-LANE", "--wave", "w06"] });
    expect(code).toBe(0);
  });

  test("a high-risk lane with a clear pre-PR review passes", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const logdir = writeLogdir(dir, [preprReviewLine("clear")]);
    const code = await runCli({
      ...io(),
      argv: ["pre-pr-check", "HX1", "--wave", "w06", "--logdir", logdir],
    });
    expect(code).toBe(0);
  });

  test("a high-risk lane with no stage=review event refuses, naming it", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const logdir = writeLogdir(dir, []);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["pre-pr-check", "HX1", "--wave", "w06", "--logdir", logdir],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no stage=review event=settled");
    expect(errors.join("\n")).toContain("HX1");
  });

  test("changes-required with no later remediate settled refuses", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const logdir = writeLogdir(dir, [preprReviewLine("changes-required")]);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["pre-pr-check", "HX1", "--wave", "w06", "--logdir", logdir],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("changes-required");
  });

  test("changes-required with a LATER remediate settled passes", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const logdir = writeLogdir(dir, [preprReviewLine("changes-required"), remediateLine()]);
    const code = await runCli({
      ...io(),
      argv: ["pre-pr-check", "HX1", "--wave", "w06", "--logdir", logdir],
    });
    expect(code).toBe(0);
  });

  test("an unreadable events log for a high-risk lane refuses (fail closed), not a usage error", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const errors: string[] = [];
    const code = await runCli({
      ...io([], errors),
      argv: ["pre-pr-check", "HX1", "--wave", "w06", "--logdir", join(dir, "absent")],
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("could not read");
  });

  test("--logdir omitted resolves exactly as wave-event.sh does, via WAVE_LOG_ROOT", async () => {
    const dir = chdirTemp();
    writePlanningFile(dir, "plan.md", highPlan);
    const root = join(dir, "waveroot");
    const logdir = join(root, "wave-w06");
    mkdirSync(logdir, { recursive: true });
    writeFileSync(join(logdir, "events.jsonl"), preprReviewLine("clear"));
    const code = await runCli({
      ...io(),
      env: { WAVE_LOG_ROOT: root },
      argv: ["pre-pr-check", "HX1", "--wave", "w06"],
    });
    expect(code).toBe(0);
  });

  test.each([
    ["no positional lane", ["pre-pr-check", "--wave", "w06"]],
    ["no --wave at all", ["pre-pr-check", "HX1"]],
    ["a missing --wave value", ["pre-pr-check", "HX1", "--wave"]],
    ["an unknown flag", ["pre-pr-check", "HX1", "--wave", "w06", "--plan", "p.md"]],
    ["too many positionals", ["pre-pr-check", "HX1", "HX2", "--wave", "w06"]],
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
    // Asserted, not assumed: if the guard ever starts executing on import —
    // with or without throwing — the command's output or its exit code would
    // give it away here, and this test fails.
    vi.resetModules();
    const saved = process.argv;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [saved[0] ?? "node"];
    try {
      await import("../cli.js");
      // The guard's command chain resolves asynchronously after the import;
      // give the task queue a turn before demanding silence.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.argv = saved;
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = undefined;
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

  test("pre-pr-check through the real entry wires readdir, exists and env from the process", async () => {
    // The only command that reaches those three deps — exercised here so the
    // real entry's own wiring (not just runCli's logic) is covered.
    vi.resetModules();
    const originalCwd = process.cwd();
    const dir = tempDir();
    mkdirSync(join(dir, "docs", "planning"), { recursive: true });
    process.chdir(dir);
    const saved = process.argv;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [saved[0] ?? "node", cliPath, "pre-pr-check", "UNKNOWN-LANE", "--wave", "w06"];
    try {
      await import("../cli.js");
      await vi.waitFor(() =>
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("risk=normal")),
      );
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = saved;
      logSpy.mockRestore();
      process.exitCode = undefined;
      process.chdir(originalCwd);
    }
  });
});
