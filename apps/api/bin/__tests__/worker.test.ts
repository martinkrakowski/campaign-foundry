import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { main, type WorkerConsumer } from "../worker.js";
import type { KafkaSettings } from "../../server/lib/config.js";

/**
 * The object-store guard `main()` runs at start (PT-4d), and the environment
 * handling this file did not have until it needed one.
 *
 * `main()` now reads `OBJECT_STORE` and, under `s3`, `objectStoreSettings()`.
 * Both read `process.env`, so without a save-and-restore here every test in the
 * file would inherit whatever the previous one set — and a `STORE_BACKEND` left
 * at `postgres` would turn an unrelated Kafka test into a configuration failure.
 */
const ENV_KEYS = [
  "OBJECT_STORE",
  "STORE_BACKEND",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "KAFKA_BROKERS",
] as const;

describe("worker bin main() (PT-6b2, D174d)", () => {
  const validSettings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };

  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    // The guard must be inert for every test that is not about it: an `s3` left
    // over from a previous test would make `main()` throw before Kafka is even
    // consulted.
    delete process.env.OBJECT_STORE;
    delete process.env.STORE_BACKEND;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

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

describe("worker main() — the object-store guard (PT-4d)", () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const kafkaSettings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };
  const quietConsumer = (): WorkerConsumer => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  });
  const mockProcess = {
    on: vi.fn(),
    removeListener: vi.fn(),
    exitCode: undefined as number | undefined,
  };

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  /** Every `S3_*` variable set, so a test can unset exactly the one it is about. */
  const validS3Env = (): void => {
    process.env.OBJECT_STORE = "s3";
    process.env.STORE_BACKEND = "postgres";
    process.env.S3_ENDPOINT = "http://s3.example:8333";
    process.env.S3_PUBLIC_ENDPOINT = "https://s3.example:8333";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_BUCKET = "campaigns";
    process.env.S3_ACCESS_KEY_ID = "key-id";
    process.env.S3_SECRET_ACCESS_KEY = "secret-value";
  };

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  test("under OBJECT_STORE=s3 with a missing variable, main() refuses to start", async () => {
    // `STORE_BACKEND` FIRST: `objectStoreSettings()` checks it before any `S3_*`,
    // so leaving it unset would throw its own message and prove nothing about the
    // variable this lane added. And only ONE `S3_*` is unset: the guard reports
    // the first missing one in declaration order, so a half-empty environment
    // would always name `S3_ENDPOINT`.
    validS3Env();
    delete process.env.S3_BUCKET;
    const consumer = quietConsumer();
    await expect(
      main(
        () => kafkaSettings,
        () => consumer,
        mockProcess as never,
        console,
        async () => {},
      ),
    ).rejects.toThrow("S3_BUCKET is required when OBJECT_STORE=s3.");
    // Refused BEFORE the consumer is built: a worker that started would take runs
    // off the queue and fail every one of them with a message about a logo.
    expect(consumer.start).not.toHaveBeenCalled();
  });

  test("the guard runs after loadEnv() and before the Kafka check", async () => {
    validS3Env();
    delete process.env.S3_ENDPOINT;
    // Both refused: the store is reported first, because a run on this host would
    // fail on every asset long before it failed on a missing broker.
    await expect(main(() => undefined)).rejects.toThrow("S3_ENDPOINT is required");
  });

  test("under OBJECT_STORE=s3 with every variable set, main() starts as usual", async () => {
    validS3Env();
    const consumer = quietConsumer();
    const { consumer: started } = await main(
      () => kafkaSettings,
      () => consumer,
      mockProcess as never,
      console,
      async () => {},
    );
    expect(started).toBe(consumer);
    expect(consumer.start).toHaveBeenCalledTimes(1);
  });

  test("under OBJECT_STORE=fs nothing is validated, whatever the S3_* variables say", async () => {
    process.env.OBJECT_STORE = "fs";
    process.env.STORE_BACKEND = "fs";
    const consumer = quietConsumer();
    await expect(
      main(
        () => kafkaSettings,
        () => consumer,
        mockProcess as never,
        console,
        async () => {},
      ),
    ).resolves.toBeDefined();
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
