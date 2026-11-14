import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  main,
  preflightDependencies,
  type PreflightDeps,
  type WorkerConsumer,
} from "../worker.js";
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
      undefined,
      async () => {},
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
      async () => {},
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
      async () => {},
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
      async () => {},
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
      undefined,
      async () => {},
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
      undefined,
      async () => {},
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
      undefined,
      async () => {},
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
        async () => {},
      ),
    ).resolves.toBeDefined();
  });
});

describe("worker CLI entrypoint execution guard", () => {
  const savedArgv = process.argv;
  const workerFile = fileURLToPath(new URL("../worker.ts", import.meta.url));
  /** The admin `main()`'s default preflight uses, so the run stays offline. */
  const offlineAdmin = () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    fetchTopicMetadata: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  });
  let admin = offlineAdmin();

  beforeEach(() => {
    vi.resetModules();
    admin = offlineAdmin();
    // `main()` runs with all defaults here, including the real
    // `preflightDependencies`, whose Kafka admin must come from a mock —
    // otherwise `KAFKA_BROKERS = "broker1:9092"` invites a live connect.
    vi.doMock("kafkajs", () => ({
      Kafka: class {
        constructor(_opts: unknown) {}
        admin(_opts: unknown) {
          return admin;
        }
      },
      logLevel: { NOTHING: 0 },
    }));
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = undefined;
    vi.doUnmock("kafkajs");
    vi.resetModules();
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

describe("worker main() — preflight ordering", () => {
  const kafkaSettings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };
  const savedEnv = Object.fromEntries(
    ["OBJECT_STORE", "STORE_BACKEND"].map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    delete process.env.OBJECT_STORE;
    delete process.env.STORE_BACKEND;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

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

  const mockProcess = {
    on: vi.fn(),
    removeListener: vi.fn(),
    exitCode: undefined as number | undefined,
  };
  const quietConsumer = (): WorkerConsumer => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  });

  test("preflight is not called when objectStoreSettings() throws", async () => {
    validS3Env();
    delete process.env.S3_BUCKET;
    const preflight = vi.fn().mockResolvedValue(undefined);
    const consumer = quietConsumer();
    await expect(
      main(
        () => kafkaSettings,
        () => consumer,
        mockProcess as never,
        console,
        async () => {},
        preflight,
      ),
    ).rejects.toThrow("S3_BUCKET is required when OBJECT_STORE=s3.");
    expect(preflight).not.toHaveBeenCalled();
    expect(consumer.start).not.toHaveBeenCalled();
  });

  test("preflight is not called when resolveSettings() returns undefined", async () => {
    const preflight = vi.fn().mockResolvedValue(undefined);
    await expect(
      main(
        () => undefined,
        () => quietConsumer(),
        mockProcess as never,
        console,
        async () => {},
        preflight,
      ),
    ).rejects.toThrow("Cannot start worker: KAFKA_BROKERS is not set.");
    expect(preflight).not.toHaveBeenCalled();
  });

  test("preflight receives settings and runs before consumerFactory and start", async () => {
    const order: string[] = [];
    const consumer = quietConsumer();
    (consumer.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("consumer.start");
      return Promise.resolve();
    });
    const preflight = vi.fn().mockImplementation((settings: KafkaSettings) => {
      order.push("preflight");
      expect(settings).toBe(kafkaSettings);
      return Promise.resolve();
    });
    const logs: string[] = [];
    const mockLogger = {
      log: vi.fn().mockImplementation((m: string) => logs.push(m)),
      warn: vi.fn(),
      error: vi.fn(),
    };
    await main(
      () => kafkaSettings,
      () => {
        order.push("consumerFactory");
        return consumer;
      },
      mockProcess as never,
      mockLogger,
      async () => {},
      preflight,
    );
    expect(order).toEqual(["preflight", "consumerFactory", "consumer.start"]);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(logs).toContain(
      "[worker] Preflight: verifying Postgres, object store, and Kafka...",
    );
    expect(logs).toContain(
      "[worker] Preflight passed; all configured dependencies are reachable.",
    );
  });

  test("a rejecting preflight prevents the consumer from being built or started", async () => {
    const preflight = vi
      .fn()
      .mockRejectedValue(new Error("Cannot start worker: Kafka preflight failed."));
    let factoryCalled = false;
    await expect(
      main(
        () => kafkaSettings,
        () => {
          factoryCalled = true;
          return quietConsumer();
        },
        mockProcess as never,
        console,
        async () => {},
        preflight,
      ),
    ).rejects.toThrow("Kafka preflight failed");
    expect(factoryCalled).toBe(false);
  });
});

describe("preflightDependencies()", () => {
  const settings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };

  const makeAdmin = () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    fetchTopicMetadata: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  });

  const makeDeps = (over: Partial<PreflightDeps> = {}): PreflightDeps => ({
    getStoreBackend: vi.fn().mockReturnValue("fs"),
    getObjectStoreMode: vi.fn().mockReturnValue("fs"),
    getDb: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    getObjectStore: vi.fn().mockReturnValue({ list: vi.fn().mockResolvedValue([]) }),
    createKafkaAdmin: vi.fn().mockReturnValue(makeAdmin()),
    ...over,
  });

  test("postgres + s3 + Kafka: one operation per active dependency, in order", async () => {
    const order: string[] = [];
    const query = vi.fn().mockImplementation(async () => {
      order.push("query");
      return { rows: [] };
    });
    const list = vi.fn().mockImplementation(async () => {
      order.push("list");
      return [];
    });
    const admin = makeAdmin();
    admin.connect.mockImplementation(async () => {
      order.push("connect");
    });
    admin.fetchTopicMetadata.mockImplementation(async () => {
      order.push("fetchTopicMetadata");
      return {};
    });
    admin.disconnect.mockImplementation(async () => {
      order.push("disconnect");
    });
    const deps = makeDeps({
      getStoreBackend: vi.fn().mockReturnValue("postgres"),
      getObjectStoreMode: vi.fn().mockReturnValue("s3"),
      getDb: vi.fn().mockReturnValue({ query }),
      getObjectStore: vi.fn().mockReturnValue({ list }),
      createKafkaAdmin: vi.fn().mockReturnValue(admin),
    });
    await preflightDependencies(settings, deps);
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(list).toHaveBeenCalledWith("_preflight");
    expect(admin.connect).toHaveBeenCalledTimes(1);
    expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({ topics: [settings.topic] });
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["query", "list", "connect", "fetchTopicMetadata", "disconnect"]);
  });

  test("fs + fs + Kafka: skips Postgres and the object store, checks Kafka only", async () => {
    const deps = makeDeps();
    await preflightDependencies(settings, deps);
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.getObjectStore).not.toHaveBeenCalled();
    const admin = deps.createKafkaAdmin(settings) as unknown as ReturnType<typeof makeAdmin>;
    expect(admin.connect).toHaveBeenCalledTimes(1);
    expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({ topics: [settings.topic] });
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a Postgres failure names Postgres, cites network policy and credentials, and short-circuits", async () => {
    const deps = makeDeps({
      getStoreBackend: vi.fn().mockReturnValue("postgres"),
      getDb: vi
        .fn()
        .mockReturnValue({ query: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "28P01" })) }),
    });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: Postgres preflight failed (code: 28P01); " +
        "commonly caused by a network policy, TLS/ACL mismatch, or invalid credentials.",
    );
    expect(deps.getObjectStore).not.toHaveBeenCalled();
    expect(deps.createKafkaAdmin).not.toHaveBeenCalled();
  });

  test("a Postgres failure without a safe token still names Postgres", async () => {
    const deps = makeDeps({
      getStoreBackend: vi.fn().mockReturnValue("postgres"),
      getDb: vi.fn().mockReturnValue({ query: vi.fn().mockRejectedValue("not an Error") }),
    });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: Postgres preflight failed; commonly caused by a network policy",
    );
  });

  test("an S3 failure names the S3 object store, keeps a safe type token, and short-circuits", async () => {
    const err = Object.assign(new Error("boom"), { code: "urn:x:error", type: "NoSuchBucket" });
    const deps = makeDeps({
      getObjectStoreMode: vi.fn().mockReturnValue("s3"),
      getObjectStore: vi.fn().mockReturnValue({ list: vi.fn().mockRejectedValue(err) }),
    });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: S3 object store preflight failed (code: NoSuchBucket); " +
        "commonly caused by a network policy, TLS/ACL mismatch, or invalid credentials.",
    );
    expect(deps.createKafkaAdmin).not.toHaveBeenCalled();
  });

  test("an S3 non-Error failure without a token still names the S3 object store", async () => {
    const deps = makeDeps({
      getObjectStoreMode: vi.fn().mockReturnValue("s3"),
      getObjectStore: vi.fn().mockReturnValue({ list: vi.fn().mockRejectedValue(42) }),
    });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: S3 object store preflight failed; commonly caused by a network policy",
    );
  });

  test("a Kafka connect failure names Kafka and still disconnects in finally", async () => {
    const admin = makeAdmin();
    admin.connect.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
    const deps = makeDeps({ createKafkaAdmin: vi.fn().mockReturnValue(admin) });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: Kafka preflight failed (code: ECONNREFUSED); " +
        "commonly caused by a network policy, TLS/ACL mismatch, or invalid credentials.",
    );
    expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a Kafka metadata failure names Kafka even without a safe token", async () => {
    const admin = makeAdmin();
    admin.fetchTopicMetadata.mockRejectedValue(
      Object.assign(new Error("x"), { type: "spaces not allowed" }),
    );
    const deps = makeDeps({ createKafkaAdmin: vi.fn().mockReturnValue(admin) });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: Kafka preflight failed; commonly caused by a network policy",
    );
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a rejecting disconnect after a successful check resolves without throwing", async () => {
    const admin = makeAdmin();
    admin.disconnect.mockRejectedValue(new Error("disconnect failed"));
    const deps = makeDeps({ createKafkaAdmin: vi.fn().mockReturnValue(admin) });
    await expect(preflightDependencies(settings, deps)).resolves.toBeUndefined();
    expect(admin.connect).toHaveBeenCalledTimes(1);
    expect(admin.fetchTopicMetadata).toHaveBeenCalledTimes(1);
  });

  test("a rejecting disconnect during cleanup does not mask a primary Kafka failure", async () => {
    const admin = makeAdmin();
    admin.connect.mockRejectedValue(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
    admin.disconnect.mockRejectedValue(new Error("disconnect also failed"));
    const deps = makeDeps({ createKafkaAdmin: vi.fn().mockReturnValue(admin) });
    await expect(preflightDependencies(settings, deps)).rejects.toThrow(
      "Cannot start worker: Kafka preflight failed (code: ECONNREFUSED)",
    );
  });
});

describe("preflight error hygiene — never echo a secret", () => {
  const settings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };
  const CONNECTION_STRING = "postgres://cf_app:super-secret-pw@db:5432/cf";
  const S3_SECRET = "wJalrXUtnFEMI-secret-access-key";
  const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END CERTIFICATE-----";

  const makeAdmin = (rejection: unknown) => ({
    connect: vi.fn().mockRejectedValue(rejection),
    fetchTopicMetadata: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  });

  const expectNoSecrets = async (promise: Promise<void>, deps: PreflightDeps): Promise<void> => {
    const err = await promise.then(
      () => {
        throw new Error("expected preflightDependencies to reject");
      },
      (e: unknown) => e as Error,
    );
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    for (const secret of [CONNECTION_STRING, S3_SECRET, "BEGIN PRIVATE KEY", "BEGIN CERTIFICATE"]) {
      expect(err.message).not.toContain(secret);
      expect(String(err)).not.toContain(secret);
    }
    expect(deps.createKafkaAdmin).not.toHaveBeenCalled();
  };

  test("a Postgres error leaking a connection string is reduced to a safe message", async () => {
    const deps: PreflightDeps = {
      getStoreBackend: vi.fn().mockReturnValue("postgres"),
      getObjectStoreMode: vi.fn().mockReturnValue("fs"),
      getDb: vi
        .fn()
        .mockReturnValue({ query: vi.fn().mockRejectedValue(new Error(CONNECTION_STRING)) }),
      getObjectStore: vi.fn(),
      createKafkaAdmin: vi.fn(),
    };
    await expectNoSecrets(preflightDependencies(settings, deps), deps);
  });

  test("an S3 error leaking a secret key and an unsafe code is reduced to a safe message", async () => {
    const err = Object.assign(new Error(`${S3_SECRET} ${PEM}`), { code: CONNECTION_STRING });
    const deps: PreflightDeps = {
      getStoreBackend: vi.fn().mockReturnValue("fs"),
      getObjectStoreMode: vi.fn().mockReturnValue("s3"),
      getDb: vi.fn(),
      getObjectStore: vi.fn().mockReturnValue({ list: vi.fn().mockRejectedValue(err) }),
      createKafkaAdmin: vi.fn(),
    };
    await expectNoSecrets(preflightDependencies(settings, deps), deps);
  });

  test("a Kafka error leaking PEM text and an unsafe code is reduced to a safe message", async () => {
    const err = Object.assign(new Error(PEM), { code: `key=${S3_SECRET}` });
    const deps: PreflightDeps = {
      getStoreBackend: vi.fn().mockReturnValue("fs"),
      getObjectStoreMode: vi.fn().mockReturnValue("fs"),
      getDb: vi.fn(),
      getObjectStore: vi.fn(),
      createKafkaAdmin: vi.fn().mockReturnValue(makeAdmin(err)),
    };
    const promise = preflightDependencies(settings, deps);
    const err2 = (await promise.then(
      () => {
        throw new Error("expected preflightDependencies to reject");
      },
      (e: unknown) => e as Error,
    )) as Error & { cause?: unknown };
    expect(err2.cause).toBeUndefined();
    for (const secret of [S3_SECRET, "BEGIN PRIVATE KEY", "BEGIN CERTIFICATE"]) {
      expect(err2.message).not.toContain(secret);
      expect(String(err2)).not.toContain(secret);
    }
    expect(err2.message).toContain("Kafka preflight failed");
  });
});

describe("defaultKafkaAdmin & defaultPreflightDeps", () => {
  const savedEnv = Object.fromEntries(
    ["OBJECT_STORE", "STORE_BACKEND"].map((key) => [key, process.env[key]]),
  );
  const settings: KafkaSettings = {
    brokers: ["broker1:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };

  let ctorOpts: Array<Record<string, unknown>> = [];
  let adminOpts: Array<Record<string, unknown>> = [];
  const admin = {
    connect: vi.fn().mockResolvedValue(undefined),
    fetchTopicMetadata: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.resetModules();
    ctorOpts = [];
    adminOpts = [];
    for (const key of Object.keys(savedEnv)) delete process.env[key];
    vi.doMock("kafkajs", () => ({
      Kafka: class {
        constructor(opts: Record<string, unknown>) {
          ctorOpts.push(opts);
        }
        admin(opts: Record<string, unknown>) {
          adminOpts.push(opts);
          return admin;
        }
      },
      logLevel: { NOTHING: 0 },
    }));
  });

  afterEach(async () => {
    vi.doUnmock("kafkajs");
    vi.resetModules();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const imported = async (): Promise<typeof import("../worker.js")> => import("../worker.js");

  test("settings without ssl pass ssl: undefined and zero-retry timeouts", async () => {
    const worker = await imported();
    await worker.preflightDependencies(settings);
    expect(ctorOpts).toHaveLength(1);
    expect(ctorOpts[0]).toMatchObject({
      clientId: "campaign-foundry-worker-preflight",
      brokers: ["broker1:9092"],
      ssl: undefined,
      connectionTimeout: 5_000,
      requestTimeout: 5_000,
      retry: { retries: 0 },
      logLevel: 0,
    });
    expect(adminOpts).toEqual([{ retry: { retries: 0 } }]);
    expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({ topics: [settings.topic] });
  });

  test("settings with ssl ca, cert, and key map to rejectUnauthorized with a ca array", async () => {
    const worker = await imported();
    await worker.preflightDependencies({
      ...settings,
      ssl: { ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" },
    });
    expect(ctorOpts[0].ssl).toEqual({
      rejectUnauthorized: true,
      ca: ["CA-PEM"],
      cert: "CERT-PEM",
      key: "KEY-PEM",
    });
  });

  test("settings with ssl cert and key but no ca map to a ca of undefined", async () => {
    const worker = await imported();
    await worker.preflightDependencies({ ...settings, ssl: { cert: "CERT-PEM", key: "KEY-PEM" } });
    expect(ctorOpts[0].ssl).toEqual({
      rejectUnauthorized: true,
      ca: undefined,
      cert: "CERT-PEM",
      key: "KEY-PEM",
    });
  });

  test("defaultKafkaAdmin is the createKafkaAdmin the default deps use", async () => {
    const worker = await imported();
    const direct = worker.defaultKafkaAdmin(settings);
    expect(direct).toBe(admin);
    expect(worker.defaultPreflightDeps.createKafkaAdmin).toBe(worker.defaultKafkaAdmin);
    // `defaultPreflightDeps` wires the real module-scope collaborators, never
    // calls at import: with fs/fs here only the (mocked) Kafka admin runs.
    expect(ctorOpts).toHaveLength(1);
  });
});
