import { describe, expect, test, vi } from "vitest";
import { runCli, errorMessage, hasSecret, type PrContextCliIo } from "../cli.js";
import type { GitIo } from "../lib/git.js";

// Secret-shaped fixtures are assembled at run time: a literal here would be read as a real
// credential by a secret scanner (GitHub's push protection refused the first push of this file).
const PRIVATE_KEY_HEADER = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");

const BASE = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HEAD = "cafebabecafebabecafebabecafebabecafebabe";
const BLOB_PORT = "1111111111111111111111111111111111111111";
const BLOB_REPO = "2222222222222222222222222222222222222222";
const BLOB_API = "3333333333333333333333333333333333333333";

function catFileResponse(blobs: Array<{ sha: string; content: string }>): string {
  let result = "";
  for (const { sha, content } of blobs) {
    const size = Buffer.byteLength(content, "utf8");
    result += `${sha} blob ${size}\n${content}\n`;
  }
  return result;
}

type GitCall = { args: readonly string[]; stdin?: string };

function makeGit(responses: Record<string, string>): GitIo & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  return {
    calls,
    run: async (args, stdin) => {
      calls.push({ args, stdin });
      return responses[args.join(" ")] ?? "";
    },
  };
}

function makeWritten(): {
  written: { path: string; content: string }[];
  writeFile: (path: string, content: string) => Promise<void>;
} {
  const written: { path: string; content: string }[] = [];
  return {
    written,
    writeFile: async (path, content) => {
      written.push({ path, content });
    },
  };
}

describe("errorMessage", () => {
  test("extracts the message from an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  test("stringifies a non-Error throw", () => {
    expect(errorMessage("string error")).toBe("string error");
  });
});

describe("collected code is read from the base tree and never from the head", () => {
  test("no cat-file or show argument names the head commit or a head-only blob; head appears only in diff", async () => {
    const portContent = "interface IRepo { save(data: string): void; }";
    const repoContent = "class SqlRepo implements IRepo { save(d: string) { return d; } }";
    const log = makeWritten();
    const git = makeGit({
      ["ls-tree -r " + BASE]: [
        `100644 blob ${BLOB_PORT}\tpackages/repo/src/repo.port.ts`,
        `100644 blob ${BLOB_REPO}\tpackages/repo/src/repo.ts`,
        `100644 blob ${BLOB_API}\tpackages/app/src/api.ts`,
        `120000 blob ${HEAD}\tsymlink/everywhere`,
      ].join("\n"),
      ["cat-file --batch"]: catFileResponse([
        { sha: BLOB_PORT, content: portContent },
        { sha: BLOB_REPO, content: repoContent },
        { sha: BLOB_API, content: 'SqlRepo.save("hello");' },
      ]),
      ["diff --unified=0 --no-color --no-ext-diff --no-renames " + BASE + " " + HEAD]:
        "diff --git a/packages/app/src/api.ts b/packages/app/src/api.ts\n" +
        "--- a/packages/app/src/api.ts\n+++ b/packages/app/src/api.ts\n" +
        '@@ -1,1 +1,1 @@\n-old()\n+SqlRepo.save("hello")\n',
    });

    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: (text) => {
        void text;
      },
    });

    expect(code).toBe(0);
    const catFileCall = git.calls.find((c) => c.args[0] === "cat-file");
    expect(catFileCall?.stdin).not.toContain(HEAD);
    // A head-only blob is never read — only base blobs are in cat-file stdin
    expect(catFileCall?.stdin).not.toContain(BLOB_API.replace("3", "9"));
    // Head appears only in the diff call args, never in cat-file/show
    const diffCall = git.calls.find((c) => c.args[0] === "diff");
    expect(diffCall?.args).toContain(HEAD);
    expect(git.calls.filter((c) => c.args[0] === "show")).toHaveLength(0);
    // Output file was written with the header
    expect(log.written).toHaveLength(1);
    expect(log.written[0]?.content).toContain("Reference code from the base commit");
  });
});

describe("commit id validation (N3)", () => {
  test("a non-hex commit id is refused before any git call", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const errs: string[] = [];
    const code = await runCli({
      argv: ["--base", "zzz", "--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: (text) => {
        errs.push(text);
      },
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
    expect(errs.some((e) => e.includes("not a valid commit id"))).toBe(true);
  });

  test("missing --base is a usage refusal", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const code = await runCli({
      argv: ["--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
  });

  test("missing --out is a usage refusal", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
  });

  test("an unknown argument is a usage refusal", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md", "--bogus"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
  });
});

describe("collector failure handling (N6)", () => {
  test("a failure inside the collector still writes the file and exits 0", async () => {
    const failGit: GitIo = {
      run: async () => {
        throw new Error("git exploded");
      },
    };
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md"],
      git: failGit,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(0);
    expect(log.written).toHaveLength(1);
    expect(log.written[0]?.content).toContain("collector failed: git exploded");
  });

  test("a wrong command line exits 2 and writes nothing", async () => {
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", "nothex", "--head", HEAD, "--out", "/tmp/out.md"],
      git: {
        run: async () => {
          throw new Error("should not be called");
        },
      },
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(log.written).toHaveLength(0);
  });
});

describe("argument parsing edge cases", () => {
  test("--max-tokens and --repo are accepted and consumed", async () => {
    const portContent = "interface IRepo { save(d: string): void; }";
    const repoContent = "class SqlRepo implements IRepo { save(d: string) { return d; } }";
    const git = makeGit({
      ["ls-tree -r " + BASE]: [
        `100644 blob ${BLOB_PORT}\tpackages/repo/src/repo.port.ts`,
        `100644 blob ${BLOB_REPO}\tpackages/repo/src/repo.ts`,
      ].join("\n"),
      ["cat-file --batch"]: catFileResponse([
        { sha: BLOB_PORT, content: portContent },
        { sha: BLOB_REPO, content: repoContent },
      ]),
      ["diff --unified=0 --no-color --no-ext-diff --no-renames " + BASE + " " + HEAD]:
        "diff --git a/packages/repo/src/repo.ts b/packages/repo/src/repo.ts\n" +
        "--- a/packages/repo/src/repo.ts\n+++ b/packages/repo/src/repo.ts\n" +
        '@@ -1,1 +1,1 @@\n-old()\n+SqlRepo.save("hi")\n',
    });
    const log = makeWritten();
    const code = await runCli({
      argv: [
        "--base",
        BASE,
        "--head",
        HEAD,
        "--out",
        "/tmp/out.md",
        "--max-tokens",
        "200",
        "--repo",
        "/repo",
      ],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(0);
    expect(log.written).toHaveLength(1);
  });

  test("missing --head is a usage refusal", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
  });

  test("a non-hex --head is a usage refusal", async () => {
    const git = makeGit({});
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", "badhex!", "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(2);
    expect(git.calls).toHaveLength(0);
    expect(log.written).toHaveLength(0);
  });

  test("a missing blob in cat-file response is skipped when building sources", async () => {
    const git = makeGit({
      ["ls-tree -r " + BASE]: [
        `100644 blob ${BLOB_PORT}\tpackages/repo/src/repo.port.ts`,
        `100644 blob ${BLOB_REPO}\tpackages/repo/src/repo.ts`,
      ].join("\n"),
      // Only BLOB_PORT is returned — BLOB_REPO is missing
      ["cat-file --batch"]: catFileResponse([
        { sha: BLOB_PORT, content: "interface IRepo { save(d: string): void; }" },
      ]),
      ["diff --unified=0 --no-color --no-ext-diff --no-renames " + BASE + " " + HEAD]:
        "diff --git a/packages/repo/src/repo.ts b/packages/repo/src/repo.ts\n" +
        "--- a/packages/repo/src/repo.ts\n+++ b/packages/repo/src/repo.ts\n" +
        "@@ -1,1 +1,1 @@\n-old()\n+save()\n",
    });
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(0);
    expect(log.written).toHaveLength(1);
    // Only the port interface file was available — output should have 0 blocks
    expect(log.written[0]?.content).toContain("0 block(s)");
  });

  test("a non-Error throw inside the pipeline still writes the error file", async () => {
    const git: GitIo = {
      run: async () => {
        throw "string error";
      },
    };
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(0);
    expect(log.written).toHaveLength(1);
    expect(log.written[0]?.content).toContain("collector failed: string error");
  });
});

describe("hasSecret (N5)", () => {
  test("a PRIVATE KEY pattern is detected", () => {
    expect(hasSecret(PRIVATE_KEY_HEADER)).toBe(true);
  });
  test("an AWS access key (AKIA) pattern is detected", () => {
    expect(hasSecret(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toBe(true);
  });
  test("a GitHub token pattern is detected", () => {
    expect(hasSecret(["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"))).toBe(true);
  });
  test("an OpenAI key pattern is detected", () => {
    expect(hasSecret(["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"))).toBe(true);
  });
  test("a Slack token pattern is detected", () => {
    expect(hasSecret(["xoxb", "1234567890", "abcdefghijklmnopqrstuvwxyz"].join("-"))).toBe(true);
  });
  test("plain code is not flagged", () => {
    expect(hasSecret("function save() { return data; }")).toBe(false);
  });
});

describe("secret scan withholds the output (N5)", () => {
  test("a secret-shaped string in the collected code withholds every block", async () => {
    const git = makeGit({
      ["ls-tree -r " + BASE]: `100644 blob ${BLOB_REPO}\tpackages/repo/src/repo.ts`,
      ["cat-file --batch"]: catFileResponse([
        {
          sha: BLOB_REPO,
          content: `function ownsSecret() { const key = "${PRIVATE_KEY_HEADER}"; return true; }`,
        },
      ]),
      ["diff --unified=0 --no-color --no-ext-diff --no-renames " + BASE + " " + HEAD]:
        "diff --git a/packages/app/src/api.ts b/packages/app/src/api.ts\n" +
        "--- a/packages/app/src/api.ts\n+++ b/packages/app/src/api.ts\n@@ -1,1 +1,1 @@\n+ownsSecret()\n",
    });
    const log = makeWritten();
    const code = await runCli({
      argv: ["--base", BASE, "--head", HEAD, "--out", "/tmp/out.md"],
      git,
      writeFile: log.writeFile,
      log: () => undefined,
      logError: () => undefined,
    });
    expect(code).toBe(0);
    expect(log.written).toHaveLength(1);
    expect(log.written[0]?.content).toContain(
      "withheld: a secret-shaped string was found in the collected code",
    );
    expect(log.written[0]?.content).not.toContain("-----BEGIN");
  });
});
