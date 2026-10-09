import { describe, expect, test } from "vitest";
import { parseDiff } from "../lib/diff.js";

const SIMPLE_DIFF = [
  "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
  "index abc123..def456 100644",
  "--- a/packages/x/src/a.ts",
  "+++ b/packages/x/src/a.ts",
  "@@ -10,3 +20,4 @@",
  " context line",
  "-repo.findById(id)",
  "+repo.findById(id)",
  "+validate(input)",
  " context line",
].join("\n");

describe("parseDiff", () => {
  test("extracts the changed path and base hunk ranges", () => {
    const info = parseDiff(SIMPLE_DIFF);
    expect(info.files).toHaveLength(1);
    expect(info.files[0]?.path).toBe("packages/x/src/a.ts");
    expect(info.files[0]?.ranges).toEqual([{ baseStart: 10, baseCount: 3 }]);
  });

  test("omits the base count defaults to 1", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -5 +20,2 @@",
      "-old",
      "+new",
      "+new2",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files[0]?.ranges).toEqual([{ baseStart: 5, baseCount: 1 }]);
  });

  test("handles multiple hunks in one file", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -10,1 +20,1 @@",
      "-a",
      "+b",
      "@@ -30,2 +40,2 @@",
      "-c",
      "-d",
      "+e",
      "+f",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files[0]?.ranges).toEqual([
      { baseStart: 10, baseCount: 1 },
      { baseStart: 30, baseCount: 2 },
    ]);
  });

  test("handles a new file (--- /dev/null)", async () => {
    const diff = [
      "diff --git a/packages/x/src/new.ts b/packages/x/src/new.ts",
      "--- /dev/null",
      "+++ b/packages/x/src/new.ts",
      "@@ -0,0 +1,1 @@",
      "+repo.findById(id)",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files[0]?.path).toBe("packages/x/src/new.ts");
    expect(info.files[0]?.ranges).toEqual([{ baseStart: 0, baseCount: 0 }]);
  });

  test("handles a deleted file (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/packages/x/src/old.ts b/packages/x/src/old.ts",
      "--- a/packages/x/src/old.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-repo.findById(id)",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files[0]?.path).toBe("packages/x/src/old.ts");
    expect(info.files[0]?.ranges).toEqual([{ baseStart: 1, baseCount: 1 }]);
  });

  test("handles multiple changed files", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-a()",
      "+b()",
      "diff --git a/apps/api/server/svc.ts b/apps/api/server/svc.ts",
      "--- a/apps/api/server/svc.ts",
      "+++ b/apps/api/server/svc.ts",
      "@@ -5,1 +5,1 @@",
      "-foo()",
      "+bar()",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files).toHaveLength(2);
    expect(info.files[0]?.path).toBe("packages/x/src/a.ts");
    expect(info.files[1]?.path).toBe("apps/api/server/svc.ts");
  });

  test("empty diff yields no files and no names", () => {
    const info = parseDiff("");
    expect(info.files).toEqual([]);
    expect(info.calledNames.size).toBe(0);
    expect(info.tableNames.size).toBe(0);
  });

  test("a hunk header that does not match the @@ regex is skipped", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ not-a-hunk-header @@",
      "+foo()",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.files).toHaveLength(1);
    expect(info.files[0]?.ranges).toEqual([]);
    expect(info.calledNames).toContain("foo");
  });

  test("a @@ line before any file header (path is null) does not push a range", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "+foo()",
    ].join("\n");
    const info = parseDiff(diff);
    // path is null, so no range is pushed even though the @@ matches the regex
    expect(info.files).toEqual([]);
    expect(info.calledNames).toContain("foo");
  });

  test("called names include method calls and function calls", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-repo.findById(id)",
      "+repo.findById(id)",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.calledNames).toContain("findById");
  });

  test("JS keyword calls are not called names", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-if (x) return",
      "+if (y) return",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.calledNames).not.toContain("if");
    expect(info.calledNames).not.toContain("return");
  });

  test("function call names are extracted", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-validate(input)",
      "+validate(input)",
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.calledNames).toContain("validate");
  });

  test("table names are extracted case-insensitively", () => {
    const diff = [
      "diff --git a/apps/api/server/migrations/0001.sql b/apps/api/server/migrations/0001.sql",
      "--- a/apps/api/server/migrations/0001.sql",
      "+++ b/apps/api/server/migrations/0001.sql",
      "@@ -1,1 +1,1 @@",
      "-INSERT INTO users VALUES(1)",
      '+INSERT INTO "orders" VALUES(1)',
    ].join("\n");
    const info = parseDiff(diff);
    expect(info.tableNames).toContain("users");
    expect(info.tableNames).toContain("orders");
  });

  test("table names from UPDATE, DELETE FROM, CREATE TABLE", () => {
    const text = [
      "diff --git a/apps/api/server/svc.ts b/apps/api/server/svc.ts",
      "--- a/apps/api/server/svc.ts",
      "+++ b/apps/api/server/svc.ts",
      "@@ -1,1 +1,1 @@",
      "-UPDATE products SET name = ?",
      "-DELETE FROM orders",
      "-CREATE TABLE IF NOT EXISTS invoices (id int)",
      "-FROM customers JOIN vendors ON ...",
    ].join("\n");
    const info = parseDiff(text);
    expect(info.tableNames).toContain("products");
    expect(info.tableNames).toContain("orders");
    expect(info.tableNames).toContain("invoices");
    expect(info.tableNames).toContain("customers");
    expect(info.tableNames).toContain("vendors");
  });

  test("the raw diff body text is never exposed in the return value", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "+UNIQUE_MARKER_42",
      "-old line",
    ].join("\n");
    const info = parseDiff(diff);
    // DiffInfo has no field that carries raw body text — only derived names.
    const json = JSON.stringify(info);
    expect(json).not.toContain("UNIQUE_MARKER_42");
    expect(json).not.toContain("old line");
  });

  test("context lines do not contribute names", () => {
    const diff = [
      "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts",
      "--- a/packages/x/src/a.ts",
      "+++ b/packages/x/src/a.ts",
      "@@ -1,1 +1,1 @@",
      " contextOnlyCall()",
      "+realCall()",
    ].join("\n");
    const info = parseDiff(diff);
    // "contextOnlyCall" appears only on a context line (starts with space), not collected
    expect(info.calledNames).not.toContain("contextOnlyCall");
    expect(info.calledNames).toContain("realCall");
  });
});
