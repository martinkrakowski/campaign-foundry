import { randomUUID } from "node:crypto";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";

/** A user is named by the address they signed up with or by their Better Auth id. */
export type EraseUserRef = { readonly email: string } | { readonly userId: string };

/** Row counts only: what an erasure changes (or, on a dry run, would change). */
export interface EraseUserCounts {
  readonly briefVersions: number;
  readonly decisions: number;
  readonly providerKeys: number;
  readonly campaignsDeletedBy: number;
  readonly deletionsRequestedBy: number;
  readonly drafts: number;
  readonly lastOpened: number;
  readonly verifications: number;
  readonly invitationsAsInvitee: number;
  readonly invitationsAsInviter: number;
  readonly sessions: number;
  readonly accounts: number;
  readonly members: number;
  readonly teamMembers: number;
  readonly teams: number;
}

export type EraseUserOutcome =
  | { readonly outcome: "not-found" }
  | { readonly outcome: "sole-owner"; readonly orgIds: readonly string[] }
  | { readonly outcome: "planned"; readonly counts: EraseUserCounts }
  | { readonly outcome: "erased"; readonly token: string; readonly counts: EraseUserCounts };

const LOOKUP_BY_EMAIL = `select id, email from "user" where email = lower($1)`;
const LOOKUP_BY_ID = `select id, email from "user" where id = $1`;

// D240 step 5. The magic-link plugin stores a random token as `identifier` and
// the email as typed inside `value` as JSON, so both clauses are needed.
const VERIFICATION_MATCH = `lower(identifier) = lower($1)
  or position(lower('"email":' || to_json($1::text)::text) in lower(value)) > 0`;
const INVITEE_MATCH = "lower(email) = lower($1)";

const LOCK_MEMBERS = `select id from member
  where org_id in (select org_id from member where user_id = $1)
  order by org_id, id
  for update`;

const SOLE_OWNER = `select m.org_id from member m
  where m.user_id = $1 and string_to_array(replace(m.role, ' ', ''), ',') @> array['owner']
    and not exists (
      select 1 from member o
       where o.org_id = m.org_id and o.user_id <> $1
         and string_to_array(replace(o.role, ' ', ''), ',') @> array['owner'])
  order by m.org_id`;

const COUNTS = `select
  (select count(*) from brief_version where actor = $1)::int as "briefVersions",
  (select count(*) from decision where actor = $1)::int as "decisions",
  (select count(*) from provider_key where created_by = $1)::int as "providerKeys",
  (select count(*) from campaign where deleted_by = $1)::int as "campaignsDeletedBy",
  (select count(*) from deletion where requested_by = $1)::int as "deletionsRequestedBy",
  (select count(*) from draft where user_id = $1)::int as "drafts",
  (select count(*) from last_opened where user_id = $1)::int as "lastOpened",
  (select count(*) from invitation where inviter_id = $1)::int as "invitationsAsInviter",
  (select count(*) from session where user_id = $1)::int as "sessions",
  (select count(*) from account where user_id = $1)::int as "accounts",
  (select count(*) from member where user_id = $1)::int as "members",
  (select count(*) from team_member where user_id = $1)::int as "teamMembers",
  (select count(distinct team_id) from team_member where user_id = $1)::int as "teams"`;

/**
 * D240: erase one user in ONE transaction. `apply: false` runs the sole-owner
 * check and the counts and writes nothing.
 */
export async function eraseUser(
  db: SqlClient,
  ref: EraseUserRef,
  options: { readonly apply: boolean },
): Promise<EraseUserOutcome> {
  const { apply } = options;
  return db.transaction((tx) => run(tx, ref, apply));
}

async function run(tx: SqlQuery, ref: EraseUserRef, apply: boolean): Promise<EraseUserOutcome> {
  const [lookup, value] =
    "email" in ref ? [LOOKUP_BY_EMAIL, ref.email] : [LOOKUP_BY_ID, ref.userId];
  const found = await tx.query<{ id: string; email: string }>(lookup, [value]);
  const user = found.rows[0];
  if (user === undefined) return { outcome: "not-found" };
  const userId = user.id;
  const email = user.email;

  // Step 1. Lock the member rows of the user's orgs (a fixed order, so two
  // erasures cannot deadlock), then read who would be left without an owner.
  await tx.query(LOCK_MEMBERS, [userId]);
  const sole = await tx.query<{ org_id: string }>(SOLE_OWNER, [userId]);
  if (sole.rows.length > 0) {
    return { outcome: "sole-owner", orgIds: sole.rows.map((row) => row.org_id) };
  }

  const main = await tx.query<Omit<EraseUserCounts, "verifications" | "invitationsAsInvitee">>(
    COUNTS,
    [userId],
  );
  const verifications = await tx.query<{ n: number }>(
    `select count(*)::int as n from verification where ${VERIFICATION_MATCH}`,
    [email],
  );
  const invitees = await tx.query<{ n: number }>(
    `select count(*)::int as n from invitation where ${INVITEE_MATCH}`,
    [email],
  );
  const counts: EraseUserCounts = {
    ...main.rows[0]!,
    verifications: verifications.rows[0]!.n,
    invitationsAsInvitee: invitees.rows[0]!.n,
  };
  if (!apply) return { outcome: "planned", counts };

  // Step 2.
  const token = `erased:${randomUUID()}`;
  // Step 3.
  await tx.query(`update brief_version set actor = $2 where actor = $1`, [userId, token]);
  await tx.query(`update decision set actor = $2 where actor = $1`, [userId, token]);
  await tx.query(`update provider_key set created_by = $2 where created_by = $1`, [userId, token]);
  await tx.query(`update campaign set deleted_by = $2 where deleted_by = $1`, [userId, token]);
  await tx.query(`update deletion set requested_by = $2 where requested_by = $1`, [userId, token]);
  // Step 4.
  await tx.query(`delete from draft where user_id = $1`, [userId]);
  await tx.query(`delete from last_opened where user_id = $1`, [userId]);
  // Step 5.
  // NOTE (D240 step 5): Better Auth core's `reset-password:<token>` and
  // `delete-account-<token>` verification rows store the USER ID as `value`;
  // neither writer is enabled here (`lib/auth/options.ts` has no emailAndPassword,
  // and `deleteUser` is off). Whoever enables either must add
  // `delete from verification where value = $userId` to this step.
  await tx.query(`delete from verification where ${VERIFICATION_MATCH}`, [email]);
  await tx.query(`delete from invitation where ${INVITEE_MATCH}`, [email]);
  // Step 6: the teams are read BEFORE the cascade removes the rows that name them.
  const teams = await tx.query<{ team_id: string }>(
    `select team_id from team_member where user_id = $1 order by team_id`,
    [userId],
  );
  await tx.query(`delete from "user" where id = $1`, [userId]);
  // Step 7.
  await tx.query(
    `update team set "memberCount" = (select count(*) from team_member tm where tm.team_id = team.id)::int
      where id = any($1::text[])`,
    [teams.rows.map((row) => row.team_id)],
  );
  // Step 8: already purged, so `claimDue` and `listDue` never see it.
  await tx.query(
    `insert into deletion (org_id, kind, subject, requested_by, not_before, purged_at)
       values (null, 'user', $1, 'cli:erase-user', now(), now())`,
    [token],
  );
  return { outcome: "erased", token, counts };
}
