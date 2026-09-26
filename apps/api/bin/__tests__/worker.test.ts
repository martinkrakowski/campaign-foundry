import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { main, type WorkerConsumer } from "../worker.js";
import type { KafkaSettings } from "../../server/lib/config.js";

describe("worker bin main() (PT-6b2, D174d)", () => {
  const validSettings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };

  test("starts consumer and registers shutdown signal listeners", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined as number | undefined,
    };

    const logs: string[] = [];
    const mockLogger = {
      log: vi.fn().mockImplementation((msg: string) => logs.push(msg)),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const { consumer, shutdown } = await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
    );

    expect(consumer).toBe(mockConsumer);
    expect(mockConsumer.start).toHaveBeenCalledTimes(1);
    expect(mockProcess.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(mockProcess.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(logs).toContain(
      '[worker] Starting Kafka run consumer on topic "cf.run-requests", group "cf-workers"...',
    );
    expect(logs).toContain("[worker] Kafka run consumer is running.");

    // Trigger SIGINT listener
    await listeners["SIGINT"]!();
    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(logs).toContain("[worker] Received SIGINT, shutting down Kafka consumer...");
    expect(logs).toContain("[worker] Kafka consumer stopped cleanly.");

    // Calling shutdown a second time is a no-op
    await shutdown("SIGTERM");
    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
  });

  test("SIGTERM stops consumer, ends database pool, and exits", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const mockExit = vi.fn();
    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined,
      exit: mockExit,
    };
    const mockEndDb = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const mockLogger = {
      log: vi.fn().mockImplementation((m: string) => logs.push(m)),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
      mockEndDb,
    );

    await listeners["SIGTERM"]!();

    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(mockEndDb).toHaveBeenCalledTimes(1);
    expect(logs).toContain("[worker] Database pool ended.");
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  test("endDb error handling when ending database pool", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const mockExit = vi.fn();
    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined,
      exit: mockExit,
    };
    const mockEndDb = vi.fn().mockRejectedValue(new Error("pool drain failed"));
    const errors: string[] = [];
    const mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn().mockImplementation((m: string) => errors.push(m)),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
      mockEndDb,
    );

    await listeners["SIGTERM"]!();

    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(mockEndDb).toHaveBeenCalledTimes(1);
    expect(errors).toContain("[worker] Error ending database pool: pool drain failed");
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  test("endDb non-Error handling", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined,
    };
    const mockEndDb = vi.fn().mockRejectedValue("string db error");
    const errors: string[] = [];
    const mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn().mockImplementation((m: string) => errors.push(m)),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
      mockEndDb,
    );

    await listeners["SIGTERM"]!();

    expect(errors).toContain("[worker] Error ending database pool: string db error");
  });

  test("default endDb runs without error even if database is unconfigured", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined,
    };
    const logs: string[] = [];
    const mockLogger = {
      log: vi.fn().mockImplementation((m: string) => logs.push(m)),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
    );

    await listeners["SIGTERM"]!();
    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(logs).toContain("[worker] Database pool ended.");
  });

  test("SIGTERM trigger and consumer.stop error handling", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("disconnect failed")),
    };

    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined as number | undefined,
    };

    const errors: string[] = [];
    const mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn().mockImplementation((msg: string) => errors.push(msg)),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
    );

    // Trigger SIGTERM
    await listeners["SIGTERM"]!();
    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(errors).toContain("[worker] Error stopping consumer: disconnect failed");
  });

  test("consumer.stop non-Error handling", async () => {
    const mockConsumer: WorkerConsumer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue("string error"),
    };

    const listeners: Record<string, () => void> = {};
    const mockProcess = {
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        listeners[event] = handler;
      }),
      removeListener: vi.fn(),
      exitCode: undefined as number | undefined,
    };

    const errors: string[] = [];
    const mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn().mockImplementation((msg: string) => errors.push(msg)),
    };

    await main(
      () => validSettings,
      () => mockConsumer,
      mockProcess as never,
      mockLogger,
    );

    await listeners["SIGTERM"]!();
    expect(errors).toContain("[worker] Error stopping consumer: string error");
  });

  test("throws when KAFKA_BROKERS / settings is undefined", async () => {
    await expect(main(() => undefined)).rejects.toThrow(
      "Cannot start worker: KAFKA_BROKERS is not set.",
    );
  });
});

describe("worker CLI entrypoint execution guard", () => {
  const savedArgv = process.argv;
  const workerFile = fileURLToPath(new URL("../worker.ts", import.meta.url));

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = undefined;
  });

  test("does not run main when process.argv[1] is not worker.ts", async () => {
    process.argv = ["node", "/other/script.js"];
    const module = await import("../worker.js");
    expect(module.main).toBeDefined();
    expect(process.exitCode).toBeUndefined();
  });

  test("executes main and handles clean resolution when argv[1] is worker.ts", async () => {
    process.argv = ["node", workerFile];
    process.env.KAFKA_BROKERS = "broker1:9092";

    const mockStart = vi.fn().mockResolvedValue(undefined);
    const mockStop = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../../server/lib/run-consumer.js", () => ({
      RunConsumer: class {
        start = mockStart;
        stop = mockStop;
      },
    }));

    await import("../worker.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    delete process.env.KAFKA_BROKERS;
  });

  test("executes main, logs error and sets exitCode 1 when main throws Error", async () => {
    process.argv = ["node", workerFile];
    delete process.env.KAFKA_BROKERS;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../worker.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith("  x  Cannot start worker: KAFKA_BROKERS is not set.");
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });

  test("executes main, logs error and sets exitCode 1 when main throws non-Error", async () => {
    process.argv = ["node", workerFile];
    process.env.KAFKA_BROKERS = "broker1:9092";

    vi.doMock("../../server/lib/run-consumer.js", () => ({
      RunConsumer: class {
        start() {
          return Promise.reject("unexpected string rejection");
        }
        stop() {
          return Promise.resolve();
        }
      },
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("../worker.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith("  x  unexpected string rejection");
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
    delete process.env.KAFKA_BROKERS;
  });
});
