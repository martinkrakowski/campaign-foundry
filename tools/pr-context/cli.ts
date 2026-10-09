import { pathToFileURL } from "node:url";
import {
  isValidCommitId,
  listBaseTree,
  readBaseBlobs,
  changedLines,
  realGit,
  type GitIo,
  type TreeEntry,
} from "./lib/git.js";
import { parseDiff } from "./lib/diff.js";
import { collectBlocks } from "./lib/collect.js";
import { render } from "./lib/render.js";

export interface PrContextCliIo {
  readonly argv: readonly string[];
  readonly git: GitIo;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly isSymlink: (path: string) => Promise<boolean>;
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
}

interface ParsedArgs {
  readonly base: string;
  readonly head: string;
  readonly out: string;
  readonly maxTokens: number;
}

const USAGE =
  "usage: pr:context --base <commit> --head <commit> --out <file> [--max-tokens <n>]\n" +
  "[--repo <dir>]\n" +
  "The output file is never written through a symlink; if the write fails, " +
  "the error is printed on stderr and the process exits 0 — the collector " +
  "never fails a review.";

function parseArgs(argv: readonly string[]): ParsedArgs {
  let base: string | undefined;
  let head: string | undefined;
  let out: string | undefined;
  let maxTokens = 15000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base") base = argv[++i];
    else if (arg === "--head") head = argv[++i];
    else if (arg === "--out") out = argv[++i];
    else if (arg === "--max-tokens") {
      const val = argv[++i];
      if (val === undefined) throw new Error("--max-tokens requires a value");
      maxTokens = Number.parseInt(val, 10);
      if (Number.isNaN(maxTokens)) throw new Error(`--max-tokens ${val} is not a number`);
    } else if (arg === "--repo") i++;
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (!base) throw new Error("--base is required");
  if (!isValidCommitId(base)) throw new Error(`${base} is not a valid commit id`);
  if (!head) throw new Error("--head is required");
  if (!isValidCommitId(head)) throw new Error(`${head} is not a valid commit id`);
  if (!out) throw new Error("--out is required");
  return { base, head, out, maxTokens };
}

function buildSources(
  entries: readonly TreeEntry[],
  blobs: Map<string, string>,
): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of entries) {
    const content = blobs.get(entry.blob);
    if (content !== undefined) sources.set(entry.path, content);
  }
  return sources;
}

/** Extract a one-line message from any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Secret-shaped patterns that must never appear in the output. N5. */
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /(?:^|[^A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

/** True when `text` contains any secret-shaped string. N5. */
export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

export async function runCli(io: PrContextCliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(io.argv);
  } catch (error) {
    io.logError(`pr:context: ${errorMessage(error)}`);
    io.logError(USAGE);
    return 2;
  }

  const start = Date.now();
  try {
    const entries = await listBaseTree(io.git, args.base);
    const blobs = await readBaseBlobs(io.git, entries);
    const sources = buildSources(entries, blobs);
    const diffText = await changedLines(io.git, args.base, args.head);
    const diff = parseDiff(diffText);
    const blocks = collectBlocks(sources, diff);
    const result = render(args.base, blocks, args.maxTokens);
    const secretFound = hasSecret(result.text);
    const outputText = secretFound
      ? render(args.base, [], 0).text +
        "\nwithheld: a secret-shaped string was found in the collected code"
      : result.text;
    // The output file is never written through a symlink; a write failure is
    // printed on stderr and exits 0 — the collector never fails a review.
    try {
      if (await io.isSymlink(args.out)) {
        throw new Error("is a symbolic link");
      }
      await io.writeFile(args.out, outputText);
    } catch (error) {
      const msg = errorMessage(error).replace(/\s+/g, " ").slice(0, 200);
      io.logError(`pr:context: could not write ${args.out}: ${msg}`);
      return 0;
    }
    const ms = Date.now() - start;
    const written = secretFound ? 0 : result.blocksWritten;
    const tokens = secretFound ? 0 : result.totalTokens;
    const dropped = secretFound ? 0 : result.blocksDropped;
    io.log(
      `pr:context: ${written} block(s), ~${tokens} tokens, ` +
        `${dropped} dropped for budget, ${ms} ms -> ${args.out}`,
    );
  } catch (error) {
    const msg = errorMessage(error).replace(/\s+/g, " ").slice(0, 200);
    const result = render(args.base, [], 0);
    const line = hasSecret(msg)
      ? "collector failed: (message withheld)"
      : `collector failed: ${msg}`;
    await io.writeFile(args.out, `${result.text}\n${line}`);
  }
  return 0;
}

/* istanbul ignore next -- CLI entry: the thin wrapper over node:child_process,
   node:fs/promises and process. runCli and every branch it feeds are covered
   directly in tests; the pathToFileURL guard is not reached in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const repoIdx = argv.indexOf("--repo");
  const repo =
    repoIdx !== -1 && argv[repoIdx + 1] !== undefined ? argv[repoIdx + 1]! : process.cwd();
  const git = realGit(repo);
  runCli({
    argv,
    git,
    writeFile: (path, content) =>
      import("node:fs/promises").then((fs) => fs.writeFile(path, content, "utf8")),
    isSymlink: (path) =>
      import("node:fs/promises").then((fs) =>
        fs
          .lstat(path)
          .then((stat) => stat.isSymbolicLink())
          .catch(() => false),
      ),
    log: (text) => console.log(text),
    logError: (text: string) => console.error(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`pr:context: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
