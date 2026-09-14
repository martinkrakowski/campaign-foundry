import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PipelineExecutionLog,
  type GeneratedAsset,
  type PipelineResult,
} from "@campaignfoundry/CampaignOrchestration";
import {
  campaignReportPath,
  isPersistedAsset,
  latestReportPath,
  readReport,
  reportRevision,
  writeReport,
} from "../report.js";
import { hashBytes } from "../brief-files.js";

// node:fs/promises is an ESM namespace (not spy-able), so the report's write path is
// routed through an overridable hook. A test can land half a payload and pause — the
// torn file a crash leaves behind — and let a reader run while it is on disk. Left
// unset, every call passes straight through to the real implementation.
const fsHook = vi.hoisted(() => ({
  writeFile: undefined as undefined | ((path: string, data: unknown) => Promise<void>),
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (path: string, data: unknown) =>
      fsHook.writeFile
        ? fsHook.writeFile(path, data)
        : (actual.writeFile as unknown as (p: string, d: unknown) => Promise<void>)(path, data),
    rename: (from: string, to: string) =>
      fsHook.rename ? fsHook.rename(from, to) : actual.rename(from, to),
  };
});

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
const gamma = (over: Partial<GeneratedAsset> = {}) => asset({ productId: "gamma", outputPath: "gamma/1x1.png", ...over });
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
    fsHook.writeFile = undefined;
    fsHook.rename = undefined;
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

  test("reportRevision is the digest of the stored bytes, and moves when they do", async () => {
    expect(await reportRevision(root, "camp")).toBeUndefined();

    await writeReport(result([asset()]));
    const first = await reportRevision(root, "camp");
    // Not a field on the document: the digest of the file, absent from the payload.
    expect(typeof first).toBe("string");
    expect(readFileSync(campaignReportPath(root, "camp")!, "utf8")).not.toContain(first!);

    await writeReport(result([asset({ complianceScore: 0.7 })]));
    expect(await reportRevision(root, "camp")).not.toBe(first);
  });

  test("reportRevision digests the stored bytes, not a re-encoding of them", async () => {
    mkdirSync(resolve(root, "reports"), { recursive: true });
    // A byte no UTF-8 decoder can round-trip: read as text it is U+FFFD, and encoding
    // that text again yields different bytes — so a revision taken from the decoded
    // text cannot equal the digest of what is stored (the pool-store defect L10 fixed).
    const stored = Buffer.concat([
      Buffer.from('{"assets":[],"note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    writeFileSync(campaignReportPath(root, "camp")!, stored);

    const revision = await reportRevision(root, "camp");
    expect(revision).toBe(hashBytes(stored));
    expect(revision).not.toBe(hashBytes(Buffer.from(stored.toString("utf8"), "utf8")));
  });

  test("reportRevision is undefined for an unsafe id and throws when the file cannot be read", async () => {
    expect(await reportRevision(root, "../evil")).toBeUndefined();

    // A directory where the report should be: not ENOENT, so it is not "nothing stored".
    mkdirSync(campaignReportPath(root, "camp")!, { recursive: true });
    await expect(reportRevision(root, "camp")).rejects.toThrow();
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

  test("a merge whose report moved under it is refused, and writes nothing", async () => {
    await writeReport(result([asset(), beta()]));
    const stale = await reportRevision(root, "camp");

    // Another run's re-roll lands while this one is still going.
    await writeReport(result([asset({ complianceScore: 0.7 })]), { merge: true });
    const current = await reportRevision(root, "camp");

    // Before this lane: both merges answered 200 and one of the two was gone.
    await expect(
      writeReport(result([gamma()]), { merge: true, expectedRevision: stale }),
    ).rejects.toMatchObject({
      code: "ECONFLICT",
      revision: current,
      message: 'Report for campaign "camp" was modified by another run.',
    });

    // The refused run wrote nothing — the report still holds the run that landed.
    const per = readAssets(resolve(root, "reports", "camp.json"));
    expect(per.find((a) => a.productId === "alpha")?.complianceScore).toBe(0.7);
    expect(per.map((a) => a.productId)).not.toContain("gamma");
  });

  test("a merge carrying the revision it read is accepted, and keeps the base it merged", async () => {
    await writeReport(result([asset(), beta()]));
    const revision = await reportRevision(root, "camp");

    const path = await writeReport(result([asset({ complianceScore: 0.9 })]), {
      merge: true,
      expectedRevision: revision,
    });
    const per = readAssets(path);
    expect(per.find((a) => a.productId === "alpha")?.complianceScore).toBe(0.9);
    // The merge base survived: an accepted write that replaced the report instead of
    // overlaying it would land the same alpha and no beta, and this is the accepted
    // path — the one no refusal test says anything about.
    expect(per.map((a) => a.productId).sort()).toEqual(["alpha", "beta"]);
  });

  test("a merge that started with no report is accepted while none is stored", async () => {
    // `null` is the absent case: the run began against no report, and nothing has
    // appeared since, so the write goes through.
    const path = await writeReport(result([asset()]), { merge: true, expectedRevision: null });
    expect(readAssets(path).map((a) => a.productId)).toEqual(["alpha"]);
  });

  test("a merge that started with no report is refused when one appeared meanwhile", async () => {
    // The run reads "nothing stored" and is still going when another run lands a
    // report. Absence is an expectation, so this run is refused rather than
    // overwriting a report it never saw.
    await expect(
      writeReport(result([asset()]), { merge: true, expectedRevision: null }),
    ).resolves.toBe(campaignReportPath(root, "camp"));
    const appeared = await reportRevision(root, "camp");

    await expect(
      writeReport(result([beta()]), { merge: true, expectedRevision: null }),
    ).rejects.toMatchObject({
      code: "ECONFLICT",
      revision: appeared,
      message: 'Report for campaign "camp" was modified by another run.',
    });

    // Refused means it wrote nothing: the report still holds the run that landed.
    expect(readAssets(resolve(root, "reports", "camp.json")).map((a) => a.productId)).toEqual([
      "alpha",
    ]);
  });

  test("without expectedRevision the write is unconditional, as both stores are", async () => {
    await writeReport(result([asset(), beta()]));
    // The report moves on disk; a write that named no revision is still not refused.
    writeFileSync(campaignReportPath(root, "camp")!, JSON.stringify({ assets: [beta()] }));

    const path = await writeReport(result([gamma()]), { merge: true });
    expect(readAssets(path).map((a) => a.productId).sort()).toEqual(["beta", "gamma"]);
  });

  test("a refused merge with no campaign id names no campaign", async () => {
    await writeReport(result([asset()]));
    const stale = await reportRevision(root, "camp");
    await writeReport(result([asset({ complianceScore: 0.7 })]));

    await expect(
      writeReport(
        { halted: false, assets: [asset()], log: undefined } as unknown as PipelineResult,
        { merge: true, expectedRevision: stale },
      ),
    ).rejects.toMatchObject({ code: "ECONFLICT", message: "Report was modified by another run." });
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

  test("isPersistedAsset takes a display size instead of a ratio — exactly one canvas (D113)", () => {
    expect(
      isPersistedAsset({ productId: "alpha", size: "728x90", treatment: "default", outputPath: "alpha/728x90.png" }),
    ).toBe(true);
    // Neither canvas: cannot be keyed or packaged.
    expect(isPersistedAsset({ productId: "alpha", treatment: "default", outputPath: "alpha/x.png" })).toBe(false);
    // Both canvases: a corrupt row, skipped like any other unusable one.
    expect(
      isPersistedAsset({
        productId: "alpha",
        aspectRatio: "1:1",
        size: "728x90",
        treatment: "default",
        outputPath: "alpha/1x1.png",
      }),
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

  test("isPersistedAsset validates the motion metadata and skips unknown formats", () => {
    const motion = {
      productId: "alpha",
      aspectRatio: "9:16",
      treatment: "headline-top-bold",
      outputPath: "alpha/9x16/v1.png",
      variantIndex: 1,
      attempt: 0,
      format: "motion",
      videoPath: "alpha/9x16/v1.mp4",
      durationSec: 6,
    };
    expect(isPersistedAsset(motion)).toBe(true);
    expect(isPersistedAsset({ ...motion, durationSec: undefined })).toBe(false);
    expect(isPersistedAsset({ ...motion, durationSec: "6" })).toBe(false);
    expect(isPersistedAsset({ ...motion, durationSec: Number.NaN })).toBe(false);
    expect(isPersistedAsset({ ...motion, durationSec: Number.POSITIVE_INFINITY })).toBe(false);
    // Unknown formats are dropped (counted as skipped by the callers), never packaged as stills.
    expect(isPersistedAsset({ ...motion, format: "gif" })).toBe(false);
    expect(isPersistedAsset({ ...motion, format: null })).toBe(false);
    // Classic rows carry no format; static rows need no motion metadata.
    expect(isPersistedAsset({ ...motion, format: undefined, videoPath: undefined, durationSec: undefined })).toBe(true);
    expect(isPersistedAsset({ ...motion, format: "static", videoPath: undefined, durationSec: undefined })).toBe(true);
  });

  test("isPersistedAsset validates html rows and requires htmlBundlePath and htmlFallbackPath (HL4)", () => {
    const htmlRow = {
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "default",
      outputPath: "alpha/1x1.png",
      format: "html",
      htmlBundlePath: "alpha/1x1/index.html",
      htmlFallbackPath: "alpha/1x1/fallback.png",
      clickDestination: "https://example.com/landing",
    };
    expect(isPersistedAsset(htmlRow)).toBe(true);
    expect(isPersistedAsset({ ...htmlRow, htmlBundlePath: undefined })).toBe(false);
    expect(isPersistedAsset({ ...htmlRow, htmlBundlePath: 123 })).toBe(false);
    expect(isPersistedAsset({ ...htmlRow, htmlFallbackPath: undefined })).toBe(false);
    expect(isPersistedAsset({ ...htmlRow, htmlFallbackPath: null })).toBe(false);
  });

  test("isPersistedAsset refuses a present, non-string clickDestination (X12)", () => {
    const row = {
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "default",
      outputPath: "alpha/1x1.png",
    };
    // Absent stays valid: not every creative is clickable.
    expect(isPersistedAsset(row)).toBe(true);
    // A string destination rides through, as HL4 wrote it.
    expect(isPersistedAsset({ ...row, clickDestination: "https://example.com/landing" })).toBe(true);
    // Present but not a string is a malformed row — the guard refuses what the type promises.
    expect(isPersistedAsset({ ...row, clickDestination: 42 })).toBe(false);
    expect(isPersistedAsset({ ...row, clickDestination: null })).toBe(false);
    expect(isPersistedAsset({ ...row, clickDestination: { url: "https://example.com" } })).toBe(false);
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

  test("isPersistedAsset accepts rows without descriptor (backward compatibility)", () => {
    const legacyClassic = {
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "default",
      outputPath: "alpha/1x1.png",
    };
    const legacyVariation = {
      productId: "alpha",
      aspectRatio: "1:1",
      treatment: "headline-top-bold",
      outputPath: "alpha/1x1/v0.png",
      variantIndex: 0,
      attempt: 0,
      format: "static",
    };
    expect(isPersistedAsset(legacyClassic)).toBe(true);
    expect(isPersistedAsset(legacyVariation)).toBe(true);
  });

  test("a row is usable whatever shape its descriptor is in", () => {
    // The guard decides whether a row is a usable ASSET. A descriptor is provenance the UI
    // reads field by field; a malformed one is a cosmetic defect, not a reason to drop a
    // creative. This asserts the guard stays out of it.
    const base = {
      productId: "alpha",
      aspectRatio: "9:16",
      treatment: "headline-top-bold",
      outputPath: "alpha/9x16/v0.png",
      variantIndex: 0,
      attempt: 0,
    };
    const wellFormed = {
      layout: "headline-top",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0.1,
      headline: "Stay wild",
      motion: "ken-burns-in",
      durationSec: 6,
      beats: 3,
    };
    expect(isPersistedAsset({ ...base, descriptor: wellFormed })).toBe(true);
    expect(isPersistedAsset({ ...base, descriptor: { layout: 42 } })).toBe(true);
    expect(isPersistedAsset({ ...base, descriptor: null })).toBe(true);
    // And a row written before descriptors existed still loads.
    expect(isPersistedAsset(base)).toBe(true);
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

  test("a reader racing a write never parses a partial report", async () => {
    // Seed a whole report, so the racing reader has a previous version to find.
    await writeReport(result([asset()]));
    const target = campaignReportPath(root, "camp")!;
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let landed!: () => void;
    const halfWritten = new Promise<void>((r) => (landed = r));
    fsHook.writeFile = async (path, data) => {
      const bytes = Buffer.from(String(data));
      // Half the payload on disk, then hold the write open — the exact moment a crash
      // or a concurrent reader sees a truncated report if this path is the target.
      await real.writeFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
      landed();
      await gate;
      await real.writeFile(path, bytes);
    };

    const writing = writeReport(result([asset({ complianceScore: 0.9 }), beta()]));
    await halfWritten;
    // The writer is mid-write and a reader runs. It must see the whole prior report,
    // never the half-payload the writer has staged.
    await expect(readReport(root, "camp")).resolves.toMatchObject({ assets: expect.any(Array) });
    release();
    await writing;
    expect(readAssets(target).map((a) => a.productId).sort()).toEqual(["alpha", "beta"]);
  });

  test("a write that fails before the rename leaves the previous report intact", async () => {
    await writeReport(result([asset()]));
    const target = campaignReportPath(root, "camp")!;
    const before = readFileSync(target);
    fsHook.rename = async () => {
      throw new Error("simulated crash before the rename");
    };

    await expect(writeReport(result([beta()]))).rejects.toThrow("simulated crash before the rename");
    // The old bytes survive and nothing half-written is left behind.
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(resolve(root, "reports")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("a write that fails before its temp exists surfaces that failure, not the cleanup's", async () => {
    await writeReport(result([asset()]));
    const target = campaignReportPath(root, "camp")!;
    const before = readFileSync(target);
    // The staging write itself fails, so there is no temp for the cleanup to unlink:
    // the unlink's own ENOENT must be swallowed, or it would replace the real error.
    fsHook.writeFile = async () => {
      throw new Error("simulated disk full");
    };

    await expect(writeReport(result([beta()]))).rejects.toThrow("simulated disk full");
    expect(readFileSync(target)).toEqual(before);
  });

  test("the atomic write renames a temp sibling over the target", async () => {
    const target = campaignReportPath(root, "camp")!;
    const renames: Array<{ from: string; to: string }> = [];
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    fsHook.rename = async (from, to) => {
      renames.push({ from, to });
      await real.rename(from, to);
    };

    await writeReport(result([asset()]));

    // Both destinations — the per-campaign report and the latest pointer — are
    // staged: either one written in place is a torn file a reader can parse.
    for (const destination of [target, resolve(root, "report.json")]) {
      const operation = renames.find((r) => r.to === destination);
      expect(operation).toBeDefined();
      // The staged name is a unique sibling — never the target itself.
      expect(operation!.from).not.toBe(destination);
      expect(operation!.from.startsWith(`${destination}.`)).toBe(true);
      expect(operation!.from.endsWith(".tmp")).toBe(true);
    }
    // And no temp name survives the write.
    expect(readdirSync(resolve(root, "reports"))).toEqual(["camp.json"]);
  });
});
