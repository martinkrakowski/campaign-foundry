import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Repo root — the nearest ancestor of cwd containing yarn.lock. Anchors paths to
 * the project regardless of where the process starts (the CLI runs at the repo
 * root; Nitro runs in apps/api). Falls back to cwd if the marker isn't found.
 */
function projectRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(resolve(dir, "yarn.lock"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd());
    dir = parent;
  }
}

/**
 * Absolute directory creatives are written to. Override with OUTPUT_DIR; defaults
 * to <repo-root>/output so the CLI and the Nitro server resolve to the same place.
 */
export function outputRoot(): string {
  return resolve(projectRoot(), process.env.OUTPUT_DIR ?? "output");
}
