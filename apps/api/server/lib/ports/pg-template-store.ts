import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
  templateProblem,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import {
  MAX_TEMPLATES_PER_ORG,
  MAX_VERSIONS_PER_TEMPLATE,
  TemplateLimitExceededError,
  byIdThenVersion,
  paginateTemplates,
  type PaginatedTemplateStorePort,
  type TemplateListOptions,
  type TemplateListPage,
  type WritableTemplateStorePort,
} from "./template-store.port.js";

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

/** A fresh copy of a canonical template, so callers can never mutate the shared library. */
function cloneCanonical(id: string): CreativeTemplate | undefined {
  const canonical = Object.values(CANONICAL_TEMPLATES).find((t) => t.id === id);
  return canonical === undefined ? undefined : structuredClone(canonical);
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
export class PgTemplateStore implements WritableTemplateStorePort, PaginatedTemplateStorePort {
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
  ) {}

  async listTemplates(): Promise<readonly CreativeTemplate[]> {
    return (await this.listTemplatesPage()).templates;
  }

  async listTemplatesPage(options?: TemplateListOptions): Promise<TemplateListPage> {
    const { rows } = await this.db.query<TemplateRow>(
      `select id, version, name, unit, creative_type, layers
         from template
        where org_id = $1
        order by id, version`,
      [this.orgId],
    );
    let skipped = 0;
    const orgRows: CreativeTemplate[] = [];
    for (const row of rows) {
      try {
        orgRows.push(toTemplate(row));
      } catch (error) {
        // A malformed persisted row is skipped and COUNTED, never served and
        // never echoed: `skipped` is a number, and the error a bad row raises
        // here carries only the validator's problem. `findTemplate` and
        // `exists` still throw — a pinned id must fail loudly, not vanish
        // from a page.
        if (!(error instanceof InvalidTemplateError)) throw error;
        skipped += 1;
      }
    }
    const merged = [...Object.values(CANONICAL_TEMPLATES), ...orgRows]
      .map((t) => cloneCanonical(t.id) ?? t)
      .sort(byIdThenVersion);
    const page = paginateTemplates(merged, options);
    return { ...page, skipped };
  }

  async findTemplate(id: string, version?: number): Promise<CreativeTemplate | undefined> {
    // Canonical first: an org row cannot exist for a canonical id (writes
    // refuse one), so this ordering is a guarantee, not a tie-break.
    const canonical = cloneCanonical(id);
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
      // The caps are enforced by the INSERT itself, in ONE statement, and the
      // statement runs inside an advisory-locked transaction (the same shape
      // as `PgJobStore.lockOrg`): `pg_advisory_xact_lock` keyed on the org
      // AND template id serializes concurrent writers to the SAME template,
      // so the writer that queues second recounts on its own statement
      // snapshot — taken after the incumbent committed — and refuses instead
      // of overshooting `MAX_VERSIONS_PER_TEMPLATE` by one. Without the lock
      // two concurrent saves of DIFFERENT versions of the same id at
      // `cap - 1` both observe `cap - 1` (neither conflicts on the primary
      // key, so neither is saved by it) and both admit. The lock is scoped
      // per (org, id): writes to different templates never queue behind each
      // other, and `hashtext` collisions only over-serialize. The lock is
      // transaction-scoped, released at commit or rollback, so a save that
      // throws never leaves it held. The overshoot that remains under READ
      // COMMITTED is bounded by concurrent writers to DIFFERENT ids at the
      // distinct-id boundary. A client without `transaction` (a minimal test
      // double) falls back to the bare statement: the caps are still
      // enforced, only the same-id serialization is lost.
      const insert = async (q: SqlQuery): Promise<void> => {
        const { rows } = await q.query(
          `insert into template
             (org_id, id, version, name, unit, creative_type, layers, created_by)
           select $1, $2, $3::int, $4, $5, $6, $7::jsonb, $8
             from (
               select count(distinct id)::int as distinct_ids,
                      count(*) filter (where id = $2)::int as id_versions
                 from template
                where org_id = $1
             ) counts
            where (id_versions > 0 or distinct_ids < $9::int)
              and id_versions < $10::int
           returning id`,
          [
            this.orgId,
            template.id,
            template.version,
            template.name,
            template.unit,
            template.creativeType,
            JSON.stringify(template.layers),
            actor,
            MAX_TEMPLATES_PER_ORG,
            MAX_VERSIONS_PER_TEMPLATE,
          ],
        );
        // No RETURNING row means the cap predicate selected nothing to insert:
        // an admission refusal, not a data error — the template itself is
        // valid, the library is just full. The message is fixed and neutral;
        // no row data travels with it.
        if (rows.length === 0) throw new TemplateLimitExceededError();
      };
      if (typeof this.db.transaction === "function") {
        await this.db.transaction(async (tx) => {
          await tx.query("select pg_advisory_xact_lock(hashtext('template:' || $1 || ':' || $2))", [
            this.orgId,
            template.id,
          ]);
          await insert(tx);
        });
      } else {
        await insert(this.db);
      }
    } catch (error) {
      // Two writers saving the same (org, id, version) race the primary key;
      // the loser sees a constraint violation, not a reason to 500 — the
      // first row remains byte-identical, never overwritten.
      if (pgErrorCode(error) === "23505") throw new TemplateVersionExistsError();
      throw error;
    }
  }
}
