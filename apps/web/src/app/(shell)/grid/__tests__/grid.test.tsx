import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { renderWithRun, seedPersistedRun, makeAsset, exerciseFocusTrap, mockPipelineApi } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import GridPage from "../page";

/** A tiny harness exposing execute/regenerate so loading states can be driven. */
function Harness() {
  const { execute, regenerateRejected } = useRun();
  return createElement(Fragment, null,
    createElement("button", { onClick: () => execute(), key: "e" }, "exec"),
    createElement("button", { onClick: () => regenerateRejected(), key: "r" }, "regen"),
    createElement(GridPage, { key: "g" }),
  );
}

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("GridPage", () => {
  test("shows the empty 'start orchestrating' state", async () => {
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Start orchestrating assets/)).toBeTruthy();
    expect(screen.getByText(/Execute the pipeline below/)).toBeTruthy();
  });

  test("shows the running message while a run is in flight with no assets yet", async () => {
    const user = userEvent.setup();
    mockPipelineApi({ post: () => new Promise<Response>(() => {}) }); // never resolves → stays loading
    renderWithRun(<Harness />);
    await user.click(screen.getByText("exec"));
    expect(await screen.findByText(/Running the pipeline/)).toBeTruthy();
  });

  test("renders the review matrix with provenance and compliance badges", async () => {
    seedPersistedRun([
      // alpha has two ratios (exercises the ratio sort), incl. an unranked one (ratioRank -1).
      makeAsset({ backgroundSource: "imagen", passedCompliance: true, logoApplied: true }),
      makeAsset({ aspectRatio: "21:9", backgroundSource: "imagen" }),
      makeAsset({ productId: "beta", aspectRatio: "9:16", backgroundSource: "procedural", passedCompliance: false, logoApplied: false }),
      makeAsset({ productId: "gamma", aspectRatio: "16:9", backgroundSource: "reused" }),
      makeAsset({ productId: "delta", aspectRatio: "1:1", backgroundSource: "openrouter" }),
      makeAsset({ productId: "epsilon", aspectRatio: "1:1", backgroundSource: "firefly" }),
    ]);
    renderWithRun(<GridPage />);
    await waitFor(() => expect(screen.getAllByText("IMAGEN").length).toBeGreaterThan(0));
    expect(screen.getByText("FIREFLY")).toBeTruthy();
    expect(screen.getByText("FALLBACK")).toBeTruthy();
    expect(screen.getByText("REUSED")).toBeTruthy();
    expect(screen.getByText("OPENROUTER")).toBeTruthy();
    expect(screen.getByText("NO LOGO")).toBeTruthy();
    expect(screen.getByText(/✓ 0 approved/)).toBeTruthy();
  });

  test("shows a descriptor chip on variation cells", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 0,
        treatment: "headline-top-subtle",
        descriptor: { layout: "headline-top", tone: "subtle", backgroundSource: "procedural", paletteShift: 0.1 },
      }),
    ]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("headline-top · subtle · procedural")).toBeTruthy();
  });

  test("omits the descriptor chip when a variant has no descriptor", async () => {
    seedPersistedRun([makeAsset({ variantIndex: 1, treatment: "headline-bottom-bold" })]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("headline-bottom-bold")).toBeTruthy();
    expect(screen.queryByText(/headline-bottom ·/)).toBeNull();
  });

  test("approve and reject toggle a creative's decision", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeAsset()]);
    renderWithRun(<GridPage />);
    await screen.findByText("IMAGEN").catch(() => undefined);
    const approve = await screen.findByText("Approve");
    await user.click(approve);
    await waitFor(() => expect(screen.getByText(/✓ 1 approved/)).toBeTruthy());
    await user.click(screen.getByText("Reject"));
    await waitFor(() => expect(screen.getByText(/✗ 1 rejected/)).toBeTruthy());
  });

  test("opens and closes the full-size preview", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeAsset()]);
    renderWithRun(<GridPage />);
    await user.click((await screen.findAllByText("Preview"))[0]);
    const modal = await screen.findByRole("dialog");
    const meta = within(modal).getByText(/alpha · 1:1 · default/);
    expect(meta).toBeTruthy();
    // Clicking the image and the metadata must not bubble to the backdrop (stopPropagation).
    await user.click(within(modal).getByRole("img"));
    await user.click(meta);
    expect(screen.queryByRole("dialog")).toBeTruthy(); // still open
    exerciseFocusTrap(modal); // covers the wrap branches (focus is on the close button)
    // Tab while focus is OFF the only focusable → the non-wrap (false) branch sides.
    (within(modal).getByLabelText("Close preview") as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("spins the targeted tiles during a selective regenerate", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected" }));
    mockPipelineApi({
      post: () => new Promise<Response>(() => {}), // pending
      report: { halted: false, assets: [makeAsset()], log: { entries: [], campaignId: "seed" } },
    });
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:brief", JSON.stringify({ id: "seed", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }] }));
    renderWithRun(<Harness />);
    await screen.findByText("Approve"); // run restored
    await user.click(screen.getByText("regen"));
    expect(await screen.findByText("Regenerating…")).toBeTruthy();
  });
});
