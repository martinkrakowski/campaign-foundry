import { describe, test, expect } from "vitest";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { isSafeId, safeId } from "../id.js";

describe("safeId (PT-1a item 7)", () => {
  test("1,000 generated ids all match SAFE_ID_PATTERN", () => {
    for (let i = 0; i < 1000; i++) {
      const id = safeId();
      expect(id).toMatch(SAFE_ID_PATTERN);
    }
  });

  test("ids are 32 lowercase hex characters, well under the 64-character cap", () => {
    expect(safeId()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("two calls never collide in a small sample", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => safeId()));
    expect(ids.size).toBe(1000);
  });
});

describe("isSafeId", () => {
  test("accepts every safeId() output and rejects an unsafe one", () => {
    expect(isSafeId(safeId())).toBe(true);
    expect(isSafeId("Not-Safe")).toBe(false);
    expect(isSafeId("")).toBe(false);
  });
});
