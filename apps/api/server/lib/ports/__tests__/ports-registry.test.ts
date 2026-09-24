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
  FsBriefStore,
  FsAssetStore,
  FsPoolStore,
  FsTemplateStore,
  FsJobStore,
} from "../index.js";
import type { BriefStorePort } from "../brief-store.port.js";
import type { AssetStorePort } from "../asset-store.port.js";
import type { PoolStorePort } from "../pool-store.port.js";
import type { TemplateStorePort } from "../template-store.port.js";
import type { JobStorePort } from "../job-store.port.js";

import { LOCAL_TENANT } from "../../tenant.js";
describe("ports registry", () => {
  afterEach(() => {
    resetBriefStore();
    resetAssetStore();
    resetPoolStore();
    resetTemplateStore();
    resetJobStore();
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

  test("getTemplateStore returns default FsTemplateStore and allows override", () => {
    const initial = getTemplateStore(LOCAL_TENANT);
    expect(initial).toBeInstanceOf(FsTemplateStore);

    const mockStore = {} as TemplateStorePort;
    setTemplateStore(mockStore);
    expect(getTemplateStore(LOCAL_TENANT)).toBe(mockStore);

    resetTemplateStore();
    expect(getTemplateStore(LOCAL_TENANT)).toBeInstanceOf(FsTemplateStore);
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
});
