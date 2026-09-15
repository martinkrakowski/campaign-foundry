import { pathToFileURL } from "node:url";
import { ManifestError, parseManifest } from "./lib/manifest.js";
import { checkInventory, formatReport } from "./lib/inventory.js";

export const DEFAULT_MANIFEST_PATH = ".architecture/manifest.yaml";

export const EXIT_CLEAN = 0;
/** The manifest and the tree disagree: fix one of them, never this code. */
export const EXIT_DRIFT = 1;
/** The manifest could not be read or parsed: the comparison did not happen. */
export const EXIT_MALFORMED = 2;

export interface ArchInventoryIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  /** File names directly inside `dir`; rejects with ENOENT when it is absent. */
  readonly listDir: (dir: string) => Promise<readonly string[]>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `arch:inventory [manifest-path]`
 *
 * Exit codes: 0 every inventory list matches its folder; 1 at least one
 * declared entry has no module file or one module file has no entry (the
 * report names each); 2 the manifest could not be read or parsed — the
 * comparison is refused rather than silently passed.
 */
export async function runCli(io: ArchInventoryIo): Promise<number> {
  const path = io.argv[0] ?? DEFAULT_MANIFEST_PATH;
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    io.logError(`cannot read ${path}: ${messageOf(error)}`);
    return EXIT_MALFORMED;
  }
  let manifest;
  try {
    manifest = parseManifest(text);
  } catch (error) {
    /* istanbul ignore next -- parseManifest throws only ManifestError. The
       guard exists so an unexpected failure surfaces as itself rather than
       as a bad manifest. */
    if (!(error instanceof ManifestError)) throw error;
    io.logError(`${path}: ${messageOf(error)}`);
    return EXIT_MALFORMED;
  }
  const findings = await checkInventory(manifest, { listDir: io.listDir });
  io.log(formatReport(findings, manifest.contexts.length));
  return findings.length === 0 ? EXIT_CLEAN : EXIT_DRIFT;
}

/* istanbul ignore next -- CLI entry: thin wrappers over node:fs plus the
   entry guard. runCli() and every branch it feeds are covered directly in
   tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readdir, readFile } = await import("node:fs/promises");
  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    readFile: (path) => readFile(path, "utf8"),
    listDir: async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(messageOf(error));
      process.exitCode = EXIT_MALFORMED;
    });
}
