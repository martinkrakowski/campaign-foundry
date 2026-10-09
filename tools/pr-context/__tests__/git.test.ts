import { describe, expect, test, vi, type Mock } from "vitest";
import { execFile } from "node:child_process";
import {
  MAX_BUFFER,
  changedLines,
  listBaseTree,
  readBaseBlobs,
  realGit,
  isValidCommitId,
  type GitIo,
  type TreeEntry,
} from "../lib/git.js";

/** Records every `run` call so a test can assert what was asked of git. */
function recordingGit(): GitIo & { calls: { args: readonly string[]; stdin?: string }[] } {
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  return {
    calls,
    run: async (args, stdin) => {
      calls.push({ args, stdin });
      return "";
    },
  };
}

/** A GitIo that returns scripted output keyed by the joined argv. */
function scriptedGit(
  script: Record<string, string>,
): GitIo & { calls: readonly { args: readonly string[]; stdin?: string }[] } {
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  return {
    calls,
    run: async (args, stdin) => {
      calls.push({ args, stdin });
      const key = args.join(" ");
      return script[key] ?? "";
    },
  };
}

describe("listBaseTree", () => {
  test("keeps regular files in allowed paths and skips everything else", async () => {
    const git = scriptedGit({
      "ls-tree -r base123": [
        "100644 blob aaa111\tpackages/x/src/a.ts",
        "100755 blob bbb222\tapps/api/bin/run.ts",
        "120000 blob ccc333\tsome/symlink",
        "100644 blob ddd444\tscripts/gate.sh",
        "100644 blob eee555\tpackages/x/src/feature.test.ts",
      ].join("\n"),
    });
    const entries = await listBaseTree(git, "base123");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: "packages/x/src/a.ts", mode: "100644", blob: "aaa111" });
    expect(entries[1]).toEqual({ path: "apps/api/bin/run.ts", mode: "100755", blob: "bbb222" });
    expect(git.calls[0]?.args).toEqual(["ls-tree", "-r", "base123"]);
  });

  test("a symlink entry in the base tree is skipped", async () => {
    const git = scriptedGit({
      "ls-tree -r base":
        "120000 blob abc\tpackages/x/src/symlink.ts\n100644 blob def\tpackages/x/src/ok.ts\n",
    });
    const entries = await listBaseTree(git, "base");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.blob).toBe("def");
  });

  test("malformed lines without a tab are skipped", async () => {
    const git = scriptedGit({
      "ls-tree -r base": "garbage line without tab\n100644 blob def\tpackages/x/src/a.ts\n",
    });
    const entries = await listBaseTree(git, "base");
    expect(entries).toHaveLength(1);
  });

  test("a header with fewer than three space-separated fields is skipped", async () => {
    const git = scriptedGit({
      "ls-tree -r base": "100644\tpackages/x/src/a.ts\n100644 blob def\tpackages/x/src/b.ts\n",
    });
    const entries = await listBaseTree(git, "base");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("packages/x/src/b.ts");
  });

  test("empty output yields no entries", async () => {
    const git = scriptedGit({ "ls-tree -r base": "" });
    expect(await listBaseTree(git, "base")).toEqual([]);
  });
});

describe("readBaseBlobs", () => {
  test("cat-file batch framing is parsed by byte length", async () => {
    // A blob whose body contains a multi-byte char (é = 2 bytes in UTF-8) and a
    // line that looks exactly like a cat-file header. Line-based parsing would
    // mis-cut this; byte-length parsing reads exactly <size> bytes after the
    // header line.
    const content = "café\ndeadbeef blob 3\nxyz\n";
    const size = Buffer.byteLength(content, "utf8");
    const output = `abc123 blob ${size}\n${content}\n`;
    const git = scriptedGit({ ["cat-file --batch"]: output });
    const entries: TreeEntry[] = [{ path: "packages/x/src/a.ts", mode: "100644", blob: "abc123" }];
    const blobs = await readBaseBlobs(git, entries);
    expect(blobs.get("abc123")).toBe(content);
    expect(git.calls[0]?.stdin).toBe("abc123\n");
  });

  test("a missing blob yields empty content and advances past it", async () => {
    const output = "notfound missing\nfound blob 5\nhello\n\n";
    const git = scriptedGit({ ["cat-file --batch"]: output });
    const entries: TreeEntry[] = [
      { path: "a.ts", mode: "100644", blob: "notfound" },
      { path: "b.ts", mode: "100644", blob: "found" },
    ];
    const blobs = await readBaseBlobs(git, entries);
    expect(blobs.get("notfound")).toBe("");
    expect(blobs.get("found")).toBe("hello");
  });

  test("empty entries returns an empty map without calling git", async () => {
    const git = recordingGit();
    const blobs = await readBaseBlobs(git, []);
    expect(blobs.size).toBe(0);
    expect(git.calls).toEqual([]);
  });

  test("truncated output (no newline) stops parsing", async () => {
    const git = scriptedGit({ ["cat-file --batch"]: "abc123" });
    const entries: TreeEntry[] = [{ path: "a.ts", mode: "100644", blob: "abc123" }];
    const blobs = await readBaseBlobs(git, entries);
    expect(blobs.get("abc123")).toBeUndefined();
  });
});

describe("changedLines", () => {
  test("runs git diff with all flags and both commits in order", async () => {
    const git = scriptedGit({
      "diff --unified=0 --no-color --no-ext-diff --no-renames base111 head222": "diff output",
    });
    const out = await changedLines(git, "base111", "head222");
    expect(out).toBe("diff output");
    expect(git.calls[0]?.args).toEqual([
      "diff",
      "--unified=0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "base111",
      "head222",
    ]);
  });
});

describe("isValidCommitId", () => {
  test("a 7-char hex id is accepted", () => {
    expect(isValidCommitId("abc1234")).toBe(true);
  });

  test("a 40-char hex id is accepted", () => {
    expect(isValidCommitId("a".repeat(40))).toBe(true);
  });

  test("a non-hex id is refused", () => {
    expect(isValidCommitId("xyz1234")).toBe(false);
  });

  test("a 6-char id is too short", () => {
    expect(isValidCommitId("abcdef")).toBe(false);
  });

  test("a 41-char id is too long", () => {
    expect(isValidCommitId("a".repeat(41))).toBe(false);
  });

  test("an empty string is refused", () => {
    expect(isValidCommitId("")).toBe(false);
  });
});

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const execFileMock = execFile as unknown as Mock;
type ExecCall = {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
  stdin: { end: Mock; write: Mock } | null;
  written: string[];
  callback: (error: Error | null, stdout: string | Buffer, stderr: string) => void;
};
let lastCall: ExecCall;

function stubExec(outcome: (call: ExecCall) => [Error | null, string | Buffer, string]): void {
  execFileMock.mockImplementation(
    (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
      callback: ExecCall["callback"],
    ) => {
      const stdin = { write: vi.fn(), end: vi.fn() };
      lastCall = { file, args, options, stdin, written: [], callback };
      queueMicrotask(() => {
        const [error, stdout, stderr] = outcome(lastCall);
        callback(error, stdout, stderr);
      });
      return lastCall;
    },
  );
}

describe("realGit", () => {
  test("spawns git with an argv array, cwd and 256 MiB maxBuffer", async () => {
    stubExec(() => [null, "ok\n", ""]);
    const git = realGit("/repo");
    await git.run(["ls-tree", "-r", "base"]);
    expect(lastCall.file).toBe("git");
    expect(lastCall.args).toEqual(["ls-tree", "-r", "base"]);
    expect(lastCall.options.cwd).toBe("/repo");
    expect(lastCall.options.maxBuffer).toBe(MAX_BUFFER);
  });

  test("never uses a shell", async () => {
    stubExec(() => [null, "", ""]);
    const git = realGit("/repo");
    await git.run(["diff", "a", "b"]);
    expect(lastCall.options.shell).toBeUndefined();
  });

  test("resolves with stdout on success", async () => {
    stubExec(() => [null, "hello\n", ""]);
    const git = realGit("/repo");
    expect(await git.run(["rev-parse", "HEAD"])).toBe("hello\n");
  });

  test("rejects on a non-zero exit", async () => {
    const err = Object.assign(new Error("exit 128"), { code: 128 });
    stubExec(() => [err, "", "fatal: bad revision"]);
    const git = realGit("/repo");
    await expect(git.run(["diff", "base", "head"])).rejects.toThrow("exit 128");
  });

  test("writes stdin and ends the pipe when supplied", async () => {
    stubExec(() => [null, "ok", ""]);
    const git = realGit("/repo");
    await git.run(["cat-file", "--batch"], "sha1\nsha2\n");
    expect(lastCall.stdin?.write).toHaveBeenCalledWith("sha1\nsha2\n");
    expect(lastCall.stdin?.end).toHaveBeenCalled();
  });

  test("does not touch stdin when none is given", async () => {
    stubExec(() => [null, "", ""]);
    const git = realGit("/repo");
    await git.run(["status"]);
    expect(lastCall.stdin?.write).not.toHaveBeenCalled();
    expect(lastCall.stdin?.end).not.toHaveBeenCalled();
  });

  test("accepts stdin even when the child has no stdin pipe", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: ExecCall["callback"],
      ) => {
        const call: ExecCall = {
          file: "git",
          args: [],
          options: {},
          stdin: null,
          written: [],
          callback,
        };
        lastCall = call;
        queueMicrotask(() => callback(null, "ok", ""));
        return call;
      },
    );
    const git = realGit("/repo");
    expect(await git.run(["cat-file", "--batch"], "input")).toBe("ok");
  });

  test("converts a Buffer stdout to a utf8 string", async () => {
    const buf = Buffer.from("café\n", "utf8");
    stubExec(() => [null, buf, ""]);
    const git = realGit("/repo");
    expect(await git.run(["ls-tree", "-r", "base"])).toBe("café\n");
  });
});
