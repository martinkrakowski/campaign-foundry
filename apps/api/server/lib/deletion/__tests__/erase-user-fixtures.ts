import { randomUUID } from "node:crypto";
import type { SqlClient, SqlQuery } from "../../db/sql-client.js";

/** The four fixture users. No id, email or name is a substring of another's. */
export const TARGET = { id: "u-target", email: "target@example.com", name: "Target Person" };
export const BYSTANDER = {
  id: "u-bystander",
  email: "bystander@example.com",
  name: "Bystander Person",
};
export const LOCAL_OWNER = {
  id: "u-local-owner",
  email: "local-owner@example.com",
  name: "Local Owner",
};
export const ACME_OWNER = {
  id: "u-acme-owner",
  email: "acme-owner@example.com",
  name: "Acme Owner",
};

export interface World {
  localCampaignId: string;
  acmeCampaignId: string;
}

const USERS: ReadonlyArray<{ id: string; email: string; name: string }> = [
  TARGET,
  BYSTANDER,
  LOCAL_OWNER,
  ACME_OWNER,
];

/** Plant the cross-org world eraseUser is exercised against, verbatim seeds. */
export async function seedWorld(db: SqlClient): Promise<World> {
  await db.query(
    `insert into org (id, name, slug, created_at) values ('acme', 'Acme', 'acme', now())`,
  );

  for (const u of USERS) {
    await db.query(
      'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
      [u.id, u.name, u.email],
    );
  }

  await db.query(
    "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner', now())",
    ["m-local-owner", LOCAL_OWNER.id],
  );
  await db.query(
    "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'admin', now())",
    ["m-target", TARGET.id],
  );
  await db.query(
    "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'member', now())",
    ["m-bystander", BYSTANDER.id],
  );
  await db.query(
    "insert into member (id, org_id, user_id, role, created_at) values ($1, 'acme', $2, 'owner', now())",
    ["m-acme-owner", ACME_OWNER.id],
  );

  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values ('team-a', 'Team A', 2, 'local', now())`,
  );
  await db.query(
    `insert into team (id, name, "memberCount", org_id, created_at) values ('team-b', 'Team B', 7, 'local', now())`,
  );

  await db.query(
    'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
    ["tm-target-a", "team-a", TARGET.id, "local:team-a:u-target"],
  );
  await db.query(
    'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
    ["tm-bystander-a", "team-a", BYSTANDER.id, "local:team-a:u-bystander"],
  );
  await db.query(
    'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
    ["tm-bystander-b", "team-b", BYSTANDER.id, "local:team-b:u-bystander"],
  );

  const { rows: localRows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug, deleted_at, deleted_by) values ('local', $1, now(), $2) returning id`,
    ["c-local", TARGET.id],
  );
  const localCampaignId = localRows[0]!.id;
  const { rows: bystanderRows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug, deleted_at, deleted_by) values ('local', $1, now(), $2) returning id`,
    ["c-bystander", BYSTANDER.id],
  );
  const bystanderCampaignId = bystanderRows[0]!.id;
  const { rows: acmeRows } = await db.query<{ id: string }>(
    `insert into campaign (org_id, slug) values ('acme', $1) returning id`,
    ["c-acme"],
  );
  const acmeCampaignId = acmeRows[0]!.id;

  await db.query(
    "insert into brief_version (campaign_id, version, body, revision, actor) values ($1, $2, '{}', 'r1', $3)",
    [localCampaignId, 1, TARGET.id],
  );
  await db.query(
    "insert into brief_version (campaign_id, version, body, revision, actor) values ($1, $2, '{}', 'r1', $3)",
    [localCampaignId, 2, BYSTANDER.id],
  );
  await db.query(
    "insert into brief_version (campaign_id, version, body, revision, actor) values ($1, $2, '{}', 'r1', $3)",
    [acmeCampaignId, 1, ACME_OWNER.id],
  );

  await db.query(
    "insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-1')",
    ["local", localCampaignId, "ak-target", TARGET.id],
  );
  await db.query(
    "insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-1')",
    ["local", localCampaignId, "ak-bystander", BYSTANDER.id],
  );
  await db.query(
    "insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-1')",
    ["acme", acmeCampaignId, "ak-acme", ACME_OWNER.id],
  );

  await db.query(
    "insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by) values ('local', $1, 'ct', 'iv', 'tag', 'dek', 'div', 'dtag', 'v1', 'abcd', $2)",
    ["gemini", TARGET.id],
  );
  await db.query(
    "insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by) values ('local', $1, 'ct', 'iv', 'tag', 'dek', 'div', 'dtag', 'v1', 'abcd', $2)",
    ["openrouter", BYSTANDER.id],
  );

  await db.query(
    "insert into draft (campaign_id, user_id, org_id, state) values ($1, $2, 'local', '{}')",
    [localCampaignId, TARGET.id],
  );
  await db.query(
    "insert into draft (campaign_id, user_id, org_id, state) values ($1, $2, 'local', '{}')",
    [localCampaignId, BYSTANDER.id],
  );

  await db.query(
    "insert into last_opened (org_id, user_id, campaign_id) values ('local', $1, $2)",
    [TARGET.id, localCampaignId],
  );
  await db.query(
    "insert into last_opened (org_id, user_id, campaign_id) values ('local', $1, $2)",
    [BYSTANDER.id, localCampaignId],
  );

  await db.query(
    "insert into verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
    ["v-1", TARGET.email, "tok"],
  );
  await db.query(
    "insert into verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
    ["v-2", "tok-target", JSON.stringify({ email: "Target@Example.com", name: "Target Person" })],
  );
  await db.query(
    "insert into verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
    ["v-3", BYSTANDER.email, "tok"],
  );
  await db.query(
    "insert into verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + interval '1 hour')",
    [
      "v-4",
      "tok-bystander",
      JSON.stringify({ email: "bystander@example.com", name: "Bystander Person" }),
    ],
  );

  await db.query(
    "insert into invitation (id, org_id, email, status, expires_at, inviter_id) values ($1, 'local', $2, 'pending', now() + interval '1 day', $3)",
    ["inv-1", TARGET.email.toUpperCase(), LOCAL_OWNER.id],
  );
  await db.query(
    "insert into invitation (id, org_id, email, status, expires_at, inviter_id) values ($1, 'local', $2, 'pending', now() + interval '1 day', $3)",
    ["inv-2", BYSTANDER.email, LOCAL_OWNER.id],
  );
  await db.query(
    "insert into invitation (id, org_id, email, status, expires_at, inviter_id) values ($1, 'local', $2, 'pending', now() + interval '1 day', $3)",
    ["inv-3", "invitee-third@example.com", TARGET.id],
  );

  for (const u of USERS) {
    await db.query(
      "insert into session (id, expires_at, token, updated_at, user_id) values ($1, now() + interval '1 day', $2, now(), $3)",
      [`s-${u.id}`, `sess-${randomUUID()}`, u.id],
    );
    await db.query(
      "insert into account (id, account_id, provider_id, user_id, updated_at) values ($1, $2, 'credential', $2, now())",
      [`a-${u.id}`, u.id],
    );
  }

  await db.query(
    "insert into deletion (org_id, kind, subject, requested_by, not_before) values ('local', 'campaign', $1, $2, now())",
    [localCampaignId, TARGET.id],
  );
  await db.query(
    "insert into deletion (org_id, kind, subject, requested_by, not_before) values ('local', 'campaign', $1, $2, now())",
    [bystanderCampaignId, BYSTANDER.id],
  );

  return { localCampaignId, acmeCampaignId };
}

/** Every base-table row, as `table: ${row::text}`, sorted — for before/after diffs. */
export async function dumpDatabase(db: SqlQuery): Promise<string[]> {
  const tables = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
       where table_schema = current_schema() and table_type = 'BASE TABLE'
       order by table_name`,
  );
  const lines: string[] = [];
  for (const { table_name } of tables.rows) {
    const { rows } = await db.query<{ row: string }>(
      `select t::text as row from "${table_name}" t order by 1`,
    );
    for (const { row } of rows) {
      lines.push(`${table_name}: ${row}`);
    }
  }
  return lines.sort();
}

/** `dumpDatabase` filtered to lines containing `needle` (JS case-insensitive, never SQL like). */
export async function rowsContaining(db: SqlClient, needle: string): Promise<string[]> {
  const all = await dumpDatabase(db);
  const lower = needle.toLowerCase();
  return all.filter((line) => line.toLowerCase().includes(lower));
}

/**
 * A client that throws `injected failure` on any statement whose SQL text
 * contains `marker`. Wraps `query` on both the client and the transaction handle
 * so a mutant under test (no transaction) is caught the same way a real one is
 * not (it rolls back). The same wrapper idea as `request.concurrency.test.ts`.
 */
export function failingOn(db: SqlClient, marker: string): SqlClient {
  const guard =
    (q: SqlQuery) =>
    async <R>(text: string, params?: readonly unknown[]) => {
      if (text.includes(marker)) throw new Error("injected failure");
      return q.query<R>(text, params);
    };
  return {
    ...db,
    query: guard(db),
    transaction: (work) => db.transaction((tx) => work({ ...tx, query: guard(tx) })),
    end: () => db.end(),
  };
}
