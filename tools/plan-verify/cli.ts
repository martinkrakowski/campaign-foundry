import { parsePremises } from "./lib/premises.js";
import {
  PREMISE_TIMEOUT_MS,
  exitCodeFor,
  formatReport,
  verifyPremises,
} from "./lib/verify.js";
import type { Premise, VerifyDeps } from "./lib/types.js";

export interface PlanVerifyIo {
  /** Plan files to check. Empty means "every plan in {@link PLAN_DIR}". */
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  /** Lists the plan directory. Only consulted when `argv` is empty. */
  readonly listPlanDir: () => Promise<readonly string[]>;
  readonly deps: VerifyDeps;
}

export const PLAN_DIR = "docs/planning";

export async function runCli(io: PlanVerifyIo): Promise<number> {
  const plans =
    io.argv.length > 0
      ? [...io.argv]
      : (await io.listPlanDir()).filter((n) => n.endsWith(".md")).sort().map((n) => `${PLAN_DIR}/${n}`);
  const premises: Premise[] = [];
  for (const plan of plans) {
    premises.push(...parsePremises(plan, await io.readFile(plan)));
  }
  const results = await verifyPremises(premises, io.deps);
  io.log(formatReport(results));
  return exitCodeFor(results);
}

/* istanbul ignore next -- CLI entry: thin wrappers over sh and node:fs, plus the
   entry guard. runCli() and every branch it feeds are covered directly in tests. */
if (process.argv[1]) {
  const { execFile } = await import("node:child_process");
  const { readFile, readdir } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const deps: VerifyDeps = {
      execute: (script) =>
        new Promise((resolve) => {
          execFile("sh", ["-c", script], { timeout: PREMISE_TIMEOUT_MS }, (error, stdout, stderr) => {
            const err = (error ?? null) as
              | (NodeJS.ErrnoException & { code?: number; killed?: boolean })
              | null;
            resolve({
              exitCode: err === null ? 0 : typeof err.code === "number" ? err.code : 1,
              output: `${stdout}${stderr}`.trim(),
              timedOut: err?.killed === true,
            });
          });
        }),
    };
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      readFile: (path) => readFile(path, "utf8"),
      listPlanDir: () => readdir(PLAN_DIR),
      deps,
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
