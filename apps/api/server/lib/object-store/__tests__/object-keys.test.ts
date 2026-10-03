import { describe, test, expect } from "vitest";
import { cachePrefix, inputKey, inputPrefix, packagePrefix, renderPrefix } from "../object-keys.js";

const ORG = "local";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const ASSET = "9c8b7a65-4d3c-4b2a-8f1e-0d9c8b7a6e5d";

describe("the C7 input key builder (PT-4b)", () => {
  test("inputKey is org/campaign/<uuid>/inputs/<uuid> and carries neither a slug nor a name", () => {
    expect(inputKey(ORG, CAMPAIGN, ASSET)).toBe(`org/local/campaign/${CAMPAIGN}/inputs/${ASSET}`);
  });

  test("inputPrefix is the same key with a trailing separator, so it is a real prefix", () => {
    const prefix = inputPrefix(ORG, CAMPAIGN);
    expect(prefix).toBe(`org/local/campaign/${CAMPAIGN}/inputs/`);
    // The trailing `/` is what keeps a neighbouring namespace out: without it
    // the prefix would also match `…/inputs-legacy/…` or any other segment
    // starting with "inputs", and `deletePrefix` would empty those too.
    expect(inputKey(ORG, CAMPAIGN, ASSET).startsWith(prefix)).toBe(true);
    expect(inputKey(ORG, CAMPAIGN, ASSET).startsWith(prefix.slice(0, -1))).toBe(true);
  });

  test("two campaigns in one org never share a prefix, and one campaign in two orgs never does either", () => {
    const other = "00000000-0000-4000-8000-000000000001";
    expect(inputPrefix(ORG, CAMPAIGN)).not.toBe(inputPrefix(ORG, other));
    expect(inputPrefix(ORG, CAMPAIGN)).not.toBe(inputPrefix("other", CAMPAIGN));
  });

  describe("every segment is checked against its OWN id pattern", () => {
    // One marker for every refused value, so a single assertion proves the
    // message names the parameter and not the value — the words "campaign" and
    // "asset" are in the message itself and would otherwise make a
    // value-shaped substring check meaningless.
    const MARKER = "MARKER-7f3a";
    const refused: readonly (readonly [string, () => unknown])[] = [
      ["a missing org id", () => inputKey("", CAMPAIGN, ASSET)],
      ["an org id with a slash", () => inputKey(`acme/../${MARKER}`, CAMPAIGN, ASSET)],
      ["an org id over 128 characters", () => inputKey(`o${MARKER}`.repeat(40), CAMPAIGN, ASSET)],
      ["a campaign id that is a slug", () => inputKey(ORG, MARKER, ASSET)],
      ["an asset id that is a name", () => inputKey(ORG, CAMPAIGN, `${MARKER}.png`)],
      ["a prefix with a slug", () => inputPrefix(ORG, MARKER)],
    ];

    for (const [what, call] of refused) {
      test(`${what} is refused, naming the parameter and not the value`, () => {
        let thrown: unknown;
        try {
          call();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toMatch(/^Refusing an object key: the (org|campaign|asset) id/);
        expect(message).not.toContain(MARKER);
      });
    }
  });

  test("an org id of the shapes Better Auth mints is accepted", () => {
    // Looser than a brief id on purpose: an org id comes from the auth
    // provider's namespace, not from `slugify`.
    for (const orgId of ["local", "Acme", "acme_1", "a-b-C_9", "o".repeat(128)]) {
      expect(inputKey(orgId, CAMPAIGN, ASSET)).toBe(
        `org/${orgId}/campaign/${CAMPAIGN}/inputs/${ASSET}`,
      );
    }
  });
});

// PT-4e. The render and cache prefixes sit beside `inputPrefix` in one file
// because they are ONE rule — a key is ids, a segment and a trailing separator,
// with nothing a user can rename anywhere in it — and three copies of it would
// be three chances to leave a slug behind in the third.
describe("the render and cache prefixes (PT-4e)", () => {
  test("renderPrefix is the input prefix with `renders` in place of `inputs`", () => {
    expect(renderPrefix(ORG, CAMPAIGN)).toBe(`org/${ORG}/campaign/${CAMPAIGN}/renders/`);
    // The trailing `/` is load-bearing here too: without it `deletePrefix` on a
    // render namespace would also match `renders-archive/…`.
    expect(renderPrefix(ORG, CAMPAIGN).startsWith("org/local/campaign/")).toBe(true);
  });

  test("cachePrefix is org-scoped and outside the campaign shape (D203)", () => {
    expect(cachePrefix(ORG)).toBe("org/local/cache/");
    // Deliberately not `org/<orgId>/campaign/<uuid>/cache/`: a cache entry
    // belongs to the prompt that produced it, not to the campaign that happened
    // to ask for it first.
    expect(cachePrefix(ORG)).not.toContain(CAMPAIGN);
    expect(cachePrefix(ORG)).not.toContain("campaign/");
  });

  test("two campaigns never share a render prefix, and two orgs never share a cache prefix", () => {
    const other = "00000000-0000-4000-8000-000000000001";
    expect(renderPrefix(ORG, CAMPAIGN)).not.toBe(renderPrefix(ORG, other));
    expect(renderPrefix(ORG, CAMPAIGN)).not.toBe(renderPrefix("other", CAMPAIGN));
    expect(cachePrefix(ORG)).not.toBe(cachePrefix("other"));
    // And the render prefix can never be a prefix of the cache one, so emptying
    // either leaves the other alone.
    expect(cachePrefix(ORG).startsWith(renderPrefix(ORG, CAMPAIGN))).toBe(false);
  });

  describe("every id is checked against its OWN pattern here too", () => {
    const MARKER = "MARKER-7f3a";
    const refused: readonly (readonly [string, () => unknown])[] = [
      ["a render prefix with a missing org id", () => renderPrefix("", CAMPAIGN)],
      ["a render prefix with a slug for a campaign id", () => renderPrefix(ORG, MARKER)],
      ["a cache prefix with an org id holding a slash", () => cachePrefix(`acme/../${MARKER}`)],
      ["a cache prefix with no org id at all", () => cachePrefix("")],
    ];

    for (const [what, call] of refused) {
      test(`${what} is refused, naming the parameter and not the value`, () => {
        let thrown: unknown;
        try {
          call();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toMatch(/^Refusing an object key: the (org|campaign) id/);
        expect(message).not.toContain(MARKER);
      });
    }
  });
});

// PT-4h1. The package prefix is the fourth member of the same family, and the
// only thing that makes it a PREFIX rather than a string is the trailing `/`:
// everything below it is a `<platformId>/<generation>/…` key, and `deletePrefix`
// at commit time is what empties an older generation.
describe("the package prefix (PT-4h1)", () => {
  test("packagePrefix is the render prefix with `packages` in place of `renders`", () => {
    expect(packagePrefix(ORG, CAMPAIGN)).toBe(`org/${ORG}/campaign/${CAMPAIGN}/packages/`);
  });

  test("the trailing slash is load-bearing: a package key starts with it, and nothing else does", () => {
    const prefix = packagePrefix(ORG, CAMPAIGN);
    // The shape below it, from `ObjectPackageStore`'s own layout: a platform, a
    // generation and a file.
    const key = `${prefix}instagram-feed/0000175304210000-aaaaaaaaaaaa.../manifest.json`;
    expect(key.startsWith(prefix)).toBe(true);
    expect(key.startsWith(prefix.slice(0, -1))).toBe(true);
    // The failure the separator prevents: without it this prefix also matches a
    // sibling namespace, and the sweep at commit time would empty it too.
    const withoutSlash = prefix.slice(0, -1);
    expect(
      `org/${ORG}/campaign/${CAMPAIGN}/packages-archive/facebook/x/manifest.json`.startsWith(
        withoutSlash,
      ),
    ).toBe(true);
    expect(
      `org/${ORG}/campaign/${CAMPAIGN}/packages-archive/facebook/x/manifest.json`.startsWith(
        prefix,
      ),
    ).toBe(false);
  });

  test("it is a SIBLING of the renders prefix, so neither can empty the other", () => {
    // A package holds COPIES. If `packages` were a subtree of `renders/`, a
    // campaign's renders and its packages would share one namespace and every
    // sweep at commit time would be a candidate for deleting renders.
    expect(packagePrefix(ORG, CAMPAIGN).startsWith(renderPrefix(ORG, CAMPAIGN))).toBe(false);
    expect(renderPrefix(ORG, CAMPAIGN).startsWith(packagePrefix(ORG, CAMPAIGN))).toBe(false);
    expect(packagePrefix(ORG, CAMPAIGN).startsWith(inputPrefix(ORG, CAMPAIGN))).toBe(false);
  });

  test("two campaigns never share a package prefix, and two orgs never share one either", () => {
    const other = "00000000-0000-4000-8000-000000000001";
    expect(packagePrefix(ORG, CAMPAIGN)).not.toBe(packagePrefix(ORG, other));
    expect(packagePrefix(ORG, CAMPAIGN)).not.toBe(packagePrefix("other", CAMPAIGN));
  });

  describe("every id is checked against its OWN pattern here too", () => {
    const MARKER = "MARKER-7f3a";
    const refused: readonly (readonly [string, () => unknown])[] = [
      ["a package prefix with a missing org id", () => packagePrefix("", CAMPAIGN)],
      ["a package prefix with a slug for a campaign id", () => packagePrefix(ORG, MARKER)],
      [
        "a package prefix with an org id holding a slash",
        () => packagePrefix(`acme/../${MARKER}`, CAMPAIGN),
      ],
      [
        "a package prefix with a campaign id over the column's shape",
        () => packagePrefix(ORG, `${MARKER}-0000-0000-0000`),
      ],
    ];

    for (const [what, call] of refused) {
      test(`${what} is refused, naming the parameter and not the value`, () => {
        let thrown: unknown;
        try {
          call();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toMatch(/^Refusing an object key: the (org|campaign) id/);
        expect(message).not.toContain(MARKER);
      });
    }
  });

  test("an org id of the shapes Better Auth mints is accepted here too", () => {
    for (const orgId of ["local", "Acme", "acme_1", "a-b-C_9"]) {
      expect(packagePrefix(orgId, CAMPAIGN)).toBe(`org/${orgId}/campaign/${CAMPAIGN}/packages/`);
    }
  });
});
