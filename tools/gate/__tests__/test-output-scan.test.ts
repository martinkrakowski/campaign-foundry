import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const scanSh = fileURLToPath(new URL("../../../scripts/test-output-scan.sh", import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLog(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-scan-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("scripts/test-output-scan.sh", () => {
  test("a failed summary makes the scan exit 96 and print the matched line", () => {
    const log = tempLog(
      "fail.txt",
      " Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 10 passed (11)\n",
    );
    const r = spawnSync("sh", [scanSh, log], { encoding: "utf8" });
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("failed tests:");
    expect(r.stdout).toContain("Test Files  1 failed | 3 passed (4)");
    expect(r.stderr).toBe("");
  });

  test("an unhandled error sentence makes the scan exit 96", () => {
    const log = tempLog(
      "unhandled.txt",
      "Test Files  3 passed (3)\n      Tests  0 failed | 12 passed (12)\n  Vitest caught 1 unhandled error\n",
    );
    const r = spawnSync("sh", [scanSh, log], { encoding: "utf8" });
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("unhandled errors:");
    expect(r.stdout).toContain("Vitest caught 1 unhandled error");
    expect(r.stderr).toBe("");
  });

  test("a clean log and logs that only mention failure in words exit 0 and print nothing", () => {
    const log = tempLog(
      "clean.txt",
      " Test Files  3 passed (3)\n      Tests  0 failed | 12 passed (12)\n \u2713 a refund that failed is retried  12ms\nstdout | x > Tests 3 failed earlier in this log line\n[h3] [unhandled] H3Error: boom\nUnhandled Rejection is handled by the app\n",
    );
    const r = spawnSync("sh", [scanSh, log], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("a missing or unreadable log file exits 2", () => {
    const noArg = spawnSync("sh", [scanSh], { encoding: "utf8" });
    expect(noArg.status).toBe(2);
    expect(noArg.stderr).toContain("usage:");

    const noFile = spawnSync("sh", [scanSh, "/does/not/exist.txt"], {
      encoding: "utf8",
    });
    expect(noFile.status).toBe(2);
    expect(noFile.stderr).toContain("usage:");

    const dir = mkdtempSync(join(tmpdir(), "cf-scan-"));
    dirs.push(dir);
    const unreadable = join(dir, "unreadable.txt");
    writeFileSync(unreadable, "data");
    chmodSync(unreadable, 0o000);
    const r = spawnSync("sh", [scanSh, unreadable], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
    chmodSync(unreadable, 0o644);
  });

  test("a log path that is a directory exits 2 and is not read as clean", () => {
    // A directory is "readable", and BSD sed exits 0 on one: without the
    // regular-file check the scan would print nothing and exit 0.
    const dir = mkdtempSync(join(tmpdir(), "cf-scan-"));
    dirs.push(dir);
    const r = spawnSync("sh", [scanSh, dir], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage:");
  });

  test("the summary is found through colour codes", () => {
    const C = "\u001b";
    const log = tempLog(
      "colour.txt",
      `${C}[31m Test Files  1 failed | 3 passed (4)${C}[0m\n${C}[32m      Tests  1 failed | 10 passed (11)${C}[0m\n`,
    );
    const r = spawnSync("sh", [scanSh, log], { encoding: "utf8" });
    expect(r.status).toBe(96);
    expect(r.stdout).toContain("failed tests:");
    expect(r.stdout).toContain("Test Files  1 failed | 3 passed (4)");
    expect(r.stderr).toBe("");
  });

  test("the scan parses under sh and dash", () => {
    const sh = spawnSync("sh", ["-n", scanSh], { encoding: "utf8" });
    expect(sh.status).toBe(0);
    if (existsSync("/bin/dash")) {
      const dash = spawnSync("/bin/dash", ["-n", scanSh], {
        encoding: "utf8",
      });
      expect(dash.status).toBe(0);
    }
  });
});
