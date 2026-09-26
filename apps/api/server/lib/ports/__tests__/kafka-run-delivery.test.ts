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

import { parseBrief } from "../../load-brief.js";

const sampleBrief = (): CampaignBrief =>
  parseBrief({
    id: "camp-deliv-kafka",
    targetRegion: "DE",
    targetAudience: "test-audience",
    campaignMessage: "Quality test run",
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
  tenant: { orgId: "org-1", userId: "user-1", roles: ["admin"], teamIds: [] },
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
    mockProducerSend.mockResolvedValue([
      { topicName: "cf.run-requests", partition: 0, errorCode: 0 },
    ]);
    const delivery = new KafkaRunDelivery(settings);
    const request = sampleRequest();

    await delivery.deliver(request);
    // Second delivery: verify connected branch is skipped
    await delivery.deliver(request);

    expect(mockProducerConnect).toHaveBeenCalledTimes(1);
    expect(mockProducerSend).toHaveBeenCalledWith({
      topic: "cf.run-requests",
      messages: [
        {
          key: "org-1:camp-deliv-kafka",
          value: JSON.stringify(request),
        },
      ],
    });

    // Disconnect when connected
    await delivery.disconnect();
    expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);

    // Disconnect when not connected
    await delivery.disconnect();
    expect(mockProducerDisconnect).toHaveBeenCalledTimes(1);
  });

  test("rethrows when broker publish fails so caller can delete queued row", async () => {
    mockProducerSend.mockRejectedValue(new Error("Kafka broker unavailable"));
    const delivery = new KafkaRunDelivery(settings);
    const request = sampleRequest();

    await expect(delivery.deliver(request)).rejects.toThrow("Kafka broker unavailable");
  });

  test("throws when initialized without settings and kafkaSettings() is undefined", () => {
    delete process.env.KAFKA_BROKERS;
    expect(() => new KafkaRunDelivery()).toThrow(
      "Cannot initialize KafkaRunDelivery without Kafka settings.",
    );
  });

  test("uses kafkaSettings() and configures SSL when settings are omitted", () => {
    const orig = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = "broker1:9092";
    try {
      new KafkaRunDelivery();
      expect(mockKafkaConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          brokers: ["broker1:9092"],
          ssl: undefined,
        }),
      );
    } finally {
      if (orig === undefined) delete process.env.KAFKA_BROKERS;
      else process.env.KAFKA_BROKERS = orig;
    }
  });

  test("configures SSL options with ca, cert, and key when provided", () => {
    const sslSettings: KafkaSettings = {
      ...settings,
      ssl: {
        ca: "CA-DATA",
        cert: "CERT-DATA",
        key: "KEY-DATA",
      },
    };
    new KafkaRunDelivery(sslSettings);
    expect(mockKafkaConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: {
          rejectUnauthorized: true,
          ca: ["CA-DATA"],
          cert: "CERT-DATA",
          key: "KEY-DATA",
        },
      }),
    );
  });

  test("configures SSL options without ca when ca is not provided", () => {
    const sslSettings: KafkaSettings = {
      ...settings,
      ssl: {
        cert: "CERT-DATA",
        key: "KEY-DATA",
      },
    };
    new KafkaRunDelivery(sslSettings);
    expect(mockKafkaConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: {
          rejectUnauthorized: true,
          ca: undefined,
          cert: "CERT-DATA",
          key: "KEY-DATA",
        },
      }),
    );
  });

  test("accepts injected kafkaClient or producer", () => {
    const customProducer = {
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const deliveryWithProducer = new KafkaRunDelivery(settings, undefined, customProducer as never);
    expect(deliveryWithProducer).toBeDefined();

    const customKafka = {
      producer: vi.fn().mockReturnValue(customProducer),
    };
    const deliveryWithKafka = new KafkaRunDelivery(settings, customKafka as never);
    expect(deliveryWithKafka).toBeDefined();
  });
});
