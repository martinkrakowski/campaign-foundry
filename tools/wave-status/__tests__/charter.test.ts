import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// D106 — the status server starts nothing, kills nothing and merges nothing, and
// (S5, owner decision 2026-09-13) never executes a premise. A premise is arbitrary
// `sh` read out of a plan file; the server may run only fixed commands with fixed
// arguments. This is checked against the SOURCE, not by injecting a fake executor:
// the server has no executor seam, so a stub nothing calls cannot fail, and a real
// violation would shell out directly or import plan-verify's verifier instead.

const WAVE_STATUS = fileURLToPath(new URL("..", import.meta.url));
/** The only subprocesses the server may run, each with arguments the code builds. */
const ALLOWED_COMMANDS = ["pgrep", "gh", "git"];
/** The only plan-verify module the server may import: the artifact's shape and path. */
const ALLOWED_PLAN_VERIFY = ["tools/plan-verify/lib/artifact.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ||
        name === "fixtures" ||
        name === "node_modules" ||
        name === "public"
        ? []
        : sourceFiles(path);
    }
    return /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

const REPO = resolve(WAVE_STATUS, "../..");
const IMPORT = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
// A bare call, not a method: `pattern.exec(text)` is a RegExp, not a subprocess.
const SUBPROCESS =
  /(?<![.\w$])(execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(\s*([^,)]*)/g;

function importsOf(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
}

describe("the status server's charter (D106, S5)", () => {
  const files = sourceFiles(WAVE_STATUS);

  test("the scan sees the server's own sources", () => {
    const names = files.map((f) => relative(REPO, f));
    expect(names).toContain("tools/wave-status/lib/collect.ts");
    expect(names).toContain("tools/wave-status/lib/backlog.ts");
  });

  test("every subprocess it starts is a fixed, allowed command — never a shell", () => {
    const calls = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(SUBPROCESS)].map((m) => ({
        file: relative(REPO, file),
        fn: m[1],
        command: m[2].trim(),
      })),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `${call.file}: ${call.fn}(${call.command}…)`).toMatchObject({
        command: expect.stringMatching(new RegExp(`^["'](${ALLOWED_COMMANDS.join("|")})["']$`)),
      });
    }
  });

  test("from plan-verify it imports the artifact module only, and that module runs nothing", () => {
    const planVerifyImports = files.flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.includes("plan-verify/"))
        .map((spec) => relative(REPO, resolve(dirname(file), spec)).replace(/\.js$/, ".ts")),
    );
    expect(planVerifyImports.length).toBeGreaterThan(0);
    for (const target of planVerifyImports) expect(ALLOWED_PLAN_VERIFY).toContain(target);
    for (const allowed of ALLOWED_PLAN_VERIFY) {
      const specs = importsOf(join(REPO, allowed));
      expect(
        specs.some((spec) => /child_process/.test(spec)),
        `${allowed} imports child_process`,
      ).toBe(false);
    }
  });
});
