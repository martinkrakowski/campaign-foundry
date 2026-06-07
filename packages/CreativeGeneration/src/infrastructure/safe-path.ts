import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a brief-supplied asset path, confined to the project directory.
 *
 * Briefs can arrive over HTTP (the /campaigns/generate route) with only shallow
 * structural validation, so an asset path is untrusted input. Reject absolute
 * paths and any `..` traversal, and require the resolved target to stay within
 * process.cwd(). Returns the safe absolute path, or undefined to signal "skip
 * this asset" — callers already treat a missing asset as a clean fall-through.
 */
export function resolveAssetPath(input: string | undefined): string | undefined {
  if (!input || isAbsolute(input)) return undefined;
  const root = resolve(process.cwd());
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}
