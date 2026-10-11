import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { findCollidingPairs } from "../colliding-pairs.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

let db: SqlClient;

async function org(id: string): Promise<void> {
  await db.query(`insert into org (id, name) values ($1, $2)`, [id, id]);
}

async function campaign(orgId: string, id: string, slug: string): Promise<void> {
  await db.query(`insert into campaign (id, org_id, slug) values ($1, $2, $3)`, [id, orgId, slug]);
}

describe("findCollidingPairs", () => {
  beforeEach(async () => {
    db = await migratedDatabase();
    await org("acme");
    await org("other");
  });
  afterEach(async () => {
    await db.end();
  });

  test("no campaign slug is another campaign's uuid: no pairs", async () => {
    await campaign("acme", A, "summer");
    await campaign("acme", B, "winter");
    expect(await findCollidingPairs(db)).toEqual([]);
  });

  test("one pair in one organisation is reported with both campaigns", async () => {
    await campaign("acme", A, B);
    await campaign("acme", B, "winter");
    expect(await findCollidingPairs(db)).toEqual([
      { orgId: "acme", slugOwnerId: A, slugOwnerSlug: B, idOwnerId: B, idOwnerSlug: "winter" },
    ]);
  });

  test("a slug equal to a campaign uuid of ANOTHER organisation is not reported", async () => {
    await campaign("acme", A, B);
    await campaign("other", B, "winter");
    expect(await findCollidingPairs(db)).toEqual([]);
  });

  test("a campaign whose slug is its OWN uuid is not a pair", async () => {
    await campaign("acme", C, C);
    expect(await findCollidingPairs(db)).toEqual([]);
  });

  test("an upper-case spelling of the uuid is reported, as the 409 check compares uuids", async () => {
    await campaign("acme", A, B.toUpperCase());
    await campaign("acme", B, "winter");
    const pairs = await findCollidingPairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ slugOwnerId: A, idOwnerId: B });
  });
});
