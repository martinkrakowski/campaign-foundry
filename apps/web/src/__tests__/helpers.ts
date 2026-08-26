import { render, fireEvent } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { vi, type Mock } from "vitest";
import { RunProvider, type Asset } from "@/lib/run-context";

/**
 * Drive a modal's focus trap through every branch: forward-Tab wrap from the last
 * focusable, backward shift+Tab wrap from the first, and a non-Tab key (early return).
 */
export const exerciseFocusTrap = (dialog: HTMLElement) => {
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])'),
  ];
  // Focus every element and tab both ways, so the forward-wrap (at the last element)
  // and backward-wrap (at the first) both fire regardless of selector ordering.
  for (const el of focusables) {
    el.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    el.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  }
  fireEvent.keyDown(window, { key: "x" }); // non-Tab, non-Escape → early return
};

/** Render a UI tree wrapped in the shared RunProvider. */
export const renderWithRun = (ui: ReactElement) => render(createElement(RunProvider, null, ui));

export const makeAsset = (over: Partial<Asset> = {}): Asset => ({
  productId: "alpha",
  aspectRatio: "1:1",
  outputPath: "alpha/1x1.png",
  proofPath: "proofs/alpha.pdf",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  treatment: "default",
  backgroundSource: "procedural",
  ...over,
});

/**
 * Seed a persisted run that RunProvider restores on mount: stores a brief (so the
 * picker won't auto-open) and points the default fetch at a report with `assets`.
 */
export const seedPersistedRun = (assets: Asset[], opts: { halted?: boolean; id?: string } = {}) => {
  const id = opts.id ?? "seed";
  localStorage.setItem("cf:brief-picked", "1");
  localStorage.setItem(
    "cf:brief",
    JSON.stringify({
      id,
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Stay wild",
      localizedMessage: "Bleib wild",
      products: [
        { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
        { id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: "b.png" },
      ],
    }),
  );
  const report = { halted: opts.halted ?? false, assets, log: { entries: [], campaignId: id } };
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const headers = { "content-type": "application/json" };
    if ((init as RequestInit | undefined)?.method === "POST") {
      return new Response(JSON.stringify({ jobId: "seed-job" }), { status: 202, headers });
    }
    if (String(url).includes("/campaigns/jobs/")) {
      return new Response(
        JSON.stringify({ status: "completed", done: assets.length, total: assets.length, log: report.log, result: report }),
        { status: 200, headers },
      );
    }
    return new Response(JSON.stringify(report), { status: 200, headers });
  });
};

interface NextControls {
  nav: { pathname: string };
  router: Record<string, Mock>;
  redirect: Mock;
}

/** The controllable next/navigation mocks exposed by vitest.setup.ts. */
export const nextMock = (): NextControls =>
  (globalThis as unknown as { __next: NextControls }).__next;
