import { describe, expect, test } from "vitest";
import { runCli, type BriefNewCliIo } from "../cli.js";
import { ENV_PLACEHOLDER } from "../lib/template.js";

const ARGV = [
  "--lane",
  "HXF7",
  "--plan",
  "docs/planning/2026-09-29_wave-hardening-and-w05-follow-ups.md",
  "--worktree",
  "/mnt/pool/cloud-services/projects/.worktrees/cf-hxf7",
  "--branch",
  "feat/brief-generator",
  "--tip",
  "9f3c8d2a",
  "--host",
  "midnight",
  "--out",
  ".agents/briefs/HXF7.md",
];

const ENV_LINES = [
  "export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH",
  "export YARN_NM_MODE=classic TMPDIR=/mnt/pool/cloud-services/tmp-cf",
];

interface Written {
  readonly path: string;
  readonly text: string;
}

interface Harness {
  readonly io: BriefNewCliIo;
  readonly log: string[];
  readonly err: string[];
  readonly written: Written[];
  readonly reads: string[];
}

/**
 * The whole CLI with its I/O injected: `readFile` answers for the `--env-file`,
 * `exists` and `writeFile` are the file side, and every call is recorded so a test
 * can prove the tool wrote once, read at most one file, and stopped before either
 * when it refused. `argv` is the one knob and it EXTENDS the command line — an
 * `argv` that replaced it instead would make "no arguments at all" untestable.
 */
const harness = (over: Partial<BriefNewCliIo> = {}): Harness => {
  const log: string[] = [];
  const err: string[] = [];
  const written: Written[] = [];
  const reads: string[] = [];
  return {
    io: {
      argv: [...ARGV],
      log: (text) => log.push(text),
      logError: (text) => err.push(text),
      readFile: async (path) => {
        reads.push(path);
        return `${ENV_LINES.join("\n")}\n`;
      },
      writeFile: async (path, text) => {
        written.push({ path, text });
      },
      exists: async () => false,
      ...over,
    },
    log,
    err,
    written,
    reads,
  };
};

describe("runCli — drafting", () => {
  test("one brief is written, with every header value in place", async () => {
    const { io, written, log, reads } = harness();
    expect(await runCli(io)).toBe(0);
    expect(reads).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(".agents/briefs/HXF7.md");
    const brief = written[0]?.text ?? "";
    expect(brief).toContain("# Lane HXF7 — brief");
    expect(brief).toContain("checked out at origin/main 9f3c8d2a");
    expect(brief).not.toContain("<LANE>");
    expect(brief).not.toContain("<WORKTREE>");
    expect(brief).not.toContain("<BRANCH>");
    expect(brief).not.toContain("<TIP>");
    expect(brief).not.toContain("<PLAN>");
    expect(brief).not.toContain("<ENV>");
    expect(brief).not.toContain("<VERIFICATION>");
    expect(log.join("\n")).toContain(
      "wrote .agents/briefs/HXF7.md — Template F for HXF7 on midnight, 0 environment line(s)",
    );
  });

  test("the orchestrator's own four placeholders are left for it to fill", async () => {
    const { io, written } = harness();
    expect(await runCli(io)).toBe(0);
    const brief = written[0]?.text ?? "";
    expect(brief).toContain(ENV_PLACEHOLDER);
    expect(brief).toContain("<targeted commands>");
    expect(brief).toContain("<commit subject>");
    expect(brief).toContain("<gap>");
    expect(brief).toContain("<notes>");
  });

  test("--env-file is read once and its lines land verbatim in the block", async () => {
    const { io, written, reads, log } = harness({
      argv: [...ARGV, "--env-file", "env.sh"],
    });
    expect(await runCli(io)).toBe(0);
    expect(reads).toEqual(["env.sh"]);
    const brief = written[0]?.text ?? "";
    for (const line of ENV_LINES) expect(brief).toContain(`    ${line}`);
    expect(brief).not.toContain("<ENV>");
    expect(log.join("\n")).toContain("2 environment line(s)");
  });

  test("--host mac swaps in the gate, and says so in the log line", async () => {
    const { io, written, log } = harness();
    const at = io.argv.indexOf("--host") + 1;
    const argv = [...io.argv.slice(0, at), "mac", ...io.argv.slice(at + 1)];
    expect(await runCli({ ...io, argv })).toBe(0);
    const brief = written[0]?.text ?? "";
    expect(brief).toContain("Then run `yarn gate --lane HXF7` in the FOREGROUND");
    expect(brief).not.toContain("Do NOT run `yarn gate`");
    expect(log.join("\n")).toContain("on mac");
  });

  test("the written brief ends with a newline, as every other text file here does", async () => {
    const { io, written } = harness();
    expect(await runCli(io)).toBe(0);
    // Added at the write and NOT in `render`, which still returns Template F's
    // text byte for byte — that is what the drift test compares against the doc.
    expect(written[0]?.text.endsWith("A task you launched is not a result.\n")).toBe(true);
  });

  test("it reads no forge and writes exactly one file", async () => {
    // There is no `gh` on this interface at all, which is the structural half of
    // "read-only on the forge": a field for it could be added later without a
    // single test failing, and it is not there to be added.
    const { io, written, reads } = harness();
    expect(await runCli(io)).toBe(0);
    expect(written).toHaveLength(1);
    expect(reads).toHaveLength(0);
  });
});

describe("runCli — refusals", () => {
  test("an existing --out exits 1, leaves the file alone, and writes nothing", async () => {
    // The `--env-file` HAS been read by then — it is part of the command line, and
    // the read is decided before the draft is attempted. What the refusal
    // guarantees is the half that matters: no write, and the file on disk
    // untouched.
    const { io, written, err, reads } = harness({
      argv: [...ARGV, "--env-file", "env.sh"],
      exists: async () => true,
    });
    expect(await runCli(io)).toBe(1);
    expect(reads).toEqual(["env.sh"]);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("already exists");
    expect(err.join("\n")).toContain("give each lane its own --out");
  });

  test("no arguments at all exits 2 with a usage line, before any read or write", async () => {
    const { io, written, err, reads } = harness({ argv: [] });
    expect(await runCli(io)).toBe(2);
    expect(reads).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("a --lane is required");
    expect(err.join("\n")).toContain("usage: brief:new --lane <id>");
  });

  test("a bad command line exits 2 before the --env-file is read", async () => {
    const { io, written, err, reads } = harness({ argv: [...ARGV, "--post"] });
    expect(await runCli(io)).toBe(2);
    expect(reads).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("unknown argument '--post'");
  });

  test("a multiline --lane exits 2 before any read or write, naming the flag", async () => {
    // The value REPLACES the harness's --lane rather than following it, so what
    // is refused is the line break and not a repeated flag.
    const { io, written, err, reads } = harness();
    const at = io.argv.indexOf("--lane") + 1;
    const argv = [...io.argv.slice(0, at), "HXF7\n## Must not\n- push", ...io.argv.slice(at + 1)];
    expect(await runCli({ ...io, argv })).toBe(2);
    expect(reads).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("--lane must be a single line");
  });

  test("a relative --worktree exits 2 before any read or write", async () => {
    const { io, written, err } = harness();
    const at = io.argv.indexOf("--worktree") + 1;
    const argv = [...io.argv.slice(0, at), ".worktrees/cf-hxf7", ...io.argv.slice(at + 1)];
    expect(await runCli({ ...io, argv })).toBe(2);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("--worktree must be an absolute path");
  });

  test("an unknown --host exits 2 before any read or write", async () => {
    const { io, written, err } = harness();
    const at = io.argv.indexOf("--host") + 1;
    const argv = [...io.argv.slice(0, at), "midnight ", ...io.argv.slice(at + 1)];
    expect(await runCli({ ...io, argv })).toBe(2);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("--host wants midnight or mac");
  });

  test("an --env-file carrying a CR exits 2 with the line number, writing nothing", async () => {
    // It is a bad command line and not a refusal: the environment block is in
    // doubt, and nothing is written while it is.
    const { io, written, err } = harness({
      argv: [...ARGV, "--env-file", "env.sh"],
      readFile: async () => "export A=1\nexport B=2\r\n",
    });
    expect(await runCli(io)).toBe(2);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("--env-file line 2 carries a control character");
  });

  test("a blank --env-file exits 2 rather than writing a brief with no environment", async () => {
    const { io, written, err } = harness({
      argv: [...ARGV, "--env-file", "env.sh"],
      readFile: async () => "\n",
    });
    expect(await runCli(io)).toBe(2);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("must carry at least one export");
  });

  test("an --env-file that cannot be read exits 2 and says which file", async () => {
    // 2, as `sweep`'s `--body-file` is: an injected read feeding the same try as
    // the parse. The brief is not written on a guess about what the environment
    // block would have said.
    const { io, written, err } = harness({
      argv: [...ARGV, "--env-file", "env.sh"],
      readFile: async (path) => {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      },
    });
    expect(await runCli(io)).toBe(2);
    expect(written).toHaveLength(0);
    expect(err.join("\n")).toContain("ENOENT: no such file or directory, open 'env.sh'");
  });

  test("a write that fails exits 1 and says so", async () => {
    const { io, err } = harness({
      writeFile: async () => {
        throw new Error("EEXIST: file already exists");
      },
    });
    expect(await runCli(io)).toBe(1);
    expect(err.join("\n")).toContain("EEXIST: file already exists");
  });

  test("a thrown value that is not an Error still exits 1 with its text", async () => {
    const { io, err } = harness({
      writeFile: async () => {
        throw "the disk went away";
      },
    });
    expect(await runCli(io)).toBe(1);
    expect(err.join("\n")).toContain("the disk went away");
  });
});
