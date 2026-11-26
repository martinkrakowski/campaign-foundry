import { describe, test, expect, afterEach } from "vitest";
import { getPublishedClipStore, resetPublishedClipStore, setPublishedClipStore } from "../index.js";
import type { PublishedClipRecordPort } from "@campaignfoundry/CampaignOrchestration";
import {
  FsPublishedClipStore,
  PublishedClipStoreUnavailableError,
} from "../fs-published-clip-store.js";
import { LOCAL_TENANT } from "../../tenant.js";

describe("FsPublishedClipStore (PT-4k): the public-media ledger is Postgres-only", () => {
  const store = new FsPublishedClipStore();

  test("record refuses, naming that published clips need Postgres", async () => {
    await expect(
      store.record(
        "acme",
        "00000000-0000-4000-8000-000000000000",
        "acme/aaa/0123.mp4",
        "u",
        "0123",
      ),
    ).rejects.toBeInstanceOf(PublishedClipStoreUnavailableError);
    await expect(
      store.record(
        "acme",
        "00000000-0000-4000-8000-000000000000",
        "acme/aaa/0123.mp4",
        "u",
        "0123",
      ),
    ).rejects.toThrow(/STORE_BACKEND=postgres/);
  });

  test("find refuses", async () => {
    await expect(
      store.find("acme", "00000000-0000-4000-8000-000000000000", "0123"),
    ).rejects.toBeInstanceOf(PublishedClipStoreUnavailableError);
  });

  test("listForCampaign refuses", async () => {
    await expect(
      store.listForCampaign("acme", "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(PublishedClipStoreUnavailableError);
  });

  test("remove refuses", async () => {
    await expect(store.remove("acme", "acme/aaa/0123.mp4")).rejects.toBeInstanceOf(
      PublishedClipStoreUnavailableError,
    );
  });

  test("the refusal is 503-shaped", async () => {
    const thrown = await store.remove("acme", "acme/aaa/0123.mp4").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(PublishedClipStoreUnavailableError);
    expect((thrown as PublishedClipStoreUnavailableError).statusCode).toBe(503);
    expect((thrown as PublishedClipStoreUnavailableError).status).toBe(503);
  });
});

describe("the registry builds FsPublishedClipStore when STORE_BACKEND is not postgres (PT-4k)", () => {
  const saved = process.env.STORE_BACKEND;

  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetPublishedClipStore();
  });

  test("the default (fs) backend answers with FsPublishedClipStore", () => {
    delete process.env.STORE_BACKEND;
    resetPublishedClipStore();
    expect(getPublishedClipStore(LOCAL_TENANT)).toBeInstanceOf(FsPublishedClipStore);
  });

  test("a double installed with setPublishedClipStore answers every tenant until reset", () => {
    delete process.env.STORE_BACKEND;
    const double = {
      record: async () => undefined,
      find: async () => undefined,
      listForCampaign: async () => [],
      remove: async () => undefined,
    } as unknown as PublishedClipRecordPort;
    setPublishedClipStore(double);
    expect(getPublishedClipStore(LOCAL_TENANT)).toBe(double);
    expect(getPublishedClipStore({ ...LOCAL_TENANT, orgId: "acme" })).toBe(double);

    resetPublishedClipStore();
    expect(getPublishedClipStore(LOCAL_TENANT)).toBeInstanceOf(FsPublishedClipStore);
  });
});
