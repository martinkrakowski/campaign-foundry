import { UUID_PATTERN } from "../object-store/object-keys.js";
import type { SqlQuery } from "../db/sql-client.js";

/** One pair: `slugOwner`'s slug is the uuid of `idOwner`, in the same organisation. */
export interface CollidingPair {
  readonly orgId: string;
  readonly slugOwnerId: string;
  readonly slugOwnerSlug: string;
  readonly idOwnerId: string;
  readonly idOwnerSlug: string;
}

interface PairRow {
  org_id: string;
  a_id: string;
  a_slug: string;
  b_id: string;
  b_slug: string;
}

/**
 * Every pair of campaigns of one organisation where the first one's slug is the uuid
 * of the second (FU-slug-uuid-409, #774, refuses to CREATE such a slug; pairs that
 * existed before it were left alone). A campaign whose slug is its own uuid is not a
 * pair. Tombstoned campaigns count, as in #774. One SELECT; nothing is written.
 */
export async function findCollidingPairs(db: SqlQuery): Promise<CollidingPair[]> {
  const { rows } = await db.query<PairRow>(
    `select a.org_id, a.id as a_id, a.slug as a_slug, b.id as b_id, b.slug as b_slug
       from campaign a
       join campaign b
                 on b.org_id = a.org_id and b.id <> a.id and b.id::text = lower(a.slug)
      where a.slug ~* $1
      order by a.org_id, a.id, b.id`,
    [UUID_PATTERN.source],
  );
  return rows.map((r) => ({
    orgId: r.org_id,
    slugOwnerId: r.a_id,
    slugOwnerSlug: r.a_slug,
    idOwnerId: r.b_id,
    idOwnerSlug: r.b_slug,
  }));
}
