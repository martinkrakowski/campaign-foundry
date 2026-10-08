import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetProjectRoot } from "@campaignfoundry/shared";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { resetObjectStoreClient, setObjectStoreClient } from "../../object-store/index.js";
import { cachePrefix, campaignPrefix, orgPrefix } from "../../object-store/object-keys.js";
import { deleteOrgObjects } from "../purge-org.js";
import { BYTES, objectSnapshot } from "./purge-org-fixtures.js";

const SAVED_OBJECT_STORE = process.env.OBJECT_STORE;
const SAVED_PROJECT_ROOT = process.env.PROJECT_ROOT;
const SAVED_OUTPUT_DIR = process.env.OUTPUT_DIR;

function restoreEnv(): void {
  if (SAVED_OBJECT_STORE === undefined) delete process.env.OBJECT_STORE;
  else process.env.OBJECT_STORE = SAVED_OBJECT_STORE;
  if (SAVED_PROJECT_ROOT === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = SAVED_PROJECT_ROOT;
  if (SAVED_OUTPUT_DIR === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = SAVED_OUTPUT_DIR;
  resetProjectRoot();
}

async function plantObjects(
  store: InMemoryObjectStore,
  orgId: string,
  campaignId: string,
): Promise<void> {
  await store.put(`${campaignPrefix(orgId, campaignId)}inputs/x`, BYTES);
  await store.put(`${campaignPrefix(orgId, campaignId)}renders/y`, BYTES);
  await store.put(`${cachePrefix(orgId)}z`, BYTES);
  await store.put(`${orgPrefix(orgId)}other/x`, BYTES);
}

describe("deleteOrgObjects (PT-9m2, D241)", () => {
  describe("s3", () => {
    let dir: string;
    let store: InMemoryObjectStore;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cf-purge-org-s3-"));
      process.env.OUTPUT_DIR = dir;
      process.env.PROJECT_ROOT = dir;
      process.env.OBJECT_STORE = "s3";
      resetProjectRoot();
      store = new InMemoryObjectStore();
      setObjectStoreClient(store);
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      resetObjectStoreClient();
      restoreEnv();
    });

    test("purgeOrg deletes everything under the org prefix including the cache and no sibling org", async () => {
      const acme = randomUUID();
      const two = randomUUID();
      const beta = randomUUID();
      await plantObjects(store, "acme", acme);
      await plantObjects(store, "acme-two", two);
      await plantObjects(store, "beta", beta);

      const beforeTwo = await objectSnapshot(store, "acme-two");
      const beforeBeta = await objectSnapshot(store, "beta");

      await deleteOrgObjects("acme");

      // `org/acme/` is gone entirely, including the cache and the stray key.
      expect(await store.list(orgPrefix("acme"))).toHaveLength(0);

      // acme-two shares the textual prefix `org/acme` (no slash) but not `org/acme/`,
      // so it and beta are byte-identical before/after.
      expect(await objectSnapshot(store, "acme-two")).toEqual(beforeTwo);
      expect(await objectSnapshot(store, "beta")).toEqual(beforeBeta);

      // A second call is a no-op.
      await deleteOrgObjects("acme");
      expect(await store.list(orgPrefix("acme"))).toHaveLength(0);
    });
  });

  describe("fs", () => {
    let projectDir: string;
    let outputDir: string;

    beforeEach(() => {
      // Two SEPARATE roots: `storageRoots` resolves one org's trees under each,
      // so each `rm` in `deleteOrgObjects` owns a distinct directory. Sharing
      // one root hid a missing `rm` from the test (D180: a mutation that drops
      // one line must still fail).
      projectDir = mkdtempSync(join(tmpdir(), "cf-purge-org-proj-"));
      outputDir = mkdtempSync(join(tmpdir(), "cf-purge-org-out-"));
      process.env.PROJECT_ROOT = projectDir;
      process.env.OUTPUT_DIR = outputDir;
      delete process.env.OBJECT_STORE;
      resetProjectRoot();
    });
    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      restoreEnv();
    });

    test("purgeOrg under the file object store removes the org trees and no other org tree", async () => {
      // The org's tree in each root, plus a file under a sibling org in each root.
      mkdirSync(join(projectDir, "orgs", "acme"), { recursive: true });
      writeFileSync(join(projectDir, "orgs", "acme", "a.txt"), "data");
      mkdirSync(join(outputDir, "orgs", "acme"), { recursive: true });
      writeFileSync(join(outputDir, "orgs", "acme", "b.txt"), "data");
      mkdirSync(join(projectDir, "orgs", "beta"), { recursive: true });
      writeFileSync(join(projectDir, "orgs", "beta", "keep.txt"), "keep");
      mkdirSync(join(outputDir, "orgs", "beta"), { recursive: true });
      writeFileSync(join(outputDir, "orgs", "beta", "keep.txt"), "keep");

      await deleteOrgObjects("acme");

      // Four assertions: each acme tree is gone, each beta tree survives.
      expect(() => statSync(join(projectDir, "orgs", "acme", "a.txt"))).toThrow("ENOENT");
      expect(() => statSync(join(outputDir, "orgs", "acme", "b.txt"))).toThrow("ENOENT");
      expect(() => statSync(join(projectDir, "orgs", "beta", "keep.txt"))).not.toThrow();
      expect(() => statSync(join(outputDir, "orgs", "beta", "keep.txt"))).not.toThrow();
    });

    test("deleteOrgObjects refuses the local org before touching any tree", async () => {
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(projectDir, "keep.txt"), "keep");
      writeFileSync(join(outputDir, "keep.txt"), "keep");

      await expect(deleteOrgObjects("local")).rejects.toThrow(/org "local" can never be deleted\./);

      expect(() => statSync(join(projectDir, "keep.txt"))).not.toThrow();
      expect(() => statSync(join(outputDir, "keep.txt"))).not.toThrow();
    });
  });
});
