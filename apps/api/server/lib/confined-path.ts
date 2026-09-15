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
 * `/tmp` → `/private/tmp`, stays allowed). A missing target is returned untouched —
 * the caller's own not-found path decides, unchanged. Write paths keep using the
 * lexical `resolveConfined`: the file may not exist yet.
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
  return target;
}
