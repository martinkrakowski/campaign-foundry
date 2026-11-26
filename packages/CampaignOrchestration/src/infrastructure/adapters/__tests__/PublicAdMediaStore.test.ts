import { describe, expect, test } from "vitest";
import { ObjectExistsError } from "../../../application/ports/out/ObjectStorePort.js";
import { InvalidPublicAdMediaInputError } from "../../../application/ports/out/PublicAdMediaPort.js";
import { InMemoryObjectStore } from "../InMemoryObjectStore.js";
import { PublicAdMediaStore } from "../PublicAdMediaStore.js";

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const HASH = "a".repeat(64);
const ORG = "org-a";

/** A deterministic 16-byte source: a fixed 128-bit sequence, so collisions are testable. */
function fixedRandom(): (size: number) => Uint8Array {
  return (size: number) => new Uint8Array(size).fill(0xab);
}

function store(options: { readonly randomBytes?: (size: number) => Uint8Array } = {}): {
  readonly media: PublicAdMediaStore;
  readonly objects: InMemoryObjectStore;
} {
  const objects = new InMemoryObjectStore({
    publicEndpoint: "https://objects.example",
    bucket: "public-media",
  });
  return {
    media: new PublicAdMediaStore({
      store: objects,
      baseUrl: "https://media.example/",
      ...options,
    }),
    objects,
  };
}

describe("PublicAdMediaStore", () => {
  test("publish stores video bytes at an org-prefixed key and returns its URL", async () => {
    const { media, objects } = store({ randomBytes: fixedRandom() });
    const published = await media.publish(ORG, BYTES, HASH);
    expect(published.key).toBe(`${ORG}/${"ab".repeat(16)}/${HASH}.mp4`);
    expect(published.url).toBe(`https://media.example/${published.key}`);
    const read = await objects.get(published.key);
    expect(read?.bytes).toEqual(BYTES);
    expect(read?.contentType).toBe("video/mp4");
  });

  test("two publishes mint different keys, so nothing is overwritten", async () => {
    const { media } = store();
    const first = await media.publish(ORG, BYTES, HASH);
    const second = await media.publish(ORG, BYTES, HASH);
    expect(second.key).not.toBe(first.key);
  });

  test("the default random source yields 32 lowercase hex characters", async () => {
    const { media } = store();
    const published = await media.publish(ORG, BYTES, HASH);
    const [org, random] = published.key.split("/");
    expect(org).toBe(ORG);
    expect(random).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a collision throws ObjectExistsError and leaves the original bytes", async () => {
    const { media, objects } = store({ randomBytes: fixedRandom() });
    const first = await media.publish(ORG, BYTES, HASH);
    await expect(media.publish(ORG, new Uint8Array([9]), HASH)).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
    expect((await objects.get(first.key))?.bytes).toEqual(BYTES);
  });

  test("a trailing slash on the base URL is stripped", () => {
    const { media } = store();
    expect(media.urlFor(`${ORG}/${"ab".repeat(16)}/${HASH}.mp4`)).toMatch(
      /^https:\/\/media\.example\/org-a\//,
    );
  });

  test("the base URL must be a plain http(s) origin", () => {
    const objects = new InMemoryObjectStore();
    for (const baseUrl of [
      "",
      "media.example",
      "ftp://media.example",
      "https://media.example?a=1",
      "https://media.example#frag",
      "https://user@media.example",
      "https://user:secret@media.example",
    ]) {
      expect(() => new PublicAdMediaStore({ store: objects, baseUrl })).toThrow(
        InvalidPublicAdMediaInputError,
      );
    }
  });

  test("an invalid org id is refused by rule, never echoed", async () => {
    const { media } = store();
    for (const orgId of ["", " ", "/org-x", "org/x", "..", ".org-x", "o".repeat(129)]) {
      let thrown: unknown;
      try {
        await media.publish(orgId, BYTES, HASH);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidPublicAdMediaInputError);
      // The echo check only means something for a value long enough to be
      // recognisable: a single space is contained in any English sentence.
      if (orgId.length >= 3) expect((thrown as Error).message).not.toContain(orgId);
    }
    await expect(media.removeOrg("../escape")).rejects.toBeInstanceOf(
      InvalidPublicAdMediaInputError,
    );
  });

  test("an invalid content hash is refused", async () => {
    const { media } = store();
    for (const hash of ["", "A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      await expect(media.publish(ORG, BYTES, hash)).rejects.toBeInstanceOf(
        InvalidPublicAdMediaInputError,
      );
    }
  });

  test("empty or non-Uint8Array bytes are refused", async () => {
    const { media } = store();
    await expect(media.publish(ORG, new Uint8Array(0), HASH)).rejects.toBeInstanceOf(
      InvalidPublicAdMediaInputError,
    );
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      media.publish(ORG, "not bytes" as any, HASH),
    ).rejects.toBeInstanceOf(InvalidPublicAdMediaInputError);
  });

  test("a random source returning the wrong length is refused", async () => {
    const { media } = store({ randomBytes: (size) => new Uint8Array(size - 1) });
    await expect(media.publish(ORG, BYTES, HASH)).rejects.toBeInstanceOf(
      InvalidPublicAdMediaInputError,
    );
  });

  test("remove and urlFor refuse a key that is not a published key", async () => {
    const { media } = store();
    for (const key of [
      "../escape.mp4",
      "/abs/lead.mp4",
      "a//b.mp4",
      `${ORG}/short/${HASH}.mp4`,
      `${ORG}/${"ab".repeat(16)}/${"g".repeat(64)}.mp4`,
      `${ORG}/${"ab".repeat(16)}/${HASH}.png`,
      `${ORG}/${"ab".repeat(16)}/${HASH}.mp4/extra`,
    ]) {
      await expect(media.remove(key)).rejects.toThrow(Error);
      expect(() => media.urlFor(key)).toThrow(Error);
    }
  });

  test("remove deletes exactly the one object", async () => {
    const { media, objects } = store();
    const published = await media.publish(ORG, BYTES, HASH);
    await media.remove(published.key);
    expect(await objects.get(published.key)).toBeUndefined();
    await media.remove(published.key);
  });

  test("removeOrg empties only that org's prefix and leaves every other org in place", async () => {
    const { media, objects } = store();
    const a = await media.publish(ORG, BYTES, HASH);
    const b = await media.publish("org-b", BYTES, HASH);
    await media.removeOrg(ORG);
    expect(await objects.get(a.key)).toBeUndefined();
    expect(await objects.get(b.key)).toBeDefined();
    expect(await objects.list("org-b/")).toHaveLength(1);
    await media.removeOrg("org-b");
    expect(await objects.get(b.key)).toBeUndefined();
  });

  test("listPages lists only that org's published objects", async () => {
    const { media, objects } = store();
    const a = await media.publish(ORG, BYTES, HASH);
    const b = await media.publish("org-b", BYTES, HASH);
    const pages: string[][] = [];
    for await (const page of media.listPages(ORG)) {
      pages.push(page.map((o) => o.key));
    }
    expect(pages).toEqual([[a.key]]);
    await media.remove(a.key);
    expect(await objects.get(b.key)).toBeDefined();
    const empty: string[][] = [];
    for await (const page of media.listPages(ORG)) empty.push(page.map((o) => o.key));
    expect(empty).toEqual([]);
  });

  test("refuses an invalid org id on listPages without listing", async () => {
    const { media } = store();
    for (const orgId of ["", " ", "/org-x", "org/x", "..", ".org-x", "o".repeat(129)]) {
      await expect(async () => {
        for await (const _page of media.listPages(orgId)) void _page;
      }).rejects.toBeInstanceOf(InvalidPublicAdMediaInputError);
    }
  });
});
