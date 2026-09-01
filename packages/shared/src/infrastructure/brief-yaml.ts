import { stringify } from "yaml";

/**
 * The canonical brief YAML writer, shared by the API (which persists it) and the
 * web editor tests (which assert round-trip determinism against it). Exactly one
 * implementation exists — a fork of this under `apps/web` was deleted (R4.3) —
 * and it is pinned to the `yaml` package's default schema (YAML 1.2), the same
 * schema the loader parses with. A writer and a parser on different schemas is
 * the real hazard: `dumpBrief` emits what `parse` reads back unchanged.
 */

/** The brief's canonical top-level key order (the sample-campaign order), then any remaining keys. */
export const BRIEF_KEY_ORDER = [
  "id",
  "targetRegion",
  "targetAudience",
  "campaignMessage",
  "localizedMessage",
  "products",
  "treatments",
  "mode",
  "variation",
  "output",
] as const;

/**
 * Serialize a brief with the canonical key order, then any remaining keys.
 *
 * `lineWidth: 0` disables folding so long messages stay on one line,
 * `aliasDuplicateObjects: false` is the `yaml`-package equivalent of js-yaml's
 * `noRefs`: a brief never grows anchors just because two fields reference the
 * same object, and `flowCollectionPadding: false` keeps flow collections in the
 * unpadded form js-yaml wrote (`[static, motion]`, not `[ static, motion ]`).
 * Keys whose value is `undefined` are omitted, matching the previous js-yaml
 * dump byte for byte on the briefs this project writes.
 */
export function dumpBrief(brief: object): string {
  const source = brief as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of BRIEF_KEY_ORDER) {
    const value = source[key];
    if (value !== undefined) ordered[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (!(key in ordered) && source[key] !== undefined) ordered[key] = source[key];
  }
  return stringify(ordered, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
    flowCollectionPadding: false,
  });
}
