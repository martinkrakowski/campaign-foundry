import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  assertNoLeakedTenantDirs,
  mountTenantApp,
  mountTenantRoute,
  setupFsHarness,
  type RouteRegistration,
  type TenantContext,
  type WebCaller,
} from "../../__tests__/tenant-harness.js";
import { getAssetStore, getBriefStore, getJobStore } from "../../../lib/ports/index.js";
import { setCapabilities } from "../../../lib/capabilities.js";
import { resetJobs } from "../../../lib/jobs.js";
import {
  PNG_B64,
  pathsNaming,
  plantCampaign,
  pointedAt,
  sampleBrief,
  snapshotTree,
} from "../../../lib/deletion/__tests__/fs-delete-fixtures.js";
import deleteHandler from "../[id].delete.js";
import idGetHandler from "../[id].get.js";
import briefsPostHandler from "../briefs.post.js";
import assetsPostHandler from "../assets.post.js";
import generateHandler from "../generate.post.js";
import jobHandler from "../jobs/[id].get.js";
import packageHandler from "../package.post.js";
import decisionsPutHandler from "../decisions.put.js";
import draftPutHandler from "../[id]/draft.put.js";
import lastOpenedPutHandler from "../last-opened.put.js";
import createHandler from "../index.post.js";
import resultHandler from "../result.get.js";
import decisionsGetHandler from "../decisions.get.js";
import poolsGetHandler from "../pools/[briefId].get.js";

/**
 * Hoisted passthrough spy for `deleteCampaignOnFileStore`: defaults to the real
 * implementation (installed here and re-installed in `beforeEach`), so every
 * test exercises the real library unless it swaps the spy with `mockXxxOnce`.
 */
const deleteSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/deletion/purge-campaign-fs.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/deletion/purge-campaign-fs.js")>();
  deleteSpy.mockImplementation(actual.deleteCampaignOnFileStore);
  return { ...actual, deleteCampaignOnFileStore: deleteSpy };
});

const admin: TenantContext = {
  orgId: "local",
  userId: "admin",
  roles: ["admin"],
  teamIds: [],
};
const member: TenantContext = {
  orgId: "local",
  userId: "m1",
  roles: ["member"],
  teamIds: ["t1"],
};

const origAuth = process.env.AUTH_MODE;

function mount(tenant: TenantContext = LOCAL_TENANT): WebCaller {
  return mountTenantRoute(deleteHandler, {
    method: "delete",
    path: "/campaigns/:id",
    tenant,
  });
}

function del(call: WebCaller, id: string): Promise<Response> {
  return call(new Request(`http://x/campaigns/${id}`, { method: "DELETE" }));
}

async function createCampaign(slug: string): Promise<void> {
  await getBriefStore(LOCAL_TENANT).createCampaign(slug, {
    name: slug,
    type: "social-post",
  });
}

function filterSnapshot(map: Map<string, string>, ...needles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of map) {
    if (needles.some((n) => k.includes(n))) out.set(k, v);
  }
  return out;
}

beforeEach(async () => {
  deleteSpy.mockClear();
  const real = await vi.importActual<typeof import("../../../lib/deletion/purge-campaign-fs.js")>(
    "../../../lib/deletion/purge-campaign-fs.js",
  );
  deleteSpy.mockImplementation(real.deleteCampaignOnFileStore);
});

afterEach(() => {
  if (origAuth === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = origAuth;
});

afterAll(() => assertNoLeakedTenantDirs());

// --- end-to-end helpers: drive the real producer chain on the file store ---

const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "FIREFLY_CLIENT_ID",
  "FIREFLY_CLIENT_SECRET",
] as const;

type JobBody = {
  status: "running" | "completed" | "failed";
  error?: string;
  result?: { assets: unknown[] };
};

const E2E_ROUTES: RouteRegistration[] = [
  { method: "post", path: "/campaigns", handler: createHandler },
  { method: "post", path: "/campaigns/briefs", handler: briefsPostHandler },
  { method: "post", path: "/campaigns/assets", handler: assetsPostHandler },
  { method: "post", path: "/campaigns/generate", handler: generateHandler },
  { method: "get", path: "/campaigns/jobs/:id", handler: jobHandler },
  { method: "post", path: "/campaigns/package", handler: packageHandler },
  { method: "put", path: "/campaigns/decisions", handler: decisionsPutHandler },
  { method: "put", path: "/campaigns/:id/draft", handler: draftPutHandler },
  { method: "put", path: "/campaigns/last-opened", handler: lastOpenedPutHandler },
  { method: "delete", path: "/campaigns/:id", handler: deleteHandler },
  { method: "get", path: "/campaigns/:id", handler: idGetHandler },
  { method: "get", path: "/campaigns/result", handler: resultHandler },
  { method: "get", path: "/campaigns/decisions", handler: decisionsGetHandler },
  { method: "get", path: "/campaigns/pools/:briefId", handler: poolsGetHandler },
];

interface Api {
  create: (body: unknown) => Promise<Response>;
  uploadAsset: (body: unknown) => Promise<Response>;
  saveBrief: (body: unknown) => Promise<Response>;
  generate: (body: unknown) => Promise<Response>;
  jobsGet: (id: string) => Promise<Response>;
  pkg: (body: unknown) => Promise<Response>;
  putDecisions: (body: unknown) => Promise<Response>;
  putDraft: (id: string, body: unknown) => Promise<Response>;
  putLastOpened: (body: unknown) => Promise<Response>;
  deleteCampaign: (id: string) => Promise<Response>;
  getCampaign: (id: string) => Promise<Response>;
  result: (id: string) => Promise<Response>;
  decisions: (id: string) => Promise<Response>;
  pools: (id: string) => Promise<Response>;
  pollJob: (jobId: string) => Promise<JobBody>;
}

function mountAll(tenant: TenantContext): Api {
  const call = mountTenantApp(E2E_ROUTES, tenant);
  const jsonReq = (path: string, method: "POST" | "PUT" | "DELETE", body: unknown) =>
    call(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const httpGet = (path: string) => call(new Request(`http://x${path}`));
  return {
    create: (body) => jsonReq("/campaigns", "POST", body),
    uploadAsset: (body) => jsonReq("/campaigns/assets", "POST", body),
    saveBrief: (body) => jsonReq("/campaigns/briefs", "POST", body),
    generate: (body) => jsonReq("/campaigns/generate?model=procedural", "POST", body),
    jobsGet: (id) => httpGet(`/campaigns/jobs/${id}`),
    pkg: (body) => jsonReq("/campaigns/package", "POST", body),
    putDecisions: (body) => jsonReq("/campaigns/decisions", "PUT", body),
    putDraft: (id, body) => jsonReq(`/campaigns/${id}/draft`, "PUT", body),
    putLastOpened: (body) => jsonReq("/campaigns/last-opened", "PUT", body),
    deleteCampaign: (id) => call(new Request(`http://x/campaigns/${id}`, { method: "DELETE" })),
    getCampaign: (id) => httpGet(`/campaigns/${id}`),
    result: (id) => httpGet(`/campaigns/result?campaignId=${id}`),
    decisions: (id) => httpGet(`/campaigns/decisions?campaignId=${id}`),
    pools: (id) => httpGet(`/campaigns/pools/${id}`),
    pollJob: pollJob.bind(null, (id: string) => httpGet(`/campaigns/jobs/${id}`)),
  };
}

async function pollJob(
  jobsGet: (id: string) => Promise<Response>,
  jobId: string,
): Promise<JobBody> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await jobsGet(jobId);
    const body = (await res.json()) as JobBody;
    if (body.status === "completed" || body.status === "failed") return body;
    if (Date.now() > deadline) throw new Error(`timed out waiting for job ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DELETE /campaigns/:id — file store", () => {
  test("DELETE /campaigns/:id deletes a campaign on the file store and removes every tree that names its slug", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale-2", "u-sale2");

      const before2 = filterSnapshot(snapshotTree(harness.tmpDir), "sale-2");
      expect(pointedAt(join(harness.projectRoot, "state", "last-opened"), "sale")).toEqual([
        "u-sale.json",
      ]);
      expect(
        (await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === "sale"),
      ).toBe(true);

      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      expect(
        (await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === "sale"),
      ).toBe(false);
      expect(pathsNaming(harness.tmpDir, "sale-2")).toEqual(
        expect.arrayContaining([
          "project/briefs/sale-2.yaml",
          "project/briefs/sale-2/campaign.json",
          "project/assets/inputs/sale-2/logo.png",
          "output/sale-2/alpha/1x1/default.png",
          "output/packages/sale-2/p1/x.zip",
          "output/reports/sale-2.json",
          "output/decisions/sale-2.json",
        ]),
      );
      expect(pointedAt(join(harness.projectRoot, "state", "last-opened"), "sale")).toEqual([]);

      expect(filterSnapshot(snapshotTree(harness.tmpDir), "sale-2")).toEqual(before2);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id deletes a campaign that has no saved version on the file store", async () => {
    const harness = setupFsHarness();
    try {
      await createCampaign("sale");
      expect(existsSync(join(harness.projectRoot, "briefs", "sale", "campaign.json"))).toBe(true);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale.yaml"))).toBe(false);

      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      expect(existsSync(join(harness.projectRoot, "briefs", "sale"))).toBe(false);
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeUndefined();
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 on the file store for an unknown campaign and creates nothing", async () => {
    const harness = setupFsHarness();
    try {
      const before = snapshotTree(harness.tmpDir);
      const res = await del(mount(LOCAL_TENANT), "ghost");
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'Campaign "ghost" not found.',
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 on the file store the second time", async () => {
    const harness = setupFsHarness();
    try {
      await createCampaign("sale");
      expect((await del(mount(LOCAL_TENANT), "sale")).status).toBe(200);
      expect((await del(mount(LOCAL_TENANT), "sale")).status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 404 on the file store when the campaign vanishes between the check and the lock", async () => {
    const harness = setupFsHarness();
    try {
      await createCampaign("sale");
      const before = snapshotTree(harness.tmpDir);
      deleteSpy.mockResolvedValueOnce({ outcome: "not-found" });
      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'Campaign "sale" not found.',
      });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 409 on the file store with the running jobId and removes nothing", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const running = await getJobStore(LOCAL_TENANT).acquireJob("sale");
      expect(running.acquired).toBe(true);
      const jobId = running.acquired ? running.jobId : "";
      const before = snapshotTree(harness.tmpDir);

      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string; jobId: string }).toEqual({
        error: 'Campaign "sale" has a run in progress.',
        jobId,
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 403 on the file store for a member and removes nothing", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const before = snapshotTree(harness.tmpDir);

      const res = await del(mount(member), "sale");
      expect(res.status).toBe(403);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'You may not delete campaign "sale".',
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);

      // In the same test an admin on the org-wide campaign deletes a second campaign.
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "second", "u-second");
      const ok = await del(mount(admin), "second");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ deleted: true });
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("sale")).toBeDefined();
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 400 on the file store for a path-unsafe id", async () => {
    const harness = setupFsHarness();
    try {
      const before = snapshotTree(harness.tmpDir);
      const res = await mount(LOCAL_TENANT)(
        new Request("http://x/campaigns/..%2Fetc", { method: "DELETE" }),
      );
      expect(res.status).toBe(400);
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 400 on the file store when a tree is a symlink and removes nothing", async () => {
    const harness = setupFsHarness();
    const outside = join(harness.tmpDir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      const assetsSale = join(harness.projectRoot, "assets", "inputs", "sale");
      rmSync(assetsSale, { recursive: true, force: true });
      symlinkSync(outside, assetsSale);

      const before = snapshotTree(harness.tmpDir);
      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'Campaign "sale" has a symlinked storage path; nothing was deleted.',
      });
      expect(snapshotTree(harness.tmpDir)).toEqual(before);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id answers 500 on the file store when the delete throws and removes nothing", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "sale", "u-sale");
      expect(existsSync(join(harness.projectRoot, "briefs", "sale.yaml"))).toBe(true);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale", "campaign.json"))).toBe(true);
      const before = snapshotTree(harness.tmpDir);

      deleteSpy.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      const res = await del(mount(LOCAL_TENANT), "sale");
      expect(res.status).toBe(500);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale.yaml"))).toBe(true);
      expect(existsSync(join(harness.projectRoot, "briefs", "sale", "campaign.json"))).toBe(true);
      expect(snapshotTree(harness.tmpDir)).toEqual(before);

      // A second DELETE runs the real library and completes the delete.
      const res2 = await del(mount(LOCAL_TENANT), "sale");
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ deleted: true });
      expect(pathsNaming(harness.tmpDir, "sale")).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  test("DELETE /campaigns/:id on the file store stays inside the callers org", async () => {
    const harness = setupFsHarness();
    try {
      await plantCampaign(ACME_TENANT, harness.acmeRoots, "sale", "u-acme");
      await plantCampaign(LOCAL_TENANT, harness.localRoots, "localonly", "u-local");
      const before = snapshotTree(harness.tmpDir);

      const res = await del(mount(ACME_TENANT), "sale");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      const after = snapshotTree(harness.tmpDir);
      // Everything outside the caller's org tree is byte-identical.
      for (const [key, value] of before) {
        if (!key.includes("orgs/acme")) expect(after.get(key)).toBe(value);
      }
      // The local-only campaign is untouched.
      expect(await getBriefStore(LOCAL_TENANT).campaignMeta("localonly")).toBeDefined();

      // A slug that lives only under the local org is 404 for the acme caller.
      const missing = await del(mount(ACME_TENANT), "localonly");
      expect(missing.status).toBe(404);
    } finally {
      harness.cleanup();
    }
  });
});

test("DELETE /campaigns/:id then removes every location a real run wrote on the file store", async () => {
  const savedObjectStore = process.env.OBJECT_STORE;
  const savedProviderKeys: Record<string, string | undefined> = {};
  delete process.env.OBJECT_STORE;
  for (const key of PROVIDER_KEYS) {
    savedProviderKeys[key] = process.env[key];
    delete process.env[key];
  }
  setCapabilities({ motion: true });
  try {
    const harness = setupFsHarness();
    try {
      const api = mountAll(LOCAL_TENANT);
      const lastOpenedDir = join(harness.projectRoot, "state", "last-opened");

      // (1) create Sale and Sale 2.
      const saleRes = await api.create({ name: "Sale", type: "social-post" });
      expect(saleRes.status).toBe(201);
      const { slug: sale } = (await saleRes.json()) as { campaignId: string; slug: string };
      expect(sale).toBe("sale");

      const sale2Res = await api.create({ name: "Sale 2", type: "social-post" });
      expect(sale2Res.status).toBe(201);
      const { slug: sale2 } = (await sale2Res.json()) as { campaignId: string; slug: string };
      expect(sale2).toBe("sale-2");

      // (2) upload the logo and save a brief for both.
      const asset1 = await api.uploadAsset({
        briefId: sale,
        name: "logo.png",
        contentBase64: PNG_B64,
      });
      expect(asset1.status).toBe(201);
      const asset2 = await api.uploadAsset({
        briefId: sale2,
        name: "logo.png",
        contentBase64: PNG_B64,
      });
      expect(asset2.status).toBe(201);

      const briefed = await api.saveBrief(sampleBrief(sale));
      expect(briefed.status).toBe(201);
      const saleRevision = ((await briefed.json()) as { revision: string }).revision;
      const briefed2 = await api.saveBrief(sampleBrief(sale2));
      expect(briefed2.status).toBe(201);

      // (3) generate for both, poll to completed; package sale.
      for (const slug of [sale, sale2]) {
        const gen = await api.generate(sampleBrief(slug));
        expect(gen.status).toBe(202);
        const { jobId } = (await gen.json()) as { jobId: string };
        const done = await api.pollJob(jobId);
        expect(done.status).toBe("completed");
        expect(done.result).toBeDefined();
      }
      const pkg = await api.pkg({ campaignId: sale, platforms: ["instagram-feed"] });
      expect(pkg.status).toBe(200);

      // (4) decisions, draft and last-opened for sale only.
      const dec = await api.putDecisions({
        campaignId: sale,
        revision: null,
        decisions: { "alpha/1:1/default": "approved" },
      });
      expect(dec.status).toBe(200);
      const dr = await api.putDraft(sale, {
        state: { source: { kind: "new" }, mode: "single" },
        baseRevision: saleRevision,
      });
      expect(dr.status).toBe(200);
      const lo = await api.putLastOpened({ campaignId: sale });
      expect(lo.status).toBe(200);

      // (5) before: every location that names sale, a last-opened pointer, a job,
      // and a byte snapshot of sale-2.
      const salePaths = pathsNaming(harness.tmpDir, sale);
      expect(salePaths).toEqual(
        expect.arrayContaining([
          "project/briefs/sale.yaml",
          "project/briefs/sale/campaign.json",
          "output/reports/sale.json",
          "output/decisions/sale.json",
          "output/packages/sale",
          "project/assets/inputs/sale/logo.png",
        ]),
      );
      expect(salePaths.some((p) => p.startsWith("output/sale/"))).toBe(true);
      expect((await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === sale)).toBe(
        true,
      );
      expect(pointedAt(lastOpenedDir, sale)).toEqual(["local.json"]);
      const before2 = filterSnapshot(snapshotTree(harness.tmpDir), sale2);

      // (6) delete sale.
      const delRes = await api.deleteCampaign(sale);
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ deleted: true });

      // (7) after: sale is gone, sale-2 is byte-identical, sale is 404 twice.
      expect(pathsNaming(harness.tmpDir, sale)).toEqual([]);
      expect((await getJobStore(LOCAL_TENANT).listJobs()).some((j) => j.campaignId === sale)).toBe(
        false,
      );
      expect(pointedAt(lastOpenedDir, sale)).toEqual([]);
      expect(filterSnapshot(snapshotTree(harness.tmpDir), sale2)).toEqual(before2);
      expect((await api.getCampaign(sale)).status).toBe(404);
      expect((await api.getCampaign(sale2)).status).toBe(200);
      expect((await api.deleteCampaign(sale)).status).toBe(404);

      // (8) re-create: the slug recycles and inherits nothing.
      const rec = await api.create({ name: "Sale", type: "social-post" });
      expect(rec.status).toBe(201);
      const { slug: recSlug } = (await rec.json()) as { slug: string };
      expect(recSlug).toBe("sale");
      const recGet = await api.getCampaign("sale");
      expect(recGet.status).toBe(200);
      const recBody = (await recGet.json()) as { hasVersion: boolean };
      expect(recBody.hasVersion).toBe(false);
      expect((await api.result("sale")).status).toBe(404);
      expect((await api.decisions("sale")).status).toBe(404);
      expect((await api.pools("sale")).status).toBe(404);
      expect(await getAssetStore(LOCAL_TENANT).listAssets("sale")).toEqual([]);
    } finally {
      harness.cleanup();
    }
  } finally {
    setCapabilities({ motion: false, reason: "not probed" });
    vi.restoreAllMocks();
    await resetJobs();
    for (const key of PROVIDER_KEYS) {
      if (savedProviderKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedProviderKeys[key];
    }
    if (savedObjectStore === undefined) delete process.env.OBJECT_STORE;
    else process.env.OBJECT_STORE = savedObjectStore;
  }
}, 120_000);
