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
  });

  test("shows the halted badge for a halted run", async () => {
    seedPersistedRun([], { halted: true });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("halted")).toBeTruthy();
  });
});
