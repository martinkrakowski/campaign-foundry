import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Resolve `segments` under `base` and reject anything that escapes that directory
 * (absolute segments, `..` after normalization, or the base itself).
 */
export function resolveConfined(base: string, ...segments: string[]): string {
  const root = resolve(base);
  const target = resolve(root, ...segments);
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error("Path escapes the allowed directory.");
  }
  return target;
}

/**
 * `resolveConfined` plus a realpath check for readers: stat/createReadStream/readFile
 * follow symlinks, so a link inside the root may aim outside it. Compares
 * `realpath(target)` against `realpath(base)` (a symlinked root, e.g. macOS
 * `/tmp` → `/private/tmp`, stays allowed) and, on success, returns that **real**
 * path rather than the lexical one: every symlink component in `target` is
 * already resolved, so a caller that looks the result up a second time by
 * pathname is not re-following a name that could have been swapped since the
 * check. A missing target is returned untouched (lexical) — the caller's own
 * not-found path decides, unchanged. Write paths keep using the lexical
 * `resolveConfined`: the file may not exist yet.
 *
 * Residual: this closes the window between the check and a *second lookup by
 * pathname* (the historical bug here). The output route further narrows it by
 * opening the returned real path with `O_NOFOLLOW`, so a swap of the final
 * component between this call and that open fails closed (ELOOP) instead of
 * following a new link. Neither closes a swap of an *intermediate real
 * directory* on the returned path between check and open: Node has no
 * `openat`/`O_BENEATH` to walk the remaining components beneath an
 * already-verified directory fd. That requires write access to the output tree
 * plus precise timing — see §29 (X26) of
 * docs/planning/2026-09-10_the-unowned-gaps.md.
 */
export async function resolveConfinedForRead(base: string, ...segments: string[]): Promise<string> {
  const target = resolveConfined(base, ...segments);
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
  const realRoot = await realpath(resolve(base));
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error("Path escapes the allowed directory.");
  }
  return realTarget;
}
