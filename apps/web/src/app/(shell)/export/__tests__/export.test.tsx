import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import {
  renderWithRun,
  seedPersistedRun,
  makeAsset,
  makeMotionAsset,
  jobOk,
  json,
  mockPipelineApi,
  seedDecisions,
  fakeDecisionsApi,
  fsUrls,
  s3Urls,
} from "@/__tests__/helpers";
import { API, URL_REFRESH_MS, useRun } from "@/lib/run-context";
import * as messages from "@/components/campaign/messages";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import ExportPage from "../page";

/** Test-only control: adopt a different brief, as the picker's select does. */
function SwitchToOther() {
  const { brief, setBrief } = useRun();
  return (
    <button type="button" onClick={() => setBrief({ ...brief, id: "other" })}>
      switch run
    </button>
  );
}

/** Test-only control: run an on-screen draft the shell does not hold (D35). */
function RunDraft() {
  const { execute } = useRun();
  return (
    <button
      type="button"
      onClick={() =>
        execute({
          schemaVersion: 1,
          template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
          id: "on-screen-draft",
          targetRegion: "US",
          targetAudience: "x",
          campaignMessage: "the draft as typed",
          products: [
            { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
            { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
          ],
        })
      }
    >
      run draft
    </button>
  );
}

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

const item = (over: Record<string, unknown> = {}) => ({
  productId: "alpha",
  aspectRatio: "1:1",
  treatment: "default",
  source: "alpha/1x1.png",
  packagedPath: "packages/seed/instagram-feed/alpha/1x1.png",
  bytes: 12,
  checks: { size: "pass" },
  ...over,
});

describe("ExportPage — platform packaging", () => {
  test("shows static platform toggles, packages the selected one, and links the zip", async () => {
    const user = userEvent.setup();
    seedDecisions({ "alpha/1:1/default": "approved" });
    seedPersistedRun([makeAsset()]);
    mockPipelineApi({
      report: {
        halted: false,
        assets: [makeAsset()],
        log: { entries: [], campaignId: "seed" },
      },
      packages: () => json({ platforms: [] }, 404),
      packagePost: () =>
        json({
          platforms: [
            {
              platformId: "instagram-feed",
              items: [
                item(),
                item({
                  productId: "beta",
                  checks: { size: "fail" },
                  packagedPath: "packages/seed/instagram-feed/beta/1x1.png",
                }),
              ],
            },
          ],
        }),
    });
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "instagram-feed", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "linkedin", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "x", pressed: false })).toBeTruthy();
    // Nothing packaged yet: the download is a disabled hint, not a link that would 404.
    const placeholder = screen.getByRole("button", { name: "Download zip" }) as HTMLButtonElement;
    expect(placeholder.disabled).toBe(true);
    expect(placeholder.title).toBe("Package this platform first");
    expect(screen.queryByRole("link", { name: "Download zip" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Package" }));
    expect(await screen.findByText("packages/seed/instagram-feed/alpha/1x1.png")).toBeTruthy();
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText("FAIL")).toBeTruthy();
    const zip = screen.getByRole("link", { name: "Download zip" });
    expect(zip.getAttribute("href")).toBe(`${API}/campaigns/packages/seed/instagram-feed.zip`);

    // linkedin has no package: back to the disabled hint.
    await user.click(screen.getByRole("button", { name: "linkedin" }));
    expect(screen.getByRole("button", { name: "linkedin", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "instagram-feed", pressed: false })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download zip" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Download zip" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a display package row names its size, not a ratio (D113)", async () => {
    const user = userEvent.setup();
    const assets = [makeAsset({ size: "728x90", outputPath: "alpha/728x90.png" })];
    seedPersistedRun(assets);
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packages: () => json({ platforms: [] }, 404),
      packagePost: () =>
        json({
          platforms: [
            {
              platformId: "google-display",
              items: [
                item({
                  aspectRatio: undefined,
                  size: "728x90",
                  packagedPath: "packages/seed/google-display/alpha/728x90.png",
                }),
              ],
            },
          ],
        }),
    });
    renderWithRun(<ExportPage />);
    await screen.findByRole("group", { name: "Platforms" });
    await user.click(screen.getByRole("button", { name: "google-display" }));
    await user.click(await screen.findByRole("button", { name: "Package" }));
    expect(await screen.findByText("packages/seed/google-display/alpha/728x90.png")).toBeTruthy();
    expect(screen.getByText("alpha @ 728x90 · default")).toBeTruthy();
  });

  test("a social-only run lists no display profile — packaging one would deterministically fail", async () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    for (const id of ["google-display", "meta-audience-network", "display-web"]) {
      expect(screen.queryByRole("button", { name: id })).toBeNull();
    }
  });

  test("a run with a 728x90 asset lists the display profiles that accept it", async () => {
    seedPersistedRun([makeAsset(), makeAsset({ size: "728x90", outputPath: "alpha/728x90.png" })]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "google-display", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "display-web", pressed: false })).toBeTruthy();
    // meta-audience-network accepts no 728x90 unit, so it stays hidden.
    expect(screen.queryByRole("button", { name: "meta-audience-network" })).toBeNull();
  });

  test("a static run is not offered the html profiles — packaging them would find nothing (X14)", async () => {
    // Size alone is not eligibility: google-display-html lists the same five
    // IAB units as google-display, but it packages html, and this run holds
    // only static assets — its Package action would deterministically fail.
    seedPersistedRun([makeAsset({ size: "728x90", outputPath: "alpha/728x90.png" })]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "google-display", pressed: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "google-display-html" })).toBeNull();
    expect(screen.queryByRole("button", { name: "display-web-html" })).toBeNull();
  });

  test("an html run is offered the html profiles AND the static ones via the fallback (D161)", async () => {
    // The picker used to hide google-display / display-web / meta-audience-network
    // for an html-only run: it read the run's formats as {"html"} alone, and none
    // of those profiles' formats (["static"]) intersected it. But
    // PackageForPlatformUseCase already packages an html row's raster fallback
    // (D122) onto exactly these three — so the picker was hiding a package the
    // API could actually build. htmlFallbackPath is what makes the row eligible;
    // an html asset without one must not gain the static profiles.
    const assets = [
      makeAsset({
        format: "html",
        size: "300x250",
        outputPath: "alpha/300x250.png",
        htmlBundlePath: "alpha/300x250/index.html",
        htmlFallbackPath: "alpha/300x250/fallback.png",
      }),
    ];
    seedPersistedRun(assets);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "google-display-html", pressed: false }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "display-web-html", pressed: false })).toBeTruthy();
    // All three static display profiles list 300x250, so all three are now
    // offered — packaging one sends the fallback PNG, not the html bundle.
    expect(screen.getByRole("button", { name: "google-display", pressed: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "display-web", pressed: false })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "meta-audience-network", pressed: false }),
    ).toBeTruthy();
  });

  test("a social static profile never packages an html row's fallback (D161 scope)", async () => {
    // The fallback route is scoped to DISPLAY static profiles (sizes, not a
    // ratio) — a social platform like instagram-feed has formats ["static"]
    // too, and must not light up just because runFormats now effectively
    // covers "static" for this row. Asserted with an aspectRatio-bearing html
    // asset, the shape a social-format html row would never actually have, to
    // prove the scope is the field (sizes !== undefined), not the presence of
    // "static" in a profile's formats.
    const assets = [
      makeAsset({
        format: "html",
        aspectRatio: "1:1",
        size: undefined,
        outputPath: "alpha/1x1.png",
        htmlBundlePath: "alpha/1x1/index.html",
        htmlFallbackPath: "alpha/1x1/fallback.png",
      }),
    ];
    seedPersistedRun(assets);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "instagram-feed" })).toBeNull();
  });

  test("Package waits for the run's review decisions: until they load, none is not yet known (D173)", async () => {
    let answer!: (r: Response) => void;
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    seedPersistedRun([makeAsset()], {
      decisions: {
        ...server,
        handle: () => new Promise<Response>((res) => (answer = res)),
      } as unknown as ReturnType<typeof fakeDecisionsApi>,
    });
    renderWithRun(<ExportPage />);
    const pkg = await screen.findByRole("button", { name: "Package" });
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    expect((pkg as HTMLButtonElement).disabled).toBe(true);
    expect(pkg.getAttribute("title")).toBe("Loading the review decisions");
    answer(server.handle("", {}));
    await waitFor(() => expect((pkg as HTMLButtonElement).disabled).toBe(false));
  });

  test("Package is disabled while a run is in flight, and says why", async () => {
    const user = userEvent.setup();
    seedPersistedRun([makeAsset()]);
    mockPipelineApi({
      report: {
        halted: false,
        assets: [makeAsset()],
        log: { entries: [], campaignId: "seed" },
      },
      post: () => new Promise<Response>(() => {}), // never resolves → the run stays in flight
    });
    renderWithRun(
      <>
        <RunDraft />
        <ExportPage />
      </>,
    );
    const pkg = (await screen.findByRole("button", { name: "Package" })) as HTMLButtonElement;
    await waitFor(() => expect(pkg.disabled).toBe(false)); // decisions loaded, a platform picked
    // The title alone is unreachable while the button is disabled — no focus, no
    // announcement — so the same reason must also be a visible, announced status line.
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByText("run draft"));
    await waitFor(() => expect(pkg.disabled).toBe(true));
    expect(pkg.title).toBe("A run is in flight — export waits until it finishes");
    expect(screen.getByRole("status").textContent).toBe(messages.exportPausedWhileRunning);
  });

  test("a run whose html assets were rejected is not offered the html profiles (X14 fix2)", async () => {
    // Packaging sends only the approved keys once decisions exist, so the picker
    // must offer only what will actually be packaged: the rejected html row is
    // still in the run, but an approved-static-only run has nothing an html
    // profile could package — offering it would deterministically error.
    const assets = [
      makeAsset({ aspectRatio: undefined, size: "728x90", outputPath: "alpha/728x90.png" }),
      makeAsset({
        productId: "gamma",
        aspectRatio: undefined,
        size: "728x90",
        outputPath: "gamma/728x90.png",
        format: "html",
        htmlBundlePath: "gamma/728x90/index.html",
      }),
    ];
    seedDecisions({ "alpha/728x90/default": "approved", "gamma/728x90/default": "rejected" });
    seedPersistedRun(assets);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    await screen.findByText(/1 of 2 creatives approved/); // the decisions have loaded
    expect(screen.getByRole("button", { name: "google-display", pressed: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "google-display-html" })).toBeNull();
    expect(screen.queryByRole("button", { name: "display-web-html" })).toBeNull();
  });

  test("sends the approved asset keys as include, and omits include with no decisions", async () => {
    const user = userEvent.setup();
    const assets = [
      makeAsset(),
      makeAsset({ productId: "beta", outputPath: "beta/1x1.png" }),
      makeAsset({ productId: "gamma", outputPath: "gamma/1x1.png" }),
    ];
    seedDecisions({ "alpha/1:1/default": "approved", "beta/1:1/default": "rejected" });
    seedPersistedRun(assets);
    const bodies: unknown[] = [];
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packagePost: (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return json({ platforms: [] });
      },
    });
    renderWithRun(<ExportPage />);
    await user.click(await screen.findByRole("button", { name: "Package" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      campaignId: "seed",
      platforms: ["instagram-feed"],
      include: ["alpha/1:1/default"],
    });
  });

  test("omits include when the reviewer has not decided anything", async () => {
    const user = userEvent.setup();
    const assets = [makeAsset()];
    seedPersistedRun(assets);
    const bodies: unknown[] = [];
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packagePost: (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return json({ platforms: [] });
      },
    });
    renderWithRun(<ExportPage />);
    await user.click(await screen.findByRole("button", { name: "Package" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ campaignId: "seed", platforms: ["instagram-feed"] });
  });

  test("surfaces a package error", async () => {
    const user = userEvent.setup();
    const assets = [makeAsset()];
    seedPersistedRun(assets);
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packagePost: () => json({ error: "Campaign report not found" }, 404),
    });
    renderWithRun(<ExportPage />);
    await user.click(await screen.findByRole("button", { name: "Package" }));
    expect(await screen.findByText("Campaign report not found")).toBeTruthy();
  });

  test("shows Packaging… while the POST is in flight", async () => {
    const user = userEvent.setup();
    const assets = [makeAsset()];
    seedPersistedRun(assets);
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packagePost: () => new Promise<Response>(() => {}),
    });
    renderWithRun(<ExportPage />);
    await user.click(await screen.findByRole("button", { name: "Package" }));
    expect(await screen.findByText("Packaging…")).toBeTruthy();
  });

  test("hydrates from GET /campaigns/packages on mount", async () => {
    seedPersistedRun([makeAsset()]);
    mockPipelineApi({
      report: {
        halted: false,
        assets: [makeAsset()],
        log: { entries: [], campaignId: "seed" },
      },
      packages: () =>
        json({
          platforms: [
            {
              platformId: "instagram-feed",
              items: [item()],
            },
          ],
        }),
    });
    renderWithRun(<ExportPage />);
    expect(await screen.findByText("PASS")).toBeTruthy();
    expect(screen.getByText("packages/seed/instagram-feed/alpha/1x1.png")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download zip" }).getAttribute("href")).toBe(
      `${API}/campaigns/packages/seed/instagram-feed.zip`,
    );
  });

  test("the zip link keys off the campaign the run ran under, not the shell brief (R6)", async () => {
    const user = userEvent.setup();
    // The shell still holds its own brief; the run on screen came from the draft.
    mockPipelineApi({
      report: {
        halted: false,
        assets: [makeAsset()],
        log: { entries: [], campaignId: "on-screen-draft" },
      },
      packages: () => json({ platforms: [] }, 404),
      packagePost: () =>
        json({
          platforms: [
            {
              platformId: "instagram-feed",
              items: [
                item({ packagedPath: "packages/on-screen-draft/instagram-feed/alpha/1x1.png" }),
              ],
            },
          ],
        }),
    });
    renderWithRun(
      <>
        <RunDraft />
        <ExportPage />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "run draft" }));
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Package" }));
    expect(
      await screen.findByText("packages/on-screen-draft/instagram-feed/alpha/1x1.png"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download zip" }).getAttribute("href")).toBe(
      `${API}/campaigns/packages/on-screen-draft/instagram-feed.zip`,
    );
  });
});

describe("ExportPage — motion", () => {
  test("approved motion rows show the duration and link the mp4; motion platforms join the picker", async () => {
    const user = userEvent.setup();
    seedDecisions({ "alpha/v1": "approved", "alpha/v2": "approved" });
    const assets = [
      makeMotionAsset(),
      makeMotionAsset({
        variantIndex: 2,
        outputPath: "alpha/9x16/v2.png",
        videoPath: "alpha/9x16/v2.mp4",
        durationSec: undefined,
      }),
    ].map((asset) => ({ ...asset, ...s3Urls(asset) }));
    seedPersistedRun(assets);
    mockPipelineApi({
      report: { halted: false, assets, log: { entries: [], campaignId: "seed" } },
      packages: () => json({ platforms: [] }, 404),
      packagePost: () =>
        json({
          platforms: [
            {
              platformId: "instagram-reel",
              items: [
                item({
                  aspectRatio: "9:16",
                  treatment: "headline-top-bold",
                  format: "motion",
                  source: "alpha/9x16/v1.mp4",
                  packagedPath: "packages/seed/instagram-reel/alpha/9x16/v1.mp4",
                  posterPath: "packages/seed/instagram-reel/alpha/9x16/v1.png",
                  durationSec: 6,
                  checks: { size: "pass", duration: "fail" },
                }),
                item({
                  aspectRatio: "9:16",
                  treatment: "headline-top-bold",
                  format: "motion",
                  source: "alpha/9x16/v2.mp4",
                  packagedPath: "packages/seed/instagram-reel/alpha/9x16/v2.mp4",
                  checks: { size: "pass", duration: "pass" },
                }),
              ],
            },
          ],
        }),
    });
    renderWithRun(<ExportPage />);
    expect(await screen.findByText("alpha @ 9:16 · v1 · headline-top-bold · 6s")).toBeTruthy();
    expect(screen.getByText("alpha @ 9:16 · v2 · headline-top-bold")).toBeTruthy();
    expect(screen.getByText("alpha/9x16/v1.mp4 · poster alpha/9x16/v1.png")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Download .MP4" });
    expect(links[0].getAttribute("href")).toBe(assets[0]!.videoDownloadUrl);
    expect(screen.queryByRole("link", { name: "Download .PNG" })).toBeNull();

    for (const id of ["instagram-story", "instagram-reel", "tiktok", "youtube-short"]) {
      expect(screen.getByRole("button", { name: id, pressed: false })).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "instagram-reel" }));
    await user.click(screen.getByRole("button", { name: "Package" }));
    expect(await screen.findByText("packages/seed/instagram-reel/alpha/9x16/v1.mp4")).toBeTruthy();
    expect(screen.getByText("alpha @ 9:16 · headline-top-bold · 6s")).toBeTruthy();
    expect(screen.getByText("alpha @ 9:16 · headline-top-bold")).toBeTruthy();
    expect(screen.getAllByTitle("duration").map((b) => b.textContent)).toEqual(["FAIL", "PASS"]);
    expect(screen.getAllByTitle("size").every((b) => b.textContent === "PASS")).toBe(true);
  });

  test("a static-only run keeps motion platforms out of the picker", async () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "instagram-reel" })).toBeNull();
  });

  test("a run switch that hides the selected motion platform drops the selection and disables Package", async () => {
    const user = userEvent.setup();
    const motionRun = {
      halted: false,
      assets: [makeMotionAsset()],
      log: { entries: [], campaignId: "seed" },
    };
    const staticRun = {
      halted: false,
      assets: [makeAsset()],
      log: { entries: [], campaignId: "other" },
    };
    seedPersistedRun(motionRun.assets);
    const bodies: unknown[] = [];
    mockPipelineApi({
      result: (url) => json(url.includes("campaignId=other") ? staticRun : motionRun),
      packages: () => json({ platforms: [] }, 404),
      packagePost: (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return json({ platforms: [] });
      },
    });
    renderWithRun(
      <>
        <ExportPage />
        <SwitchToOther />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "instagram-reel" }));
    expect(screen.getByRole("button", { name: "instagram-reel", pressed: true })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "switch run" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "instagram-reel" })).toBeNull(),
    );
    // No visible platform is selected any more.
    for (const id of ["instagram-feed", "linkedin", "x"]) {
      expect(screen.getByRole("button", { name: id, pressed: false })).toBeTruthy();
    }
    const packageButton = screen.getByRole("button", { name: "Package" }) as HTMLButtonElement;
    expect(packageButton.disabled).toBe(true);
    expect(packageButton.title).toBe("Select a platform first");
    await user.click(packageButton);
    expect(bodies).toEqual([]);

    // Picking a visible platform re-enables packaging for exactly that platform.
    await user.click(screen.getByRole("button", { name: "linkedin" }));
    await user.click(screen.getByRole("button", { name: "Package" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ campaignId: "other", platforms: ["linkedin"] });
  });
});

/**
 * The control-boundary token (WCAG 1.4.11): these controls are identified only by
 * their hairline, so it must be `border-border-control` (≥ 3:1 on every ground).
 * jsdom applies no CSS, so the class list is the only observable — split, because
 * `border-border` is a substring of `border-border-control`.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("ExportPage — control boundaries carry border-control", () => {
  test("the unfilled platform pill and the disabled download hint keep the ≥3:1 hairline", async () => {
    seedPersistedRun([makeAsset()]);
    mockPipelineApi({
      report: { halted: false, assets: [makeAsset()], log: { entries: [], campaignId: "seed" } },
      packages: () => json({ platforms: [] }, 404),
    });
    renderWithRun(<ExportPage />);
    expect(await screen.findByRole("group", { name: "Platforms" })).toBeTruthy();

    // Unselected pill: no fill, the hairline is the entire control.
    const pill = screen.getByRole("button", { name: "linkedin", pressed: false });
    expect(classes(pill)).toContain("border-border-control");
    expect(classes(pill)).not.toContain("border-border");
    // The selected arm keeps the brand token instead.
    const selected = screen.getByRole("button", { name: "instagram-feed", pressed: true });
    expect(classes(selected)).toContain("border-brand-primary");

    // Download hint: a pill with a disabled arm, still a control boundary.
    const download = screen.getByRole("button", { name: "Download zip" });
    expect(classes(download)).toContain("border-border-control");
    expect(classes(download)).not.toContain("border-border");
  });
});

/**
 * D204/D212: every export row links the server's own field, read exactly.
 *
 * **Both backends, exact equality.** `s3Urls` is cross-origin, so its download fields
 * differ from its display ones by the signed disposition — which is the only thing that
 * makes the pair distinguishable at all. `fsUrls` is the same-origin shape where D212
 * says the two are the SAME string, so it proves the code reads the FIELD rather than
 * merely building something plausible. Never `toContain`: a URL that mentions the path
 * is the old client-built defect wearing a new signature.
 */
describe("ExportPage — every row href is the server's field (D204/D212)", () => {
  const BACKENDS = [
    ["s3", s3Urls],
    ["fs", fsUrls],
  ] as const;

  /** The row whose sub-line names `path` — the row this assertion is about. */
  const rowFor = (path: string): HTMLElement =>
    screen.getByText(path).parentElement?.parentElement as HTMLElement;

  test("the proof, MP4 and PNG rows link proofUrl, videoDownloadUrl and outputDownloadUrl", async () => {
    for (const [backend, urls] of BACKENDS) {
      const still = makeAsset();
      const motion = makeMotionAsset({ variantIndex: 2 });
      seedDecisions({ "alpha/1:1/default": "approved", "alpha/v2": "approved" });
      seedPersistedRun([
        { ...still, ...urls(still) },
        { ...motion, ...urls(motion) },
      ]);
      const { unmount } = renderWithRun(<ExportPage />);
      await screen.findByText(/2 of 2 creatives approved/);
      expect(rowFor("proofs/alpha.pdf").textContent, backend).toContain("alpha");
      expect(
        within(rowFor("proofs/alpha.pdf")).getByRole("link").getAttribute("href"),
        backend,
      ).toBe(urls(still).proofUrl);
      expect(
        within(rowFor("alpha/9x16/v1.mp4 · poster alpha/9x16/v1.png"))
          .getByRole("link")
          .getAttribute("href"),
        backend,
      ).toBe(urls(motion).videoDownloadUrl);
      expect(within(rowFor("alpha/1x1.png")).getByRole("link").getAttribute("href"), backend).toBe(
        urls(still).outputDownloadUrl,
      );
      unmount();
    }
  });

  test("under s3 each download href is provably not the display URL it sits beside", async () => {
    const base = makeAsset();
    const still = { ...base, ...s3Urls(base) };
    seedDecisions({ "alpha/1:1/default": "approved" });
    seedPersistedRun([still]);
    renderWithRun(<ExportPage />);
    await screen.findByText(/1 of 1 creatives approved/);
    const href = (row: HTMLElement) => within(row).getByRole("link").getAttribute("href");
    const png = href(rowFor("alpha/1x1.png"));
    const proof = href(rowFor("proofs/alpha.pdf"));
    // The fixture's own pair differs by the disposition, so the distinction is real
    // rather than a coincidence — a consumer that reached for `outputUrl` for the PNG
    // download, or for a display URL for the proof, fails here on `toBe`.
    expect(still.outputDownloadUrl).not.toBe(still.outputUrl);
    expect(png).not.toBe(still.outputUrl);
    expect(proof).not.toBe(still.outputUrl);
    expect(png).toContain("response-content-disposition");
  });

  test("two approved rows sharing one proofPath are one row, linking the first usable proofUrl", async () => {
    // The dedupe keys on `proofPath`, not on the URL: the two rows are the same PDF, so
    // either signature fetches the same bytes and only one row belongs in the queue.
    const first = makeAsset({ variantIndex: 0, treatment: "default" });
    const second = makeAsset({
      variantIndex: 1,
      treatment: "other",
      outputPath: "alpha/1x1/second.png",
    });
    seedDecisions({ "alpha/v0": "approved", "alpha/v1": "approved" });
    seedPersistedRun([
      { ...first, ...s3Urls(first) },
      // The second row carries NO proofUrl: the row must keep the first usable one
      // rather than fall back to a path or drop the link entirely.
      { ...second, proofUrl: undefined },
    ]);
    renderWithRun(<ExportPage />);
    await screen.findByText(/2 of 2 creatives approved/);
    expect(screen.getByText("Proof PDFs (1)")).toBeTruthy();
    const proof = within(rowFor("proofs/alpha.pdf")).getByRole("link");
    expect(proof.getAttribute("href")).toBe(s3Urls(first).proofUrl);
  });

  test("the packages zip is the route URL, and stays it beside signed assets (PT-4h owns it)", async () => {
    // Not this lane's field, and deliberately unchanged: the zip is served by the API's
    // own route under every backend, so its href must not become a signed asset URL.
    const user = userEvent.setup();
    const base = makeAsset();
    const still = { ...base, ...s3Urls(base) };
    seedDecisions({ "alpha/1:1/default": "approved" });
    const seeded = seedPersistedRun([still]);
    mockPipelineApi({
      opened: seeded,
      report: { halted: false, assets: [still], log: { entries: [], campaignId: "seed" } },
      packages: () => json({ platforms: [] }, 404),
      packagePost: () => json({ platforms: [{ platformId: "instagram-feed", items: [item()] }] }),
    });
    renderWithRun(<ExportPage />);
    await user.click(await screen.findByRole("button", { name: "Package" }));
    const zip = await screen.findByRole("link", { name: "Download zip" });
    expect(zip.getAttribute("href")).toBe(`${API}/campaigns/packages/seed/instagram-feed.zip`);
    for (const url of Object.values(s3Urls(still))) {
      expect(zip.getAttribute("href")).not.toBe(url);
    }
  });

  test("with no *Url at all every row says Unavailable and keeps its label and path", async () => {
    // `makeAsset` carries paths and no URLs: the shape of a run committed from a job
    // payload, which the jobs route answers with paths and signs nothing (D213). The
    // rows must say so — and must not link anything, because an `<a>` with no `href`
    // navigates the page instead of naming what is missing.
    const still = makeAsset();
    const motion = makeMotionAsset();
    seedDecisions({ "alpha/1:1/default": "approved", "alpha/v1": "approved" });
    seedPersistedRun([still, motion]);
    const { container } = renderWithRun(<ExportPage />);
    await screen.findByText(/2 of 2 creatives approved/);
    const unavailable = screen.getAllByTestId("download-unavailable");
    // One per row: the proof, the MP4 and the PNG.
    expect(unavailable).toHaveLength(3);
    expect(unavailable.every((el) => el.textContent === "Unavailable")).toBe(true);
    expect(screen.queryByRole("link", { name: "Download .PDF" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download .MP4" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download .PNG" })).toBeNull();
    // The labels and paths survive: the creative IS approved and the path is real.
    expect(screen.getByText("alpha/1x1.png")).toBeTruthy();
    expect(screen.getByText("alpha/9x16/v1.mp4 · poster alpha/9x16/v1.png")).toBeTruthy();
    expect(screen.getByText("proofs/alpha.pdf")).toBeTruthy();
    for (const el of container.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain("/output/");
      }
    }
  });
});

/**
 * PT-4g3 fix 1 (F4) — a signed-URL refresh must not refetch the package manifests.
 *
 * **The export page calls `loadPackages` from an effect keyed on its identity**
 * (`export/page.tsx`: `useEffect(() => { void loadPackages(); }, [loadPackages])`).
 * Memoised on `[brief.id, run]`, a same-report refresh gives that callback a new identity
 * every four minutes — so the URL refreshing that keeps the grid's images alive also
 * re-downloaded every stored package manifest for the campaign, forever, while the page
 * sat there. `loadPackages` is now keyed on what it actually READS (`run?.target.id`).
 */
describe("ExportPage — a signed-URL refresh does not refetch packages (PT-4g3 F4)", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  /**
   * The two ids whose disagreement is the whole point: the campaign the SHELL holds
   * (`brief.id`) and the campaign the RUN on screen was written under (`ranCampaignId`).
   * A "Run this draft" run is the only way they differ, and it is the only way a
   * `[brief.id]` keying could satisfy the no-refetch assertion below while dropping the
   * package manifests for the campaign actually on screen.
   */
  let ids: { briefId: string; ranCampaignId: string | null } = { briefId: "", ranCampaignId: null };
  function ObserveIds() {
    const { brief, ranCampaignId } = useRun();
    // In an EFFECT, not in the render body: this must record what React COMMITTED, and a
    // render-phase assignment can leave a value from a pass that was thrown away.
    useEffect(() => {
      ids = { briefId: brief.id, ranCampaignId };
    }, [brief.id, ranCampaignId]);
    return null;
  }

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await advance(0);
  };
  const packageReadsFor = (campaignId: string) =>
    vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([u]) =>
        String(u).includes(`/campaigns/packages/${encodeURIComponent(campaignId)}`),
      ).length;
  const packageReads = () =>
    vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([u]) => String(u).includes("/campaigns/packages")).length;

  test("one refresh, zero package reads — and a draft run still re-lists them", async () => {
    vi.useFakeTimers();
    const row = makeAsset({ productId: "alpha", outputPath: "alpha/1x1.png" });
    const seeded = seedPersistedRun([row]);
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      packages: (url) =>
        json({
          platforms: [
            {
              platformId: `p${url.includes("on-screen-draft") ? "draft" : "seed"}`,
              items: [item()],
            },
          ],
        }),
      post: () => json({ jobId: "job-1" }, 202),
      job: () =>
        jobOk({
          halted: false,
          assets: [row],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
      result: (url) => {
        // The draft run's own re-read, keyed on the campaign the POST actually ran.
        if (url.includes("campaignId=on-screen-draft")) {
          return json({
            halted: false,
            assets: [{ ...row, ...s3Urls(row, "rev-draft") }],
            log: { entries: [], campaignId: "on-screen-draft" },
          });
        }
        if (!url.includes("/campaigns/result")) return json({ halted: false, assets: [] });
        read += 1;
        return json({
          halted: false,
          assets: [{ ...row, ...s3Urls(row, read === 1 ? "rev-1" : "rev-2") }],
          log: { entries: [], campaignId: "seed" },
        });
      },
    });
    renderWithRun(
      <>
        <RunDraft />
        <ObserveIds />
        <ExportPage />
      </>,
    );
    await settle();
    // The page hydrated once, which is the read this test measures everything else against.
    const baseline = packageReads();
    // Counted per campaign, because the mount also asks once with no run on screen at
    // all (`run?.target.id ?? brief.id`, and there is neither yet) — so the TOTAL is not a
    // per-campaign figure, and "no new reads for the shell's campaign" has to be said
    // about that campaign alone.
    const seedBaseline = packageReadsFor("seed");
    expect(baseline).toBeGreaterThan(seedBaseline);

    // Three refresh ticks: a new callback identity each time under the old keying.
    await advance(URL_REFRESH_MS);
    await advance(URL_REFRESH_MS);
    await advance(URL_REFRESH_MS);
    expect(read).toBeGreaterThan(1);
    expect(packageReads()).toBe(baseline);

    // **And the case `run?.target.id` exists for.** "Run this draft" commits a run whose
    // target is the DRAFT's campaign while `brief.id` stays `seed` — the only way the two
    // ids can disagree, and the only way a `[brief.id]` keying could pass the assertions
    // above while dropping the package manifests for the campaign actually on screen.
    expect(ids.briefId).toBe("seed");
    await act(async () => {
      screen.getByText("run draft").click();
    });
    await settle();
    expect(ids.briefId).toBe("seed");
    expect(ids.ranCampaignId).toBe("on-screen-draft");
    // The manifests come back FOR THE DRAFT'S CAMPAIGN — stated first, because it is the
    // assertion that distinguishes `run?.target.id` from `brief.id`, and a `[brief.id]`
    // keying makes no request at all rather than a differently-targeted one. Then the
    // total, and the shell's own campaign, which `brief.id` never moved away from.
    expect(packageReadsFor("on-screen-draft")).toBeGreaterThan(0);
    expect(packageReads()).toBeGreaterThan(baseline);
    expect(packageReadsFor("seed")).toBe(seedBaseline);
  });
});
