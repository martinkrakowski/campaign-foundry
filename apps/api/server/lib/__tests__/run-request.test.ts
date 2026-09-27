import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CampaignBrief,
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";
import { enqueueJob, resetJobs, startQueuedJob } from "../jobs.js";
import { executeRunRequest, overlayOrgKeys, type RunRequest } from "../run-request.js";
import { resetProviderKeyStore, setProviderKeyStore } from "../ports/index.js";
import type { Provider, ProviderKeyPort } from "../ports/provider-key.port.js";
import { setCapabilities } from "../capabilities.js";
import { runEnvironment, type RunEnvironment } from "../run-environment.js";
import * as pipelineModule from "../pipeline.js";

const sampleBrief = (): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp-org-keys",
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

/** The mocked run's log: these tests read only `campaignId`. */
type RunLog = Extract<
  Awaited<ReturnType<typeof pipelineModule.runCampaign>>,
  { success: true }
>["value"]["log"];
const RUN_LOG = { campaignId: "camp-org-keys" } as unknown as RunLog;

/** A ProviderKeyStore double for testing key resolution. */
function fakeProviderKeyStore(keys: Partial<Record<Provider, string>>): ProviderKeyPort {
  return {
    put: async () => {
      throw new Error("not implemented");
    },
    list: async () =>
      Object.keys(keys).map((provider) => ({
        provider: provider as Provider,
        last4: "1234",
        createdAt: new Date().toISOString(),
      })),
    revoke: async () => {},
    open: async (provider: Provider) => keys[provider],
  };
}

describe("executeRunRequest org provider keys (PT-7b3a, D175)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-org-keys-"));
    process.env.OUTPUT_DIR = dir;
    process.env.GEMINI_API_KEY = "platform-gemini-secret-key-9999";
    setCapabilities({ motion: true });
  });

  afterEach(async () => {
    await resetJobs();
    resetProviderKeyStore();
    rmSync(dir, { recursive: true, force: true });
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGemini;
    setCapabilities({ motion: false, reason: "not probed" });
    vi.restoreAllMocks();
  });

  test("resolves the org's active key at execution time and records keyOwner: 'org'", async () => {
    const orgKey = "org-gemini-secret-key-1111";
    setProviderKeyStore(fakeProviderKeyStore({ gemini: orgKey }));

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "imagen",
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    // The run must use the org's active key, not the platform key
    expect(seenEnv?.providers.geminiKey).toBe(orgKey);
    // Providers must record whose key each provider uses
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("org");
    expect(seenEnv?.providers.keyOwners?.openrouter).toBe("platform");
    expect(seenEnv?.providers.keyOwners?.firefly).toBe("platform");
  });

  test("resolves OpenRouter and Firefly org keys when active, decoding Firefly JSON", async () => {
    const orgOpenRouterKey = "org-openrouter-secret-key-2222";
    const fireflyPlaintext = JSON.stringify({
      clientId: "org-firefly-client-id",
      clientSecret: "org-firefly-secret",
    });
    setProviderKeyStore(
      fakeProviderKeyStore({
        openrouter: orgOpenRouterKey,
        firefly: fireflyPlaintext,
      }),
    );

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "firefly",
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    expect(seenEnv?.providers.openRouterKey).toBe(orgOpenRouterKey);
    expect(seenEnv?.providers.keyOwners?.openrouter).toBe("org");
    expect(seenEnv?.providers.fireflyClientId).toBe("org-firefly-client-id");
    expect(seenEnv?.providers.fireflyClientSecret).toBe("org-firefly-secret");
    expect(seenEnv?.providers.keyOwners?.firefly).toBe("org");
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("platform");
  });

  test("a revoked key falls back to the platform key", async () => {
    // open returns undefined for revoked or unconfigured keys
    setProviderKeyStore(fakeProviderKeyStore({ gemini: undefined }));

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    expect(seenEnv?.providers.geminiKey).toBe("platform-gemini-secret-key-9999");
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("platform");
  });

  test("falls back to platform keys when provider key store throws ProviderKeyUnavailableError", async () => {
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => {
        throw new Error("not implemented");
      },
      revoke: async () => {},
      open: async () => {
        const { ProviderKeyUnavailableError } = await import("../ports/provider-key.port.js");
        throw new ProviderKeyUnavailableError("BYOK needs Postgres");
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    expect(seenEnv?.providers.geminiKey).toBe("platform-gemini-secret-key-9999");
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("platform");
  });

  test("propagates unexpected store error during key resolution", async () => {
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => {
        throw new Error("not implemented");
      },
      revoke: async () => {},
      open: async () => {
        throw new Error("database connection lost");
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      reroll: false,
    };

    await expect(executeRunRequest(request)).rejects.toThrow("database connection lost");
  });

  test("no key appears in a log, response or RunRequest", async () => {
    const orgKey = "org-gemini-secret-key-1111";
    setProviderKeyStore(fakeProviderKeyStore({ gemini: orgKey }));

    const logSpy = vi.spyOn(console, "log");
    const warnSpy = vi.spyOn(console, "warn");
    const errorSpy = vi.spyOn(console, "error");
    const infoSpy = vi.spyOn(console, "info");

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async () => ({
      success: true,
      value: {
        assets: [],
        halted: false,
        log: RUN_LOG,
        policyHash: "h",
        seed: 1,
      },
    }));

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "imagen",
      reroll: false,
    };

    // Assert RunRequest does not carry key
    expect(JSON.stringify(request)).not.toContain(orgKey);
    expect(JSON.stringify(request)).not.toContain("platform-gemini-secret-key-9999");

    await executeRunRequest(request);

    // Assert no key was logged
    const allLogged = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(allLogged).not.toContain(orgKey);
    expect(allLogged).not.toContain("platform-gemini-secret-key-9999");
  });

  test.each([
    ["invalid JSON", "invalid-not-json"],
    ["null", "null"],
    ["an array", "[]"],
    ["missing clientId", JSON.stringify({ clientSecret: "platform-sec" })],
    ["missing clientSecret", JSON.stringify({ clientId: "platform-id" })],
    ["empty clientId", JSON.stringify({ clientId: "", clientSecret: "platform-sec" })],
    ["empty clientSecret", JSON.stringify({ clientId: "platform-id", clientSecret: "" })],
    ["non-string clientId", JSON.stringify({ clientId: 123, clientSecret: "platform-sec" })],
    ["non-string clientSecret", JSON.stringify({ clientId: "platform-id", clientSecret: true })],
  ])(
    "corrupt Firefly plaintext (%s) falls back to platform Firefly credentials",
    async (_desc, plaintext) => {
      setProviderKeyStore(fakeProviderKeyStore({ firefly: plaintext }));
      const baseEnv = runEnvironment(LOCAL_TENANT);
      const env = await overlayOrgKeys(baseEnv);
      expect(env.providers.fireflyClientId).toBe(baseEnv.providers.fireflyClientId);
      expect(env.providers.fireflyClientSecret).toBe(baseEnv.providers.fireflyClientSecret);
      expect(env.providers.keyOwners?.firefly).toBe("platform");
    },
  );

  test("defaults keyOwners to platform when baseEnv has keyOwners: undefined", async () => {
    setProviderKeyStore(fakeProviderKeyStore({}));
    const baseEnv: RunEnvironment = {
      ...runEnvironment(LOCAL_TENANT),
      providers: {
        ...runEnvironment(LOCAL_TENANT).providers,
        keyOwners: undefined,
      },
    };
    const env = await overlayOrgKeys(baseEnv);
    expect(env.providers.keyOwners).toEqual({
      gemini: "platform",
      openrouter: "platform",
      firefly: "platform",
    });
  });

  test("a decryption failure on an unused provider does not fail the run", async () => {
    const orgKey = "org-gemini-secret-key-1111";
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => [
        { provider: "gemini", last4: "1111", createdAt: new Date().toISOString() },
        { provider: "firefly", last4: "9999", createdAt: new Date().toISOString() },
      ],
      revoke: async () => {},
      open: async (provider) => {
        if (provider === "firefly") throw new Error("corrupted Firefly ciphertext");
        if (provider === "gemini") return orgKey;
        return undefined;
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "imagen",
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    expect(seenEnv?.providers.geminiKey).toBe(orgKey);
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("org");
  });

  test("a failure opening a key the run DOES use fails the run and does not fall back to platform", async () => {
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => [
        { provider: "gemini", last4: "1111", createdAt: new Date().toISOString() },
      ],
      revoke: async () => {},
      open: async (provider) => {
        if (provider === "gemini") throw new Error("corrupted Gemini ciphertext");
        return undefined;
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "imagen",
      reroll: false,
    };

    // Must reject, failing the run instead of using the platform geminiKey
    await expect(executeRunRequest(request)).rejects.toThrow("corrupted Gemini ciphertext");
  });

  test("an org-keyed Imagen fallback under Firefly meters org", async () => {
    const origFfId = process.env.FIREFLY_CLIENT_ID;
    const origFfSec = process.env.FIREFLY_CLIENT_SECRET;
    process.env.FIREFLY_CLIENT_ID = "platform-firefly-id";
    process.env.FIREFLY_CLIENT_SECRET = "platform-firefly-secret";

    try {
      const orgGeminiKey = "org-gemini-secret-key-fallback";
      setProviderKeyStore(fakeProviderKeyStore({ gemini: orgGeminiKey }));

      const tenant: TenantContext = {
        orgId: "org-acme",
        userId: "user-1",
        roles: ["owner"],
        teamIds: [],
      };

      let seenEnv: RunEnvironment | undefined;
      vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
        seenEnv = env;
        return {
          success: true,
          value: {
            assets: [],
            halted: false,
            log: RUN_LOG,
            policyHash: "h",
            seed: 1,
          },
        };
      });

      const brief = sampleBrief();
      const env = runEnvironment(tenant);
      const claim = await enqueueJob(env, brief.id);
      if (!claim.acquired) throw new Error("job not acquired");
      await startQueuedJob(env, claim.jobId);

      const request: RunRequest = {
        jobId: claim.jobId,
        tenant,
        brief,
        imageModel: "firefly",
        reroll: false,
      };

      await executeRunRequest(request);

      expect(seenEnv).toBeDefined();
      // Firefly is platform (no org Firefly key), but Gemini fallback must be org-owned
      expect(seenEnv?.providers.geminiKey).toBe(orgGeminiKey);
      expect(seenEnv?.providers.keyOwners?.gemini).toBe("org");
      expect(seenEnv?.providers.keyOwners?.firefly).toBe("platform");
    } finally {
      if (origFfId === undefined) delete process.env.FIREFLY_CLIENT_ID;
      else process.env.FIREFLY_CLIENT_ID = origFfId;
      if (origFfSec === undefined) delete process.env.FIREFLY_CLIENT_SECRET;
      else process.env.FIREFLY_CLIENT_SECRET = origFfSec;
    }
  });

  test("a fallback key that fails to decrypt does not fail the run", async () => {
    const fireflyPlaintext = JSON.stringify({
      clientId: "org-firefly-client-id",
      clientSecret: "org-firefly-secret",
    });
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => [
        { provider: "firefly", last4: "1234", createdAt: new Date().toISOString() },
        { provider: "gemini", last4: "5678", createdAt: new Date().toISOString() },
      ],
      revoke: async () => {},
      open: async (provider) => {
        if (provider === "firefly") return fireflyPlaintext;
        if (provider === "gemini") throw new Error("corrupted Gemini fallback key");
        return undefined;
      },
    };
    setProviderKeyStore(store);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "firefly",
      reroll: false,
    };

    // Does NOT fail the run
    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    // Primary Firefly used org key
    expect(seenEnv?.providers.fireflyClientId).toBe("org-firefly-client-id");
    expect(seenEnv?.providers.keyOwners?.firefly).toBe("org");
    // Gemini fallback fell back to platform key because decryption failed
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("platform");

    // Warn logged provider and error class only, never key material
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[overlay-org-keys] fallback provider "gemini" key unavailable: Error',
      ),
    );
  });

  test("a fallback key that fails with non-Error rejection logs UnknownError and does not fail run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => [
        { provider: "firefly", last4: "1234", createdAt: new Date().toISOString() },
        { provider: "gemini", last4: "5678", createdAt: new Date().toISOString() },
      ],
      revoke: async () => {},
      open: async (provider) => {
        if (provider === "firefly") {
          return JSON.stringify({
            clientId: "org-firefly-client-id",
            clientSecret: "org-firefly-client-secret",
          });
        }
        if (provider === "gemini") {
          return Promise.reject("raw-string-failure");
        }
        return undefined;
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    let seenEnv: RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: RUN_LOG,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "firefly",
      reroll: false,
    };

    await executeRunRequest(request);

    expect(seenEnv).toBeDefined();
    expect(seenEnv?.providers.keyOwners?.gemini).toBe("platform");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[overlay-org-keys] fallback provider "gemini" key unavailable: UnknownError',
      ),
    );
  });

  test("a primary key that fails still does fail the run", async () => {
    const store: ProviderKeyPort = {
      put: async () => {
        throw new Error("not implemented");
      },
      list: async () => [
        { provider: "firefly", last4: "1234", createdAt: new Date().toISOString() },
      ],
      revoke: async () => {},
      open: async (provider) => {
        if (provider === "firefly") throw new Error("corrupted Firefly primary ciphertext");
        return undefined;
      },
    };
    setProviderKeyStore(store);

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    if (!claim.acquired) throw new Error("job not acquired");
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
      imageModel: "firefly",
      reroll: false,
    };

    await expect(executeRunRequest(request)).rejects.toThrow(
      "corrupted Firefly primary ciphertext",
    );
  });

  test("overlayOrgKeys resolves specific providers and respects primary option", async () => {
    const orgOpenRouter = "sk-or-v1-explicit-primary";
    setProviderKeyStore(fakeProviderKeyStore({ openrouter: orgOpenRouter }));

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };
    const baseEnv = runEnvironment(tenant);
    const env = await overlayOrgKeys(baseEnv, {
      providers: ["openrouter"],
      primary: "openrouter",
    });

    expect(env.providers.openRouterKey).toBe(orgOpenRouter);
    expect(env.providers.keyOwners?.openrouter).toBe("org");
  });

  test("overlayOrgKeys defaults to all providers when options omitted", async () => {
    const orgOpenRouter = "sk-or-v1-all-providers";
    setProviderKeyStore(fakeProviderKeyStore({ openrouter: orgOpenRouter }));

    const tenant: TenantContext = {
      orgId: "org-acme",
      userId: "user-1",
      roles: ["owner"],
      teamIds: [],
    };
    const baseEnv = runEnvironment(tenant);
    const env = await overlayOrgKeys(baseEnv);

    expect(env.providers.openRouterKey).toBe(orgOpenRouter);
    expect(env.providers.keyOwners?.openrouter).toBe("org");
  });
});
