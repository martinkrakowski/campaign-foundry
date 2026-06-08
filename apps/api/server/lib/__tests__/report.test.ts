import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PipelineExecutionLog,
  type GeneratedAsset,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import { campaignReportPath, latestReportPath, writeReport } from "../report.js";

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
  log: new PipelineExecutionLog(campaignId),
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

  test("merge drops unkeyable rows from a corrupt prior report, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(resolve(root, "reports"), { recursive: true });
    writeFileSync(
      resolve(root, "reports", "camp.json"),
      JSON.stringify({ assets: [null, { productId: "x" }, beta()] }),
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
