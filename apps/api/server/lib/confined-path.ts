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
