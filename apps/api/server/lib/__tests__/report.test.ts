import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PipelineExecutionLog,
  type GeneratedAsset,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import { campaignReportPath, isPersistedAsset, latestReportPath, readReport, writeReport } from "../report.js";

type ReportAsset = GeneratedAsset & { brandCompliant: boolean };

const asset = (over: Partial<GeneratedAsset> = {}): GeneratedAsset => ({
  productId: "alpha",
  aspectRatio: "1:1",
  outputPath: "alpha/1x1.png",
  proofPath: "proofs/alpha.pdf",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  treatment: "default",
  backgroundSource: "procedural",
  ...over,
});
const beta = (over: Partial<GeneratedAsset> = {}) => asset({ productId: "beta", outputPath: "beta/1x1.png", ...over });
const result = (assets: GeneratedAsset[], campaignId = "camp"): PipelineResult => ({
  assets,
  log: new PipelineExecutionLog(campaignId, () => new Date("2026-01-01T00:00:00.000Z")),
  halted: false,
});
const readAssets = (p: string): ReportAsset[] => (JSON.parse(readFileSync(p, "utf8")) as { assets: ReportAsset[] }).assets;

describe("report persistence", () => {
  let root: string;
  const orig = process.env.OUTPUT_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-report-"));
    process.env.OUTPUT_DIR = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (orig === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = orig;
    vi.restoreAllMocks();
  });

  test("campaignReportPath: reports path for a safe id, null for an unsafe one", () => {
    expect(campaignReportPath(root, "camp")).toBe(resolve(root, "reports", "camp.json"));
    expect(campaignReportPath(root, "../evil")).toBeNull();
  });

  test("latestReportPath points at report.json", () => {
    expect(latestReportPath(root)).toBe(resolve(root, "report.json"));
  });

  test("readReport returns the parsed per-campaign report", async () => {
    await writeReport(result([asset()]));
    await expect(readReport(root, "camp")).resolves.toMatchObject({
      halted: false,
      assets: [expect.objectContaining({ productId: "alpha" })],
    });
  });

  test("readReport returns undefined for an unsafe id", async () => {
    await expect(readReport(root, "../evil")).resolves.toBeUndefined();
  });

  test("readReport returns undefined when the file is missing", async () => {
    await expect(readReport(root, "camp")).resolves.toBeUndefined();
  });

  test("readReport returns undefined for invalid JSON", async () => {
    mkdirSync(resolve(root, "reports"), { recursive: true });
    writeFileSync(resolve(root, "reports", "camp.json"), "{not json");
    await expect(readReport(root, "camp")).resolves.toBeUndefined();
  });

  test("writes per-campaign and latest, deriving brandCompliant (density AND logo)", async () => {
    const path = await writeReport(result([asset({ logoApplied: false }), beta()]));
    expect(path).toBe(resolve(root, "reports", "camp.json"));

    const per = readAssets(path);
    expect(per[0].brandCompliant).toBe(false); // passed but no logo
    expect(per[1].brandCompliant).toBe(true);
    expect(readAssets(resolve(root, "report.json"))).toHaveLength(2);
  });

  test("merge overlays regenerated cells onto the prior report by identity", async () => {
    await writeReport(result([asset(), beta()]));
    const path = await writeReport(result([asset({ complianceScore: 0.9 })]), { merge: true });

    const per = readAssets(path);
    expect(per).toHaveLength(2); // beta preserved, alpha replaced
    expect(per.find((a) => a.productId === "alpha")?.complianceScore).toBe(0.9);
  });

  test("merge from a missing prior report starts empty", async () => {
    const path = await writeReport(result([asset()]), { merge: true });
    expect(readAssets(path)).toHaveLength(1);
  });

  test("isPersistedAsset requires the four string identity/path fields", () => {
    expect(isPersistedAsset({ productId: "alpha", aspectRatio: "1:1" })).toBe(false);
    expect(isPersistedAsset({ productId: "alpha", aspectRatio: "1:1", treatment: "default" })).toBe(false);
    expect(
      isPersistedAsset({ productId: "alpha", aspectRatio: "1:1", treatment: "default", outputPath: "alpha/1x1.png" }),
    ).toBe(true);
    expect(isPersistedAsset(null)).toBe(false);
    expect(isPersistedAsset("nope")).toBe(false);
    expect(
      isPersistedAsset({ productId: 1, aspectRatio: "1:1", treatment: "default", outputPath: "alpha/1x1.png" }),
    ).toBe(false);
  });

  test("isPersistedAsset requires a string videoPath on motion rows", () => {
    const motion = {
      productId: "alpha",
      aspectRatio: "9:16",
      treatment: "headline-top-bold",
      outputPath: "alpha/9x16/v1.png",
      variantIndex: 1,
      attempt: 0,
      format: "motion",
      durationSec: 6,
    };
    expect(isPersistedAsset(motion)).toBe(false);
    expect(isPersistedAsset({ ...motion, videoPath: "alpha/9x16/v1.mp4" })).toBe(true);
    expect(isPersistedAsset({ ...motion, format: "static" })).toBe(true);
  });

  test("isPersistedAsset requires the four strings plus integer variantIndex and attempt on variation rows", () => {
    const variation = {
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "headline-top-bold",
      outputPath: "alpha/1x1/v0.png",
      variantIndex: 0,
      attempt: 0,
    };
    expect(isPersistedAsset(variation)).toBe(true);
    expect(isPersistedAsset({ ...variation, variantIndex: 1.5 })).toBe(false);
    expect(isPersistedAsset({ ...variation, variantIndex: -1 })).toBe(false);
    expect(isPersistedAsset({ ...variation, attempt: -1 })).toBe(false);
    expect(isPersistedAsset({ ...variation, attempt: 1.2 })).toBe(false);
    expect(isPersistedAsset({ ...variation, attempt: undefined })).toBe(false);
    expect(isPersistedAsset({ ...variation, aspectRatio: undefined })).toBe(false);
    expect(isPersistedAsset({ ...variation, treatment: undefined })).toBe(false);
  });

  test("merge of a re-rolled variation slot replaces exactly one row; siblings unchanged", async () => {
    const v0 = asset({
      variantIndex: 0,
      attempt: 0,
      outputPath: "alpha/1x1/v0.png",
      treatment: "headline-bottom-bold",
      seed: 1,
      format: "static",
    });
    const v1 = asset({
      productId: "beta",
      variantIndex: 1,
      attempt: 0,
      outputPath: "beta/9x16/v1.png",
      treatment: "headline-top-subtle",
      seed: 2,
      format: "static",
    });
    await writeReport({
      ...result([v0, v1]),
      policyHash: "abc",
      seed: 42,
    });
    const path = await writeReport(
      { ...result([asset({ ...v0, complianceScore: 0.9, seed: 99 })]), policyHash: "abc", seed: 42 },
      { merge: true },
    );
    const per = readAssets(path);
    expect(per).toHaveLength(2); // count stays at the original row count
    expect(per.find((a) => a.variantIndex === 0)?.complianceScore).toBe(0.9);
    expect(per.find((a) => a.variantIndex === 1)?.outputPath).toBe("beta/9x16/v1.png");
    const payload = JSON.parse(readFileSync(path, "utf8")) as { policyHash: string; seed: number };
    expect(payload.policyHash).toBe("abc");
    expect(payload.seed).toBe(42);
  });

  test("merge drops unkeyable rows from a corrupt prior report, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(resolve(root, "reports"), { recursive: true });
    writeFileSync(
      resolve(root, "reports", "camp.json"),
      JSON.stringify({
        assets: [null, { productId: "x" }, { productId: "alpha", aspectRatio: "1:1", treatment: "default" }, beta()],
      }),
    );
    const path = await writeReport(result([asset()]), { merge: true });

    expect(readAssets(path).map((a) => a.productId).sort()).toEqual(["alpha", "beta"]);
    expect(warn).toHaveBeenCalled();
  });

  test("merge treats a prior report with a non-array assets field as empty", async () => {
    mkdirSync(resolve(root, "reports"), { recursive: true });
    writeFileSync(resolve(root, "reports", "camp.json"), JSON.stringify({ assets: "not-an-array" }));
    const path = await writeReport(result([asset()]), { merge: true });
    expect(readAssets(path)).toHaveLength(1);
  });

  test("falls back to the latest pointer when the run lacks a campaign id", async () => {
    const path = await writeReport({ halted: false, assets: [asset()], log: undefined } as unknown as PipelineResult);
    expect(path).toBe(resolve(root, "report.json"));
  });

  test("merge without a campaign id uses the latest pointer as its base", async () => {
    await writeReport(result([asset()]));
    const path = await writeReport(
      { halted: false, assets: [asset({ complianceScore: 0.7 })], log: undefined } as unknown as PipelineResult,
      { merge: true },
    );
    expect(path).toBe(resolve(root, "report.json"));
    expect(readAssets(path)[0].complianceScore).toBe(0.7);
  });
});
