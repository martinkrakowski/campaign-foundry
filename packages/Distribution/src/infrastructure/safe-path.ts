import { resolve, sep } from "node:path";

/**
 * Resolve `relativePath` under `root`, refusing any result that escapes it.
 * Shared by FileSystemExporter and FileSystemPackageStore.
 */
export function resolveSafe(root: string, relativePath: string, action: "read" | "write" | "remove"): string {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Refusing to ${action} outside the output root: ${relativePath}`);
  }
  return target;
}
