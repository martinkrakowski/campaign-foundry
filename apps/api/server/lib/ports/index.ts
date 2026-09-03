import { FsBriefStore } from "./fs-brief-store.js";
import { FsAssetStore } from "./fs-asset-store.js";
import { FsPoolStore } from "./fs-pool-store.js";
import type { BriefStorePort } from "./brief-store.port.js";
import type { AssetStorePort } from "./asset-store.port.js";
import type { PoolStorePort } from "./pool-store.port.js";

export * from "./brief-store.port.js";
export * from "./asset-store.port.js";
export * from "./pool-store.port.js";
export * from "./fs-brief-store.js";
export * from "./fs-asset-store.js";
export * from "./fs-pool-store.js";

let currentBriefStore: BriefStorePort | undefined;
let currentAssetStore: AssetStorePort | undefined;
let currentPoolStore: PoolStorePort | undefined;

export function getBriefStore(): BriefStorePort {
  if (!currentBriefStore) {
    currentBriefStore = new FsBriefStore();
  }
  return currentBriefStore;
}

export function setBriefStore(store: BriefStorePort): void {
  currentBriefStore = store;
}

export function resetBriefStore(): void {
  currentBriefStore = undefined;
}

export function getAssetStore(): AssetStorePort {
  if (!currentAssetStore) {
    currentAssetStore = new FsAssetStore();
  }
  return currentAssetStore;
}

export function setAssetStore(store: AssetStorePort): void {
  currentAssetStore = store;
}

export function resetAssetStore(): void {
  currentAssetStore = undefined;
}

export function getPoolStore(): PoolStorePort {
  if (!currentPoolStore) {
    currentPoolStore = new FsPoolStore();
  }
  return currentPoolStore;
}

export function setPoolStore(store: PoolStorePort): void {
  currentPoolStore = store;
}

export function resetPoolStore(): void {
  currentPoolStore = undefined;
}
