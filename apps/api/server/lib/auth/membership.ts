import type { SqlClient } from "../db/sql-client.js";
import type { TenantContext } from "../tenant.js";

/**
 * A signed-in user's tenant (PT-1a item 3): the first membership by org id,
 * deterministic while D175 keeps org creation and invitations off, so a user
 * belongs to at most `local`. A user in more than one org (PT-7's BYOK era) is
 * PT-2's authorisation and org-switching work, not this lane's.
 *
 * `undefined` means no membership at all — the caller's 403.
 */
export async function memberTenant(
  db: SqlClient,
  userId: string,
): Promise<TenantContext | undefined> {
  const members = await db.query<{ org_id: string; role: string }>(
    "select org_id, role from member where user_id = $1 order by org_id",
    [userId],
  );
  const member = members.rows[0];
  if (!member) return undefined;
  const teams = await db.query<{ team_id: string }>(
    `select tm.team_id from team_member tm
       join team t on t.id = tm.team_id
      where tm.user_id = $1 and t.org_id = $2
      order by tm.team_id`,
    [userId, member.org_id],
  );
  return {
    orgId: member.org_id,
    userId,
    roles: member.role.split(",").map((r) => r.trim()),
    teamIds: teams.rows.map((t) => t.team_id),
  };
}
