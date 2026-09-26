import { describe, test, expect, beforeEach, vi } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { KafkaRunDelivery } from "../kafka-run-delivery.js";
import type { RunRequest } from "../../run-request.js";
import type { KafkaSettings } from "../../config.js";

const mockProducerSend = vi.hoisted(() => vi.fn());
const mockProducerConnect = vi.hoisted(() => vi.fn());
const mockProducerDisconnect = vi.hoisted(() => vi.fn());
const mockKafkaConstructor = vi.hoisted(() => vi.fn());

vi.mock("kafkajs", () => {
  return {
    Kafka: class MockKafka {
      constructor(config: unknown) {
        mockKafkaConstructor(config);
      }
      producer() {
        return {
          connect: mockProducerConnect,
          send: mockProducerSend,
          disconnect: mockProducerDisconnect,
        };
      }
    },
  };
});

const sampleBrief = (): CampaignBrief => ({
  id: "camp-deliv-kafka",
  targetRegion: "DE",
  targetAudience: "test-audience",
  campaignMessage: "Quality test run",
  mode: "generation",
  assets: [],
  products: [
    {
      id: "alpha",
      name: "Alpha",
      primaryColor: "#1473E6",
      logoPath: "assets/inputs/hydra-logo.png",
    },
  ],
});

const sampleRequest = (): RunRequest => ({
  jobId: "00000000-0000-0000-0000-000000000001",
  tenant: { orgId: "org-1", userId: "user-1", roles: ["admin"] },
  brief: sampleBrief(),
  reroll: false,
});

describe("KafkaRunDelivery (PT-6b2, D174d)", () => {
  const settings: KafkaSettings = {
    brokers: ["broker1:9092", "broker2:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: false,
  };

  beforeEach(() => {
    mockProducerSend.mockReset();
    mockProducerConnect.mockReset();
    mockProducerDisconnect.mockReset();
    mockKafkaConstructor.mockReset();
    mockProducerConnect.mockResolvedValue(undefined);
    mockProducerDisconnect.mockResolvedValue(undefined);
  });

  test("publishes serialized RunRequest keyed <orgId>:<campaignId> and awaits broker ack", async () => {
    mockProducerSend.mockResolvedValue([{ topicName: "cf.run-requests", partition: 0, errorCode: 0 }]);
    const delivery = new KafkaRunDelivery(settings);
    const request = sampleRequest();

    await delivery.deliver(request);

    expect(mockProducerSend).toHaveBeenCalledWith({
      topic: "cf.run-requests",
      messages: [
        {
          key: "org-1:camp-deliv-kafka",
          value: JSON.stringify(request),
        },
      ],
    });
  });

  test("rethrows when broker publish fails so caller can delete queued row", async () => {
    mockProducerSend.mockRejectedValue(new Error("Kafka broker unavailable"));
    const delivery = new KafkaRunDelivery(settings);
    const request = sampleRequest();

    await expect(delivery.deliver(request)).rejects.toThrow("Kafka broker unavailable");
  });
});
