import { pathToFileURL } from "node:url";
import { HandoffError, parseHandoff } from "./lib/handoff.js";
import { checkHandoff, exitCodeFor, formatReport } from "./lib/check.js";
import type { HandoffDeps } from "./lib/types.js";

export const EXIT_MALFORMED = 2;

export interface HandoffCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly deps: HandoffDeps;
}

export async function runCli(io: HandoffCliIo): Promise<number> {
  const [path] = io.argv;
  if (path === undefined || path === "") {
    io.logError("usage: handoff:check <handoff.json>");
    return EXIT_MALFORMED;
  }
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    io.logError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_MALFORMED;
  }
  let handoff;
  try {
    handoff = parseHandoff(text);
  } catch (error) {
    /* istanbul ignore next -- parseHandoff throws only HandoffError. The guard exists so an
       unexpected failure surfaces as itself rather than as a bad handoff. */
    if (!(error instanceof HandoffError)) throw error;
    io.logError(`${path}: ${error.message}`);
    return EXIT_MALFORMED;
  }
  let report;
  try {
    report = await checkHandoff(handoff, io.deps);
  } catch (error) {
    // A declared file that cannot be read, or a runner that produced no report:
    // the handoff is unusable, not unready. Saying which is the difference
    // between "add a test" and "fix your paths".
    io.logError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_MALFORMED;
  }
  io.log(formatReport(report));
  return exitCodeFor(report);
}

/* istanbul ignore next -- CLI entry: thin wrappers over node:fs and vitest, plus the entry guard.
   runCli() and every branch it feeds are covered directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFile } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");

  /**
   * Vitest's JSON reporter, read for the names of failing tests. `--reporter=json`
   * writes the run to stdout; a non-zero exit is expected here and is not an error,
   * because a stage-1 handoff is supposed to be red.
   */
  const failingTests = (files: readonly string[]): Promise<readonly string[]> =>
    new Promise((resolve, reject) => {
      execFile(
        "yarn",
        ["vitest", "run", "--reporter=json", ...files],
        { maxBuffer: 64 * 1024 * 1024 },
        (_error, stdout) => {
          const start = stdout.indexOf("{");
          if (start === -1) {
            reject(new Error("vitest produced no JSON report"));
            return;
          }
          try {
            const report = JSON.parse(stdout.slice(start)) as {
              testResults?: { assertionResults?: { title?: string; status?: string }[] }[];
            };
            const failed: string[] = [];
            for (const file of report.testResults ?? []) {
              for (const a of file.assertionResults ?? []) {
                if (a.status === "failed" && typeof a.title === "string") failed.push(a.title);
              }
            }
            resolve(failed);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
    });

  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    readFile: (path) => readFile(path, "utf8"),
    deps: { readFile: (path) => readFile(path, "utf8"), failingTests },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_MALFORMED;
    });
}
