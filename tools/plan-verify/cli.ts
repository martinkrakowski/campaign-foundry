import { parsePremises } from "./lib/premises.js";
import {
  PREMISE_TIMEOUT_MS,
  exitCodeFor,
  formatReport,
  verifyPremises,
} from "./lib/verify.js";
import type { Premise, VerifyDeps } from "./lib/types.js";
import {
  PROVENANCE_UNKNOWN,
  artifactPathFor,
  buildArtifact,
  errorText,
  serializeArtifact,
  type ArtifactScope,
} from "./lib/artifact.js";

export interface PlanVerifyIo {
  /** Plan files to check. Empty means "every plan in {@link PLAN_DIR}". */
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  /** Lists the plan directory. Only consulted when `argv` is empty. */
  readonly listPlanDir: () => Promise<readonly string[]>;
  readonly deps: VerifyDeps;
  readonly now: () => string;
  readonly git: (args: readonly string[]) => Promise<string>;
  readonly artifactPath: () => string;
  readonly writeArtifact: (path: string, contents: string) => Promise<void>;
}

export const PLAN_DIR = "docs/planning";

export async function runCli(io: PlanVerifyIo): Promise<number> {
  const isSubset = io.argv.length > 0;
  const plans = isSubset
    ? [...io.argv]
    : (await io.listPlanDir()).filter((n) => n.endsWith(".md")).sort().map((n) => `${PLAN_DIR}/${n}`);
  const premises: Premise[] = [];
  for (const plan of plans) {
    premises.push(...parsePremises(plan, await io.readFile(plan)));
  }
  const results = await verifyPremises(premises, io.deps);
  io.log(formatReport(results));

  let branch = PROVENANCE_UNKNOWN;
  let head = PROVENANCE_UNKNOWN;
  try {
    const b = (await io.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (b !== "") branch = b;
  } catch {
    // unknown
  }
  try {
    const h = (await io.git(["rev-parse", "HEAD"])).trim();
    if (h !== "") head = h;
  } catch {
    // unknown
  }

  const scope: ArtifactScope = isSubset ? { kind: "partial", plans } : { kind: "full" };
  const artifact = buildArtifact(results, {
    at: io.now(),
    git: { branch, head },
    scope,
    plans,
  });

  const path = io.artifactPath();
  try {
    await io.writeArtifact(path, serializeArtifact(artifact));
  } catch (err: unknown) {
    io.log(`WARN: could not write artifact ${path}: ${errorText(err)}`);
  }

  return exitCodeFor(results);
}

/* istanbul ignore next -- CLI entry: thin wrappers over sh and node:fs, plus the
   entry guard. runCli() and every branch it feeds are covered directly in tests. */
if (process.argv[1]) {
  const { execFile } = await import("node:child_process");
  const { readFile, readdir, writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
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
      now: () => new Date().toISOString(),
      git: (args) =>
        new Promise((resolve, reject) => {
          execFile("git", args, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        }),
      artifactPath: () => artifactPathFor(process.env),
      writeArtifact: async (path, contents) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, "utf8");
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
