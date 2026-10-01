import { pathToFileURL } from "node:url";
import { parseBriefNewArgs } from "./lib/args.js";
import { draftBriefNew, type BriefNewRequest } from "./lib/draft.js";
import { envLinesFrom } from "./lib/template.js";
// The one function this borrows rather than copies, as `fix-brief` does: an
// unknown thrown value still has to become one line of text on stderr.
import { errorText } from "../sweep/lib/sweep.js";

/**
 * The I/O this CLI is given. `readFile`, `writeFile`, `mkdir` and `exists` are all
 * injected because a test must be able to run a whole draft — read the env file,
 * decide the pre-flight, create the directory, render, write, refuse — without a
 * file on disk, exactly as `SweepCliIo` injects `readFile` for `--body-file` and
 * `FixBriefCliIo` injects `writeFile`.
 */
export interface BriefNewCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * `brief:new --lane <id> --plan <path> --worktree <abs path> --branch <name>
 * --tip <sha> --host <midnight|mac> --out <path> [--env-file <path>]`
 *
 * Exit codes, as in `fix-brief`: 0 the brief was written; 2 the command line
 * cannot be acted on; 1 the write itself failed.
 *
 * **2 is the whole of the pre-flight**, and it is decided before a byte is
 * written: a refused flag or value, an `--env-file` that cannot be read, is blank
 * or carries a control character, and an `--out` that already exists. That last one
 * is here rather than in the draft because it is a decision about the command
 * line — the caller named a path that is taken, and the brief on disk is what the
 * run would have destroyed — and the message names the path and says what to do
 * instead, as every refusal in this repo lists its reasons.
 *
 * **1 is what is left after that**, which is the write: the `wx` refusing a file
 * that appeared between the pre-flight check and the write, a directory that could
 * not be created, a path the kernel would not take. The two are different moments
 * and they say so; both leave the file alone.
 *
 * It reads at most one file, creates at most one directory and writes one, and it
 * never touches the forge: no forge field reaches a lane brief, so there is
 * nothing to sanitise and nothing to fetch.
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
  if (await io.exists(request.out)) {
    io.logError(`refusing to write ${request.out} — it already exists`);
    io.logError(
      `  ${request.out} exists, so this run would overwrite the brief already on disk; give each lane its own --out`,
    );
    return 2;
  }
  try {
    const drafted = await draftBriefNew(request, {
      writeFile: io.writeFile,
      mkdir: io.mkdir,
    });
    io.log(
      `wrote ${drafted.out} — Template F for ${drafted.lane} on ${drafted.host}, ` +
        `${drafted.envLineCount} environment line(s)`,
    );
    return 0;
  } catch (error) {
    io.logError(errorText(error));
    return 1;
  }
}

/* istanbul ignore next -- CLI entry: the thin wrapper over node:fs, plus the
   entry guard. runCli() and every branch it feeds are covered directly in
   tests. */
if (process.argv[1]) {
  const { access, mkdir, readFile, writeFile } = await import("node:fs/promises");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, text) => writeFile(path, text, { encoding: "utf8", flag: "wx" }),
      // `recursive` is what makes this idempotent, and that is the whole reason it
      // can be unconditional: a directory that is already there is not an error,
      // so there is no case where the caller has to say whether to create it.
      // `await` and no return, because node's `mkdir` resolves with the first
      // path it created and this interface promises `void` — nothing downstream
      // of it wants to know which.
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
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
