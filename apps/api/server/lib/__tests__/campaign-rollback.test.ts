import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import type { CampaignMeta } from "../ports/brief-store.port.js";
import type { StorageScope } from "../run-environment.js";
import { rollbackReservedCampaign } from "../campaign-rollback.js";
import { objectStore } from "../config.js";
import { deletePool } from "../pools.js";

const { freeUnreferencedAssets } = vi.hoisted(() => ({
  freeUnreferencedAssets: vi.fn(),
}));

vi.mock("../config.js", () => ({ objectStore: vi.fn() }));
vi.mock("../pools.js", () => ({
  deletePool: vi.fn(),
  withPoolLock: (_scope: unknown, _slug: string, fn: () => unknown) => fn(),
}));
vi.mock("../ports/index.js", () => ({
  getAssetStore: () => ({ freeUnreferencedAssets }),
}));

const scope = { tenant: "t1" } as unknown as StorageScope;

const store = {
  campaignMeta: vi.fn(),
  releaseCampaign: vi.fn().mockResolvedValue(true),
};

let warn: ReturnType<typeof vi.spyOn>;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  freeUnreferencedAssets.mockClear();
  vi.mocked(deletePool).mockClear();
  vi.mocked(objectStore).mockClear();
  store.campaignMeta.mockClear();
  store.releaseCampaign.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const meta = (hasVersion: boolean): CampaignMeta => ({ hasVersion }) as unknown as CampaignMeta;

describe("rollbackReservedCampaign", () => {
  test("rollback deletes the pool then frees the created ids then releases, in that order", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.campaignMeta.mockResolvedValue(meta(false));

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create");

    expect(deletePool).toHaveBeenCalledWith(scope, "t");
    expect(freeUnreferencedAssets).toHaveBeenCalledWith("t", ["a", "b"]);
    expect(store.releaseCampaign).toHaveBeenCalledWith("t");
    const deleteOrder = vi.mocked(deletePool).mock.invocationCallOrder[0];
    const freeOrder = freeUnreferencedAssets.mock.invocationCallOrder[0];
    const releaseOrder = store.releaseCampaign.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(freeOrder);
    expect(freeOrder).toBeLessThan(releaseOrder);
  });

  test("rollback frees under s3 without asking campaignMeta", async () => {
    vi.mocked(objectStore).mockReturnValue("s3");

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create");

    expect(freeUnreferencedAssets).toHaveBeenCalledWith("t", ["a", "b"]);
    expect(store.campaignMeta).not.toHaveBeenCalled();
  });

  test("rollback frees nothing off s3 once a version exists but still releases", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.campaignMeta.mockResolvedValue(meta(true));

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create");

    expect(freeUnreferencedAssets).not.toHaveBeenCalled();
    expect(store.releaseCampaign).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  test("rollback frees nothing off s3 when campaignMeta answers undefined", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.campaignMeta.mockResolvedValue(undefined);

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create");

    expect(freeUnreferencedAssets).not.toHaveBeenCalled();
    expect(store.releaseCampaign).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  test("rollback makes no store call when nothing was created", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");

    await rollbackReservedCampaign(scope, store, "t", [], "create");

    expect(store.campaignMeta).not.toHaveBeenCalled();
    expect(freeUnreferencedAssets).not.toHaveBeenCalled();
    expect(store.releaseCampaign).toHaveBeenCalledOnce();
    expect(deletePool).toHaveBeenCalledWith(scope, "t");
  });

  test("rollback warns with the create label and still releases when campaignMeta rejects", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.campaignMeta.mockRejectedValue(new Error("meta boom"));

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create");

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[campaigns] could not free the assets of "t" after a failed create: meta boom',
    );
    expect(store.releaseCampaign).toHaveBeenCalledOnce();
  });

  test("rollback warns with the duplicate label and still releases when the free rejects", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.campaignMeta.mockResolvedValue(meta(false));
    freeUnreferencedAssets.mockRejectedValueOnce(new Error("free boom"));

    await rollbackReservedCampaign(scope, store, "t", ["a", "b"], "duplicate");

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[campaigns] could not free the assets of "t" after a failed duplicate: free boom',
    );
    expect(store.releaseCampaign).toHaveBeenCalledOnce();
  });

  test("rollback lets a release failure propagate", () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    store.releaseCampaign.mockRejectedValueOnce(new Error("release boom"));

    return expect(rollbackReservedCampaign(scope, store, "t", [], "create")).rejects.toThrow(
      "release boom",
    );
  });

  test("rollback stops at a pool failure and releases nothing", async () => {
    vi.mocked(objectStore).mockReturnValue("fs");
    vi.mocked(deletePool).mockRejectedValueOnce(new Error("pool boom"));

    await expect(rollbackReservedCampaign(scope, store, "t", ["a", "b"], "create")).rejects.toThrow(
      "pool boom",
    );
    expect(freeUnreferencedAssets).not.toHaveBeenCalled();
    expect(store.releaseCampaign).not.toHaveBeenCalled();
  });
});
