/**
 * Stub-naming: how the hexagen generator turns a manifest entry into a
 * module filename, and back.
 *
 * The rule for naming a module that exports several things (the convention
 * this check and the manifest inventories both follow):
 *
 *   One inventory entry per module FILE, not per export. The entry name is
 *   the file's stem with the folder's generator suffix removed (`.vo`,
 *   `.use-case`, …) — so `GenerateCampaignUseCase.use-case.ts` is the single
 *   entry `GenerateCampaignUseCase` however many symbols it exports, and a
 *   data module with several exports is named after its file, never after
 *   one of its exports.
 *
 *   A file is inventoried only if its stem is a PascalCase identifier that
 *   the generator could itself have emitted: `toPascalCase(entry) + suffix`
 *   must reproduce the filename exactly. Kebab-case files
 *   (`advertising-units.ts`) can never be manifest entries — the generator
 *   PascalCases every entry name when it derives a filename — so they are
 *   helper/data modules outside the inventory, not drift.
 *
 * `toPascalCase` below is a byte-for-byte mirror of
 * `src/domain/services/name-normalizer.ts`'s `toPascalCase`/
 * `toPascalCaseIdentifier` in `@hexagen-monaco/sync` (verified against
 * `dist/index.js`): the generator's own `normalizeStubName` strips a
 * template's suffix the same way before Pascal-casing what remains.
 *
 * A naming template may reference `{scope}` in addition to `{name}` — the
 * generator's `generateStubs`/`interpolateWithLog` (`dist/index.js`)
 * interpolates both — and may contain a directory component before the
 * filename (the interpolated string is joined onto the module directory
 * with `path.join`, which accepts one). This module resolves `{scope}`
 * first, then splits what remains into a directory prefix and a
 * `{name}`-templated leaf, so the file this check compares is the full
 * relative path, not a basename.
 */

import { DEFAULT_NAMING as HEXAGEN_DEFAULT_NAMING, sanitizeScope } from "@hexagen-monaco/sync";
import type { Manifest as HexManifest } from "@hexagen-monaco/sync";
import type { StubKind } from "./types.js";

export class NamingError extends Error {}

/** Hexagen's own built-in defaults, re-exported under our local `StubKind` —
 *  the assignment below is the compile-time guarantee that the two key sets
 *  still agree; a hexagen release that adds or drops a stub kind fails this
 *  file to build instead of silently comparing the wrong kind. */
export const DEFAULT_NAMING: Readonly<Record<StubKind, string>> = HEXAGEN_DEFAULT_NAMING;

/**
 * The project's npm scope, for a `{scope}` naming template.
 *
 * Mirrors `resolveScope` (`src/types/manifest/helpers.ts` in
 * `@hexagen-monaco/sync`): that function is declared in the package's type
 * declarations but is NOT part of its runtime export list (`dist/index.js`'s
 * `export { … }` names `sanitizeScope` but not `resolveScope` — importing it
 * would fail at run time), so this reimplements its precedence
 * (`manifest.scope` -> `manifest.system` -> `"generated-project"`) on top of
 * the one primitive hexagen does export.
 */
export function resolveScope(manifest: Pick<HexManifest, "scope" | "system">): string {
  const raw =
    typeof manifest.scope === "string" && manifest.scope.length > 0
      ? manifest.scope
      : typeof manifest.system === "string" && manifest.system.length > 0
        ? manifest.system
        : "generated-project";
  return sanitizeScope(raw);
}

const PLACEHOLDER = "{name}";
const SCOPE_TOKEN = "{scope}";
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

/** Split a naming template into its literal prefix and suffix. */
export function splitTemplate(template: string): { prefix: string; suffix: string } {
  const at = template.indexOf(PLACEHOLDER);
  if (at === -1) {
    throw new NamingError(`stub naming template "${template}" must contain {name}`);
  }
  if (template.indexOf(PLACEHOLDER, at + 1) !== -1) {
    throw new NamingError(`stub naming template "${template}" must contain {name} exactly once`);
  }
  return { prefix: template.slice(0, at), suffix: template.slice(at + PLACEHOLDER.length) };
}

/** Same normalization the generator applies before interpolating a filename. */
export function toPascalCase(stem: string): string {
  const pascal = stem
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  if (pascal.length === 0) return "Stub";
  return /^[0-9]/.test(pascal) ? `Stub${pascal}` : pascal;
}

export interface ResolvedTemplate {
  /** Empty, or a directory prefix ending in "/". */
  readonly dirPrefix: string;
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Resolve `{scope}` to a literal (scope never varies per entry, so this is a
 * plain substring replacement — equivalent to hexagen's generic `{token}`
 * interpolator for this one variable), then split what remains into a
 * directory prefix and the `{name}`-templated leaf. Exported so a caller that
 * needs to know WHERE a naming template's files live (`inventory.ts`, to
 * list the right directory) does not have to reimplement this split.
 */
export function resolveTemplate(template: string, scope: string): ResolvedTemplate {
  const withScope = template.split(SCOPE_TOKEN).join(scope);
  const slash = withScope.lastIndexOf("/");
  const dirPrefix = slash === -1 ? "" : withScope.slice(0, slash + 1);
  const leaf = slash === -1 ? withScope : withScope.slice(slash + 1);
  const { prefix, suffix } = splitTemplate(leaf);
  return { dirPrefix, prefix, suffix };
}

/**
 * The canonical (Pascal, suffix-stripped) form of a declared entry, under
 * `template` — mirrors hexagen's own `normalizeStubName`
 * (`src/generators/stubs.ts`, `dist/index.js`): strip the template's suffix
 * from the raw name if it already carries one, then Pascal-case what
 * remains. hexagen never strips a *prefix* this way (`normalizeStubName`
 * only ever looks at the text after `{name}`), so neither does this.
 *
 * Comparing entries by this canonical form — not by string equality with the
 * raw declared name — is what lets a kebab-case declaration (`user-repo`)
 * and its PascalCase file (`UserRepo.ts`) agree, the same way hexagen's own
 * generator would treat them as the same stub.
 */
export function canonicalEntry(entry: string, template: string, scope: string): string {
  const { suffix } = resolveTemplate(template, scope);
  // A template whose suffix is empty (e.g. a bare "{name}") must not strip
  // anything: `entry.endsWith("")` is trivially true, and slicing off a
  // zero-length suffix must never touch `entry` (a naive `entry.slice(0,
  // -suffix.length)` degenerates to `slice(0, -0)`, i.e. `slice(0, 0)`, which
  // would empty every entry into the "Stub" fallback below).
  const base =
    suffix.length > 0 && entry.endsWith(suffix)
      ? entry.slice(0, entry.length - suffix.length)
      : entry;
  return toPascalCase(base);
}

/** The relative path (directory prefix included) the generator would emit for
 *  `entry` under `template`, resolving `{scope}` from the manifest first. */
export function fileForEntry(entry: string, template: string, scope: string): string {
  const { dirPrefix, prefix, suffix } = resolveTemplate(template, scope);
  return `${dirPrefix}${prefix}${canonicalEntry(entry, template, scope)}${suffix}`;
}

/**
 * The inventory entry a (directory-prefix-included) relative path represents,
 * or `undefined` when it is not a manifest module for this template — wrong
 * directory, wrong shape for the leaf template, a non-Pascal stem such as a
 * kebab-case data module or a lowercase barrel, or a test/declaration file.
 */
export function entryForFile(file: string, template: string, scope: string): string | undefined {
  if (file.endsWith(".d.ts") || file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
    return undefined;
  }
  const { dirPrefix, prefix, suffix } = resolveTemplate(template, scope);
  if (dirPrefix.length > 0 && !file.startsWith(dirPrefix)) return undefined;
  const leaf = dirPrefix.length > 0 ? file.slice(dirPrefix.length) : file;
  if (!leaf.startsWith(prefix) || !leaf.endsWith(suffix)) return undefined;
  const stem = leaf.slice(prefix.length, leaf.length - suffix.length);
  return PASCAL.test(stem) ? stem : undefined;
}
