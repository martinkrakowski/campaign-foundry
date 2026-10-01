import { pathToFileURL } from "node:url";
import { parseFixBriefArgs, type FixBriefArgs } from "./lib/args.js";
import { FixBriefRefusal, draftBrief } from "./lib/draft.js";
import { errorText } from "../sweep/lib/sweep.js";
// The one function this borrows rather than copies: `gh` colorizes JSON when
// FORCE_COLOR is set even off a TTY, and `JSON.parse` then dies on the ANSI
// prefix — which is how a working GraphQL reply looks like a failed fetch.
import { ghChildEnv } from "../sweep/cli.js";

/**
 * The I/O this CLI is given. `gh` and `writeFile` are injected beside the
 * existence check because a test must be able to run a whole draft — fetch,
 * render, write, refusals — without a network or a file, exactly as
 * `SweepCliIo` injects `readFile`.
 */
export interface FixBriefCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly gh: (args: readonly string[]) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * `fix-brief --pr <n> --lane <id> --round <k> --worktree <path> --branch <name>
 * --tip <sha> --out <path> [--threads <id,id,…>]`
 *
 * Exit codes, as in `sweep`: 0 the brief was written; 1 a refusal — an
 * `--out` that exists, threads that could not be read in full, a PR that could
 * not be read, a `--threads` id that is not an open thread of it — with every
 * reason listed and nothing written; 2 the command line itself is wrong, which
 * is decided before the first forge call.
 *
 * Read-only on the forge: the only request this tool makes is the threads
 * query, and the only thing it writes is `--out`.
 */
export async function runCli(io: FixBriefCliIo): Promise<number> {
  let plan: FixBriefArgs;
  try {
    plan = parseFixBriefArgs(io.argv);
  } catch (error) {
    io.logError(errorText(error));
    return 2;
  }
  try {
    const drafted = await draftBrief(plan, {
      gh: io.gh,
      writeFile: io.writeFile,
      exists: io.exists,
    });
    io.log(
      `wrote ${drafted.out} — ${drafted.threadIds.length} item(s) from PR #${plan.pr}` +
        (drafted.threadIds.length === 0
          ? "; nothing is unresolved on that PR"
          : ` (${drafted.threadIds.join(", ")})`),
    );
    return 0;
  } catch (error) {
    if (error instanceof FixBriefRefusal) {
      io.logError(error.message);
      for (const reason of error.reasons) io.logError(`  ${reason}`);
      return 1;
    }
    io.logError(errorText(error));
    return 1;
  }
}

/* istanbul ignore next -- CLI entry: the thin wrapper over gh and node:fs,
   plus the entry guard. runCli() and every branch it feeds are covered
   directly in tests. */
if (process.argv[1]) {
  const { execFile } = await import("node:child_process");
  const { access, writeFile } = await import("node:fs/promises");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      // `wx` is the half of "never overwrite round k" that the pre-check in
      // draft.ts cannot be: that check and this write are two separate moments,
      // and anything that creates the file between them — another round on the
      // same path, a second lane, a stray editor buffer — is refused by the
      // kernel rather than truncated by this tool. The cost is an EEXIST that
      // this entry's catch reports as exit 1, like any other failed write, with
      // the path in the message.
      writeFile: (path, text) => writeFile(path, text, { encoding: "utf8", flag: "wx" }),
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      gh: (args) =>
        new Promise((resolve, reject) => {
          execFile(
            "gh",
            [...args],
            { maxBuffer: 16 * 1024 * 1024, env: ghChildEnv(process.env) },
            (error, stdout, stderr) => {
              if (error !== null) {
                reject(
                  new Error(`gh ${args.slice(0, 2).join(" ")}: ${stderr.trim() || error.message}`),
                );
              } else {
                resolve(stdout);
              }
            },
          );
        }),
    })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
