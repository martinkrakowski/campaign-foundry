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

describe("ports registry", () => {
  afterEach(() => {
    resetBriefStore();
    resetAssetStore();
    resetPoolStore();
    resetTemplateStore();
    resetJobStore();
  });

  test("getBriefStore returns default FsBriefStore and allows override", () => {
    const initial = getBriefStore();
    expect(initial).toBeInstanceOf(FsBriefStore);

    const mockStore = {} as BriefStorePort;
    setBriefStore(mockStore);
    expect(getBriefStore()).toBe(mockStore);

    resetBriefStore();
    expect(getBriefStore()).toBeInstanceOf(FsBriefStore);
  });

  test("getAssetStore returns default FsAssetStore and allows override", () => {
    const initial = getAssetStore();
    expect(initial).toBeInstanceOf(FsAssetStore);

    const mockStore = {} as AssetStorePort;
    setAssetStore(mockStore);
    expect(getAssetStore()).toBe(mockStore);

    resetAssetStore();
    expect(getAssetStore()).toBeInstanceOf(FsAssetStore);
  });

  test("getPoolStore returns default FsPoolStore and allows override", () => {
    const initial = getPoolStore();
    expect(initial).toBeInstanceOf(FsPoolStore);

    const mockStore = {} as PoolStorePort;
    setPoolStore(mockStore);
    expect(getPoolStore()).toBe(mockStore);

    resetPoolStore();
    expect(getPoolStore()).toBeInstanceOf(FsPoolStore);
  });

  test("getTemplateStore returns default FsTemplateStore and allows override", () => {
    const initial = getTemplateStore();
    expect(initial).toBeInstanceOf(FsTemplateStore);

    const mockStore = {} as TemplateStorePort;
    setTemplateStore(mockStore);
    expect(getTemplateStore()).toBe(mockStore);

    resetTemplateStore();
    expect(getTemplateStore()).toBeInstanceOf(FsTemplateStore);
  });

  test("getJobStore returns default FsJobStore and allows override", () => {
    const initial = getJobStore();
    expect(initial).toBeInstanceOf(FsJobStore);

    const mockStore = {} as JobStorePort;
    setJobStore(mockStore);
    expect(getJobStore()).toBe(mockStore);

    resetJobStore();
    expect(getJobStore()).toBeInstanceOf(FsJobStore);
  });

  test("job registry aliases point to the job store functions", () => {
    expect(getJobRegistry).toBe(getJobStore);
    expect(setJobRegistry).toBe(setJobStore);
    expect(resetJobRegistry).toBe(resetJobStore);
  });
});
