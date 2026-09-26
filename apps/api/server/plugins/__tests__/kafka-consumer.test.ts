import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import defaultPlugin, { createKafkaConsumerPlugin, type ConsumerInstance, type NitroApp } from "../kafka-consumer.js";

const mockConsumerStart = vi.hoisted(() => vi.fn());
const mockConsumerStop = vi.hoisted(() => vi.fn());

vi.mock("../../lib/run-consumer.js", () => ({
  RunConsumer: class {
    start = mockConsumerStart;
    stop = mockConsumerStop;
  },
}));

describe("kafka-consumer Nitro plugin (PT-6b2, D174d)", () => {
  const origBrokers = process.env.KAFKA_BROKERS;
  const origConsume = process.env.KAFKA_CONSUME;

  beforeEach(() => {
    mockConsumerStart.mockReset().mockResolvedValue(undefined);
    mockConsumerStop.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (origBrokers === undefined) delete process.env.KAFKA_BROKERS;
    else process.env.KAFKA_BROKERS = origBrokers;

    if (origConsume === undefined) delete process.env.KAFKA_CONSUME;
    else process.env.KAFKA_CONSUME = origConsume;
  });

  test("starts consumer and hooks shutdown when KAFKA_CONSUME=true", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") closeHook = cb;
        }),
      },
    };

    await defaultPlugin(nitroApp);

    expect(mockConsumerStart).toHaveBeenCalledTimes(1);
    expect(nitroApp.hooks?.hook).toHaveBeenCalledWith("close", expect.any(Function));

    expect(closeHook).toBeDefined();
    await closeHook!();
    expect(mockConsumerStop).toHaveBeenCalledTimes(1);
  });

  test("does not start consumer when KAFKA_CONSUME is not true", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    delete process.env.KAFKA_CONSUME;

    const nitroApp: NitroApp = {
      hooks: { hook: vi.fn() },
    };

    await defaultPlugin(nitroApp);

    expect(mockConsumerStart).not.toHaveBeenCalled();
    expect(nitroApp.hooks?.hook).not.toHaveBeenCalled();

    process.env.KAFKA_CONSUME = "false";
    await defaultPlugin(nitroApp);
    expect(mockConsumerStart).not.toHaveBeenCalled();
  });

  test("does not start consumer when KAFKA_BROKERS is unset even if KAFKA_CONSUME=true", async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_CONSUME = "true";

    const nitroApp: NitroApp = {
      hooks: { hook: vi.fn() },
    };

    await defaultPlugin(nitroApp);

    expect(mockConsumerStart).not.toHaveBeenCalled();
  });

  test("runs safely when nitroApp or hooks are undefined", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    await defaultPlugin(undefined);
    expect(mockConsumerStart).toHaveBeenCalledTimes(1);

    await defaultPlugin({} as NitroApp);
    expect(mockConsumerStart).toHaveBeenCalledTimes(2);
  });

  test("createKafkaConsumerPlugin allows injecting consumerFactory", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer);

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") closeHook = cb;
        }),
      },
    };

    await plugin(nitroApp);
    expect(customConsumer.start).toHaveBeenCalledTimes(1);

    await closeHook!();
    expect(customConsumer.stop).toHaveBeenCalledTimes(1);
  });
});
