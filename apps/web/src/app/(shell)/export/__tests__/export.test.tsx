import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, makeAsset, makeMotionAsset, json, mockPipelineApi } from "@/__tests__/helpers";
import { API, useRun } from "@/lib/run-context";
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
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "approved" }));
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
              items: [item(), item({ productId: "beta", checks: { size: "fail" }, packagedPath: "packages/seed/instagram-feed/beta/1x1.png" })],
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
    expect((screen.getByRole("button", { name: "Download zip" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("sends the approved asset keys as include, and omits include with no decisions", async () => {
    const user = userEvent.setup();
    const assets = [
      makeAsset(),
      makeAsset({ productId: "beta", outputPath: "beta/1x1.png" }),
      makeAsset({ productId: "gamma", outputPath: "gamma/1x1.png" }),
    ];
    localStorage.setItem(
      "cf:decisions",
      JSON.stringify({ "alpha/1:1/default": "approved", "beta/1:1/default": "rejected" }),
    );
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
});

describe("ExportPage — motion", () => {
  test("approved motion rows show the duration and link the mp4; motion platforms join the picker", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/v1": "approved", "alpha/v2": "approved" }));
    const assets = [makeMotionAsset(), makeMotionAsset({ variantIndex: 2, outputPath: "alpha/9x16/v2.png", videoPath: "alpha/9x16/v2.mp4", durationSec: undefined })];
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
    expect(links[0].getAttribute("href")).toBe(`${API}/output/alpha/9x16/v1.mp4`);
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
    const motionRun = { halted: false, assets: [makeMotionAsset()], log: { entries: [], campaignId: "seed" } };
    const staticRun = { halted: false, assets: [makeAsset()], log: { entries: [], campaignId: "other" } };
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
    await waitFor(() => expect(screen.queryByRole("button", { name: "instagram-reel" })).toBeNull());
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
