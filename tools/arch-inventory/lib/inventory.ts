import { join } from "node:path";
import { canonicalEntry, entryForFile, fileForEntry, resolveTemplate } from "./naming.js";
import type { ContextDecl, Finding, ListKey, Manifest, StubKind } from "./types.js";

/** The workspaces prefix `packages/*` the manifest declares for contexts. */
export const PACKAGE_ROOT = "packages";

/** Test fixture shape: a virtual directory tree keyed by dir path. */
export interface Tree {
  [dir: string]: readonly string[];
}

export interface InventoryDeps {
  /** File names directly inside `dir`; rejects with ENOENT when it is absent. */
  readonly listDir: (dir: string) => Promise<readonly string[]>;
}

interface ListSpec {
  readonly key: ListKey;
  readonly kind: StubKind;
  readonly layer: "domain" | "application" | "infrastructure";
  readonly sub: string;
}

/**
 * The seven inventory lists, each mapped to the folder its modules live in —
 * `domain_services` at `domain/services`, the generator's own emission site.
 * These `sub` folders are hexagen's own hard-coded emission sites
 * (`buildEmissionPlan` in `dist/index.js`: `dir("domain/entities")`,
 * `dir("domain/value-objects")`, `dir("domain/services")`,
 * `dir("application/use-cases")`, `dir("application/ports/in")`,
 * `dir("application/ports/out")`, `dir("infrastructure/adapters")`) —
 * verified NOT to come from the manifest's `generator.sync.layers.*.subfolders`
 * lists, which `ensureLayerFolders` reads only to scaffold empty placeholder
 * directories, never to place a named stub. Only the layer's own `folder`
 * (`src/domain`, …) is manifest-configurable; this tool already reads that
 * from `manifest.folders`.
 *
 * The naming rule this comparison applies is stated in `naming.ts`: one
 * entry per module file (not per export), named after the file; a file the
 * generator could never emit (kebab-case stem, wrong suffix, a barrel or a
 * test) is a helper module, not inventory, and is never drift.
 */
export const LISTS: readonly ListSpec[] = [
  { key: "entities", kind: "entity", layer: "domain", sub: "entities" },
  { key: "value_objects", kind: "valueObject", layer: "domain", sub: "value-objects" },
  { key: "domain_services", kind: "domainService", layer: "domain", sub: "services" },
  { key: "use_cases", kind: "useCase", layer: "application", sub: "use-cases" },
  { key: "ports.in", kind: "inPort", layer: "application", sub: "ports/in" },
  { key: "ports.out", kind: "outPort", layer: "application", sub: "ports/out" },
  { key: "adapters", kind: "adapter", layer: "infrastructure", sub: "adapters" },
];

async function moduleFiles(dir: string, deps: InventoryDeps): Promise<readonly string[]> {
  try {
    return await deps.listDir(dir);
  } catch (error: unknown) {
    /* A context that has no folder for a list declares nothing there either;
       anything else (EACCES, EIO) is a real failure and must not look clean.
       `listDir` rejects with Error subclasses carrying `code`, so reading the
       property off the cast is the whole check — a non-Error rejection has no
       code and propagates like any other failure. */
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Declared entries that collide once resolved: a literal repeat, or two
 *  distinct names the naming template resolves to the same file. Reports the
 *  raw declared names (not the resolved file) that share a target. */
function findDuplicates(declared: readonly string[], template: string, scope: string): readonly string[] {
  const firstFor = new Map<string, string>();
  const dupes = new Set<string>();
  for (const entry of declared) {
    const file = fileForEntry(entry, template, scope);
    const first = firstFor.get(file);
    if (first !== undefined) {
      dupes.add(first);
      dupes.add(entry);
    } else {
      firstFor.set(file, entry);
    }
  }
  return [...dupes].sort();
}

async function checkList(
  context: ContextDecl,
  spec: ListSpec,
  manifest: Manifest,
  deps: InventoryDeps,
): Promise<Finding | undefined> {
  const template = context.naming[spec.kind];
  const dir = join(PACKAGE_ROOT, context.name, manifest.folders[spec.layer], spec.sub);
  // A naming template may itself contain a directory component (e.g. a
  // `{scope}` prefix) — the file this check compares lives at that offset
  // from `dir`, not directly inside it, and is reported as the full relative
  // path (`dirPrefix` re-attached below), never a bare basename.
  const { dirPrefix } = resolveTemplate(template, manifest.scope);
  // `dirPrefix` ends in "/" (it is re-attached to filenames below to form a
  // full relative path); `path.join` would otherwise preserve that trailing
  // slash on the directory it hands to `listDir`.
  const effectiveDir = dirPrefix.length > 0 ? join(dir, dirPrefix.slice(0, -1)) : dir;
  const rawFiles = await moduleFiles(effectiveDir, deps);
  const files = rawFiles.map((file) => dirPrefix + file);
  const declared = context.lists[spec.key];
  const present = new Set(files);
  // Compare by canonical form, not raw string equality: a kebab-case
  // declaration (`user-repo`) and its PascalCase file (`UserRepo.ts`) must
  // agree, the same way hexagen's own generator would treat them.
  const declaredCanonical = new Set(declared.map((entry) => canonicalEntry(entry, template, manifest.scope)));
  const missing = files
    .map((file) => entryForFile(file, template, manifest.scope))
    .filter((entry): entry is string => entry !== undefined && !declaredCanonical.has(entry))
    .sort();
  const stale = declared.filter((entry) => !present.has(fileForEntry(entry, template, manifest.scope))).sort();
  const duplicates = findDuplicates(declared, template, manifest.scope);
  if (missing.length === 0 && stale.length === 0 && duplicates.length === 0) return undefined;
  return { context: context.name, list: spec.key, missing, stale, duplicates };
}

/** Every (context x list) pair where the manifest and the tree disagree, or
 *  the manifest disagrees with itself (duplicates). */
export async function checkInventory(
  manifest: Manifest,
  deps: InventoryDeps,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const context of manifest.contexts) {
    for (const spec of LISTS) {
      const finding = await checkList(context, spec, manifest, deps);
      if (finding !== undefined) findings.push(finding);
    }
  }
  return findings;
}

function describeSide(finding: readonly string[], side: string): string | undefined {
  return finding.length === 0 ? undefined : `${side} ${finding.length}: ${finding.join(", ")}`;
}

/**
 * Human-readable report: one line per drifted (context x list), then the
 * summary. The counts on the summary line are what the gate reads.
 */
export function formatReport(findings: readonly Finding[], contextCount: number): string {
  const checked = `${contextCount} context(s) x ${LISTS.length} list(s)`;
  if (findings.length === 0) {
    return `manifest inventory is current: no drift across ${checked}.`;
  }
  const lines = findings.map((finding) => {
    const sides = [
      describeSide(finding.missing, "missing"),
      describeSide(finding.stale, "stale"),
      describeSide(finding.duplicates, "duplicate"),
    ]
      .filter((line): line is string => line !== undefined)
      .join("; ");
    return `${finding.context} ${finding.list}: ${sides}`;
  });
  const missing = findings.reduce((sum, f) => sum + f.missing.length, 0);
  const stale = findings.reduce((sum, f) => sum + f.stale.length, 0);
  const duplicates = findings.reduce((sum, f) => sum + f.duplicates.length, 0);
  lines.push(`summary: ${missing} missing, ${stale} stale, ${duplicates} duplicate across ${checked}.`);
  return lines.join("\n");
}
