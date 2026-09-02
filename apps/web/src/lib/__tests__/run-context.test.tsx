import { describe, test, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { assetIdentity } from "@campaignfoundry/CampaignOrchestration";
import { RunProvider, useRun, assetKey, assetLabel, type Asset } from "@/lib/run-context";
import { json, jobOk, mockPipelineApi, EMPTY_REPORT, renderWithRun } from "@/__tests__/helpers";
import { Header } from "@/components/shell/Header";
import { CommandBar } from "@/components/shell/CommandBar";

const wrapper = ({ children }: { children: ReactNode }) => createElement(RunProvider, null, children);
const setup = () => renderHook(() => useRun(), { wrapper });

const asset = (over: Partial<Asset> = {}): Asset => ({
  productId: "alpha",
  aspectRatio: "1:1",
  outputPath: "alpha/1x1.png",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  treatment: "default",
  backgroundSource: "procedural",
  ...over,
});

describe("useRun", () => {
  test("throws when used outside a RunProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useRun())).toThrow(/within a RunProvider/);
  });

  test("assetKey combines product, ratio and treatment", () => {
    expect(assetKey(asset({ productId: "p", aspectRatio: "9:16", treatment: "t" }))).toBe("p/9:16/t");
  });

  test("web assetKey and domain assetIdentity share classic and variation fixtures", () => {
    const classic = asset({ productId: "p", aspectRatio: "9:16", treatment: "t" });
    const variation = asset({
      productId: "p",
      aspectRatio: "1:1",
      treatment: "headline-top-bold",
      variantIndex: 3,
    });
    expect(assetKey(classic)).toBe(assetIdentity(classic));
    expect(assetKey(variation)).toBe(assetIdentity(variation));
    expect(assetIdentity(classic)).toBe("p/9:16/t");
    expect(assetIdentity(variation)).toBe("p/v3");
  });

  test("assetLabel includes v<index> for variation cells", () => {
    expect(assetLabel(asset({ productId: "p", aspectRatio: "9:16", treatment: "t" }))).toBe("p @ 9:16 · t");
    expect(
      assetLabel(asset({ productId: "hydra-bottle", aspectRatio: "1:1", treatment: "headline-top-bold", variantIndex: 4 })),
    ).toBe("hydra-bottle @ 1:1 · v4 · headline-top-bold");
  });
});

describe("RunProvider — execute", () => {
  test("posts the brief and populates assets", async () => {
    mockPipelineApi({ job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.hasRun).toBe(true);
    expect(result.current.assetVersion).toBeGreaterThan(0);
  });

  test("an override brief is POSTed in place of the shell's, and the shell's brief is untouched (D35)", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "on-screen-draft" } }),
    });
    const { result } = setup();
    // The shell holds one brief; the editor hands Generate the on-screen draft — a
    // brief that may never have been written to disk.
    const onScreenDraft = {
      id: "on-screen-draft",
      targetRegion: "US",
      targetAudience: "x",
      campaignMessage: "the draft as typed",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
        { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
      ],
    };
    await act(async () => {
      await result.current.execute(onScreenDraft);
    });
    expect(bodies[0]).toMatchObject({ id: "on-screen-draft", campaignMessage: "the draft as typed" });
    // Run-without-write commits nothing: the shell still holds what it held.
    expect(result.current.brief.id).toBe("summer-hydration-2026");
    expect(result.current.assets).toHaveLength(1);
  });

  test("sends the selected model in the query string", async () => {
    const urls: string[] = [];
    mockPipelineApi({
      post: (url) => {
        urls.push(url);
        return json({ jobId: "job-1" }, 202);
      },
    });
    const { result } = setup();
    act(() => result.current.setSelectedModel("procedural"));
    await act(async () => {
      await result.current.execute();
    });
    expect(urls.some((u) => u.includes("model=procedural"))).toBe(true);
  });

  test("surfaces an actionable error on a non-ok, non-JSON response", async () => {
    mockPipelineApi({ post: () => new Response("502 Bad Gateway", { status: 502 }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/Pipeline API unreachable/);
  });

  test("surfaces a JSON error from a non-202 POST", async () => {
    mockPipelineApi({ post: () => json({ error: "Invalid campaign brief" }, 400) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("Invalid campaign brief");
  });

  test("discards a run whose result lands after a brief switch", async () => {
    let resolvePost!: (r: Response) => void;
    mockPipelineApi({
      post: () =>
        new Promise<Response>((res) => {
          resolvePost = res;
        }),
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    // Switch to a different brief while the POST is in flight (bumps the run token).
    act(() => {
      result.current.setBrief({
        id: "other-brief",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      });
    });
    await act(async () => {
      resolvePost(json({ jobId: "job-1" }, 202));
      await exec;
    });
    expect(result.current.assets).toHaveLength(0); // stale result dropped
  });
});

describe("RunProvider — review decisions", () => {
  test("decide toggles approve/reject and clears on repeat", () => {
    const { result } = setup();
    act(() => result.current.decide("k", "approved"));
    expect(result.current.decisions.k).toBe("approved");
    act(() => result.current.decide("k", "approved"));
    expect(result.current.decisions.k).toBeUndefined();
    act(() => result.current.decide("k", "rejected"));
    expect(result.current.decisions.k).toBe("rejected");
  });

  test("persists decisions to localStorage", async () => {
    const { result } = setup();
    act(() => result.current.decide("alpha/1:1/default", "approved"));
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("cf:decisions") ?? "{}")).toEqual({ "alpha/1:1/default": "approved" });
    });
  });

  test("regenerateRejected is a no-op when nothing is rejected", async () => {
    mockPipelineApi();
    const { result } = setup();
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before); // no POST
  });

  test("regenerateRejected is a no-op when a run exists but nothing is rejected", async () => {
    mockPipelineApi({ job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before); // no POST
  });

  test("regenerateRejected re-rolls rejected cells and returns them to review", async () => {
    mockPipelineApi({ job: () => jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(result.current.assets[0].complianceScore).toBe(0.9);
    expect(result.current.decisions["alpha/1:1/default"]).toBeUndefined(); // cleared, back to review
  });

  test("re-roll of a variant asset sends productId, variantIndex, attempt and increments", async () => {
    const bodies: unknown[] = [];
    let servedAttempt = 0;
    const variant = asset({
      variantIndex: 2,
      treatment: "headline-top-subtle",
      outputPath: "alpha/1x1/v2.png",
      attempt: 0,
    });
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: Array<{ attempt?: number }> };
        bodies.push(body);
        if (body.regenerateOnly?.[0]?.attempt !== undefined) servedAttempt = body.regenerateOnly[0].attempt;
        return json({ jobId: "job-1" }, 202);
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [{ ...variant, attempt: servedAttempt, treatment: servedAttempt === 0 ? variant.treatment : "headline-bottom-bold" }],
          log: { entries: [] },
        }),
    });
    const { result } = setup();
    // a variation run can only exist under a randomized brief
    act(() => result.current.setBrief({ ...result.current.brief, mode: "variation", variation: { count: 1 } } as never));
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/v2", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(bodies[1]).toEqual(
      expect.objectContaining({
        regenerateOnly: [{ productId: "alpha", variantIndex: 2, attempt: 1 }],
      }),
    );
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.assets[0].outputPath).toBe("alpha/1x1/v2.png");
    expect(result.current.decisions["alpha/v2"]).toBeUndefined();
    expect(result.current.assets[0].treatment).toBe("headline-bottom-bold");
    act(() => result.current.decide("alpha/v2", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(bodies[2]).toEqual(
      expect.objectContaining({
        regenerateOnly: [{ productId: "alpha", variantIndex: 2, attempt: 2 }],
      }),
    );
  });

  test("re-roll treats a missing asset.attempt as 0", async () => {
    const bodies: unknown[] = [];
    const variant = asset({
      variantIndex: 2,
      treatment: "headline-top-subtle",
      outputPath: "alpha/1x1/v2.png",
    });
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [variant], log: { entries: [] } }),
    });
    const { result } = setup();
    // a variation run can only exist under a randomized brief
    act(() => result.current.setBrief({ ...result.current.brief, mode: "variation", variation: { count: 1 } } as never));
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/v2", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(bodies[1]).toEqual(
      expect.objectContaining({
        regenerateOnly: [{ productId: "alpha", variantIndex: 2, attempt: 1 }],
      }),
    );
  });

  test("re-roll after a reload advances from the persisted asset.attempt", async () => {
    const bodies: unknown[] = [];
    const variant = asset({
      variantIndex: 2,
      attempt: 3,
      treatment: "headline-top-subtle",
      outputPath: "alpha/1x1/v2.png",
    });
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
    mockPipelineApi({
      report: { halted: false, assets: [variant], log: { entries: [], campaignId: "seed" } },
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [{ ...variant, attempt: 4 }], log: { entries: [] } }),
    });
    const { result } = setup();
    // a variation run can only exist under a randomized brief
    act(() => result.current.setBrief({ ...result.current.brief, mode: "variation", variation: { count: 1 } } as never));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    act(() => result.current.decide("alpha/v2", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(bodies[0]).toEqual(
      expect.objectContaining({
        regenerateOnly: [{ productId: "alpha", variantIndex: 2, attempt: 4 }],
      }),
    );
  });
});

describe("RunProvider — result-scoped actions key off the brief the run ran (R6)", () => {
  /** The editor's on-screen draft: a brief the shell does not hold (D35). */
  const onScreenDraft = {
    id: "on-screen-draft",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "the draft as typed",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
      { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
    ],
  };

  test("a re-roll after 'Run this draft' POSTs the draft, not the shell brief", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () =>
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [], campaignId: "on-screen-draft" } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute(onScreenDraft);
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    // The money: the re-roll goes out under the brief that produced the assets —
    // the draft — never the shell's untouched brief.
    const body = bodies[1] as { brief: { id: string; campaignMessage: string }; regenerateOnly: unknown[] };
    expect(body.brief).toMatchObject({ id: "on-screen-draft", campaignMessage: "the draft as typed" });
    expect(body.regenerateOnly).toHaveLength(1);
    expect(result.current.assets[0].complianceScore).toBe(0.9);
    expect(result.current.decisions["alpha/1:1/default"]).toBeUndefined(); // back to review
  });

  test("a re-roll after a normal run POSTs the same brief it ran", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    const body = bodies[1] as { brief: { id: string } };
    expect(body.brief).toMatchObject({ id: "summer-hydration-2026" });
  });

  test("a re-roll after running a randomized draft under a classic shell brief is not blocked", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ variantIndex: 0, outputPath: "alpha/1x1/v0.png", complianceScore: 0.9 })],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
    });
    const { result } = setup();
    // The shell brief is classic; the draft is a randomized campaign. The run's mode
    // guard must ask the brief the run ran — the draft — not the shell's (R6).
    await act(async () => {
      await result.current.execute({ ...onScreenDraft, mode: "variation", variation: { count: 1 } } as never);
    });
    expect(result.current.runMode).toBe("variation");
    expect(result.current.rerollBlockedReason).toBeNull();
    act(() => result.current.decide("alpha/v0", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    const body = bodies[1] as { brief: { id: string } };
    expect(body.brief).toMatchObject({ id: "on-screen-draft" });
    expect(result.current.decisions["alpha/v0"]).toBeUndefined(); // back to review
  });

  test("a brief switch after a draft run still supersedes the re-roll (runSeq guard)", async () => {
    let resolveRegen!: (r: Response) => void;
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return new Promise<Response>((res) => (resolveRegen = res));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset({ complianceScore: 0.1 })], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute(onScreenDraft);
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    let regen!: Promise<void>;
    act(() => {
      regen = result.current.regenerateRejected();
    });
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      resolveRegen(json({ jobId: "job-reroll" }, 202));
      await regen;
    });
    // The switched brief has no run; the stale regenerate was discarded whole.
    expect(result.current.assets).toHaveLength(0);
  });
});

describe("RunProvider — briefApplied", () => {
  test("the default brief nobody has touched is not applied", () => {
    const { result } = setup();
    expect(result.current.briefApplied).toBe(false);
  });

  test("the empty brief the new-brief route releases is not applied", () => {
    const { result } = setup();
    // `blankBrief()` (editor-state.ts): a blank id is the marker for "no campaign" —
    // nothing can be saved, listed or run under it, so nothing has been applied.
    act(() => {
      result.current.setBrief({ id: "", targetRegion: "", targetAudience: "", campaignMessage: "", products: [] });
    });
    expect(result.current.briefApplied).toBe(false);
  });

  test("a brief the editor committed is applied", () => {
    const { result } = setup();
    act(() => result.current.setBrief({ ...result.current.brief, id: "applied-brief" }));
    expect(result.current.briefApplied).toBe(true);
  });
});

describe("RunProvider — the telemetry drawer", () => {
  test("starts closed, toggles both ways, and closes", () => {
    const { result } = setup();
    expect(result.current.telemetryOpen).toBe(false);
    act(() => result.current.toggleTelemetry());
    expect(result.current.telemetryOpen).toBe(true);
    act(() => result.current.toggleTelemetry());
    expect(result.current.telemetryOpen).toBe(false);
    act(() => result.current.toggleTelemetry());
    act(() => result.current.closeTelemetry());
    expect(result.current.telemetryOpen).toBe(false);
  });
});

describe("RunProvider — brief picker & persistence", () => {
  test("auto-opens the picker on first visit, then remembers dismissal", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.briefPickerOpen).toBe(true));
    act(() => result.current.closeBriefPicker());
    expect(result.current.briefPickerOpen).toBe(false);
    expect(localStorage.getItem("cf:brief-picked")).toBe("1");
  });

  test("restores the persisted brief on mount", async () => {
    const stored = {
      id: "stored-brief",
      targetRegion: "FR",
      targetAudience: "x",
      campaignMessage: "y",
      products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
    };
    localStorage.setItem("cf:brief", JSON.stringify(stored));
    const { result } = setup();
    await waitFor(() => expect(result.current.brief.id).toBe("stored-brief"));
  });

  test("ignores malformed stored brief/decisions", async () => {
    localStorage.setItem("cf:brief", "{ not json");
    localStorage.setItem("cf:decisions", JSON.stringify(["not", "an", "object"]));
    const { result } = setup();
    await waitFor(() => expect(result.current.brief.id).toBe("summer-hydration-2026")); // falls back to default
    expect(result.current.decisions).toEqual({});
  });

  test("the blank brief releases the shell but keeps the last-opened record (D37/H5)", async () => {
    const { result } = setup();
    await act(async () => {
      result.current.setBrief({
        id: "keeper",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      } as never);
    });
    expect(localStorage.getItem("cf:brief")).not.toBeNull();

    // D37: cf:brief is the "last opened" convenience, never an address — the URL
    // names the open brief. Releasing the shell's campaign (visiting /brief/new
    // opens no brief) must not destroy the pointer to the one the user opened
    // last: the bare /brief redirect and the grid's restore read it (H5).
    await act(async () => {
      result.current.setBrief({
        id: "",
        targetRegion: "",
        targetAudience: "",
        campaignMessage: "",
        products: [],
      } as never);
    });
    expect(result.current.brief.id).toBe("");
    expect(JSON.parse(localStorage.getItem("cf:brief") ?? "null")?.id).toBe("keeper");
  });

  test("setBrief keeps the current run when the id already matches", async () => {
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "summer-hydration-2026" } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets).toHaveLength(1);
    // Re-select the same brief id — the loaded run (and decisions) stay intact.
    act(() => result.current.setBrief({ ...result.current.brief }));
    expect(result.current.assets).toHaveLength(1);
  });

  test("does not auto-open the picker once it has been dismissed", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    const { result } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.briefPickerOpen).toBe(false);
  });

  test("openBriefPicker opens the picker from the sidebar", () => {
    localStorage.setItem("cf:brief-picked", "1"); // suppress the first-visit auto-open
    const { result } = setup();
    act(() => result.current.openBriefPicker());
    expect(result.current.briefPickerOpen).toBe(true);
  });

  test("restores persisted decisions on mount, filtering invalid values", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "approved", bad: "bogus" }));
    const { result } = setup();
    await waitFor(() => expect(result.current.decisions["alpha/1:1/default"]).toBe("approved"));
    expect(result.current.decisions.bad).toBeUndefined();
  });

  test("restores the persisted run for the stored brief on mount", async () => {
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "stored", targetRegion: "FR", targetAudience: "x", campaignMessage: "y", products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }] }),
    );
    mockPipelineApi({ report: { halted: false, assets: [asset()], log: { entries: [], campaignId: "stored" } } });
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
  });

  test("setBrief loads the target brief's own persisted run", async () => {
    mockPipelineApi({
      result: (url) =>
        url.includes("campaignId=other")
          ? json({ halted: false, assets: [asset({ productId: "beta" })], log: { entries: [], campaignId: "other" } })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    act(() =>
      result.current.setBrief({
        id: "other",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
  });

  test("tolerates localStorage being unavailable", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = setup();
    act(() =>
      result.current.setBrief({
        id: "nostore",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    act(() => result.current.decide("k", "approved"));
    act(() => result.current.closeBriefPicker());
    expect(result.current.brief.id).toBe("nostore"); // survived without throwing
  });
});

describe("RunProvider — late results after a switch", () => {
  const otherBrief = {
    id: "switched",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "y",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
      { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
    ],
  };

  test("an errored run that resolves after a brief switch is dropped", async () => {
    let rejectPost!: (e: unknown) => void;
    mockPipelineApi({
      post: () =>
        new Promise<Response>((_res, rej) => {
          rejectPost = rej;
        }),
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    act(() => result.current.setBrief(otherBrief));
    await act(async () => {
      rejectPost(new Error("boom"));
      await exec;
    });
    expect(result.current.error).toBeNull(); // stale error suppressed
  });

  test("regenerateRejected surfaces an error when the re-roll fails", async () => {
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        return body.regenerateOnly ? new Response("boom", { status: 500 }) : json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(result.current.error).toMatch(/Pipeline API unreachable/);
  });

  test("execute uses the generic message when a run rejects with a non-Error", async () => {
    mockPipelineApi({ post: () => Promise.reject("plain string") });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("Generation failed");
  });

  test("regenerateRejected uses the generic message on a non-Error rejection", async () => {
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return Promise.reject("plain string");
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(result.current.error).toBe("Regeneration failed");
  });

  test("a regenerate that resolves after a brief switch is dropped", async () => {
    let resolveRegen!: (r: Response) => void;
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return new Promise<Response>((res) => (resolveRegen = res));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset({ complianceScore: 0.1 })], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    let regen!: Promise<void>;
    act(() => {
      regen = result.current.regenerateRejected();
    });
    act(() => result.current.setBrief(otherBrief)); // bumps the run token
    await act(async () => {
      resolveRegen(json({ jobId: "job-1" }, 202));
      await regen;
    });
    // The switched brief has no run; the stale regenerate result was discarded.
    expect(result.current.assets).toHaveLength(0);
  });
});

describe("RunProvider — log-only and superseded restores", () => {
  const haltedRun = (id: string) => json({ halted: true, assets: [], log: { entries: [], campaignId: id } });

  test("restores a halted, log-only run on mount (no assets, no version bump)", async () => {
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "halted", targetRegion: "FR", targetAudience: "x", campaignMessage: "y", products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }] }),
    );
    mockPipelineApi({ report: { halted: true, assets: [], log: { entries: [], campaignId: "halted" } } });
    const { result } = setup();
    await waitFor(() => expect(result.current.halted).toBe(true));
    expect(result.current.assets).toHaveLength(0);
  });

  test("setBrief adopts a halted, log-only run for the target brief", async () => {
    mockPipelineApi({
      result: (url) => (url.includes("campaignId=halt2") ? haltedRun("halt2") : json(EMPTY_REPORT)),
    });
    const { result } = setup();
    act(() =>
      result.current.setBrief({
        id: "halt2",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await waitFor(() => expect(result.current.halted).toBe(true));
  });

  test("swallows a failed restore fetch on mount", async () => {
    mockPipelineApi({ result: () => Promise.reject(new Error("network down")) });
    const { result } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.hasRun).toBe(false);
  });

  test("swallows a failed run fetch triggered by setBrief", async () => {
    mockPipelineApi({ result: () => Promise.reject(new Error("down")) });
    const { result } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      result.current.setBrief({
        id: "sb",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.brief.id).toBe("sb");
  });

  test("drops a regenerate that errors after a brief switch", async () => {
    let rejectRegen!: (e: unknown) => void;
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return new Promise<Response>((_res, rej) => (rejectRegen = rej));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    let regen!: Promise<void>;
    act(() => {
      regen = result.current.regenerateRejected();
    });
    act(() =>
      result.current.setBrief({
        id: "switched2",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      rejectRegen(new Error("boom"));
      await regen;
    });
    expect(result.current.error).toBeNull(); // stale regenerate error suppressed
  });

  test("a superseding setBrief discards the earlier brief's in-flight run fetch", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    mockPipelineApi({
      result: (url) => {
        if (url.includes("campaignId=first")) return new Promise<Response>((res) => resolvers.push(res));
        return json(EMPTY_REPORT);
      },
    });
    const mk = (id: string) => ({
      id,
      targetRegion: "US",
      targetAudience: "x",
      campaignMessage: "y",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
        { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
      ],
    });
    const { result } = setup();
    act(() => result.current.setBrief(mk("first")));
    act(() => result.current.setBrief(mk("second"))); // supersedes 'first' before its fetch resolves
    await act(async () => {
      resolvers.forEach((r) => r(json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "first" } })));
      await Promise.resolve();
    });
    expect(result.current.brief.id).toBe("second");
    expect(result.current.assets).toHaveLength(0); // the stale 'first' run was ignored
  });
});

describe("RunProvider — job polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("polls until a running job completes", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        if (polls === 1) return json({ status: "running", done: 0, total: 0, log: null });
        return jobOk({ halted: false, assets: [asset()], log: { entries: [] } });
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await exec;
    });
    expect(result.current.assets).toHaveLength(1);
    expect(polls).toBe(2);
  });

  test("surfaces a failed job's error", async () => {
    mockPipelineApi({ job: () => json({ status: "failed", done: 0, total: 0, log: null, error: "need two products" }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("need two products");
  });

  test("uses a generic message when a failed job has no error", async () => {
    mockPipelineApi({ job: () => json({ status: "failed", done: 0, total: 0, log: null }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("Generation failed");
  });

  test("uses a generic message when a completed job has no result", async () => {
    mockPipelineApi({ job: () => json({ status: "completed", done: 0, total: 0, log: null }) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("Generation failed");
  });

  test("a lost job shows the last saved result as such — no cache-bust, decisions kept", async () => {
    let posted = false;
    mockPipelineApi({
      post: () => {
        posted = true;
        return json({ jobId: "job-1" }, 202);
      },
      job: () => json({ error: "not found" }, 404),
      result: (url) =>
        posted && String(url).includes("campaignId=summer-hydration-2026")
          ? json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "summer-hydration-2026" } })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    const versionBefore = result.current.assetVersion;
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.error).toMatch(/Run was interrupted/);
    expect(result.current.assetVersion).toBe(versionBefore);
    expect(result.current.decisions["alpha/1:1/default"]).toBe("rejected");
    expect(result.current.loading).toBe(false);
  });

  test("a lost job with a halted log-only report on disk shows that report", async () => {
    let posted = false;
    mockPipelineApi({
      post: () => {
        posted = true;
        return json({ jobId: "job-1" }, 202);
      },
      job: () => json({ error: "not found" }, 404),
      result: () =>
        posted
          ? json({ halted: true, assets: [], log: { entries: [], campaignId: "summer-hydration-2026" } })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.halted).toBe(true);
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toMatch(/Run was interrupted/);
  });

  test("a lost job with nothing on disk reports the interruption and keeps the grid empty", async () => {
    mockPipelineApi({ job: () => json({ error: "not found" }, 404) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/Run was interrupted/);
    expect(result.current.hasRun).toBe(false);
  });

  test("a lost job whose restore fetch fails still reports the interruption", async () => {
    mockPipelineApi({
      job: () => json({ error: "not found" }, 404),
      result: () => Promise.reject(new Error("down")),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/Run was interrupted/);
  });

  test("never adopts another brief's persisted report after a lost job", async () => {
    mockPipelineApi({
      job: () => json({ error: "not found" }, 404),
      result: () => json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "other" } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toMatch(/Run was interrupted/);
  });

  test("a 409 carrying a handle adopts the run in progress and polls it to completion", async () => {
    // The server refused the POST because a run is already in flight, and named it:
    // the honest answer is to poll that job, not to treat the response as a failure.
    mockPipelineApi({
      post: () =>
        json(
          {
            error: 'A run for campaign "summer-hydration-2026" is already in progress.',
            jobId: "in-flight",
            campaignId: "summer-hydration-2026",
          },
          409,
        ),
      job: (url) =>
        String(url).includes("/campaigns/jobs/in-flight")
          ? jobOk({ halted: false, assets: [asset()], log: { entries: [] } })
          : json({ error: "not found" }, 404),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.hasRun).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test("a 409 without a handle surfaces the error honestly and fabricates no run", async () => {
    // An API that predates the handle: there is nothing to adopt, so the press says
    // why it did not start a run instead of pretending one is underway.
    mockPipelineApi({
      post: () => json({ error: 'A run for campaign "summer-hydration-2026" is already in progress.' }, 409),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/already in progress/);
    expect(result.current.hasRun).toBe(false);
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  test("a re-roll result that lands after a brief switch is dropped", async () => {
    let resolveJob!: (r: Response) => void;
    mockPipelineApi({
      post: (_url, init) => {
        const body = JSON.parse(init.body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return json({ jobId: "job-reroll" }, 202);
        return json({ jobId: "job-1" }, 202);
      },
      job: (url) =>
        String(url).includes("job-reroll")
          ? new Promise<Response>((res) => (resolveJob = res))
          : jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    let regen!: Promise<void>;
    act(() => {
      regen = result.current.regenerateRejected();
    });
    await waitFor(() => expect(typeof resolveJob).toBe("function"));
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      resolveJob(jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }));
      await regen;
    });
    expect(result.current.assets).toHaveLength(0); // the switched brief has no run
    expect(result.current.regeneratingKeys).toBeNull();
  });

  test("a lost re-roll leaves the grid and the rejected decisions untouched", async () => {
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "summer-hydration-2026" } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    mockPipelineApi({ job: () => json({ error: "not found" }, 404) });
    const versionBefore = result.current.assetVersion;
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(result.current.error).toMatch(/Run was interrupted/);
    expect(result.current.decisions["alpha/1:1/default"]).toBe("rejected");
    expect(result.current.assetVersion).toBe(versionBefore);
    expect(result.current.regeneratingKeys).toBeNull();
  });

  test("tolerates transient poll failures with backoff, then gives up", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        return new Response("<html>502</html>", { status: 502 });
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    // 250 → 375 → 562.5 → 843.75 ms between the five attempts; total < 2.1 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await exec;
    });
    expect(polls).toBe(5);
    expect(result.current.error).toMatch(/Pipeline API unreachable \(HTTP 502\)/);
  });

  test("a transient blip in the middle of a run does not abort it", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        if (polls === 1) return json({ status: "running", done: 0, total: 0, log: null });
        if (polls === 2) return new Response("nope", { status: 500 });
        return jobOk({ halted: false, assets: [asset()], log: { entries: [] } });
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await exec;
    });
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  test("gives up with the API's JSON error after repeated non-ok polls", async () => {
    vi.useFakeTimers();
    mockPipelineApi({ job: () => json({ error: "nope" }, 500) });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
      await exec;
    });
    expect(result.current.error).toBe("nope");
  });

  test("polling backs off to the cap on a long run", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        return polls < 8
          ? json({ status: "running", done: 0, total: 0, log: null })
          : jobOk({ halted: false, assets: [asset()], log: { entries: [] } });
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    // Delays: 250, 375, 562.5, 843.75, 1265.6, 1898.4, 2000 → cumulative ≈ 7.2 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_300);
      await exec;
    });
    expect(polls).toBe(8);
    expect(result.current.assets).toHaveLength(1);
  });

  test("rejects a 2xx without a job id as a version mismatch", async () => {
    mockPipelineApi({ post: () => json({}, 202) });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/expected 202 with a job id/);
  });

  test("a brief switch aborts the poller between polls", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({ job: () => (polls += 1, json({ status: "running", done: 0, total: 0, log: null })) });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    expect(polls).toBe(1);
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await exec;
    });
    expect(polls).toBe(1); // the pending wait rejected on abort; no further GETs
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("a brief switch while a poll GET is in flight stops the loop before the next wait", async () => {
    let resolveJob!: (r: Response) => void;
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        return new Promise<Response>((res) => (resolveJob = res));
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    await waitFor(() => expect(typeof resolveJob).toBe("function"));
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      resolveJob(json({ status: "running", done: 0, total: 0, log: null }));
      await exec;
    });
    expect(polls).toBe(1); // the wait saw the abort immediately; no second GET
  });

  test("a brief switch during lost-job recovery drops the stale restore", async () => {
    let resolveResult!: (r: Response) => void;
    let posted = false;
    mockPipelineApi({
      post: () => {
        posted = true;
        return json({ jobId: "job-1" }, 202);
      },
      job: () => json({ error: "not found" }, 404),
      // Hang only the recovery fetch for the original brief; the switched brief's own
      // restore fetch must resolve normally (or it would steal the resolver).
      result: (url) =>
        posted && String(url).includes("campaignId=summer-hydration-2026")
          ? new Promise<Response>((res) => (resolveResult = res))
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    await waitFor(() => expect(typeof resolveResult).toBe("function"));
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      resolveResult(
        json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "summer-hydration-2026" } }),
      );
      await exec;
    });
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("unmounting the provider aborts an in-flight poller", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({ job: () => (polls += 1, json({ status: "running", done: 0, total: 0, log: null })) });
    const { result, unmount } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await exec;
    });
    expect(polls).toBe(1);
  });

  test("a brief switch during polling drops the stale job result", async () => {
    let resolveJob!: (r: Response) => void;
    mockPipelineApi({
      job: () => new Promise<Response>((res) => (resolveJob = res)),
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    await waitFor(() => expect(typeof resolveJob).toBe("function")); // POST 202, GET job hanging
    act(() =>
      result.current.setBrief({
        id: "switched",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    await act(async () => {
      resolveJob(jobOk({ halted: false, assets: [asset()], log: { entries: [] } }));
      await exec;
    });
    expect(result.current.assets).toHaveLength(0);
  });
});

describe("RunProvider — estimate and packaging", () => {
  const pkg = (platformId: string) => ({
    platformId,
    items: [
      {
        productId: "alpha",
        aspectRatio: "1:1",
        treatment: "default",
        source: "alpha/1x1.png",
        packagedPath: `packages/summer-hydration-2026/${platformId}/alpha/1x1.png`,
        bytes: 12,
        checks: { size: "pass" as const },
      },
    ],
  });

  test("setEstimate stores ok, infeasible, unavailable, and idle", () => {
    const { result } = setup();
    act(() =>
      result.current.setEstimate({
        status: "ok",
        estimate: { creatives: 12, axisProductSize: 36, feasible: true, genaiCalls: 0 },
        error: null,
      }),
    );
    expect(result.current.estimateStatus).toBe("ok");
    expect(result.current.estimate?.creatives).toBe(12);
    act(() => result.current.setEstimate({ status: "infeasible", estimate: null, error: "nope" }));
    expect(result.current.estimateError).toBe("nope");
    act(() => result.current.setEstimate({ status: "unavailable", estimate: null, error: null }));
    expect(result.current.estimateStatus).toBe("unavailable");
    act(() => result.current.setEstimate({ status: "loading" }));
    expect(result.current.estimateStatus).toBe("loading");
    act(() => result.current.setEstimate({ status: "idle" }));
    expect(result.current.estimate).toBeNull();
    expect(result.current.estimateError).toBeNull();
    expect(result.current.estimateStatus).toBe("idle");
  });

  test("packageSelected merges platforms and records an error", async () => {
    mockPipelineApi({
      packagePost: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { platforms: string[] };
        if (body.platforms[0] === "x") return json({ error: "unknown" }, 422);
        return json({ platforms: [pkg(body.platforms[0])] });
      },
    });
    const { result } = setup();
    await act(async () => {
      await result.current.packageSelected(["instagram-feed"]);
    });
    expect(result.current.packages.map((p) => p.platformId)).toEqual(["instagram-feed"]);
    await act(async () => {
      await result.current.packageSelected(["linkedin"]);
    });
    expect(result.current.packages.map((p) => p.platformId).sort()).toEqual(["instagram-feed", "linkedin"]);
    await act(async () => {
      await result.current.packageSelected(["x"]);
    });
    expect(result.current.packageError).toBe("unknown");
    expect(result.current.packages).toHaveLength(2);
  });

  test("loadPackages hydrates, treats 404 as empty, and surfaces other errors", async () => {
    mockPipelineApi({
      packages: () => json({ platforms: [pkg("instagram-feed")] }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.loadPackages();
    });
    expect(result.current.packages).toHaveLength(1);
    mockPipelineApi({ packages: () => json({ error: "Not found" }, 404) });
    await act(async () => {
      await result.current.loadPackages();
    });
    expect(result.current.packages).toHaveLength(0);
    mockPipelineApi({ packages: () => json({ error: "boom" }, 500) });
    await act(async () => {
      await result.current.loadPackages();
    });
    expect(result.current.packageError).toBe("boom");
  });

  test("switching briefs clears estimate and packages", async () => {
    mockPipelineApi({
      packagePost: () => json({ platforms: [pkg("instagram-feed")] }),
    });
    const { result } = setup();
    act(() =>
      result.current.setEstimate({
        status: "ok",
        estimate: { creatives: 1, axisProductSize: 1, feasible: true, genaiCalls: 0 },
        error: null,
      }),
    );
    await act(async () => {
      await result.current.packageSelected(["instagram-feed"]);
    });
    act(() =>
      result.current.setBrief({
        id: "other-camp",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
        ],
      }),
    );
    expect(result.current.estimate).toBeNull();
    expect(result.current.packages).toHaveLength(0);
    expect(result.current.estimateStatus).toBe("idle");
  });

  const otherBrief = {
    id: "other-camp",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "y",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
      { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
    ],
  };

  test("a brief switch aborts an in-flight package call and drops its result", async () => {
    let resolvePost: ((r: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    mockPipelineApi({
      packagePost: (_url, init) => {
        signal = init.signal;
        return new Promise<Response>((res) => {
          resolvePost = res;
        });
      },
    });
    const { result } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.packageSelected(["instagram-feed"]);
    });
    expect(result.current.packaging).toBe(true);
    await waitFor(() => expect(resolvePost).toEqual(expect.any(Function)));
    expect(signal?.aborted).toBe(false);
    act(() => result.current.setBrief(otherBrief));
    expect(signal?.aborted).toBe(true);
    expect(result.current.packaging).toBe(false);
    await act(async () => {
      resolvePost?.(json({ platforms: [pkg("instagram-feed")] }));
      await pending;
    });
    expect(result.current.packages).toHaveLength(0);
    expect(result.current.packageError).toBeNull();
  });

  test("a package call that rejects after a brief switch sets no error", async () => {
    let rejectPost: ((e: unknown) => void) | undefined;
    mockPipelineApi({
      packagePost: () =>
        new Promise<Response>((_res, rej) => {
          rejectPost = rej;
        }),
    });
    const { result } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.packageSelected(["instagram-feed"]);
    });
    await waitFor(() => expect(rejectPost).toEqual(expect.any(Function)));
    act(() => result.current.setBrief(otherBrief));
    await act(async () => {
      rejectPost?.(new Error("aborted"));
      await pending;
    });
    expect(result.current.packageError).toBeNull();
  });

  test("an older package call is discarded once a newer one completed", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    mockPipelineApi({
      packagePost: () =>
        new Promise<Response>((res) => {
          resolvers.push(res);
        }),
    });
    const { result } = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.packageSelected(["instagram-feed"]);
      second = result.current.packageSelected(["linkedin"]);
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1](json({ platforms: [pkg("linkedin")] }));
      await second;
    });
    expect(result.current.packages.map((p) => p.platformId)).toEqual(["linkedin"]);
    await act(async () => {
      resolvers[0](json({ platforms: [pkg("instagram-feed")] }));
      await first;
    });
    expect(result.current.packages.map((p) => p.platformId)).toEqual(["linkedin"]);
    expect(result.current.packaging).toBe(false);
  });

  test("a stale package listing does not overwrite a newer package result", async () => {
    let resolveList: ((r: Response) => void) | undefined;
    mockPipelineApi({
      packages: () =>
        new Promise<Response>((res) => {
          resolveList = res;
        }),
      packagePost: () => json({ platforms: [pkg("x")] }),
    });
    const { result } = setup();
    let listing!: Promise<void>;
    act(() => {
      listing = result.current.loadPackages();
    });
    await waitFor(() => expect(resolveList).toEqual(expect.any(Function)));
    await act(async () => {
      await result.current.packageSelected(["x"]);
    });
    expect(result.current.packages.map((p) => p.platformId)).toEqual(["x"]);
    await act(async () => {
      resolveList?.(json({ platforms: [pkg("instagram-feed")] }));
      await listing;
    });
    expect(result.current.packages.map((p) => p.platformId)).toEqual(["x"]);
  });

  test("a brief switch aborts an in-flight package listing and drops its result or error", async () => {
    let resolveList: ((r: Response) => void) | undefined;
    let rejectList: ((e: unknown) => void) | undefined;
    mockPipelineApi({
      packages: (url) => {
        if (url.includes("other-camp")) return json({ error: "Not found" }, 404);
        return new Promise<Response>((res, rej) => {
          resolveList = res;
          rejectList = rej;
        });
      },
    });
    const { result } = setup();
    // fetch is mocked per-URL above; capture the signal through the spy's last call.
    let listing!: Promise<void>;
    act(() => {
      listing = result.current.loadPackages();
    });
    await waitFor(() => expect(resolveList).toEqual(expect.any(Function)));
    const signal = (vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined)?.signal;
    expect(signal?.aborted).toBe(false);
    act(() => result.current.setBrief(otherBrief));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveList?.(json({ platforms: [pkg("instagram-feed")] }));
      await listing;
    });
    expect(result.current.packages).toHaveLength(0);

    // Same race, rejecting: the error is dropped too.
    resolveList = undefined;
    act(() => result.current.setBrief({ ...otherBrief, id: "summer-hydration-2026" }));
    act(() => {
      listing = result.current.loadPackages();
    });
    await waitFor(() => expect(rejectList).toEqual(expect.any(Function)));
    act(() => result.current.setBrief(otherBrief));
    await act(async () => {
      rejectList?.(new Error("aborted"));
      await listing;
    });
    expect(result.current.packageError).toBeNull();
  });

  test("packageSelected uses a generic message for a non-Error rejection", async () => {
    mockPipelineApi({
      packagePost: () => Promise.reject("plain"),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.packageSelected(["instagram-feed"]);
    });
    expect(result.current.packageError).toBe("Network error");
  });

  test("loadPackages uses a generic message for a non-Error rejection", async () => {
    mockPipelineApi({
      packages: () => Promise.reject("plain"),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.loadPackages();
    });
    expect(result.current.packageError).toBe("Network error");
  });

  const onScreenDraft = {
    id: "on-screen-draft",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "the draft as typed",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" },
      { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" },
    ],
  };

  test("packageSelected keys the package POST off the campaign the run ran under (R6)", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "on-screen-draft" } }),
      packagePost: (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return json({ platforms: [] });
      },
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute(onScreenDraft);
    });
    await act(async () => {
      await result.current.packageSelected(["instagram-feed"]);
    });
    // The report the server reads is keyed by the campaign id, so the POST must name
    // the draft's id — the shell's brief would package (or miss) another campaign.
    expect(bodies[0]).toMatchObject({ campaignId: "on-screen-draft", platforms: ["instagram-feed"] });
  });

  test("loadPackages lists the packages of the campaign the run ran under (R6)", async () => {
    const urls: string[] = [];
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "on-screen-draft" } }),
      packages: (url) => {
        urls.push(url);
        return json({ platforms: [] }, 404);
      },
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute(onScreenDraft);
    });
    await act(async () => {
      await result.current.loadPackages();
    });
    expect(urls.some((u) => u.includes("/campaigns/packages/on-screen-draft"))).toBe(true);
  });

describe("re-roll across a mode change", () => {
  /** A randomized brief on file — the mismatch scenarios restore a run under it. */
  const variationStoredBrief = {
    id: "camp",
    mode: "variation",
    variation: { count: 1 },
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
  };

  test("refuses to re-roll a classic run recorded under a randomized brief, and says why", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      report: { halted: false, assets: [asset()], log: { entries: [], campaignId: "camp" } },
    });
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:brief", JSON.stringify(variationStoredBrief));
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1)); // the classic report restored
    expect(result.current.runMode).toBe("brief");
    expect(result.current.rerollBlockedReason).toMatch(
      /came from a classic run, but the brief they were produced under is now a randomized campaign/,
    );

    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    // nothing was sent — classic targets against a randomized brief can only fail
    expect(bodies.length).toBe(0);
    expect(result.current.error).toMatch(/cannot be re-rolled\. Run the full campaign/);
  });

  test("the other direction blocks too: a randomized run recorded under a classic brief", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "camp", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: variationStoredBrief.products }),
    );
    mockPipelineApi({
      report: {
        halted: false,
        assets: [asset({ variantIndex: 0, outputPath: "alpha/1x1/v0.png" })],
        log: { entries: [], campaignId: "camp" },
      },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.runMode).toBe("variation");
    expect(result.current.rerollBlockedReason).toMatch(
      /came from a randomized run, but the brief they were produced under is now a classic campaign/,
    );
  });

  test("a matching mode does not block", async () => {
    mockPipelineApi({
      post: () => json({ jobId: "job-1" }, 202),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ variantIndex: 0, outputPath: "alpha/1x1/v0.png" })],
          log: { entries: [], campaignId: "camp" },
        }),
    });
    const { result } = setup();
    act(() =>
      result.current.setBrief({ ...result.current.brief, id: "camp", mode: "variation", variation: { count: 1 } } as never),
    );
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.runMode).toBe("variation");
    expect(result.current.rerollBlockedReason).toBeNull();
  });

  test("a same-id brief edit after the run keeps the re-roll on the brief that ran (R6)", async () => {
    const bodies: unknown[] = [];
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [], campaignId: "camp" } }),
    });
    const { result } = setup();
    act(() => result.current.setBrief({ ...result.current.brief, id: "camp" }));
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.runMode).toBe("brief");
    expect(result.current.rerollBlockedReason).toBeNull();

    // the brief becomes a randomized campaign — but the run on screen (and the brief
    // recorded beside it as its producer) is untouched: the re-roll still goes out
    // under the classic brief the run actually used, so it stays possible.
    act(() =>
      result.current.setBrief({ ...result.current.brief, mode: "variation", variation: { count: 1 } } as never),
    );
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.rerollBlockedReason).toBeNull();

    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    const body = bodies[1] as { brief: { id: string; mode?: string } };
    expect(body.brief).toMatchObject({ id: "camp" });
    expect(body.brief.mode).toBeUndefined();
    expect(result.current.decisions["alpha/1:1/default"]).toBeUndefined(); // back to review
  });
});

});

describe("RunProvider — a second Generate does not lose the campaign (C4)", () => {
  /** Commits a brief the way Apply does — the one thing that turns Generate into a run. */
  const ApplyBrief = () => {
    const { brief, setBrief } = useRun();
    return (
      <button type="button" onClick={() => setBrief({ ...brief, id: "applied-brief" })}>apply</button>
    );
  };

  test("Header Generate and CommandBar Execute fired in one tick leave one run and show its result", async () => {
    const user = userEvent.setup();
    // Both POSTs are held so the two run verbs fire while both are in flight — the
    // exact state a double press creates. The real server serializes them: the first
    // POST finds no running job and answers 202; the second is refused 409, carrying
    // the running job's handle.
    const postAnswers: Array<(r: Response) => void> = [];
    mockPipelineApi({
      post: () => new Promise<Response>((res) => postAnswers.push(res)),
      job: () =>
        jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "applied-brief" } }),
    });
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
        <CommandBar onToggleTelemetry={() => {}} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));
    // The bar's Execute opens its confirm; the verb that actually runs is the dialog's
    // Generate — which, like the header's, is never disabled by loading. Both stay
    // pressable while a run is in flight: exactly how a campaign gets pressed twice.
    await user.click(screen.getByRole("button", { name: /Execute/ }));
    const headerGenerate = within(screen.getByRole("banner")).getByRole("button", { name: "Generate" });
    const dialogGenerate = within(screen.getByRole("dialog", { name: "Confirm pipeline action" })).getByText("Generate");
    // One tick: both presses dispatch in the same synchronous burst, before React can
    // flush the first press's loading state or either POST can answer.
    act(() => {
      headerGenerate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      dialogGenerate.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(postAnswers.length).toBe(2); // both presses really did ask the server
    postAnswers[0](json({ jobId: "job-1" }, 202));
    postAnswers[1](
      json(
        {
          error: 'A run for campaign "applied-brief" is already in progress.',
          jobId: "job-1",
          campaignId: "applied-brief",
        },
        409,
      ),
    );
    // The run the server kept is on the grid — not an error about a run that was fine.
    await waitFor(() => expect(screen.getByText(/Execution complete/)).toBeTruthy());
    expect(screen.queryByText(/already in progress/)).toBeNull();
  });
});

