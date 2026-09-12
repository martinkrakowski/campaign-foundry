import { parseManifest, ManifestError } from "./lib/manifest.js";
import { exitCodeFor, formatChecks, replayManifest, type ScratchDeps } from "./lib/replay.js";
import type { MutationDeps } from "../mutate/lib/types.js";

export const EXIT_MALFORMED = 2;

export interface ManifestCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly deps: MutationDeps;
  readonly scratch: ScratchDeps;
}

export async function runCli(io: ManifestCliIo): Promise<number> {
  const [path] = io.argv;
  if (path === undefined || path === "") {
    io.logError("usage: mutate:verify <manifest.json>");
    return EXIT_MALFORMED;
  }
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    io.logError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_MALFORMED;
  }
  let manifest;
  try {
    manifest = parseManifest(text);
  } catch (error) {
    /* istanbul ignore next -- parseManifest throws only ManifestError. This guard exists so that an
       unexpected failure surfaces as itself rather than being reported as a bad manifest. */
    if (!(error instanceof ManifestError)) throw error;
    io.logError(`${path}: ${error.message}`);
    return EXIT_MALFORMED;
  }
  const checks = await replayManifest(manifest, io.deps, io.scratch);
  io.log(formatChecks(manifest.lane, checks));
  return exitCodeFor(checks);
}

/* istanbul ignore next -- CLI entry: thin wrappers over node:fs and node:child_process, plus the
   entry guard. runCli() and every branch it feeds are covered directly in tests. */
if (process.argv[1]) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const deps: MutationDeps = {
      readFile: (path) => readFile(path, "utf8"),
      readFileBuffer: (path) => readFile(path),
      writeFileBuffer: (path, content) => writeFile(path, content),
      execute: (command) =>
        new Promise((resolve) => {
          const [bin, ...rest] = command;
          execFile(bin as string, rest, (error, stdout, stderr) => {
            const raw = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
            resolve({
              exitCode: error === null ? 0 : typeof raw === "number" ? raw : 1,
              stdout,
              stderr,
            });
          });
        }),
    };
    const scratch: ScratchDeps = {
      makeDir: () => mkdtemp(join(tmpdir(), "mutate-manifest-")),
      writeText: (path, text) => writeFile(path, text, "utf8"),
      removeDir: (path) => rm(path, { recursive: true, force: true }),
      join,
    };
    runCli({
      argv: process.argv.slice(2),
      log: (text) => console.log(text),
      logError: (text) => console.error(text),
      readFile: (path) => readFile(path, "utf8"),
      deps,
      scratch,
    })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_MALFORMED;
      });
  }
}
