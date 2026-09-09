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
