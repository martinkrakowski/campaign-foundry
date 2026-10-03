import { describe, test, expect } from "vitest";
import { inputKey, inputPrefix } from "../object-keys.js";

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
