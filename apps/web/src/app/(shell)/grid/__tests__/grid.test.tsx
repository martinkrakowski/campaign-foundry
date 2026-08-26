import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { renderWithRun, seedPersistedRun, makeAsset, exerciseFocusTrap, mockPipelineApi, jobOk, json } from "@/__tests__/helpers";
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
    expect(await screen.findByText("alpha @ 1:1 · v0 · headline-top-subtle")).toBeTruthy();
    expect(screen.getAllByText("headline-top").length).toBeGreaterThan(0);
    expect(screen.getAllByText("subtle").length).toBeGreaterThan(0);
    expect(screen.getAllByText("procedural").length).toBeGreaterThan(0);
    expect(screen.getByText("shift 0.1")).toBeTruthy();
  });

  test("omits the descriptor chip when a variant has no descriptor", async () => {
    seedPersistedRun([makeAsset({ variantIndex: 1, treatment: "headline-bottom-bold" })]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("alpha @ 1:1 · v1 · headline-bottom-bold")).toBeTruthy();
    expect(screen.queryByText(/headline-bottom ·/)).toBeNull();
  });

  test("a variation re-roll updates the tile in place and clears its decision", async () => {
    const user = userEvent.setup();
    const original = makeAsset({
      variantIndex: 0,
      attempt: 0,
      treatment: "headline-top-subtle",
      outputPath: "alpha/1x1/v0.png",
    });
    const rerolled = { ...original, attempt: 1, treatment: "headline-bottom-bold" };
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({
        id: "seed",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "Hi",
        products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
      }),
    );
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/v0": "rejected" }));
    mockPipelineApi({
      report: { halted: false, assets: [original], log: { entries: [], campaignId: "seed" } },
      job: () =>
        jobOk({
          halted: false,
          assets: [rerolled],
          log: { entries: [], campaignId: "seed" },
        }),
    });
    renderWithRun(<Harness />);
    expect(await screen.findByText("alpha @ 1:1 · v0 · headline-top-subtle")).toBeTruthy();
    await user.click(screen.getByText("regen"));
    expect(await screen.findByText("alpha @ 1:1 · v0 · headline-bottom-bold")).toBeTruthy();
    expect(screen.queryByText("alpha @ 1:1 · v0 · headline-top-subtle")).toBeNull();
    await waitFor(() => expect(screen.getByText(/✗ 0 rejected/)).toBeTruthy());
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
    const meta = within(modal).getByText(/alpha @ 1:1 · default/);
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

  test("renders 100 mixed assets, filters, pages, and descriptor chips", async () => {
    const user = userEvent.setup();
    const hundred = Array.from({ length: 100 }, (_, i) =>
      makeAsset({
        productId: i < 50 ? "alpha" : "beta",
        aspectRatio: (["1:1", "9:16", "16:9"] as const)[i % 3],
        outputPath: `asset-${i}.png`,
        treatment: `t${i}`,
        format: i % 7 === 0 ? "motion" : "static",
        ...(i % 3 === 0
          ? {}
          : {
              variantIndex: i,
              descriptor: {
                layout: i % 2 === 0 ? "headline-top" : "headline-bottom",
                tone: i % 4 < 2 ? "bold" : "subtle",
                backgroundSource: i % 5 === 0 ? "genai" : "procedural",
                paletteShift: i % 6 === 0 ? 0.2 : 0,
              },
            }),
      }),
    );
    seedPersistedRun(hundred);
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Showing 24 of 100/)).toBeTruthy();
    expect(screen.getAllByText("Approve")).toHaveLength(24);
    expect(document.querySelector("figure")?.className).toMatch(/content-visibility/);
    expect(screen.getAllByText("headline-top").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Layout")).toBeTruthy();

    await user.click(screen.getByText("Show more"));
    expect(await screen.findByText(/Showing 48 of 100/)).toBeTruthy();
    expect(screen.getAllByText("Approve")).toHaveLength(48);

    await user.selectOptions(screen.getByLabelText("Product"), "alpha");
    expect(await screen.findByText(/Showing 24 of 50/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Ratio"), "1:1");
    await user.selectOptions(screen.getByLabelText("Format"), "motion");
    await user.selectOptions(screen.getByLabelText("Layout"), "headline-bottom");
    expect(await screen.findByText(/No creatives match the current filters/)).toBeTruthy();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  test("a brief switch resets the filters and the page to defaults", async () => {
    function Switch() {
      const { setBrief, brief } = useRun();
      return createElement(Fragment, null,
        createElement("button", {
          onClick: () =>
            setBrief({
              ...brief,
              id: "other",
              products: [{ id: "gamma", name: "Gamma", primaryColor: "#111111", logoPath: "g.png" }],
            }),
        }, "switch"),
        createElement(GridPage, null),
      );
    }
    const user = userEvent.setup();
    const seedAssets = Array.from({ length: 30 }, (_, i) =>
      makeAsset({ productId: i % 2 ? "alpha" : "beta", outputPath: `a-${i}.png`, treatment: `t${i}` }),
    );
    const otherAssets = [
      makeAsset({ productId: "gamma", outputPath: "gamma/1x1.png" }),
      makeAsset({ productId: "delta", outputPath: "delta/1x1.png" }),
    ];
    seedPersistedRun(seedAssets);
    mockPipelineApi({
      result: (url) =>
        url.includes("campaignId=other")
          ? json({ halted: false, assets: otherAssets, log: { entries: [], campaignId: "other" } })
          : json({ halted: false, assets: seedAssets, log: { entries: [], campaignId: "seed" } }),
    });
    renderWithRun(<Switch />);
    expect(await screen.findByText(/Showing 24 of 30/)).toBeTruthy();
    await user.click(screen.getByText("Show more"));
    expect(await screen.findByText(/Showing 30 of 30/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Product"), "alpha");
    expect(await screen.findByText(/Showing 15 of 15/)).toBeTruthy();
    expect((screen.getByLabelText("Product") as HTMLSelectElement).value).toBe("alpha");

    await user.click(screen.getByText("switch"));
    expect(await screen.findByText(/Showing 2 of 2/)).toBeTruthy();
    expect((screen.getByLabelText("Product") as HTMLSelectElement).value).toBe("");
    // The first change after the reset starts from the defaults, not the stale state.
    await user.selectOptions(screen.getByLabelText("Product"), "gamma");
    expect(await screen.findByText(/Showing 1 of 1/)).toBeTruthy();
  });

  test("omits axis filters when no asset has a descriptor", async () => {
    seedPersistedRun([makeAsset(), makeAsset({ productId: "beta", outputPath: "beta/1x1.png" })]);
    renderWithRun(<GridPage />);
    expect(await screen.findByLabelText("Product")).toBeTruthy();
    expect(screen.getByLabelText("Ratio")).toBeTruthy();
    expect(screen.getByLabelText("Format")).toBeTruthy();
    expect(screen.queryByLabelText("Layout")).toBeNull();
    expect(screen.queryByLabelText("Tone")).toBeNull();
    expect(screen.queryByLabelText("Background source")).toBeNull();
  });

  test("tone and background filters reduce the visible set", async () => {
    const user = userEvent.setup();
    seedPersistedRun([
      makeAsset({
        variantIndex: 0,
        descriptor: { layout: "headline-top", tone: "bold", backgroundSource: "genai", paletteShift: 0 },
      }),
      makeAsset({
        productId: "beta",
        variantIndex: 1,
        outputPath: "beta/1x1.png",
        descriptor: { layout: "headline-bottom", tone: "subtle", backgroundSource: "procedural", paletteShift: 0.2 },
      }),
    ]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Showing 2 of 2/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Tone"), "subtle");
    expect(await screen.findByText(/Showing 1 of 1/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Tone"), "All");
    await user.selectOptions(screen.getByLabelText("Background source"), "genai");
    expect(await screen.findByText(/Showing 1 of 1/)).toBeTruthy();
  });
});
