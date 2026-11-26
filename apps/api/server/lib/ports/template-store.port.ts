import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";

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
