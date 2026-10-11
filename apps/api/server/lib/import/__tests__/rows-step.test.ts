import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashBytes } from "../../brief-files.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import type { ReportStorePort } from "../../ports/report-store.port.js";
import { importReport, importReportRow, readReviewed } from "../rows-step.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

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

  test("a second import of the same bytes is skipped and the row is not touched", async () => {
    await importReportRow(reports, "camp", LOOSE);
    const before = await row(env);
    const result = await importReportRow(reports, "camp", LOOSE);
    expect(result).toEqual({ kind: "report", status: "skipped", revision: hashBytes(LOOSE) });
    expect(await row(env)).toEqual(before);
  });

  test("a different stored report is refused and left as it was", async () => {
    const theirs = '{"assets":["a user ran this campaign"]}';
    await reports.writeReport("camp", theirs);
    const before = await row(env);
    const result = await importReportRow(reports, "camp", LOOSE);
    expect(result.status).toBe("refused");
    expect(result.revision).toBe(hashBytes(LOOSE));
    expect(result.reason).toBe(
      `a different report is already stored for camp (revision ${before?.revision})`,
    );
    expect(await row(env)).toEqual(before);
  });

  test("bytes that are not valid UTF-8 are refused before any write", async () => {
    const broken = Buffer.from([0x7b, 0xff, 0x7d]);
    const result = await importReportRow(reports, "camp", broken);
    expect(result).toEqual({
      kind: "report",
      status: "refused",
      revision: hashBytes(broken),
      reason: "reports/camp.json is not valid UTF-8, so its exact bytes cannot be stored",
    });
    expect(await row(env)).toBeUndefined();
  });

  test("a store failure that is not a conflict is thrown, not turned into a refusal", async () => {
    const failing = {
      writeReport: async () => {
        throw new Error("the database went away");
      },
    } as unknown as ReportStorePort;
    await expect(importReportRow(failing, "camp", LOOSE)).rejects.toThrow("the database went away");
  });

  test("bytes that are not JSON are refused before any write", async () => {
    const broken = Buffer.from('{"assets": [', "utf8");
    const result = await importReportRow(reports, "camp", broken);
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/^reports\/camp\.json is not JSON \(/);
    expect(await row(env)).toBeUndefined();
  });

  test("JSON that is not an object is refused before any write", async () => {
    for (const text of ["[1,2]", "null", '"a report"', "7"]) {
      const result = await importReportRow(reports, "camp", Buffer.from(text, "utf8"));
      expect(result).toEqual({
        kind: "report",
        status: "refused",
        revision: hashBytes(Buffer.from(text, "utf8")),
        reason: "reports/camp.json is not a JSON object, so no later read could use it",
      });
    }
    expect(await row(env)).toBeUndefined();
  });

  test("a report whose render path is bad is still stored verbatim", async () => {
    const bad = Buffer.from('{"outputPath":"../../etc/passwd","videoPath":"camp/gone.mp4"}', "utf8");
    const result = await importReportRow(reports, "camp", bad);
    expect(result).toEqual({ kind: "report", status: "written", revision: hashBytes(bad) });
    expect((await row(env))?.body).toBe(bad.toString("utf8"));
  });
});

describe("rows-step: readReviewed", () => {
  let root: string;
  const REL = "reports/camp.json";
  const digest = (): Map<string, string> => new Map([[REL, hashBytes(LOOSE)]]);
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    dropRoot(root);
  });

  test("a file that is not there and was not reviewed is absent", async () => {
    expect(await readReviewed(root, REL, new Map())).toEqual({ state: "absent" });
  });

  test("a file the digest named and that is gone is refused as changed", async () => {
    expect(await readReviewed(root, REL, digest())).toEqual({
      state: "refused",
      reason: "reports/camp.json changed since the digest",
    });
  });

  test("a file where the reports directory should be is refused, not absent", async () => {
    writeAt(root, "reports", "not a directory");
    const got = await readReviewed(root, REL, digest());
    expect(got.state).toBe("refused");
    expect((got as { reason: string }).reason).toMatch(/ENOTDIR/);
  });

  test("a symlinked parent directory is refused", async () => {
    const elsewhere = makeRoot();
    try {
      writeAt(elsewhere, "camp.json", LOOSE);
      linkAt(root, "reports", elsewhere);
      const got = await readReviewed(root, REL, digest());
      expect(got).toEqual({
        state: "refused",
        reason: "reports is a symlinked directory; the importer never follows one",
      });
    } finally {
      dropRoot(elsewhere);
    }
  });

  test("a symlinked file is refused", async () => {
    const target = writeAt(root, "elsewhere/camp.json", LOOSE);
    linkAt(root, REL, target);
    const got = await readReviewed(root, REL, digest());
    expect(got.state).toBe("refused");
    expect((got as { reason: string }).reason).toMatch(/is a symlink; the importer never follows one$/);
  });

  test("a file the digest does not name is refused", async () => {
    writeAt(root, REL, LOOSE);
    expect(await readReviewed(root, REL, new Map())).toEqual({
      state: "refused",
      reason: "reports/camp.json is not in the reviewed digest",
    });
  });

  test("bytes that differ from the reviewed ones are refused", async () => {
    writeAt(root, REL, '{"assets":["edited after the review"]}');
    expect(await readReviewed(root, REL, digest())).toEqual({
      state: "refused",
      reason: "reports/camp.json changed since the digest",
    });
  });

  test("the reviewed bytes are returned", async () => {
    writeAt(root, REL, LOOSE);
    const got = await readReviewed(root, REL, digest());
    expect(got.state).toBe("ok");
    expect((got as { bytes: Buffer }).bytes.equals(LOOSE)).toBe(true);
  });
});
