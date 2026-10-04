import { describe, test, expect } from "vitest";
import type { AssetEntry } from "@/lib/briefs-api";
import { assetRefFor, describeAssetRef, isAssetId, refMatchesAsset } from "../asset-refs";
import * as messages from "@/components/campaign/messages";
// The same cross-app import `ceiling-parity.test.ts` and `validate.test.ts` make: a
// mirror tested without the thing it mirrors is exactly the drift these tests exist
// to catch. `isAssetId` is copied from the API's asset-store port, and if the two
// ever disagree then a ref the server reads as a path is displayed as an id (a
// filename the operator never uploaded) or the reverse — a bare uuid where a name
// should be, with no way to tell from the UI which one is showing.
import { isAssetId as isAssetIdOnServer } from "../../../../api/server/lib/ports/asset-store.port";

/** A lower-case canonical uuid — the only shape the server stores an id in. */
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
/** A second one, so "another entry's id" is never accidentally this entry's. */
const OTHER_ID = "9c5b94b1-35ad-49bb-b118-8e8fc24af80e";

/** An s3-shaped listing entry: the object backend's `ObjectAssetStore` sets `id`. */
const s3Entry: AssetEntry = {
  id: ID,
  name: "hydra-logo.png",
  type: "image/png",
  size: 2048,
  thumbnailUrl: "/api/pipeline/campaigns/assets?briefId=camp-1&name=hydra-logo.png",
};

/** An fs-shaped listing entry: `FsAssetStore` never sets an `id` key at all. */
const fsEntry: AssetEntry = {
  name: "hydra-logo.png",
  type: "image/png",
  size: 2048,
  thumbnailUrl: "",
};

describe("isAssetId", () => {
  // One table, both implementations. D203 makes this decision once for the whole
  // stack, and the web's copy is the one a user would SEE the result of.
  const table: readonly { readonly ref: string; readonly id: boolean; readonly why: string }[] = [
    { ref: ID, id: true, why: "a lower-case uuid is what the server stores" },
    {
      ref: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
      id: false,
      why: "upper-case is not canonical, and the server would read it as a path",
    },
    { ref: `assets/inputs/${ID}/x.png`, id: false, why: "a path is a path whatever it contains" },
    { ref: "assets/inputs/hydra-logo.png", id: false, why: "today's filesystem ref" },
    { ref: "", id: false, why: "no ref at all" },
    { ref: ` ${ID} `, id: false, why: "a padded uuid is a typo, not an id" },
  ];

  for (const { ref, id, why } of table) {
    test(`${id ? "reads" : "refuses"} ${why}: ${JSON.stringify(ref)}`, () => {
      expect(isAssetId(ref)).toBe(id);
    });
  }

  test("agrees with the API's copy on every row of that table", () => {
    for (const { ref, id } of table) {
      // Both sides asserted, not only their agreement: a pair of functions that
      // agreed on being wrong would pass a comparison alone.
      expect(isAssetIdOnServer(ref)).toBe(id);
      expect(isAssetId(ref)).toBe(id);
      expect(isAssetId(ref)).toBe(isAssetIdOnServer(ref));
    }
  });
});

describe("assetRefFor", () => {
  test("stores the id when the listing carries one", () => {
    expect(assetRefFor(s3Entry, "camp-1")).toBe(ID);
  });

  test("stores today's path when the entry has no id (fs)", () => {
    expect(assetRefFor(fsEntry, "camp-1")).toBe("assets/inputs/camp-1/hydra-logo.png");
  });

  test("refuses a malformed id rather than storing a ref the server would read as a path", () => {
    expect(assetRefFor({ ...s3Entry, id: "NOT-A-UUID" }, "camp-1")).toBe(
      "assets/inputs/camp-1/hydra-logo.png",
    );
    // Upper-case is the near-miss: it LOOKS like an id and is not one.
    expect(assetRefFor({ ...s3Entry, id: ID.toUpperCase() }, "camp-1")).toBe(
      "assets/inputs/camp-1/hydra-logo.png",
    );
  });
});

describe("refMatchesAsset", () => {
  test("matches an entry by its id", () => {
    expect(refMatchesAsset(ID, s3Entry, "camp-1")).toBe(true);
  });

  test("matches an entry by the campaign path (fs)", () => {
    expect(refMatchesAsset("assets/inputs/camp-1/hydra-logo.png", fsEntry, "camp-1")).toBe(true);
  });

  test("matches an entry by the bare filename (a ref typed into the mirror input)", () => {
    expect(refMatchesAsset("hydra-logo.png", fsEntry, "camp-1")).toBe(true);
  });

  test("refuses another entry's id", () => {
    expect(refMatchesAsset(OTHER_ID, s3Entry, "camp-1")).toBe(false);
  });

  test("refuses another campaign's path for the same filename", () => {
    expect(refMatchesAsset("assets/inputs/camp-2/hydra-logo.png", fsEntry, "camp-1")).toBe(false);
  });

  test("refuses no ref at all", () => {
    expect(refMatchesAsset(undefined, fsEntry, "camp-1")).toBe(false);
    expect(refMatchesAsset(undefined, s3Entry, "camp-1")).toBe(false);
  });
});

describe("describeAssetRef", () => {
  test("a path ref shows its basename and resolves nothing", () => {
    expect(describeAssetRef("assets/inputs/camp-1/hydra-logo.png", [s3Entry])).toStrictEqual({
      label: "hydra-logo.png",
      state: "path",
    });
  });

  test("a path with no slash is its own basename", () => {
    expect(describeAssetRef("hydra-logo.png", undefined)).toStrictEqual({
      label: "hydra-logo.png",
      state: "path",
    });
  });

  test("an id resolves to the listing entry's name, thumbnail and size", () => {
    expect(describeAssetRef(ID, [s3Entry])).toStrictEqual({
      label: "hydra-logo.png",
      thumbnailUrl: s3Entry.thumbnailUrl,
      size: 2048,
      state: "found",
    });
  });

  test("an id whose listing has not arrived says it is loading, never the uuid", () => {
    const described = describeAssetRef(ID, undefined);
    expect(described.state).toBe("pending");
    expect(described.label).toBe("Loading asset…");
    expect(described.label).not.toContain(ID);
    expect(described.thumbnailUrl).toBeUndefined();
    expect(described.size).toBeUndefined();
  });

  test("an id no listing entry carries is unavailable, never the uuid", () => {
    // Three listings, three ways the answer is "not here": nothing at all, a
    // filesystem listing that carries no ids by construction, and a listing of
    // OTHER assets — an id that is not this one must not be mistaken for it.
    const otherEntry: AssetEntry = { ...s3Entry, id: OTHER_ID, name: "summer.png" };
    for (const listing of [[], [fsEntry], [otherEntry]] as const) {
      const described = describeAssetRef(ID, listing);
      expect(described.state).toBe("unavailable");
      expect(described.label).toBe("Unavailable asset");
      expect(described.label).not.toContain(ID);
      expect(described.thumbnailUrl).toBeUndefined();
      expect(described.size).toBeUndefined();
    }
  });

  test("a deleted asset's id is unavailable rather than pending — an empty listing is an answer", () => {
    // The distinction the two states exist for: `undefined` means nobody has asked,
    // `[]` means the ask came back with nothing. Reading "Loading…" off the second
    // is a field stuck on a promise that already resolved.
    expect(describeAssetRef(ID, undefined).state).toBe("pending");
    expect(describeAssetRef(ID, []).state).toBe("unavailable");
  });

  // The `refetching` claim at the helper, which the pending label's whole reason
  // for existing rests on. `listing === undefined` and `refetching` are different
  // claims — nobody has asked, versus the ask is in flight — and only the second one
  // is temporary, so only the second one may say "Loading".
  test("a refetch in flight reads pending; only a settled listing may say unavailable", () => {
    // Only listings that do NOT hold the id: a listing that holds it has already
    // resolved it, and no fetch in flight makes that unresolved.
    for (const listing of [undefined, [], [fsEntry]] as const) {
      const inFlight = describeAssetRef(ID, listing, true);
      expect(inFlight.state, JSON.stringify(listing)).toBe("pending");
      expect(inFlight.label).toBe(messages.assetPending);
      expect(inFlight.label).not.toContain(ID);
    }
    // And with nothing in flight, the same absent ids are a verdict.
    expect(describeAssetRef(ID, [], false).state).toBe("unavailable");
    expect(describeAssetRef(ID, [fsEntry], false).state).toBe("unavailable");
    // A listing that never arrived is pending whatever else is true, because nobody
    // has asked yet — `refetching` cannot un-ask.
    expect(describeAssetRef(ID, undefined, false).state).toBe("pending");
    // A resolved ref is a name either way; the fetch does not change that.
    expect(describeAssetRef(ID, [s3Entry], true).state).toBe("found");
    // A path resolves itself, so it is never pending whatever is in flight.
    expect(describeAssetRef("assets/inputs/camp/x.png", undefined, true).state).toBe("path");
  });

  test("two ids resolve independently from one listing", () => {
    const second: AssetEntry = { ...s3Entry, id: OTHER_ID, name: "summer.png" };
    const listing = [s3Entry, second];
    expect(describeAssetRef(ID, listing).label).toBe("hydra-logo.png");
    expect(describeAssetRef(OTHER_ID, listing).label).toBe("summer.png");
  });
});
