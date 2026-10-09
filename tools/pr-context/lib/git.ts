import { execFile } from "node:child_process";
import { isCollectable, isRegularMode } from "./paths.js";

/** Bytes in 256 MiB: the cap a single git output stream may reach. */
export const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * The git contact surface of the collector.
 *
 * `run` receives git's argv (without `git` itself) and optional stdin, and
 * resolves with stdout — string only. It rejects on a non-zero exit or a launch
 * failure, so every caller has exactly one error path. A test supplies a fake
 * that answers from in-memory maps, so no test here spawns a process. N3.
 */
export interface GitIo {
  run(args: readonly string[], stdin?: string): Promise<string>;
}

/** A blob in the base tree, as `git ls-tree` reports it. */
export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
}

/**
 * The real `GitIo`: `git` by argv array only, never a shell, with a 256 MiB cap.
 * Stdin is piped when supplied (for `cat-file --batch`). N3.
 */
export function realGit(cwd: string): GitIo {
  return {
    run: (args, stdin) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "git",
          [...args],
          { cwd, maxBuffer: MAX_BUFFER },
          (error, stdout) => {
            if (error === null) {
              resolve(stdout.toString());
              return;
            }
            reject(error);
          },
        );
        if (stdin !== undefined && child.stdin) {
          child.stdin.write(stdin);
          child.stdin.end();
        }
      }),
  };
}

/**
 * `git ls-tree -r <base>`: every blob in the base tree, keeping only the regular
 * files in allowed paths. Modes that are not `100644`/`100755` (symlinks,
 * submodules, trees) are dropped; collectable paths only. N1, N2, N4.
 */
export async function listBaseTree(git: GitIo, base: string): Promise<TreeEntry[]> {
  const out = await git.run(["ls-tree", "-r", base]);
  const entries: TreeEntry[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const head = line.slice(0, tab).split(" ");
    const mode = head[0];
    const object = head[2];
    if (mode === undefined || object === undefined) continue;
    if (!isRegularMode(mode)) continue;
    const path = line.slice(tab + 1);
    if (!isCollectable(path)) continue;
    entries.push({ path, mode, blob: object });
  }
  return entries;
}

/**
 * `git cat-file --batch`: reads the content of every blob by SHA, parsing the
 * `<id> blob <size>\n<bytes>\n` framing BY BYTE LENGTH so that a blob whose body
 * contains a line that looks like a header is still cut correctly. Returns blob
 * id → content. N1.
 */
export async function readBaseBlobs(
  git: GitIo,
  entries: readonly TreeEntry[],
): Promise<Map<string, string>> {
  if (entries.length === 0) return new Map();
  const stdin = entries.map((e) => e.blob).join("\n") + "\n";
  const out = await git.run(["cat-file", "--batch"], stdin);
  const buf = Buffer.from(out, "utf8");
  const blobs = new Map<string, string>();
  let pos = 0;
  for (const entry of entries) {
    const nl = buf.indexOf(0x0a, pos); // '\n'
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString("utf8");
    const parts = header.split(" ");
    const size = Number.parseInt(parts[2] ?? "-1", 10);
    const contentStart = nl + 1;
    const contentEnd = contentStart + size;
    blobs.set(entry.blob, buf.subarray(contentStart, contentEnd).toString("utf8"));
    pos = contentEnd + 1;
  }
  return blobs;
}

/**
 * `git diff --unified=0 --no-color --no-ext-diff --no-renames <base> <head>`: the
 * textual diff used ONLY to learn which files and lines changed. No blob of the
 * head commit is ever read, parsed or printed. N1.
 */
export async function changedLines(git: GitIo, base: string, head: string): Promise<string> {
  return git.run([
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    base,
    head,
  ]);
}

/** A commit id is 7–40 hex chars; anything else is refused before git is called. N3. */
export const COMMIT_ID = /^[0-9a-f]{7,40}$/;

/** True when `id` looks like a real git commit id. N3. */
export function isValidCommitId(id: string): boolean {
  return COMMIT_ID.test(id);
}
