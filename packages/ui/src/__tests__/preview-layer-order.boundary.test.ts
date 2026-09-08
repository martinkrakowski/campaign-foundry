import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * D121 — the preview's stack order has one source:
 * `CANONICAL_TEMPLATES["image-text"].layers`, re-exported from `preview-layers.ts`
 * as `PREVIEW_LAYER_ORDER` and iterated by the glyph. A *second* hardcoded
 * ordering anywhere else in the kit is how the glyph and the compositor drift.
 *
 * This is the boundary test the DoD asks for: it scans `packages/ui/src/**` and
 * fails on any file other than `preview-layers.ts` holding an array literal of
 * two or more `LayerKind` string members. It is deliberately narrow — array
 * literals only, and only when *every* quoted string in the literal is a layer
 * kind — so it can never fire on prose, identifiers, or unrelated arrays.
 * Deleting it as noise is exactly the regression it guards against.
 */

const LAYER_KINDS = ["image", "fill", "static-text", "animated-text", "html", "video", "logo", "accent", "shade"] as const;

/** Recurse `packages/ui/src`, skipping `__tests__`: behavioural tests enumerate
 * kinds to assert on outputs (that is their job); the boundary protects the
 * component sources, which must derive the order instead of copying it. */
function listKitSources(dir: string, root: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...listKitSources(full, root));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      names.push(relative(root, full));
    }
  }
  return names;
}

const kitDir = resolve(import.meta.dirname, "..");
const files = listKitSources(kitDir, kitDir).filter((file) => file !== "src/preview-layers.ts");

/** Every array literal: `\[` … `\]`, newlines allowed. */
const ARRAY_LITERAL = /\[((?:[^\]\\]|\\.)*)\]/g;
const QUOTED = /"([^"]+)"|'([^']+)'/g;

/** True when the literal holds two or more quoted strings and every one is a layer kind. */
function secondOrdering(literal: string): boolean {
  const strings = [...literal.matchAll(QUOTED)]
    .map((m) => m[1] ?? m[2])
    .filter((s): s is string => s !== undefined);
  if (strings.length < 2) return false;
  return strings.every((s) => (LAYER_KINDS as readonly string[]).includes(s));
}

test("only preview-layers.ts may hold an ordering of layer kinds (D121)", () => {
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(kitDir, file), "utf-8");
    for (const match of source.matchAll(ARRAY_LITERAL)) {
      if (secondOrdering(match[1])) violations.push(file);
    }
  }
  expect(violations, "a second hardcoded ordering of layer kinds — read from PREVIEW_LAYER_ORDER instead")
    .toEqual([]);
});
