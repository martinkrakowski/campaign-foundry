import { describe, test, expect } from "vitest";
import { PipelineExecutionLog } from "../PipelineExecutionLog.vo.js";

const STARTED = new Date("2026-01-01T00:00:00.000Z");
const RECORDED = new Date("2026-01-01T00:00:01.000Z");
const COMPLETED = new Date("2026-01-01T00:00:02.000Z");

const sequencedClock = (times: Date[]): (() => Date) => {
  let i = 0;
  return () => {
    const next = times[i];
    if (next === undefined) throw new Error("clock exhausted");
    i += 1;
    return next;
  };
};

const frozen = (): Date => STARTED;

describe("PipelineExecutionLog", () => {
  test("stamps startedAt, record, and complete from successive clock reads", () => {
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, RECORDED, COMPLETED]));
    expect(log.startedAt).toBe(STARTED);
    log.record("Stage", "message");
    expect(log.entries[0].timestamp).toBe(RECORDED);
    log.complete();
    expect(log.completedAt).toBe(COMPLETED);
  });

  test("record appends an entry with the given stage, message and level", () => {
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, RECORDED]));
    log.record("ValidateBriefIntegrity", "ok", "warn");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      stage: "ValidateBriefIntegrity",
      message: "ok",
      level: "warn",
      timestamp: RECORDED,
    });
  });

  test("record defaults to info level", () => {
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, RECORDED]));
    log.record("Stage", "message");
    expect(log.entries[0].level).toBe("info");
    expect(log.entries[0].timestamp).toBe(RECORDED);
  });

  test("entries reflects every recorded line in order", () => {
    const second = new Date("2026-01-01T00:00:01.500Z");
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, RECORDED, second]));
    log.record("A", "first");
    log.record("B", "second");
    expect(log.entries.map((e) => e.message)).toEqual(["first", "second"]);
    expect(log.entries.map((e) => e.timestamp)).toEqual([RECORDED, second]);
  });

  test("complete stamps completedAt from the clock", () => {
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, COMPLETED]));
    expect(log.completedAt).toBeUndefined();
    log.complete();
    expect(log.completedAt).toBe(COMPLETED);
  });

  test("toJSON serializes the campaign id, totals and entries", () => {
    const log = new PipelineExecutionLog("camp", sequencedClock([STARTED, RECORDED, COMPLETED]));
    log.totalOperations = 6;
    log.record("Stage", "message");
    log.complete();
    const json = log.toJSON();
    expect(json).toMatchObject({ campaignId: "camp", totalOperations: 6 });
    expect(json.startedAt).toBe(STARTED);
    expect(json.completedAt).toBe(COMPLETED);
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0].timestamp).toBe(RECORDED);
  });

  test("a frozen clock yields the same instant on every stamp", () => {
    const log = new PipelineExecutionLog("camp", frozen);
    log.record("Stage", "message");
    log.complete();
    expect(log.startedAt).toBe(STARTED);
    expect(log.entries[0].timestamp).toBe(STARTED);
    expect(log.completedAt).toBe(STARTED);
  });
});
