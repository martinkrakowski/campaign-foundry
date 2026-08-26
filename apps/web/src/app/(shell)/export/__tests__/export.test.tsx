import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, makeAsset, json, mockPipelineApi } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import ExportPage from "../page";

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
  test("shows static platform tabs, packages the selected tab, and links the zip", async () => {
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
    expect(await screen.findByRole("tablist", { name: "Platforms" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "instagram-feed" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "linkedin" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "x" })).toBeTruthy();
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
    await user.click(screen.getByRole("tab", { name: "linkedin" }));
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
