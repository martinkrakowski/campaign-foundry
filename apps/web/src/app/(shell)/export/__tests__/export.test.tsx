import { describe, test, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
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
    const zip = screen.getByText("Download zip") as HTMLAnchorElement;
    expect(zip.getAttribute("href")).toBe(`${API}/campaigns/packages/seed/instagram-feed.zip`);

    await user.click(screen.getByRole("button", { name: "Package" }));
    expect(await screen.findByText("packages/seed/instagram-feed/alpha/1x1.png")).toBeTruthy();
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText("FAIL")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "linkedin" }));
    expect((screen.getByText("Download zip") as HTMLAnchorElement).getAttribute("href")).toBe(
      `${API}/campaigns/packages/seed/linkedin.zip`,
    );
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
  });
});
