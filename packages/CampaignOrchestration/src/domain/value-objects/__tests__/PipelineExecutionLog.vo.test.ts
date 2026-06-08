import { describe, test, expect } from "vitest";
import { PipelineExecutionLog } from "../PipelineExecutionLog.vo.js";

describe("PipelineExecutionLog", () => {
  test("record appends an entry with the given stage, message and level", () => {
    const log = new PipelineExecutionLog("camp");
    log.record("ValidateBriefIntegrity", "ok", "warn");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      stage: "ValidateBriefIntegrity",
      message: "ok",
      level: "warn",
    });
    expect(log.entries[0].timestamp).toBeInstanceOf(Date);
  });

  test("record defaults to info level", () => {
    const log = new PipelineExecutionLog("camp");
    log.record("Stage", "message");
    expect(log.entries[0].level).toBe("info");
  });

  test("entries reflects every recorded line in order", () => {
    const log = new PipelineExecutionLog("camp");
    log.record("A", "first");
    log.record("B", "second");
    expect(log.entries.map((e) => e.message)).toEqual(["first", "second"]);
  });

  test("complete stamps completedAt", () => {
    const log = new PipelineExecutionLog("camp");
    expect(log.completedAt).toBeUndefined();
    log.complete();
    expect(log.completedAt).toBeInstanceOf(Date);
  });

  test("toJSON serializes the campaign id, totals and entries", () => {
    const log = new PipelineExecutionLog("camp");
    log.totalOperations = 6;
    log.record("Stage", "message");
    log.complete();
    const json = log.toJSON();
    expect(json).toMatchObject({ campaignId: "camp", totalOperations: 6 });
    expect(json.startedAt).toBeInstanceOf(Date);
    expect(json.completedAt).toBeInstanceOf(Date);
    expect(json.entries).toHaveLength(1);
  });
});
