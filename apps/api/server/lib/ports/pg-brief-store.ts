import { SAFE_ID_PATTERN, type CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import { BRIEF_SOURCE_EXTS, hashBytes, isErrno } from "../brief-files.js";
import type { SqlClient } from "../db/sql-client.js";
import { parseBriefText, type ParseBriefOptions } from "../load-brief.js";
import type { BriefStorePort, StoredBrief } from "./brief-store.port.js";

/** A file key ("<slug>.yaml") and the bare slug name the same row; strip a known extension. */
function slugOf(fileOrId: string): string {
  const lower = fileOrId.toLowerCase();
  for (const ext of BRIEF_SOURCE_EXTS) {
    if (lower.endsWith(ext)) return fileOrId.slice(0, fileOrId.length - ext.length);
  }
  return fileOrId;
}

interface BriefVersionRow {
  readonly campaign_id: string;
  readonly version: number;
  readonly revision: string;
  readonly body: Record<string, unknown>;
}

function notFound(id: string): Error {
  const err = new Error(`Brief "${id}" not found.`);
  (err as { code?: string }).code = "ENOENT";
  return err;
}

/** A write's id becomes a column value here, not a path — but an unsafe one is
 * still refused up front, the same guard `PgDecisionStore` applies (and the
 * same class of id `fs-brief-store.ts`'s path confinement refuses for reads). */
function assertSafeSlug(id: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Brief id ${JSON.stringify(id)} is not a safe id.`);
  }
}

/**
 * Briefs as rows (PT-3d, D168, D169). `campaign` mints the org-scoped surrogate
 * id and carries the slug — still the domain id every route and this port
 * address a brief by (`brief.id`), until PT-5 moves routes to ids. `brief_version`
 * is one row per save, so a write is an audit entry, never an overwrite, and it
 * carries the SHA-256 of the canonical YAML (`dumpBrief`) as its revision.
 * Unlike reports and decisions, **a PT-8 import will not keep brief revisions**:
 * the file store's revision hashes the operator's own bytes, comments included,
 * while this store's revision hashes `dumpBrief` of the parsed object — the two
 * never agree, even for an unchanged brief.
 *
 * The store is built per (org, actor) — the registry key, `lib/ports/index.ts`
 * — so every write's actor needs no argument and every read is scoped to its
 * org by construction; another org's campaign is invisible, not forbidden.
 */
export class PgBriefStore implements BriefStorePort {
  private readonly lockChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
    private readonly actor: string,
  ) {}

  /** The campaign's latest version in this org, or undefined if no brief has that slug. */
  private async currentRow(slug: string): Promise<BriefVersionRow | undefined> {
    const { rows } = await this.db.query<BriefVersionRow>(
      `select bv.campaign_id, bv.version, bv.revision, bv.body
         from campaign c
         join brief_version bv on bv.campaign_id = c.id
        where c.org_id = $1 and c.slug = $2
        order by bv.version desc
        limit 1`,
      [this.orgId, slug],
    );
    return rows[0];
  }

  async listBriefs(): Promise<readonly StoredBrief[]> {
    const { rows } = await this.db.query<{
      slug: string;
      body: Record<string, unknown>;
      revision: string;
    }>(
      `select slug, body, revision from (
         select distinct on (c.id) c.id, c.slug, bv.body, bv.revision
           from campaign c
           join brief_version bv on bv.campaign_id = c.id
          where c.org_id = $1
          order by c.id, bv.version desc
       ) latest
       order by slug`,
      [this.orgId],
    );
    const briefs: StoredBrief[] = [];
    for (const row of rows) {
      const file = `${row.slug}.yaml`;
      try {
        briefs.push({
          file,
          brief: parseBriefText(file, dumpBrief(row.body)),
          revision: row.revision,
        });
      } catch (error) {
        // A row that no longer parses is skipped, the way the file store skips a
        // bad file — never dropped from the org silently, just kept out of the list.
        console.warn(`[briefs] skipped ${row.slug}: ${errorMessage(error)}`);
      }
    }
    return briefs;
  }

  async findBriefById(id: string): Promise<StoredBrief | undefined> {
    const row = await this.currentRow(id);
    if (!row) return undefined;
    const file = `${id}.yaml`;
    return { file, brief: parseBriefText(file, dumpBrief(row.body)), revision: row.revision };
  }

  async findBriefFileById(id: string): Promise<string | undefined> {
    return (await this.currentRow(id)) ? `${id}.yaml` : undefined;
  }

  async findBriefFile(id: string): Promise<string | undefined> {
    // No non-test caller (PT-3d spec): every campaign is stored under exactly
    // one key, its slug, so this answers the same as findBriefFileById.
    return this.findBriefFileById(id);
  }

  async readBrief(fileOrKey: string, opts: ParseBriefOptions = {}): Promise<CampaignBrief> {
    const slug = slugOf(fileOrKey);
    const row = await this.currentRow(slug);
    if (!row) throw notFound(fileOrKey);
    return parseBriefText(`${slug}.yaml`, dumpBrief(row.body), opts);
  }

  async createBrief(brief: CampaignBrief): Promise<StoredBrief> {
    assertSafeSlug(brief.id);
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into campaign (org_id, slug) values ($1, $2)
         on conflict (org_id, slug) do nothing
         returning id`,
        [this.orgId, brief.id],
      );
      const campaignId = rows[0]?.id;
      if (!campaignId) {
        const err = new Error(`Brief "${brief.id}" already exists.`);
        (err as { code?: string }).code = "EEXIST";
        throw err;
      }
      const yaml = dumpBrief(brief);
      const revision = hashBytes(Buffer.from(yaml, "utf8"));
      await tx.query(
        `insert into brief_version (campaign_id, version, body, revision, actor)
         values ($1, 1, $2::jsonb, $3, $4)`,
        [campaignId, JSON.stringify(brief), revision, this.actor],
      );
      return { file: `${brief.id}.yaml`, brief, revision };
    });
  }

  /**
   * The compare-and-swap (D79) inside the write's own transaction: `select …
   * for update` on the campaign row serialises every writer targeting this
   * brief, so the version this reads and the version it inserts are one
   * snapshot. This is never a lock held around caller code — the store's own
   * short write, not `withBriefLock`'s `fn` — so it cannot deadlock against a
   * `fn` that calls back into this store on another pooled connection.
   */
  async rewriteBrief(
    brief: CampaignBrief,
    options?: { expectedRevision?: string },
  ): Promise<StoredBrief> {
    assertSafeSlug(brief.id);
    return this.db.transaction(async (tx) => {
      const { rows: campaigns } = await tx.query<{ id: string }>(
        `select id from campaign where org_id = $1 and slug = $2 for update`,
        [this.orgId, brief.id],
      );
      const campaignId = campaigns[0]?.id;
      if (!campaignId) throw notFound(brief.id);
      const { rows: versions } = await tx.query<{ version: number; revision: string }>(
        `select version, revision from brief_version where campaign_id = $1 order by version desc limit 1`,
        [campaignId],
      );
      const current = versions[0]!; // createBrief always writes version 1
      if (options?.expectedRevision && options.expectedRevision !== current.revision) {
        const err = new Error("Brief was modified by another user.");
        (err as { code?: string; revision?: string }).code = "ECONFLICT";
        (err as { revision?: string }).revision = current.revision;
        throw err;
      }
      const yaml = dumpBrief(brief);
      const revision = hashBytes(Buffer.from(yaml, "utf8"));
      await tx.query(
        `insert into brief_version (campaign_id, version, body, revision, actor)
         values ($1, $2, $3::jsonb, $4, $5)`,
        [campaignId, current.version + 1, JSON.stringify(brief), revision, this.actor],
      );
      return { file: `${brief.id}.yaml`, brief, revision };
    });
  }

  async replaceBrief(
    brief: CampaignBrief,
    options?: { expectedRevision?: string },
  ): Promise<StoredBrief> {
    try {
      return await this.rewriteBrief(brief, options);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return this.createBrief(brief);
      throw error;
    }
  }

  async getRevision(fileOrId: string): Promise<string | undefined> {
    return (await this.currentRow(slugOf(fileOrId)))?.revision;
  }

  async exists(fileOrId: string): Promise<boolean> {
    return (await this.currentRow(slugOf(fileOrId))) !== undefined;
  }

  /**
   * The in-process per-brief chain, unchanged from `FsBriefStore`
   * (`fs-brief-store.ts:230-242`). Cross-process safety is `rewriteBrief` and
   * `replaceBrief`'s compare-and-swap plus `createBrief`'s unique key, above —
   * never a database lock held around `fn`: `fn`'s own store calls run on other
   * pooled connections and would deadlock against one, which PGlite (one
   * connection) cannot show. The trade-off this leaves: two users' saves on one
   * brief serialise only through the compare-and-swap (the loser gets 409), not
   * through this chain, which only ever sees its own process's callers.
   */
  withBriefLock<T>(briefId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockChains.get(briefId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.lockChains.set(briefId, settled);
    void settled.then(() => {
      if (this.lockChains.get(briefId) === settled) this.lockChains.delete(briefId);
    });
    return run;
  }
}
