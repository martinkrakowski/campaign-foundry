import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a brief-supplied asset path, confined to `<root>/assets`.
 *
 * Briefs arrive over HTTP (the /campaigns/generate route) as untrusted input, and
 * `logoApplied` is echoed back per asset — so a broad base directory would be a
 * file-existence/decodability oracle for the whole repo. Confine reads to
 * `<root>/assets`: reject absolute paths and anything (after `..`
 * normalization) that escapes that subtree. Returns the safe absolute path, or
 * undefined to signal "skip this asset" — callers treat a missing asset as a
 * clean fall-through.
 *
 * `root` is the project root the caller was constructed with (D167, PT-0b1):
 * the location is a parameter handed down from the composition root, never
 * read from the process environment here.
 */
export function resolveAssetPath(input: string | undefined, root: string): string | undefined {
  if (!input || isAbsolute(input)) return undefined;
  const assetBase = resolve(root, "assets");
  // Brief paths are repo-root-relative by convention (e.g. "assets/inputs/x.png"),
  // so resolve against the root, then require containment within assets/.
  const target = resolve(root, input);
  const rel = relative(assetBase, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}
