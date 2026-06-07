import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Repo root — the nearest ancestor of cwd containing yarn.lock. Brief asset paths
 * are relative to the project, but the process may start at the repo root (CLI) or
 * in a workspace dir (Nitro runs in apps/api), so cwd alone is unreliable. Falls
 * back to cwd if the marker isn't found.
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
 * Resolve a brief-supplied asset path, confined to the project directory.
 *
 * Briefs can arrive over HTTP (the /campaigns/generate route) with only shallow
 * structural validation, so an asset path is untrusted input. Reject absolute
 * paths and any `..` traversal, and require the resolved target to stay within the
 * project root. Returns the safe absolute path, or undefined to signal "skip this
 * asset" — callers already treat a missing asset as a clean fall-through.
 */
export function resolveAssetPath(input: string | undefined): string | undefined {
  if (!input || isAbsolute(input)) return undefined;
  const root = projectRoot();
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}
