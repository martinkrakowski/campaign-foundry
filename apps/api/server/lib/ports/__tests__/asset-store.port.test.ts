import { describe, expect, test } from "vitest";
import { isAssetId } from "../asset-store.port.js";

/**
 * `isAssetId` alone (PT-4k1) — D203's shape rule, the ONE discriminator between a
 * ref that names an asset and a ref that names a path.
 *
 * It is pure and imports nothing, so this file needs no harness, no database and
 * no `S3_*`. That is the point of keeping the rule in one pure function: the
 * route's write-side checks (PT-4k2), `ObjectInputAssets`' id branch and the two
 * adapters' `readAssetById`/`assetOwner` all ask the same question, and a second
 * copy of it is how an id and a path come to be told apart two different ways.
 */

/** The shape `randomUUID` and Postgres both render an `asset.id` in. */
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("isAssetId (PT-4k1, D203)", () => {
  test("a lower-case uuid is an id", () => {
    expect(isAssetId(ID)).toBe(true);
    // The extremes of the alphabet, which a `[0-9a-z]`-style pattern would admit
    // and a `[0-9a-f]` one must not.
    expect(isAssetId("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isAssetId("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
  });

  test("an UPPER-CASE uuid is NOT an id, and this is load-bearing (C1)", () => {
    // NOT tidy: `asset.id` is a `uuid` column, and Postgres renders a uuid in
    // LOWER case, so no row can ever hold this. Case-insensitively accepting it
    // would let `a.id = $2` bind it and raise `22P02` — a 500 where the promise
    // is `undefined`. This is the case that catches a reuse of the neighbouring
    // `CAMPAIGN_UUID_PATTERN`, which carries the `/i` flag.
    expect(isAssetId(ID.toUpperCase())).toBe(false);
    // Mixed case too, for the same reason and the same mechanism.
    expect(isAssetId("3F2504E0-4f89-41D3-9a0c-0305e82c3301")).toBe(false);
  });

  test("the wrong length is not an id", () => {
    // One group short, one group long, and no dashes at all: three separate ways
    // to be near the shape without being it.
    expect(isAssetId("3f2504e0-4f89-41d3-9a0c-0305e82c330")).toBe(false);
    expect(isAssetId("3f2504e0-4f89-41d3-9a0c-0305e82c33012")).toBe(false);
    expect(isAssetId("3f2504e04f8941d39a0c0305e82c3301")).toBe(false);
    // Groups of the right count and the wrong sizes.
    expect(isAssetId("3f2504e-4f89-41d3-9a0c-0305e82c3301")).toBe(false);
    // And a trailing character the anchor must not let through.
    expect(isAssetId(`${ID}\n`)).toBe(false);
    expect(isAssetId(` ${ID}`)).toBe(false);
  });

  test("a path is not an id — the other half of the rule", () => {
    // The whole point of shape over prefix: D203 makes it the only
    // discriminator, so a ref that merely LOOKS path-ish must not be an id.
    expect(isAssetId("assets/inputs/winter-sale/logo.png")).toBe(false);
    expect(isAssetId("logo.png")).toBe(false);
    expect(isAssetId("assets/inputs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/logo.png")).toBe(false);
    // A slug that is uuid-shaped: nothing stops an operator naming a campaign
    // that, and D203's rule is that shape alone decides — which is exactly why the
    // rule must be narrow enough that only a uuid can pass it.
    expect(isAssetId("winter-sale")).toBe(false);
    // The demo ref the repo ships, root level and with no campaign.
    expect(isAssetId("assets/inputs/hydra-logo.png")).toBe(false);
  });

  test("the empty string is not an id", () => {
    // Named separately because `resolveAssetPath` answers `undefined` for it too,
    // and the two must not be confusable: this one never reaches a query, that one
    // reaches none either, and a caller that reads the difference as "unsafe"
    // would blame the brief.
    expect(isAssetId("")).toBe(false);
  });

  test("a bare hyphen run is not an id", () => {
    // The degenerate shape: the right number of separators and nothing else.
    expect(isAssetId("--------")).toBe(false);
    expect(isAssetId("-".repeat(36))).toBe(false);
  });
});
