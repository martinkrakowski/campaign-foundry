import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRun, seedPersistedRun, makeAsset } from "@/__tests__/helpers";
import { nextMock } from "@/__tests__/helpers";
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

describe("CompliancePage", () => {
  test("shows the awaiting state with no run", async () => {
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Awaiting pipeline execution/)).toBeTruthy();
  });

  test("renders a row per asset with pass/fail gates", async () => {
    seedPersistedRun([
      makeAsset({ passedCompliance: true, logoApplied: true }),
      makeAsset({ productId: "beta", aspectRatio: "9:16", passedCompliance: false, logoApplied: false }),
    ]);
    renderWithRun(<CompliancePage />);
    await waitFor(() => expect(screen.getAllByText(/Brand-colour density/)).toHaveLength(2));
    expect(screen.getByText("PASS")).toBeTruthy();
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
    seedPersistedRun([makeAsset(), makeAsset({ productId: "beta", outputPath: "beta/1x1.png", proofPath: "proofs/beta.pdf" })]);
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
    seedPersistedRun([makeAsset({ passedCompliance: true }), makeAsset({ productId: "beta", passedCompliance: false })]);
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
