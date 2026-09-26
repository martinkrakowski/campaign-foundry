import { describe, test, expect } from "vitest";
import { FsUsageStore } from "../fs-usage-store.js";

describe("FsUsageStore (STORE_BACKEND=fs, PT-7a)", () => {
  test("records nothing and reports no usage", async () => {
    const store = new FsUsageStore();
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "imagen-4.0-generate-001",
      units: 1,
      keyOwner: "platform",
    });
    await expect(store.countThisMonth("local", new Date())).resolves.toBe(0);
  });

  test("quota is always unlimited, so admission never refuses on this backend", async () => {
    const store = new FsUsageStore();
    await expect(store.quota("local")).resolves.toBeNull();
  });

  test("the fs store never refuses: reserve returns an id, settle and release are no-ops (PT-7a2, D175)", async () => {
    const store = new FsUsageStore();
    const id1 = await store.reserve("local");
    expect(typeof id1).toBe("string");
    const id2 = await store.reserve("local");
    expect(typeof id2).toBe("string");
    await expect(
      store.settle(id1!, {
        orgId: "local",
        provider: "imagen",
        model: "imagen-4.0-generate-001",
        units: 1,
        keyOwner: "platform",
      }),
    ).resolves.toBeUndefined();
    await expect(store.release(id2!)).resolves.toBeUndefined();
  });
});
