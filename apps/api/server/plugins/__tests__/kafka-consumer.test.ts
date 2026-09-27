import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import defaultPlugin, {
  calculateBackoff,
  createKafkaConsumerPlugin,
  type ConsumerInstance,
  type NitroApp,
} from "../kafka-consumer.js";

const mockConsumerStart = vi.hoisted(() => vi.fn());
const mockConsumerStop = vi.hoisted(() => vi.fn());
const mockCloseRunDelivery = vi.hoisted(() => vi.fn());

vi.mock("../../lib/ports/run-delivery-registry.js", () => ({
  closeRunDelivery: mockCloseRunDelivery,
}));

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
    mockCloseRunDelivery.mockReset().mockResolvedValue(undefined);
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

    await defaultPlugin(nitroApp as never);

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

    await defaultPlugin(nitroApp as never);

    expect(mockConsumerStart).not.toHaveBeenCalled();
    expect(nitroApp.hooks?.hook).not.toHaveBeenCalled();

    process.env.KAFKA_CONSUME = "false";
    await defaultPlugin(nitroApp as never);
    expect(mockConsumerStart).not.toHaveBeenCalled();
  });

  test("does not start consumer when KAFKA_BROKERS is unset even if KAFKA_CONSUME=true", async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_CONSUME = "true";

    const nitroApp: NitroApp = {
      hooks: { hook: vi.fn() },
    };

    await defaultPlugin(nitroApp as never);

    expect(mockConsumerStart).not.toHaveBeenCalled();
  });

  test("runs safely when nitroApp or hooks are undefined", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    await defaultPlugin(undefined as never);
    expect(mockConsumerStart).toHaveBeenCalledTimes(1);

    await defaultPlugin({} as never);
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

    await plugin(nitroApp as never);
    expect(customConsumer.start).toHaveBeenCalledTimes(1);

    await closeHook!();
    expect(customConsumer.stop).toHaveBeenCalledTimes(1);
  });

  test("a failed consumer stop still closes the delivery producer", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const errorMock = vi.fn();
    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("disconnect failed")),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer, { error: errorMock });

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") closeHook = cb;
        }),
      },
    };

    await plugin(nitroApp as never);
    await expect(closeHook!()).resolves.toBeUndefined();
    expect(mockCloseRunDelivery).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("disconnect failed"));
  });

  test("a non-Error consumer stop failure is logged as a string", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const errorMock = vi.fn();
    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue("socket gone"),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer, { error: errorMock });

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") closeHook = cb;
        }),
      },
    };

    await plugin(nitroApp as never);
    await closeHook!();
    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("socket gone"));
    expect(mockCloseRunDelivery).toHaveBeenCalledTimes(1);
  });

  test("rejected start is logged and not unhandled", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const errorMock = vi.fn();
    const logger = { error: errorMock };
    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockRejectedValue(new Error("broker connection refused")),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer, logger);

    plugin({} as never);

    await new Promise((r) => setTimeout(r, 10));

    expect(customConsumer.start).toHaveBeenCalledTimes(1);
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "Error starting Kafka consumer (attempt 1): broker connection refused",
      ),
    );
  });

  test("close before start resolves still stops the consumer", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    let resolveStart: () => void;
    const startPromise = new Promise<void>((r) => {
      resolveStart = r;
    });

    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockReturnValue(startPromise),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") closeHook = cb;
        }),
      },
    };

    const plugin = createKafkaConsumerPlugin(() => customConsumer);
    plugin(nitroApp as never);

    expect(customConsumer.start).toHaveBeenCalledTimes(1);
    expect(closeHook).toBeDefined();

    await closeHook!();
    expect(customConsumer.stop).toHaveBeenCalledTimes(1);

    resolveStart!();
    await startPromise;
  });

  test("kafkaSettings throw is logged and does not result in unhandled rejection", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092, ,broker2:9092";
    process.env.KAFKA_CONSUME = "true";

    const errorMock = vi.fn();
    const logger = { error: errorMock };
    const plugin = createKafkaConsumerPlugin(undefined, logger);

    plugin({} as never);

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("Error reading Kafka settings: Malformed KAFKA_BROKERS"),
    );
    expect(mockConsumerStart).not.toHaveBeenCalled();
  });

  test("kafkaSettings non-Error throw is logged and does not throw", async () => {
    const errorMock = vi.fn();
    const logger = { error: errorMock };
    const plugin = createKafkaConsumerPlugin(undefined, logger, () => {
      throw "string settings error";
    });

    plugin({} as never);

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("Error reading Kafka settings: string settings error"),
    );
  });

  test("rejected start with non-Error is logged", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const errorMock = vi.fn();
    const logger = { error: errorMock };
    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockRejectedValue("string start failure"),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer, logger);

    plugin({} as never);

    await new Promise((r) => setTimeout(r, 10));

    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining("Error starting Kafka consumer (attempt 1): string start failure"),
    );
  });

  test("nitroApp with hooks object but no hook function", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = createKafkaConsumerPlugin(() => customConsumer);
    plugin({ hooks: {} } as never);

    expect(customConsumer.start).toHaveBeenCalledTimes(1);
  });

  test("a start that fails twice and then succeeds starts once", async () => {
    vi.useFakeTimers();
    try {
      process.env.KAFKA_BROKERS = "broker1:9092";
      process.env.KAFKA_CONSUME = "true";

      const errorMock = vi.fn();
      const logger = { error: errorMock };
      let attempts = 0;
      const customConsumer: ConsumerInstance = {
        start: vi.fn().mockImplementation(async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`broker down attempt ${attempts}`);
          }
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const timer = { setTimeout, clearTimeout, random: () => 0 };
      const plugin = createKafkaConsumerPlugin(() => customConsumer, logger, undefined, timer);
      plugin({} as never);

      // Immediately after plugin invocation, first attempt failed
      await vi.advanceTimersByTimeAsync(0);
      expect(customConsumer.start).toHaveBeenCalledTimes(1);

      // Advance 1s: retry 1 (attempt 2) runs and fails
      await vi.advanceTimersByTimeAsync(1000);
      expect(customConsumer.start).toHaveBeenCalledTimes(2);

      // Advance 2s: retry 2 (attempt 3) runs and succeeds
      await vi.advanceTimersByTimeAsync(2000);
      expect(customConsumer.start).toHaveBeenCalledTimes(3);

      // Additional time passes; consumer was started, no more start calls
      await vi.advanceTimersByTimeAsync(10000);
      expect(customConsumer.start).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a close during backoff stops the retries", async () => {
    vi.useFakeTimers();
    try {
      process.env.KAFKA_BROKERS = "broker1:9092";
      process.env.KAFKA_CONSUME = "true";

      const customConsumer: ConsumerInstance = {
        start: vi.fn().mockRejectedValue(new Error("broker down")),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      let closeHook: (() => Promise<void>) | undefined;
      const nitroApp: NitroApp = {
        hooks: {
          hook: vi.fn().mockImplementation((name, cb) => {
            if (name === "close") closeHook = cb;
          }),
        },
      };

      const plugin = createKafkaConsumerPlugin(() => customConsumer, { error: vi.fn() });
      plugin(nitroApp as never);

      await vi.advanceTimersByTimeAsync(0);
      expect(customConsumer.start).toHaveBeenCalledTimes(1);

      // Close fires during backoff before retry
      expect(closeHook).toBeDefined();
      await closeHook!();

      // Advancing time further should NOT trigger any more start attempts
      await vi.advanceTimersByTimeAsync(120_000);
      expect(customConsumer.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("close while start is pending and then rejects does not schedule a retry", async () => {
    vi.useFakeTimers();
    try {
      process.env.KAFKA_BROKERS = "broker1:9092";
      process.env.KAFKA_CONSUME = "true";

      let rejectStart!: (err: Error) => void;
      const startPromise = new Promise<void>((_, reject) => {
        rejectStart = reject;
      });

      const customConsumer: ConsumerInstance = {
        start: vi.fn().mockReturnValue(startPromise),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      let closeHook: (() => Promise<void>) | undefined;
      const nitroApp: NitroApp = {
        hooks: {
          hook: vi.fn().mockImplementation((name, cb) => {
            if (name === "close") closeHook = cb;
          }),
        },
      };

      const errorMock = vi.fn();
      const plugin = createKafkaConsumerPlugin(() => customConsumer, { error: errorMock });
      plugin(nitroApp as never);

      expect(customConsumer.start).toHaveBeenCalledTimes(1);

      // Close hook fires while start is pending
      expect(closeHook).toBeDefined();
      await closeHook!();
      expect(customConsumer.stop).toHaveBeenCalledTimes(1);

      // Now start promise rejects
      rejectStart(new Error("broker unreachable during shutdown"));
      await vi.advanceTimersByTimeAsync(0);

      expect(errorMock).toHaveBeenCalledWith(
        expect.stringContaining(
          "Error starting Kafka consumer (attempt 1): broker unreachable during shutdown",
        ),
      );

      // Advancing time should not trigger any retry
      await vi.advanceTimersByTimeAsync(120_000);
      expect(customConsumer.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("calculateBackoff returns exponential backoff with jitter up to 60s cap", () => {
    // With zero jitter
    expect(calculateBackoff(1, () => 0)).toBe(1000);
    expect(calculateBackoff(2, () => 0)).toBe(2000);
    expect(calculateBackoff(3, () => 0)).toBe(4000);
    expect(calculateBackoff(6, () => 0)).toBe(32000);
    expect(calculateBackoff(7, () => 0)).toBe(60000); // 64000 capped at 60000
    expect(calculateBackoff(8, () => 0)).toBe(60000);

    // With jitter: capped at 60000
    expect(calculateBackoff(7, () => 1)).toBe(60000);
    expect(calculateBackoff(1, () => 0.5)).toBe(1500);

    // Default random produces value in expected range
    const backoff1 = calculateBackoff(1);
    expect(backoff1).toBeGreaterThanOrEqual(1000);
    expect(backoff1).toBeLessThanOrEqual(2000);
  });

  test("if closed before tryStart begins, consumer is not started", async () => {
    process.env.KAFKA_BROKERS = "broker1:9092";
    process.env.KAFKA_CONSUME = "true";

    const customConsumer: ConsumerInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const nitroApp: NitroApp = {
      hooks: {
        hook: vi.fn().mockImplementation((name, cb) => {
          if (name === "close") {
            void cb();
          }
        }),
      },
    };

    const plugin = createKafkaConsumerPlugin(() => customConsumer);
    plugin(nitroApp as never);

    expect(customConsumer.start).not.toHaveBeenCalled();
  });

  test("retry uses Math.random when timer does not provide a custom random function", async () => {
    vi.useFakeTimers();
    try {
      process.env.KAFKA_BROKERS = "broker1:9092";
      process.env.KAFKA_CONSUME = "true";

      const customConsumer: ConsumerInstance = {
        start: vi.fn().mockRejectedValue(new Error("start error")),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const timerWithoutRandom: KafkaPluginTimer = {
        setTimeout,
        clearTimeout,
      };

      const plugin = createKafkaConsumerPlugin(
        () => customConsumer,
        { error: vi.fn() },
        undefined,
        timerWithoutRandom,
      );
      plugin({} as never);

      await vi.advanceTimersByTimeAsync(0);
      expect(customConsumer.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
