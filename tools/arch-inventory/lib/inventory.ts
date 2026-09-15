import { DEFAULT_NAMING, entryForFile, fileForEntry } from "./naming.js";
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

async function checkList(
  context: ContextDecl,
  spec: ListSpec,
  manifest: Manifest,
  deps: InventoryDeps,
): Promise<Finding | undefined> {
  const dir = [PACKAGE_ROOT, context.name, manifest.folders[spec.layer], spec.sub].join("/");
  const files = await moduleFiles(dir, deps);
  const template = manifest.naming[spec.kind] ?? DEFAULT_NAMING[spec.kind];
  const declared = context.lists[spec.key];
  const present = new Set(files);
  const missing = files
    .map((file) => entryForFile(file, template))
    .filter((entry): entry is string => entry !== undefined && !declared.includes(entry))
    .sort();
  const stale = declared
    .filter((entry) => !present.has(fileForEntry(entry, template)))
    .sort();
  if (missing.length === 0 && stale.length === 0) return undefined;
  return { context: context.name, list: spec.key, missing, stale };
}

/** Every (context x list) pair where the manifest and the tree disagree. */
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
    const sides = [describeSide(finding.missing, "missing"), describeSide(finding.stale, "stale")]
      .filter((line): line is string => line !== undefined)
      .join("; ");
    return `${finding.context} ${finding.list}: ${sides}`;
  });
  const missing = findings.reduce((sum, f) => sum + f.missing.length, 0);
  const stale = findings.reduce((sum, f) => sum + f.stale.length, 0);
  lines.push(`summary: ${missing} missing, ${stale} stale across ${checked}.`);
  return lines.join("\n");
}
