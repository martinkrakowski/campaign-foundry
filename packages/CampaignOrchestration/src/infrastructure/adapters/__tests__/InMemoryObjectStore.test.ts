import { describe, expect, test } from "vitest";
import { ObjectExistsError } from "../../../application/ports/out/ObjectStorePort.js";
import { InMemoryObjectStore, LIST_PAGE_SIZE_PROBLEM } from "../InMemoryObjectStore.js";

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** A store with a frozen clock, so `lastModified` is a value and not a moment. */
function frozen(): InMemoryObjectStore {
  return new InMemoryObjectStore({
    now: () => 1_700_000_000_000,
    publicEndpoint: "https://objects.example",
    bucket: "campaign-foundry",
  });
}

describe("InMemoryObjectStore", () => {
  test("a round trip keeps the bytes and the content type", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/hero.png", BYTES, { contentType: "image/png" });
    const read = await store.get("campaigns/c1/renders/hero.png");
    expect(read?.bytes).toEqual(BYTES);
    expect(read?.contentType).toBe("image/png");
  });

  test("a stored object is detached from the buffer it was written from", async () => {
    const store = frozen();
    const buffer = new Uint8Array([9, 9]);
    await store.put("campaigns/c1/renders/a.png", buffer);
    buffer[0] = 0;
    expect((await store.get("campaigns/c1/renders/a.png"))?.bytes).toEqual(new Uint8Array([9, 9]));
  });

  test("put without a content type stores none", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    expect((await store.get("campaigns/c1/renders/a.png"))?.contentType).toBeUndefined();
  });

  test("head reports the size, the type and an unquoted etag", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES, { contentType: "image/png" });
    const metadata = await store.head("campaigns/c1/renders/a.png");
    expect(metadata?.size).toBe(5);
    expect(metadata?.contentType).toBe("image/png");
    expect(metadata?.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a missing object is undefined from get and head alike", async () => {
    const store = frozen();
    expect(await store.get("campaigns/c1/renders/none.png")).toBeUndefined();
    expect(await store.head("campaigns/c1/renders/none.png")).toBeUndefined();
  });

  test("an unconditional put replaces what was there", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES, { contentType: "image/png" });
    await store.put("campaigns/c1/renders/a.png", new Uint8Array([7]), {
      contentType: "image/webp",
    });
    const read = await store.get("campaigns/c1/renders/a.png");
    expect(read?.bytes).toEqual(new Uint8Array([7]));
    expect(read?.contentType).toBe("image/webp");
  });

  test("a conditional create on a taken key throws and keeps the original", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES, { contentType: "image/png" });
    await expect(
      store.put("campaigns/c1/renders/a.png", new Uint8Array([7]), { ifNoneMatch: "*" }),
    ).rejects.toBeInstanceOf(ObjectExistsError);
    expect((await store.get("campaigns/c1/renders/a.png"))?.bytes).toEqual(BYTES);
  });

  test("a conditional create on a free key succeeds", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES, { ifNoneMatch: "*" });
    expect((await store.get("campaigns/c1/renders/a.png"))?.bytes).toEqual(BYTES);
  });

  test("delete is idempotent", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    await store.delete("campaigns/c1/renders/a.png");
    await expect(store.delete("campaigns/c1/renders/a.png")).resolves.toBeUndefined();
    expect(await store.get("campaigns/c1/renders/a.png")).toBeUndefined();
  });

  test("list pages internally and answers with every match, in insertion order", async () => {
    const store = new InMemoryObjectStore({ now: () => 1_700_000_000_000, listPageSize: 2 });
    for (const name of ["a", "b", "c", "d", "e"]) {
      await store.put(`campaigns/c1/renders/${name}.png`, BYTES);
    }
    await store.put("campaigns/c2/renders/a.png", BYTES);
    const listed = await store.list("campaigns/c1/renders/");
    expect(listed.map((entry) => entry.key)).toEqual([
      "campaigns/c1/renders/a.png",
      "campaigns/c1/renders/b.png",
      "campaigns/c1/renders/c.png",
      "campaigns/c1/renders/d.png",
      "campaigns/c1/renders/e.png",
    ]);
    expect(listed[0]?.size).toBe(5);
    expect(listed[0]?.lastModified).toEqual(new Date(1_700_000_000_000));
    expect(listed[0]?.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a page size wider than the match list still answers with all of it", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    expect(await store.list("campaigns/c1/")).toHaveLength(1);
    expect(await store.list("campaigns/c9/")).toHaveLength(0);
  });

  test("deletePrefix removes only the prefix, and is idempotent", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    await store.put("campaigns/c1/renders/b.png", BYTES);
    await store.put("campaigns/c1/renders/nested/c.png", BYTES);
    await store.put("campaigns/c2/renders/a.png", BYTES);
    await store.deletePrefix("campaigns/c1/renders/");
    await expect(store.deletePrefix("campaigns/c1/renders/")).resolves.toBeUndefined();
    expect((await store.list("campaigns/")).map((entry) => entry.key)).toEqual([
      "campaigns/c2/renders/a.png",
    ]);
  });

  test("copy duplicates the object and leaves the source in place", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES, { contentType: "image/png" });
    await store.copy("campaigns/c1/renders/a.png", "campaigns/c1/renders/b.png");
    expect((await store.get("campaigns/c1/renders/b.png"))?.bytes).toEqual(BYTES);
    expect((await store.get("campaigns/c1/renders/b.png"))?.contentType).toBe("image/png");
    expect(await store.get("campaigns/c1/renders/a.png")).toBeDefined();
  });

  test("copy of a missing source throws rather than creating an empty object", async () => {
    const store = frozen();
    await expect(store.copy("campaigns/c1/none.png", "campaigns/c1/b.png")).rejects.toThrow(
      "Cannot copy an object that does not exist.",
    );
    expect(await store.head("campaigns/c1/b.png")).toBeUndefined();
  });

  test("every method refuses a key outside the confined shape", async () => {
    const store = frozen();
    const bad = "campaigns/../escape.png";
    await expect(store.put(bad, BYTES)).rejects.toThrow(/Refusing an object key/);
    await expect(store.get(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.head(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.delete(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.list(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.deletePrefix(bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.copy(bad, "campaigns/c1/b.png")).rejects.toThrow(/Refusing an object key/);
    await expect(store.copy("campaigns/c1/a.png", bad)).rejects.toThrow(/Refusing an object key/);
    await expect(store.presignGet(bad, { expiresInSeconds: 60 })).rejects.toThrow(
      /Refusing an object key/,
    );
  });

  test("constructed with no options at all it still works, off its own clock", async () => {
    // Every other test injects a clock and an endpoint, so this is the only one
    // that reaches the defaults — including `Date.now()`, which is what makes a
    // `lastModified` in a listing a real moment rather than a fixed value.
    const store = new InMemoryObjectStore();
    const before = Date.now();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    const listed = await store.list("campaigns/c1/");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastModified.getTime()).toBeGreaterThanOrEqual(before);
    expect(listed[0]?.lastModified.getTime()).toBeLessThanOrEqual(Date.now());
    const url = new URL(
      await store.presignGet("campaigns/c1/renders/a.png", { expiresInSeconds: 60 }),
    );
    expect(url.host).toBe("memory.invalid");
    expect(url.pathname).toBe("/in-memory/campaigns/c1/renders/a.png");
  });

  test("a page size that is not a positive integer is refused at construction", () => {
    // Zero is the one that matters: `list` advances the page BY this number, so a
    // zero never terminates — and as a synchronous loop it starves the event loop,
    // taking the test worker with it rather than failing one test. S3 clamps a
    // `max-keys=0` to its own default, so both adapters refuse it instead.
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new InMemoryObjectStore({ listPageSize: pageSize })).toThrow(
        LIST_PAGE_SIZE_PROBLEM,
      );
    }
    expect(() => new InMemoryObjectStore({ listPageSize: 1 })).not.toThrow();
  });

  test("an empty prefix is refused, so deletePrefix cannot empty the store", async () => {
    const store = frozen();
    await store.put("campaigns/c1/renders/a.png", BYTES);
    await expect(store.list("")).rejects.toThrow(/Refusing an object key/);
    await expect(store.deletePrefix("")).rejects.toThrow(/Refusing an object key/);
    expect(await store.head("campaigns/c1/renders/a.png")).toBeDefined();
  });
});

describe("InMemoryObjectStore.presignGet", () => {
  test("answers a URL of the real one's shape on the endpoint it was built with", async () => {
    const store = new InMemoryObjectStore({
      publicEndpoint: "https://objects.example/",
      bucket: "campaign-foundry",
      now: () => 1_700_000_000_000,
    });
    const url = new URL(
      await store.presignGet("campaigns/c1/renders/hero.png", {
        expiresInSeconds: 1200,
        responseContentDisposition: 'attachment; filename="hero.png"',
        responseContentType: "image/png",
      }),
    );
    expect(url.host).toBe("objects.example");
    expect(url.pathname).toBe("/campaign-foundry/campaigns/c1/renders/hero.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1200");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="hero.png"',
    );
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
  });

  test("omits the response-* parameters it was not given", async () => {
    const store = frozen();
    const url = new URL(await store.presignGet("campaigns/c1/a.png", { expiresInSeconds: 60 }));
    expect(url.search).not.toContain("response-content-disposition");
    expect(url.search).not.toContain("response-content-type");
  });

  test("the injected now decides the signature, and a different key or window changes it", async () => {
    const store = new InMemoryObjectStore({ now: () => 1_700_000_000_000 });
    const at = { expiresInSeconds: 1200, now: 1_700_000_000_000 };
    const base = await store.presignGet("campaigns/c1/a.png", at);
    expect(await store.presignGet("campaigns/c1/a.png", at)).toBe(base);
    expect(await store.presignGet("campaigns/c1/b.png", at)).not.toBe(base);
    expect(await store.presignGet("campaigns/c1/a.png", { ...at, expiresInSeconds: 60 })).not.toBe(
      base,
    );
    expect(
      await store.presignGet("campaigns/c1/a.png", { ...at, now: 1_700_000_000_001 }),
    ).not.toBe(base);
  });

  test("falls back to the store's own clock when no now is passed", async () => {
    const store = new InMemoryObjectStore({ now: () => 1_700_000_000_000 });
    const url = new URL(await store.presignGet("campaigns/c1/a.png", { expiresInSeconds: 60 }));
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      new URL(
        await store.presignGet("campaigns/c1/a.png", {
          expiresInSeconds: 60,
          now: 1_700_000_000_000,
        }),
      ).searchParams.get("X-Amz-Signature"),
    );
  });

  // PT-4f, D209a. A real signature covers every parameter in the query, so a digest
  // that did not would be the ONE adapter on which "change `v`, get a different
  // URL" is false — and the conformance suite holds both adapters to exactly that.
  test("a `version` rides as `v`, and the digest covers it", async () => {
    const store = frozen();
    const at = { expiresInSeconds: 1200, now: 1_700_000_000_000 };
    const base = await store.presignGet("campaigns/c1/a.png", at);

    const versioned = new URL(
      await store.presignGet("campaigns/c1/a.png", { ...at, version: "r1" }),
    );
    expect(versioned.searchParams.get("v")).toBe("r1");
    // Two revisions are two URLs, even for one key in one window: this is what
    // makes a report's revision part of the signed URL rather than a cache-buster
    // a client appends.
    expect(
      new URL(
        await store.presignGet("campaigns/c1/a.png", { ...at, version: "r2" }),
      ).searchParams.get("X-Amz-Signature"),
    ).not.toBe(versioned.searchParams.get("X-Amz-Signature"));
    // The same revision is the same URL.
    expect(await store.presignGet("campaigns/c1/a.png", { ...at, version: "r1" })).toBe(
      versioned.toString(),
    );
    // And no version at all is no `v` parameter.
    expect(new URL(base).searchParams.has("v")).toBe(false);
  });

  test("the digest also covers the disposition and the content type", async () => {
    const store = frozen();
    const at = { expiresInSeconds: 1200, now: 1_700_000_000_000 };
    const bare = new URL(await store.presignGet("campaigns/c1/a.png", at));
    // Both are signed query parameters in a real store, so a digest covering only
    // the key and the window would hand one signature to two URLs it treats as
    // different objects-in-time.
    for (const option of [
      { responseContentDisposition: 'attachment; filename="a.pdf"' },
      { responseContentType: "application/pdf" },
    ]) {
      const withOption = new URL(
        await store.presignGet("campaigns/c1/a.png", { ...at, ...option }),
      );
      expect(withOption.searchParams.get("X-Amz-Signature")).not.toBe(
        bare.searchParams.get("X-Amz-Signature"),
      );
    }
  });
});
