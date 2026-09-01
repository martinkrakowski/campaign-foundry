import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import { dumpBrief } from "@campaignfoundry/shared";
import { isAlias, isMap, parseAllDocuments, type Document, type Scalar, type YAMLMap } from "yaml";
import { resolveConfined } from "./confined-path.js";
import { YAML_ALIAS_CAP } from "./load-brief.js";
import { getBriefStore } from "./ports/index.js";

/** The canonical brief YAML writer lives in shared — one serializer, one schema (R4.3). */
export { dumpBrief };

/** Formats the loader understands — listing and id lookup accept these (case-insensitive). */
export const BRIEF_SOURCE_EXTS = [".yaml", ".yml", ".json"] as const;

export const SYMLINK_WRITE_ERROR = "Refusing to write through a symlink.";

/**
 * Fail-closed refusal to rewrite: the existing file is not a single, parseable
 * YAML brief document. The caller must never fall back to a whole-object dump —
 * that is the data-loss path this error exists to close (R4.1).
 */
export class BriefDocumentError extends Error {
  constructor(path: string, reason: string) {
    super(
      `Refusing to rewrite "${path}": ${reason}. ` +
        "A save never falls back to a whole-object dump, which would destroy the file's comments and formatting.",
    );
    this.name = "BriefDocumentError";
    (this as { code?: string }).code = "EBRIEFDOC";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  }
  return false;
}

/**
 * Merge keys need no special handling on either side of the diff: `parse` and
 * `Document.toJS` both apply a real `<<: *alias` merge (the merged-in fields
 * appear as plain keys and `<<` disappears), so an unchanged merge compares
 * equal and round-trips byte for byte, a changed merged-in field is written as
 * an explicit override — the correct YAML move — and a merged-in key missing
 * from the new brief finds nothing to delete, so the anchor survives untouched.
 */

/**
 * Walk the document along `path` and refuse if any node the write would land on
 * (or pass through) is a YAML alias: `setIn` through an alias writes into the
 * anchored map, silently changing every other usage of that anchor.
 */
function assertNoAliasAtPath(doc: Document, filePath: string, path: string[]): void {
  // patchNode only ever descends into mappings (both sides of the diff must be
  // plain objects), so every node a walked path passes through is a YAMLMap.
  let node = doc.contents as YAMLMap;
  for (const key of path) {
    // Brief keys are plain scalars; String() covers the degenerate null key.
    const pair = node.items.find((p) => String((p.key as Scalar).value) === key);
    if (!pair) return; // missing node — setIn creates it fresh, no alias in the way
    if (isAlias(pair.value)) {
      throw new BriefDocumentError(
        filePath,
        `"${path.join(".")}" is a YAML alias — writing through it would change the anchored map everywhere it is used`,
      );
    }
    node = pair.value as YAMLMap;
  }
}

function patchNode(doc: Document, filePath: string, oldValue: unknown, newValue: unknown, path: string[]): void {
  if (deepEqual(oldValue, newValue)) return;
  if (isPlainObject(oldValue) && isPlainObject(newValue)) {
    for (const key of Object.keys(newValue)) {
      patchNode(doc, filePath, oldValue[key], newValue[key], [...path, key]);
    }
    for (const key of Object.keys(oldValue)) {
      if (!(key in newValue)) doc.deleteIn([...path, key]);
    }
    return;
  }
  assertNoAliasAtPath(doc, filePath, path);
  // A JSON round trip strips shared references (they would serialize as new
  // anchors) and `undefined` holes the writer cannot represent.
  doc.setIn(path, JSON.parse(JSON.stringify(newValue)));
}

/**
 * Non-destructive brief write: parse the existing bytes as a YAML Document
 * (fail closed if it is not exactly one parseable mapping), patch the paths
 * that actually changed, and re-emit — comments, blank lines, key order and
 * quoting of untouched nodes survive byte for byte (R4.1).
 *
 * The parser is the `yaml` package at its default schema, YAML 1.2 — the same
 * schema `load-brief.ts` parses and `dumpBrief` writes with — with alias
 * expansion capped at `YAML_ALIAS_CAP`.
 *
 * Returns the full file text (BOM and CRLF endings preserved where the source
 * used them; `toString` itself always emits LF).
 */
export function patchBriefYaml(filePath: string, raw: string, brief: object): string {
  // A UTF-8 BOM is legal at the head of a YAML stream but `toString` does not
  // re-emit one — strip it for parsing and re-attach it on output.
  const bom = raw.startsWith("\uFEFF");
  const docs = parseAllDocuments(bom ? raw.slice(1) : raw);
  if (docs.length === 0) throw new BriefDocumentError(filePath, "the file contains no YAML document");
  if (docs.length > 1) throw new BriefDocumentError(filePath, "the file contains more than one YAML document");
  const doc = docs[0];
  if (doc.errors.length > 0) {
    throw new BriefDocumentError(filePath, `the file does not parse as YAML (${doc.errors[0].message})`);
  }
  if (!isMap(doc.contents)) {
    throw new BriefDocumentError(filePath, "the file's top-level YAML node is not a mapping");
  }
  const target = JSON.parse(JSON.stringify(brief)) as Record<string, unknown>;
  patchNode(doc, filePath, doc.toJS({ maxAliasCount: YAML_ALIAS_CAP }), target, []);
  let out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (raw.includes("\r\n")) out = out.replace(/\r?\n/g, "\r\n");
  return (bom ? "\uFEFF" : "") + out;
}

/**
 * Dispatch on the file extension (R4.2). The `.json` branch is a named carve-out,
 * not an accident of control flow: a JSON brief must stay JSON — a YAML Document
 * patch applied to it would write YAML into a `.json` file and hide the brief on
 * the next load. It is therefore never Document-patched and never fail-closed for
 * "not a YAML Document"; the canonical YAML dump applies only to `.yaml`/`.yml`.
 */
export function serializeBrief(path: string, brief: CampaignBrief): string {
  return extname(path).toLowerCase() === ".json" ? JSON.stringify(brief, null, 2) : dumpBrief(brief);
}

export function briefsDir(): string {
  return resolve(projectRoot(), "briefs");
}

/** Confined path for the canonical create target `briefs/<id>.yaml`. */
export function briefYamlPath(id: string): string {
  return resolveConfined(briefsDir(), `${id}.yaml`);
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function isExistsError(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

export function isBriefSourceName(name: string): boolean {
  const lower = name.toLowerCase();
  return BRIEF_SOURCE_EXTS.some((ext) => lower.endsWith(ext));
}

/** Compute SHA-256 hex digest of raw bytes. */
export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compute SHA-256 hex digest of a file's raw bytes. */
export async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return hashBytes(bytes);
}

/** True if anything (file, dir, symlink) exists at `path`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * First regular file at `briefs/<id>.<ext>` for `exts`, in order.
 * Missing / non-file entries are skipped; an empty result means 404.
 */
export async function findBriefFile(
  id: string,
  exts: readonly string[] = BRIEF_SOURCE_EXTS,
): Promise<string | undefined> {
  const file = await getBriefStore().findBriefFile(id, exts);
  return file ? resolve(briefsDir(), file) : undefined;
}

/**
 * Regular briefs/ source whose parsed `brief.id` equals `id`.
 * Filename may differ from the id (e.g. `sample-campaign.yaml` / `summer-hydration-2026`).
 * Unparseable files and non-files are skipped, matching GET /campaigns/briefs.
 */
export async function findBriefById(
  id: string,
): Promise<{ path: string; brief: CampaignBrief } | undefined> {
  const found = await getBriefStore().findBriefById(id);
  if (!found) return undefined;
  return { path: resolve(briefsDir(), found.file), brief: found.brief };
}

export async function findBriefFileById(id: string): Promise<string | undefined> {
  const file = await getBriefStore().findBriefFileById(id);
  return file ? resolve(briefsDir(), file) : undefined;
}

/** Exclusive create — fails with EEXIST if anything is already at `path`. */
export async function createBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().createBrief(brief);
}

/** Overwrite an existing regular file in its own format; refuse a symlink. */
export async function rewriteBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().rewriteBrief(brief);
}

/**
 * Replace an existing file at `path`, or create it if missing.
 * Used by POST `?replace=1`. Symlinks are refused; a racing create is EEXIST.
 */
export async function replaceBriefFile(path: string, brief: CampaignBrief): Promise<void> {
  await getBriefStore().replaceBrief(brief);
}

/**
 * Serialise revision-check→write sections per brief id within this process, so a
 * conditional write cannot be overtaken between its hash comparison and its write.
 * Errors in `fn` do not poison the chain.
 */
export function withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
  return getBriefStore().withBriefLock(briefId, fn);
}
