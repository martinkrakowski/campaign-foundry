import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/run-test-step.sh", import.meta.url));

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cf-rt-step-"));
}

describe("scripts/run-test-step.sh", () => {
  test("a failing command fails the step with its own exit code even when its output holds a failed summary", () => {
    const r = spawnSync(
      "sh",
      [script, "sh", "-c", "printf '%s\n' '      Tests  1 failed | 10 passed (11)'; exit 3"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(3);
    expect(r.stderr).not.toContain("run-test-step: FAILED");
  });

  test("a passing command with a clean summary passes", () => {
    const r = spawnSync(
      "sh",
      [
        script,
        "sh",
        "-c",
        "printf '%s\n' ' Test Files  3 passed (3)' '      Tests  12 passed (12)'",
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Test Files  3 passed (3)");
    expect(r.stdout).toContain("Tests  12 passed (12)");
  });

  test("a command that exits 0 while its output reports failed tests fails the step with code 96", () => {
    const fake = "printf '%s\\n' '      Tests  1 failed | 10 passed (11)'; exit 0";

    // Off Actions: the variable is REMOVED, not inherited — this suite itself
    // runs under GITHUB_ACTIONS=true in CI.
    const offActions = { ...process.env };
    delete offActions.GITHUB_ACTIONS;
    const plain = spawnSync("sh", [script, "sh", "-c", fake], {
      encoding: "utf8",
      env: offActions,
    });
    expect(plain.status).toBe(96);
    expect(plain.stderr).toContain("run-test-step: FAILED");
    expect(plain.stderr).toContain("failed tests");
    expect(plain.stderr).toContain("Tests  1 failed | 10 passed (11)");
    expect(plain.stdout).not.toContain("::error::");

    const gh = spawnSync("sh", [script, "sh", "-c", fake], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    });
    expect(gh.status).toBe(96);
    expect(gh.stdout).toContain("::error::");
    expect(gh.stdout).toContain("failed tests");
    expect(gh.stderr).toContain("run-test-step: FAILED");
  });

  test("the output streams through unchanged with annotation lines included", () => {
    const fake =
      "printf '%s\\n' alpha; " +
      "printf '%s\\n' '::error file=x.ts,line=1::boom' >&2; " +
      "printf '%s\\n' beta; " +
      "printf '%s\\n' gamma >&2; " +
      "exit 0";
    const r = spawnSync("sh", [script, "sh", "-c", fake], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("alpha\n::error file=x.ts,line=1::boom\nbeta\ngamma\n");
  });

  test("the temp files are removed on success and on failure and on a scan failure", () => {
    const env = (tmp: string) => ({
      ...process.env,
      TMPDIR: tmp,
      GITHUB_ACTIONS: "false",
    });

    let tmp = freshDir();
    let r = spawnSync("sh", [script, "sh", "-c", "printf '%s\\n' ' Tests  3 passed (3)'; exit 0"], {
      encoding: "utf8",
      env: env(tmp),
    });
    expect(r.status).toBe(0);
    expect(readdirSync(tmp)).toHaveLength(0);
    rmSync(tmp, { recursive: true, force: true });

    tmp = freshDir();
    r = spawnSync("sh", [script, "sh", "-c", "exit 3"], {
      encoding: "utf8",
      env: env(tmp),
    });
    expect(r.status).toBe(3);
    expect(readdirSync(tmp)).toHaveLength(0);
    rmSync(tmp, { recursive: true, force: true });

    const scriptDir = freshDir();
    const copy = join(scriptDir, "run-test-step.sh");
    copyFileSync(script, copy);
    tmp = freshDir();
    r = spawnSync("sh", [copy, "sh", "-c", "printf '%s\\n' alpha; exit 0"], {
      encoding: "utf8",
      env: env(tmp),
    });
    expect(r.status).toBe(2);
    expect(readdirSync(tmp)).toHaveLength(0);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  });

  test("the wrapper parses under sh and dash", () => {
    const sh = spawnSync("sh", ["-n", script], { encoding: "utf8" });
    expect(sh.status).toBe(0);
    expect(sh.stderr).toBe("");

    const have = spawnSync("sh", ["-c", "command -v dash"], {
      encoding: "utf8",
    });
    if (have.status === 0) {
      const d = spawnSync("dash", ["-n", script], { encoding: "utf8" });
      expect(d.status).toBe(0);
      expect(d.stderr).toBe("");
    }
  });
});
