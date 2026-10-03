import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ObjectExistsError, type ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
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
