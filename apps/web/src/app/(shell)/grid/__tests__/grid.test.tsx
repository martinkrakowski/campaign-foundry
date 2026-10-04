import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import {
  renderWithRun,
  seedPersistedRun,
  fakeDecisionsApi,
  makeAsset,
  makeMotionAsset,
  exerciseFocusTrap,
  mockPipelineApi,
  jobOk,
  json,
  storedTemplate,
  seedDecisions,
  fsUrls,
  s3Urls,
} from "@/__tests__/helpers";
import {
  DECISIONS_CONFLICT_MESSAGE,
  DECISIONS_UNREADABLE_MESSAGE,
  useRun,
  API,
  type Asset,
} from "@/lib/run-context";
import GridPage from "../page";
import { typeDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";

/**
 * One asset as `GET /campaigns/result` sends it for review: paths AND the `*Url`
 * fields the route mints (D204).
 *
 * **A test about the ELEMENT needs this.** Since D212 a tile renders its `<img>`,
 * `<video>` or download `<a>` from these fields and from nothing else — a fixture with
 * only paths renders the placeholder, so a test written about hover, the play control
 * or the modal would be measuring the placeholder instead of what it names. `urls`
 * picks the backend: `s3Urls` (default) is the cross-origin shape where the download
 * and display fields genuinely differ, `fsUrls` the same-origin one where D212 says
 * they are the same string.
 */
const served = (asset: Asset, urls: (a: Asset) => Partial<Asset> = s3Urls): Asset => ({
  ...asset,
  ...urls(asset),
});

/** A tiny harness exposing execute/regenerate so loading states can be driven. */
function Harness() {
  const { execute, regenerateRejected } = useRun();
  return createElement(
    Fragment,
    null,
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

  test("counts the creatives once the run reports progress", async () => {
    const user = userEvent.setup();
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        if (polls === 1) return json({ status: "running", done: 2, total: 5, log: null });
        return new Promise<Response>(() => {}); // hold the run open on the counted state
      },
    });
    renderWithRun(<Harness />);
    await user.click(screen.getByText("exec"));
    expect(await screen.findByText(messages.gridRunningCounted(2, 5))).toBeTruthy();
  });

  test("says nothing about counts before the run has planned its cells", async () => {
    const user = userEvent.setup();
    mockPipelineApi({
      job: () => json({ status: "running", done: 0, total: 0, log: null }),
    });
    renderWithRun(<Harness />);
    await user.click(screen.getByText("exec"));
    // 0/0 is the opening state of every run — "0 of 0 creatives done" would be
    // the same non-answer the counter exists to replace.
    expect(await screen.findByText(messages.gridRunningUncounted)).toBeTruthy();
    expect(screen.queryByText(messages.gridRunningCounted(0, 0))).toBeNull();
  });

  test("renders the review matrix with provenance and compliance badges", async () => {
    seedPersistedRun([
      // alpha has two ratios (exercises the ratio sort), incl. an unranked one (ratioRank -1).
      makeAsset({ backgroundSource: "imagen", passedCompliance: true, logoApplied: true }),
      makeAsset({ aspectRatio: "21:9", backgroundSource: "imagen" }),
      makeAsset({
        productId: "beta",
        aspectRatio: "9:16",
        backgroundSource: "procedural",
        passedCompliance: false,
        logoApplied: false,
      }),
      makeAsset({ productId: "gamma", aspectRatio: "16:9", backgroundSource: "reused" }),
      makeAsset({ productId: "delta", aspectRatio: "1:1", backgroundSource: "openrouter" }),
      makeAsset({ productId: "epsilon", aspectRatio: "1:1", backgroundSource: "firefly" }),
    ]);
    renderWithRun(<GridPage />);
    await waitFor(() => expect(screen.getAllByText("IMAGEN").length).toBeGreaterThan(0));
    expect(screen.getByText("FIREFLY")).toBeTruthy();
    const fireflyBadge = screen.getByText("FIREFLY");
    expect(fireflyBadge.className).toContain("border-brand-on-tint");
    expect(fireflyBadge.className).toContain("bg-brand-tint");
    expect(fireflyBadge.className).toContain("text-brand-on-tint");
    expect(screen.getByText("FALLBACK")).toBeTruthy();
    expect(screen.getByText("REUSED")).toBeTruthy();
    expect(screen.getByText("OPENROUTER")).toBeTruthy();
    expect(screen.getByText("NO LOGO")).toBeTruthy();
    expect(screen.getByText(/✓ 0 approved/)).toBeTruthy();
    expect(screen.getByText("seed")).toBeTruthy();
    expect(screen.getByText(typeDisplayName("social-post"))).toBeTruthy();
    expect(screen.queryByText("social-post")).toBeNull();
  });

  test("a display cell groups under its IAB size and keys by it, never a ratio (D113)", async () => {
    seedPersistedRun([
      makeAsset({ aspectRatio: undefined, size: "728x90", outputPath: "alpha/728x90.png" }),
    ]);
    renderWithRun(<GridPage />);
    // The filter offers the unit, the group heading is the unit itself, and the
    // card carries no ratio.
    expect((await screen.findAllByText("728x90")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("alpha @ 728x90 · default")).toBeTruthy();
  });

  test("a short-video brief shows the type display name on the review summary, never the raw id", async () => {
    seedPersistedRun([makeAsset()], { brief: { type: "short-video" } });
    renderWithRun(<GridPage />);
    expect(await screen.findByText(typeDisplayName("short-video"))).toBeTruthy();
    expect(screen.queryByText("short-video")).toBeNull();
  });

  test("a stored type banner shows Social post on the review summary, never an empty chip", async () => {
    seedPersistedRun([makeAsset()], { brief: { type: "banner" } });
    renderWithRun(<GridPage />);
    expect(await screen.findByText(typeDisplayName("social-post"))).toBeTruthy();
    expect(screen.queryByText("banner")).toBeNull();
  });

  test("shows a descriptor chip on variation cells", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 0,
        treatment: "headline-top-subtle",
        descriptor: {
          layout: "headline-top",
          tone: "subtle",
          backgroundSource: "procedural",
          paletteShift: 0.1,
        },
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

    const report = {
      halted: false,
      assets,
      log: { entries: [], campaignId: "camp" },
    };

    mockPipelineApi({
      post: () => json({ jobId: "job-reload-test" }, 202),
      job: () => jobOk(report),
      result: () => json(report),
      opened: {
        id: "camp",
        brief: {
          id: "camp",
          targetRegion: "DE",
          targetAudience: "a",
          campaignMessage: "Stay wild",
          template: storedTemplate,
          products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
          mode: "variation",
          variation: { count: 2 },
        },
      },
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
    seedDecisions({ "alpha/v0": "rejected" });
    // D213: a re-roll commits from a re-read of `GET /campaigns/result`, and the
    // server writes that report BEFORE it completes the job — so the store moves when
    // the job answers, and the result read is what puts the new tile on screen.
    let stored: unknown[] = [original];
    mockPipelineApi({
      report: { halted: false, assets: [original], log: { entries: [], campaignId: "seed" } },
      job: () => {
        stored = [rerolled];
        return jobOk({
          halted: false,
          assets: [rerolled],
          log: { entries: [], campaignId: "seed" },
        });
      },
      result: () =>
        json({ halted: false, assets: stored, log: { entries: [], campaignId: "seed" } }),
      opened: {
        id: "seed",
        brief: {
          id: "seed",
          targetRegion: "DE",
          targetAudience: "a",
          campaignMessage: "Hi",
          template: storedTemplate,
          products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
          // a variation run (variantIndex assets) can only exist under a randomized brief
          mode: "variation",
          variation: { count: 1 },
        },
      },
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
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false)); // decisions loaded
    await user.click(approve);
    await waitFor(() => expect(screen.getByText(/✓ 1 approved/)).toBeTruthy());
    await user.click(screen.getByText("Reject"));
    await waitFor(() => expect(screen.getByText(/✗ 1 rejected/)).toBeTruthy());
  });

  test("a decision another tab beat to the server shows the server's decisions and says why (D173, D82)", async () => {
    const user = userEvent.setup();
    const server = fakeDecisionsApi();
    seedPersistedRun([makeAsset()], { decisions: server });
    renderWithRun(<GridPage />);
    const approve = await screen.findByText("Approve");
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false)); // decisions loaded
    server.saveElsewhere({ "alpha/1:1/default": "rejected" }); // the other tab
    await user.click(approve);
    expect((await screen.findByRole("status")).textContent).toBe(DECISIONS_CONFLICT_MESSAGE);
    await waitFor(() => expect(screen.getByText(/✗ 1 rejected/)).toBeTruthy());
    expect(screen.getByText(/✓ 0 approved/)).toBeTruthy();
  });

  test("Approve and Reject wait for the run's review decisions to load (D173)", async () => {
    let release!: () => void;
    const server = fakeDecisionsApi();
    seedPersistedRun([makeAsset()], {
      decisions: {
        ...server,
        handle: (url: string, init: RequestInit) =>
          new Promise<Response>((res) => (release = () => res(server.handle(url, init)))),
      } as unknown as ReturnType<typeof fakeDecisionsApi>,
    });
    renderWithRun(<GridPage />);
    const approve = (await screen.findByText("Approve")) as HTMLButtonElement;
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe("Loading the review decisions");
    expect((screen.getByText("Reject") as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(approve.disabled).toBe(false));
  });

  test("Approve and Reject pause while a run is in flight, name the run as why, and return after it", async () => {
    const user = userEvent.setup();
    let finishPost!: (res: Response) => void;
    const seeded = seedPersistedRun([makeAsset()]);
    mockPipelineApi({
      opened: seeded,
      report: {
        halted: false,
        assets: [makeAsset()],
        log: { entries: [], campaignId: "seed" },
      },
      post: () => new Promise<Response>((res) => (finishPost = res)), // held open → the run is in flight
    });
    renderWithRun(<Harness />);
    const approve = (await screen.findByText("Approve")) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false)); // decisions loaded
    // The title alone is unreachable while the button is disabled — no focus, no
    // announcement — so the same reason must also be a visible, announced status line.
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByText("exec"));
    await waitFor(() => expect(approve.disabled).toBe(true));
    expect(approve.title).toBe("A run is in flight — verdicts wait until it finishes");
    expect((screen.getByText("Reject") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(messages.reviewPausedWhileRunning);
    finishPost(json({ jobId: "job-1" }, 202));
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("decisions that could not be loaded say so on the review bar, pause the verdicts, and Try again loads them", async () => {
    const user = userEvent.setup();
    let down = true;
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    seedPersistedRun([makeAsset()], {
      decisions: {
        ...server,
        handle: (url: string, init: RequestInit) =>
          down ? json({ error: "down" }, 500) : server.handle(url, init),
      } as ReturnType<typeof fakeDecisionsApi>,
    });
    renderWithRun(<GridPage />);
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(DECISIONS_UNREADABLE_MESSAGE);
    const approve = screen.getByText("Approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe(DECISIONS_UNREADABLE_MESSAGE);
    down = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText(/✓ 1 approved/)).toBeTruthy());
    expect(approve.disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the Preview pill carries its own boundary, not the video's", async () => {
    // The pill is white on a translucent scrim, so on a motion tile its ground is the clip
    // itself: over a white frame `bg-scrim/40` composites to #999999 and a white pill is
    // 2.85:1, under the 3:1 WCAG 1.4.11 asks of a control boundary. The ring is what makes
    // the edge independent of the frame — drop it and the pill is legible only over dark
    // video. Asserted as a class because the contrast has no other observable in jsdom.
    seedPersistedRun([makeAsset()]);
    renderWithRun(<GridPage />);
    const pill = (await screen.findAllByText("Preview"))[0];
    expect(pill.className).toContain("ring-scrim");
    expect(pill.className).toMatch(/\bring-1\b/);
  });

  test("the lightbox chrome is fixed-white, because its ground is black in both themes", async () => {
    // `bg-scrim/80` composites to #333333 over the light page, so theme text painted on
    // it measured 2.32:1 (muted) and 1.41:1 (primary) — invisible in the light theme,
    // fine in the dark one, which is why the audit missed it. White is a function of
    // this ground, not of the theme.
    const user = userEvent.setup();
    seedPersistedRun([makeAsset()]);
    renderWithRun(<GridPage />);
    await user.click((await screen.findAllByText("Preview"))[0]);

    const modal = await screen.findByRole("dialog");
    expect(screen.getByLabelText("Close preview").className).toContain("text-white/70");
    const assetLabel = within(modal).getByText(/alpha @ 1:1/);
    expect(assetLabel.className).toContain("text-white");
    expect(assetLabel.parentElement?.className).toContain("text-white/70");
  });

  test("opens and closes the full-size preview", async () => {
    const user = userEvent.setup();
    seedPersistedRun([served(makeAsset())]);
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
    seedDecisions({ "alpha/1:1/default": "rejected" });
    mockPipelineApi({
      post: () => new Promise<Response>(() => {}), // pending
      report: { halted: false, assets: [makeAsset()], log: { entries: [], campaignId: "seed" } },
      opened: {
        id: "seed",
        brief: {
          id: "seed",
          targetRegion: "DE",
          targetAudience: "a",
          campaignMessage: "Hi",
          template: storedTemplate,
          products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
        },
      },
    });
    localStorage.setItem("cf:brief-picked", "1");
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
      return createElement(
        Fragment,
        null,
        createElement(
          "button",
          {
            onClick: () =>
              setBrief({
                ...brief,
                id: "other",
                products: [
                  { id: "gamma", name: "Gamma", primaryColor: "#111111", logoPath: "g.png" },
                ],
              }),
          },
          "switch",
        ),
        createElement(GridPage, null),
      );
    }
    const user = userEvent.setup();
    const seedAssets = Array.from({ length: 30 }, (_, i) =>
      makeAsset({
        productId: i % 2 ? "alpha" : "beta",
        outputPath: `a-${i}.png`,
        treatment: `t${i}`,
      }),
    );
    const otherAssets = [
      makeAsset({ productId: "gamma", outputPath: "gamma/1x1.png" }),
      makeAsset({ productId: "delta", outputPath: "delta/1x1.png" }),
    ];
    const seeded = seedPersistedRun(seedAssets);
    mockPipelineApi({
      opened: seeded,
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
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "genai",
          paletteShift: 0,
        },
      }),
      makeAsset({
        productId: "beta",
        variantIndex: 1,
        outputPath: "beta/1x1.png",
        descriptor: {
          layout: "headline-bottom",
          tone: "subtle",
          backgroundSource: "procedural",
          paletteShift: 0.2,
        },
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
    const motion = served(makeMotionAsset());
    const still = served(makeAsset());
    seedPersistedRun([motion, still]);
    renderWithRun(<GridPage />);
    const video = (await screen.findByLabelText(LABEL)) as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.muted).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    // The server's own fields, exactly (D204/D212) — not a path this page builds.
    expect(video.getAttribute("poster")).toBe(motion.outputUrl);
    expect(video.getAttribute("src")).toBe(motion.videoUrl);
    expect(screen.getByText("ken-burns-in · 6s")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download .MP4" }).getAttribute("href")).toBe(
      motion.videoDownloadUrl,
    );
    expect(screen.getByRole("link", { name: "Download poster .PNG" }).getAttribute("href")).toBe(
      motion.outputDownloadUrl,
    );
    // The static tile keeps its plain image + download label.
    expect(
      (await screen.findByRole("img", { name: "alpha @ 1:1 · default" })).getAttribute("src"),
    ).toBe(still.outputUrl);
    expect(screen.getByRole("link", { name: "Download .PNG" }).getAttribute("href")).toBe(
      still.outputDownloadUrl,
    );
  });

  test("hover plays and leaving rewinds; the play control toggles for keyboard users", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockImplementation(() => Promise.resolve());
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const user = userEvent.setup();
    seedPersistedRun([served(makeMotionAsset())]);
    renderWithRun(<GridPage />);
    const video = (await screen.findByLabelText(LABEL)) as HTMLVideoElement;
    const tile = video.parentElement as HTMLElement;

    fireEvent.mouseEnter(tile);
    expect(play).toHaveBeenCalledTimes(1);
    // The control flips to "playing" only once play() has resolved.
    expect(
      await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true }),
    ).toBeTruthy();
    video.currentTime = 3;
    fireEvent.mouseLeave(tile);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(0);
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false })).toBeTruthy();

    // Keyboard: focus + Enter never passes through the hover handlers.
    screen.getByRole("button", { name: `Play ${LABEL}` }).focus();
    await user.keyboard("{Enter}");
    expect(play).toHaveBeenCalledTimes(2);
    expect(
      (await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true })).textContent,
    ).toBe("❚❚ 6s");
    await user.keyboard("{Enter}");
    expect(pause).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false }).textContent).toBe(
      "▶ 6s",
    );
  });

  test("a play() that returns nothing counts as playing; a rejected play() keeps the play control and shows a hint", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    play.mockImplementationOnce(() => undefined as unknown as Promise<void>);
    play.mockImplementationOnce(() => Promise.reject(new Error("NotAllowedError")));
    play.mockImplementationOnce(() => Promise.resolve());
    const user = userEvent.setup();
    seedPersistedRun([
      served(
        makeMotionAsset({
          durationSec: undefined,
          descriptor: {
            layout: "headline-top",
            tone: "bold",
            backgroundSource: "procedural",
            paletteShift: 0,
            motion: "headline-rise",
          },
        }),
      ),
    ]);
    renderWithRun(<GridPage />);
    const button = await screen.findByRole("button", { name: `Play ${LABEL}` });
    expect(button.textContent).toContain("clip");
    expect(screen.getByText("headline-rise · ?s")).toBeTruthy();
    button.focus();
    await user.keyboard("{Enter}"); // play() → undefined (old engine): treated as started
    expect(
      await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true }),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await user.keyboard("{Enter}"); // pause
    await user.keyboard("{Enter}"); // play() → rejected: not playing, hint shown
    expect(play).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "can't play");
    expect(screen.getByRole("button", { name: `Play ${LABEL}`, pressed: false })).toBeTruthy();
    await user.keyboard("{Enter}"); // play() → resolves: the hint clears
    expect(
      await screen.findByRole("button", { name: `Pause ${LABEL}`, pressed: true }),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the chip falls back to the asset duration when the descriptor lacks one", async () => {
    seedPersistedRun([
      makeMotionAsset({
        durationSec: 4,
        descriptor: {
          layout: "headline-top",
          tone: "bold",
          backgroundSource: "procedural",
          paletteShift: 0,
          motion: "accent-wipe",
        },
      }),
    ]);
    renderWithRun(<GridPage />);
    expect(await screen.findByText("accent-wipe · 4s")).toBeTruthy();
  });

  test("the preview modal plays the clip with controls", async () => {
    const user = userEvent.setup();
    seedPersistedRun([served(makeMotionAsset())]);
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
    seedPersistedRun([served(makeMotionAsset()), served(makeAsset())]);
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
    const original = served(makeMotionAsset());
    const rerolled = served(
      makeMotionAsset({
        attempt: 1,
        complianceScore: 0.9,
        descriptor: { ...makeMotionAsset().descriptor!, motion: "accent-wipe" },
      }),
    );
    const seeded = seedPersistedRun([original]);
    let body: unknown;
    // D213: as above — the merged report is written before the job completes, so the
    // re-read that commits the re-roll answers the re-rolled row.
    let stored: unknown[] = [original];
    mockPipelineApi({
      opened: seeded,
      report: { halted: false, assets: [original], log: { entries: [], campaignId: "seed" } },
      post: (_u, init) => {
        body = JSON.parse(String(init.body));
        return json({ jobId: "job-2" }, 202);
      },
      job: () => {
        stored = [rerolled];
        return jobOk({
          halted: false,
          assets: [rerolled],
          log: { entries: [], campaignId: "seed" },
        });
      },
      result: () =>
        json({ halted: false, assets: stored, log: { entries: [], campaignId: "seed" } }),
    });
    renderWithRun(<Harness />);
    await screen.findByLabelText(LABEL);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(screen.getByText("regen"));
    expect(await screen.findByText("accent-wipe · 6s")).toBeTruthy();
    expect((body as { regenerateOnly: unknown[] }).regenerateOnly).toEqual([
      { productId: "alpha", variantIndex: 1, attempt: 1 },
    ]);
    expect(screen.getAllByLabelText(LABEL)).toHaveLength(1);
    expect(screen.getByText(/90\.0%/)).toBeTruthy();
  });
});

/**
 * D204/D212: the tile's every URL is the server's own field, read exactly.
 *
 * **Both backends, every case.** `s3Urls` is cross-origin, so its download fields
 * differ from its display ones by the signed disposition — a consumer that reached
 * for `outputUrl` where `outputDownloadUrl` belongs fails a `toBe` there. `fsUrls` is
 * the same-origin shape where D212 says the two are the SAME string, so a test that
 * only ran the `s3` fixture would never learn whether the code reads the field at all
 * or merely built something plausible. Exact attribute equality in both, never
 * `toContain`: a URL that merely *mentions* the path is the old defect wearing the
 * new signature.
 */
describe("GridPage — every tile URL is the server's field (D204/D212)", () => {
  const BACKENDS = [
    ["s3", s3Urls],
    ["fs", fsUrls],
  ] as const;

  test("the still tile renders outputUrl as its img src", async () => {
    for (const [backend, urls] of BACKENDS) {
      const still = served(makeAsset(), urls);
      seedPersistedRun([still]);
      const { unmount } = renderWithRun(<GridPage />);
      const img = await screen.findByRole("img", { name: "alpha @ 1:1 · default" });
      expect(img.getAttribute("src"), backend).toBe(still.outputUrl);
      unmount();
    }
  });

  test("the motion tile renders videoUrl as its src and outputUrl as its poster", async () => {
    for (const [backend, urls] of BACKENDS) {
      const motion = served(makeMotionAsset(), urls);
      seedPersistedRun([motion]);
      const { unmount } = renderWithRun(<GridPage />);
      const video = await screen.findByLabelText("alpha @ 9:16 · v1 · headline-top-bold");
      expect(video.getAttribute("src"), backend).toBe(motion.videoUrl);
      expect(video.getAttribute("poster"), backend).toBe(motion.outputUrl);
      unmount();
    }
  });

  test("the download links use the attachment fields, never the display ones", async () => {
    const MOTION_LABEL = "alpha @ 9:16 · v1 · headline-top-bold";
    const STILL_LABEL = "alpha @ 1:1 · default";
    for (const [backend, urls] of BACKENDS) {
      const motion = served(makeMotionAsset({ proofPath: "proofs/motion.pdf" }), urls);
      const still = served(makeAsset(), urls);
      seedPersistedRun([motion, still]);
      const { unmount } = renderWithRun(<GridPage />);
      await screen.findByRole("img", { name: STILL_LABEL });
      // Scoped to the tile, so each link is the one the CELL holds — both tiles carry a
      // "Print Proof (.PDF)" and both carry a PNG, and an unscoped query would be
      // asserting on whichever came first in the document.
      const tile = (label: string) => screen.getByText(label).closest("figure") as HTMLElement;
      const href = (label: string, name: string) =>
        within(tile(label)).getByRole("link", { name }).getAttribute("href");
      expect(href(MOTION_LABEL, "Download .MP4"), backend).toBe(motion.videoDownloadUrl);
      expect(href(MOTION_LABEL, "Download poster .PNG"), backend).toBe(motion.outputDownloadUrl);
      expect(href(STILL_LABEL, "Download .PNG"), backend).toBe(still.outputDownloadUrl);
      expect(href(MOTION_LABEL, "Print Proof (.PDF)"), backend).toBe(motion.proofUrl);
      expect(href(STILL_LABEL, "Print Proof (.PDF)"), backend).toBe(still.proofUrl);
      // Every link keeps `download`: same-origin on `fs` it is what saves the file, and
      // cross-origin under `s3` it is inert while the signed disposition decides.
      for (const [label, name] of [
        [MOTION_LABEL, "Download .MP4"],
        [STILL_LABEL, "Download .PNG"],
        [STILL_LABEL, "Print Proof (.PDF)"],
      ] as const) {
        expect(
          within(tile(label)).getByRole("link", { name }).hasAttribute("download"),
          backend,
        ).toBe(true);
      }
      // Under `s3` the display and download URLs genuinely differ, so pinning the
      // distinction is a real assertion rather than a coincidence of the fixture: a
      // consumer that reached for the DISPLAY url where the download belongs fails here.
      if (backend === "s3") {
        expect(motion.videoDownloadUrl).not.toBe(motion.videoUrl);
        expect(motion.outputDownloadUrl).not.toBe(motion.outputUrl);
        expect(href(MOTION_LABEL, "Download .MP4")).not.toBe(motion.videoUrl);
        expect(href(MOTION_LABEL, "Download poster .PNG")).not.toBe(motion.outputUrl);
        expect(href(STILL_LABEL, "Download .PNG")).not.toBe(still.outputUrl);
      }
      unmount();
    }
  });

  test("the preview modal renders the still's outputUrl and the motion clip's own fields", async () => {
    const user = userEvent.setup();
    const still = served(makeAsset());
    const motion = served(makeMotionAsset());
    seedPersistedRun([still, motion]);
    renderWithRun(<GridPage />);
    await screen.findByRole("img", { name: "alpha @ 1:1 · default" });

    await user.click(screen.getAllByRole("button", { name: "Preview" })[0]!);
    const stillModal = await screen.findByRole("dialog");
    expect(within(stillModal).getByRole("img").getAttribute("src")).toBe(still.outputUrl);
    await user.keyboard("{Escape}");

    await user.click(screen.getAllByRole("button", { name: "Preview" })[1]!);
    const motionModal = await screen.findByRole("dialog");
    const preview = within(motionModal).getByLabelText("alpha @ 9:16 · v1 · headline-top-bold");
    expect(preview.getAttribute("src")).toBe(motion.videoUrl);
    expect(preview.getAttribute("poster")).toBe(motion.outputUrl);
  });
});

describe("GridPage — no server URL means the placeholder, never a client-built one (D212/D213)", () => {
  const STILL_LABEL = "alpha @ 1:1 · default";
  const MOTION_LABEL = "alpha @ 9:16 · v1 · headline-top-bold";

  test("with every *Url absent and the paths present, the still tile renders the placeholder", async () => {
    // `makeAsset` carries paths and NO `*Url` — which is exactly what a run committed
    // from a job payload looks like, since the jobs route signs nothing (D213).
    seedPersistedRun([makeAsset()]);
    const { container } = renderWithRun(<GridPage />);
    await screen.findByText(/Showing 1 of 1/);

    // The property FIRST, before any assertion about what the tile rendered: not one
    // attribute anywhere in the container names the output route. A single `src` built
    // by this page would 404 under `s3`, and it is the one failure no later assertion
    // here would make visible — a placeholder with a client-built href still renders.
    for (const el of container.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain("/output/");
      }
    }

    const placeholder = await screen.findByTestId("asset-unavailable");
    expect(placeholder.getAttribute("role")).toBe("img");
    expect(placeholder.getAttribute("aria-label")).toBe(`${STILL_LABEL} — preview unavailable`);
    expect(placeholder.textContent).toBe("Preview unavailable");

    // No element renders a source at all: not an `<img>` with no `src`, not a
    // `<video>` with no `src`, and no download link whose href is missing.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    // The overlay is still reachable: the reviewer previews and decides as usual.
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  test("the motion tile and the modal both render the placeholder when no videoUrl arrived", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeMotionAsset()]);
    const { container } = renderWithRun(<GridPage />);
    expect(await screen.findByTestId("asset-unavailable")).toBeTruthy();
    // Never a `<video>` with no `src`: the cell IS the clip, so without one it is the
    // placeholder — even though `outputPath` is present and would make a poster.
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByLabelText(MOTION_LABEL)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByTestId("asset-unavailable")).toBeTruthy();
    expect(within(modal).queryByRole("img", { name: MOTION_LABEL })).toBeNull();
  });

  test("a poster without a clip takes the placeholder; a clip without a poster omits the attribute", async () => {
    const user = userEvent.setup();
    const motion = makeMotionAsset();
    // `outputUrl` present, `videoUrl` absent: the cell is the clip, so it cannot render.
    seedPersistedRun([{ ...motion, ...fsUrls(motion), videoUrl: undefined }]);
    const { unmount } = renderWithRun(<GridPage />);
    expect(await screen.findByTestId("asset-unavailable")).toBeTruthy();
    unmount();

    // `videoUrl` present, `outputUrl` absent: the clip renders and the poster attribute
    // is OMITTED, rather than pointing at nothing.
    seedPersistedRun([{ ...motion, ...fsUrls(motion), outputUrl: undefined }]);
    renderWithRun(<GridPage />);
    const video = await screen.findByLabelText(MOTION_LABEL);
    expect(video.getAttribute("src")).toBe(fsUrls(motion).videoUrl);
    expect(video.hasAttribute("poster")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByLabelText(MOTION_LABEL).hasAttribute("poster")).toBe(false);
  });

  test("an empty or non-string URL field is no URL, not an href to nowhere", async () => {
    // The three ways a persisted report can fail to name a file, one at a time. All of
    // them must land on the placeholder: `""` resolves to the page itself, and a
    // non-string is the untrusted-JSON case the type's optionality cannot rule out.
    for (const [name, value] of [
      ["empty", ""],
      ["number", 42],
      ["null", null],
    ] as const) {
      seedPersistedRun([makeAsset({ outputUrl: value as unknown as string })]);
      const { unmount } = renderWithRun(<GridPage />);
      expect(await screen.findByTestId("asset-unavailable"), name).toBeTruthy();
      expect(screen.queryByRole("link"), name).toBeNull();
      unmount();
    }
  });

  test("a re-run's new revision moves the tile's src; the same revision leaves it alone", async () => {
    // Cache busting is the REPORT REVISION's job now (D209a/c), not a client counter:
    // every run writes a new report, so the URL over the same path must change — or the
    // bytes behind it stay cached and the grid shows the previous creative. The row's
    // `outputPath` never moves, so a changed `src` can only be the revision.
    const user = userEvent.setup();
    const row = makeAsset();
    let revision = "rev-1";
    let reads = 0;
    const seeded = seedPersistedRun([row]);
    mockPipelineApi({
      opened: seeded,
      post: () => json({ jobId: "job-1" }, 202),
      job: () => jobOk({ halted: false, assets: [row], log: { entries: [], campaignId: "seed" } }),
      result: () => {
        reads += 1;
        return json({
          halted: false,
          assets: [{ ...row, ...s3Urls(row, revision) }],
          log: { entries: [], campaignId: "seed" },
        });
      },
    });
    renderWithRun(<Harness />);
    await screen.findByRole("img", { name: STILL_LABEL });
    const tileSrc = () =>
      screen.queryByRole("img", { name: STILL_LABEL })?.getAttribute("src") ?? null;

    await user.click(screen.getByText("exec"));
    await waitFor(() => expect(tileSrc()).toBe(s3Urls(row, "rev-1").outputUrl));
    const first = tileSrc();

    // The same revision: the same report, so the same URL. A re-read that invented a
    // fresh query here would defeat the browser cache D204 is built on. The read
    // counter is what makes this wait for the commit instead of racing it.
    const beforeSecond = reads;
    await user.click(screen.getByText("exec"));
    await waitFor(() => expect(reads).toBeGreaterThan(beforeSecond));
    expect(tileSrc()).toBe(first);

    // A new revision: a new URL over the same path — exactly the signed `v` that differs.
    revision = "rev-2";
    await user.click(screen.getByText("exec"));
    await waitFor(() => expect(tileSrc()).toBe(s3Urls(row, "rev-2").outputUrl));
    expect(tileSrc()).not.toBe(first);
    expect(tileSrc()).toContain("v=rev-2");
  });
});

/**
 * The control-boundary token (WCAG 1.4.11): these controls are identified only by
 * their hairline, so it must be `border-border-control` (≥ 3:1 on every ground).
 * jsdom applies no CSS, so the class list is the only observable — split, because
 * `border-border` is a substring of `border-border-control`.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

/** The page campaign's uuid and slug — two names for one campaign (D178). */
const PAGE_UUID = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";
const PAGE_SLUG = "autumn-launch";

describe("GridPage — control boundaries carry border-control", () => {
  test("the pager, the native filter selects, and the unselected decision arms", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) =>
      makeAsset({ outputPath: `a-${i}.png`, treatment: `t${i}` }),
    );
    seedPersistedRun(thirty);
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Showing 24 of 30/)).toBeTruthy();

    // Pager: bg-surface on the page ground — a ~1.05:1 fill delta.
    const pager = screen.getByRole("button", { name: "Show more" });
    expect(classes(pager)).toContain("border-border-control");
    expect(classes(pager)).not.toContain("border-border");

    // Native <select>, bg-surface-2.
    const product = screen.getByLabelText("Product");
    expect(classes(product)).toContain("border-border-control");
    expect(classes(product)).not.toContain("border-border");

    // The unselected arm of each decision toggle; the decided arm keeps success/error.
    for (const name of ["Approve", "Reject"]) {
      const arm = screen.getAllByRole("button", { name })[0];
      expect(classes(arm)).toContain("border-border-control");
      expect(classes(arm)).not.toContain("border-border");
    }
  });
});

describe("GridPage — the page's ?campaign= (PT-5c3, D180)", () => {
  afterEach(() => window.history.replaceState(null, "", "/grid"));

  test("loads from a uuid query whose report keys the campaign's slug, and the assets render", async () => {
    window.history.replaceState(null, "", `/grid?campaign=${PAGE_UUID}`);
    // The page is addressed by the uuid (D178); the persisted report keys by the
    // slug — the report's log.campaignId is a DIFFERENT string from the query.
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${PAGE_UUID}`)
            ? json({
                halted: false,
                assets: [makeAsset({ backgroundSource: "imagen" })],
                log: { entries: [], campaignId: PAGE_SLUG },
              })
            : json({ halted: false, assets: [], log: null });
        }
        if (url === `${API}/campaigns/${PAGE_UUID}`) {
          return json({
            campaignId: PAGE_UUID,
            slug: PAGE_SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          });
        }
        if (url.includes("/campaigns/briefs")) {
          return json({
            briefs: [
              {
                file: `${PAGE_SLUG}.yaml`,
                campaignId: PAGE_UUID,
                brief: {
                  id: PAGE_SLUG,
                  template: storedTemplate,
                  targetRegion: "DE",
                  targetAudience: "a",
                  campaignMessage: "m",
                  products: [
                    { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
                  ],
                },
              },
            ],
          });
        }
        return json({ error: "Not found" }, 404);
      },
    });
    renderWithRun(<GridPage />);
    expect(await screen.findByText("alpha @ 1:1 · default")).toBeTruthy();
  });

  test("an unknown id shows the empty state", async () => {
    window.history.replaceState(null, "", `/grid?campaign=${PAGE_UUID}`);
    // Unknown: the meta read answers what a missing campaign answers (404).
    mockPipelineApi({ result: () => json({ error: "Not found" }, 404) });
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Start orchestrating assets/)).toBeTruthy();
  });

  test("a hidden id shows the same empty state (PT-2d: hidden reads as missing)", async () => {
    window.history.replaceState(null, "", `/grid?campaign=${PAGE_UUID}`);
    // Hidden by team: the API answers the same 404 the unknown id does (PT-2d),
    // so the page cannot tell them apart — and must not try to.
    mockPipelineApi({ result: () => json({ error: "Not found" }, 404) });
    renderWithRun(<GridPage />);
    expect(await screen.findByText(/Start orchestrating assets/)).toBeTruthy();
  });
});
