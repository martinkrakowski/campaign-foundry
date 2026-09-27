import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";
import { enqueueJob, getJob, resetJobs, startQueuedJob } from "../jobs.js";
import { executeRunRequest, type RunRequest } from "../run-request.js";
import { resetProviderKeyStore, setProviderKeyStore } from "../ports/index.js";
import type { Provider, ProviderKeyPort, ProviderKeySummary } from "../ports/provider-key.port.js";
import { setCapabilities } from "../capabilities.js";
import { runEnvironment } from "../run-environment.js";
import * as pipelineModule from "../pipeline.js";

const sampleBrief = (): CampaignBrief => ({
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

    let seenEnv: pipelineModule.RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: { campaignId: "camp-org-keys" } as any,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    expect(claim.acquired).toBe(true);
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

    let seenEnv: pipelineModule.RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: { campaignId: "camp-org-keys" } as any,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    expect(claim.acquired).toBe(true);
    await startQueuedJob(env, claim.jobId);

    const request: RunRequest = {
      jobId: claim.jobId,
      tenant,
      brief,
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

    let seenEnv: pipelineModule.RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: { campaignId: "camp-org-keys" } as any,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    expect(claim.acquired).toBe(true);
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

    let seenEnv: pipelineModule.RunEnvironment | undefined;
    vi.spyOn(pipelineModule, "runCampaign").mockImplementation(async (env) => {
      seenEnv = env;
      return {
        success: true,
        value: {
          assets: [],
          halted: false,
          log: { campaignId: "camp-org-keys" } as any,
          policyHash: "h",
          seed: 1,
        },
      };
    });

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    expect(claim.acquired).toBe(true);
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
    expect(claim.acquired).toBe(true);
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
        log: { campaignId: "camp-org-keys" } as any,
        policyHash: "h",
        seed: 1,
      },
    }));

    const brief = sampleBrief();
    const env = runEnvironment(tenant);
    const claim = await enqueueJob(env, brief.id);
    expect(claim.acquired).toBe(true);
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
});
