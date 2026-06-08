import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { RunProvider, useRun, assetKey, type Asset } from "@/lib/run-context";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const EMPTY = { halted: false, assets: [], log: null };

/** Route fetch by method: GET (mount/restore) vs POST (generate). */
const routeFetch = (onPost: () => Response | Promise<Response>) =>
  vi.mocked(globalThis.fetch).mockImplementation((_url, init) =>
    (init as RequestInit | undefined)?.method === "POST" ? Promise.resolve(onPost()) as Promise<Response> : Promise.resolve(json(EMPTY)),
  );

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
    routeFetch(() => json({ halted: false, assets: [asset()], log: { entries: [] } }));
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
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      urls.push(String(url));
      return Promise.resolve((init as RequestInit | undefined)?.method === "POST" ? json({ halted: false, assets: [], log: { entries: [] } }) : json(EMPTY));
    });
    const { result } = setup();
    act(() => result.current.setSelectedModel("procedural"));
    await act(async () => {
      await result.current.execute();
    });
    expect(urls.some((u) => u.includes("model=procedural"))).toBe(true);
  });

  test("surfaces an actionable error on a non-ok, non-JSON response", async () => {
    routeFetch(() => new Response("502 Bad Gateway", { status: 502 }));
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toMatch(/Pipeline API unreachable/);
  });

  test("discards a run whose result lands after a brief switch", async () => {
    let resolvePost!: (r: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) =>
      (init as RequestInit | undefined)?.method === "POST"
        ? new Promise<Response>((res) => {
            resolvePost = res;
          })
        : Promise.resolve(json(EMPTY)),
    );
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
      resolvePost(json({ halted: false, assets: [asset()], log: { entries: [] } }));
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
    routeFetch(() => json(EMPTY));
    const { result } = setup();
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before); // no POST
  });

  test("regenerateRejected re-rolls rejected cells and returns them to review", async () => {
    routeFetch(() => json({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }));
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
    routeFetch(() => json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "summer-hydration-2026" } }));
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
    vi.mocked(globalThis.fetch).mockResolvedValue(json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "stored" } }));
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
  });

  test("setBrief loads the target brief's own persisted run", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      Promise.resolve(
        String(url).includes("campaignId=other")
          ? json({ halted: false, assets: [asset({ productId: "beta" })], log: { entries: [], campaignId: "other" } })
          : json(EMPTY),
      ),
    );
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
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) =>
      (init as RequestInit | undefined)?.method === "POST"
        ? new Promise<Response>((_res, rej) => {
            rejectPost = rej;
          })
        : Promise.resolve(json(EMPTY)),
    );
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
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        const body = JSON.parse((init as RequestInit).body as string) as { regenerateOnly?: unknown };
        return Promise.resolve(
          body.regenerateOnly
            ? new Response("boom", { status: 500 })
            : json({ halted: false, assets: [asset()], log: { entries: [] } }),
        );
      }
      return Promise.resolve(json(EMPTY));
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
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) =>
      (init as RequestInit | undefined)?.method === "POST" ? Promise.reject("plain string") : Promise.resolve(json(EMPTY)),
    );
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("Generation failed");
  });

  test("regenerateRejected uses the generic message on a non-Error rejection", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        const body = JSON.parse((init as RequestInit).body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return Promise.reject("plain string");
        return Promise.resolve(json({ halted: false, assets: [asset()], log: { entries: [] } }));
      }
      return Promise.resolve(json(EMPTY));
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
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        const body = JSON.parse((init as RequestInit).body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return new Promise<Response>((res) => (resolveRegen = res));
        return Promise.resolve(json({ halted: false, assets: [asset()], log: { entries: [] } }));
      }
      return Promise.resolve(json(EMPTY));
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
      resolveRegen(json({ halted: false, assets: [asset({ complianceScore: 0.1 })], log: { entries: [] } }));
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
    vi.mocked(globalThis.fetch).mockResolvedValue(haltedRun("halted"));
    const { result } = setup();
    await waitFor(() => expect(result.current.halted).toBe(true));
    expect(result.current.assets).toHaveLength(0);
  });

  test("setBrief adopts a halted, log-only run for the target brief", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      Promise.resolve(String(url).includes("campaignId=halt2") ? haltedRun("halt2") : json(EMPTY)),
    );
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
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network down"));
    const { result } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.hasRun).toBe(false);
  });

  test("drops a regenerate that errors after a brief switch", async () => {
    let rejectRegen!: (e: unknown) => void;
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") {
        const body = JSON.parse((init as RequestInit).body as string) as { regenerateOnly?: unknown };
        if (body.regenerateOnly) return new Promise<Response>((_res, rej) => (rejectRegen = rej));
        return Promise.resolve(json({ halted: false, assets: [asset()], log: { entries: [] } }));
      }
      return Promise.resolve(json(EMPTY));
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
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      if (String(url).includes("campaignId=first")) return new Promise<Response>((res) => resolvers.push(res));
      return Promise.resolve(json(EMPTY));
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
