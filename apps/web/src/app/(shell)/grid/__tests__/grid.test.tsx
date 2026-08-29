import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import {
  renderWithRun,
  seedPersistedRun,
  makeAsset,
  makeMotionAsset,
  exerciseFocusTrap,
  mockPipelineApi,
  jobOk,
  json,
} from "@/__tests__/helpers";
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

  test("shows beat and pooled headline descriptor chips when present", async () => {
    seedPersistedRun([
      makeMotionAsset({
        variantIndex: 0,
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: 0,
          motion: "ken-burns-in",
          durationSec: 6,
          beats: 3,
          headline: "Stay wild",
        },
      }),
      makeAsset({
        variantIndex: 1,
        descriptor: {
          layout: "headline-bottom",
          tone: "subtle",
          backgroundSource: "procedural",
          paletteShift: 0,
          beats: 1,
        },
      }),
    ]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("3 beats")).toBeTruthy();
    expect(screen.getByText("1 beat")).toBeTruthy();
    expect(screen.getByText('"Stay wild"')).toBeTruthy();
  });

  test("a long pooled headline is bounded and keeps its full text on hover", async () => {
    // Every other chip in this row is a short enum. A pooled headline is arbitrary author
    // text, and the row does not wrap inside a 240px tile — unbounded, it pushes the chips
    // after it out of view.
    const long =
      "Stay wild, stay hydrated, and never stop exploring the trail ahead of you today and tomorrow";
    seedPersistedRun([
      makeAsset({
        variantIndex: 0,
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: 0,
          headline: long,
        },
      }),
    ]);
    renderWithRun(<GridPage />);
    const chip = await screen.findByText(`"${long}"`);
    expect(chip.className).toContain("truncate");
    expect(chip.className).toMatch(/max-w-/);
    // Clipped on screen, but the whole line is still reachable.
    expect(chip.getAttribute("title")).toBe(long);
  });

  test("a partial descriptor from a persisted report loses only the bad field, never a chip's worth of nothing", async () => {
    // This goes through the real boundary: seedPersistedRun mocks fetch, so the report is
    // narrowed by fetchPersistedRun exactly as it would be in the app. Without that wiring
    // `layout` renders as `undefined` — a visible empty pill.
    seedPersistedRun([
      makeAsset({
        variantIndex: 0,
        descriptor: {
          layout: 42,
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: "nope",
          beats: 3,
        } as unknown as never,
      }),
    ]);
    renderWithRun(<GridPage />);
    // The usable fields survive…
    expect((await screen.findAllByText("bold")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("procedural").length).toBeGreaterThan(0);
    expect(screen.getByText("3 beats")).toBeTruthy();
    // …and the unusable ones leave nothing behind, rather than an empty chip.
    expect(screen.queryByText("42")).toBeNull();
    expect(screen.queryByText("shift nope")).toBeNull();
    expect(screen.queryByText("shift undefined")).toBeNull();
    // The creative itself is untouched by any of this.
    expect(screen.getByText(/alpha @ 1:1/)).toBeTruthy();
  });

  test("omits beat and headline chips when fields are absent", async () => {
    seedPersistedRun([
      makeMotionAsset({
        variantIndex: 0,
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: 0,
          motion: "ken-burns-in",
          durationSec: 6,
        },
      }),
    ]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("ken-burns-in · 6s")).toBeTruthy();
    expect(screen.queryByText(/beat/)).toBeNull();
    expect(screen.queryByText(/".*"/)).toBeNull();
  });

  test("a reloaded campaign shows the same descriptor chips as a freshly-run one", async () => {
    const user = userEvent.setup();
    const assets = [
      makeMotionAsset({
        variantIndex: 0,
        treatment: "headline-top-bold",
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: 0.2,
          motion: "ken-burns-in",
          durationSec: 6,
          beats: 3,
          headline: "Stay wild",
        },
      }),
      makeAsset({
        variantIndex: 1,
        treatment: "headline-bottom-subtle",
        descriptor: {
          layout: "headline-bottom",
          tone: "subtle",
          backgroundSource: "procedural",
          paletteShift: 0,
        },
      }),
    ];

    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({
        id: "camp",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "Stay wild",
        products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
        mode: "variation",
        variation: { count: 2 },
      }),
    );

    const report = {
      halted: false,
      assets,
      log: { entries: [], campaignId: "camp" },
    };

    mockPipelineApi({
      post: () => json({ jobId: "job-reload-test" }, 202),
      job: () => jobOk(report),
      result: () => json(report),
    });

    // 1. Freshly run the campaign
    const { unmount } = renderWithRun(<Harness />);
    await user.click(screen.getByText("exec"));

    // Verify chips on fresh run
    expect(await screen.findByText("3 beats")).toBeTruthy();
    expect(screen.getByText('"Stay wild"')).toBeTruthy();
    expect(screen.getByText("ken-burns-in · 6s")).toBeTruthy();
    expect(screen.getByText("shift 0.2")).toBeTruthy();
    expect(screen.getAllByText("headline-top").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bold").length).toBeGreaterThan(0);
    expect(screen.getAllByText("headline-bottom").length).toBeGreaterThan(0);
    expect(screen.getAllByText("subtle").length).toBeGreaterThan(0);

    // 2. Reload: unmount and mount fresh GridPage (fetches from persisted GET /campaigns/result)
    unmount();
    renderWithRun(<GridPage />);

    // Verify chips on reloaded run match freshly-run chips
    expect(await screen.findByText("3 beats")).toBeTruthy();
    expect(screen.getByText('"Stay wild"')).toBeTruthy();
    expect(screen.getByText("ken-burns-in · 6s")).toBeTruthy();
    expect(screen.getByText("shift 0.2")).toBeTruthy();
    expect(screen.getAllByText("headline-top").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bold").length).toBeGreaterThan(0);
    expect(screen.getAllByText("headline-bottom").length).toBeGreaterThan(0);
    expect(screen.getAllByText("subtle").length).toBeGreaterThan(0);
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
        // a variation run (variantIndex assets) can only exist under a randomized brief
        mode: "variation",
        variation: { count: 1 },
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

describe("GridPage — motion cells", () => {
  afterEach(() => vi.restoreAllMocks());

  const LABEL = "alpha @ 9:16 · v1 · headline-top-bold";

  test("renders a muted metadata-preloaded <video> with the poster, the motion chip, and mp4 + poster downloads", async () => {
    seedPersistedRun([makeMotionAsset(), makeAsset()]);
    renderWithRun(<GridPage />);
    const video = (await screen.findByLabelText(LABEL)) as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.muted).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("poster")).toContain("/output/alpha/9x16/v1.png?v=");
    expect(video.getAttribute("src")).toContain("/output/alpha/9x16/v1.mp4?v=");
    expect(screen.getByText("ken-burns-in · 6s")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download .MP4" }).getAttribute("href")).toContain("alpha/9x16/v1.mp4");
    expect(screen.getByRole("link", { name: "Download poster .PNG" })).toBeTruthy();
    // The static tile keeps its plain image + download label.
    expect(screen.getByRole("img", { name: "alpha @ 1:1 · default" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download .PNG" })).toBeTruthy();
  });

  test("hover plays and leaving rewinds; the play control toggles for keyboard users", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const user = userEvent.setup();
    seedPersistedRun([makeMotionAsset()]);
    renderWithRun(<GridPage />);
    const video = (await screen.findByLabelText(LABEL)) as HTMLVideoElement;
    const tile = video.parentElement as HTMLElement;

    fireEvent.mouseEnter(tile);
    expect(play).toHaveBeenCalledTimes(1);
    // The control flips to "playing" only once play() has resolved.
    expect(await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true })).toBeTruthy();
    video.currentTime = 3;
    fireEvent.mouseLeave(tile);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false })).toBeTruthy();

    // Keyboard: focus + Enter never passes through the hover handlers.
    screen.getByRole("button", { name: `Play ${LABEL}` }).focus();
    await user.keyboard("{Enter}");
    expect(play).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true })).textContent).toBe("❚❚ 6s");
    await user.keyboard("{Enter}");
    expect(pause).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false }).textContent).toBe("▶ 6s");
  });

  test("a play() that returns nothing counts as playing; a rejected play() keeps the play control and shows a hint", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    play.mockImplementationOnce(() => undefined as unknown as Promise<void>);
    play.mockImplementationOnce(() => Promise.reject(new Error("NotAllowedError")));
    play.mockImplementationOnce(() => Promise.resolve());
    const user = userEvent.setup();
    seedPersistedRun([makeMotionAsset({ durationSec: undefined, descriptor: { layout: "headline-top", tone: "bold", backgroundSource: "procedural", paletteShift: 0, motion: "headline-rise" } })]);
    renderWithRun(<GridPage />);
    const button = await screen.findByRole("button", { name: `Play ${LABEL}` });
    expect(button.textContent).toContain("clip");
    expect(screen.getByText("headline-rise · ?s")).toBeTruthy();
    button.focus();
    await user.keyboard("{Enter}"); // play() → undefined (old engine): treated as started
    expect(await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await user.keyboard("{Enter}"); // pause
    await user.keyboard("{Enter}"); // play() → rejected: not playing, hint shown
    expect(play).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "can't play");
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false })).toBeTruthy();
    await user.keyboard("{Enter}"); // play() → resolves: the hint clears
    expect(await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the chip falls back to the asset duration when the descriptor lacks one", async () => {
    seedPersistedRun([makeMotionAsset({ durationSec: 4, descriptor: { layout: "headline-top", tone: "bold", backgroundSource: "procedural", paletteShift: 0, motion: "accent-wipe" } })]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("accent-wipe · 4s")).toBeTruthy();
  });

  test("the preview modal plays the clip with controls", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeMotionAsset()]);
    renderWithRun(<GridPage />);
    await screen.findByLabelText(LABEL);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog");
    const preview = within(dialog).getByLabelText(LABEL) as HTMLVideoElement;
    expect(preview.tagName).toBe("VIDEO");
    expect(preview.hasAttribute("controls")).toBe(true);
    expect(preview.muted).toBe(true);
    fireEvent.click(preview); // stopPropagation — the dialog stays open
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("the format filter separates motion from static cells", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeMotionAsset(), makeAsset()]);
    renderWithRun(<GridPage />);
    await screen.findByLabelText(LABEL);
    await user.selectOptions(screen.getByLabelText("Format"), "motion");
    expect(screen.getByLabelText(LABEL)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "alpha @ 1:1 · default" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Format"), "static");
    expect(screen.queryByLabelText(LABEL)).toBeNull();
    expect(screen.getByRole("img", { name: "alpha @ 1:1 · default" })).toBeTruthy();
  });

  test("re-rolling a rejected motion variant sends its identity with attempt + 1 and swaps the tile in place", async () => {
    const user = userEvent.setup();
    const original = makeMotionAsset();
    const rerolled = makeMotionAsset({ attempt: 1, complianceScore: 0.9, descriptor: { ...original.descriptor!, motion: "accent-wipe" } });
    seedPersistedRun([original]);
    let body: unknown;
    mockPipelineApi({
      report: { halted: false, assets: [original], log: { entries: [], campaignId: "seed" } },
      post: (_u, init) => {
        body = JSON.parse(String(init.body));
        return json({ jobId: "job-2" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [rerolled], log: { entries: [], campaignId: "seed" } }),
    });
    renderWithRun(<Harness />);
    await screen.findByLabelText(LABEL);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByText("regen"));
    expect(await screen.findByText("accent-wipe · 6s")).toBeTruthy();
    expect((body as { regenerateOnly: unknown[] }).regenerateOnly).toEqual([{ productId: "alpha", variantIndex: 1, attempt: 1 }]);
    expect(screen.getAllByLabelText(LABEL)).toHaveLength(1);
    expect(screen.getByText(/90\.0%/)).toBeTruthy();
  });
});
