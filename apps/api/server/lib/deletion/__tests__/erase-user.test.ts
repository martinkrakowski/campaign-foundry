import { beforeEach, afterEach, describe, expect, test } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { eraseUser } from "../erase-user.js";
import { listDue } from "../deletion-store.js";
import {
  ACME_OWNER,
  BYSTANDER,
  LOCAL_OWNER,
  TARGET,
  dumpDatabase,
  failingOn,
  rowsContaining,
  seedWorld,
} from "./erase-user-fixtures.js";
import type { EraseUserCounts, EraseUserRef } from "../erase-user.js";
import type { World } from "./erase-user-fixtures.js";

const EXPECTED_COUNTS: EraseUserCounts = {
  briefVersions: 1,
  decisions: 1,
  providerKeys: 1,
  campaignsDeletedBy: 1,
  deletionsRequestedBy: 1,
  drafts: 1,
  lastOpened: 1,
  verifications: 2,
  invitationsAsInvitee: 1,
  invitationsAsInviter: 1,
  sessions: 1,
  accounts: 1,
  members: 1,
  teamMembers: 1,
  teams: 1,
};

/** The string-valued leaves of an arbitrary value (object keys are not values). */
function collectStrings(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") out.add(v);
    else if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) v.forEach(walk);
      else Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

describe("eraseUser (D240)", () => {
  let db: SqlClient;
  let world: World;

  beforeEach(async () => {
    db = await migratedDatabase();
    world = await seedWorld(db);
  }, 30_000);

  afterEach(async () => {
    await db.end();
  });

  test("eraseUser answers not-found for an unknown user and writes nothing", async () => {
    const before = await dumpDatabase(db);

    const unknown = await eraseUser(db, { userId: "u-nobody" }, { apply: true });
    expect(unknown).toEqual({ outcome: "not-found" });

    const local = await eraseUser(db, { userId: "local" }, { apply: true });
    expect(local).toEqual({ outcome: "not-found" });

    const after = await dumpDatabase(db);
    expect(after).toEqual(before);
  });

  test("eraseUser finds the user by email in any letter case", async () => {
    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { email: "TARGET@Example.com" }, { apply: false });

    expect(outcome).toMatchObject({ outcome: "planned" });
    expect("token" in outcome).toBe(false);
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser finds the user by id", async () => {
    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { userId: "u-target" }, { apply: false });

    expect(outcome).toMatchObject({ outcome: "planned" });
    expect(await dumpDatabase(db)).toEqual(before);
  });

  /** Apply a TARGET erase and return the minted token, asserting `erased`. */
  async function applyTarget(): Promise<string> {
    return erasedOutcome({ userId: TARGET.id });
  }

  /** Erase `ref` and return the token, asserting the outcome was `erased`. */
  async function erasedOutcome(ref: EraseUserRef): Promise<string> {
    const outcome = await eraseUser(db, ref, { apply: true });
    if (outcome.outcome !== "erased") {
      throw new Error(`wanted erased, got ${outcome.outcome}`);
    }
    return outcome.token;
  }

  test("eraseUser replaces brief_version actor with the token and leaves another user untouched", async () => {
    const { rows: beforeActors } = await db.query<{ actor: string }>(
      `select actor from brief_version where campaign_id = $1 order by version`,
      [world.localCampaignId],
    );
    expect(beforeActors.map((r) => r.actor)).toEqual([TARGET.id, BYSTANDER.id]);

    const token = await applyTarget();
    expect(token).toMatch(/^erased:[0-9a-f-]{36}$/);

    const { rows: actors } = await db.query<{ actor: string }>(
      `select actor from brief_version where campaign_id = $1 order by version`,
      [world.localCampaignId],
    );
    expect(actors.map((r) => r.actor)).toEqual([token, BYSTANDER.id]);

    const { rows: targeted } = await db.query<{ n: number }>(
      `select count(*)::int as n from brief_version where actor = $1`,
      [TARGET.id],
    );
    expect(targeted[0]!.n).toBe(0);

    const { rows: acme } = await db.query<{ actor: string }>(
      `select actor from brief_version where campaign_id = $1`,
      [world.acmeCampaignId],
    );
    expect(acme[0]!.actor).toBe(ACME_OWNER.id);
  });

  test("eraseUser replaces decision actor with the token and leaves another user untouched", async () => {
    const token = await applyTarget();

    const { rows: acmeActor } = await db.query<{ actor: string }>(
      `select actor from decision where asset_key = $1`,
      ["ak-target"],
    );
    expect(acmeActor[0]!.actor).toBe(token);

    const { rows: bystanderActor } = await db.query<{ actor: string }>(
      `select actor from decision where asset_key = $1`,
      ["ak-bystander"],
    );
    expect(bystanderActor[0]!.actor).toBe(BYSTANDER.id);

    const { rows: targeted } = await db.query<{ n: number }>(
      `select count(*)::int as n from decision where actor = $1`,
      [TARGET.id],
    );
    expect(targeted[0]!.n).toBe(0);

    const { rows: acmeRow } = await db.query<{ actor: string }>(
      `select actor from decision where asset_key = $1`,
      ["ak-acme"],
    );
    expect(acmeRow[0]!.actor).toBe(ACME_OWNER.id);
  });

  test("eraseUser replaces provider_key created_by with the token and leaves another user untouched", async () => {
    const before = await db.query<{ ciphertext: string; revoked_at: Date | null }>(
      `select ciphertext, revoked_at from provider_key where provider = $1`,
      ["gemini"],
    );

    const token = await applyTarget();

    const { rows: after } = await db.query<{
      ciphertext: string;
      revoked_at: Date | null;
      created_by: string;
    }>(`select ciphertext, revoked_at, created_by from provider_key where provider = $1`, [
      "gemini",
    ]);
    expect(after[0]!.ciphertext).toBe(before.rows[0]!.ciphertext);
    expect(after[0]!.revoked_at).toBeNull();
    expect(after[0]!.created_by).toBe(token);

    const { rows: other } = await db.query<{ created_by: string }>(
      `select created_by from provider_key where provider = $1`,
      ["openrouter"],
    );
    expect(other[0]!.created_by).toBe(BYSTANDER.id);
  });

  test("eraseUser replaces campaign deleted_by with the token and leaves another user untouched", async () => {
    const { rows: beforeLocal } = await db.query<{
      deleted_by: string | null;
      tombstoned: boolean;
    }>(
      `select deleted_by, deleted_at is not null as tombstoned from campaign where org_id = 'local' and slug = 'c-local'`,
    );
    expect(beforeLocal[0]!.deleted_by).toBe(TARGET.id);
    expect(beforeLocal[0]!.tombstoned).toBe(true);

    const token = await applyTarget();

    const { rows: localCampaign } = await db.query<{ deleted_by: string | null }>(
      `select deleted_by from campaign where org_id = 'local' and slug = 'c-local'`,
    );
    expect(localCampaign[0]!.deleted_by).toBe(token);

    const { rows: localTombstone } = await db.query<{ tombstoned: boolean }>(
      `select deleted_at is not null as tombstoned from campaign where org_id = 'local' and slug = 'c-local'`,
    );
    expect(localTombstone[0]!.tombstoned).toBe(true);

    const { rows: bystander } = await db.query<{ deleted_by: string | null }>(
      `select deleted_by from campaign where slug = 'c-bystander'`,
    );
    expect(bystander[0]!.deleted_by).toBe(BYSTANDER.id);

    const { rows: acme } = await db.query<{ deleted_by: string | null }>(
      `select deleted_by from campaign where slug = 'c-acme'`,
    );
    expect(acme[0]!.deleted_by).toBeNull();
  });

  test("eraseUser replaces deletion requested_by with the token and leaves another user untouched", async () => {
    const { rows: beforeTarget } = await db.query<{ requested_by: string }>(
      `select requested_by from deletion where kind = 'campaign' and subject = $1`,
      [world.localCampaignId],
    );
    expect(beforeTarget[0]!.requested_by).toBe(TARGET.id);

    const token = await applyTarget();

    const { rows: targetRow } = await db.query<{ requested_by: string }>(
      `select requested_by from deletion where kind = 'campaign' and subject = $1`,
      [world.localCampaignId],
    );
    expect(targetRow[0]!.requested_by).toBe(token);

    const { rows: bystanderRow } = await db.query<{ requested_by: string }>(
      `select requested_by from deletion where requested_by = $1`,
      [BYSTANDER.id],
    );
    expect(bystanderRow[0]!.requested_by).toBe(BYSTANDER.id);

    const { rows: leftBehind } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where requested_by = $1`,
      [TARGET.id],
    );
    expect(leftBehind[0]!.n).toBe(0);
  });

  test("eraseUser deletes the draft and last_opened rows of the user only", async () => {
    const { rows: beforeTarget } = await db.query<{ n: number }>(
      `select count(*)::int as n from draft where user_id = $1`,
      [TARGET.id],
    );
    expect(beforeTarget[0]!.n).toBe(1);
    const { rows: beforeBystander } = await db.query<{ state: unknown }>(
      `select state from draft where user_id = $1`,
      [BYSTANDER.id],
    );
    expect(beforeBystander[0]!.state).toEqual({});

    await applyTarget();

    const { rows: targetDrafts } = await db.query<{ n: number }>(
      `select count(*)::int as n from draft where user_id = $1`,
      [TARGET.id],
    );
    expect(targetDrafts[0]!.n).toBe(0);
    const { rows: targetOpened } = await db.query<{ n: number }>(
      `select count(*)::int as n from last_opened where user_id = $1`,
      [TARGET.id],
    );
    expect(targetOpened[0]!.n).toBe(0);

    const { rows: bystanderDraft } = await db.query<{ state: unknown }>(
      `select state from draft where user_id = $1`,
      [BYSTANDER.id],
    );
    expect(bystanderDraft[0]!.state).toEqual({});
    const { rows: bystanderOpened } = await db.query<{ n: number }>(
      `select count(*)::int as n from last_opened where user_id = $1`,
      [BYSTANDER.id],
    );
    expect(bystanderOpened[0]!.n).toBe(1);
  });

  test("eraseUser deletes verification rows whose identifier is the email", async () => {
    const { rows: before } = await db.query<{ n: number }>(
      `select count(*)::int as n from verification where id = 'v-1'`,
    );
    expect(before[0]!.n).toBe(1);

    await applyTarget();

    const { rows: v1 } = await db.query<{ id: string }>(
      `select id from verification where id = 'v-1'`,
    );
    expect(v1).toEqual([]);
    const { rows: v3 } = await db.query<{ id: string }>(
      `select id from verification where id = 'v-3'`,
    );
    expect(v3.length).toBe(1);
  });

  test("eraseUser deletes magic-link verification rows whose value holds the email", async () => {
    const { rows: before } = await db.query<{ n: number }>(
      `select count(*)::int as n from verification where id = 'v-2'`,
    );
    expect(before[0]!.n).toBe(1);

    await applyTarget();

    const { rows: v2 } = await db.query<{ id: string }>(
      `select id from verification where id = 'v-2'`,
    );
    expect(v2).toEqual([]);

    const { rows: v4 } = await db.query<{ value: string }>(
      `select value from verification where id = 'v-4'`,
    );
    expect(v4[0]!.value).toBe(
      JSON.stringify({ email: "bystander@example.com", name: "Bystander Person" }),
    );
  });

  test("eraseUser keeps a verification row whose value holds a longer address containing the email", async () => {
    await db.query(
      `insert into verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + interval '1 hour')`,
      ["v-5", "tok-long", JSON.stringify({ email: "bigtarget@example.com", name: "X" })],
    );

    const { rows: before } = await db.query<{ n: number }>(
      `select count(*)::int as n from verification where id = 'v-5'`,
    );
    expect(before[0]!.n).toBe(1);

    await applyTarget();

    const { rows: v5 } = await db.query<{ id: string }>(
      `select id from verification where id = 'v-5'`,
    );
    expect(v5.length).toBe(1);
  });

  test("eraseUser deletes invitations sent to the email in any letter case", async () => {
    const { rows: beforeInv1 } = await db.query<{ n: number }>(
      `select count(*)::int as n from invitation where id = 'inv-1'`,
    );
    expect(beforeInv1[0]!.n).toBe(1);

    await applyTarget();

    const { rows: inv1 } = await db.query<{ id: string }>(
      `select id from invitation where id = 'inv-1'`,
    );
    expect(inv1).toEqual([]);

    const { rows: inv2 } = await db.query<{ id: string }>(
      `select id from invitation where id = 'inv-2'`,
    );
    expect(inv2.length).toBe(1);
  });

  test("eraseUser cascades session account member and team_member and invitations the user sent", async () => {
    const targets = [
      ["session", "user_id"],
      ["account", "user_id"],
      ["member", "user_id"],
      ["team_member", "user_id"],
    ] as const;
    for (const [table, col] of targets) {
      const { rows: before } = await db.query<{ n: number }>(
        `select count(*)::int as n from "${table}" where ${col} = $1`,
        [TARGET.id],
      );
      expect(before[0]!.n).toBe(1);
    }
    const { rows: beforeUser } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = $1`,
      [TARGET.id],
    );
    expect(beforeUser[0]!.n).toBe(1);
    const { rows: beforeInv3 } = await db.query<{ n: number }>(
      `select count(*)::int as n from invitation where id = 'inv-3'`,
    );
    expect(beforeInv3[0]!.n).toBe(1);

    await applyTarget();

    for (const [table, col] of targets) {
      const { rows: after } = await db.query<{ n: number }>(
        `select count(*)::int as n from "${table}" where ${col} = $1`,
        [TARGET.id],
      );
      expect(after[0]!.n).toBe(0);
    }
    const { rows: afterUser } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = $1`,
      [TARGET.id],
    );
    expect(afterUser[0]!.n).toBe(0);
    const { rows: afterInv3 } = await db.query<{ n: number }>(
      `select count(*)::int as n from invitation where id = 'inv-3'`,
    );
    expect(afterInv3[0]!.n).toBe(0);

    const { rows: bystanderTeams } = await db.query<{ n: number }>(
      `select count(*)::int as n from team_member where user_id = $1`,
      [BYSTANDER.id],
    );
    expect(bystanderTeams[0]!.n).toBe(2);
    const { rows: bystanderUser } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = $1`,
      [BYSTANDER.id],
    );
    expect(bystanderUser[0]!.n).toBe(1);
    const { rows: inv2 } = await db.query<{ n: number }>(
      `select count(*)::int as n from invitation where id = 'inv-2'`,
    );
    expect(inv2[0]!.n).toBe(1);
  });

  test("eraseUser recounts memberCount for the teams the user left", async () => {
    const { rows: beforeA } = await db.query<{ memberCount: number }>(
      `select "memberCount" from team where id = 'team-a'`,
    );
    expect(beforeA[0]!.memberCount).toBe(2);
    const { rows: beforeB } = await db.query<{ memberCount: number }>(
      `select "memberCount" from team where id = 'team-b'`,
    );
    expect(beforeB[0]!.memberCount).toBe(7);

    await applyTarget();

    const { rows: afterA } = await db.query<{ memberCount: number }>(
      `select "memberCount" from team where id = 'team-a'`,
    );
    expect(afterA[0]!.memberCount).toBe(1);
    const { rows: afterB } = await db.query<{ memberCount: number }>(
      `select "memberCount" from team where id = 'team-b'`,
    );
    expect(afterB[0]!.memberCount).toBe(7);
  });

  test("eraseUser inserts one user deletion row that is already purged and holds only the token", async () => {
    const token = await applyTarget();

    const { rows } = await db.query<{
      org_id: string | null;
      kind: string;
      subject: string;
      requested_by: string;
      purged_at: Date | null;
      attempts: number;
      claimed_until: Date | null;
    }>(
      `select org_id, kind, subject, requested_by, purged_at, attempts, claimed_until
         from deletion where kind = 'user'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.org_id).toBeNull();
    expect(rows[0]!.kind).toBe("user");
    expect(rows[0]!.subject).toBe(token);
    expect(rows[0]!.requested_by).toBe("cli:erase-user");
    expect(rows[0]!.purged_at).not.toBeNull();
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.claimed_until).toBeNull();

    const due = await listDue(db);
    expect(due.filter((d) => d.kind === "user")).toEqual([]);
  });

  test("eraseUser refuses the only owner of an org and writes nothing", async () => {
    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { userId: LOCAL_OWNER.id }, { apply: true });

    expect(outcome).toEqual({ outcome: "sole-owner", orgIds: ["local"] });
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser refuses when one of several orgs has the user as its only owner", async () => {
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'acme', $2, 'admin', now())",
      ["m-lo-acme", LOCAL_OWNER.id],
    );
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner', now())",
      ["m-acme-local", ACME_OWNER.id],
    );

    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { userId: ACME_OWNER.id }, { apply: true });

    expect(outcome).toEqual({ outcome: "sole-owner", orgIds: ["acme"] });
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser proceeds when another member also owns the org", async () => {
    await db.query(
      `update member set role = 'owner,admin' where org_id = 'local' and user_id = $1`,
      [BYSTANDER.id],
    );

    const beforeOwners = await db.query<{ user_id: string }>(
      `select user_id from member where org_id = 'local'
         and string_to_array(replace(role, ' ', ''), ',') @> array['owner']
       order by user_id`,
    );
    expect(beforeOwners.rows.map((r) => r.user_id)).toEqual([BYSTANDER.id, LOCAL_OWNER.id]);

    const token = await erasedOutcome({ userId: LOCAL_OWNER.id });

    const { rows: owners } = await db.query<{ user_id: string }>(
      `select user_id from member where org_id = 'local'
         and string_to_array(replace(role, ' ', ''), ',') @> array['owner']
       order by user_id`,
    );
    expect(owners).toEqual([{ user_id: BYSTANDER.id }]);

    const { rows: count } = await db.query<{ n: number }>(
      `select count(*)::int as n from member where org_id = 'local'
         and string_to_array(replace(role, ' ', ''), ',') @> array['owner']`,
    );
    expect(count[0]!.n).toBe(1);
    expect(token).toMatch(/^erased:[0-9a-f-]{36}$/);
  });

  test("eraseUser proceeds for an admin who is not an owner", async () => {
    const { rows: before } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = $1`,
      [TARGET.id],
    );
    expect(before[0]!.n).toBe(1);

    const token = await erasedOutcome({ userId: TARGET.id });
    expect(token).toMatch(/^erased:[0-9a-f-]{36}$/);

    const { rows: after } = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = $1`,
      [TARGET.id],
    );
    expect(after[0]!.n).toBe(0);
  });

  test("eraseUser dry run reports counts and changes nothing", async () => {
    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: false });

    expect(outcome).toMatchObject({ outcome: "planned" });
    expect("token" in outcome).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(outcome, "counts") &&
        (outcome as { counts: EraseUserCounts }).counts,
    ).toEqual(EXPECTED_COUNTS);
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser dry run reports the sole owner refusal", async () => {
    const before = await dumpDatabase(db);

    const outcome = await eraseUser(db, { userId: LOCAL_OWNER.id }, { apply: false });

    expect(outcome).toEqual({ outcome: "sole-owner", orgIds: ["local"] });
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser reports the counts of what it changed", async () => {
    const planned = await eraseUser(db, { email: TARGET.email }, { apply: false });
    expect(planned.outcome).toBe("planned");

    const applied = await eraseUser(db, { email: TARGET.email }, { apply: true });
    expect(applied.outcome).toBe("erased");

    expect((applied as { counts: EraseUserCounts }).counts).toEqual(EXPECTED_COUNTS);
    expect((planned as { counts: EraseUserCounts }).counts).toEqual(
      (applied as { counts: EraseUserCounts }).counts,
    );
  });

  test("eraseUser a second run after an erase is a no-op", async () => {
    const first = await eraseUser(db, { email: TARGET.email }, { apply: true });
    expect(first.outcome).toBe("erased");
    const afterFirst = await dumpDatabase(db);

    const second = await eraseUser(db, { email: TARGET.email }, { apply: true });
    expect(second).toEqual({ outcome: "not-found" });

    expect(await dumpDatabase(db)).toEqual(afterFirst);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from deletion where kind = 'user'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  test("eraseUser leaves another org and another user untouched", async () => {
    const beforeAcme = await rowsContaining(db, "acme");
    const beforeBystander = await rowsContaining(db, "u-bystander");
    expect(beforeAcme.length).toBeGreaterThan(0);
    expect(beforeBystander.length).toBeGreaterThan(0);

    await applyTarget();

    expect(await rowsContaining(db, "acme")).toEqual(beforeAcme);
    expect(await rowsContaining(db, "u-bystander")).toEqual(beforeBystander);
  });

  test("eraseUser leaves no row anywhere holding the email name or user id", async () => {
    for (const needle of [TARGET.email, TARGET.name, TARGET.id]) {
      expect((await rowsContaining(db, needle)).length).toBeGreaterThan(0);
    }

    await applyTarget();

    for (const needle of [TARGET.email, TARGET.name, TARGET.id]) {
      expect(await rowsContaining(db, needle)).toEqual([]);
    }
  });

  test("eraseUser outcome carries no email name or user id", async () => {
    const erased = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    expect(erased.outcome).toBe("erased");
    const erasedJson = JSON.stringify(erased);
    expect(erasedJson).not.toContain(TARGET.email);
    expect(erasedJson).not.toContain(TARGET.name);
    expect(erasedJson).not.toContain(TARGET.id);
    const token = (erased as { token: string }).token;
    expect(collectStrings(erased)).toEqual(new Set(["erased", token]));

    const sole = await eraseUser(db, { userId: LOCAL_OWNER.id }, { apply: false });
    expect(sole.outcome).toBe("sole-owner");
    const soleJson = JSON.stringify(sole);
    expect(soleJson).not.toContain(LOCAL_OWNER.email);
    expect(soleJson).not.toContain(LOCAL_OWNER.name);
    expect(soleJson).not.toContain(LOCAL_OWNER.id);
  });

  test("eraseUser rolls back every earlier step when the last step fails", async () => {
    const before = await dumpDatabase(db);

    await expect(
      eraseUser(failingOn(db, "insert into deletion"), { userId: TARGET.id }, { apply: true }),
    ).rejects.toThrow("injected failure");

    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("eraseUser rolls back every earlier step when deleting the user fails", async () => {
    const before = await dumpDatabase(db);

    await expect(
      eraseUser(failingOn(db, 'delete from "user"'), { userId: TARGET.id }, { apply: true }),
    ).rejects.toThrow("injected failure");

    expect(await dumpDatabase(db)).toEqual(before);
  });
});
