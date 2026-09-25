import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FsReportStore } from "../fs-report-store.js";
import { ReportConflictError } from "../report-store.port.js";

describe("FsReportStore", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-report-store-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("an explicit root is used instead of the output root", async () => {
    const store = new FsReportStore(root);
    const locator = await store.writeReport("camp", '{"assets":[]}');
    expect(locator).toBe(resolve(root, "reports", "camp.json"));
    expect(readFileSync(locator, "utf8")).toBe('{"assets":[]}');
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [] });
  });

  test("an unsafe campaign id reads as nothing, has no revision, and cannot be written", async () => {
    const store = new FsReportStore(root);
    await expect(store.readReport("../evil")).resolves.toBeUndefined();
    await expect(store.getRevision("../evil")).resolves.toBeUndefined();
    await expect(store.writeReport("../evil", "{}")).rejects.toThrow(
      'Report campaign id "../evil" is not a safe id.',
    );
    expect(existsSync(resolve(root, "reports"))).toBe(false);
  });

  test("a revision read that fails for any reason but absence is surfaced, not read as absent", async () => {
    const store = new FsReportStore(root);
    // A directory where the report should be: reading it fails with EISDIR, which is
    // not "nothing stored", so it must not come back as an undefined revision.
    mkdirSync(resolve(root, "reports", "camp.json"), { recursive: true });
    await expect(store.getRevision("camp")).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("a report read that fails for any reason but absence is surfaced, not read as absent", async () => {
    const store = new FsReportStore(root);
    mkdirSync(resolve(root, "reports", "camp.json"), { recursive: true });
    await expect(store.readReport("camp")).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("expectedRevision null writes only while nothing is stored, and a match writes", async () => {
    const store = new FsReportStore(root);
    const first = await store.writeReport("camp", '{"assets":[]}', null);
    const firstRevision = await store.getRevision("camp");
    await expect(store.writeReport("camp", '{"assets":[1]}', null)).rejects.toBeInstanceOf(
      ReportConflictError,
    );
    const second = await store.writeReport("camp", '{"assets":[1]}', firstRevision);
    expect(second).toBe(first);
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [1] });
  });

  test("a stale expectedRevision is refused with the current revision, and writes nothing", async () => {
    const store = new FsReportStore(root);
    await store.writeReport("camp", '{"assets":[]}', null);
    const first = await store.getRevision("camp");
    await store.writeReport("camp", '{"assets":[1]}', first);
    const second = await store.getRevision("camp");
    await expect(store.writeReport("camp", '{"assets":[2]}', first)).rejects.toMatchObject({
      code: "ECONFLICT",
      revision: second,
    });
    await expect(store.readReport("camp")).resolves.toEqual({ assets: [1] });
  });
});
