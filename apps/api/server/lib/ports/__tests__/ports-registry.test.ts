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
  FsBriefStore,
  FsAssetStore,
  FsPoolStore,
} from "../index.js";
import type { BriefStorePort } from "../brief-store.port.js";
import type { AssetStorePort } from "../asset-store.port.js";
import type { PoolStorePort } from "../pool-store.port.js";

describe("ports registry", () => {
  afterEach(() => {
    resetBriefStore();
    resetAssetStore();
    resetPoolStore();
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
});
