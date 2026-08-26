import { describe, test, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { RunProvider, useRun, assetKey, type Asset } from "@/lib/run-context";
import { json, jobOk, mockPipelineApi, EMPTY_REPORT } from "@/__tests__/helpers";

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
