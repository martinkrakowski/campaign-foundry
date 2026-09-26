import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { EachMessagePayload } from "kafkajs";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { isRunRequest, RunConsumer } from "../run-consumer.js";
import type { RunRequest } from "../run-request.js";
import type { KafkaSettings } from "../config.js";
import * as jobs from "../jobs.js";
import * as runRequestModule from "../run-request.js";

const mockConsumerConnect = vi.hoisted(() => vi.fn());
const mockConsumerDisconnect = vi.hoisted(() => vi.fn());
const mockConsumerSubscribe = vi.hoisted(() => vi.fn());
const mockConsumerRun = vi.hoisted(() => vi.fn());
const mockConsumerCommitOffsets = vi.hoisted(() => vi.fn());
const mockKafkaConstructor = vi.hoisted(() => vi.fn());

vi.mock("kafkajs", () => ({
  Kafka: class MockKafka {
    constructor(config: unknown) {
      mockKafkaConstructor(config);
    }
    consumer() {
      return {
        connect: mockConsumerConnect,
        disconnect: mockConsumerDisconnect,
        subscribe: mockConsumerSubscribe,
        run: mockConsumerRun,
        commitOffsets: mockConsumerCommitOffsets,
      };
    }
  },
}));

import { parseBrief } from "../load-brief.js";

const sampleBrief = (): CampaignBrief =>
  parseBrief({
    id: "camp-consumer",
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

describe("isRunRequest validator", () => {
  test("accepts valid RunRequest", () => {
    expect(isRunRequest(sampleRequest())).toBe(true);
  });

  test("rejects non-object or null", () => {
    expect(isRunRequest(null)).toBe(false);
    expect(isRunRequest("string")).toBe(false);
    expect(isRunRequest(123)).toBe(false);
  });

  test("rejects missing or empty jobId", () => {
    expect(isRunRequest({ ...sampleRequest(), jobId: "" })).toBe(false);
    expect(isRunRequest({ ...sampleRequest(), jobId: 123 })).toBe(false);
  });

  test("rejects missing or invalid tenant", () => {
    expect(isRunRequest({ ...sampleRequest(), tenant: null })).toBe(false);
    expect(isRunRequest({ ...sampleRequest(), tenant: { orgId: "" } })).toBe(false);
  });

  test("rejects missing or invalid brief", () => {
    expect(isRunRequest({ ...sampleRequest(), brief: null })).toBe(false);
    expect(isRunRequest({ ...sampleRequest(), brief: { id: "" } })).toBe(false);
  });
});

describe("RunConsumer (PT-6b2, D171, D174d)", () => {
  const settings: KafkaSettings = {
    brokers: ["broker1:9092", "broker2:9092"],
    topic: "cf.run-requests",
    groupId: "cf-workers",
    consume: true,
  };

  let startQueuedJobSpy: ReturnType<typeof vi.spyOn>;
  let runJobSpy: ReturnType<typeof vi.spyOn>;
  let executeRunRequestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockConsumerConnect.mockReset().mockResolvedValue(undefined);
    mockConsumerDisconnect.mockReset().mockResolvedValue(undefined);
    mockConsumerSubscribe.mockReset().mockResolvedValue(undefined);
    mockConsumerRun.mockReset().mockResolvedValue(undefined);
    mockConsumerCommitOffsets.mockReset().mockResolvedValue(undefined);
    mockKafkaConstructor.mockReset();

    startQueuedJobSpy = vi.spyOn(jobs, "startQueuedJob");
    runJobSpy = vi.spyOn(jobs, "runJob").mockImplementation(() => {});
    executeRunRequestSpy = vi
      .spyOn(runRequestModule, "executeRunRequest")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("successful message: calls startQueuedJob, runs job, and commits offset after decision", async () => {
    const callOrder: string[] = [];
    startQueuedJobSpy.mockImplementation(async () => {
      callOrder.push("startQueuedJob");
      return true;
    });

    const commitMock = vi.fn().mockImplementation(async () => {
      callOrder.push("commitOffset");
    });

    const consumer = new RunConsumer(settings);
    const request = sampleRequest();
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "10",
        key: Buffer.from("org-1:camp-consumer"),
        value: Buffer.from(JSON.stringify(request)),
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(startQueuedJobSpy).toHaveBeenCalledTimes(1);
    expect(runJobSpy).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "11");
    expect(callOrder).toEqual(["startQueuedJob", "commitOffset"]);

    // Verify runJob callback passes signal through to executeRunRequest
    const runJobCallback = runJobSpy.mock.calls[0]![2];
    const abortSignal = new AbortController().signal;
    await runJobCallback(abortSignal);
    expect(executeRunRequestSpy).toHaveBeenCalledWith(request, abortSignal);
  });

  test("duplicate message: startQueuedJob returns false, drops run, and commits offset", async () => {
    const callOrder: string[] = [];
    startQueuedJobSpy.mockImplementation(async () => {
      callOrder.push("startQueuedJob");
      return false;
    });

    const commitMock = vi.fn().mockImplementation(async () => {
      callOrder.push("commitOffset");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumer = new RunConsumer(settings);
    const request = sampleRequest();
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "15",
        key: Buffer.from("org-1:camp-consumer"),
        value: Buffer.from(JSON.stringify(request)),
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(startQueuedJobSpy).toHaveBeenCalledTimes(1);
    expect(runJobSpy).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "16");
    expect(callOrder).toEqual(["startQueuedJob", "commitOffset"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dropping duplicate or expired run request for job "00000000-0000-0000-0000-000000000001"',
      ),
    );
  });

  test("replay after completion: drops run and commits offset", async () => {
    startQueuedJobSpy.mockResolvedValue(false);
    const commitMock = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumer = new RunConsumer(settings);
    const request = sampleRequest();
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "20",
        value: Buffer.from(JSON.stringify(request)),
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(runJobSpy).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "21");
    expect(warnSpy).toHaveBeenCalled();
  });

  test("malformed message with empty value: logs and commits offset without starting job", async () => {
    const commitMock = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumer = new RunConsumer(settings);
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "30",
        value: null,
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(startQueuedJobSpy).not.toHaveBeenCalled();
    expect(runJobSpy).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "31");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Dropping empty Kafka message"));
  });

  test("malformed message with invalid JSON: logs and commits offset without starting job", async () => {
    const commitMock = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumer = new RunConsumer(settings);
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "40",
        value: Buffer.from("{invalid json"),
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(startQueuedJobSpy).not.toHaveBeenCalled();
    expect(runJobSpy).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "41");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dropping malformed JSON message"),
    );
  });

  test("malformed message missing required fields: logs and commits offset without starting job", async () => {
    const commitMock = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumer = new RunConsumer(settings);
    const payload = {
      topic: "cf.run-requests",
      partition: 0,
      message: {
        offset: "50",
        value: Buffer.from(JSON.stringify({ notA: "valid-run-request" })),
      },
    } as unknown as EachMessagePayload;

    await consumer.handleMessage(payload, commitMock);

    expect(startQueuedJobSpy).not.toHaveBeenCalled();
    expect(runJobSpy).not.toHaveBeenCalled();
    expect(commitMock).toHaveBeenCalledWith("cf.run-requests", 0, "51");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dropping malformed RunRequest message"),
    );
  });

  test("start and stop lifecycle: connects, subscribes, runs with autoCommit false, and disconnects", async () => {
    const consumer = new RunConsumer(settings);
    await consumer.start();

    expect(mockConsumerConnect).toHaveBeenCalledTimes(1);
    expect(mockConsumerSubscribe).toHaveBeenCalledWith({
      topic: "cf.run-requests",
      fromBeginning: false,
    });
    expect(mockConsumerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        autoCommit: false,
        eachMessage: expect.any(Function),
      }),
    );

    // Calling start again while running is a no-op
    await consumer.start();
    expect(mockConsumerConnect).toHaveBeenCalledTimes(1);

    // Exercise eachMessage runner callback wired to consumer.commitOffsets
    const runner = mockConsumerRun.mock.calls[0]![0];
    startQueuedJobSpy.mockResolvedValue(true);
    const payload = {
      topic: "cf.run-requests",
      partition: 1,
      message: {
        offset: "7",
        value: Buffer.from(JSON.stringify(sampleRequest())),
      },
    } as unknown as EachMessagePayload;
    await runner.eachMessage(payload);
    expect(mockConsumerCommitOffsets).toHaveBeenCalledWith([
      { topic: "cf.run-requests", partition: 1, offset: "8" },
    ]);

    // Stop disconnects
    await consumer.stop();
    expect(mockConsumerDisconnect).toHaveBeenCalledTimes(1);

    // Calling stop again when stopped is a no-op
    await consumer.stop();
    expect(mockConsumerDisconnect).toHaveBeenCalledTimes(1);
  });

  test("throws when initialized without settings and kafkaSettings() returns undefined", () => {
    delete process.env.KAFKA_BROKERS;
    expect(() => new RunConsumer()).toThrow(
      "Cannot initialize RunConsumer without Kafka settings.",
    );
  });

  test("constructs with default kafkaSettings and SSL options", () => {
    const orig = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = "broker1:9092";
    try {
      new RunConsumer();
      expect(mockKafkaConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "campaign-foundry-consumer",
          brokers: ["broker1:9092"],
          ssl: undefined,
        }),
      );
    } finally {
      if (orig === undefined) delete process.env.KAFKA_BROKERS;
      else process.env.KAFKA_BROKERS = orig;
    }
  });

  test("configures SSL when settings carry ca, cert, and key", () => {
    const sslSettings: KafkaSettings = {
      ...settings,
      ssl: {
        ca: "CA-DATA",
        cert: "CERT-DATA",
        key: "KEY-DATA",
      },
    };
    new RunConsumer(sslSettings);
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

  test("configures SSL without ca when ca is not provided", () => {
    const sslSettings: KafkaSettings = {
      ...settings,
      ssl: {
        cert: "CERT-DATA",
        key: "KEY-DATA",
      },
    };
    new RunConsumer(sslSettings);
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

  test("accepts injected consumer or kafka client", () => {
    const customConsumer = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      run: vi.fn(),
      commitOffsets: vi.fn(),
    };
    const c1 = new RunConsumer(settings, undefined, customConsumer as never);
    expect(c1).toBeDefined();

    const customKafka = {
      consumer: vi.fn().mockReturnValue(customConsumer),
    };
    const c2 = new RunConsumer(settings, customKafka as never);
    expect(c2).toBeDefined();
  });
});
