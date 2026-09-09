import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration";
import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import type { TemplateStorePort } from "./template-store.port.js";

/**
 * Read-only template store seeded from the canonical templates (D123).
 *
 * The seed alone is the whole library today: there is no on-disk template
 * directory, and its absence is not an error and must not warn. Versions are
 * indexed per id so a later record for the same id is a new version, and an
 * unknown version is never served in place of the one pinned.
 */
export class FsTemplateStore implements TemplateStorePort {
  private readonly versionsById: ReadonlyMap<string, readonly CreativeTemplate[]>;

  constructor(seed: readonly CreativeTemplate[] = Object.values(CANONICAL_TEMPLATES)) {
    const versionsById = new Map<string, CreativeTemplate[]>();
    for (const template of seed) {
      const versions = versionsById.get(template.id);
      if (versions) {
        versions.push(template);
      } else {
        versionsById.set(template.id, [template]);
      }
    }
    this.versionsById = versionsById;
  }

  async listTemplates(): Promise<readonly CreativeTemplate[]> {
    return [...this.versionsById.values()].flat();
  }

  async findTemplate(id: string, version?: number): Promise<CreativeTemplate | undefined> {
    const versions = this.versionsById.get(id);
    if (!versions || versions.length === 0) {
      return undefined;
    }
    if (version === undefined) {
      return versions.reduce((highest, template) =>
        template.version > highest.version ? template : highest,
      );
    }
    return versions.find((template) => template.version === version);
  }

  async exists(id: string, version?: number): Promise<boolean> {
    return (await this.findTemplate(id, version)) !== undefined;
  }
}
