import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { LOCAL_TENANT } from "../../tenant.js";
import { InProcessRunDelivery } from "../in-process-run-delivery.js";
import { KafkaRunDelivery } from "../kafka-run-delivery.js";
import { getRunDelivery, setRunDelivery, resetRunDelivery } from "../run-delivery-registry.js";
import type { RunDeliveryPort } from "../run-delivery.port.js";

vi.mock("kafkajs", () => ({
  Kafka: class {
    producer() {
      return {
        connect: vi.fn(),
        send: vi.fn(),
        disconnect: vi.fn(),
      };
    }
  },
}));

describe("run-delivery-registry (PT-6b2, D171, D174d)", () => {
  const origBrokers = process.env.KAFKA_BROKERS;

  beforeEach(() => {
    resetRunDelivery();
    delete process.env.KAFKA_BROKERS;
  });

  afterEach(() => {
    resetRunDelivery();
    if (origBrokers === undefined) delete process.env.KAFKA_BROKERS;
    else process.env.KAFKA_BROKERS = origBrokers;
  });

  test("selects InProcessRunDelivery when kafkaSettings() is undefined", () => {
    delete process.env.KAFKA_BROKERS;
    const delivery = getRunDelivery(LOCAL_TENANT);
    expect(delivery).toBeInstanceOf(InProcessRunDelivery);
  });

  test("selects KafkaRunDelivery when kafkaSettings() is defined", () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    const delivery = getRunDelivery(LOCAL_TENANT);
    expect(delivery).toBeInstanceOf(KafkaRunDelivery);
  });

  test("honours test double installed with setRunDelivery", () => {
    const fakeDelivery: RunDeliveryPort = {
      deliver: vi.fn(),
    };
    setRunDelivery(fakeDelivery);
    expect(getRunDelivery(LOCAL_TENANT)).toBe(fakeDelivery);
  });

  test("resetRunDelivery clears test double and instance cache", () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    const first = getRunDelivery(LOCAL_TENANT);
    expect(first).toBeInstanceOf(KafkaRunDelivery);

    resetRunDelivery();
    delete process.env.KAFKA_BROKERS;

    const second = getRunDelivery(LOCAL_TENANT);
    expect(second).toBeInstanceOf(InProcessRunDelivery);
  });

  test("caches and returns the same instance on consecutive calls", () => {
    delete process.env.KAFKA_BROKERS;
    const first = getRunDelivery(LOCAL_TENANT);
    const second = getRunDelivery(LOCAL_TENANT);
    expect(first).toBe(second);
  });
});
