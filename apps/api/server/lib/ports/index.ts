import { FsBriefStore } from "./fs-brief-store.js";
import { FsAssetStore } from "./fs-asset-store.js";
import type { BriefStorePort } from "./brief-store.port.js";
import type { AssetStorePort } from "./asset-store.port.js";

export * from "./brief-store.port.js";
export * from "./asset-store.port.js";
export * from "./fs-brief-store.js";
export * from "./fs-asset-store.js";

let currentBriefStore: BriefStorePort | undefined;
let currentAssetStore: AssetStorePort | undefined;

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
