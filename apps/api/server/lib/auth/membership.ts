import type { SqlClient } from "../db/sql-client.js";
import type { TenantContext } from "../tenant.js";

/**
 * A signed-in user's tenant (PT-1a item 3, PT-1b1): the session's active org
 * when the user is a member of it, otherwise the first membership by org id.
 * Only the user's own membership rows are searched, so an active org the user
 * does not belong to can never be selected; it falls back instead.
 *
 * `undefined` means no membership at all — the caller's 403.
 */
export async function memberTenant(
  db: SqlClient,
  userId: string,
  activeOrganizationId?: string | null,
): Promise<TenantContext | undefined> {
  const members = await db.query<{ org_id: string; role: string }>(
    "select org_id, role from member where user_id = $1 order by org_id",
    [userId],
  );
  if (members.rows.length === 0) return undefined;
  const member =
    (activeOrganizationId
      ? members.rows.find((m) => m.org_id === activeOrganizationId)
      : undefined) ?? members.rows[0]!;
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
