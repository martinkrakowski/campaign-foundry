import { pathToFileURL } from "node:url";
import {
  anchorExitCode,
  checkAnchors,
  formatAnchorReport,
  type AnchorDeps,
} from "./lib/anchors.js";

export const DEFAULT_MANIFEST_DIR = ".agents/manifests";
/** The directory could not be listed. Not "no manifests": a check that cannot look must not pass. */
export const EXIT_UNUSABLE = 2;

export interface AnchorCliIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  /** Every manifest in the directory, in a stable order. Never a diff — that is the point. */
  readonly listManifests: (dir: string) => Promise<readonly string[]>;
  readonly deps: AnchorDeps;
}

/**
 * Asks of EVERY manifest, not only the ones a change touched: does each live
 * mutation's before-text still appear exactly once in its file?
 *
 * The diff-scoped question is the one `verify-manifests.sh` already asks, and
 * it is the reason 57 anchors across 34 manifests were dead here with a green
 * gate: a lane that reformats a source file breaks anchors in manifests its
 * diff never names, and those manifests are never replayed again. Scoping this
 * check to a diff too would rebuild that hole, so it deliberately walks the
 * directory.
 */
export async function runAnchorCli(io: AnchorCliIo): Promise<number> {
  const dir = io.argv[0] ?? DEFAULT_MANIFEST_DIR;
  let manifests: readonly string[];
  try {
    manifests = await io.listManifests(dir);
  } catch (error) {
    io.logError(
      `anchors: cannot list ${dir}: ${error instanceof Error ? error.message : String(error)} — ` +
        `refusing to report that as nothing to check`,
    );
    return EXIT_UNUSABLE;
  }
  if (manifests.length === 0) {
    io.log(`anchors: no manifests in ${dir}; nothing to check`);
    return 0;
  }
  const report = await checkAnchors(manifests, io.deps);
  io.log(formatAnchorReport(report));
  return anchorExitCode(report);
}

/* istanbul ignore next -- CLI entry: the real directory listing and the entry guard. runAnchorCli()
   and every branch it feeds are covered directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  runAnchorCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    listManifests: async (dir) =>
      (await readdir(dir))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(dir, name)),
    deps: { readText: (path) => readFile(path, "utf8") },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_UNUSABLE;
    });
}
