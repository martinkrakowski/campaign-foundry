import { describe, test, expect, afterEach } from "vitest";
import {
  getBriefStore,
  setBriefStore,
  resetBriefStore,
  getAssetStore,
  setAssetStore,
  resetAssetStore,
  getPoolStore,
  setPoolStore,
  resetPoolStore,
  getTemplateStore,
  setTemplateStore,
  resetTemplateStore,
  getJobStore,
  setJobStore,
  resetJobStore,
  getJobRegistry,
  setJobRegistry,
  resetJobRegistry,
  getDraftStore,
  setDraftStore,
  resetDraftStore,
  getLastOpenedStore,
  setLastOpenedStore,
  resetLastOpenedStore,
  FsBriefStore,
  FsAssetStore,
  FsPoolStore,
  FsJobStore,
  FsDraftStore,
  FsLastOpenedStore,
  PgTemplateStore,
} from "../index.js";
import type { BriefStorePort } from "../brief-store.port.js";
import type { AssetStorePort } from "../asset-store.port.js";
import type { PoolStorePort } from "../pool-store.port.js";
import type { TemplateStorePort } from "../template-store.port.js";
import type { JobStorePort } from "../job-store.port.js";
import type { DraftStorePort } from "../draft-store.port.js";
import type { LastOpenedStorePort } from "../last-opened-store.port.js";

import { LOCAL_TENANT } from "../../tenant.js";
import {
  CANONICAL_TEMPLATES,
  TemplateWriteUnsupportedError,
} from "@campaignfoundry/CampaignOrchestration";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { setDatabase, resetDatabase } from "../../db/database.js";
describe("ports registry", () => {
  afterEach(() => {
    resetBriefStore();
    resetAssetStore();
    resetPoolStore();
    resetTemplateStore();
    resetJobStore();
    resetDraftStore();
    resetLastOpenedStore();
  });

  test("getBriefStore returns default FsBriefStore and allows override", () => {
    const initial = getBriefStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsBriefStore);

    const mockStore = {} as BriefStorePort;
    setBriefStore(mockStore);
    expect(getBriefStore(LOCAL_TENANT)).toBe(mockStore);

    resetBriefStore();
    expect(getBriefStore(LOCAL_TENANT)).toBeInstanceOf(FsBriefStore);
  });

  test("getAssetStore returns default FsAssetStore and allows override", () => {
    const initial = getAssetStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsAssetStore);

    const mockStore = {} as AssetStorePort;
    setAssetStore(mockStore);
    expect(getAssetStore(LOCAL_TENANT)).toBe(mockStore);

    resetAssetStore();
    expect(getAssetStore(LOCAL_TENANT)).toBeInstanceOf(FsAssetStore);
  });

  test("getPoolStore returns default FsPoolStore and allows override", () => {
    const initial = getPoolStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsPoolStore);

    const mockStore = {} as PoolStorePort;
    setPoolStore(mockStore);
    expect(getPoolStore(LOCAL_TENANT)).toBe(mockStore);

    resetPoolStore();
    expect(getPoolStore(LOCAL_TENANT)).toBeInstanceOf(FsPoolStore);
  });

  test("getTemplateStore reads the canonical library and wraps a read-only double so saveTemplate throws", async () => {
    const initial = getTemplateStore(LOCAL_TENANT);
    // Read behaviour, not object identity: the registry wraps any store that
    // lacks saveTemplate, so the default FsTemplateStore is reachable only
    // through the read methods it delegates.
    expect(await initial.listTemplates()).toEqual(Object.values(CANONICAL_TEMPLATES));
    expect(await initial.exists("canonical-video")).toBe(true);
    await expect(initial.saveTemplate(CANONICAL_TEMPLATES.video, "u")).rejects.toBeInstanceOf(
      TemplateWriteUnsupportedError,
    );

    const mockStore = {
      listTemplates: async () => [],
      findTemplate: async () => undefined,
      exists: async () => false,
    } as TemplateStorePort;
    setTemplateStore(mockStore);
    const wrapped = getTemplateStore(LOCAL_TENANT);
    expect(await wrapped.listTemplates()).toEqual([]);
    expect(await wrapped.exists("no-such-template")).toBe(false);
    await expect(wrapped.saveTemplate(CANONICAL_TEMPLATES.video, "u")).rejects.toBeInstanceOf(
      TemplateWriteUnsupportedError,
    );

    resetTemplateStore();
    await expect(getTemplateStore(LOCAL_TENANT).listTemplates()).resolves.not.toEqual([]);
  });

  test("getJobStore returns default FsJobStore and allows override", () => {
    const initial = getJobStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsJobStore);

    const mockStore = {} as JobStorePort;
    setJobStore(mockStore);
    expect(getJobStore(LOCAL_TENANT)).toBe(mockStore);

    resetJobStore();
    expect(getJobStore(LOCAL_TENANT)).toBeInstanceOf(FsJobStore);
  });

  test("job registry aliases point to the job store functions", () => {
    expect(getJobRegistry).toBe(getJobStore);
    expect(setJobRegistry).toBe(setJobStore);
    expect(resetJobRegistry).toBe(resetJobStore);
  });

  test("getDraftStore returns default FsDraftStore and allows override", () => {
    const initial = getDraftStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsDraftStore);

    const mockStore = {} as DraftStorePort;
    setDraftStore(mockStore);
    expect(getDraftStore(LOCAL_TENANT)).toBe(mockStore);

    resetDraftStore();
    expect(getDraftStore(LOCAL_TENANT)).toBeInstanceOf(FsDraftStore);
  });

  test("getLastOpenedStore returns default FsLastOpenedStore and allows override", () => {
    const initial = getLastOpenedStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsLastOpenedStore);

    const mockStore = {} as LastOpenedStorePort;
    setLastOpenedStore(mockStore);
    expect(getLastOpenedStore(LOCAL_TENANT)).toBe(mockStore);

    resetLastOpenedStore();
    expect(getLastOpenedStore(LOCAL_TENANT)).toBeInstanceOf(FsLastOpenedStore);
  });
});

describe("the template registry under STORE_BACKEND=postgres (RW-22)", () => {
  const saved = process.env.STORE_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetTemplateStore();
    resetDatabase();
  });

  test("postgres builds a database store per org; the same org shares one store", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";

    const local = getTemplateStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgTemplateStore);
    expect(getTemplateStore(LOCAL_TENANT)).toBe(local);

    const otherOrg = { ...LOCAL_TENANT, orgId: "acme" };
    const other = getTemplateStore(otherOrg);
    expect(other).toBeInstanceOf(PgTemplateStore);
    expect(other).not.toBe(local);

    await db.end();
  });

  test("a read-only double passed to setTemplateStore is wrapped so saveTemplate throws", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";

    const mockStore = {
      listTemplates: async () => [],
      findTemplate: async () => undefined,
      exists: async () => false,
    } as TemplateStorePort;
    setTemplateStore(mockStore);
    const wrapped = getTemplateStore(LOCAL_TENANT);
    expect(await wrapped.listTemplates()).toEqual([]);
    await expect(wrapped.saveTemplate(CANONICAL_TEMPLATES.video, "u")).rejects.toBeInstanceOf(
      TemplateWriteUnsupportedError,
    );

    await db.end();
  });
});
