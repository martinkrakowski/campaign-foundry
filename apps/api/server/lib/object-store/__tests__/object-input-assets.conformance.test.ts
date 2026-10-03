import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { getAssetStore, resetAssetStore } from "../../ports/index.js";
import { ObjectAssetStore } from "../../ports/object-asset-store.js";
import type { RunEnvironment } from "../../run-environment.js";
import { objectStoreClient, resetObjectStoreClient, setObjectStoreClient } from "../index.js";
import { ObjectInputAssets } from "../object-input-assets.js";
import { S3ObjectStore } from "../S3ObjectStore.js";

/**
 * `ObjectInputAssets` against a REAL S3-compatible endpoint (PT-4d).
 *
 * It lives beside the conformance suite rather than in the offline files because
 * the claim it makes is only meaningful against a store that really answers: the
 * offline cases run on `InMemoryObjectStore`, whose `get` is a Map lookup and
 * cannot 404, cannot refuse, and cannot be unreachable. This file is the one that
 * would notice a key shape a real bucket rejects.
 *
 * **It needs no Postgres server.** CI's "S3 conformance" step has no database,
 * and `migratedDatabase()` builds PGlite in-process — which is why the seeds below
 * are plain SQL against that client rather than a pg harness.
 *
 * Skipped unless `TEST_S3_ENDPOINT` names one, and LOUD under `TEST_S3_REQUIRED`:
 * a run that promised a real endpoint and got none is a failed claim, not a green
 * suite (the same rule, and the same reason, as `object-store.conformance.test.ts`).
 * The unreachable-endpoint case — the one store failure a real bucket cannot be
 * asked for on demand — is in `object-input-assets.test.ts` instead, because it
 * needs no endpoint at all.
 */

const ENDPOINT = process.env.TEST_S3_ENDPOINT;
const REQUIRED = process.env.TEST_S3_REQUIRED === "1";

const ORG = "local";
const SLUG = "winter-sale";
const NAME = "logo.png";
const REF = `assets/inputs/${SLUG}/${NAME}`;
/** Real PNG bytes, not a token string: a bucket stores what it is given. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(ENDPOINT === undefined && !REQUIRED)(
  "ObjectInputAssets — a real S3 endpoint (PT-4d)",
  () => {
    let db: SqlClient;
    let assets: ObjectAssetStore;
    let env: RunEnvironment;
    /** The configured client, kept so a test can spy on the store itself. */
    let client: ObjectStorePort;
    const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
    const SAVED_STORE_BACKEND = process.env.STORE_BACKEND;

    beforeAll(async () => {
      if (ENDPOINT === undefined) {
        throw new Error("TEST_S3_REQUIRED=1 but TEST_S3_ENDPOINT is unset.");
      }
      const required = (name: string): string => {
        const value = process.env[name];
        if (value === undefined || value === "") {
          throw new Error(`TEST_S3_REQUIRED=1 but ${name} is unset.`);
        }
        return value;
      };
      // Injected through the CLIENT registry rather than built from
      // `process.env.S3_*`: the harness's variables are named `TEST_S3_*`, and
      // `objectStoreSettings()` only ever reads the six `S3_*`. The registry is
      // also the path a real deployment takes, so this exercises the one the port
      // reads through rather than a hand-wired store.
      const configured = new S3ObjectStore({
        settings: {
          endpoint: ENDPOINT,
          publicEndpoint: required("TEST_S3_PUBLIC_ENDPOINT"),
          region: required("TEST_S3_REGION"),
          bucket: required("TEST_S3_BUCKET"),
          accessKeyId: required("TEST_S3_ACCESS_KEY_ID"),
          secretAccessKey: required("TEST_S3_SECRET_ACCESS_KEY"),
        },
      });
      setObjectStoreClient(configured);
      // `OBJECT_STORE=s3` picks the object branch of the asset registry, and
      // `STORE_BACKEND=postgres` is what `objectStoreSettings()` demands of it —
      // set for the registry's benefit, and restored below because both are
      // process-wide and the next file in this worker reads them.
      process.env.OBJECT_STORE = "s3";
      process.env.STORE_BACKEND = "postgres";
      resetAssetStore();
      db = await migratedDatabase();
      setDatabase(db);
      // `getAssetStore` rather than a hand-built store, so the write goes through
      // the same adapter the read does.
      assets = getAssetStore(env0()) as ObjectAssetStore;
      // Read back through the registry rather than reused from the local: it is
      // the instance every read in this file reaches, and that is the one a test
      // has to spy on.
      client = objectStoreClient();
      await db.query(`insert into org (id, name) values ($1, $1) on conflict do nothing`, [ORG]);
      await db.query(`insert into campaign (org_id, slug) values ($1, $2)`, [ORG, SLUG]);
      env = env0();
    });

    afterAll(async () => {
      // The whole campaign, objects and rows: the keys carry uuids, so a leftover
      // row without its prefix deleted would be invisible and permanent.
      await assets.deleteAssets(SLUG);
      resetAssetStore();
      resetObjectStoreClient();
      resetDatabase();
      if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
      else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
      if (SAVED_STORE_BACKEND === undefined) delete process.env.STORE_BACKEND;
      else process.env.STORE_BACKEND = SAVED_STORE_BACKEND;
      await db.end();
    });

    test("bytes written through ObjectAssetStore come back through the port unchanged", async () => {
      const path = await assets.writeAsset(SLUG, NAME, PNG);
      // The ref a brief stores is the one the port is asked for: if these two ever
      // disagreed, the write would land and the read would answer ENOENT.
      expect(path.path).toBe(REF);
      const bytes = await new ObjectInputAssets(env).read(REF);
      expect(bytes).toBeDefined();
      expect(Buffer.from(bytes!)).toEqual(PNG);
    });

    test("a ref nothing answers is ENOENT, not undefined and not a refusal", async () => {
      const error = await new ObjectInputAssets(env)
        .read(`assets/inputs/${SLUG}/never-uploaded.png`)
        .catch((e: unknown) => e);
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("an unsafe ref is still undefined, with no store call behind it", async () => {
      // The store itself is spied on, not the port: against a real bucket the
      // claim in this test's name is the one that matters, because a ref refused
      // by `resolveAssetPath` must cost nothing — no key is even built for it. An
      // assertion on the port's answer alone would pass against a port that
      // reached the bucket first and then decided to answer `undefined`.
      const get = vi.spyOn(client, "get");
      expect(await new ObjectInputAssets(env).read("../escape.png")).toBeUndefined();
      expect(await new ObjectInputAssets(env).read("")).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
    });

    test("an org the slug is not in gets ENOENT — never another org's bytes", async () => {
      // Its own name: the database is shared across this file's tests (one
      // beforeAll), so re-writing NAME would be a legitimate duplicate (EEXIST)
      // and the cross-org read below would never run.
      const crossOrgName = "cross-org.png";
      const crossOrgRef = `assets/inputs/${SLUG}/${crossOrgName}`;
      await assets.writeAsset(SLUG, crossOrgName, PNG);
      // The owning org reads it, so an ENOENT below is the org boundary, not a missing object.
      expect(await new ObjectInputAssets(env).read(crossOrgRef)).toBeDefined();
      const theirs: RunEnvironment = {
        ...env,
        tenant: { ...env.tenant, orgId: `${ORG}-other-${randomUUID().slice(0, 8)}` },
      };
      await expect(new ObjectInputAssets(theirs).read(crossOrgRef)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  },
);

/** The scope the reads and the registry are asked for; no root exists on disk. */
function env0(): RunEnvironment {
  return {
    tenant: { orgId: ORG, userId: "u", roles: [], teamIds: [] },
    outputRoot: "/tmp/pt-4d-real-store",
    assetRoot: "/tmp/pt-4d-real-store",
    messageFont: "Inter",
    providers: {},
  };
}
