import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PR #599 review (finding 6, greptile): `ports/index.ts` importing
 * `in-process-run-delivery.js` closes a cycle back on itself —
 * `ports/index -> in-process-run-delivery -> run-request -> jobs ->
 * ports/index` — the circular dependency `.agents/architecture.md:45`
 * forbids. `hexagen arch validate` (`yarn lint:arch`) does not catch it: its
 * layer rules cover `packages/*\/src` only (a documented scope gap), never
 * `apps/*`. This is a plain static-import DFS instead — regex the relative
 * `import`/`export … from` specifiers (never `import type`/`export type`,
 * which are erased at build and create no runtime edge) starting from
 * `ports/index.ts`, and assert the file the fix moved out of it is not
 * reachable.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = resolve(HERE, "..", "..");

/** A `from "..."`/`from '...'` specifier on a *runtime* import/export line. */
const IMPORT_LINE = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // a package import — not part of this graph
  const abs = resolve(dirname(fromFile), specifier);
  return abs.endsWith(".js") ? `${abs.slice(0, -3)}.ts` : abs;
}

/** Every file this file's runtime imports/exports reach, directly. */
function directDeps(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const deps: string[] = [];
  for (const match of src.matchAll(IMPORT_LINE)) {
    const resolved = resolveSpecifier(file, match[2]!);
    if (resolved) deps.push(resolved);
  }
  return deps;
}

/** Every file reachable from `start` by following runtime import/export edges. */
function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop()!;
    for (const dep of directDeps(file)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen;
}

describe("ports/index.ts stays acyclic", () => {
  test("the barrel never reaches in-process-run-delivery.ts (finding 6)", () => {
    const barrel = resolve(LIB_DIR, "ports", "index.ts");
    const adapter = resolve(LIB_DIR, "ports", "in-process-run-delivery.ts");

    const reachable = reachableFrom(barrel);

    // The adapter's own chain (run-request -> jobs -> ports/index) still
    // reaches the barrel one-way — that is fine, and proves the DFS actually
    // walks the real chain rather than trivially passing. What must never
    // happen is the barrel reaching the adapter, which is what closes the
    // loop back on itself.
    expect(reachableFrom(adapter).has(barrel)).toBe(true);
    expect(reachable.has(adapter)).toBe(false);
  });
});
