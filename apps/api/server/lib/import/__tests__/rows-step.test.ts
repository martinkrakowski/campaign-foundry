import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashBytes } from "../../brief-files.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import type { ReportStorePort } from "../../ports/report-store.port.js";
import { importReportRow } from "../rows-step.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";

/** A report as a hand might leave it: valid JSON, but not the bytes `JSON.stringify` writes. */
const LOOSE = Buffer.from('{\n  "assets":  [ ],\n\t"outputPath": "camp/a.png"  }\n', "utf8");

type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

/** The stored row for `camp`, read straight from the table (never through the store). */
async function row(env: Env): Promise<{ body: string; revision: string; at: string } | undefined> {
  const { rows } = await env.db.query<{ body: string; revision: string; at: string }>(
    "select body, revision, updated_at::text as at from report where org_id = $1 and campaign_id = $2",
    ["local", "camp"],
  );
  return rows[0];
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("rows-step: importReportRow", () => {
  let env: Env;
  let reports: ReportStorePort;
  beforeEach(async () => {
    env = await useApplyEnvironment();
    reports = new PgReportStore(env.db, "local");
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("a report is stored with the file's exact bytes, so its revision is the sha256 of the source", async () => {
    const result = await importReportRow(reports, "camp", LOOSE);
    expect(result).toEqual({ kind: "report", status: "written", revision: hashBytes(LOOSE) });
    const stored = await row(env);
    expect(stored?.revision).toBe(hashBytes(LOOSE));
    expect(stored?.body).toBe(LOOSE.toString("utf8"));
  });
});
