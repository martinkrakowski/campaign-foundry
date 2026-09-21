import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRun, seedPersistedRun, makeAsset } from "@/__tests__/helpers";
import { nextMock } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import CompliancePage from "@/app/(shell)/compliance/page";
import ExportPage from "@/app/(shell)/export/page";
import RunsPage from "@/app/(shell)/runs/page";
import IndexPage from "@/app/page";

describe("IndexPage", () => {
  test("redirects to the grid", () => {
    IndexPage();
    expect(nextMock().redirect).toHaveBeenCalledWith("/grid");
  });
});

describe("CompliancePage — occlusion advisories (D136)", () => {
  test("an advisory gets its own row, labelled Layer Order, beside the density row", async () => {
    seedPersistedRun([
      makeAsset({ occlusionAdvisories: ["Shade sits above Static text and mutes it."] }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Shade sits above Static text/)).toBeTruthy();
    // Its own row and its own rule name: the density verdict and the layer
    // finding are different checks with different verdicts, on one surface.
    expect(screen.getByText(messages.complianceRuleLayerOrder)).toBeTruthy();
    expect(screen.getByText(messages.complianceRuleBrandDensity)).toBeTruthy();
  });

  test("an advisory reads ADVISORY, never FAIL (D135)", async () => {
    seedPersistedRun([
      makeAsset({
        passedCompliance: true,
        logoApplied: true,
        occlusionAdvisories: ["Shade sits above Static text and mutes it."],
      }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toBeTruthy();
    // D135: a reorder that hides or mutes a layer warns and never refuses.
    // The density row beside it is still a PASS, so the advisory cannot be
    // read as a gate the operator has to clear.
    expect(screen.getByText(messages.COMPLIANCE_GATE_LABEL.pass)).toBeTruthy();
    expect(screen.queryByText(messages.COMPLIANCE_GATE_LABEL.fail)).toBeNull();
  });

  test("two advisories on one asset are two rows", async () => {
    seedPersistedRun([makeAsset({ occlusionAdvisories: ["First finding.", "Second finding."] })]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText("First finding.")).toBeTruthy();
    expect(screen.getByText("Second finding.")).toBeTruthy();
    expect(screen.getAllByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toHaveLength(2);
  });

  test("an asset with no advisory adds no row", async () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(messages.complianceRuleBrandDensity)).toBeTruthy();
    expect(screen.queryByText(messages.complianceRuleLayerOrder)).toBeNull();
    expect(screen.queryByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toBeNull();
  });
});

describe("CompliancePage", () => {
  test("shows the awaiting state with no run", async () => {
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Awaiting pipeline execution/)).toBeTruthy();
  });

  test("the group label and table headers render through Eyebrow on the token", async () => {
    renderWithRun(<CompliancePage />);
    const label = await screen.findByText("Compliance");
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toContain("tracking-eyebrow");
    expect(label.className).not.toContain("tracking-widest");
    // the headers stay real <th> cells — Eyebrow renders through them, not inside them
    for (const header of ["Asset Target", "Rule Engine", "Telemetry Result", "Gate Status"]) {
      const th = screen.getByText(header);
      expect(th.tagName).toBe("TH");
      expect(th.className).toContain("tracking-eyebrow");
      expect(th.className).toContain("font-normal");
      expect(th.className).not.toContain("tracking-widest");
    }
  });

  test("renders a row per asset with pass/fail gates", async () => {
    seedPersistedRun([
      makeAsset({ passedCompliance: true, logoApplied: true }),
      makeAsset({
        productId: "beta",
        aspectRatio: "9:16",
        passedCompliance: false,
        logoApplied: false,
      }),
    ]);
    renderWithRun(<CompliancePage />);
    await waitFor(() => expect(screen.getAllByText(/Brand-colour density/)).toHaveLength(2));
    expect(screen.getByText(messages.COMPLIANCE_GATE_LABEL.pass)).toBeTruthy();
    expect(screen.getByText("FAIL")).toBeTruthy();
  });

  test("variation rows include v<index> in the asset target", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
  });
});

describe("ExportPage", () => {
  test("prompts to run when there is no run", async () => {
    renderWithRun(<ExportPage />);
    expect(await screen.findByText(/Run the orchestration pipeline/)).toBeTruthy();
  });

  test("prompts to approve when nothing is approved yet", async () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByText(/No creatives approved yet/)).toBeTruthy();
  });

  test("lists approved renders and their proofs", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "approved" }));
    seedPersistedRun([
      makeAsset(),
      makeAsset({ productId: "beta", outputPath: "beta/1x1.png", proofPath: "proofs/beta.pdf" }),
    ]);
    renderWithRun(<ExportPage />);
    await waitFor(() => expect(screen.getByText(/1 of 2 creatives approved/)).toBeTruthy());
    expect(screen.getByText("proofs/alpha.pdf")).toBeTruthy();
  });

  test("variation labels include v<index>", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/v4": "approved" }));
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
  });
});

describe("RunsPage", () => {
  test("shows the no-runs state initially", async () => {
    renderWithRun(<RunsPage />);
    expect(await screen.findByText(/No runs yet/)).toBeTruthy();
  });

  test("summarizes a completed run", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "approved" }));
    seedPersistedRun([
      makeAsset({ passedCompliance: true }),
      makeAsset({ productId: "beta", passedCompliance: false }),
    ]);
    renderWithRun(<RunsPage />);
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    expect(screen.getByText("seed")).toBeTruthy();
    expect(screen.getByText("alpha @ 1:1 · default")).toBeTruthy();
  });

  test("variation rows include v<index> in the run asset list", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
  });

  test("shows policyHash and seed when present on the run result", async () => {
    seedPersistedRun([makeAsset()], { policyHash: "abc123def", seed: 42 });
    renderWithRun(<RunsPage />);
    await waitFor(() => expect(screen.getByText("abc123def")).toBeTruthy());
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("Policy hash")).toBeTruthy();
    expect(screen.getByText("Seed")).toBeTruthy();
  });

  test("shows policyHash alone when seed is absent", async () => {
    seedPersistedRun([makeAsset()], { policyHash: "only-hash" });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("only-hash")).toBeTruthy();
    expect(screen.queryByText("Seed")).toBeNull();
  });

  test("shows seed alone when policyHash is absent", async () => {
    seedPersistedRun([makeAsset()], { seed: 7 });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.getByText("Seed")).toBeTruthy();
    expect(screen.queryByText("Policy hash")).toBeNull();
  });

  test("shows the halted badge for a halted run", async () => {
    seedPersistedRun([], { halted: true });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("halted")).toBeTruthy();
  });
});
