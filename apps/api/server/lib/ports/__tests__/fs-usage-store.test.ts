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
});
