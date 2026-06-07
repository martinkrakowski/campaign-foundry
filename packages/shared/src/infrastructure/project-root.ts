import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Files that mark the monorepo root, in any-of order. */
const ROOT_MARKERS = ["yarn.lock", "turbo.json"];

let cached: string | undefined;

/**
 * The monorepo root, resolved once per process. Resolution order:
 *   1. PROJECT_ROOT env var (authoritative — for packaged/preview runtimes such as
 *      `node .output/server` where the marker files may not ship).
 *   2. Nearest ancestor of cwd containing a root marker (yarn.lock / turbo.json).
 *   3. cwd (last-resort fallback).
 *
 * Anchors cwd-relative project conventions so they resolve identically whether a
 * process starts at the repo root (the CLI) or in a workspace dir (Nitro runs in
 * apps/api). Memoized — the result is stable for a process, and this is called on
 * hot paths (per request, per generated asset).
 */
export function projectRoot(): string {
  if (cached) return cached;
  const override = process.env.PROJECT_ROOT;
  if (override) return (cached = resolve(override));
  let dir = resolve(process.cwd());
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(resolve(dir, marker)))) return (cached = dir);
    const parent = dirname(dir);
    if (parent === dir) return (cached = resolve(process.cwd()));
    dir = parent;
  }
}
