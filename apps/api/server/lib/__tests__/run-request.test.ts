import { describe, test, expect } from "vitest";
import type { RunRequest } from "../run-request.js";
import { executeRunRequest } from "../run-request.js";
import { InProcessRunDelivery } from "../ports/run-delivery.port.js";
import { LOCAL_TENANT } from "../tenant.js";

describe("RunRequest and RunDeliveryPort (PT-6b1 gap demonstration)", () => {
  test("RunRequest serializes and deserializes through JSON cleanly", () => {
    const request: RunRequest = {
      jobId: "job-123",
      tenant: LOCAL_TENANT,
      brief: {
        id: "camp-1",
        mode: "full",
        name: "Test Campaign",
        summary: "Summary",
        targetRegion: "DE",
        targetAudience: "Audience",
        campaignMessage: "Message",
        products: [],
      },
      imageModel: "imagen-3",
      regenerateOnly: ["banner_300x250"],
      reroll: true,
      expectedRevision: "rev-456",
    };

    const serialized = JSON.stringify(request);
    const deserialized = JSON.parse(serialized) as RunRequest;

    expect(deserialized).toEqual(request);
  });

  test("InProcessRunDelivery is defined", () => {
    const delivery = new InProcessRunDelivery();
    expect(delivery).toBeDefined();
  });
});
