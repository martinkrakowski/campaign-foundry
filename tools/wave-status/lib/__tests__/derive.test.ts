import { describe, test, expect } from "vitest";
import { deriveLane, parseGateLog, parseLastExit } from "../derive.js";

const coverageSummary = (overrides: Record<string, string> = {}): string =>
  [
    "=============================== Coverage summary ===============================",
    `Statements   : ${overrides.statements ?? "100% ( 8116/8116 )"}`,
    `Branches     : ${overrides.branches ?? "100% ( 5762/5762 )"}`,
    `Functions    : ${overrides.functions ?? "100% ( 1681/1681 )"}`,
    `Lines        : ${overrides.lines ?? "100% ( 7062/7062 )"}`,
    "================================================================================",
  ].join("\n");

describe("parseLastExit — the dispatch script's EXIT-marker contract", () => {
  test("an EXIT 1 tail with a body above it reads exit 1", () => {
    expect(parseLastExit("building...\nrun failed: ECONNREFUSED\nEXIT 1\n")).toBe(1);
  });

  test("two markers: the last one wins — a retried lane's earlier failure is history", () => {
    expect(parseLastExit("first attempt died\nEXIT 1\nretrying\nfinished clean\nEXIT 0\n")).toBe(0);
    expect(
      deriveLane({
        alive: false,
        log: {
          bytes: 64,
          mtimeMs: 1,
          tail: "first attempt died\nEXIT 1\nretrying\nfinished clean\nEXIT 0\n",
        },
      }).exit,
    ).toBe(0);
  });

  test("no marker — a lane still working — leaves exit absent", () => {
    expect(parseLastExit("working, no output yet")).toBeUndefined();
  });

  test("a body line that merely mentions EXIT is not a marker", () => {
    expect(parseLastExit("grep EXIT patterns here\nEXIT 0\n")).toBe(0);
    expect(parseLastExit("the marker is EXIT not EXIT-ish\n")).toBeUndefined();
  });

  test("a trailing space on the EXIT marker is still a marker — last one still wins", () => {
    expect(parseLastExit("first attempt died\nEXIT 1\nretrying\nEXIT 0 ")).toBe(0);
  });
});

describe("parseGateLog — the gate log's coverage summary and exit", () => {
  test("the four istanbul summary lines produce the four counters", () => {
    const gate = parseGateLog(`${coverageSummary()}\nEXIT 0\n`);
    expect(gate.coverage).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
    expect(gate.exit).toBe(0);
  });

  test("an indented istanbul summary still produces the four counters", () => {
    const indented = coverageSummary()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const gate = parseGateLog(`${indented}\nEXIT 0\n`);
    expect(gate.coverage).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
  });

  test("fractional counters parse as numbers, not strings", () => {
    const gate = parseGateLog(
      `${coverageSummary({ branches: "98.5% ( 5700/5786 )", lines: "87.25% ( 6160/7062 )" })}\nEXIT 0\n`,
    );
    expect(gate.coverage).toEqual({
      statements: 100,
      branches: 98.5,
      functions: 100,
      lines: 87.25,
    });
  });

  test("GATE EXIT 0 trailing is accepted as the gate's exit", () => {
    expect(parseGateLog(`${coverageSummary()}\nGATE EXIT 0\n`).exit).toBe(0);
    expect(parseGateLog("...\nGATE EXIT 1\n").exit).toBe(1);
  });

  test("a trailing space on GATE EXIT is still the gate's exit — last marker still wins", () => {
    expect(parseGateLog("GATE EXIT 1\nGATE EXIT 0 ").exit).toBe(0);
  });

  test("a trailing space on the gate log EXIT marker is still the gate's exit", () => {
    expect(parseGateLog(`${coverageSummary()}\nEXIT 0 `).exit).toBe(0);
  });

  test("a non-trailing exit line is not the gate's exit", () => {
    const gate = parseGateLog(`EXIT 0\n${coverageSummary()}\n`);
    expect(gate.exit).toBeUndefined();
    expect(gate.coverage).toBeDefined();
  });

  test("three of four counters is not a summary — coverage stays absent, nothing defaulted", () => {
    const text = coverageSummary()
      .split("\n")
      .filter((line) => !line.startsWith("Functions"))
      .join("\n");
    const gate = parseGateLog(`${text}\nEXIT 0\n`);
    expect(gate.coverage).toBeUndefined();
    expect(gate.exit).toBe(0);
  });

  test("a gate log with no summary and no exit yields an empty fact set", () => {
    expect(parseGateLog("yarn run test:cov\nrunning...\n")).toEqual({});
  });
});

describe("deriveLane — derived facts stay absent when the observation lacks them", () => {
  test("an EXIT 1 log tail with a body above it yields exit 1", () => {
    const derived = deriveLane({
      alive: false,
      log: { bytes: 1024, mtimeMs: 1_000, tail: "opencode run\nerror: locked\nEXIT 1\n" },
    });
    expect(derived.exit).toBe(1);
    expect(derived.alive).toBe(false);
    expect(derived.log).toEqual({ bytes: 1024, mtimeMs: 1_000, tail: "opencode run\nerror: locked\nEXIT 1\n" });
  });

  test("no log, no gate log: exit and gate stay absent — never defaulted", () => {
    expect(deriveLane({ alive: true })).toEqual({ alive: true });
  });

  test("a log without an EXIT marker leaves exit absent while the log itself is kept", () => {
    const log = { bytes: 0, mtimeMs: 5_000, tail: "" };
    const derived = deriveLane({ alive: true, log });
    expect(derived.exit).toBeUndefined();
    expect(derived.log).toBe(log);
  });

  test("a gate log produces the gate facts; its absence produces no gate object", () => {
    const withGate = deriveLane({ alive: false, gateLog: `${coverageSummary()}\nGATE EXIT 0\n` });
    expect(withGate.gate).toEqual({
      exit: 0,
      coverage: { statements: 100, branches: 100, functions: 100, lines: 100 },
    });
    expect(deriveLane({ alive: false }).gate).toBeUndefined();
    expect(deriveLane({ alive: true, gateLog: "yarn run test:cov\nrunning...\n" }).gate).toBeUndefined();
  });

  test("coverage without a trailing gate exit still produces a gate object", () => {
    const derived = deriveLane({ alive: true, gateLog: coverageSummary() });
    expect(derived.gate?.exit).toBeUndefined();
    expect(derived.gate?.coverage).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
  });

  test("a trailing GATE EXIT without a coverage summary still produces gate.exit", () => {
    expect(deriveLane({ alive: false, gateLog: "GATE EXIT 1\n" }).gate).toEqual({ exit: 1 });
  });

  test("pr and diff observations pass through untouched", () => {
    const pr = {
      number: 218,
      state: "open" as const,
      checks: "pending" as const,
    };
    const diff = { files: 3, insertions: 120, deletions: 14 };
    const derived = deriveLane({ alive: true, pr, diff });
    expect(derived.pr).toEqual(pr);
    expect(derived.diff).toEqual(diff);
  });
});
