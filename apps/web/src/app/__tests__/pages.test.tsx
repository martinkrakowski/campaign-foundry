import { describe, test, expect, afterEach, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithRun,
  seedPersistedRun,
  makeAsset,
  seedDecisions,
  nextMock,
  mockPipelineApi,
  jobOk,
  json,
  s3Urls,
  EMPTY_REPORT,
} from "@/__tests__/helpers";
import { API, useRun } from "@/lib/run-context";
import { Header } from "@/components/shell/Header";
import * as messages from "@/components/campaign/messages";
import CompliancePage from "@/app/(shell)/compliance/page";
import GridPage from "@/app/(shell)/grid/page";
import ExportPage from "@/app/(shell)/export/page";
import RunsPage from "@/app/(shell)/runs/page";
import IndexPage from "@/app/page";

describe("IndexPage", () => {
  test("redirects to the grid", () => {
    IndexPage();
    expect(nextMock().redirect).toHaveBeenCalledWith("/grid");
  });
});

describe("CompliancePage — occlusion advisories (D136)", () => {
  test("an advisory gets its own row, labelled Layer Order, beside the density row", async () => {
    seedPersistedRun([
      makeAsset({ occlusionAdvisories: ["Shade sits above Static text and mutes it."] }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Shade sits above Static text/)).toBeTruthy();
    // Its own row and its own rule name: the density verdict and the layer
    // finding are different checks with different verdicts, on one surface.
    expect(screen.getByText(messages.complianceRuleLayerOrder)).toBeTruthy();
    expect(screen.getByText(messages.complianceRuleBrandDensity)).toBeTruthy();
  });

  test("an advisory reads ADVISORY, never FAIL (D135)", async () => {
    seedPersistedRun([
      makeAsset({
        passedCompliance: true,
        logoApplied: true,
        occlusionAdvisories: ["Shade sits above Static text and mutes it."],
      }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toBeTruthy();
    // D135: a reorder that hides or mutes a layer warns and never refuses.
    // The density row beside it is still a PASS, so the advisory cannot be
    // read as a gate the operator has to clear.
    expect(screen.getByText(messages.COMPLIANCE_GATE_LABEL.pass)).toBeTruthy();
    expect(screen.queryByText(messages.COMPLIANCE_GATE_LABEL.fail)).toBeNull();
  });

  test("two advisories on one asset are two rows", async () => {
    seedPersistedRun([makeAsset({ occlusionAdvisories: ["First finding.", "Second finding."] })]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText("First finding.")).toBeTruthy();
    expect(screen.getByText("Second finding.")).toBeTruthy();
    expect(screen.getAllByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toHaveLength(2);
  });

  test("an asset with no advisory adds no row", async () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(messages.complianceRuleBrandDensity)).toBeTruthy();
    expect(screen.queryByText(messages.complianceRuleLayerOrder)).toBeNull();
    expect(screen.queryByText(messages.COMPLIANCE_GATE_LABEL.advisory)).toBeNull();
  });
});

describe("CompliancePage", () => {
  test("shows the awaiting state with no run", async () => {
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Awaiting pipeline execution/)).toBeTruthy();
  });

  test("the group label and table headers render through Eyebrow on the token", async () => {
    renderWithRun(<CompliancePage />);
    const label = await screen.findByText("Compliance");
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toContain("tracking-eyebrow");
    expect(label.className).not.toContain("tracking-widest");
    // the headers stay real <th> cells — Eyebrow renders through them, not inside them
    for (const header of ["Asset Target", "Rule Engine", "Telemetry Result", "Gate Status"]) {
      const th = screen.getByText(header);
      expect(th.tagName).toBe("TH");
      expect(th.className).toContain("tracking-eyebrow");
      expect(th.className).toContain("font-normal");
      expect(th.className).not.toContain("tracking-widest");
    }
  });

  test("renders a row per asset with pass/fail gates", async () => {
    seedPersistedRun([
      makeAsset({ passedCompliance: true, logoApplied: true }),
      makeAsset({
        productId: "beta",
        aspectRatio: "9:16",
        passedCompliance: false,
        logoApplied: false,
      }),
    ]);
    renderWithRun(<CompliancePage />);
    await waitFor(() => expect(screen.getAllByText(/Brand-colour density/)).toHaveLength(2));
    expect(screen.getByText(messages.COMPLIANCE_GATE_LABEL.pass)).toBeTruthy();
    expect(screen.getByText("FAIL")).toBeTruthy();
  });

  test("variation rows include v<index> in the asset target", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
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
    seedDecisions({ "alpha/1:1/default": "approved" });
    seedPersistedRun([
      makeAsset(),
      makeAsset({ productId: "beta", outputPath: "beta/1x1.png", proofPath: "proofs/beta.pdf" }),
    ]);
    renderWithRun(<ExportPage />);
    await waitFor(() => expect(screen.getByText(/1 of 2 creatives approved/)).toBeTruthy());
    expect(screen.getByText("proofs/alpha.pdf")).toBeTruthy();
  });

  test("variation labels include v<index>", async () => {
    seedDecisions({ "alpha/v4": "approved" });
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<ExportPage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
  });
});

/**
 * D213 + D212, on both consumer pages at once: when the run the shell commits is the
 * JOB payload, the grid shows the placeholder and the export rows say Unavailable.
 *
 * **This is the degraded state the whole change is about.** `withAssetUrls` runs on
 * `result.get` alone, so a payload from the jobs route has no URL to render and none to
 * link — that route answers the stored report exactly as it is. The one thing neither
 * page may do is answer for the server: a client-built output path 404s under `s3` and
 * retires in PT-4i.
 *
 * The fixture is the REAL degradation and not a hand-stripped one. The mount restore
 * reads `result.get` and gets signed URLs, so the pages first render real images; then
 * Generate goes out, its re-read FAILS — the branch D213 defines as "commit the job
 * payload" — and `jobOk` applies the jobs route's own `stripAssetUrls` to what the
 * shell then commits. So the placeholder appears because the server said nothing, not
 * because a fixture was written to be empty.
 */
describe("GridPage + ExportPage — a run committed from a job payload", () => {
  function Generate() {
    const { execute } = useRun();
    return (
      <button type="button" onClick={() => void execute()}>
        generate
      </button>
    );
  }

  /** The job payload's row: paths only, because `jobOk` strips every `*Url` from it. */
  const base = makeAsset();
  const signed = { ...base, ...s3Urls(base) };
  // A seeded run whose re-read fails once the generate POST has gone out. The mount
  // restore's own read still answers, so the pages first render the signed URLs.
  const seedRunWhoseRereadFails = () => {
    const seeded = seedPersistedRun([signed]);
    let posted = false;
    mockPipelineApi({
      opened: seeded,
      report: { halted: false, assets: [signed], log: { entries: [], campaignId: "seed" } },
      post: () => {
        posted = true;
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [base], log: { entries: [], campaignId: "seed" } }),
      result: () =>
        posted
          ? json({ error: "boom" }, 500)
          : json({ halted: false, assets: [signed], log: { entries: [], campaignId: "seed" } }),
    });
  };
  seedRunWhoseRereadFails();

  test("the grid shows the placeholder and the export rows say Unavailable", async () => {
    const user = userEvent.setup();
    seedRunWhoseRereadFails();
    const { container } = renderWithRun(
      <>
        <Generate />
        <GridPage />
        <ExportPage />
      </>,
    );

    // Before the run the persisted report's signed URLs are what both pages render…
    expect(
      (await screen.findByRole("img", { name: "alpha @ 1:1 · default" })).getAttribute("src"),
    ).toContain("https://objects.example/");
    expect(screen.getByRole("link", { name: "Download .PNG" }).getAttribute("href")).toContain(
      "https://objects.example/",
    );

    // …and after it, the committed job payload carries none.
    await user.click(screen.getByText("generate"));
    expect(await screen.findByTestId("asset-unavailable")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    // The grid has no download link at all — not one that would navigate to nothing.
    expect(screen.queryByRole("link", { name: "Download .PNG" })).toBeNull();
    for (const el of container.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain("/output/");
    }

    // The reviewer can still review it: the cell renders, with its placeholder, so the
    // creative can be approved — and THAT is how an approved row arrives at the export
    // page with no URL to link.
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getAllByTestId("download-unavailable")).toHaveLength(2));
    // The rows keep their label and path: the creative IS approved and the path is
    // real — what is missing is a way to fetch it.
    expect(screen.getByText("alpha/1x1.png")).toBeTruthy();
    expect(screen.getByText("proofs/alpha.pdf")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download .PDF" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download .PNG" })).toBeNull();
  });
});

describe("RunsPage", () => {
  test("shows the no-runs state initially", async () => {
    renderWithRun(<RunsPage />);
    expect(await screen.findByText(/No runs yet/)).toBeTruthy();
  });

  test("summarizes a completed run", async () => {
    seedDecisions({ "alpha/1:1/default": "approved", "beta/1:1/default": "rejected" });
    seedPersistedRun([
      makeAsset({ passedCompliance: true }),
      makeAsset({ productId: "beta", passedCompliance: false }),
    ]);
    renderWithRun(<RunsPage />);
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    expect(screen.getByText("seed")).toBeTruthy();
    expect(screen.getByText("alpha @ 1:1 · default")).toBeTruthy();
    // The review counts are the server's decisions, once they load (D173).
    await waitFor(() =>
      expect(screen.getByText("Pending review").parentElement?.textContent).toMatch(/0/),
    );
    expect(screen.getByText("Approved").parentElement?.textContent).toMatch(/1/);
    expect(screen.getByText("Rejected").parentElement?.textContent).toMatch(/1/);
  });

  test("variation rows include v<index> in the run asset list", async () => {
    seedPersistedRun([
      makeAsset({
        variantIndex: 4,
        treatment: "headline-top-bold",
        outputPath: "alpha/1x1/v4.png",
      }),
    ]);
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("alpha @ 1:1 · v4 · headline-top-bold")).toBeTruthy();
  });

  test("shows policyHash and seed when present on the run result", async () => {
    seedPersistedRun([makeAsset()], { policyHash: "abc123def", seed: 42 });
    renderWithRun(<RunsPage />);
    await waitFor(() => expect(screen.getByText("abc123def")).toBeTruthy());
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("Policy hash")).toBeTruthy();
    expect(screen.getByText("Seed")).toBeTruthy();
  });

  test("shows policyHash alone when seed is absent", async () => {
    seedPersistedRun([makeAsset()], { policyHash: "only-hash" });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("only-hash")).toBeTruthy();
    expect(screen.queryByText("Seed")).toBeNull();
  });

  test("shows seed alone when policyHash is absent", async () => {
    seedPersistedRun([makeAsset()], { seed: 7 });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.getByText("Seed")).toBeTruthy();
    expect(screen.queryByText("Policy hash")).toBeNull();
  });

  test("shows the halted badge for a halted run", async () => {
    seedPersistedRun([], { halted: true });
    renderWithRun(<RunsPage />);
    expect(await screen.findByText("halted")).toBeTruthy();
  });
});

describe("the shell pages carry ?campaign= (PT-5c3, D180)", () => {
  const UUID = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";
  const SLUG = "autumn-launch";

  afterEach(() => window.history.replaceState(null, "", "/grid"));

  /**
   * The page campaign's server. The run report keys by the SLUG and is served
   * ONLY under the uuid's query — the report's log.campaignId is a DIFFERENT
   * string from the page's query, so a page that fetched by the slug, or that
   * matched the report against the uuid, would show nothing.
   */
  const pageCampaignApi = () =>
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({ halted: false, assets: [makeAsset()], log: { entries: [], campaignId: SLUG } })
            : json(EMPTY_REPORT);
        }
        if (url === `${API}/campaigns/${UUID}`) {
          return json({
            campaignId: UUID,
            slug: SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          });
        }
        if (url.includes("/campaigns/briefs")) {
          return json({
            briefs: [
              {
                file: `${SLUG}.yaml`,
                campaignId: UUID,
                brief: {
                  id: SLUG,
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

  test("compliance loads from a uuid query whose report keys the slug, and the rows render", async () => {
    window.history.replaceState(null, "", `/compliance?campaign=${UUID}`);
    pageCampaignApi();
    renderWithRun(<CompliancePage />);
    expect(await screen.findByText(/Brand-colour density/)).toBeTruthy();
    expect(screen.getByText(messages.COMPLIANCE_GATE_LABEL.pass)).toBeTruthy();
  });

  test("export loads from a uuid query whose report keys the slug, and the renders list", async () => {
    window.history.replaceState(null, "", `/export?campaign=${UUID}`);
    seedDecisions({ "alpha/1:1/default": "approved" });
    pageCampaignApi();
    renderWithRun(<ExportPage />);
    await waitFor(() => expect(screen.getByText(/1 of 1 creatives approved/)).toBeTruthy());
    expect(screen.getByText("alpha/1x1.png")).toBeTruthy();
  });

  test("runs loads from a uuid query whose report keys the slug, and the summary renders", async () => {
    window.history.replaceState(null, "", `/runs?campaign=${UUID}`);
    pageCampaignApi();
    renderWithRun(<RunsPage />);
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    // The campaign the page loaded is the one the summary names.
    expect(screen.getByText(SLUG)).toBeTruthy();
    expect(screen.getByText("alpha @ 1:1 · default")).toBeTruthy();
  });

  test("the header tabs and the mobile menu carry the query, and the active tab is still marked", async () => {
    nextMock().nav.pathname = "/compliance";
    window.history.replaceState(null, "", `/compliance?campaign=${UUID}`);
    pageCampaignApi();
    const user = userEvent.setup();
    renderWithRun(
      <>
        <Header />
        <CompliancePage />
      </>,
    );
    // The query rides the HREF only; the active match stays on the path, so the
    // page the user is on keeps its tab even with the query present.
    const grid = await screen.findByRole("link", { name: "Grid" });
    await waitFor(() => expect(grid.getAttribute("href")).toBe(`/grid?campaign=${SLUG}`));
    const compliance = screen.getByRole("link", { name: "Compliance" });
    expect(compliance.getAttribute("href")).toBe(`/compliance?campaign=${SLUG}`);
    expect(compliance.getAttribute("aria-current")).toBe("page");
    expect(grid.getAttribute("aria-current")).toBeNull();

    await user.click(screen.getByLabelText("Open menu"));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const mobileGrid = within(dialog).getByRole("link", { name: "Grid" });
    expect(mobileGrid.getAttribute("href")).toBe(`/grid?campaign=${SLUG}`);
    const mobileCompliance = within(dialog).getByRole("link", { name: "Compliance" });
    expect(mobileCompliance.getAttribute("href")).toBe(`/compliance?campaign=${SLUG}`);
    expect(mobileCompliance.getAttribute("aria-current")).toBe("page");
    expect(mobileGrid.getAttribute("aria-current")).toBeNull();
  });
});

/**
 * PT-5e item 3 (D173, D180) — a BARE shell url follows the per-user
 * last-opened pointer: the campaign the user last had, in the URL, so the page
 * is shareable and a reload needs no memory of this browser. With no pointer
 * the visitor goes to the grid and is offered the picker, which is where a
 * campaign is chosen from.
 *
 * One test per bare URL, in both directions, because "each bare url redirects"
 * is only true if every one of them does it — a hook that only the grid calls
 * would pass any single assertion.
 */
describe("the bare shell urls follow the last-opened pointer (PT-5e)", () => {
  const UUID = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";

  afterEach(() => window.history.replaceState(null, "", "/grid"));

  /** The server holds this user's last-opened campaign, and nothing else. */
  const withPointer = () =>
    mockPipelineApi({
      opened: { id: UUID, brief: { id: UUID, products: [] } },
    });

  const bareUrls = [
    { path: "/grid", page: <GridPage /> },
    { path: "/export", page: <ExportPage /> },
    { path: "/runs", page: <RunsPage /> },
    { path: "/compliance", page: <CompliancePage /> },
  ] as const;

  test.each(bareUrls)("$path redirects to the last-opened campaign", async ({ path, page }) => {
    nextMock().nav.pathname = path;
    window.history.replaceState(null, "", path);
    withPointer();
    renderWithRun(page);
    await waitFor(() =>
      expect(nextMock().router.replace).toHaveBeenCalledWith(`${path}?campaign=${UUID}`),
    );
  });

  // `/grid` is the fallback itself and is covered by the test below; the other
  // three have somewhere to go.
  test.each(bareUrls.filter((u) => u.path !== "/grid"))(
    "$path falls back to the grid when there is no pointer",
    async ({ path, page }) => {
      nextMock().nav.pathname = path;
      window.history.replaceState(null, "", path);
      renderWithRun(page);
      await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/grid"));
    },
  );

  test("a bare /grid with no pointer stays put and opens the picker", async () => {
    // The grid IS the fallback, so it must not replace itself — a self-replace
    // re-runs the effect that issued it, and would fetch and replace forever.
    nextMock().nav.pathname = "/grid";
    window.history.replaceState(null, "", "/grid");
    const Probe = () => <span data-testid="picker">{String(useRun().briefPickerOpen)}</span>;
    renderWithRun(
      <>
        <GridPage />
        <Probe />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("picker").textContent).toBe("true"));
    // A macrotask, not the microtask the waitFor above ends on (fix round,
    // coderabbit PRRT_kwDOSzP1zc6nENjV): the self-replace this test rules out
    // is issued from a promise continuation, so without the flush the
    // assertion runs before the code has had the chance to do it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });

  test("a page that already names a campaign is left alone — the URL is the source of truth", async () => {
    // The pointer would say `other`, but this URL says `UUID`; the redirect
    // must not fire and overwrite the page the visitor actually asked for.
    nextMock().nav.pathname = "/grid";
    window.history.replaceState(null, "", `/grid?campaign=${UUID}`);
    mockPipelineApi({ opened: { id: "other", brief: { id: "other", products: [] } } });
    renderWithRun(<GridPage />);
    // Wait on the page's OWN open, not on a pointer read: a url that already
    // names a campaign is not the pointer's to decide, so neither the redirect
    // hook nor the shell's mount restore asks for one (fix round, qodo
    // PRRT_kwDOSzP1zc6nELaK). Waiting on the pointer here would have waited
    // for a request the fixed code must never make.
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) => String(url).includes(`/campaigns/${UUID}`)),
      ).toBe(true),
    );
    // A macrotask, not a microtask: the redirect is issued from a promise
    // continuation, so the assertion has to land after one for the guard to be
    // exercised at all (coderabbit PRRT_kwDOSzP1zc6nENjV).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([url]) => String(url).includes("/campaigns/last-opened")),
    ).toBe(false);
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });

  test("a failed pointer read navigates nowhere (F6: could-not-ask is not absence)", async () => {
    nextMock().nav.pathname = "/runs";
    window.history.replaceState(null, "", "/runs");
    // The pointer read itself, not some other request, is what has to fail.
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.reject(new Error("down")));
    renderWithRun(<RunsPage />);
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) => String(url).includes("/campaigns/last-opened")),
      ).toBe(true),
    );
    // A macrotask, not the microtask the waitFor above ends on (fix round,
    // coderabbit PRRT_kwDOSzP1zc6nENjV): the redirect is issued from a promise
    // continuation, so without the flush the assertion runs before the read
    // has settled and passes whatever the code then does.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });

  test("unmounting before the pointer answers navigates nowhere", async () => {
    nextMock().nav.pathname = "/export";
    window.history.replaceState(null, "", "/export");
    // Two callers read the pointer on this page — the shell's own restore and
    // the page's redirect — and each gets its own pending answer, so all of
    // them are held and released together.
    const resolvers: ((r: Response) => void)[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      String(url).includes("/campaigns/last-opened")
        ? new Promise<Response>((resolve) => resolvers.push(resolve))
        : Promise.resolve(json(EMPTY_REPORT)),
    );
    const view = renderWithRun(<ExportPage />);
    await waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
    view.unmount();
    for (const resolve of resolvers) resolve(json({ campaignId: UUID }));
    // A macrotask, not a microtask: the redirect is guarded by the effect's
    // own cleanup flag, so the answer has to be delivered and observed AFTER
    // the unmount for the guard to be exercised at all.
    await new Promise((r) => setTimeout(r, 0));
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });
});
