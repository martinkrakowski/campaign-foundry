import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ObjectExistsError,
  type ListedObject,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { S3ObjectStore } from "../S3ObjectStore.js";

/**
 * The ONE conformance suite for `ObjectStorePort` (PT-4a).
 *
 * The factory below is invoked twice over the same test NAMES: once against
 * `InMemoryObjectStore`, which always runs, and once against `S3ObjectStore` on a
 * real endpoint when `TEST_S3_ENDPOINT` is set. A case only one of the two can
 * pass is a difference between the adapters pretending to be one port, and the
 * count equality asserted at the bottom is what stops the two lists drifting
 * apart quietly.
 *
 * It lives here rather than in the package because the package cannot import
 * `S3ObjectStore`: `aws4fetch` is imported in `lib/object-store/` and nowhere
 * else (D202).
 */
const ENDPOINT = process.env.TEST_S3_ENDPOINT;
const REQUIRED = process.env.TEST_S3_REQUIRED === "1";

/** Where the fake builds its presigned URLs, so the host assertion means the same thing twice. */
const PUBLIC_ENDPOINT = process.env.TEST_S3_PUBLIC_ENDPOINT ?? "https://memory.invalid";
const BUCKET = process.env.TEST_S3_BUCKET ?? "in-memory";

/** Eleven bytes, so `Range: bytes=0-3` is a quarter of it and the total is 11. */
const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** Two keys per page, so three keys under a prefix take two pages in BOTH adapters. */
const LIST_PAGE_SIZE = 2;

function describeConformance({ real }: { real: boolean }): readonly string[] {
  // A unique prefix per run: both CI test steps share one bucket, and a run must
  // never list, read or delete another run's keys.
  const prefix = `conformance/${randomUUID()}/`;
  const key = (name: string) => `${prefix}${name}`;
  let store: ObjectStorePort;
  const names: string[] = [];
  const it = (name: string, body: () => Promise<void>): void => {
    names.push(name);
    test(name, body);
  };

  describe.skipIf(real && ENDPOINT === undefined && !REQUIRED)(
    real
      ? "ObjectStorePort conformance — a real S3 endpoint"
      : "ObjectStorePort conformance — in memory",
    () => {
      beforeAll(async () => {
        if (!real) {
          store = new InMemoryObjectStore({
            listPageSize: LIST_PAGE_SIZE,
            publicEndpoint: PUBLIC_ENDPOINT,
            bucket: BUCKET,
          });
          return;
        }
        // Fail loudly rather than skip when a store was demanded: a run that
        // promised a real endpoint and got none is a failed claim, not a green suite.
        if (ENDPOINT === undefined)
          throw new Error("TEST_S3_REQUIRED=1 but TEST_S3_ENDPOINT is unset.");
        const origin = ENDPOINT.replace(/\/+$/, "");
        const reachable = await fetch(`${origin}/healthz`).then(
          (response) => response.ok,
          (error: unknown) => {
            throw new Error(`TEST_S3_REQUIRED=1 but ${origin}/healthz failed: ${String(error)}`);
          },
        );
        if (!reachable)
          throw new Error(`TEST_S3_REQUIRED=1 but ${origin}/healthz answered non-2xx.`);
        const required = (name: string): string => {
          const value = process.env[name];
          if (value === undefined || value === "") {
            throw new Error(`TEST_S3_REQUIRED=1 but ${name} is unset.`);
          }
          return value;
        };
        store = new S3ObjectStore({
          settings: {
            endpoint: ENDPOINT,
            publicEndpoint: required("TEST_S3_PUBLIC_ENDPOINT"),
            region: required("TEST_S3_REGION"),
            bucket: required("TEST_S3_BUCKET"),
            accessKeyId: required("TEST_S3_ACCESS_KEY_ID"),
            secretAccessKey: required("TEST_S3_SECRET_ACCESS_KEY"),
          },
          fetchImpl: fetch,
          listPageSize: LIST_PAGE_SIZE,
        });
      });

      afterAll(async () => {
        await store.deletePrefix(prefix);
      });

      it("a stored object comes back byte-identical, with its content type", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const read = await store.get(key("hero.png"));
        expect(read?.bytes).toEqual(BYTES);
        expect(read?.contentType).toBe("image/png");
        expect((await store.head(key("hero.png")))?.size).toBe(BYTES.length);
      });

      it("a conditional create on a taken key is refused and the original survives", async () => {
        await store.put(key("taken.png"), BYTES, { contentType: "image/png" });
        await expect(
          store.put(key("taken.png"), new Uint8Array([255]), { ifNoneMatch: "*" }),
        ).rejects.toBeInstanceOf(ObjectExistsError);
        expect((await store.get(key("taken.png")))?.bytes).toEqual(BYTES);
      });

      it("delete is idempotent", async () => {
        await store.put(key("gone.png"), BYTES);
        await store.delete(key("gone.png"));
        await expect(store.delete(key("gone.png"))).resolves.toBeUndefined();
        expect(await store.get(key("gone.png"))).toBeUndefined();
      });

      it("a prefix list returns every key under it, across a second page", async () => {
        for (const name of ["a.png", "b.png", "c.png"]) {
          await store.put(key(`list/${name}`), BYTES);
        }
        const listed = await store.list(key("list/"));
        expect(listed.map((entry) => entry.key).sort()).toEqual(
          [key("list/a.png"), key("list/b.png"), key("list/c.png")].sort(),
        );
      });

      it("a paged list yields every key under a prefix in pages no larger than the page size", async () => {
        for (const name of ["a.png", "b.png", "c.png"]) {
          await store.put(key(`paged/${name}`), BYTES);
        }
        const pages: (readonly ListedObject[])[] = [];
        for await (const page of store.listPages(key("paged/"))) pages.push(page);
        expect(pages.map((page) => page.length)).toEqual([2, 1]);
        expect(
          pages
            .flat()
            .map((entry) => entry.key)
            .sort(),
        ).toEqual([key("paged/a.png"), key("paged/b.png"), key("paged/c.png")].sort());
      });

      it("a Node Buffer body is stored as exactly its bytes", async () => {
        // `Buffer` extends `Uint8Array`, but `Buffer.prototype.slice` is
        // `subarray` — so an adapter that copies with `slice()` copies NOTHING
        // here, and `head().size` answers 8192 with the rest of Node's shared
        // pool in the bucket. `Buffer` is what `fs.readFile`, `Buffer.concat`,
        // sharp and ffmpeg hand back, so this is the shape the next lane puts.
        const buffer = Buffer.from([1, 2, 3]);
        await store.put(key("buffer.bin"), buffer, { contentType: "application/octet-stream" });
        expect((await store.head(key("buffer.bin")))?.size).toBe(3);
        expect((await store.get(key("buffer.bin")))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
        // And the caller's own buffer stays the caller's to keep writing to.
        buffer[0] = 250;
        expect((await store.get(key("buffer.bin")))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      });

      // PT-4e. A motion variant's clip is 3–8 MiB and it is already IN MEMORY
      // before the exporter sees it — there is no multipart in this store and
      // none is needed, which is exactly why the size is the thing under test:
      // a single PUT of a body this size is the only large transfer the app
      // makes, and nothing else in this suite crosses a megabyte.
      it("an ~8 MiB body round-trips byte-identical", async () => {
        // PATTERNED, not zeros: a body of zeros is the one buffer that can be
        // short, doubled or replaced by a same-length run of zeroes and still
        // compare equal. `i % 251` makes every byte position carry its own
        // index-dependent value, so any offset, truncation or zero-fill shows up
        // as a difference rather than as nothing.
        const body = Buffer.allocUnsafe(8 * 1024 * 1024);
        for (let i = 0; i < body.length; i++) body[i] = i % 251;
        await store.put(key("clip.mp4"), body, { contentType: "video/mp4" });

        const read = await store.get(key("clip.mp4"));
        expect(read).toBeDefined();
        // `Buffer.equals`, never `toEqual`: an 8M-element structural comparison
        // is slow and, on failure, prints a diff no human reads.
        expect(Buffer.from(read!.bytes).equals(body)).toBe(true);
        // The size, so a body that arrived whole but short is caught even if a
        // future read happened to return a same-length buffer of zeroes.
        expect((await store.head(key("clip.mp4")))?.size).toBe(body.length);
        expect(read!.contentType).toBe("video/mp4");
      });

      it("copy duplicates an object under a new key and leaves the source", async () => {
        await store.put(key("src.png"), BYTES, { contentType: "image/png" });
        await store.copy(key("src.png"), key("dst.png"));
        expect((await store.get(key("dst.png")))?.bytes).toEqual(BYTES);
        expect(await store.get(key("src.png"))).toBeDefined();
      });

      it("a presigned GET is a URL on the public endpoint, signed for its window", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const url = await store.presignGet(key("hero.png"), { expiresInSeconds: 1200 });
        const parsed = new URL(url);
        // Asserted in BOTH runs. The shape is the contract, and a real adapter
        // signing for an in-cluster endpoint is invisible to a real-only check.
        expect(parsed.host).toBe(new URL(PUBLIC_ENDPOINT).host);
        expect(parsed.pathname).toBe(`/${BUCKET}/${key("hero.png")}`);
        expect(parsed.searchParams.get("X-Amz-Expires")).toBe("1200");
        expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
        if (real) {
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
        }
      });

      it("a presigned GET with one flipped signature digit is refused", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const parsed = new URL(await store.presignGet(key("hero.png"), { expiresInSeconds: 1200 }));
        const signature = parsed.searchParams.get("X-Amz-Signature") ?? "";
        const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
        parsed.searchParams.set("X-Amz-Signature", flipped);
        if (real) {
          expect((await fetch(parsed.toString())).status).toBe(403);
        } else {
          // A digest is not a SigV4 signature, so a flipped digit changes nothing
          // the fake can observe. What it can say is that there is a signature to
          // tamper with, and that it travels as a plain query parameter.
          expect(signature).toMatch(/^[0-9a-f]{64}$/);
          expect(flipped).not.toBe(signature);
          expect(parsed.searchParams.get("X-Amz-Signature")).toBe(flipped);
        }
      });

      it("a presigned GET signed for a window that has closed is refused", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const stale = await store.presignGet(key("hero.png"), {
          expiresInSeconds: 1200,
          now: Date.now() - 21 * 60 * 1000,
        });
        if (real) {
          expect((await fetch(stale)).status).toBe(403);
        } else {
          const fresh = await store.presignGet(key("hero.png"), { expiresInSeconds: 1200 });
          expect(new URL(stale).searchParams.get("X-Amz-Signature")).not.toBe(
            new URL(fresh).searchParams.get("X-Amz-Signature"),
          );
        }
      });

      it("a ranged presigned GET answers 206 with a Content-Range", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const url = await store.presignGet(key("hero.png"), { expiresInSeconds: 1200 });
        if (real) {
          const response = await fetch(url, { headers: { Range: "bytes=0-3" } });
          expect(response.status).toBe(206);
          expect(response.headers.get("content-range")).toBe(`bytes 0-3/${BYTES.length}`);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(0, 4));
        } else {
          // The range is a header the browser adds, so the signed URL is the one
          // an unranged GET uses — which is all the fake has to say about it.
          expect(new URL(url).searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
        }
      });

      it("a presigned GET honours response-content-disposition", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const url = await store.presignGet(key("hero.png"), {
          expiresInSeconds: 1200,
          responseContentDisposition: 'attachment; filename="x.png"',
        });
        if (real) {
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-disposition")).toBe('attachment; filename="x.png"');
        } else {
          expect(new URL(url).searchParams.get("response-content-disposition")).toBe(
            'attachment; filename="x.png"',
          );
        }
      });

      // PT-4f, D209a. The report revision rides the signed URL as `v` (D204), so
      // the one case both adapters must agree on is that it is INSIDE the
      // signature: a store that accepted a tampered `v` would be serving a caller
      // a URL it never signed, and a fake that hashed only the key and the window
      // would be the one adapter on which "changing `v` changes the URL" is false.
      it("a presigned GET with a version answers 200, and the same URL with `v` changed is refused", async () => {
        await store.put(key("hero.png"), BYTES, { contentType: "image/png" });
        const signed = await store.presignGet(key("hero.png"), {
          expiresInSeconds: 1200,
          // The window's own floor, so this case does not itself depend on the
          // clock: the conformance suite is about the signature, not the window.
          now: Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000),
          version: "revision-a",
        });
        const parsed = new URL(signed);
        if (real) {
          const untampered = await fetch(signed);
          expect(untampered.status).toBe(200);
          expect(new Uint8Array(await untampered.arrayBuffer())).toEqual(BYTES);
          parsed.searchParams.set("v", "revision-b");
          expect((await fetch(parsed.toString())).status).toBe(403);
        } else {
          // The fake cannot verify a signature, so what it CAN say is that `v` is
          // present, that it travels as a plain query parameter, and that changing
          // it changes the digest — the same three claims the flipped-signature
          // case above makes.
          expect(parsed.searchParams.get("v")).toBe("revision-a");
          const base = parsed.searchParams.get("X-Amz-Signature");
          parsed.searchParams.set("v", "revision-b");
          expect(parsed.searchParams.get("X-Amz-Signature")).toBe(base);
          const other = new URL(
            await store.presignGet(key("hero.png"), {
              expiresInSeconds: 1200,
              now: Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000),
              version: "revision-b",
            }),
          );
          expect(other.searchParams.get("X-Amz-Signature")).not.toBe(base);
        }
      });
    },
  );
  // The names come back as an array rather than a number because Vitest 4
  // collects a `describe` body AFTER the factory has returned, so a counter read
  // at the return statement is always 0 (measured, both for a run suite and for a
  // skipped one — a skipped suite's tests are registered too). The bottom test
  // reads this array at RUN time, when collection has finished.
  return names;
}

const inMemoryNames = describeConformance({ real: false });
const realNames = describeConformance({ real: true });

// Outside both describes, and unconditional: a skip on the real half must never be
// able to hide a case that only one of the two adapters has.
test("both conformance runs register the same tests", () => {
  expect(inMemoryNames.length).toBeGreaterThan(0);
  expect(realNames).toHaveLength(inMemoryNames.length);
  expect(realNames).toEqual(inMemoryNames);
});
