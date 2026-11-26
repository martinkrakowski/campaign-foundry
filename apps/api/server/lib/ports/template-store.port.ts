import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";

/**
 * How many DISTINCT template ids one org may hold (its own rows only — the
 * canonical library is ownerless and in memory, so it never counts), and how
 * many versions one template id may accumulate. Both are provisional caps:
 * revisit them before they bind a real org.
 */
export const MAX_TEMPLATES_PER_ORG = 50;
export const MAX_VERSIONS_PER_TEMPLATE = 20;

/** The largest page `listTemplatesPage` will serve when a `limit` is given. */
export const MAX_TEMPLATES_PAGE_SIZE = 100;

/**
 * The per-org/per-template caps are a write admission rule, not a data
 * problem: the template itself is valid, the library is just full. Mapped to
 * HTTP 422 by `respondTemplateWriteError` (lib/template-write.ts).
 */
export class TemplateLimitExceededError extends Error {
  constructor(message = "Template limit exceeded for this organization.") {
    super(message);
    this.name = "TemplateLimitExceededError";
  }
}

/** A `cursor` that does not decode to a `{ id, version }` position. */
export class InvalidTemplateCursorError extends Error {
  constructor(message = "Invalid template cursor.") {
    super(message);
    this.name = "InvalidTemplateCursorError";
  }
}

/** Optional page shape for `listTemplatesPage`. */
export interface TemplateListOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/** One page of the library, plus how many malformed rows were skipped. */
export interface TemplateListPage {
  readonly templates: readonly CreativeTemplate[];
  readonly skipped: number;
  readonly nextCursor?: string;
}

/**
 * Port for reading the creative template library (D123).
 *
 * Templates are library entities: ownerless, versioned, immutable per version.
 * A new version is a new record; an old version is never edited. This port is
 * read-only by construction — the library is maintained out of band, and no
 * write method exists to violate that.
 */
export interface TemplateStorePort {
  /**
   * List all templates in the library, one record per version.
   */
  listTemplates(): Promise<readonly CreativeTemplate[]>;

  /**
   * Find a template by its domain identifier (`template.id`) and version.
   * Without a version, the highest version present is returned.
   * With a version, an exact match is required: an unknown version is
   * undefined, never a fallback to a different version than the one pinned.
   */
  findTemplate(id: string, version?: number): Promise<CreativeTemplate | undefined>;

  /**
   * True if a template with the given id (and version, when given) exists.
   */
  exists(id: string, version?: number): Promise<boolean>;
}

/**
 * The template store when writes exist for it. Canonical templates remain
 * ownerless and never writable (D123): a store that answers this port's read
 * methods from the canonical library alone is still a `TemplateStorePort`,
 * and `asWritableTemplateStore` (lib/ports/index.ts) wraps any such store in
 * a `saveTemplate` that throws `TemplateWriteUnsupportedError`.
 */
export interface WritableTemplateStorePort extends TemplateStorePort {
  /**
   * Create a new (org, id, version) template row. A version is never
   * overwritten: a duplicate (id, version) throws `TemplateVersionExistsError`,
   * a colliding canonical id throws `CanonicalTemplateCollisionError`, and a
   * template `templateProblem` refuses throws `InvalidTemplateError`.
   */
  saveTemplate(template: CreativeTemplate, actor: string): Promise<void>;
}

/**
 * Additive pagination over a template store (CFRW22G): a store may serve it
 * natively, and every store that does not is paginated by the route over
 * `listTemplates`. Declared after `WritableTemplateStorePort` so
 * `TemplateStorePort`'s method block stays exactly
 * `["listTemplates", "findTemplate", "exists"]` — its read-only-by-
 * construction shape is asserted by test (fs-template-store.test.ts).
 */
export interface PaginatedTemplateStorePort extends TemplateStorePort {
  /**
   * One page of the library in `byIdThenVersion` order. Without a `limit`,
   * every template is returned (bounded by the per-org caps) and
   * `nextCursor` is undefined; with one, the page carries the cursor of the
   * next page while more templates remain. `skipped` counts malformed stored
   * rows the read refused to serve — a number, never their content.
   */
  listTemplatesPage(options?: TemplateListOptions): Promise<TemplateListPage>;
}

/** id asc, then version asc — the ordering the merged read is served in. */
export function byIdThenVersion(
  a: { readonly id: string; readonly version: number },
  b: { readonly id: string; readonly version: number },
): number {
  return a.id.localeCompare(b.id) || a.version - b.version;
}

/**
 * Base64url JSON `{ id, version }` — the position after the last template of
 * the page just served. Only the fields the ordering needs travel; a cursor
 * never carries template content.
 */
export function encodeTemplateCursor(template: {
  readonly id: string;
  readonly version: number;
}): string {
  return Buffer.from(
    JSON.stringify({ id: template.id, version: template.version }),
    "utf8",
  ).toString("base64url");
}

/**
 * Decode a cursor to its `{ id, version }` position, refusing anything that
 * is not exactly that: non-base64url bytes, invalid JSON, a missing or empty
 * `id`, or a `version` that is not a positive safe integer. Throws
 * `InvalidTemplateCursorError` — the caller maps it to its own answer.
 */
export function decodeTemplateCursor(cursor: string): { id: string; version: number } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidTemplateCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidTemplateCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidTemplateCursorError();
  const { id, version } = parsed as { id: unknown; version: unknown };
  if (typeof id !== "string" || id === "") throw new InvalidTemplateCursorError();
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new InvalidTemplateCursorError();
  }
  return { id, version };
}

/**
 * Slice an already-`byIdThenVersion`-sorted list into a page. The cursor (when
 * given) drops everything at or before its `{ id, version }` position; without
 * a `limit`, every remaining template is returned with `nextCursor` undefined.
 * With a `limit`, the page is the first `limit` remaining templates and
 * `nextCursor` is emitted only while more remain — the cursor of the page's
 * LAST template, which the next call re-anchors on. `skipped` is 0 here: only
 * a store that reads stored rows can know which of them it refused.
 */
export function paginateTemplates(
  items: readonly CreativeTemplate[],
  options?: TemplateListOptions,
): TemplateListPage {
  let start = 0;
  if (options?.cursor !== undefined) {
    const { id, version } = decodeTemplateCursor(options.cursor);
    while (start < items.length && byIdThenVersion(items[start]!, { id, version }) <= 0) {
      start += 1;
    }
  }
  const remaining = items.slice(start);
  const { limit } = options ?? {};
  if (limit === undefined) {
    return { templates: remaining, skipped: 0, nextCursor: undefined };
  }
  const templates = remaining.slice(0, limit);
  const last = templates.at(-1);
  return {
    templates,
    skipped: 0,
    nextCursor:
      remaining.length > limit && last !== undefined ? encodeTemplateCursor(last) : undefined,
  };
}
