import { pathToFileURL } from "node:url";
import { parseBriefNewArgs } from "./lib/args.js";
import { BriefNewRefusal, draftBriefNew, type BriefNewRequest } from "./lib/draft.js";
import { envLinesFrom } from "./lib/template.js";
// The one function this borrows rather than copies, as `fix-brief` does: an
// unknown thrown value still has to become one line of text on stderr.
import { errorText } from "../sweep/lib/sweep.js";

/**
 * The I/O this CLI is given. `readFile` and `writeFile` are injected beside the
 * existence check because a test must be able to run a whole draft — read the
 * env file, render, write, refusals — without a file on disk, exactly as
 * `SweepCliIo` injects `readFile` for `--body-file` and `FixBriefCliIo` injects
 * `writeFile`.
 */
export interface BriefNewCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * `brief:new --lane <id> --plan <path> --worktree <abs path> --branch <name>
 * --tip <sha> --host <midnight|mac> --out <path> [--env-file <path>]`
 *
 * Exit codes, as in `fix-brief`: 0 the brief was written; 1 a refusal — an
 * `--out` that exists — with every reason listed and nothing written; 2 the
 * command line itself is wrong, which is decided before anything is written.
 *
 * A `--env-file` that cannot be read, is blank, or carries a control character is
 * exit 2 and not exit 1: it is a bad command line, and it is decided in the same
 * try as the parse so that nothing is written while the environment block is in
 * doubt.
 *
 * It reads one file and writes one, and it never touches the forge: no forge
 * field reaches a lane brief, so there is nothing to sanitise and nothing to
 * fetch.
 */
export async function runCli(io: BriefNewCliIo): Promise<number> {
  let request: BriefNewRequest;
  try {
    const args = parseBriefNewArgs(io.argv);
    request = {
      ...args,
      ...(args.envFile === undefined
        ? {}
        : { envLines: envLinesFrom(await io.readFile(args.envFile)) }),
    };
  } catch (error) {
    io.logError(errorText(error));
    return 2;
  }
  try {
    const drafted = await draftBriefNew(request, {
      writeFile: io.writeFile,
      exists: io.exists,
    });
    io.log(
      `wrote ${drafted.out} — Template F for ${drafted.lane} on ${drafted.host}, ` +
        `${drafted.envLineCount} environment line(s)`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BriefNewRefusal) {
      io.logError(error.message);
      for (const reason of error.reasons) io.logError(`  ${reason}`);
      return 1;
    }
    io.logError(errorText(error));
    return 1;
  }
}

/* istanbul ignore next -- CLI entry: the thin wrapper over node:fs, plus the
   entry guard. runCli() and every branch it feeds are covered directly in
   tests. */
if (process.argv[1]) {
  const { access, readFile, writeFile } = await import("node:fs/promises");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, text) => writeFile(path, text, { encoding: "utf8", flag: "wx" }),
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
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
