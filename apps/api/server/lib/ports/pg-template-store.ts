import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
  templateProblem,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../db/sql-client.js";
import type { WritableTemplateStorePort } from "./template-store.port.js";

/** `error.code`, when `error` has one (pg and PGlite both attach the SQLSTATE as a string). */
function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" ? code : code === undefined ? undefined : String(code);
}

interface TemplateRow {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly unit: string;
  readonly creative_type: string;
  readonly layers: unknown;
}

function toTemplate(row: TemplateRow): CreativeTemplate {
  const template: CreativeTemplate = {
    id: row.id,
    version: row.version,
    name: row.name,
    unit: row.unit as CreativeTemplate["unit"],
    creativeType: row.creative_type as CreativeTemplate["creativeType"],
    layers: row.layers as CreativeTemplate["layers"],
  };
  const problem = templateProblem(template);
  if (problem !== undefined) throw new InvalidTemplateError(problem);
  return template;
}

/**
 * Org-scoped templates as rows (RW-22, D123), one org's: the store is built
 * for an org, so every statement is scoped to it and another org's templates
 * are invisible — the same shape as `PgDraftStore` / `PgProviderKeyStore`.
 *
 * The canonical library stays ownerless and in memory (`CANONICAL_TEMPLATES`,
 * M3): every read merges it under the org's own rows, so a canonical id
 * always resolves from the seed and an org row can never shadow it (writes
 * refuse canonical ids outright). A stored row is a new (org_id, id, version)
 * record — an existing version is never overwritten, and the primary key is
 * the backstop if two writers race.
 */
export class PgTemplateStore implements WritableTemplateStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async listTemplates(): Promise<readonly CreativeTemplate[]> {
    const { rows } = await this.db.query<TemplateRow>(
      `select id, version, name, unit, creative_type, layers
         from template
        where org_id = $1
        order by id, version`,
      [this.orgId],
    );
    return [...Object.values(CANONICAL_TEMPLATES), ...rows.map(toTemplate)];
  }

  async findTemplate(id: string, version?: number): Promise<CreativeTemplate | undefined> {
    // Canonical first: an org row cannot exist for a canonical id (writes
    // refuse one), so this ordering is a guarantee, not a tie-break.
    const canonical = Object.values(CANONICAL_TEMPLATES).find((t) => t.id === id);
    if (canonical !== undefined) {
      if (version === undefined || canonical.version === version) return canonical;
      return undefined;
    }
    const { rows } = await this.db.query<TemplateRow>(
      `select id, version, name, unit, creative_type, layers
         from template
        where org_id = $1 and id = $2
          ${version === undefined ? "order by version desc limit 1" : "and version = $3"}`,
      version === undefined ? [this.orgId, id] : [this.orgId, id, version],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return toTemplate(row);
  }

  async exists(id: string, version?: number): Promise<boolean> {
    return (await this.findTemplate(id, version)) !== undefined;
  }

  async saveTemplate(template: CreativeTemplate, actor: string): Promise<void> {
    const problem = templateProblem(template);
    if (problem !== undefined) throw new InvalidTemplateError(problem);
    if (Object.values(CANONICAL_TEMPLATES).some((t) => t.id === template.id)) {
      throw new CanonicalTemplateCollisionError(
        `template id "${template.id}" collides with a canonical template id`,
      );
    }
    try {
      await this.db.query(
        `insert into template
           (org_id, id, version, name, unit, creative_type, layers, created_by)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          this.orgId,
          template.id,
          template.version,
          template.name,
          template.unit,
          template.creativeType,
          JSON.stringify(template.layers),
          actor,
        ],
      );
    } catch (error) {
      // Two writers saving the same (org, id, version) race the primary key;
      // the loser sees a constraint violation, not a reason to 500 — the
      // first row remains byte-identical, never overwritten.
      if (pgErrorCode(error) === "23505") throw new TemplateVersionExistsError();
      throw error;
    }
  }
}
