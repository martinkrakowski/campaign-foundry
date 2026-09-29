import {
  SAFE_ID_PATTERN,
  isReservedCampaignId,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import { BRIEF_SOURCE_EXTS, hashBytes, isErrno } from "../brief-files.js";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { parseBriefText, type ParseBriefOptions } from "../load-brief.js";
import type {
  BriefStorePort,
  BriefWriteOptions,
  CampaignMeta,
  CreateCampaignOptions,
  ResolvedCampaign,
  StoredBrief,
} from "./brief-store.port.js";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** The exact `JSON.stringify(brief)` bytes the write stored; see the migration. */
  readonly body: string;
  /** D166: null (org-wide) or the team the campaign belongs to; see `visible`. */
  readonly team_id: string | null;
}

/** `body` is validated by `parseBriefText` right after this call; a bad row simply fails to parse. */
function parseBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

function notFound(id: string): Error {
  const err = new Error(`Brief "${id}" not found.`);
  (err as { code?: string }).code = "ENOENT";
  return err;
}

/**
 * Thrown when a caller may not assign a campaign to `teamId` (D166 item 3):
 * either the route's own cheap check (`teamId` is not one of the caller's own
 * teams and the caller is neither `owner` nor `admin`) or this store's
 * authoritative one (the id names no team in this org at all — a foreign
 * team, or a typo — which the FK alone would only catch as a 500). Routes map
 * this to 403, the same way `isErrno(error, "ECONFLICT")` maps to 409.
 */
function forbiddenTeam(teamId: string): Error {
  const err = new Error(`Not authorized to assign team "${teamId}".`);
  (err as { code?: string }).code = "EFORBIDDEN";
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

function assertNotReserved(id: string): void {
  if (isReservedCampaignId(id)) {
    throw new Error(`"${id}" is reserved; choose another campaign id.`);
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
  /** Team columns and `campaignVisibility("hidden")` — see `BriefStorePort.supportsTeams`. */
  readonly supportsTeams = true;

  private readonly lockChains = new Map<string, Promise<unknown>>();

  /**
   * `roles` and `teamIds` default to none (an admin-less, team-less caller):
   * every existing call site (PT-3d's tests, and any lane that never assigns a
   * team) still sees exactly the org-wide campaigns team scope always allowed,
   * since a campaign with no team is visible regardless of role or team.
   */
  constructor(
    private readonly db: SqlClient,
    private readonly orgId: string,
    private readonly actor: string,
    private readonly roles: readonly string[] = [],
    private readonly teamIds: readonly string[] = [],
  ) {}

  /**
   * Team scope (D166 item 2): a campaign with no team is visible to the whole
   * org; the org's `owner` and `admin` roles see every campaign regardless of
   * team; anyone else sees a campaign only through their own teams.
   */
  private visible(teamId: string | null): boolean {
    if (teamId === null) return true;
    if (this.roles.includes("owner") || this.roles.includes("admin")) return true;
    return this.teamIds.includes(teamId);
  }

  /** The campaign's latest version in this org, or undefined if no brief has that slug or it is hidden from this caller by team (D166). */
  private async currentRow(slug: string): Promise<BriefVersionRow | undefined> {
    const { rows } = await this.db.query<BriefVersionRow>(
      `select bv.campaign_id, bv.version, bv.revision, bv.body, c.team_id
         from campaign c
         join brief_version bv on bv.campaign_id = c.id
        where c.org_id = $1 and c.slug = $2
        order by bv.version desc
        limit 1`,
      [this.orgId, slug],
    );
    const row = rows[0];
    if (!row || !this.visible(row.team_id)) return undefined;
    return row;
  }

  /**
   * "absent" | "visible" | "hidden" (D166 item 4, `BriefStorePort`): tells
   * "never created" (a campaign row does not exist at all — `lib/ownership.ts`
   * `campaignKnown` must still fall through to its report/asset fallback for
   * an unsaved draft) from "exists but hidden" (a row exists whose team the
   * caller's role or memberships cannot see — `campaignKnown` must 404
   * immediately, even when a report or asset exists in the org's scope), from
   * plain "visible". `findBriefById` alone cannot make this distinction:
   * team scope already makes it answer `undefined` for both "absent" and
   * "hidden". Also used by the brief write routes (item 3) to answer 409 on
   * a hidden or already-visible target before any write or asset copy runs.
   */
  async campaignVisibility(id: string): Promise<"absent" | "visible" | "hidden"> {
    const { rows } = await this.db.query<{ team_id: string | null }>(
      `select team_id from campaign where org_id = $1 and slug = $2`,
      [this.orgId, id],
    );
    const row = rows[0];
    if (!row) return "absent";
    return this.visible(row.team_id) ? "visible" : "hidden";
  }

  /** See `BriefStorePort.campaignTeam` (PT-5b2 fix-round item 1). */
  async campaignTeam(slug: string): Promise<string | null | undefined> {
    const { rows } = await this.db.query<{ team_id: string | null }>(
      `select team_id from campaign where org_id = $1 and slug = $2`,
      [this.orgId, slug],
    );
    const row = rows[0];
    if (!row || !this.visible(row.team_id)) return undefined;
    return row.team_id;
  }

  /**
   * Resolve a campaign reference (canonical uuid OR slug) within the caller's scope (D178, D179).
   * Tries canonical uuid first, then falls back to slug.
   * Answers { campaignId, slug } or undefined if absent or hidden by team.
   */
  async resolveCampaign(ref: string): Promise<ResolvedCampaign | undefined> {
    // A uuid-shaped ref is tried as an id first. A match the caller may not see is
    // treated exactly as no match (PT-2d: hidden is indistinguishable from missing),
    // so the ref still falls through to the slug lookup.
    if (CANONICAL_UUID_PATTERN.test(ref)) {
      const { rows } = await this.db.query<{ id: string; slug: string; team_id: string | null }>(
        `select id, slug, team_id from campaign where org_id = $1 and id = $2`,
        [this.orgId, ref.toLowerCase()],
      );
      const byId = rows[0];
      if (byId && this.visible(byId.team_id)) return { campaignId: byId.id, slug: byId.slug };
    }
    const { rows } = await this.db.query<{ id: string; slug: string; team_id: string | null }>(
      `select id, slug, team_id from campaign where org_id = $1 and slug = $2`,
      [this.orgId, ref],
    );
    const bySlug = rows[0];
    if (!bySlug || !this.visible(bySlug.team_id)) return undefined;
    return { campaignId: bySlug.id, slug: bySlug.slug };
  }

  async listBriefs(): Promise<readonly StoredBrief[]> {
    const { rows } = await this.db.query<{
      campaign_id: string;
      slug: string;
      body: string;
      revision: string;
      team_id: string | null;
    }>(
      `select campaign_id, slug, body, revision, team_id from (
         select distinct on (c.id) c.id as campaign_id, c.slug, c.team_id, bv.body, bv.revision
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
      // D166 item 2: a campaign hidden from this caller by team is skipped
      // exactly like a row that fails to parse below — dropped from THIS
      // listing, never from the org. The mutation manifest anchors on this
      // predicate: drop it and the other-team-hidden test lists a campaign
      // it must not.
      if (!this.visible(row.team_id)) continue;
      const file = `${row.slug}.yaml`;
      try {
        briefs.push({
          campaignId: row.campaign_id,
          file,
          brief: parseBriefText(file, dumpBrief(parseBody(row.body))),
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
    return {
      campaignId: row.campaign_id,
      file,
      brief: parseBriefText(file, dumpBrief(parseBody(row.body))),
      revision: row.revision,
    };
  }

  async findBriefFileById(id: string): Promise<string | undefined> {
    return (await this.currentRow(id)) ? `${id}.yaml` : undefined;
  }

  async findBriefFile(
    id: string,
    exts: readonly string[] = BRIEF_SOURCE_EXTS,
  ): Promise<string | undefined> {
    // Every campaign is stored under exactly one key, its slug at ".yaml" — so
    // this can only ever answer that key, and only when ".yaml" is among the
    // extensions the caller accepts (the fs store's own contract: an id with
    // no file at an allowed extension is not found).
    if (!exts.includes(".yaml")) return undefined;
    return this.findBriefFileById(id);
  }

  async readBrief(fileOrKey: string, opts: ParseBriefOptions = {}): Promise<CampaignBrief> {
    const slug = slugOf(fileOrKey);
    const row = await this.currentRow(slug);
    if (!row) throw notFound(fileOrKey);
    return parseBriefText(`${slug}.yaml`, dumpBrief(parseBody(row.body)), opts);
  }

  /**
   * D166 item 3's authoritative check, inside the same transaction as the
   * write it guards: `teamId` must name a team of THIS org. The route's own
   * cheap check (the caller is `owner`/`admin`, or `teamId` is one of the
   * caller's own teams) cannot catch an owner or admin naming another org's
   * team (or a typo'd id) — `team.id` is a bare `text` primary key, not scoped
   * to an org, so the `campaign.team_id` FK alone would only turn that into an
   * opaque 500. `null` (no team) is never checked.
   */
  private async assertTeamInOrg(tx: SqlQuery, teamId: string): Promise<void> {
    const { rows } = await tx.query<{ found: number }>(
      `select 1 as found from team where id = $1 and org_id = $2`,
      [teamId, this.orgId],
    );
    if (rows.length === 0) throw forbiddenTeam(teamId);
  }

  /**
   * `teamId` stays three-state all the way to the write (D177, PT-5b2):
   * `undefined` (the route passed none) must NOT become `createCampaign`'s
   * "no team" default when this write turns out to be the first Save onto an
   * ALREADY-EXISTING versionless row — that would reset a team-scoped
   * campaign to org-wide the moment its first Save omits `teamId`, exactly
   * the failure mode `rewriteBrief` already avoids for every later Save. It
   * becomes `null` only for a genuinely fresh insert, where "no team" IS the
   * default (unchanged from before this lane).
   */
  private async createBriefInternal(
    brief: CampaignBrief,
    teamId: string | null | undefined,
  ): Promise<StoredBrief> {
    assertSafeSlug(brief.id);
    return this.db.transaction(async (tx) => {
      if (teamId !== null && teamId !== undefined) await this.assertTeamInOrg(tx, teamId);
      const { rows: inserted } = await tx.query<{ id: string }>(
        `insert into campaign (org_id, slug, team_id) values ($1, $2, $3)
         on conflict (org_id, slug) do nothing
         returning id`,
        [this.orgId, brief.id, teamId ?? null],
      );
      let campaignId = inserted[0]?.id;
      if (campaignId === undefined) {
        // The slug already names a campaign row — either a blank
        // `POST /campaigns` mint with no version yet (this Save is its
        // first: D177) or a genuinely existing brief (refused, unchanged).
        // Locked with `for update`, the same compare-and-swap shape
        // `rewriteBriefInternal` uses, so a concurrent write to this exact
        // row serialises on it rather than reading a version count this
        // transaction is about to invalidate.
        //
        // D181 fix round: a row already existing here is exactly what
        // grandfathers a reserved slug (D181's scope note) — `assertNotReserved`
        // never runs in this branch, reserved or not, because this write is
        // onto a campaign that already exists, not a fresh mint of one.
        const { rows: existing } = await tx.query<{ id: string; team_id: string | null }>(
          `select id, team_id from campaign where org_id = $1 and slug = $2 for update`,
          [this.orgId, brief.id],
        );
        const row = existing[0]!; // the insert's own conflict proves this row exists
        if (!this.visible(row.team_id)) {
          // D166: hidden from this caller by team — answers exactly like an
          // existing brief (EEXIST), never written into, versionless or not.
          const err = new Error(`Brief "${brief.id}" already exists.`);
          (err as { code?: string }).code = "EEXIST";
          throw err;
        }
        campaignId = row.id;
        const { rows: versions } = await tx.query<{ version: number }>(
          `select version from brief_version where campaign_id = $1 limit 1`,
          [campaignId],
        );
        if (versions.length > 0) {
          const err = new Error(`Brief "${brief.id}" already exists.`);
          (err as { code?: string }).code = "EEXIST";
          throw err;
        }
        // Versionless: this Save is its first. `teamId === undefined` (the
        // route passed none) leaves the row's team exactly as
        // `createCampaign` set it — see this method's own doc comment.
        if (teamId !== undefined) {
          await tx.query(`update campaign set team_id = $1 where id = $2`, [teamId, campaignId]);
        }
      } else {
        // A brand-new row: nothing existed for this slug a moment ago, so a
        // reserved id may never mint fresh here (D181) — checked AFTER the
        // insert, not before, precisely so an already-existing row (the
        // branch above) is never refused as reserved. Throwing rolls this
        // insert back with the rest of the transaction.
        assertNotReserved(brief.id);
      }
      const yaml = dumpBrief(brief);
      const revision = hashBytes(Buffer.from(yaml, "utf8"));
      await tx.query(
        `insert into brief_version (campaign_id, version, body, revision, actor)
         values ($1, 1, $2, $3, $4)`,
        [campaignId, JSON.stringify(brief), revision, this.actor],
      );
      return { campaignId, file: `${brief.id}.yaml`, brief, revision };
    });
  }

  async createBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    return this.createBriefInternal(brief, options?.teamId);
  }

  /**
   * D177 (PT-5b2): `POST /campaigns`'s blank-create path. No lock: the
   * unique `(org_id, slug)` constraint is the whole race guard (the Dedupe
   * note in the plan) — the caller's own dedupe loop retries the next suffix
   * on the EEXIST this throws, never a separate check-then-act read.
   * `options.name`/`options.type` (PT-5b3, D168, D177) are the display name
   * and campaign type the user typed at Create, stored on `campaign` itself
   * (0013) so a later Save — which only ever inserts a `brief_version` row —
   * cannot touch them (item 4: Saving never clears them). Both are nullable,
   * so a caller that omits either (or the whole `options` object) stores
   * null, exactly like a campaign minted before this migration.
   */
  async createCampaign(slug: string, options?: CreateCampaignOptions): Promise<ResolvedCampaign> {
    assertSafeSlug(slug);
    assertNotReserved(slug);
    const teamId = options?.teamId ?? null;
    return this.db.transaction(async (tx) => {
      if (teamId !== null) await this.assertTeamInOrg(tx, teamId);
      const { rows } = await tx.query<{ id: string }>(
        `insert into campaign (org_id, slug, team_id, name, type) values ($1, $2, $3, $4, $5)
         on conflict (org_id, slug) do nothing
         returning id`,
        [this.orgId, slug, teamId, options?.name ?? null, options?.type ?? null],
      );
      const campaignId = rows[0]?.id;
      if (!campaignId) {
        const err = new Error(`Brief "${slug}" already exists.`);
        (err as { code?: string }).code = "EEXIST";
        throw err;
      }
      return { campaignId, slug };
    });
  }

  /**
   * See `BriefStorePort.campaignMeta` (PT-5b3). Mirrors `resolveCampaign`'s
   * own uuid-then-slug shape (a canonical uuid tried first, falling back to
   * slug), since `ref` is the same D178 reference every route resolves —
   * duplicated rather than composed with `resolveCampaign`, the same
   * trade-off this file already makes for `currentRow` vs `listBriefs`.
   * `has_version` is a single `exists` subquery rather than a join, so an
   * unversioned row (no `brief_version` at all) still answers one row, not
   * zero.
   */
  async campaignMeta(ref: string): Promise<CampaignMeta | undefined> {
    interface Row {
      readonly id: string;
      readonly slug: string;
      readonly name: string | null;
      readonly type: string | null;
      readonly team_id: string | null;
      readonly has_version: boolean;
    }
    const selectHasVersion = `exists(select 1 from brief_version bv where bv.campaign_id = c.id) as has_version`;
    const toMeta = (row: Row): CampaignMeta => ({
      campaignId: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      hasVersion: row.has_version,
    });
    if (CANONICAL_UUID_PATTERN.test(ref)) {
      const { rows } = await this.db.query<Row>(
        `select c.id, c.slug, c.name, c.type, c.team_id, ${selectHasVersion}
           from campaign c where c.org_id = $1 and c.id = $2`,
        [this.orgId, ref.toLowerCase()],
      );
      const metaById = rows[0];
      if (metaById && this.visible(metaById.team_id)) return toMeta(metaById);
    }
    const { rows } = await this.db.query<Row>(
      `select c.id, c.slug, c.name, c.type, c.team_id, ${selectHasVersion}
         from campaign c where c.org_id = $1 and c.slug = $2`,
      [this.orgId, ref],
    );
    const metaBySlug = rows[0];
    if (!metaBySlug || !this.visible(metaBySlug.team_id)) return undefined;
    return toMeta(metaBySlug);
  }

  /**
   * See `BriefStorePort.hasGenuineReservation` (D181 fix round 2). On
   * Postgres `campaignMeta` is already exact — a `campaign` row is real
   * evidence on its own, unlike fs's bare-directory fallback, because
   * `writePool`'s own insert (`pg-pool-store.ts`) writes only the `pool`
   * table, which has no foreign key to `campaign` (`0005_pool.sql`) and
   * `campaignMeta` never reads.
   */
  async hasGenuineReservation(ref: string): Promise<boolean> {
    return (await this.campaignMeta(ref)) !== undefined;
  }

  /**
   * See `BriefStorePort.releaseCampaign` (PT-5b2 fix-round item 2). One
   * statement: the `not exists` guard is the same "still zero versions"
   * check `createBriefInternal`'s conflict branch reads, so a concurrent
   * first-version `createBrief` racing this delete either wins outright (a
   * version already exists, so this deletes nothing and answers `false`) or
   * this delete wins first (the row is gone before that transaction's own
   * `select … for update` can see it). The caller's own `withBriefLock`
   * already rules the second case out for two requests on the same
   * process — campaigns are never otherwise deleted, so this delete only
   * ever fires from the same request that reserved the row moments before,
   * inside the SAME lock.
   */
  async releaseCampaign(slug: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `delete from campaign
        where org_id = $1 and slug = $2
          and not exists (select 1 from brief_version where campaign_id = campaign.id)
       returning id`,
      [this.orgId, slug],
    );
    return rows.length > 0;
  }

  /**
   * The compare-and-swap (D79) inside the write's own transaction: `select …
   * for update` on the campaign row serialises every writer targeting this
   * brief, so the version this reads and the version it inserts are one
   * snapshot. This is never a lock held around caller code — the store's own
   * short write, not `withBriefLock`'s `fn` — so it cannot deadlock against a
   * `fn` that calls back into this store on another pooled connection.
   *
   * `teamId` is `undefined` when `rewriteBrief`'s own caller passes no
   * `options.teamId` — leave the column exactly as it is, so a plain save
   * never resets an assigned team — and any other value (a team id, or `null`
   * to clear one, D166 item 3) is the value the route already authorized. The
   * row's current team is read here too so a campaign hidden from this caller by
   * team (D166) answers `notFound`, the same as a genuinely missing row —
   * without it, a member of another team could rewrite, or even reassign, a
   * campaign they cannot otherwise see at all.
   */
  private async rewriteBriefInternal(
    brief: CampaignBrief,
    expectedRevision: string | undefined,
    teamId: string | null | undefined,
  ): Promise<StoredBrief> {
    assertSafeSlug(brief.id);
    return this.db.transaction(async (tx) => {
      const { rows: campaigns } = await tx.query<{ id: string; team_id: string | null }>(
        `select id, team_id from campaign where org_id = $1 and slug = $2 for update`,
        [this.orgId, brief.id],
      );
      const campaignRow = campaigns[0];
      if (!campaignRow || !this.visible(campaignRow.team_id)) throw notFound(brief.id);
      const campaignId = campaignRow.id;
      const { rows: versions } = await tx.query<{ version: number; revision: string }>(
        `select version, revision from brief_version where campaign_id = $1 order by version desc limit 1`,
        [campaignId],
      );
      // D177 (PT-5b2): a `POST /campaigns` blank create leaves a campaign row
      // with no version yet — rewriteBrief has nothing to rewrite. Answering
      // `notFound` (ENOENT) here, exactly like a genuinely missing row, lets
      // both callers already keyed on that code do the right thing: PUT
      // /campaigns/briefs/:id 404s (its own contract — it never creates), and
      // `replaceBrief`'s ENOENT catch falls through to `createBrief`, which
      // completes the row's first Save. Without this, `versions[0]!` below
      // would throw an uncaught TypeError (500) instead.
      const current = versions[0];
      if (!current) throw notFound(brief.id);
      if (expectedRevision && expectedRevision !== current.revision) {
        const err = new Error("Brief was modified by another user.");
        (err as { code?: string; revision?: string }).code = "ECONFLICT";
        (err as { revision?: string }).revision = current.revision;
        throw err;
      }
      if (teamId !== undefined) {
        if (teamId !== null) await this.assertTeamInOrg(tx, teamId);
        await tx.query(`update campaign set team_id = $1 where id = $2`, [teamId, campaignId]);
      }
      const yaml = dumpBrief(brief);
      const revision = hashBytes(Buffer.from(yaml, "utf8"));
      await tx.query(
        `insert into brief_version (campaign_id, version, body, revision, actor)
         values ($1, $2, $3, $4, $5)`,
        [campaignId, current.version + 1, JSON.stringify(brief), revision, this.actor],
      );
      return { campaignId, file: `${brief.id}.yaml`, brief, revision };
    });
  }

  async rewriteBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    return this.rewriteBriefInternal(brief, options?.expectedRevision, options?.teamId);
  }

  /**
   * `replaceBrief`'s own ENOENT-falls-to-create shape carries the team the
   * route already authorized (D166 item 3) down either path. `rewriteBrief`'s
   * "`options.teamId` undefined leaves it as it is" keeps an already-assigned
   * team in place for the common existing-campaign case — a replace-save with
   * no `teamId` in the request must not reset it to org-wide. Only when there
   * is no existing row to leave alone (ENOENT, a fresh slug) does `undefined`
   * become `createBrief`'s `null` default.
   */
  async replaceBrief(brief: CampaignBrief, options?: BriefWriteOptions): Promise<StoredBrief> {
    try {
      return await this.rewriteBrief(brief, options);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return this.createBrief(brief, { teamId: options?.teamId ?? null });
      }
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
