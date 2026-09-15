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
 * These mirror `name-normalizer.ts` / `stubs.ts` in @hexagen-monaco/sync.
 */

import type { StubKind } from "./types.js";

export class NamingError extends Error {}

/** Hexagen's built-in defaults (`DEFAULT_NAMING` in the sync bundle). */
export const DEFAULT_NAMING: Readonly<Record<StubKind, string>> = {
  entity: "{name}.ts",
  valueObject: "{name}.vo.ts",
  domainService: "{name}.service.ts",
  useCase: "{name}.use-case.ts",
  inPort: "{name}.in-port.ts",
  outPort: "{name}.out-port.ts",
  adapter: "{name}.adapter.ts",
};

const PLACEHOLDER = "{name}";
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

/** The filename the generator would emit for `entry` under `template`. */
export function fileForEntry(entry: string, template: string): string {
  const { prefix, suffix } = splitTemplate(template);
  const base = entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : entry;
  return `${prefix}${toPascalCase(base)}${suffix}`;
}

/**
 * The inventory entry a file represents, or `undefined` when the file is
 * not a manifest module (wrong shape for the folder's template, a non-
 * Pascal stem such as a kebab-case data module or a lowercase barrel, or a
 * test/declaration file).
 */
export function entryForFile(file: string, template: string): string | undefined {
  if (file.endsWith(".d.ts") || file.endsWith(".test.ts") || file.endsWith(".spec.ts")) {
    return undefined;
  }
  const { prefix, suffix } = splitTemplate(template);
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return undefined;
  const stem = file.slice(prefix.length, file.length - suffix.length);
  return PASCAL.test(stem) ? stem : undefined;
}
