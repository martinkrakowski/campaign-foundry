import { safeId } from "../server/lib/auth/id.js";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import { connect } from "./db.js";

/**
 * Grant one user ownership of `local` (PT-1a item 6). Better Auth's own sign-up
 * (magic link or Google) creates a user with no membership, which the tenant
 * middleware answers 403 `no_membership` for (item 3) — this is how the first
 * operator, and only the operator, gets past that: run it once, after they
 * have signed in at least once so their `user` row exists.
 *
 *   yarn auth:bootstrap <email>
 */
export const USAGE = "usage: yarn auth:bootstrap <email>";

/** Make `email`'s user an owner-member of `local`. Idempotent: already-owner is a no-op. */
async function bootstrap(db: SqlClient, email: string): Promise<void> {
  const users = await db.query<{ id: string }>('select id from "user" where email = $1', [email]);
  const user = users.rows[0];
  if (!user) {
    throw new Error(
      `No user with email ${JSON.stringify(email)} has signed in yet. Ask them to sign in once ` +
        "(magic link or Google), then run this again.",
    );
  }
  await db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; role: string }>(
      "select id, role from member where org_id = 'local' and user_id = $1",
      [user.id],
    );
    const member = existing.rows[0];
    if (member) {
      if (member.role.split(",").map((r) => r.trim()).includes("owner")) return;
      await tx.query("update member set role = $1 where id = $2", ["owner", member.id]);
      return;
    }
    await tx.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner', now())",
      [safeId(), user.id],
    );
  });
}

export async function main(
  email: string | undefined,
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (!email) throw new Error(USAGE);
  const db = open();
  try {
    await bootstrap(db, email);
    log(`  ${email} is now an owner of "local".`);
  } finally {
    await db.end();
  }
}
