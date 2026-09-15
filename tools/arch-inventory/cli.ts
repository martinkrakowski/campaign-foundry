import { pathToFileURL } from "node:url";
import type { Manifest as HexManifest, Result } from "@hexagen-monaco/sync";
import { fromHexagen } from "./lib/manifest.js";
import { checkInventory, formatReport } from "./lib/inventory.js";

/** The workspace root `arch:inventory` compares by default — `.architecture/
 *  manifest.yaml` under it, exactly where hexagen's own `loadManifest` reads. */
export const DEFAULT_WORKSPACE_ROOT = ".";

export const EXIT_CLEAN = 0;
/** The manifest and the tree disagree: fix one of them, never this code. */
export const EXIT_DRIFT = 1;
/** The manifest could not be loaded, or this tool could not make sense of it
 *  once loaded: the comparison did not happen. */
export const EXIT_MALFORMED = 2;

export interface ArchInventoryIo {
  readonly argv: readonly string[];
  readonly log: (text: string) => void;
  readonly logError: (text: string) => void;
  /** hexagen's own manifest loader (anchors, split manifests, owned-port
   *  objects — all resolved before this tool ever sees the result). */
  readonly loadManifest: (workspaceRoot: string) => Promise<Result<HexManifest, Error>>;
  /** File names directly inside `dir`; rejects with ENOENT when it is absent. */
  readonly listDir: (dir: string) => Promise<readonly string[]>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `arch:inventory [workspace-root]`
 *
 * Exit codes: 0 every inventory list matches its folder; 1 at least one
 * declared entry has no module file, one module file has no entry, or two
 * declared entries collide (the report names each); 2 the manifest could not
 * be loaded, or this tool's own naming resolution rejected it (e.g. a stub
 * naming template missing `{name}`) — the comparison is refused rather than
 * silently passed, and nothing here is left to throw uncaught.
 */
export async function runCli(io: ArchInventoryIo): Promise<number> {
  const root = io.argv[0] ?? DEFAULT_WORKSPACE_ROOT;
  const loaded = await io.loadManifest(root);
  if (!loaded.success) {
    io.logError(`cannot load the manifest under ${root}: ${messageOf(loaded.error)}`);
    return EXIT_MALFORMED;
  }
  let manifest;
  try {
    manifest = fromHexagen(loaded.value);
  } catch (error) {
    io.logError(`manifest: ${messageOf(error)}`);
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
  const { readdir } = await import("node:fs/promises");
  const { loadManifest } = await import("@hexagen-monaco/sync");
  runCli({
    argv: process.argv.slice(2),
    log: (text) => console.log(text),
    logError: (text) => console.error(text),
    loadManifest,
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
