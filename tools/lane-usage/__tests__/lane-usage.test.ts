import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/lane-usage.sh` — a lane's time and tokens from opencode's own
 * database. `opencode` and `ssh` are stubbed on PATH: each call appends its
 * name and argv to calls.log (fields end in US, records in RS, because the
 * SQL argument spans lines), prints out.<n> for the n-th call if that file
 * exists, and exits with exit.<n> (default 0). No test here reads a real database or reaches a host.
 */

const script = fileURLToPath(new URL("../../../scripts/lane-usage.sh", import.meta.url));

const STUB = [
  "#!/bin/sh",
  'n=$(cat "$STUB_DIR/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/count"',
  'printf "%s\\037" "$(basename "$0")" "$@" >> "$STUB_DIR/calls.log"',
  'printf "\\036" >> "$STUB_DIR/calls.log"',
  '[ -f "$STUB_DIR/out.$n" ] && cat "$STUB_DIR/out.$n"',
  'exit "$(cat "$STUB_DIR/exit.$n" 2>/dev/null || echo 0)"',
  "",
].join("\n");

let root: string;
let binDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lane-usage-test-"));
  binDir = join(root, "bin");
  mkdirSync(binDir);
  for (const name of ["opencode", "ssh"]) {
    writeFileSync(join(binDir, name), STUB);
    chmodSync(join(binDir, name), 0o755);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stubCall(n: number, out: string, exit = 0): void {
  writeFileSync(join(root, `out.${n}`), out);
  writeFileSync(join(root, `exit.${n}`), String(exit));
}

function run(args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync("sh", [script, ...args], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, STUB_DIR: root, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The recorded calls, each as [command, ...argv]. */
function calls(): string[][] {
  const log = join(root, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\x1e")
    .filter((record) => record !== "")
    .map((record) => record.split("\x1f").slice(0, -1));
}

const HEADER = "directory\tsessions\tagents";

describe("lane-usage.sh", () => {
  test("queries the local database for the exact directory, as TSV", () => {
    stubCall(1, `${HEADER}\n/w/cf-a\t1\tlane\n`);
    const r = run(["/w/cf-a"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${HEADER}\n/w/cf-a\t1\tlane\n`);
    const [call] = calls();
    expect(call?.[0]).toBe("opencode");
    expect(call?.[1]).toBe("db");
    expect(call?.[2]).toContain("FROM session WHERE directory = '/w/cf-a' GROUP BY directory");
    expect(call?.slice(-2)).toEqual(["--format", "tsv"]);
  });

  test("selects every column the report documents", () => {
    stubCall(1, `${HEADER}\n`);
    run(["/w/cf-a"]);
    const sql = calls()[0]?.[2] ?? "";
    for (const column of [
      "directory",
      "AS sessions",
      "AS agents",
      "json_extract(model, '$.id')) AS models",
      "(max(time_updated) - min(time_created)) / 1000 AS secs",
      "sum(tokens_input) AS tokens_in",
      "sum(tokens_output) AS tokens_out",
      "sum(tokens_reasoning) AS tokens_reasoning",
      "sum(tokens_cache_read) AS cache_read",
      "sum(tokens_cache_write) AS cache_write",
      "round(sum(cost), 4) AS cost",
    ]) {
      expect(sql).toContain(column);
    }
  });

  test("strips trailing slashes, which opencode never stores", () => {
    stubCall(1, `${HEADER}\n`);
    run(["/w/cf-a//"]);
    expect(calls()[0]?.[2]).toContain("directory = '/w/cf-a' GROUP");
  });

  test("--json asks opencode for JSON", () => {
    stubCall(1, '[{"directory":"/w/cf-a"}]');
    const r = run(["--json", "/w/cf-a"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('[{"directory":"/w/cf-a"}]\n');
    expect(calls()[0]?.slice(-2)).toEqual(["--format", "json"]);
  });

  test("an empty TSV result is exit 1, naming the directory", () => {
    const r = run(["/w/none"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no opencode session for '/w/none'");
  });

  test("an empty JSON result is exit 1", () => {
    stubCall(1, "[]");
    const r = run(["--json", "/w/none"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("a failed query is 'unknown', exit 3 — never a guess", () => {
    stubCall(1, "", 1);
    const r = run(["/w/cf-a", "/w/cf-b"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("unknown — opencode db exited 1 for '/w/cf-a'");
    expect(calls()).toHaveLength(1);
  });

  test("several directories share one TSV header, and a missing one still reports the rest", () => {
    stubCall(1, `${HEADER}\n/w/cf-a\t1\tlane`);
    stubCall(3, `${HEADER}\n/w/cf-c\t2\tlane`);
    const r = run(["/w/cf-a", "/w/cf-b", "/w/cf-c"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`${HEADER}\n/w/cf-a\t1\tlane\n/w/cf-c\t2\tlane\n`);
    expect(r.stderr).toContain("no opencode session for '/w/cf-b'");
  });

  describe("--host", () => {
    test("runs the query over ssh with opencode's bin dir on the remote PATH", () => {
      stubCall(1, `${HEADER}\n/w/cf-a\t1\tlane`);
      const r = run(["--host", "m", "/w/cf-a"]);
      expect(r.status).toBe(0);
      const [call] = calls();
      expect(call?.[0]).toBe("ssh");
      expect(call?.[1]).toBe("m");
      expect(call?.[2]).toMatch(/^PATH=\$HOME\/\.opencode\/bin:\$PATH opencode db "SELECT /);
      expect(call?.[2]).toContain("directory = '/w/cf-a' GROUP BY directory\" --format tsv");
      expect(call).toHaveLength(3);
    });

    test("names the host when a directory has no session there", () => {
      const r = run(["--host", "m", "/w/none"]);
      expect(r.stderr).toContain("no opencode session for '/w/none' on m");
    });

    test("LANE_USAGE_REMOTE_PATH replaces the remote bin dir", () => {
      stubCall(1, `${HEADER}\n`);
      run(["--host", "m", "/w/cf-a"], { LANE_USAGE_REMOTE_PATH: "$HOME/bin:/opt/oc" });
      expect(calls()[0]?.[2]).toMatch(/^PATH=\$HOME\/bin:\/opt\/oc:\$PATH opencode db /);
    });

    test.each([["$(id)"], ["a b"], ["`id`"], ["a;id"], ["${HOME}"], ["'x'"]])(
      "refuses LANE_USAGE_REMOTE_PATH %j before running anything",
      (value) => {
        const r = run(["--host", "m", "/w/cf-a"], { LANE_USAGE_REMOTE_PATH: value });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("refusing LANE_USAGE_REMOTE_PATH");
        expect(calls()).toEqual([]);
      },
    );

    test.each([["-oProxyCommand=id"], ["m;id"], ["m h"], ["user@m"]])("refuses host %j", (host) => {
      const r = run(["--host", host, "/w/cf-a"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("refusing host");
      expect(calls()).toEqual([]);
    });
  });

  describe("refusals (exit 2, nothing run)", () => {
    test.each([
      ["relative directory", ["w/cf-a"], "must be absolute"],
      ["a quote in the directory", ["/w/x'; DROP TABLE session; --"], "refusing '/w/x'"],
      ["a space in the directory", ["/w/a b"], "refusing '/w/a b'"],
      ["a dollar in the directory", ["/w/$HOME"], "refusing"],
      ["no directory", [], "usage:"],
      ["--host with no value", ["--host"], "usage:"],
      ["an unknown flag", ["--csv", "/w/cf-a"], "usage:"],
    ])("%s", (_name, args, message) => {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(message);
      expect(calls()).toEqual([]);
    });

    test("a later bad directory refuses before the first is queried", () => {
      const r = run(["/w/cf-a", "relative"]);
      expect(r.status).toBe(2);
      expect(calls()).toEqual([]);
    });

    test("-- ends the flags", () => {
      stubCall(1, `${HEADER}\n`);
      const r = run(["--", "/w/cf-a"]);
      expect(r.status).toBe(0);
      expect(calls()).toHaveLength(1);
    });
  });
});
