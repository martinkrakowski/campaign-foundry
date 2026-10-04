import { describe, test, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, type ReactNode } from "react";
import { assetIdentity } from "@campaignfoundry/CampaignOrchestration";
import { BRIEF_SCHEMA_VERSION } from "@campaignfoundry/CampaignOrchestration/brief-schema-version";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  RunProvider,
  useRun,
  usePageCampaignParam,
  API,
  DEFAULT_BRIEF,
  assetKey,
  assetCanvas,
  assetLabel,
  fetchPersistedRun,
  fetchRunningJob,
  normalizeRunResult,
  DECISIONS_CONFLICT_MESSAGE,
  DECISIONS_UNSAVED_MESSAGE,
  DECISIONS_UNREADABLE_MESSAGE,
  fetchDecisions,
  saveDecisions,
  handlePipelineResponseError,
  NO_ORGANISATION_YET_MESSAGE,
  ASSET_URL_FIELDS,
  URL_REFRESH_MS,
  holdsExpiringUrls,
  type Asset,
  type RunResult,
} from "@/lib/run-context";
import {
  json,
  jobOk,
  mockPipelineApi,
  EMPTY_REPORT,
  openedCampaign,
  renderWithRun,
  fakeDecisionsApi,
  seedDecisions,
  seedPersistedRun,
  fsUrls,
  s3Urls,
  FS_REVISION,
} from "@/__tests__/helpers";
import { CommandBar } from "@/components/shell/CommandBar";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(RunProvider, null, children);
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
    expect(assetKey(asset({ productId: "p", aspectRatio: "9:16", treatment: "t" }))).toBe(
      "p/9:16/t",
    );
  });

  test("assetCanvas names the canvas a row renders on; a corrupt row degrades to the empty key", () => {
    expect(assetCanvas({ aspectRatio: "1:1" })).toBe("1:1");
    expect(assetCanvas({ size: "728x90" })).toBe("728x90");
    // The API's report guard keeps rows to exactly one canvas (D113); the empty
    // fallback is defense-in-depth for a hand-edited report, never a real row.
    expect(assetCanvas({})).toBe("");
  });

  test("web assetKey and domain assetIdentity share classic and variation fixtures", () => {
    const classic = asset({ productId: "p", aspectRatio: "9:16", treatment: "t" });
    const display = asset({
      productId: "p",
      aspectRatio: undefined,
      size: "728x90",
      treatment: "t",
    });
    const variation = asset({
      productId: "p",
      aspectRatio: "1:1",
      treatment: "headline-top-bold",
      variantIndex: 3,
    });
    expect(assetKey(classic)).toBe(assetIdentity(classic));
    // A display cell keys on its size — a 728x90 cell never collides with a ratio cell.
    expect(assetKey(display)).toBe(assetIdentity(display));
    expect(assetIdentity(display)).toBe("p/728x90/t");
    expect(assetKey(variation)).toBe(assetIdentity(variation));
    expect(assetIdentity(classic)).toBe("p/9:16/t");
    expect(assetIdentity(variation)).toBe("p/v3");
  });

  test("assetLabel includes v<index> for variation cells", () => {
    expect(assetLabel(asset({ productId: "p", aspectRatio: "9:16", treatment: "t" }))).toBe(
      "p @ 9:16 · t",
    );
    expect(
      assetLabel(asset({ productId: "p", aspectRatio: undefined, size: "728x90", treatment: "t" })),
    ).toBe("p @ 728x90 · t");
    expect(
      assetLabel(
        asset({
          productId: "hydra-bottle",
          aspectRatio: "1:1",
          treatment: "headline-top-bold",
          variantIndex: 4,
        }),
      ),
    ).toBe("hydra-bottle @ 1:1 · v4 · headline-top-bold");
  });
});

describe("fetchPersistedRun — could not ask vs there is nothing (D83/F6)", () => {
  test("a rejected fetch is not an absent run", async () => {
    mockPipelineApi({ result: () => Promise.reject(new Error("down")) });
    await expect(fetchPersistedRun("seed")).rejects.toThrow("down");
  });

  test("a 5xx with a JSON body is not an absent run", async () => {
    // A 500 with a body does not throw at the fetch layer — it used to slip through
    // the campaignId test and resolve as "no run". It is a failed read.
    mockPipelineApi({ result: () => json({ error: "boom" }, 500) });
    await expect(fetchPersistedRun("seed")).rejects.toThrow(/Pipeline API unreachable/);
  });

  test("a 200 whose body carries no run for the campaign is an absent run", async () => {
    // The one truthful absence: the read succeeded and named no run for this campaign.
    mockPipelineApi({ result: () => json({ halted: false, assets: [], log: null }) });
    await expect(fetchPersistedRun("seed")).resolves.toBeNull();
  });

  test("a 404 from the server resolves as an absent run (PT-2b)", async () => {
    mockPipelineApi({ result: () => json({ error: "Campaign not found" }, 404) });
    await expect(fetchPersistedRun("seed")).resolves.toBeNull();
  });

  test("a 200 carrying the campaign's own run resolves with it", async () => {
    mockPipelineApi({
      result: () =>
        json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "seed" } }),
    });
    const d = await fetchPersistedRun("seed");
    expect(d?.assets).toHaveLength(1);
  });
});

describe("fetchRunningJob — 404 and network failure tolerance", () => {
  test("returns null for an empty campaignId", async () => {
    await expect(fetchRunningJob("")).resolves.toBeNull();
  });

  test("returns null when server answers 404", async () => {
    mockPipelineApi({
      result: () => json({ error: "No running job" }, 404),
    });
    await expect(fetchRunningJob("seed")).resolves.toBeNull();
  });

  test("returns null when server answers 500", async () => {
    mockPipelineApi({
      result: () => json({ error: "boom" }, 500),
    });
    await expect(fetchRunningJob("seed")).resolves.toBeNull();
  });

  test("returns null on a network rejection", async () => {
    mockPipelineApi({
      result: () => Promise.reject(new Error("network failure")),
    });
    await expect(fetchRunningJob("seed")).resolves.toBeNull();
  });

  test("returns null when body carries no jobId string", async () => {
    mockPipelineApi({
      result: () => json({ notAJobId: 123 }),
    });
    await expect(fetchRunningJob("seed")).resolves.toBeNull();
  });

  test("returns jobId string when 200 with jobId", async () => {
    mockPipelineApi({
      result: () => json({ jobId: "job-xyz-123" }),
    });
    await expect(fetchRunningJob("seed")).resolves.toBe("job-xyz-123");
  });
});

describe("RunProvider — execute", () => {
  test("posts the brief and populates assets", async () => {
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
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
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
    });
    const { result } = setup();
    // The shell holds one brief; the editor hands Generate the on-screen draft — a
    // brief that may never have been written to disk.
    const onScreenDraft = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    expect(bodies[0]).toMatchObject({
      id: "on-screen-draft",
      campaignMessage: "the draft as typed",
    });
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
  /** A restored run for campaign "seed" whose decisions the returned fake server holds. */
  const restored = async (verdicts: Record<string, "approved" | "rejected"> = {}) => {
    const server = fakeDecisionsApi(verdicts);
    seedPersistedRun([asset(), asset({ productId: "beta", outputPath: "beta/1x1.png" })], {
      decisions: server,
    });
    const hook = setup();
    await waitFor(() => expect(hook.result.current.decisionsLoaded).toBe(true));
    return { ...hook, server };
  };

  test("decide toggles approve/reject and clears on repeat", async () => {
    const { result } = await restored();
    act(() => result.current.decide("k", "approved"));
    expect(result.current.decisions.k).toBe("approved");
    act(() => result.current.decide("k", "approved"));
    expect(result.current.decisions.k).toBeUndefined();
    act(() => result.current.decide("k", "rejected"));
    expect(result.current.decisions.k).toBe("rejected");
  });

  test("decide does nothing with no run on screen: there is nothing to decide on", () => {
    mockPipelineApi();
    const { result } = setup();
    act(() => result.current.decide("k", "approved"));
    expect(result.current.decisions).toEqual({});
  });

  test("each decision is saved to the server in turn, each naming the revision the one before produced (D173)", async () => {
    const { result, server } = await restored();
    act(() => result.current.decide("alpha/1:1/default", "approved"));
    act(() => result.current.decide("beta/1:1/default", "rejected"));
    await waitFor(() =>
      expect(server.stored()).toEqual({
        "alpha/1:1/default": "approved",
        "beta/1:1/default": "rejected",
      }),
    );
    expect(result.current.decisionsNotice).toBeNull();
  });

  test("a restored run shows the decisions the server holds, and nothing is read from localStorage", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "beta/1:1/default": "approved" }));
    const { result } = await restored({ "alpha/1:1/default": "rejected" });
    await waitFor(() =>
      expect(result.current.decisions).toEqual({ "alpha/1:1/default": "rejected" }),
    );
    expect(localStorage.getItem("cf:decisions")).toBeNull(); // the retired key is removed
  });

  test("a save another tab beat is a conflict: the server's decisions replace the screen's, with a notice (D82)", async () => {
    const { result, server } = await restored({ "alpha/1:1/default": "approved" });
    await waitFor(() => expect(result.current.decisions["alpha/1:1/default"]).toBe("approved"));
    server.saveElsewhere({ "beta/1:1/default": "rejected" }); // the other tab
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await waitFor(() => expect(result.current.decisionsNotice).toBe(DECISIONS_CONFLICT_MESSAGE));
    await waitFor(() =>
      expect(result.current.decisions).toEqual({ "beta/1:1/default": "rejected" }),
    );
    expect(server.stored()).toEqual({ "beta/1:1/default": "rejected" }); // the stale save never landed
    // The next decision saves against the adopted revision, and clears the notice.
    act(() => result.current.decide("alpha/1:1/default", "approved"));
    await waitFor(() => expect(result.current.decisionsNotice).toBeNull());
    expect(server.stored()).toEqual({
      "beta/1:1/default": "rejected",
      "alpha/1:1/default": "approved",
    });
  });

  test("a save queued behind a conflict is dropped, not sent over the adopted decisions", async () => {
    const { result, server } = await restored();
    server.saveElsewhere({ "beta/1:1/default": "approved" });
    act(() => result.current.decide("alpha/1:1/default", "rejected")); // 409
    act(() => result.current.decide("alpha/1:1/default", "rejected")); // queued behind it
    await waitFor(() => expect(result.current.decisionsNotice).toBe(DECISIONS_CONFLICT_MESSAGE));
    await waitFor(() =>
      expect(result.current.decisions).toEqual({ "beta/1:1/default": "approved" }),
    );
    expect(server.stored()).toEqual({ "beta/1:1/default": "approved" });
  });

  test("decisions that land after a brief switch are dropped: they belong to the brief left behind", async () => {
    let answer!: (r: Response) => void;
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    seedPersistedRun([asset()], {
      decisions: {
        ...server,
        handle: () => new Promise<Response>((res) => (answer = res)),
      } as unknown as ReturnType<typeof fakeDecisionsApi>,
    });
    const { result } = setup();
    await waitFor(() => expect(answer).toBeTypeOf("function")); // the load is in flight
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "elsewhere",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      }),
    );
    await act(async () => {
      answer(server.handle("", {}));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.decisions).toEqual({});
  });

  /** A fake whose PUTs wait until the test lets them through. */
  const heldSaves = () => {
    const server = fakeDecisionsApi();
    const held: (() => void)[] = [];
    const fake = {
      ...server,
      handle: (url: string, init: RequestInit) =>
        init.method === "PUT"
          ? new Promise<Response>((res) => held.push(() => res(server.handle(url, init))))
          : server.handle(url, init),
    } as ReturnType<typeof fakeDecisionsApi>;
    return { fake, held, server };
  };
  const elsewhere = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "elsewhere",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "y",
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
  };

  test("a save that lands after a brief switch changes nothing on the new brief's screen", async () => {
    const { fake, held } = heldSaves();
    seedPersistedRun([asset()], { decisions: fake });
    const { result } = setup();
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    act(() => result.current.decide("alpha/1:1/default", "approved"));
    await waitFor(() => expect(held).toHaveLength(1));
    act(() => result.current.setBrief(elsewhere));
    await act(async () => {
      held[0]!();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.decisions).toEqual({});
    expect(result.current.decisionsNotice).toBeNull();
  });

  test("a re-roll whose brief is switched away while its verdict saves is never sent", async () => {
    const { fake, held } = heldSaves();
    const posts: unknown[] = [];
    mockPipelineApi({
      decisions: fake,
      post: (_url, init) => {
        posts.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await waitFor(() => expect(held).toHaveLength(1)); // the verdict is saving
    let regen!: Promise<void>;
    act(() => {
      regen = result.current.regenerateRejected();
    });
    act(() => result.current.setBrief(elsewhere));
    await act(async () => {
      held[0]!();
      await regen;
    });
    expect(posts).toHaveLength(1); // the first run only: the re-roll never went out
  });

  test("a decision clicked before the server's decisions load is dropped, not saved over them", async () => {
    let release!: () => void;
    let gets = 0;
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    const held = {
      ...server,
      handle: (url: string, init: RequestInit) =>
        init.method === "PUT" || (gets += 1) > 1
          ? server.handle(url, init)
          : new Promise<Response>((res) => (release = () => res(server.handle(url, init)))),
    } as ReturnType<typeof fakeDecisionsApi>;
    seedPersistedRun([asset(), asset({ productId: "beta", outputPath: "beta/1x1.png" })], {
      decisions: held,
    });
    const { result } = setup();
    await waitFor(() => expect(release).toBeTypeOf("function")); // the load is in flight
    expect(result.current.decisionsLoaded).toBe(false);
    act(() => result.current.decide("beta/1:1/default", "rejected"));
    expect(result.current.decisions).toEqual({});
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    expect(result.current.decisions).toEqual({ "alpha/1:1/default": "approved" });
    expect(server.stored()).toEqual({ "alpha/1:1/default": "approved" });
  });

  test("a save that does not land puts the screen back to what is recorded, and says so", async () => {
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    const failing = {
      ...server,
      handle: (url: string, init: RequestInit) =>
        init.method === "PUT" ? json({ error: "down" }, 500) : server.handle(url, init),
    } as ReturnType<typeof fakeDecisionsApi>;
    seedPersistedRun([asset()], { decisions: failing });
    const { result } = setup();
    await waitFor(() => expect(result.current.decisions["alpha/1:1/default"]).toBe("approved"));
    act(() => result.current.decide("alpha/1:1/default", "rejected"));
    await waitFor(() => expect(result.current.decisionsNotice).toBe(DECISIONS_UNSAVED_MESSAGE));
    await waitFor(() => expect(result.current.decisions["alpha/1:1/default"]).toBe("approved"));
  });

  test("decisions that could not be fetched pause reviewing with a reason, and a retry loads them", async () => {
    let down = true;
    const server = fakeDecisionsApi({ "alpha/1:1/default": "approved" });
    seedPersistedRun([asset()], {
      decisions: {
        ...server,
        handle: (url: string, init: RequestInit) =>
          down ? json({ error: "down" }, 500) : server.handle(url, init),
      } as ReturnType<typeof fakeDecisionsApi>,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.decisionsNotice).toBe(DECISIONS_UNREADABLE_MESSAGE));
    expect(result.current.decisionsLoaded).toBe(false);
    expect(result.current.decisions).toEqual({});
    down = false;
    act(() => result.current.reloadDecisions());
    expect(result.current.decisionsNotice).toBeNull();
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    expect(result.current.decisions).toEqual({ "alpha/1:1/default": "approved" });
  });

  test("a failed load that lands after a brief switch says nothing about the new brief", async () => {
    let fail!: () => void;
    seedPersistedRun([asset()], {
      decisions: {
        handle: () =>
          new Promise<Response>((res) => (fail = () => res(json({ error: "down" }, 500)))),
      } as unknown as ReturnType<typeof fakeDecisionsApi>,
    });
    const { result } = setup();
    await waitFor(() => expect(fail).toBeTypeOf("function")); // the load is in flight
    act(() => result.current.setBrief(elsewhere));
    await act(async () => {
      fail();
    });
    await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
    expect(result.current.decisionsNotice).toBeNull();
  });

  test("reloadDecisions with no run on screen does nothing", () => {
    mockPipelineApi();
    const { result } = setup();
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    act(() => result.current.reloadDecisions());
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
    expect(result.current.decisionsLoaded).toBe(false);
  });

  test("reviewing pauses while a conflict's reload is in flight: a click then is dropped", async () => {
    let release: (() => void) | undefined;
    let gets = 0;
    const server = fakeDecisionsApi();
    const fake = {
      ...server,
      handle: (url: string, init: RequestInit) =>
        init.method === "PUT" || (gets += 1) !== 2
          ? server.handle(url, init)
          : new Promise<Response>((res) => (release = () => res(server.handle(url, init)))),
    } as ReturnType<typeof fakeDecisionsApi>;
    seedPersistedRun([asset(), asset({ productId: "beta", outputPath: "beta/1x1.png" })], {
      decisions: fake,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    server.saveElsewhere({ "beta/1:1/default": "approved" });
    act(() => result.current.decide("alpha/1:1/default", "rejected")); // 409, then the held reload
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(result.current.decisionsLoaded).toBe(false);
    act(() => result.current.decide("alpha/1:1/default", "approved")); // during the reload
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    expect(result.current.decisions).toEqual({ "beta/1:1/default": "approved" });
    expect(server.stored()).toEqual({ "beta/1:1/default": "approved" });
  });

  test("a re-roll whose verdict lost to another tab's is not sent: the report write would retire that tab's approval", async () => {
    const server = fakeDecisionsApi();
    const posts: unknown[] = [];
    mockPipelineApi({
      decisions: server,
      post: (_url, init) => {
        posts.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    server.saveElsewhere({ "alpha/1:1/default": "approved" }); // the other tab approves
    act(() => result.current.decide("alpha/1:1/default", "rejected")); // this save will 409
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(posts).toHaveLength(1); // the first run only
    expect(result.current.regeneratingKeys).toBeNull();
    await waitFor(() =>
      expect(result.current.decisions).toEqual({ "alpha/1:1/default": "approved" }),
    );
    expect(server.stored()).toEqual({ "alpha/1:1/default": "approved" });
  });

  test("fetchDecisions keeps approved and rejected verdicts, and refuses an answer that is not a decision map", async () => {
    const answer = (body: unknown, status = 200) =>
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(body, status));
    answer({
      decisions: {
        "alpha/1:1/default": { verdict: "approved" },
        bad: { verdict: "bogus" },
        nul: null,
      },
      revision: "r",
    });
    await expect(fetchDecisions("seed")).resolves.toEqual({
      decisions: { "alpha/1:1/default": "approved" },
      revision: "r",
    });
    answer({ decisions: [], revision: null });
    await expect(fetchDecisions("seed")).rejects.toThrow(/not a decision map/);
    answer(null);
    await expect(fetchDecisions("seed")).rejects.toThrow(/not a decision map/);
    answer({ decisions: {}, revision: 7 });
    await expect(fetchDecisions("seed")).rejects.toThrow(/without a revision/);
    answer({ error: "down" }, 500);
    await expect(fetchDecisions("seed")).rejects.toThrow();
    answer({ error: "Campaign not found" }, 404);
    await expect(fetchDecisions("seed")).resolves.toEqual({
      decisions: {},
      revision: null,
    });
  });

  test("saveDecisions names the revision it read, answers a 409 as a conflict, and throws on anything else", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ decisions: {}, revision: "r2" }))
      .mockResolvedValueOnce(json({ error: "changed" }, 409))
      .mockResolvedValueOnce(json({ error: "down" }, 500));
    await expect(saveDecisions("seed", "r1", { k: "approved" })).resolves.toEqual({
      decisions: {},
      revision: "r2",
    });
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({
      campaignId: "seed",
      revision: "r1",
      decisions: { k: "approved" },
    });
    expect(spy.mock.calls[0]![1]!.method).toBe("PUT");
    await expect(saveDecisions("seed", "r1", {})).resolves.toBe("conflict");
    await expect(saveDecisions("seed", "r1", {})).rejects.toThrow();
  });

  test("regenerateRejected is a no-op when nothing is rejected", async () => {
    mockPipelineApi();
    const { result } = setup();
    // Let the mount restore's own job/result discovery settle first, so its calls
    // aren't mistaken for ones regenerateRejected made.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before); // no POST
  });

  test("regenerateRejected is a no-op when a run exists but nothing is rejected", async () => {
    mockPipelineApi({
      job: () => jobOk({ halted: false, assets: [asset()], log: { entries: [] } }),
    });
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
    mockPipelineApi({
      job: () =>
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }),
    });
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

  test("re-roll of a display cell sends its size as the canvas (D113)", async () => {
    const bodies: unknown[] = [];
    const leaderboard = asset({
      aspectRatio: undefined,
      size: "728x90",
      outputPath: "alpha/728x90.png",
    });
    mockPipelineApi({
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () => jobOk({ halted: false, assets: [leaderboard], log: { entries: [] } }),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    // The display cell keys — and re-rolls — by its size, never a ratio.
    expect(result.current.assets[0].outputPath).toBe("alpha/728x90.png");
    act(() => result.current.decide("alpha/728x90/default", "rejected"));
    await act(async () => {
      await result.current.regenerateRejected();
    });
    expect(bodies[1]).toEqual(
      expect.objectContaining({
        regenerateOnly: [{ productId: "alpha", size: "728x90", treatment: "default" }],
      }),
    );
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
        const body = JSON.parse(init.body as string) as {
          regenerateOnly?: Array<{ attempt?: number }>;
        };
        bodies.push(body);
        if (body.regenerateOnly?.[0]?.attempt !== undefined)
          servedAttempt = body.regenerateOnly[0].attempt;
        return json({ jobId: "job-1" }, 202);
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [
            {
              ...variant,
              attempt: servedAttempt,
              treatment: servedAttempt === 0 ? variant.treatment : "headline-bottom-bold",
            },
          ],
          log: { entries: [] },
        }),
    });
    const { result } = setup();
    // a variation run can only exist under a randomized brief
    act(() =>
      result.current.setBrief({
        ...result.current.brief,
        mode: "variation",
        variation: { count: 1 },
      } as never),
    );
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
    act(() =>
      result.current.setBrief({
        ...result.current.brief,
        mode: "variation",
        variation: { count: 1 },
      } as never),
    );
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
    mockPipelineApi({
      opened: openedCampaign({
        id: "seed",
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "Hi",
        products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
        // a variation run can only exist under a randomized brief, so the
        // campaign the pointer names is one — which is also why the restore can
        // stand on its own now that it is a server read (PT-5e) rather than a
        // synchronous local copy the test had to amend after mounting.
        mode: "variation",
        variation: { count: 1 },
      }),
      report: { halted: false, assets: [variant], log: { entries: [], campaignId: "seed" } },
      post: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ jobId: "job-1" }, 202);
      },
      job: () =>
        jobOk({ halted: false, assets: [{ ...variant, attempt: 4 }], log: { entries: [] } }),
    });
    const { result } = setup();
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
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        jobOk({
          halted: false,
          assets: [asset({ complianceScore: 0.9 })],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
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
    const body = bodies[1] as {
      brief: { id: string; campaignMessage: string };
      regenerateOnly: unknown[];
    };
    expect(body.brief).toMatchObject({
      id: "on-screen-draft",
      campaignMessage: "the draft as typed",
    });
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
      job: () =>
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }),
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
          assets: [
            asset({ variantIndex: 0, outputPath: "alpha/1x1/v0.png", complianceScore: 0.9 }),
          ],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
    });
    const { result } = setup();
    // The shell brief is classic; the draft is a randomized campaign. The run's mode
    // guard must ask the brief the run ran — the draft — not the shell's (R6).
    await act(async () => {
      await result.current.execute({
        ...onScreenDraft,
        mode: "variation",
        variation: { count: 1 },
      } as never);
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
      job: () =>
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.1 })], log: { entries: [] } }),
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
    // The re-roll goes out once the verdict that asked for it is saved (D173).
    await waitFor(() => expect(resolveRegen).toBeTypeOf("function"));
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "",
        targetRegion: "",
        targetAudience: "",
        campaignMessage: "",
        products: [],
      });
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
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      targetRegion: "FR",
      targetAudience: "x",
      campaignMessage: "y",
      products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
    };
    mockPipelineApi({ opened: openedCampaign(stored) });
    const { result } = setup();
    await waitFor(() => expect(result.current.brief.id).toBe("stored-brief"));
  });

  // PT-5e: there is no stored JSON left to be malformed — the server names the
  // campaign or it does not. A pointer read that FAILS restores nothing at all
  // (F6: could-not-ask is not absence), so the shell keeps the default brief
  // AND runs no default-brief discovery — the second half is what makes the
  // first able to fail.
  test("a failed pointer read leaves the shell on the default brief and starts no discovery", async () => {
    // `lastOpened`, not `result` (fix round, coderabbit PRRT_kwDOSzP1zc6nENjV):
    // the pointer URL is answered before any `result` handler runs, so `result`
    // left this read SUCCEEDING with `null` — and a null pointer is exactly the
    // path that starts `restoreDefaultBrief`, so the assertion below held for a
    // read that had not failed at all.
    mockPipelineApi({ lastOpened: () => Promise.reject(new Error("down")) });
    const { result } = setup();
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) => String(url).includes("/campaigns/last-opened")),
      ).toBe(true),
    );
    // A macrotask, so the read's rejection and its `.catch` have both run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.brief.id).toBe(DEFAULT_BRIEF.id);
    // No default-brief job lookup went out — the discovery a NULL pointer
    // starts, and a failed one must not.
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([url]) =>
          String(url).includes(`/campaigns/jobs?campaignId=${DEFAULT_BRIEF.id}`),
        ),
    ).toBe(false);
  });

  // Fix round (qodo #4). `setBrief` fired every `putLastOpened` as an unordered
  // fire-and-forget, so two rapid commits could reach the server out of order —
  // and the server's upsert keeps the LAST write to land, not the last one
  // issued. A slow first write therefore left the pointer naming the campaign
  // the user had already left. The writes are serialized instead, so the order
  // commits happen in is the order the server records.
  test("rapid switches record the last one opened even when the earlier write answers last (qodo #4)", async () => {
    const issued: string[] = [];
    const landed: string[] = [];
    const hold: (() => void)[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      const u = String(url);
      if ((init as RequestInit)?.method === "PUT" && u === `${API}/campaigns/last-opened`) {
        const campaignId = (
          JSON.parse(String((init as RequestInit).body)) as { campaignId: string }
        ).campaignId;
        issued.push(campaignId);
        // The FIRST pointer write is held until the test releases it, so an
        // unserialized implementation completes them in the opposite order.
        if (issued.length === 1) {
          return new Promise<Response>((res) => {
            hold.push(() => {
              landed.push(campaignId);
              res(json({ campaignId }));
            });
          });
        }
        landed.push(campaignId);
        return Promise.resolve(json({ campaignId }));
      }
      if (u === `${API}/campaigns/jobs`) return Promise.resolve(json({}));
      if (u === `${API}/campaigns/result`) return Promise.resolve(json(EMPTY_REPORT));
      return Promise.resolve(json(EMPTY_REPORT));
    });

    const { result } = setup();
    await act(async () => {
      result.current.setBrief({ ...DEFAULT_BRIEF, id: "first" });
      result.current.setBrief({ ...DEFAULT_BRIEF, id: "second" });
    });
    // Serialized: the second write has not gone out while the first is held.
    expect(issued).toEqual(["first"]);
    await act(async () => {
      for (const release of hold) release();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(issued).toEqual(["first", "second"]);
    // The server's row ends on the campaign the user actually opened last.
    expect(landed).toEqual(["first", "second"]);
  });

  test("the blank brief releases the shell but keeps the last-opened pointer (D37/H5)", async () => {
    const { result } = setup();
    const pointers = () =>
      vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url, init]) => {
          const u = String(url);
          return u.includes("/campaigns/last-opened") && (init as RequestInit)?.method === "PUT";
        })
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)).campaignId);
    await act(async () => {
      result.current.setBrief({
        id: "keeper",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      } as never);
    });
    expect(pointers()).toEqual(["keeper"]);

    // D37: the last-opened pointer is a convenience, never an address — the URL
    // names the open campaign. Releasing the shell's campaign (visiting
    // /brief/new opens none) must not destroy the pointer to the one the user
    // opened last: the bare routes follow it, and the shell restores from it.
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
    expect(pointers()).toEqual(["keeper"]); // unchanged: a blank brief writes none
  });

  test("setBrief keeps the current run when the id already matches", async () => {
    mockPipelineApi({
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "summer-hydration-2026" },
        }),
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

  test("restores the persisted run for the last-opened campaign on mount", async () => {
    mockPipelineApi({
      opened: openedCampaign({
        id: "stored",
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        targetRegion: "FR",
        targetAudience: "x",
        campaignMessage: "y",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      }),
      report: { halted: false, assets: [asset()], log: { entries: [], campaignId: "stored" } },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
  });

  /**
   * PT-5e (D173, D180) — the pointer is a SERVER record, per (org, user). These
   * are the two properties a `localStorage` record could not have, and the two
   * the lane is for.
   */
  test("the pointer survives a reload: a second mount, with no local record, restores the same campaign", async () => {
    mockPipelineApi({
      opened: openedCampaign({
        id: "durable",
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      }),
    });
    // A reload keeps localStorage but rebuilds every piece of state; a device
    // that has never seen this app has neither. Both must read the same
    // campaign off the server, which is the whole claim.
    localStorage.clear();
    const first = setup();
    await waitFor(() => expect(first.result.current.brief.id).toBe("durable"));
    first.unmount();
    localStorage.clear();
    const second = setup();
    await waitFor(() => expect(second.result.current.brief.id).toBe("durable"));
  });

  test("the pointer is per user: another user's session restores its own campaign, not this one's", async () => {
    // Two users in one org share every server resource but never a pointer row,
    // so "another device" is only another device for the SAME user.
    const mine = { id: "mine", template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE) };
    const theirs = { id: "theirs", template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE) };
    const pointer = { campaignId: "" };
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      const u = String(url);
      const method = (init as RequestInit)?.method ?? "GET";
      if (u.includes("/campaigns/last-opened") && method === "PUT") {
        pointer.campaignId = (
          JSON.parse(String((init as RequestInit).body)) as { campaignId: string }
        ).campaignId;
        return Promise.resolve(json({ campaignId: pointer.campaignId }));
      }
      if (u.includes("/campaigns/last-opened")) {
        // The server answers per session user, exactly as the real route does.
        return Promise.resolve(json({ campaignId: pointer.campaignId || null }));
      }
      if (u.includes("/campaigns/briefs")) {
        const brief = pointer.campaignId === "mine" ? mine : theirs;
        return Promise.resolve(
          json({ briefs: [{ file: `${brief.id}.json`, campaignId: brief.id, brief }] }),
        );
      }
      if (u.includes("/campaigns/")) {
        const id = u.slice(`${API}/campaigns/`.length);
        return Promise.resolve(
          json({ campaignId: id, slug: id, name: null, type: null, hasVersion: false }),
        );
      }
      return Promise.resolve(json(EMPTY_REPORT));
    });

    const { result } = setup();
    await act(async () => {
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "mine",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      } as never);
    });
    expect(pointer.campaignId).toBe("mine");
    // A different user then opens their own campaign: the pointer moves, and the
    // first user's is not what either of them reads afterwards.
    await act(async () => {
      result.current.setBrief({ ...theirs, targetRegion: "", targetAudience: "" } as never);
    });
    expect(pointer.campaignId).toBe("theirs");
  });

  // The no-pointer half of the restore (PT-5e). `DEFAULT_BRIEF` is a real
  // campaign to Generate — nothing gates it on `briefApplied` — so its run is
  // discovered exactly like any other campaign's, and the shell adopts it.
  test("a user with no pointer restores the default brief's own persisted run", async () => {
    mockPipelineApi({
      report: {
        halted: false,
        assets: [asset({ productId: "p1" })],
        log: { entries: [], campaignId: DEFAULT_BRIEF.id },
      },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.brief.id).toBe(DEFAULT_BRIEF.id);
  });

  test("a campaign opened while the default-brief job lookup is in flight wins", async () => {
    // The mount's discovery is guarded, not trusted: a campaign the user opens
    // while it is still asking about the default one supersedes it, and its
    // late answer must not start a poller for the campaign just left behind.
    // One pending answer PER job lookup — the mount's and the commit's own both
    // go out, and resolving the wrong one would answer a different campaign.
    const pending = new Map<string, (r: Response) => void>();
    mockPipelineApi({
      result: (url) => {
        if (!url.includes("/campaigns/jobs")) return Promise.resolve(json(EMPTY_REPORT));
        return new Promise<Response>((resolve) => pending.set(url, resolve));
      },
    });
    const mountLookup = `${API}/campaigns/jobs?campaignId=${DEFAULT_BRIEF.id}`;
    const { result } = setup();
    await waitFor(() => expect(pending.has(mountLookup)).toBe(true));
    act(() => {
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "opened-in-the-meantime",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      } as never);
    });
    // The mount's own late answer, naming a job for the campaign left behind.
    pending.get(mountLookup)!(json({ jobId: "job-for-the-campaign-left-behind" }));
    // A macrotask, so the whole lookup chain settles before the answer is
    // judged — a single microtask leaves the parse half of it in flight.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.brief.id).toBe("opened-in-the-meantime");
    expect(result.current.loading).toBe(false);
  });

  test("a failed default-brief read that lands after a campaign was opened commits nothing", async () => {
    // The read failed AND it is stale: F6 says a read that cannot be trusted
    // claims nothing, so neither a run nor a membership notice may come from
    // it. (A failure that is NOT stale still names the denial — setBrief's own
    // catch covers that, and is asserted above.)
    let rejectResult: ((reason: unknown) => void) | undefined;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/result")
          ? new Promise<Response>((_resolve, reject) => {
              rejectResult = reject;
            })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    await waitFor(() => expect(rejectResult).toBeTypeOf("function"));
    act(() => {
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "opened-in-the-meantime",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "m",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      } as never);
    });
    rejectResult!(new Error("down"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.brief.id).toBe("opened-in-the-meantime");
    expect(result.current.assets).toEqual([]);
    expect(result.current.membershipError).toBeNull();
  });

  test("a pointer answer that is not a campaign object reads as no pointer", async () => {
    // The lenient parse, in the shell's own terms: this server never answers
    // that way, so reading it as "no pointer" is the same best-effort stance
    // every other untrusted field here already takes — never a hard failure
    // over a page the user is only trying to load.
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      String(url).includes("/campaigns/last-opened")
        ? Promise.resolve(json("not a pointer"))
        : Promise.resolve(json(EMPTY_REPORT)),
    );
    const { result } = setup();
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) => String(url).includes("/campaigns/last-opened")),
      ).toBe(true),
    );
    expect(result.current.brief.id).toBe(DEFAULT_BRIEF.id);
  });

  test("setBrief loads the target brief's own persisted run", async () => {
    mockPipelineApi({
      result: (url) =>
        url.includes("campaignId=other")
          ? json({
              halted: false,
              assets: [asset({ productId: "beta" })],
              log: { entries: [], campaignId: "other" },
            })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        return body.regenerateOnly
          ? new Response("boom", { status: 500 })
          : json({ jobId: "job-1" }, 202);
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
      job: () =>
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.1 })], log: { entries: [] } }),
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
    // The re-roll goes out once the verdict that asked for it is saved (D173).
    await waitFor(() => expect(resolveRegen).toBeTypeOf("function"));
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
  const haltedRun = (id: string) =>
    json({ halted: true, assets: [], log: { entries: [], campaignId: id } });

  test("restores a halted, log-only run on mount (no assets, no version bump)", async () => {
    mockPipelineApi({
      opened: openedCampaign({
        id: "halted",
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        targetRegion: "FR",
        targetAudience: "x",
        campaignMessage: "y",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      }),
      report: { halted: true, assets: [], log: { entries: [], campaignId: "halted" } },
    });
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    // The re-roll goes out once the verdict that asked for it is saved (D173).
    await waitFor(() => expect(rejectRegen).toBeTypeOf("function"));
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        if (url.includes("campaignId=first"))
          return new Promise<Response>((res) => resolvers.push(res));
        return json(EMPTY_REPORT);
      },
    });
    const mk = (id: string) => ({
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
      resolvers.forEach((r) =>
        r(json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "first" } })),
      );
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
    mockPipelineApi({
      job: () =>
        json({ status: "failed", done: 0, total: 0, log: null, error: "need two products" }),
    });
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
    // A lost job wrote no report, so the server retired nothing.
    const server = fakeDecisionsApi({ "alpha/1:1/default": "rejected" });
    server.retire = () => undefined;
    mockPipelineApi({
      decisions: server,
      post: () => {
        posted = true;
        return json({ jobId: "job-1" }, 202);
      },
      job: () => json({ error: "not found" }, 404),
      result: (url) =>
        posted && String(url).includes("campaignId=summer-hydration-2026")
          ? json({
              halted: false,
              assets: [asset()],
              log: { entries: [], campaignId: "summer-hydration-2026" },
            })
          : json(EMPTY_REPORT),
    });
    const { result } = setup();
    // The mount restore is a server read now (PT-5e), so it is still in flight
    // here; let it finish before sampling the version, or this would measure
    // the restore's own bump rather than the lost job's silence.
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) =>
            String(url).includes("/campaigns/result?campaignId=summer-hydration-2026"),
          ),
      ).toBe(true),
    );
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
          ? json({
              halted: true,
              assets: [],
              log: { entries: [], campaignId: "summer-hydration-2026" },
            })
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
      result: () =>
        json({ halted: false, assets: [asset()], log: { entries: [], campaignId: "other" } }),
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
      post: () =>
        json({ error: 'A run for campaign "summer-hydration-2026" is already in progress.' }, 409),
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
      resolveJob(
        jobOk({ halted: false, assets: [asset({ complianceScore: 0.9 })], log: { entries: [] } }),
      );
      await regen;
    });
    expect(result.current.assets).toHaveLength(0); // the switched brief has no run
    expect(result.current.regeneratingKeys).toBeNull();
  });

  test("a lost re-roll leaves the grid and the rejected decisions untouched", async () => {
    mockPipelineApi({
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "summer-hydration-2026" },
        }),
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
    mockPipelineApi({
      job: () => ((polls += 1), json({ status: "running", done: 0, total: 0, log: null })),
    });
    const { result } = setup();
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    expect(polls).toBe(1);
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
        json({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "summer-hydration-2026" },
        }),
      );
      await exec;
    });
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("unmounting the provider aborts an in-flight poller", async () => {
    vi.useFakeTimers();
    let polls = 0;
    mockPipelineApi({
      job: () => ((polls += 1), json({ status: "running", done: 0, total: 0, log: null })),
    });
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    expect(result.current.packages.map((p) => p.platformId).sort()).toEqual([
      "instagram-feed",
      "linkedin",
    ]);
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
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
    // Found by URL, not position: mount's own (unrelated) job/result discovery calls
    // race this one and can land after it in the mock's call log.
    const packagesCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([u]) => String(u).includes("/campaigns/packages"));
    const signal = (packagesCall?.[1] as RequestInit | undefined)?.signal;
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
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
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
    expect(bodies[0]).toMatchObject({
      campaignId: "on-screen-draft",
      platforms: ["instagram-feed"],
    });
  });

  test("loadPackages lists the packages of the campaign the run ran under (R6)", async () => {
    const urls: string[] = [];
    mockPipelineApi({
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "on-screen-draft" },
        }),
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
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
      mockPipelineApi({
        opened: openedCampaign(variationStoredBrief),
        report: { halted: false, assets: [asset()], log: { entries: [], campaignId: "camp" } },
      });
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
      mockPipelineApi({
        opened: openedCampaign({
          id: "camp",
          template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
          targetRegion: "DE",
          targetAudience: "a",
          campaignMessage: "Hi",
          products: variationStoredBrief.products,
        }),
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
        result.current.setBrief({
          ...result.current.brief,
          id: "camp",
          mode: "variation",
          variation: { count: 1 },
        } as never),
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
        job: () =>
          jobOk({
            halted: false,
            assets: [asset({ complianceScore: 0.9 })],
            log: { entries: [], campaignId: "camp" },
          }),
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
        result.current.setBrief({
          ...result.current.brief,
          mode: "variation",
          variation: { count: 1 },
        } as never),
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

  /**
   * D213: every completed run is committed from a re-read of
   * `GET /campaigns/result`, never from the job payload.
   *
   * **These assert on the committed run STATE, not on a rendered `src`.** The
   * consumers of the `*Url` fields are PT-4g2's; what PT-4g1 owns is that the state
   * the context holds is the server-merged, URL-bearing one. The claim is therefore
   * "the run on screen came from the result route", and a rendered `src` would be a
   * statement about a consumer this lane does not touch.
   *
   * **The job payload in every fixture is deliberately distinguishable from the
   * result's** — a different compliance score as well as a missing `outputUrl` — so a
   * commit that took the wrong one fails on the score too, and not only on the field
   * D213 is about.
   */
  describe("D213: the commit comes from the result route, not the job payload", () => {
    /** The row the JOBS route answers: paths, a marker score, and no `*Url` at all. */
    const inJob = (over: Partial<Asset> = {}): Asset =>
      asset({ productId: "p1", outputPath: "p1/1x1.png", complianceScore: 0.1, ...over });

    /**
     * A campaign of its own for the run under test, so no OTHER read can answer for it.
     *
     * **A report is keyed by campaign, and a shell under test has at least two
     * campaigns in play.** On mount the provider asks for the last-opened pointer and,
     * finding none, runs `restoreDefaultBrief`'s own discovery for `DEFAULT_BRIEF` —
     * a job lookup and a persisted-run read that race `execute` and can commit their
     * own row. Those reads target `DEFAULT_BRIEF`, so keying this test's report to
     * {@link RUN_CAMPAIGN} means only `execute`'s own re-read can answer the
     * assertions below. Without that, the mount restore commits the result's row
     * first, every assertion passes, and removing D213's commit entirely still
     * leaves the test green (Qodo's finding, one level deeper than it was reported:
     * the job and the result agreeing is only half of it).
     */
    const RUN_CAMPAIGN = "d213-campaign";
    /** Move the shell onto {@link RUN_CAMPAIGN} so `execute` runs that campaign. */
    const underTestCampaign = async (result: {
      current: ReturnType<typeof useRun>;
    }): Promise<void> => {
      await act(async () => {
        result.current.setBrief({ ...result.current.brief, id: RUN_CAMPAIGN } as never);
      });
    };
    /** True for the `/campaigns/result` read that belongs to {@link RUN_CAMPAIGN}. */
    const readsRunCampaign = (url: string): boolean =>
      String(url).includes(`campaignId=${RUN_CAMPAIGN}`);

    /**
     * Three DIFFERENT bodies, because the two routes answer different things: the
     * JOBS route returns the job as stored (paths only — `jobOk` strips every `*Url`,
     * and the score here is `inJob`'s marker), and the RESULT route returns the
     * server-merged report with the URLs it mints. The store's copy moves only when
     * the generate POST goes out, which is how the real server behaves
     * (`generate.post.ts` writes the report, THEN completes the job).
     *
     * **A test that hands both handlers the same assets asserts nothing about which
     * one the commit came from** — the job payload would carry the URLs and the score
     * and pass every line (Qodo). `job` is therefore a separate argument.
     */
    const store = (before: unknown[], inTheJob: unknown[], after: unknown[]) => {
      let current = before;
      const report = (assets: unknown[]) =>
        json({
          halted: false,
          assets,
          log: { entries: [], campaignId: RUN_CAMPAIGN },
        });
      return {
        post: () => {
          current = after;
          return json({ jobId: "job-1" }, 202);
        },
        job: () =>
          jobOk({
            halted: false,
            assets: inTheJob,
            log: { entries: [], campaignId: RUN_CAMPAIGN },
          }),
        // Another campaign's read is answered "nothing on disk", which is what a real
        // `/campaigns/result?campaignId=` says about a campaign it has no report for.
        result: (url: string) => (readsRunCampaign(url) ? report(current) : json(EMPTY_REPORT)),
      };
    };

    test("after Generate the tile shows result.get's outputUrl, not the job's", async () => {
      // The JOB's body: paths, and the marker score. The RESULT's: the merged row with
      // `s3`-shaped URLs and the score under assertion. They differ on EVERY field the
      // assertions below name, so a commit from either one is identifiable.
      const inTheJob = inJob({ complianceScore: 0.1 });
      const merged = { ...inJob({ complianceScore: 0.9 }), ...s3Urls(inJob()) };
      mockPipelineApi(store([inJob()], [inTheJob], [merged]));

      const { result } = setup();
      await underTestCampaign(result);
      await act(async () => {
        await result.current.execute();
      });

      const committed = result.current.assets[0]!;
      // The score is the RESULT route's, and provably not the job's own — so the
      // committed row is not the job payload, whichever way the URLs below resolve.
      expect(committed.complianceScore).toBe(0.9);
      expect(committed.complianceScore).not.toBe(inTheJob.complianceScore);
      // And the URL is the result's, which the jobs route cannot have signed at all.
      expect(committed.outputUrl).toBe(merged.outputUrl);
      expect(committed.outputUrl).toBeDefined();
      // A `s3`-shaped URL on the store's own origin, not a client-built `/output/`
      // path: the fixture's shape is the assertion, not just its presence.
      expect(committed.outputUrl).toContain("https://objects.example/");
      expect(committed.outputDownloadUrl).toBe(merged.outputDownloadUrl);
      // The D212 pair really does differ here, so a commit that reached for the
      // DISPLAY url where the download belongs would fail here and not pass quietly.
      expect(committed.outputDownloadUrl).not.toBe(committed.outputUrl);
    });

    test("a re-roll commits the re-read too, and keeps decisions on untouched cells", async () => {
      const first = inJob({ productId: "p1" });
      const second = inJob({ productId: "p2", outputPath: "p2/1x1.png" });
      const seeded = seedPersistedRun([first, second], {
        decisions: { "p1/1:1/default": "rejected" },
      });
      // The server's merged report after the re-roll: p1 regenerated, p2 untouched, and
      // BOTH carrying the URLs `result.get` mints — the ones the job payload cannot hold.
      const merged = [first, second].map((row) => ({
        ...row,
        ...s3Urls(row, "rev-after-reroll"),
      }));
      let current: unknown[] = [first, second];
      mockPipelineApi({
        opened: seeded,
        post: () => {
          current = merged;
          return json({ jobId: "job-2" }, 202);
        },
        job: () =>
          jobOk({
            halted: false,
            assets: [merged[0]],
            log: { entries: [], campaignId: "seed" },
          }),
        result: () =>
          json({ halted: false, assets: current, log: { entries: [], campaignId: "seed" } }),
      });
      const { result } = setup();
      await waitFor(() => expect(result.current.assets).toHaveLength(2));
      // The verdict that asked for this re-roll, so the re-roll has something to do.
      act(() => result.current.decide("p1/1:1/default", "rejected"));
      act(() => result.current.decide("p2/1:1/default", "approved"));

      await act(async () => {
        await result.current.regenerateRejected();
      });

      const byId = new Map(result.current.assets.map((a) => [a.productId, a] as const));
      // The re-rolled cell carries the NEW revision's URL. The job handler above is
      // handed the same merged row, so `jobOk`'s strip is what makes this a re-read
      // assertion rather than a tautology: the job payload that reached the shell held
      // no `outputUrl` at all, so only the result read can have supplied this one.
      expect(byId.get("p1")?.outputUrl).toBe(merged[0]!.outputUrl);
      expect(byId.get("p1")?.outputUrl).toContain("v=rev-after-reroll");
      // The untouched cell is committed from the same read and still has its URL, and
      // the decisions on screen survive: p1 returns to review, p2 keeps its approval.
      // p2 is in NO job payload at all, so a job overlay could not have produced it.
      expect(byId.get("p2")?.outputUrl).toBe(merged[1]!.outputUrl);
      expect(result.current.decisions["p1/1:1/default"]).toBeUndefined();
      expect(result.current.decisions["p2/1:1/default"]).toBe("approved");
    });

    test("a re-read that fails or answers nothing commits the job payload — with no URLs", async () => {
      // Both degraded answers, one at a time: a 500 is "could not ask" and an empty
      // report is "nothing there", and neither may be reported as a successful re-read.
      for (const [name, answer] of [
        ["500", () => json({ error: "boom" }, 500)],
        ["null", () => json(EMPTY_REPORT)],
      ] as const) {
        const payload = inJob({ complianceScore: 0.1 });
        const { result } = setup();
        mockPipelineApi({
          post: () => json({ jobId: "job-1" }, 202),
          job: () =>
            jobOk({
              halted: false,
              assets: [payload],
              log: { entries: [], campaignId: DEFAULT_BRIEF.id },
            }),
          result: answer,
        });
        await act(async () => {
          await result.current.execute();
        });

        // The job payload IS committed — that is the honest degraded state, not a
        // failure — and it carries PATHS and no `*Url`, because the jobs route signs
        // nothing. A consumer must therefore render a placeholder here (PT-4g2) rather
        // than build a `/output/` URL of its own.
        expect(result.current.assets, name).toHaveLength(1);
        expect(result.current.assets[0].outputPath, name).toBe("p1/1x1.png");
        expect(result.current.assets[0].outputUrl, name).toBeUndefined();
        expect(result.current.assets[0].outputDownloadUrl, name).toBeUndefined();
        expect(result.current.error, name).toBeNull();
        vi.restoreAllMocks();
      }
    });

    test("a 403 no_membership on the re-roll's re-read shows the notice and commits nothing", async () => {
      const rejected = inJob({ productId: "p1" });
      const other = inJob({ productId: "p2", outputPath: "p2/1x1.png" });
      const seeded = seedPersistedRun([rejected, other], {
        decisions: { "p1/1:1/default": "rejected" },
      });
      let denied = false;
      mockPipelineApi({
        opened: seeded,
        post: () => {
          denied = true;
          return json({ jobId: "job-2" }, 202);
        },
        job: () =>
          jobOk({
            halted: false,
            assets: [{ ...rejected, complianceScore: 0.9 }],
            log: { entries: [], campaignId: "seed" },
          }),
        // The mount restore reads BEFORE the re-roll goes out, and must succeed; only
        // the re-read after it is denied, which is the case D213 has to get right.
        result: () =>
          denied
            ? json(
                { error: "This account belongs to no organisation.", code: "no_membership" },
                403,
              )
            : json({
                halted: false,
                assets: [rejected, other],
                log: { entries: [], campaignId: "seed" },
              }),
      });
      const { result } = setup();
      await waitFor(() => expect(result.current.assets).toHaveLength(2));
      act(() => result.current.decide("p1/1:1/default", "rejected"));

      await act(async () => {
        await result.current.regenerateRejected();
      });

      await waitFor(() => expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE));
      // Nothing committed: the job's own payload is never a fallback on a denial, and
      // the run already on screen is left exactly as it was.
      expect(result.current.assets).toHaveLength(2);
      expect(result.current.assets[0].complianceScore).toBe(0.1);
      expect(result.current.assets[0].outputUrl).toBeUndefined();
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    test("the jobs route is asked for the run and the result route for the commit — never the reverse", async () => {
      // The order is the claim: the job decides THAT a run finished, and the result
      // decides WHAT is on screen. Recorded as ONE timeline from both handlers, so a
      // re-read issued before the job completed shows up as a wrong order.
      const merged = { ...inJob({ complianceScore: 0.9 }), ...fsUrls(inJob(), FS_REVISION) };
      const asked: string[] = [];
      mockPipelineApi({
        post: () => json({ jobId: "job-1" }, 202),
        job: () => {
          asked.push("job");
          return jobOk({
            halted: false,
            assets: [inJob()],
            log: { entries: [], campaignId: RUN_CAMPAIGN },
          });
        },
        result: (url) => {
          asked.push(String(url));
          // Keyed to the run's own campaign, so the mount restore's reads for
          // `DEFAULT_BRIEF` commit nothing and the only commit under test is the one
          // `execute`'s re-read makes.
          return readsRunCampaign(url)
            ? json({
                halted: false,
                assets: [merged],
                log: { entries: [], campaignId: RUN_CAMPAIGN },
              })
            : json(EMPTY_REPORT);
        },
      });

      const { result } = setup();
      await underTestCampaign(result);
      await act(async () => {
        await result.current.execute();
      });

      const isResultRead = (entry: string): boolean =>
        entry.includes("/campaigns/result?campaignId=");
      expect(asked.filter(isResultRead).length).toBeGreaterThan(0);
      // The job answered BEFORE the last read, and the last read is the re-read — which
      // is what "committed from the result route" means as a sequence.
      expect(asked.indexOf("job")).toBeGreaterThanOrEqual(0);
      expect(asked.indexOf("job")).toBeLessThan(asked.length - 1);
      expect(isResultRead(asked[asked.length - 1]!)).toBe(true);
      // And the committed URL is the fs shape — the same string the route builds, with
      // the report revision as its one query — so a client-built `?v=<counter>` would
      // be a different string.
      expect(result.current.assets[0].outputUrl).toBe(
        `/api/pipeline/output/p1/1x1.png?v=${FS_REVISION}`,
      );
      expect(result.current.assets[0].outputUrl).toBe(merged.outputUrl);
    });

    test("a re-roll whose re-read FAILS overlays the job payload, keeping untouched cells", async () => {
      // The other degraded answer, and the only one that reaches today's merge: a
      // 403 membership denial returns above it, and a re-read that ANSWERS takes the
      // whole server-merged report. What is left is "could not ask", where the
      // re-rolled cells can only come from the job payload — paths and no `*Url`, so
      // PT-4g2's consumers render placeholders rather than build their own URLs.
      const rejected = inJob({ productId: "p1" });
      const other = inJob({ productId: "p2", outputPath: "p2/1x1.png" });
      const seeded = seedPersistedRun([rejected, other], {
        decisions: { "p1/1:1/default": "rejected" },
      });
      let rerollPosted = false;
      mockPipelineApi({
        opened: seeded,
        post: () => {
          rerollPosted = true;
          return json({ jobId: "job-1" }, 202);
        },
        // The job answers with ONLY the regenerated cell, as the server's re-roll does.
        job: () =>
          jobOk({
            halted: false,
            assets: [{ ...rejected, complianceScore: 0.9 }],
            log: { entries: [], campaignId: "seed" },
          }),
        result: () =>
          rerollPosted
            ? json({ error: "boom" }, 500)
            : json({
                halted: false,
                assets: [rejected, other],
                log: { entries: [], campaignId: "seed" },
              }),
      });
      const { result } = setup();
      await waitFor(() => expect(result.current.assets).toHaveLength(2));
      act(() => result.current.decide("p1/1:1/default", "rejected"));

      await act(async () => {
        await result.current.regenerateRejected();
      });

      const byId = new Map(result.current.assets.map((a) => [a.productId, a] as const));
      // The overlay ran: p1 is the re-rolled row from the JOB payload and p2 survived.
      expect(result.current.assets).toHaveLength(2);
      expect(byId.get("p1")?.complianceScore).toBe(0.9);
      expect(byId.get("p2")?.outputPath).toBe("p2/1x1.png");
      // And the degraded state is honest about it: the overlaid row came from the JOB
      // payload, which `jobOk` has already stripped of every `*Url` because the jobs
      // route signs none — so the absence here is the route's contract, not a gap in
      // the fixture. A client-built `/output/` URL is the 404 D213 forbids.
      expect(byId.get("p1")?.outputUrl).toBeUndefined();
      expect(byId.get("p1")?.outputDownloadUrl).toBeUndefined();
      expect(byId.get("p2")?.outputUrl).toBeUndefined();
      // A failed READ is not a complaint: the grid is committed and the error slot is
      // clear, exactly as in `adoptJob`'s own fallback.
      expect(result.current.error).toBeNull();
      expect(result.current.membershipError).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    test("a re-roll whose re-read lands after a newer run has started commits nothing", async () => {
      // The concurrency question D213 adds: the re-read is an await AFTER the job
      // settles, and a re-roll that started earlier can still have it in flight when
      // the user presses Generate again. The seq guard is the ONLY thing between that
      // late answer and the newer run's grid — so the second actor is stacked here
      // rather than assumed, and the assertion is that the newer run's committed row
      // is the one still on screen.
      const rejected = inJob({ productId: "p1" });
      const other = inJob({ productId: "p2", outputPath: "p2/1x1.png" });
      const rerolled = { ...rejected, complianceScore: 0.9, ...s3Urls(rejected, "rev-reroll") };
      const newer = {
        ...inJob({ productId: "p3", outputPath: "p3/1x1.png", complianceScore: 0.4 }),
      };
      const seeded = seedPersistedRun([rejected, other], {
        decisions: { "p1/1:1/default": "rejected" },
      });
      const onDisk = (assets: unknown[]) =>
        json({ halted: false, assets, log: { entries: [], campaignId: "seed" } });
      // The re-roll's own re-read, held open until the newer run has committed.
      let resolveReRead!: (r: Response) => void;
      const heldReRead = new Promise<Response>((r) => {
        resolveReRead = r;
      });
      let rerollPosted = false;
      let held = false;
      let posts = 0;
      mockPipelineApi({
        opened: seeded,
        post: () => {
          posts += 1;
          rerollPosted = true;
          return json({ jobId: `job-${posts}` }, 202);
        },
        job: (url) =>
          jobOk({
            halted: false,
            assets: [url.includes("job-1") ? rerolled : newer],
            log: { entries: [], campaignId: "seed" },
          }),
        result: () => {
          // Before the re-roll goes out: the seeded report the mount restore wants.
          if (!rerollPosted) return onDisk([rejected, other]);
          // The re-roll's re-read, held. Everything after it is the newer run's.
          if (!held) {
            held = true;
            return heldReRead;
          }
          return onDisk([newer]);
        },
      });
      const { result } = setup();
      await waitFor(() => expect(result.current.assets).toHaveLength(2));
      act(() => result.current.decide("p1/1:1/default", "rejected"));

      let regen!: Promise<void>;
      act(() => {
        regen = result.current.regenerateRejected();
      });
      // The re-read is now in flight and the re-roll is waiting on it.
      await waitFor(() => expect(held).toBe(true));

      // The second actor: a fresh Generate, which claims the run with its own token.
      await act(async () => {
        await result.current.execute();
      });
      expect(result.current.assets[0].productId).toBe("p3");

      // Now let the re-roll's re-read land. It is a perfectly good answer to a
      // question nobody is asking any more.
      await act(async () => {
        resolveReRead(onDisk([rerolled]));
        await regen;
      });

      // The newer run still owns the screen: the late re-read committed nothing, and
      // in particular did not put the older campaign's cells back under it.
      expect(result.current.assets).toHaveLength(1);
      expect(result.current.assets[0].productId).toBe("p3");
      expect(result.current.assets[0].complianceScore).toBe(0.4);
      expect(result.current.loading).toBe(false);
    });

    test("a re-run moves the committed URL, and the same revision leaves it alone", async () => {
      // Cache busting is the revision's job (D209a/c): every run writes a new report,
      // so a re-run must hand the browser a DIFFERENT URL for the same path — or the
      // bytes behind it stay cached and the grid shows the previous creative. Asserted
      // on the committed state, since the `src` that consumes it is PT-4g2's.
      let revision = "rev-1";
      const row = inJob();
      mockPipelineApi({
        post: () => json({ jobId: "job-1" }, 202),
        job: () =>
          jobOk({
            halted: false,
            assets: [row],
            log: { entries: [], campaignId: RUN_CAMPAIGN },
          }),
        // Keyed to the run's own campaign, so the mount restore's reads for
        // `DEFAULT_BRIEF` commit nothing and every URL observed below came from a
        // re-read `execute` made.
        result: (url) =>
          readsRunCampaign(url)
            ? json({
                halted: false,
                assets: [{ ...row, ...s3Urls(row, revision) }],
                log: { entries: [], campaignId: RUN_CAMPAIGN },
              })
            : json(EMPTY_REPORT),
      });

      const { result } = setup();
      await underTestCampaign(result);
      await act(async () => {
        await result.current.execute();
      });
      const first = result.current.assets[0].outputUrl;

      // Same revision: the same report, so the same URL — a re-read that invented a
      // fresh query here would defeat the browser cache D204 is built on.
      await act(async () => {
        await result.current.execute();
      });
      expect(result.current.assets[0].outputUrl).toBe(first);

      // A new revision: a new URL, over the same path. Exactly the signed `v` that
      // differs, which is what makes the fetch happen.
      revision = "rev-2";
      await act(async () => {
        await result.current.execute();
      });
      expect(result.current.assets[0].outputUrl).not.toBe(first);
      expect(result.current.assets[0].outputUrl).toContain("v=rev-2");
      expect(result.current.assets[0].outputPath).toBe("p1/1x1.png"); // the path did not move
    });
  });
});

describe("RunProvider — a second Generate does not lose the campaign (C4)", () => {
  /** Commits a brief the way Apply does — the one thing that turns Generate into a run. */
  const ApplyBrief = () => {
    const { brief, setBrief } = useRun();
    return (
      <button type="button" onClick={() => setBrief({ ...brief, id: "applied-brief" })}>
        apply
      </button>
    );
  };

  /**
   * SG9 — this pressed the HEADER's Generate against the bar's Execute. SG-D10 took the
   * header verb out, so the second presser is a bare `execute()` from the provider's own
   * hook: what the test measures is the PROVIDER's token discipline (two POSTs in one
   * tick, one adopted run), and that was never a property of which button fired it. The
   * two real run verbs left in the app — the bar's Execute and the editor's Generate —
   * live in two different routes and cannot be pressed in the same tick anyway.
   */
  const RunNow = () => {
    const { execute } = useRun();
    return (
      <button type="button" onClick={() => void execute()}>
        run now
      </button>
    );
  };

  test("a second run verb fired in the same tick leaves one run and shows its result", async () => {
    const user = userEvent.setup();
    // Both POSTs are held so the two run verbs fire while both are in flight — the
    // exact state a double press creates. The real server serializes them: the first
    // POST finds no running job and answers 202; the second is refused 409, carrying
    // the running job's handle.
    const postAnswers: Array<(r: Response) => void> = [];
    mockPipelineApi({
      post: () => new Promise<Response>((res) => postAnswers.push(res)),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "applied-brief" },
        }),
    });
    renderWithRun(
      <>
        <ApplyBrief />
        <RunNow />
        <CommandBar onToggleTelemetry={() => {}} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));
    // The bar's Execute opens its confirm; the verb that actually runs is the dialog's
    // Generate — never disabled by loading. Both stay pressable while a run is in
    // flight: exactly how a campaign gets pressed twice.
    await user.click(screen.getByRole("button", { name: /Execute/ }));
    const secondPress = screen.getByRole("button", { name: "run now" });
    const dialogGenerate = within(
      screen.getByRole("dialog", { name: "Confirm pipeline action" }),
    ).getByText("Generate");
    // One tick: both presses dispatch in the same synchronous burst, before React can
    // flush the first press's loading state or either POST can answer.
    act(() => {
      secondPress.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("RunProvider — run progress", () => {
  test("a running snapshot's counts reach the context, and clear when the run settles", async () => {
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        // The first snapshot is mid-run; the poller keeps going until a settled
        // one arrives, so this is the shape a real run spends its life in.
        if (polls === 1) return json({ status: "running", done: 2, total: 5, log: null });
        return jobOk({ halted: false, assets: [asset()], log: { entries: [] } });
      },
    });
    const { result } = setup();
    let exec!: Promise<void>;
    act(() => {
      exec = result.current.execute();
    });
    await waitFor(() => expect(result.current.progress).toEqual({ done: 2, total: 5 }));
    await act(async () => {
      await exec;
    });
    // Progress belongs to a run in flight; a finished run shows its assets.
    expect(result.current.progress).toBeNull();
    expect(result.current.assets).toHaveLength(1);
  });

  test("a running snapshot with no counts leaves progress alone", async () => {
    let polls = 0;
    mockPipelineApi({
      job: () => {
        polls += 1;
        // A proxy or an older API can answer 200 without the counters; the
        // poller treats it as a running snapshot and shows nothing rather than
        // inventing a number.
        if (polls === 1) return json({ status: "running" });
        return jobOk({ halted: false, assets: [asset()], log: { entries: [] } });
      },
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.progress).toBeNull();
    expect(result.current.assets).toHaveLength(1);
  });
});

describe("normalizeRunResult — D136 advisories are persisted JSON", () => {
  test("a well-formed list survives", () => {
    const [row] = normalizeRunResult({
      halted: false,
      assets: [asset({ occlusionAdvisories: ["Shade mutes the headline."] })],
    }).assets;
    expect(row!.occlusionAdvisories).toEqual(["Shade mutes the headline."]);
  });

  test("a hand-edited report handing back a string drops the key instead of rendering it", () => {
    // The compliance page maps over this. A string would take the whole page
    // down at render, which is the class `assetCanvas({})`'s fallback exists
    // for — repaired here, where the repair lives.
    const [row] = normalizeRunResult({
      halted: false,
      assets: [asset({ occlusionAdvisories: "not a list" as never })],
    }).assets;
    expect(row!.occlusionAdvisories).toBeUndefined();
  });

  test("a list with a non-string member is dropped whole", () => {
    const [row] = normalizeRunResult({
      halted: false,
      assets: [asset({ occlusionAdvisories: ["fine", 7 as never] })],
    }).assets;
    expect(row!.occlusionAdvisories).toBeUndefined();
  });
});

describe("run-context 401 and 403 pipeline error handling", () => {
  // Several tests here stub `window` wholesale (`vi.stubGlobal`) to capture a redirect
  // without a real navigation — undo it after each, or a later test in this file that
  // reads `window.location` for real gets the previous test's stub instead.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetchPersistedRun on 401 unauthenticated routes to /sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });
    mockPipelineApi({
      result: () => json({ error: "Sign in required.", code: "unauthenticated" }, 401),
    });
    await expect(fetchPersistedRun("camp")).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });

  test("fetchPersistedRun on 403 no_membership surfaces organisation error and not pipeline unreachable", async () => {
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    await expect(fetchPersistedRun("camp")).rejects.toThrow(/organisation/i);
    await expect(fetchPersistedRun("camp")).rejects.not.toThrow(/Pipeline API unreachable/);
  });

  test("fetchDecisions and saveDecisions handle 401 and 403", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({ error: "Sign in required.", code: "unauthenticated" }, 401),
    );
    await expect(fetchDecisions("camp")).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/sign-in");

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    );
    await expect(fetchDecisions("camp")).rejects.toThrow(/organisation/i);

    assign.mockClear();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({ error: "Sign in required.", code: "unauthenticated" }, 401),
    );
    await expect(saveDecisions("camp", null, {})).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/sign-in");

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    );
    await expect(saveDecisions("camp", null, {})).rejects.toThrow(/organisation/i);
  });

  test("execute on 401 routes to /sign-in and on 403 shows no organisation yet state", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });

    mockPipelineApi({
      post: () => json({ error: "Sign in required.", code: "unauthenticated" }, 401),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(assign).toHaveBeenCalledWith("/sign-in");

    mockPipelineApi({
      post: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("This account belongs to no organisation.");
    expect(result.current.error).not.toMatch(/Pipeline API unreachable/);
  });

  test("pollJob on 401 routes to /sign-in and on 403 fails run with organisation error", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });

    mockPipelineApi({
      post: () => json({ jobId: "job-1" }, 202),
      job: () => json({ error: "Sign in required.", code: "unauthenticated" }, 401),
    });
    const { result } = setup();
    await act(async () => {
      await result.current.execute();
    });
    expect(assign).toHaveBeenCalledWith("/sign-in");

    mockPipelineApi({
      post: () => json({ jobId: "job-2" }, 202),
      job: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.error).toBe("This account belongs to no organisation.");
  });

  test("setBrief catches a 403 no_membership as a typed membership error, in its own state", async () => {
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    const { result } = setup();
    await act(async () => {
      result.current.setBrief({ ...result.current.brief, id: "other-camp" });
    });
    // PT-1b2 item 3: the fixed constant, in `membershipError` — never the pipeline
    // `error` slot, and never the server's own message text (which this asserts by
    // being IN a distinct field, not by string content).
    expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    expect(result.current.error).toBeNull();
  });

  test("setBrief detects a 403 no_membership by code, not by matching the server's wording", async () => {
    // The old detection was `/organisation/i.test(err.message)` against the server's
    // own string — a server that reworded it to American spelling ("organization")
    // would silently fail to match and the state would never show. This response uses
    // that exact reworded spelling; only a `code`-based check catches it.
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organization.", code: "no_membership" }, 403),
    });
    const { result } = setup();
    await act(async () => {
      result.current.setBrief({ ...result.current.brief, id: "reworded-camp" });
    });
    expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    expect(result.current.error).toBeNull();
  });

  test("a 403 that resolves after a later brief switch does not set a stale membership notice", async () => {
    // The switched-away-from brief's own fetchPersistedRun is still in flight when the
    // user moves on — its `.catch` had no staleness guard, so a slow 403 landing after
    // the switch would set membershipError for a brief that is no longer active.
    // setBrief now asks `/campaigns/jobs?campaignId=` (fetchRunningJob) BEFORE
    // `/campaigns/result?campaignId=` (fetchPersistedRun) — the job lookup must resolve
    // "no running job" quickly so the deferred 403 lands on the persisted-run read,
    // which is the call whose `.catch` this test exercises.
    let resolveStale!: (res: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    mockPipelineApi({
      result: (u) => {
        if (u.includes("/campaigns/result?campaignId=stale-camp")) return stale;
        return json(EMPTY_REPORT);
      },
    });
    const { result } = setup();

    act(() => {
      result.current.setBrief({ ...result.current.brief, id: "stale-camp" });
    });

    // Wait until the job-discovery-first chain has actually reached the persisted-run
    // read for "stale-camp" (where `stale` is parked) before switching away — `brief.id`
    // itself flips synchronously inside setBrief, so waiting on that alone would let
    // the switch below race ahead of the very fetch this test means to outlive.
    await waitFor(() => {
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([u]) => String(u).includes("/campaigns/result?campaignId=stale-camp")),
      ).toBe(true);
    });

    act(() => {
      result.current.setBrief({ ...result.current.brief, id: "fresh-camp" });
    });
    await waitFor(() => expect(result.current.brief.id).toBe("fresh-camp"));

    await act(async () => {
      resolveStale(
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.membershipError).toBeNull();
  });

  test("a completed run after a 403 on the same brief clears the stale membership notice", async () => {
    // F6's own comment claims "a later successful fetch (a run, a re-roll, a brief
    // switch) heals it" — a completed `execute` is one of those, and nothing actually
    // cleared membershipError on it before this fix.
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    const { result } = setup();
    await act(async () => {
      result.current.setBrief({ ...result.current.brief, id: "camp-1" });
    });
    await waitFor(() => {
      expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    });

    mockPipelineApi({
      job: () =>
        jobOk({ halted: false, assets: [asset()], log: { entries: [], campaignId: "camp-1" } }),
    });
    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.membershipError).toBeNull();
  });

  test("the initial mount's own persisted-run fetch sets membershipError the same way", async () => {
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });
    const { result } = setup();
    await waitFor(() => {
      expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    });
    expect(result.current.error).toBeNull();
  });

  test("handlePipelineResponseError handles href fallback and undefined messages", () => {
    const loc = { href: "" } as unknown as Location;
    vi.stubGlobal("window", { ...window, location: loc });
    const err401 = handlePipelineResponseError(401, null);
    expect(err401.message).toBe("Sign in required.");
    expect(loc.href).toBe("/sign-in");

    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });
    const err401Auth = handlePipelineResponseError(401, {
      code: "unauthenticated",
      error: "Auth required",
    });
    expect(err401Auth.message).toBe("Auth required");
    expect(assign).toHaveBeenCalledWith("/sign-in");

    assign.mockClear();
    const err401Other = handlePipelineResponseError(401, {
      code: "other_code",
      error: "Token expired",
    });
    expect(assign).not.toHaveBeenCalled();
    expect(err401Other.message).toContain("Pipeline API unreachable");

    const err403 = handlePipelineResponseError(403, { code: "no_membership" });
    expect(err403.message).toBe(NO_ORGANISATION_YET_MESSAGE);
  });
});

describe("RunProvider — running job awareness on reload and brief switch", () => {
  const activeBrief = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "active-campaign",
    targetRegion: "US",
    targetAudience: "x",
    campaignMessage: "y",
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
  };

  test("reload adopts a running job: queries running job, sets loading, polls and commits", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    let queriedJob = false;
    let resolveJob!: (res: Response) => void;
    const jobPromise = new Promise<Response>((r) => {
      resolveJob = r;
    });
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ jobId: "job-reload-1" });
        }
        return json(EMPTY_REPORT);
      },
      job: () => jobPromise,
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));
    await waitFor(() => expect(result.current.loading).toBe(true));
    act(() => {
      resolveJob(
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
      );
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.hasRun).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  test("an adopted job's completed re-read returning 403 no_membership shows the notice and commits nothing", async () => {
    // greptile "membership denial is hidden": the re-read `adoptJob` makes for an
    // adopted job used to fold ANY failure — including a 403 no_membership — into
    // `null`, then fell through and committed the job's own (possibly partial, for a
    // re-roll) payload while also healing any stale membershipError. A membership
    // denial must never be treated as "no run on disk".
    localStorage.setItem("cf:brief-picked", "1");
    let queriedJob = false;
    let resolveJob!: (res: Response) => void;
    const jobPromise = new Promise<Response>((r) => {
      resolveJob = r;
    });
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ jobId: "job-reload-1" });
        }
        if (url.includes("/campaigns/result?campaignId=active-campaign")) {
          return json(
            { error: "This account belongs to no organisation.", code: "no_membership" },
            403,
          );
        }
        return json(EMPTY_REPORT);
      },
      job: () => jobPromise,
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));
    await waitFor(() => expect(result.current.loading).toBe(true));
    act(() => {
      resolveJob(
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    });
    // The job's own completed payload (1 asset) is never committed on a denial.
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.hasRun).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("an adopted job that's lost, with the re-read returning 403 no_membership, shows the notice instead of LOST_JOB_MESSAGE", async () => {
    // Same fix, the "lost" outcome's own re-read: a membership denial here used to be
    // folded into `null` too, surfacing as a plain "job interrupted" error with no
    // mention of the real cause.
    localStorage.setItem("cf:brief-picked", "1");
    let queriedJob = false;
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ jobId: "job-lost-1" });
        }
        if (url.includes("/campaigns/result?campaignId=active-campaign")) {
          return json(
            { error: "This account belongs to no organisation.", code: "no_membership" },
            403,
          );
        }
        return json(EMPTY_REPORT);
      },
      job: () => json({ error: "not found" }, 404),
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));

    await waitFor(() => {
      expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  test("reload when no job is running (404) leaves the page as today", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    let queriedJob = false;
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ error: "No running job" }, 404);
        }
        return json(EMPTY_REPORT);
      },
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("reload with network failure leaves the page as today", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    let queriedJob = false;
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return Promise.reject(new Error("network blip"));
        }
        return json(EMPTY_REPORT);
      },
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("setBrief adopts a running job for the target brief", async () => {
    let queriedJob = false;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ jobId: "job-setbrief-1" });
        }
        return json(EMPTY_REPORT);
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(queriedJob).toBe(true));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.loading).toBe(false);
    expect(result.current.hasRun).toBe(true);
  });

  test("setBrief when no job is running (404) leaves the page as today", async () => {
    let queriedJob = false;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          queriedJob = true;
          return json({ error: "No running job" }, 404);
        }
        return json(EMPTY_REPORT);
      },
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(queriedJob).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  test("adoptJob uses the generic message when polling rejects with a non-Error", async () => {
    localStorage.setItem("cf:brief-picked", "1");
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          return json({ jobId: "job-reload-1" });
        }
        return json(EMPTY_REPORT);
      },
      job: () => Promise.reject("string rejection"),
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.error).toBe("Generation failed"));
    expect(result.current.loading).toBe(false);
  });

  test("setBrief racing mount restore prevents mount path from adopting stale brief", async () => {
    const localBrief = { ...activeBrief, campaignMessage: "from-the-pointer" };
    const editorBrief = { ...activeBrief, campaignMessage: "from-editor" };
    localStorage.setItem("cf:brief-picked", "1");

    let jobQueries = 0;
    mockPipelineApi({
      opened: openedCampaign(localBrief),
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          jobQueries += 1;
          return json({ jobId: "job-active-1" });
        }
        return json(EMPTY_REPORT);
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(editorBrief);
    });

    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.brief.campaignMessage).toBe("from-editor");
    // Only setBrief's lookup goes out. The mount restore resolves the pointer's
    // campaign through `openPageCampaign`, whose own token a deliberate commit
    // bumps (`setBrief` does, synchronously) — so the mount path is superseded
    // before it would have asked about jobs, and one result commits, under the
    // edited brief, never the campaign the pointer named.
    expect(jobQueries).toBe(1);
    expect(result.current.loading).toBe(false);
  });

  test("switching to a different brief while an adoption is polling never commits the stale job into the new brief", async () => {
    const otherBrief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "other-campaign",
      targetRegion: "FR",
      targetAudience: "other-aud",
      campaignMessage: "other-msg",
      products: [{ id: "p2", name: "P2", primaryColor: "#222222", logoPath: "b.png" }],
    };

    let resolveActiveJob!: (r: Response) => void;
    const activeJobPromise = new Promise<Response>((r) => {
      resolveActiveJob = r;
    });

    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          return json({ jobId: "job-active" });
        }
        if (url.includes("/campaigns/jobs?campaignId=other-campaign")) {
          return json({ error: "No running job" }, 404);
        }
        return json(EMPTY_REPORT);
      },
      job: (url) => {
        if (url.includes("job-active")) {
          return activeJobPromise;
        }
        return json({ error: "Not found" }, 404);
      },
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });

    await waitFor(() => expect(result.current.loading).toBe(true));

    act(() => {
      result.current.setBrief(otherBrief);
    });

    resolveActiveJob(
      jobOk({
        halted: false,
        assets: [asset({ productId: "p1" })],
        log: { entries: [], campaignId: "active-campaign" },
      }),
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.brief.id).toBe("other-campaign");
    expect(result.current.assets).toHaveLength(0);
    expect(result.current.hasRun).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  test('mount restore discovers a job for the unrestored default brief too (coderabbit "Discover jobs for the default brief after reload")', async () => {
    // No localStorage: the shell starts on DEFAULT_BRIEF ("summer-hydration-2026"),
    // which Generate can run exactly like any other campaign (nothing gates it on
    // `briefApplied`) — so a reload mid-run must discover it too.
    let queriedJob = false;
    let resolveJob!: (r: Response) => void;
    const jobPromise = new Promise<Response>((r) => {
      resolveJob = r;
    });
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=summer-hydration-2026")) {
          queriedJob = true;
          return json({ jobId: "job-default-1" });
        }
        return json(EMPTY_REPORT);
      },
      job: () => jobPromise,
    });

    const { result } = setup();
    await waitFor(() => expect(queriedJob).toBe(true));
    await waitFor(() => expect(result.current.loading).toBe(true));
    act(() => {
      resolveJob(
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "summer-hydration-2026" },
        }),
      );
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
  });

  test('mount restore reads the persisted report AFTER checking for a job, closing the restore/lookup gap (qodo #1, coderabbit "Close the gap between result restoration and job lookup")', async () => {
    localStorage.setItem("cf:brief-picked", "1");
    let calls = 0;
    mockPipelineApi({
      opened: openedCampaign(activeBrief),
      result: (url) => {
        if (!url.includes("campaignId=active-campaign")) return json(EMPTY_REPORT); // unrelated
        // Counted across BOTH endpoints: only the FIRST request this provider makes
        // about this campaign sees the pre-settlement (empty) report; every later
        // one sees the real one — modelling a job whose report write lands between
        // the two requests. Reading the report before checking the job (the old
        // order) makes THAT the first request and it is stuck stale; checking the
        // job first (this order) makes the report read the second request, and it
        // lands after the write.
        const callIndex = calls++;
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          return json({ error: "No running job" }, 404); // the job already settled
        }
        return callIndex === 0
          ? json(EMPTY_REPORT)
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            });
      },
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.loading).toBe(false);
  });

  test("setBrief reads the persisted report AFTER checking for a job, closing the same restore/lookup gap", async () => {
    let calls = 0;
    mockPipelineApi({
      result: (url) => {
        if (!url.includes("campaignId=active-campaign")) return json(EMPTY_REPORT); // unrelated
        const callIndex = calls++;
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          return json({ error: "No running job" }, 404);
        }
        return callIndex === 0
          ? json(EMPTY_REPORT)
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            });
      },
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.loading).toBe(false);
  });

  test('setBrief discovers a job for the already-displayed brief when it is not already polling (qodo #2, "Same-campaign jobs remain unadopted")', async () => {
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ error: "No running job" }, 404)
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.loading).toBe(false);

    // Another client starts a run for this same campaign while this tab shows the
    // (now stale) completed run — nothing here is polling it. By the time the job
    // answers "completed" the server has already written its report (generate.post.ts:
    // writeReport, then completeJob), so the persisted read below reflects the new run.
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ jobId: "job-elsewhere" })
          : json({
              halted: false,
              assets: [asset({ productId: "p2" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p2" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });

    // Re-selecting the SAME brief (the picker, Save) must still discover the job —
    // the run on screen already matches this campaign, which used to short-circuit
    // before job discovery ever ran.
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets.some((a) => a.productId === "p2")).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  test("setBrief skips job discovery for the already-displayed brief while already polling one for it", async () => {
    let jobLookups = 0;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ error: "No running job" }, 404)
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.loading).toBe(false);

    // Another client starts a run; the job GET hangs, so once adopted `loading`
    // stays true for the rest of this test.
    let resolvePoll!: (r: Response) => void;
    const pollPromise = new Promise<Response>((r) => {
      resolvePoll = r;
    });
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          jobLookups += 1;
          return json({ jobId: "job-in-flight" });
        }
        return json({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        });
      },
      job: () => pollPromise,
    });

    // Re-select the same brief again; this discovers job-in-flight and starts
    // polling it.
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    const lookupsAfterAdopt = jobLookups;

    // Re-select it a third time WHILE still polling that same job: the run on
    // screen still names this campaign, so branch (1) fires again, but this tab
    // is already polling a job for it — discovery must be skipped, not doubled.
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(jobLookups).toBe(lookupsAfterAdopt);
    expect(result.current.loading).toBe(true);

    resolvePoll(
      jobOk({
        halted: false,
        assets: [asset({ productId: "p2" })],
        log: { entries: [], campaignId: "active-campaign" },
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  test("unmounting during setBrief's job discovery leaves no orphaned poller (github-actions #71u)", async () => {
    let resolveJobLookup!: (r: Response) => void;
    const jobLookupPromise = new Promise<Response>((r) => {
      resolveJobLookup = r;
    });
    let polls = 0;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? jobLookupPromise
          : json(EMPTY_REPORT),
      job: () => {
        polls += 1;
        return jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        });
      },
    });

    const { result, unmount } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    unmount();
    await act(async () => {
      resolveJobLookup(json({ jobId: "job-orphan" }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(polls).toBe(0);
  });

  test('unmounting when a child effect committed the brief before the mount effect ran leaves no orphaned poller (coderabbit "Register the unmount cleanup before the briefDecidedRef early return")', async () => {
    // React runs a child's effects before its parent's — the editor route's own
    // load effect calls `setBrief` from a child of `RunProvider`, so
    // `briefDecidedRef.current` is already true by the time the provider's own
    // mount effect runs. That is the NORMAL ordering, not an edge case; the mount
    // effect's early return for it must still register a cleanup.
    function EarlyBriefSetter() {
      const { setBrief } = useRun();
      useEffect(() => {
        setBrief(activeBrief);
      }, []);
      return null;
    }
    let resolveJobLookup!: (r: Response) => void;
    const jobLookupPromise = new Promise<Response>((r) => {
      resolveJobLookup = r;
    });
    let polls = 0;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? jobLookupPromise
          : json(EMPTY_REPORT),
      job: () => {
        polls += 1;
        return jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        });
      },
    });

    const { result, unmount } = renderHook(() => useRun(), {
      wrapper: ({ children }) =>
        createElement(RunProvider, null, createElement(EarlyBriefSetter), children),
    });
    await waitFor(() => expect(result.current.brief.id).toBe("active-campaign"));
    unmount();
    await act(async () => {
      resolveJobLookup(json({ jobId: "job-orphan" }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(polls).toBe(0);
  });

  // The same property on the OTHER mount path. `restoreDefaultBrief` used to
  // take the effect's `active` flag BY VALUE, so the `superseded()` guard it
  // closes over could never see cleanup's `active = false`: a job lookup still
  // out when the provider unmounted went on to `adoptJob`, whose `beginRun`
  // created a fresh poller after cleanup had already aborted the previous one.
  // The two threads name one mechanism (qodo #7, coderabbit "Use live mount
  // state in restoreDefaultBrief").
  test("a default-brief job lookup that lands after unmount starts no poller (qodo #7, coderabbit)", async () => {
    let resolveJobLookup!: (r: Response) => void;
    const jobLookupPromise = new Promise<Response>((r) => {
      resolveJobLookup = r;
    });
    let polls = 0;
    mockPipelineApi({
      // No `opened`: the pointer answers "no pointer", which is the one path
      // that reaches `restoreDefaultBrief`.
      result: (url) =>
        url.includes(`/campaigns/jobs?campaignId=${DEFAULT_BRIEF.id}`)
          ? jobLookupPromise
          : json(EMPTY_REPORT),
      job: () => {
        polls += 1;
        return jobOk({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: DEFAULT_BRIEF.id },
        });
      },
    });

    const { result, unmount } = setup();
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) =>
            String(url).includes(`/campaigns/jobs?campaignId=${DEFAULT_BRIEF.id}`),
          ),
      ).toBe(true),
    );
    unmount();
    await act(async () => {
      resolveJobLookup(json({ jobId: "job-orphan" }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    // Nothing adopted the orphaned job, so no poller was ever started for it.
    expect(polls).toBe(0);
    expect(result.current.brief.id).toBe(DEFAULT_BRIEF.id);
  });

  test('adopting a job commits the persisted report, not the job\'s own (possibly partial) result (greptile "Re-roll adoption drops creatives")', async () => {
    // The job being adopted is a selective re-roll: its own completed payload
    // carries only the one regenerated cell, but the server has already merged
    // it into the full persisted report (generate.post.ts: writeReport, then
    // completeJob) — which also still carries the other cells' verdicts.
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ jobId: "job-reroll" })
          : json({
              halted: false,
              assets: [
                asset({ productId: "p1" }),
                asset({ productId: "p2" }),
                asset({ productId: "p3" }),
                asset({ productId: "p4" }),
              ],
              log: { entries: [], campaignId: "active-campaign" },
            }),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p2" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
      decisions: { "p1/1:1/default": "approved", "p3/1:1/default": "rejected" },
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(4));
    expect(result.current.assets.map((a) => a.productId).sort()).toEqual(["p1", "p2", "p3", "p4"]);
    await waitFor(() => expect(result.current.decisions["p1/1:1/default"]).toBe("approved"));
    expect(result.current.decisions["p3/1:1/default"]).toBe("rejected");
  });

  test("an adopted job whose persisted-report re-read fails falls back to the job's own result", async () => {
    // F6: a failed read is "could not ask", not "nothing was saved" — the grid
    // shows the job's own payload rather than staying empty.
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign")) {
          return json({ jobId: "job-x" });
        }
        return Promise.reject(new Error("down"));
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.assets[0]!.productId).toBe("p1");
  });

  test("a brief switch while an adopted job's persisted-report re-read is in flight drops the stale read", async () => {
    let resolvePersisted!: (r: Response) => void;
    const persistedPromise = new Promise<Response>((r) => {
      resolvePersisted = r;
    });
    // Set only once adoptJob actually asks for the persisted report — assigning
    // `resolvePersisted` above happens synchronously in the Promise executor, so
    // waiting on that alone would pass before the request is ever made and this
    // test could not fail if the runSeq check after the re-read (below) were
    // removed (coderabbit).
    let persistedRequested = false;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?campaignId=active-campaign"))
          return json({ jobId: "job-x" });
        if (url.includes("campaignId=active-campaign")) {
          persistedRequested = true;
          return persistedPromise;
        }
        return json(EMPTY_REPORT); // the switched-to brief's own (unrelated) lookups
      },
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    // The job has completed and adoptJob is now re-reading the persisted report
    // (hung above); switch briefs before that read resolves.
    await waitFor(() => expect(persistedRequested).toBe(true));
    act(() =>
      result.current.setBrief({
        schemaVersion: BRIEF_SCHEMA_VERSION,
        template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
        id: "switched-during-adopt",
        targetRegion: "US",
        targetAudience: "x",
        campaignMessage: "y",
        products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }],
      }),
    );
    await act(async () => {
      resolvePersisted(
        json({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.brief.id).toBe("switched-during-adopt");
    expect(result.current.assets).toHaveLength(0);
  });

  test('a failed decisions reload after an adopted full run shows no old verdicts (greptile "Old verdicts remain visible")', async () => {
    let down = false;
    const server = fakeDecisionsApi({ "p1/1:1/default": "approved" });
    const decisions = {
      ...server,
      handle: (url: string, init: RequestInit) =>
        down ? json({ error: "down" }, 500) : server.handle(url, init),
    } as ReturnType<typeof fakeDecisionsApi>;

    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ error: "No running job" }, 404)
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
      decisions,
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.decisions["p1/1:1/default"]).toBe("approved"));

    // A full run completes elsewhere — the job's own payload is the entire set (no
    // merge happened), and the decisions endpoint has since gone down.
    down = true;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ jobId: "job-full" })
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
      decisions,
    });
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.decisionsNotice).toBe(DECISIONS_UNREADABLE_MESSAGE));
    expect(result.current.decisions).toEqual({});
  });

  test("an adopted job commits when the persisted report has no assets array (coderabbit)", async () => {
    // `fetchPersistedRun` accepts a report with a `log` and no `assets` (D83/F6:
    // halted, log-only runs count) — the length comparison must not throw on it.
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ jobId: "job-x" })
          : json({ halted: false, log: { entries: [], campaignId: "active-campaign" } }),
      job: () =>
        jobOk({
          halted: false,
          assets: [asset({ productId: "p1" })],
          log: { entries: [], campaignId: "active-campaign" },
        }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.hasRun).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.assets).toEqual([]);
  });

  test("an adopted job commits when its own completed payload has no assets array (coderabbit)", async () => {
    // The job payload (`outcome.result`) is an untrusted cast (`pollJob`) — the length
    // comparison must not throw when it lacks `assets` either.
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? json({ jobId: "job-x" })
          : json({
              halted: false,
              assets: [asset({ productId: "p1" })],
              log: { entries: [], campaignId: "active-campaign" },
            }),
      job: () => jobOk({ halted: false, log: { entries: [], campaignId: "active-campaign" } }),
    });
    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  test('a job lookup that resolves after a newer run has started for the same campaign does not adopt the stale job or clobber the newer one (greptile "Stale lookup replaces newer run")', async () => {
    let resolveLookup!: (r: Response) => void;
    const lookupPromise = new Promise<Response>((r) => {
      resolveLookup = r;
    });
    let newJobPolls = 0;
    let staleJobPolled = false;
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/jobs?campaignId=active-campaign")
          ? lookupPromise
          : json(EMPTY_REPORT),
      post: () => json({ jobId: "new-job" }, 202),
      job: (url) => {
        if (url.includes("new-job")) {
          newJobPolls += 1;
          return jobOk({
            halted: false,
            assets: [asset({ productId: "p-new" })],
            log: { entries: [], campaignId: "active-campaign" },
          });
        }
        if (url.includes("stale-job")) {
          staleJobPolled = true;
          return jobOk({
            halted: false,
            assets: [asset({ productId: "p-stale" })],
            log: { entries: [], campaignId: "active-campaign" },
          });
        }
        return json({ error: "Not found" }, 404);
      },
    });

    const { result } = setup();
    act(() => {
      result.current.setBrief(activeBrief);
    });
    // The lookup started by setBrief is still pending (mocked to hang). Start a
    // newer run for the same campaign before it resolves.
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p-new"]);
    expect(newJobPolls).toBe(1);
    expect(result.current.loading).toBe(false);

    // The stale lookup now answers with a job that was running before this tab
    // ever asked about it.
    act(() => {
      resolveLookup(json({ jobId: "stale-job" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(staleJobPolled).toBe(false);
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p-new"]);
    expect(result.current.loading).toBe(false);
  });
});

describe("fetchPersistedRun — the report the page's uuid resolves (PT-5c3, D178)", () => {
  const uuid = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";

  test("a report keyed by the campaign's slug is the page's run when the page carries the uuid", async () => {
    // On Postgres the report stores the slug while the URL carries the uuid
    // (D178) — the slug `GET /campaigns/:id` resolved names the same campaign.
    mockPipelineApi({
      result: () =>
        json({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "autumn-launch" },
        }),
    });
    const d = await fetchPersistedRun(uuid, "autumn-launch");
    expect(d?.assets).toHaveLength(1);
  });

  test("a report keyed by neither the id nor the slug is another campaign's, and is not adopted", async () => {
    mockPipelineApi({
      result: () =>
        json({
          halted: false,
          assets: [asset()],
          log: { entries: [], campaignId: "someone-else" },
        }),
    });
    await expect(fetchPersistedRun(uuid, "autumn-launch")).resolves.toBeNull();
  });
});

describe("RunProvider — the page's ?campaign= (PT-5c3, D180)", () => {
  const UUID = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";
  const SLUG = "autumn-launch";

  /** The campaign's stored brief, as the listing carries it (PT-5a). */
  const storedBrief = {
    id: SLUG,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "m",
    products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
  };

  /**
   * The page campaign's server. The run report keys by the SLUG and is served
   * ONLY under the uuid's query: a page that fetched by the slug, or that
   * matched the report against the uuid, would show nothing — which is what
   * makes this the test the slug match lives or dies by.
   */
  const pageCampaignApi = (opts: { hasVersion?: boolean; briefs?: unknown[] } = {}) =>
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({
                halted: false,
                assets: [asset()],
                log: { entries: [], campaignId: SLUG },
              })
            : json(EMPTY_REPORT);
        }
        if (url === `${API}/campaigns/${UUID}`) {
          return json({
            campaignId: UUID,
            slug: SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: opts.hasVersion ?? true,
          });
        }
        if (url.includes("/campaigns/briefs")) {
          return json({ briefs: opts.briefs ?? [] });
        }
        return json({ error: "Not found" }, 404);
      },
    });

  test("a uuid page adopts the run whose report keys the campaign's slug, and commits the campaign's stored brief from the listing", async () => {
    pageCampaignApi({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.brief.campaignMessage).toBe("m");
  });

  test("a stale cached brief for this campaign's slug is never trusted directly — the listing decides (qodo: organisation switches reuse another brief)", async () => {
    // Slugs are unique per organisation, not globally (pg-brief-store.ts's
    // `resolveCampaign`: `where org_id = $1 and slug = $2`). A copy left over
    // from a DIFFERENT organisation's same-slug campaign would satisfy a bare
    // `parsed.id === meta.slug` match by coincidence — so that shortcut is gone,
    // and the listing (scoped to the caller's own session) always answers. The
    // pointer carries an id, never a brief, so there is no cached copy left to
    // trust at all.
    localStorage.setItem("cf:brief-picked", "1");
    pageCampaignApi({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
    const { result } = setup();
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    // The listing's own content wins, not the cached copy's.
    expect(result.current.brief.campaignMessage).toBe("m");
    const listing = vi
      .mocked(globalThis.fetch)
      .mock.calls.some(([url]) => String(url).includes("/campaigns/briefs"));
    expect(listing).toBe(true);
  });

  test("a versionless campaign commits its placeholder brief and still loads the run", async () => {
    // A listing of other campaigns decides nothing for this one: neither the
    // campaignId nor the brief id matches, so the placeholder answers.
    pageCampaignApi({
      hasVersion: false,
      briefs: [
        {
          file: "unrelated.yaml",
          campaignId: "018f6d2a-1111-7b4a-8d21-3f9e2a5b6c7d",
          brief: { ...storedBrief, id: "unrelated" },
        },
      ],
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    // The placeholder is named by the slug — the campaign the report keys (PT-5b2).
    expect(result.current.brief.id).toBe(SLUG);
  });

  test("a listing entry without campaignId still answers by its brief id", async () => {
    // An answer that predates PT-5a carries no campaignId; the brief's own id
    // (the slug) names the campaign just the same.
    pageCampaignApi({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief }] });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.brief.id).toBe(SLUG);
  });

  test("a resolution superseded while its listing was in flight commits nothing", async () => {
    const UUID_A = "018f6d2a-0000-7b4a-8d21-3f9e2a5b6c7d";
    let listingCalls = 0;
    let releaseAListing!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({
                halted: false,
                assets: [asset({ productId: "beta" })],
                log: { entries: [], campaignId: SLUG },
              })
            : json(EMPTY_REPORT);
        }
        if (url.includes("/campaigns/briefs")) {
          listingCalls += 1;
          if (listingCalls === 1) {
            return new Promise<Response>(
              (res) => (releaseAListing = () => res(json({ briefs: [] }))),
            );
          }
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        if (url === `${API}/campaigns/${UUID_A}`) {
          return json({
            campaignId: UUID_A,
            slug: "stale-campaign",
            name: "Stale",
            type: "social-post",
            hasVersion: true,
          });
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
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID_A));
    await waitFor(() => expect(releaseAListing).toBeTypeOf("function")); // A's listing is held
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.brief.id).toBe(SLUG));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    await act(async () => {
      releaseAListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A's listing landed on a superseded resolution: B's campaign stands.
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.assets).toHaveLength(1);
  });

  test("a page-less brief commit (the picker, the editor's Save) supersedes a page-campaign resolution still in flight (qodo: old campaigns overwrite editor changes)", async () => {
    let releaseListing!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/briefs")) {
          return new Promise<Response>(
            (res) =>
              (releaseListing = () =>
                res(
                  json({
                    briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }],
                  }),
                )),
          );
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
        return json(EMPTY_REPORT);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID)); // the page's own resolution starts…
    await waitFor(() => expect(releaseListing).toBeTypeOf("function")); // …its listing is held
    const editorBrief = {
      ...storedBrief,
      schemaVersion: BRIEF_SCHEMA_VERSION,
      id: "hand-picked",
      campaignMessage: "picked in the editor",
    };
    act(() => result.current.setBrief(editorBrief)); // …the editor commits directly (no `page`)
    await act(async () => {
      releaseListing(); // the page's stale resolution finally answers
      await new Promise((r) => setTimeout(r, 0));
    });
    // The editor's own commit stands; the page's late resolution never landed over it.
    expect(result.current.brief.id).toBe("hand-picked");
    expect(result.current.brief.campaignMessage).toBe("picked in the editor");
  });

  test("opening a page with no ?campaign= supersedes a resolution still in flight for the page just left", async () => {
    let releaseListing!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/briefs")) {
          return new Promise<Response>(
            (res) =>
              (releaseListing = () =>
                res(
                  json({
                    briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }],
                  }),
                )),
          );
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
        return json(EMPTY_REPORT);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(releaseListing).toBeTypeOf("function"));
    act(() => result.current.openPageCampaign(null)); // navigated to a bare page
    await act(async () => {
      releaseListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // The bare page's own state stands; the abandoned campaign never committed.
    expect(result.current.brief.id).not.toBe(SLUG);
    expect(result.current.assets).toEqual([]);
  });

  test("a failed listing that lands on a superseded resolution commits nothing", async () => {
    const UUID_A = "018f6d2a-0000-7b4a-8d21-3f9e2a5b6c7d";
    let listingCalls = 0;
    let rejectAListing!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({
                halted: false,
                assets: [asset({ productId: "beta" })],
                log: { entries: [], campaignId: SLUG },
              })
            : json(EMPTY_REPORT);
        }
        if (url.includes("/campaigns/briefs")) {
          listingCalls += 1;
          if (listingCalls === 1) {
            return new Promise<Response>(
              (_, rej) => (rejectAListing = () => rej(new Error("down"))),
            );
          }
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        if (url === `${API}/campaigns/${UUID_A}`) {
          return json({
            campaignId: UUID_A,
            slug: "stale-campaign",
            name: "Stale",
            type: "social-post",
            hasVersion: true,
          });
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
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID_A));
    await waitFor(() => expect(rejectAListing).toBeTypeOf("function")); // A's listing is held
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.brief.id).toBe(SLUG));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    await act(async () => {
      rejectAListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A's failed listing landed on a superseded resolution: it names nothing —
    // no membership error, and B's campaign stays exactly as it committed.
    expect(result.current.membershipError).toBeNull();
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.assets).toHaveLength(1);
  });

  test("a listing that lands after unmount commits nothing", async () => {
    let releaseListing!: () => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockPipelineApi({
      result: (url) => {
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
          return new Promise<Response>((res) => (releaseListing = () => res(json({ briefs: [] }))));
        }
        return json(EMPTY_REPORT);
      },
    });
    const { result, unmount } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(releaseListing).toBeTypeOf("function"));
    const calls = fetchSpy.mock.calls.length;
    unmount();
    await act(async () => {
      releaseListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // No run fetch followed the unmounted commit.
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  test("a failure superseded by a later open says nothing about the campaign left behind", async () => {
    const UUID_A = "018f6d2a-0000-7b4a-8d21-3f9e2a5b6c7d";
    let rejectA!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url === `${API}/campaigns/${UUID_A}`) {
          return new Promise<Response>((_, rej) => (rejectA = () => rej(new Error("down"))));
        }
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({ halted: false, assets: [asset()], log: { entries: [], campaignId: SLUG } })
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
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID_A));
    await waitFor(() => expect(rejectA).toBeTypeOf("function"));
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.brief.id).toBe(SLUG));
    await act(async () => {
      rejectA();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A's failure is not B's news: no membership error, B's campaign stands.
    expect(result.current.membershipError).toBeNull();
    expect(result.current.brief.id).toBe(SLUG);
  });

  test("a failed listing on a versioned campaign commits nothing — no blank placeholder overwrites the real brief (qodo: a listing outage blanks a saved campaign brief)", async () => {
    mockPipelineApi({
      result: (url) => {
        if (url === `${API}/campaigns/${UUID}`) {
          return json({
            campaignId: UUID,
            slug: SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          });
        }
        if (url.includes("/campaigns/briefs")) return json({ error: "down" }, 500);
        return json(EMPTY_REPORT);
      },
    });
    const { result } = setup();
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(([url]) => String(url).includes("/campaigns/briefs")),
      ).toBe(true),
    );
    // Let the rejected listing's catch, and the early return it leads to, settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Nothing committed: no run fetch went out (it rides the brief's commit), and
    // the blank placeholder was never written over the campaign's real, already-
    // saved brief. The pointer is an id, so a listing outage cannot blank it.
    expect(result.current.brief.id).not.toBe(SLUG);
    expect(result.current.assets).toEqual([]);
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).includes("/campaigns/last-opened") &&
            (init as RequestInit)?.method === "PUT",
        ),
    ).toBe(false);
  });

  test("a failed listing still names a versionless campaign through its placeholder", async () => {
    // Unlike the versioned case above, there is no real, saved content for a
    // placeholder to blank: `hasVersion` says so directly, so the listing's
    // outcome — success, a miss, or a failure alike — never withholds it.
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/briefs")) return json({ error: "down" }, 500);
        if (url === `${API}/campaigns/${UUID}`)
          return json({
            campaignId: UUID,
            slug: SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: false,
          });
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({ halted: false, assets: [asset()], log: { entries: [], campaignId: SLUG } })
            : json(EMPTY_REPORT);
        }
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.brief.id).toBe(SLUG);
  });

  test("a hidden id and an unknown id show the same empty state — the previous campaign's run, decisions and brief are all cleared", async () => {
    // PT-2d's rule: a team-hidden campaign answers exactly what a missing one
    // does — 404 to the meta read — so both read as "none" here, identically.
    // Seeded with a REAL committed campaign first (coderabbit: the prior version
    // of this test asserted an empty state that would have passed even if
    // `clearRunState()` were deleted, since nothing was ever on screen to clear).
    pageCampaignApi({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
    const { result } = setup();
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
    expect(result.current.brief.id).toBe(SLUG); // sanity: the campaign really did commit
    await act(async () => {
      result.current.openPageCampaign("018f6d2a-0000-7b4a-8d21-3f9e2a5b6c7d");
    });
    expect(result.current.hasRun).toBe(false);
    expect(result.current.assets).toEqual([]);
    expect(result.current.decisionsLoaded).toBe(false);
    // qodo/coderabbit "Clear the brief in the empty state": the previous
    // campaign's brief must go too, or Header keeps building tab links from its
    // (now abandoned) slug, and PR #621 gates Grid's Generate/Render preview on
    // `briefApplied` (run-context.tsx:1227) — which stays true on a stale brief.
    expect(result.current.brief).toBe(DEFAULT_BRIEF);
    expect(result.current.briefApplied).toBe(false);
  });

  test("a bare page keeps today's behaviour: no meta read, and the shell stays with its own restore", async () => {
    seedPersistedRun([asset()]);
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    const metaRead = vi
      .mocked(globalThis.fetch)
      .mock.calls.some(([url]) => String(url) === `${API}/campaigns/${UUID}`);
    expect(metaRead).toBe(false);
    await act(async () => {
      result.current.openPageCampaign(null);
    });
    // The run the shell restored is untouched.
    expect(result.current.assets).toHaveLength(1);
  });

  test("re-opening the page's campaign keeps the run on screen and asks about jobs by the page's id", async () => {
    const seeded = seedPersistedRun([asset()], { id: SLUG });
    const urls: string[] = [];
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        urls.push(url);
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({ halted: false, assets: [asset()], log: { entries: [], campaignId: SLUG } })
            : json({ halted: false, assets: [asset()], log: { entries: [], campaignId: SLUG } });
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
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    // The job lookup goes out under the page's uuid, not the brief's slug.
    await waitFor(() =>
      expect(urls.some((u) => u.includes(`/campaigns/jobs?campaignId=${UUID}`))).toBe(true),
    );
    // The run (and its decisions) stay exactly as they were.
    expect(result.current.assets).toHaveLength(1);
    await waitFor(() => expect(result.current.decisionsLoaded).toBe(true));
  });

  test("a running job for the page's campaign is adopted through the uuid and commits", async () => {
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/jobs?")) {
          return url.includes(`campaignId=${UUID}`) ? json({ jobId: "job-page" }) : json({});
        }
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({ halted: false, assets: [asset()], log: { entries: [], campaignId: SLUG } })
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
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        return json({ error: "Not found" }, 404);
      },
      job: () =>
        jobOk({ halted: false, assets: [asset({ productId: "beta" })], log: { entries: [] } }),
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.hasRun).toBe(true);
  });

  test("a later open supersedes the resolution still in flight", async () => {
    const UUID_A = "018f6d2a-0000-7b4a-8d21-3f9e2a5b6c7d";
    let releaseA!: () => void;
    mockPipelineApi({
      result: (url) => {
        if (url.includes("/campaigns/result")) {
          return url.includes(`campaignId=${UUID}`)
            ? json({
                halted: false,
                assets: [asset({ productId: "beta" })],
                log: { entries: [], campaignId: SLUG },
              })
            : json(EMPTY_REPORT);
        }
        if (url === `${API}/campaigns/${UUID_A}`) {
          return new Promise<Response>(
            (res) =>
              (releaseA = () =>
                res(
                  json({
                    campaignId: UUID_A,
                    slug: "stale-campaign",
                    name: "Stale",
                    type: "social-post",
                    hasVersion: true,
                  }),
                )),
          );
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
          return json({ briefs: [{ file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID }] });
        }
        return json({ error: "Not found" }, 404);
      },
    });
    const { result } = setup();
    act(() => result.current.openPageCampaign(UUID_A));
    await waitFor(() => expect(releaseA).toBeTypeOf("function"));
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(result.current.brief.id).toBe(SLUG));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    await act(async () => {
      releaseA();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A's late answer changed nothing: B's campaign is what the shell holds.
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.assets).toHaveLength(1);
  });

  test("a resolution that lands after unmount commits nothing", async () => {
    let release!: () => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockPipelineApi({
      result: (url) => {
        if (url === `${API}/campaigns/${UUID}`) {
          return new Promise<Response>(
            (res) =>
              (release = () =>
                res(
                  json({
                    campaignId: UUID,
                    slug: SLUG,
                    name: "Autumn Launch",
                    type: "social-post",
                    hasVersion: true,
                  }),
                )),
          );
        }
        return json(EMPTY_REPORT);
      },
    });
    const { result, unmount } = setup();
    act(() => result.current.openPageCampaign(UUID));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const calls = fetchSpy.mock.calls.length;
    unmount();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    // No listing read, no run fetch followed the unmounted commit.
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  test("a no-membership denial on the meta read is shown, never read as an empty page", async () => {
    mockPipelineApi({
      result: () => json({ code: "no_membership", error: "no organisation yet" }, 403),
    });
    const { result } = setup();
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await waitFor(() => expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE));
  });

  test("a meta read that fails at the network keeps the shell exactly as it was (F6)", async () => {
    seedPersistedRun([asset()]);
    const { result } = setup();
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    const prior = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation((url, init) =>
      String(url) === `${API}/campaigns/${UUID}`
        ? Promise.reject(new Error("down"))
        : (prior as (u: URL | RequestInfo, i?: RequestInit) => Promise<Response>)(url, init),
    );
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await new Promise((r) => setTimeout(r, 0));
    // Could-not-ask is not absence: the restored run stays on screen.
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.membershipError).toBeNull();
  });

  // Fix round (qodo PRRT_kwDOSzP1zc6nELaK). The mount effect's pointer read is
  // ONE request; the page's own `?campaign=` open is a `getCampaign` and then a
  // `listBriefs`. The pointer therefore normally answers first, and because
  // `briefDecidedRef` only flips when the page's open COMMITS, the pointer's
  // `openPageCampaign` bumped `pageCampaignSeq` and threw the URL's campaign
  // away — showing one campaign under another's id, and writing the wrong one
  // back as the pointer. The listing here is held until the pointer has been
  // answered, so the ordering the finding names is the ordering the test runs.
  const pointerRaceApi = (opts: {
    pointer: string;
    /** Held so the page's own open cannot commit before the pointer answers. */
    holdListing?: boolean;
  }) => {
    let releaseListing!: () => void;
    const listing = opts.holdListing
      ? new Promise<Response>((res) => {
          releaseListing = () =>
            res(
              json({
                briefs: [
                  { file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID },
                  {
                    file: "other.yaml",
                    brief: { ...storedBrief, id: "other-slug", campaignMessage: "the pointer's" },
                    campaignId: opts.pointer,
                  },
                ],
              }),
            );
        })
      : Promise.resolve(
          json({
            briefs: [
              { file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID },
              {
                file: "other.yaml",
                brief: { ...storedBrief, id: "other-slug", campaignMessage: "the pointer's" },
                campaignId: opts.pointer,
              },
            ],
          }),
        );
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      const u = String(url);
      if (u === `${API}/campaigns/last-opened`)
        return Promise.resolve(json({ campaignId: opts.pointer }));
      if (u === `${API}/campaigns/briefs`) return listing;
      if (u === `${API}/campaigns/${UUID}` || u === `${API}/campaigns/${opts.pointer}`) {
        return Promise.resolve(
          json({
            campaignId: u.endsWith(UUID) ? UUID : opts.pointer,
            slug: u.endsWith(UUID) ? SLUG : "other-slug",
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          }),
        );
      }
      return Promise.resolve(json(EMPTY_REPORT));
    });
    return () => releaseListing?.();
  };

  test("a full page load of ?campaign= keeps the URL's campaign: the mount pointer never supersedes it (qodo PRRT_kwDOSzP1zc6nELaK)", async () => {
    const OTHER = "018f6d2a-1111-7b4a-8d21-3f9e2a5b6c7d";
    const releaseListing = pointerRaceApi({ pointer: OTHER, holdListing: true });
    const probe = () => {
      usePageCampaignParam();
      return useRun();
    };
    window.history.replaceState(null, "", `/grid?campaign=${UUID}`);
    const { result, unmount } = renderHook(probe, { wrapper });
    // The pointer has answered and its own open has run to completion; only
    // then is the page's held listing released.
    await waitFor(() => expect(result.current.brief.id).not.toBe(SLUG));
    await act(async () => {
      releaseListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // The URL is the source of truth (D180): the campaign it names is the one
    // on screen — not the pointer's, under the URL's id.
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.brief.campaignMessage).toBe("m");
    unmount();
    window.history.replaceState(null, "", "/grid");
  });

  test("a page open that starts while the mount pointer is in flight wins it (qodo PRRT_kwDOSzP1zc6nELaK)", async () => {
    const OTHER = "018f6d2a-1111-7b4a-8d21-3f9e2a5b6c7d";
    // A deferred Response PER pointer read, not one shared promise: a Response
    // body is read once, and two callers read the pointer on a bare page (the
    // shell's restore and the page's redirect), so a single shared Response
    // would starve the second of them and quietly disarm this test.
    const pointerReads: (() => void)[] = [];
    // The visitor's own page open is held mid-flight, so the pointer's answer
    // lands while it is still resolving — the window the seq guard exists for.
    let releaseListing!: () => void;
    const listingHeld = new Promise<Response>((r) => {
      releaseListing = () =>
        r(
          json({
            briefs: [
              { file: `${SLUG}.yaml`, brief: storedBrief, campaignId: UUID },
              {
                file: "other.yaml",
                brief: { ...storedBrief, id: "other-slug", campaignMessage: "the pointer's" },
                campaignId: OTHER,
              },
            ],
          }),
        );
    });
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      const u = String(url);
      if (u === `${API}/campaigns/last-opened`) {
        return new Promise<Response>((res) => {
          pointerReads.push(() => res(json({ campaignId: OTHER })));
        });
      }
      if (u === `${API}/campaigns/briefs`) return listingHeld;
      if (u === `${API}/campaigns/${UUID}` || u === `${API}/campaigns/${OTHER}`) {
        return Promise.resolve(
          json({
            campaignId: u.endsWith(UUID) ? UUID : OTHER,
            slug: u.endsWith(UUID) ? SLUG : "other-slug",
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          }),
        );
      }
      return Promise.resolve(json(EMPTY_REPORT));
    });
    // A BARE page, so the mount effect does ask for the pointer at all.
    window.history.replaceState(null, "", "/grid");
    const probe = () => {
      usePageCampaignParam();
      return useRun();
    };
    const { result, unmount } = renderHook(probe, { wrapper });
    // A navigation to a campaign-addressed url while that read is still out:
    // the visitor's own page, which must own the campaign.
    await act(async () => {
      result.current.openPageCampaign(UUID);
    });
    await act(async () => {
      for (const answer of pointerReads) answer();
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      releaseListing();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Without the seq guard the pointer's own open superseded this one and the
    // shell fell all the way back to the default brief.
    expect(result.current.brief.id).toBe(SLUG);
    expect(result.current.brief.campaignMessage).toBe("m");
    unmount();
  });

  // Fix round (qodo #5). A bare page whose pointer is null opened the picker
  // and left the shell exactly as it was, so the picker appeared OVER the
  // previous campaign's creatives — under a url that names no campaign at all.
  // The pointer is advisory and its write is fire-and-forget, so "the shell
  // holds a campaign but the server has no pointer for it" is reachable (a
  // write that did not land, or a campaign deleted/hidden elsewhere), not
  // hypothetical.
  test("a bare page with no pointer releases the campaign the shell was showing (qodo #5)", async () => {
    mockPipelineApi(); // no `opened`: the server answers "no pointer"
    localStorage.setItem("cf:brief-picked", "1");
    window.history.replaceState(null, "", "/grid");
    // The page hook mounts only once the shell is holding a campaign, so this
    // is the navigation under test rather than a first visit.
    let showPage = false;
    const Page = () => {
      usePageCampaignParam();
      return null;
    };
    const pageWrapper = ({ children }: { children: ReactNode }) =>
      createElement(RunProvider, null, showPage ? createElement(Page) : null, children);
    const { result, rerender } = renderHook(() => useRun(), { wrapper: pageWrapper });
    await act(async () => {
      result.current.setBrief({ ...DEFAULT_BRIEF, id: "previous-campaign" });
    });
    expect(result.current.brief.id).toBe("previous-campaign");
    expect(result.current.briefApplied).toBe(true);
    showPage = true;
    rerender();
    await waitFor(() => expect(result.current.briefPickerOpen).toBe(true));
    // The picker is open AND the shell let go: the bare url names no campaign,
    // so the one it was showing is not this page's (D180).
    expect(result.current.brief.id).toBe(DEFAULT_BRIEF.id);
    expect(result.current.briefApplied).toBe(false);
    expect(result.current.assets).toEqual([]);
  });

  test("the page hook hands the URL's ?campaign= through, and a bare page hands null", async () => {
    const urls: string[] = [];
    mockPipelineApi({
      result: (url) => {
        urls.push(url);
        if (url === `${API}/campaigns/${UUID}`) {
          return json({
            campaignId: UUID,
            slug: SLUG,
            name: "Autumn Launch",
            type: "social-post",
            hasVersion: true,
          });
        }
        return json(EMPTY_REPORT);
      },
    });
    const probe = () => {
      usePageCampaignParam();
      return useRun();
    };
    window.history.replaceState(null, "", `/grid?campaign=${UUID}`);
    const first = renderHook(probe, { wrapper });
    await waitFor(() => expect(urls.some((u) => u === `${API}/campaigns/${UUID}`)).toBe(true));
    first.unmount();
    window.history.replaceState(null, "", "/grid");
    const bare = renderHook(probe, { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const metaReads = urls.filter((u) => u === `${API}/campaigns/${UUID}`).length;
    expect(metaReads).toBe(1); // the bare page added no second read
    bare.unmount();
    window.history.replaceState(null, "", "/grid");
  });
});

describe("usableUrl — only the URL shapes the server mints", () => {
  test("a same-origin path and an absolute http(s) URL are usable", async () => {
    const { usableUrl } = await import("@/lib/run-context");
    expect(usableUrl("/api/pipeline/output/a/1x1.png?v=abc")).toBe(
      "/api/pipeline/output/a/1x1.png?v=abc",
    );
    expect(usableUrl("https://objects.example/bucket/k?X-Amz-Signature=s")).toBe(
      "https://objects.example/bucket/k?X-Amz-Signature=s",
    );
    expect(usableUrl("http://localhost:8333/bucket/k")).toBe("http://localhost:8333/bucket/k");
  });

  test.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative", "//evil.example/x.png"],
    ["slash-backslash", "/\\evil.example/x.png"],
    ["an unparseable host", "//["],
    ["slash-backslash-backslash", "/\\\\evil.example/x.png"],
    ["a bare word", "not a url"],
    ["empty", ""],
    ["non-string", 42],
  ])("%s is NOT usable — it renders the placeholder, never an href", async (_label, value) => {
    const { usableUrl } = await import("@/lib/run-context");
    expect(usableUrl(value)).toBeUndefined();
  });
});

/**
 * PT-4g3 (D214(e), D215) — the shell re-reads `GET /campaigns/result` before the URLs
 * on screen expire.
 *
 * **The shape of every test here is the clock.** `URL_REFRESH_MS` is four minutes of
 * real time, so `vi.useFakeTimers()` is installed BEFORE `setup()` (the refresh timeout
 * is armed at mount, and a fake installed after mount would not own it) and every flush
 * goes through `advanceTimersByTimeAsync`. `waitFor`/`findBy*` are banned here for the
 * usual reason — they poll the faked clock and hang.
 *
 * **Every read is counted by URL, never by handler call.** `mockPipelineApi`'s fallback
 * `result` handler also answers `GET /campaigns/jobs?campaignId=`, so a handler-call
 * counter is not a read counter; the assertions use `readsFor(campaignId)`.
 *
 * **The fixtures are the two windows of ONE report**: the first `result.get` answers
 * with the rows signed at `rev-1`, the refresh with the same rows signed at `rev-2`. The
 * report is therefore identical — only the signatures move, which is exactly the case
 * the same-report branch exists for, and what a real two-reads-in-one-window costs.
 */
describe("RunProvider — signed URL refresh (PT-4g3)", () => {
  afterEach(() => {
    vi.useRealTimers();
    // The per-test override has to go: happy-dom defines `visibilityState` as a
    // prototype getter, and a test-local `defineProperty` would shadow it for the next.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  /** The row the seeded report carries: one static creative, and no URLs of its own. */
  const row = (over: Partial<Asset> = {}): Asset =>
    asset({ productId: "p1", outputPath: "p1/1x1.png", ...over });

  /** That row as `result.get` sends it under `s3`: signed, and expiring. */
  const signed = (a: Asset, revision: string): Asset => ({ ...a, ...s3Urls(a, revision) });

  /** That row as `result.get` sends it under `fs`: the output route, which never expires. */
  const onFs = (a: Asset): Asset => ({ ...a, ...fsUrls(a) });

  /** A `GET /campaigns/result` answer for one campaign. */
  const onDisk = (campaignId: string, assets: unknown[]) =>
    json({ halted: false, assets, log: { entries: [], campaignId } });

  /**
   * The reads that named this campaign — the only ones a refresh of it can be. Keyed by
   * campaign because a shell under test has more than one in play: the mount restore
   * asks about the last-opened campaign while a re-roll asks about the run's own.
   */
  const readsFor = (campaignId: string) =>
    vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([u]) => String(u).includes(`/campaigns/result?campaignId=${campaignId}`))
      .length;

  /** The campaign's decision reads, so "decisions were NOT re-fetched" is observable. */
  const decisionReads = () =>
    vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(
        ([u, init]) =>
          String(u).includes("/campaigns/decisions") &&
          ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
      ).length;

  /** Move the faked clock, letting whatever is already in flight settle. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /**
   * Let the mount's own chain finish WITHOUT moving the clock. A `Response` body is
   * read over several ticks, so "settled" is a number of turns of the microtask queue,
   * not one.
   */
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await advance(0);
  };

  /** Fake the document's visibility and dispatch — what the effect listens for. */
  const visibility = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  /** A promise whose settlement the test decides — a read held open mid-flight. */
  const deferred = () => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  /**
   * A decisions endpoint that HOLDS its second read open, so the state between a
   * decisions clear and the reload that clear triggers is observable rather than a tick
   * nobody can see. `held` is returned beside the endpoint and NOT on it, because
   * `mockPipelineApi` takes the endpoint's own shape.
   */
  const gatedDecisions = (verdicts: Record<string, "approved" | "rejected">) => {
    const server = fakeDecisionsApi(verdicts);
    const held = deferred();
    let gets = 0;
    const endpoint = {
      // `Promise.resolve`-ed by `mockPipelineApi`, so a promise is a legal answer here
      // even though the endpoint's own type says `Response`.
      handle: (url: string, init: RequestInit) =>
        ((init.method ?? "GET") === "GET" && ++gets === 2
          ? held.promise
          : server.handle(url, init)) as Response,
      retire: (init: RequestInit) => server.retire(init),
      stored: () => server.stored(),
      saveElsewhere: (next: Record<string, "approved" | "rejected">) => server.saveElsewhere(next),
    };
    return { endpoint, held };
  };

  test("holdsExpiringUrls is true only for a signed URL — never for an fs path, an unsigned row or an absent one", () => {
    const a = row();
    // `s3`: an absolute http(s) presigned GET on the store's own origin.
    expect(holdsExpiringUrls({ halted: false, assets: [signed(a, "rev-1")] })).toBe(true);
    // `fs`: same-origin paths, which `usableUrl` keeps and which never expire (D204).
    expect(holdsExpiringUrls({ halted: false, assets: [onFs(a)] })).toBe(false);
    // A row the server could not sign a URL for: no field is a URL at all.
    expect(holdsExpiringUrls({ halted: false, assets: [a] })).toBe(false);
    // A halted, log-only report carries NO `assets` key — `fetchPersistedRun` accepts
    // one, so the predicate must not assume the field is there.
    expect(holdsExpiringUrls({ halted: true, log: null } as unknown as RunResult)).toBe(false);
    expect(ASSET_URL_FIELDS).toHaveLength(7);
  });

  test("s3, visible: after URL_REFRESH_MS exactly one more read, carrying the next window's URLs", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const second = signed(first, "rev-2");
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [read++ === 0 ? signed(first, "rev-1") : second])
          : onDisk("seed", []),
    });

    const { result } = setup();
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    const baseline = readsFor("seed");
    expect(baseline).toBe(1);

    await advance(URL_REFRESH_MS);

    expect(readsFor("seed")).toBe(baseline + 1);
    expect(result.current.assets[0].outputUrl).toBe(second.outputUrl);
    expect(result.current.assets[0].outputUrl).toContain("v=rev-2");
  });

  test("the bound: nothing at three minutes, the re-read at four, and the constant under the five-minute floor", async () => {
    vi.useFakeTimers();
    // The whole reason for 4 and not 10: a URL read in the last second of its 15-minute
    // signing window has 5 minutes of life, so a longer tick can hold an expired URL.
    expect(URL_REFRESH_MS).toBeLessThan(5 * 60_000);
    const first = row();
    const seeded = seedPersistedRun([first]);
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [signed(first, "rev-1")])
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");

    await advance(3 * 60_000);
    expect(readsFor("seed")).toBe(baseline);

    await advance(60_000);
    expect(readsFor("seed")).toBe(baseline + 1);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
  });

  test("hidden: no timer at all, and becoming visible refreshes at once because the URLs are stale", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const second = signed(first, "rev-2");
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [read++ === 0 ? signed(first, "rev-1") : second])
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");

    visibility("hidden");
    await advance(60 * 60_000);
    expect(readsFor("seed")).toBe(baseline);

    // An hour on screen is stale past any bound, so showing the tab refreshes NOW
    // rather than waiting out a fresh interval.
    visibility("visible");
    expect(readsFor("seed")).toBe(baseline + 1);
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(second.outputUrl);
  });

  test("visible before the timer is due: the REMAINDER is scheduled, so the read lands at 4 minutes and not at 6", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [signed(first, "rev-1")])
          : onDisk("seed", []),
    });
    // No `result` needed: this test is entirely about WHEN the read happens, and the
    // read count is the whole assertion.
    setup();
    await settle();
    const baseline = readsFor("seed");

    await advance(60_000);
    visibility("hidden");
    await advance(60_000);
    visibility("visible");
    await settle();
    // Two minutes old is not stale, so showing the tab reads nothing…
    expect(readsFor("seed")).toBe(baseline);

    // …and the read lands on the ORIGINAL schedule (+4 min), not a fresh interval from
    // the moment the tab came back (+6). The remainder is the whole point.
    await advance(2 * 60_000);
    expect(readsFor("seed")).toBe(baseline + 1);
  });

  test("fs: an hour on screen and two visibility changes make no request at all", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [onFs(first)])
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(fsUrls(first).outputUrl);
    const baseline = readsFor("seed");

    await advance(60 * 60_000);
    visibility("hidden");
    await advance(60_000);
    visibility("visible");
    await settle();

    // No timer, no listener, no request: an fs URL is a same-origin path that never
    // expires, so the effect returned before arming either (D215(b)). **The count is the
    // assertion**, and it comes before the predicate below, because the request is the
    // defect — the predicate is only here to say which answer produced it.
    expect(readsFor("seed")).toBe(baseline);
    expect(holdsExpiringUrls({ halted: false, assets: result.current.assets })).toBe(false);
  });

  test("a same-report refresh keeps the verdicts, their loaded flag, assetVersion and the decisions read", async () => {
    vi.useFakeTimers();
    const first = row();
    // Seeded on the TEST, not on one mock: the second `mockPipelineApi` below answers
    // the campaign's decisions from the same seed.
    seedDecisions({ "p1/1:1/default": "approved" });
    const seeded = seedPersistedRun([first]);
    const second = signed(first, "rev-2");
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [read++ === 0 ? signed(first, "rev-1") : second])
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    expect(result.current.decisions).toEqual({ "p1/1:1/default": "approved" });
    expect(result.current.decisionsLoaded).toBe(true);
    const version = result.current.assetVersion;
    const decisionsBefore = decisionReads();

    await advance(URL_REFRESH_MS);

    expect(result.current.assets[0].outputUrl).toBe(second.outputUrl);
    expect(result.current.decisions).toEqual({ "p1/1:1/default": "approved" });
    expect(result.current.decisionsLoaded).toBe(true);
    // `assetVersion` is a dependency of the decisions effect AND half of the grid's
    // `filtersKey`, so a bump here would pause reviewing, drop a queued save and reset
    // the reviewer's filters — four times an hour, for signatures.
    expect(result.current.assetVersion).toBe(version);
    expect(decisionReads()).toBe(decisionsBefore);
  });

  test("a DIFFERENT report while idle is committed as a new run — version up, verdicts cleared and reloaded", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first], {
      decisions: { "p1/1:1/default": "approved" },
    });
    // Another tab ran this campaign: a second product the screen has never shown.
    const ranElsewhere = signed(row({ productId: "p2", outputPath: "p2/1x1.png" }), "rev-2");
    const server = gatedDecisions({ "p1/1:1/default": "approved" });
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      decisions: server.endpoint,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [read++ === 0 ? signed(first, "rev-1") : ranElsewhere])
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    expect(result.current.decisions).toEqual({ "p1/1:1/default": "approved" });
    const version = result.current.assetVersion;

    await advance(URL_REFRESH_MS);
    await settle();

    expect(result.current.assets.map((a) => a.productId)).toEqual(["p2"]);
    expect(result.current.assets[0].outputUrl).toBe(ranElsewhere.outputUrl);
    expect(result.current.assetVersion).toBe(version + 1);
    // The verdicts are GONE and the reload they triggered is still out — which is what
    // `decidable={decisionsLoaded && !loading}` reads as "reviewing is paused".
    expect(result.current.decisions).toEqual({});
    expect(result.current.decisionsLoaded).toBe(false);

    await act(async () => {
      server.held.resolve(json({ decisions: {}, revision: "rev-0" }));
    });
    await settle();
    expect(result.current.decisionsLoaded).toBe(true);
  });

  test("a job in flight owns the screen: a different report commits nothing, the same one moves URLs only", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    // The job is held open so advancing the clock never drives the poller.
    const jobHeld = deferred();
    const bodies = [
      [signed(first, "rev-1")],
      // A DIFFERENT report — another tab's run — which must not be committed.
      [signed(first, "rev-2"), signed(row({ productId: "p2", outputPath: "p2/1x1.png" }), "rev-2")],
      // The SAME report again, with the next window's signatures.
      [signed(first, "rev-3")],
    ];
    // Past the last body, keep serving the last one: a read this test did not plan for
    // must still get a well-formed report rather than a crash.
    const last = bodies[bodies.length - 1]!;
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      post: () => json({ jobId: "job-1" }, 202),
      job: () => jobHeld.promise,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", bodies[read++] ?? last)
          : onDisk("seed", []),
    });
    const { result } = setup();
    await settle();
    const before = result.current.assets;

    // The job's promise is deliberately never awaited: the poller is held open, and the
    // point is that the refresh tick moves nothing while `loading` is true.
    await act(async () => {
      void result.current.execute();
    });
    await settle();
    expect(result.current.loading).toBe(true);

    // Tick one: a different report, while `loading`. The job's own D213 re-read commits
    // whatever it produces, so this read commits nothing.
    await advance(URL_REFRESH_MS);
    await settle();
    expect(result.current.assets).toBe(before);
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.loading).toBe(true);
    expect(result.current.regeneratingKeys).toBeNull();

    // Tick two: the same report. The grid keeps rendering the previous assets while a
    // run is in flight (`loading` is a per-cell overlay), so swapping the URLs is
    // exactly right — and nothing else may move.
    await advance(URL_REFRESH_MS);
    await settle();
    expect(result.current.assets).not.toBe(before);
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.assets[0].productId).toBe("p1");
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-3").outputUrl);
    expect(result.current.loading).toBe(true);
    expect(result.current.regeneratingKeys).toBeNull();
    expect(result.current.decisions).toEqual({});
  });

  test("a read issued before a run started is dropped once the run token moves", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const held = deferred();
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      post: () => json({ jobId: "job-1" }, 202),
      job: () => json({ status: "running", done: 0, total: 0, log: null }),
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        return read === 1 ? onDisk("seed", [signed(first, "rev-1")]) : held.promise;
      },
    });
    const { result } = setup();
    await settle();
    const before = result.current.assets[0].outputUrl;
    expect(before).toBe(s3Urls(first, "rev-1").outputUrl);

    // The tick issues its read, and the answer is held open.
    await advance(URL_REFRESH_MS);
    expect(read).toBe(2);

    // The second actor: Generate, whose `beginRun` moves the token this read owns — for
    // a run that is now the one the screen belongs to. Its own promise is never awaited:
    // the job answers "running" forever, and what matters is that the token has moved.
    await act(async () => {
      void result.current.execute();
    });
    await settle();
    expect(result.current.loading).toBe(true);
    expect(result.current.assets[0].outputUrl).toBe(before);

    // The held answer is a perfectly good read of the SAME report, with fresher URLs.
    await act(async () => {
      held.resolve(onDisk("seed", [signed(first, "rev-late")]));
    });
    await settle();

    expect(result.current.assets[0].outputUrl).toBe(before);
    expect(result.current.assets[0].outputUrl).not.toBe(s3Urls(first, "rev-late").outputUrl);
  });

  test("a read in flight when a job commits is dropped — the job's result stays on screen", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const held = deferred();
    const jobHeld = deferred();
    const committed = row({ productId: "p9", outputPath: "p9/1x1.png" });
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      post: () => json({ jobId: "job-1" }, 202),
      job: () => jobHeld.promise,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        if (read === 1) return onDisk("seed", [signed(first, "rev-1")]);
        if (read === 2) return held.promise;
        return onDisk("seed", [signed(committed, "rev-job")]);
      },
    });
    const { result } = setup();
    await settle();
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p1"]);

    // Generate FIRST, so the token the refresh will own is the job's: `beginRun` runs on
    // the POST's answer, and the job itself is then held open. A refresh issued BEFORE
    // the POST would be caught by the seq guard instead, which is the previous test.
    let exec!: Promise<void>;
    await act(async () => {
      exec = result.current.execute();
    });
    await settle();
    expect(result.current.loading).toBe(true);

    await advance(URL_REFRESH_MS);
    expect(read).toBe(2);

    // The job completes and commits. It moves the run but NOT the token.
    await act(async () => {
      jobHeld.resolve(
        jobOk({ halted: false, assets: [committed], log: { entries: [], campaignId: "seed" } }),
      );
      await exec;
    });
    await settle();
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p9"]);
    expect(result.current.loading).toBe(false);

    // The stale read lands. It knows nothing about the job that has just committed, and
    // committing over it would put the previous report back on the grid.
    await act(async () => {
      held.resolve(onDisk("seed", [signed(first, "rev-late")]));
    });
    await settle();
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p9"]);
    expect(result.current.assets[0].outputUrl).toContain("v=rev-job");
  });

  test("a job commit and a stale refresh in ONE batch: the job's result stays on screen", async () => {
    // F1. The `runRef.current` guard alone cannot see this, and the mechanism is the
    // batch: `runRef.current` is the LAST RENDERED run, while an updater sees every
    // `setRun` queued since that render. `adoptJob`'s commit is a PLAIN `setRun` from a
    // promise continuation that does NOT bump `runSeq` — `beginRun` moved the token when
    // the run STARTED, and this refresh read was issued after that — and React 19 renders
    // default-lane updates in a later macrotask. So both commits land before any render,
    // both pass the `runRef` guard, and a plain `setRun` here is applied LAST and wins.
    //
    // **Everything below is inside ONE `act()`, and no render happens in the middle.**
    // That is the whole point: a `settle()` between the two resolutions would render, the
    // guard would catch it, and the test would pass against the bug it exists for.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const jobHeld = deferred();
    const jobReRead = deferred();
    const refreshHeld = deferred();
    // What the job produces, and what it commits from: a DIFFERENT product, so the two
    // candidates are distinguishable by identity alone and not by a URL.
    const jobRow = row({ productId: "p9", outputPath: "p9/1x1.png" });
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      post: () => json({ jobId: "job-1" }, 202),
      job: () => jobHeld.promise,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        // 1: the mount restore. 2: the refresh (held). 3: adoptJob's re-read (held).
        if (read === 1) return onDisk("seed", [signed(first, "rev-1")]);
        if (read === 2) return refreshHeld.promise;
        return jobReRead.promise;
      },
    });
    const { result } = setup();
    await settle();

    // Generate FIRST, so the token the refresh will own is the job's, then let the tick
    // issue its read against that same token. Its promise is never awaited: the job is
    // driven by hand below, and what matters here is that `beginRun` has already run.
    await act(async () => {
      void result.current.execute();
    });
    await settle();
    expect(result.current.loading).toBe(true);
    await advance(URL_REFRESH_MS);
    expect(read).toBe(2);

    // The job settles, and its re-read goes out and is held too. No commit yet.
    await act(async () => {
      jobHeld.resolve(
        jobOk({ halted: false, assets: [jobRow], log: { entries: [], campaignId: "seed" } }),
      );
    });
    await settle();
    expect(read).toBe(3);
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p1"]);

    // ONE batch: the job's re-read lands (it commits), then the stale refresh lands. Both
    // resolutions are issued in issue order and take the same route, so they take the
    // same shape of hops and the job's commit is queued first.
    await act(async () => {
      jobReRead.resolve(onDisk("seed", [signed(jobRow, "rev-job")]));
      refreshHeld.resolve(onDisk("seed", [signed(first, "rev-stale")]));
    });
    await settle();

    // The job's result is on screen, and the stale read's URLs are nowhere in it.
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p9"]);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(jobRow, "rev-job").outputUrl);
    expect(result.current.assets[0].outputUrl).not.toContain("v=rev-stale");
  });

  test("a hidden tab is never polled: a read in flight at hide time schedules nothing", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const held = deferred();
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        // Read 1 is the mount restore; read 2 is the tick, which this test holds open;
        // every read after it answers with its own revision, so a URL that moves is a
        // read that happened rather than a stale promise resolving twice.
        return read === 1
          ? onDisk("seed", [signed(first, "rev-1")])
          : read === 2
            ? held.promise
            : onDisk("seed", [signed(first, `rev-${read}`)]);
      },
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");

    // The tick issues its read; the tab hides while it is out.
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 1);
    visibility("hidden");

    // The read settles while hidden. Its `finally` is the one place a fresh timer could
    // be armed from here, and a hidden tab must not have one.
    await act(async () => {
      held.resolve(onDisk("seed", [signed(first, "rev-2")]));
    });
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-2").outputUrl);

    // Half an hour of hidden tab: eight intervals, and not one of them a request.
    await advance(30 * 60_000);
    expect(readsFor("seed")).toBe(baseline + 1);

    // Showing the tab reads at once, because the read above DID land and the URLs are
    // now half an hour old — stale, so the trigger refreshes rather than scheduling. The
    // timer is armed again from that read, not from the moment the tab came back.
    visibility("visible");
    expect(readsFor("seed")).toBe(baseline + 2);
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-3").outputUrl);
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 3);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-4").outputUrl);
  });

  test("an effect that arms while the tab is ALREADY hidden schedules nothing", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let served = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("/campaigns/result?campaignId=seed")
          ? onDisk("seed", [signed(first, `rev-${++served}`)])
          : onDisk("seed", []),
    });
    // Hidden BEFORE the provider mounts, so the run commits — and the effect arms —
    // with the tab already hidden. A user who opens the tab to find a background tab
    // holding a run is the ordinary case; a timer firing there before they ever look
    // is not what this lane is for.
    visibility("hidden");
    const { result } = setup();
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    const baseline = readsFor("seed");

    await advance(60 * 60_000);
    expect(readsFor("seed")).toBe(baseline);

    // Visible: the read is stale (an hour), so it happens at once, and the timer is
    // armed again from there.
    visibility("visible");
    expect(readsFor("seed")).toBe(baseline + 1);
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-2").outputUrl);
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 2);
  });

  test("a signing outage keeps the screen and keeps the timer: the next tick heals", async () => {
    // F3. The server answers 200 with every `*Url` OMITTED when it cannot sign
    // (`signed-urls.ts`'s `signingFailure` — a bucket that will not sign is an outage, not
    // an error, and the route degrades rather than 500s). `sameReport` strips exactly
    // those keys, so that answer arrives at the same-report branch looking identical apart
    // from the URLs. Commit it and every `src` and `href` leaves the screen, and because
    // `holdsExpiringUrls` is then false the effect STANDS DOWN — so one 200 from a stalled
    // bucket would blank the grid permanently, with no timer left to heal it.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    // What the outage looks like: the stored report, unsigned — the paths are still there,
    // which is what makes it the same report.
    const unsigned = onDisk("seed", [first]);
    let read = 0;
    let outage = true;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        if (read === 1) return onDisk("seed", [signed(first, "rev-1")]);
        if (outage) return unsigned;
        return onDisk("seed", [signed(first, `rev-${read + 1}`)]);
      },
    });
    const { result } = setup();
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    const baseline = readsFor("seed");

    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 1);
    // The old URLs are still on screen: nothing was claimed and nothing was lost.
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    expect(result.current.assets).toHaveLength(1);

    // **And the timer is still armed** — the difference between a degraded read and a
    // dead one. One tick later the route is asked again.
    //
    // One interval per `advance`, because that is what happens: each tick is its own
    // macrotask with a render in between. Compressing three ticks into one `advance`
    // would queue three commits in ONE batch, where `runRef.current` is the same stale
    // run for all three and the F1 updater collapses them to the first — a state no
    // browser produces, and one this test would then be measuring instead of the outage.
    outage = false;
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 2);
    expect(result.current.assets[0].outputUrl).toContain("v=rev-4");

    // And it keeps ticking: the refresh stands down only when the run stops holding
    // expiring URLs, and this one still does.
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 3);
    expect(result.current.assets[0].outputUrl).toContain("v=rev-5");
    expect(result.current.assets[0].outputUrl).not.toBe(s3Urls(first, "rev-1").outputUrl);
  });

  test("a PARTIAL signing failure renews what it can and keeps the field it could not", async () => {
    // Item 1. `urlFields` in `signed-urls.ts` signs each of the seven fields on its own
    // and omits only the ones it could not, so one stalled row answers 200 with that ONE
    // `*Url` missing. Committing that answer whole takes the working creative off the
    // screen — a poster rendered as a placeholder, a download link gone — until the next
    // tick, which is the failure this merge removes. The merge is per row AND per field,
    // so asset 1 takes the new signature and asset 2 keeps the one that still works.
    vi.useFakeTimers();
    const one = row({ productId: "p1", outputPath: "p1/1x1.png" });
    const two = row({ productId: "p2", outputPath: "p2/1x1.png" });
    const seeded = seedPersistedRun([one, two]);
    const oldOne = signed(one, "rev-1");
    const oldTwo = signed(two, "rev-1");
    // The outage: asset 1 signs at the new window, asset 2's `outputUrl` is absent while
    // its other fields are present — a per-field failure, not a per-row one.
    const partialOne = { ...one, ...s3Urls(one, "rev-2") };
    const partialTwo = { ...two, ...fsUrls(two) };
    delete (partialTwo as Partial<Asset>).outputUrl;
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        if (read === 1) return onDisk("seed", [oldOne, oldTwo]);
        return onDisk("seed", [partialOne, partialTwo]);
      },
    });
    const { result } = setup();
    await settle();
    expect(result.current.assets.map((a) => a.outputUrl)).toEqual([
      s3Urls(one, "rev-1").outputUrl,
      s3Urls(two, "rev-1").outputUrl,
    ]);
    const baseline = readsFor("seed");

    await advance(URL_REFRESH_MS);

    expect(readsFor("seed")).toBe(baseline + 1);
    // Asset 1 was renewed; asset 2's `outputUrl` — the field the store would not sign —
    // is the one ALREADY on screen, not a placeholder.
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(one, "rev-2").outputUrl);
    expect(result.current.assets[1].outputUrl).toBe(s3Urls(two, "rev-1").outputUrl);
    expect(result.current.assets[1].outputUrl).toBeDefined();
    // A field the outage answer DID carry is still taken, so a partly healthy bucket
    // replaces everything it can rather than only the first row.
    expect(result.current.assets[1].outputDownloadUrl).toBe(fsUrls(two).outputDownloadUrl);
  });

  test("a healed membership clears on any 200, signed or not", async () => {
    // Item 1. `setMembershipError(null)` proves membership on ANY successful read, so it
    // cannot sit behind a check on whether the URLs were renewed: a 200 whose URLs the
    // store would not sign is still a 200, and a reviewer whose organisation came back
    // must not be left under a stale denial because the bucket is also unhappy.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let mode: "ok" | "denied" | "unsigned" = "ok";
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        if (mode === "denied") return json({ code: "no_membership" }, 403);
        if (mode === "unsigned") return onDisk("seed", [first]);
        return onDisk("seed", [signed(first, "rev-1")]);
      },
    });
    const { result } = setup();
    await settle();
    expect(result.current.membershipError).toBeNull();

    // The denial, then a 200 that carries no signatures at all.
    mode = "denied";
    await advance(URL_REFRESH_MS);
    expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    mode = "unsigned";
    await advance(URL_REFRESH_MS);
    expect(result.current.membershipError).toBeNull();
    // And the screen survived the unsigned read, as item 1 requires.
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
  });

  test("a healed membership clears on a CHANGED report that arrives unsigned, though the report is held", async () => {
    // The different-report branch holds an unsigned changed report back (item 2), and the
    // heal must not be held back with it: the 200 still proves membership.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const ranElsewhere = row({ productId: "p2", outputPath: "p2/1x1.png" });
    let mode: "ok" | "denied" | "changedUnsigned" = "ok";
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        if (mode === "denied") return json({ code: "no_membership" }, 403);
        if (mode === "changedUnsigned") return onDisk("seed", [ranElsewhere]);
        return onDisk("seed", [signed(first, "rev-1")]);
      },
    });
    const { result } = setup();
    await settle();

    mode = "denied";
    await advance(URL_REFRESH_MS);
    expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    mode = "changedUnsigned";
    await advance(URL_REFRESH_MS);
    expect(result.current.membershipError).toBeNull();
    // Held, not committed: the old report and its links are still on screen.
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p1"]);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
  });

  test("a changed report arriving unsigned is held, and the next signed tick commits it", async () => {
    // Item 2. The different-report branch had no outage check, and an unsigned `d` is
    // worse there than on the same-report branch: committing it hands the grid a report
    // with no links at all AND stands the refresh down permanently, because
    // `holdsExpiringUrls` is then false of the committed run, so no tick ever follows.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const ranElsewhere = row({ productId: "p2", outputPath: "p2/1x1.png" });
    const newRow = signed(ranElsewhere, "rev-3");
    let mode: "same" | "changedUnsigned" | "changedSigned" = "same";
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        // The changed report, unsigned: the paths arrived, the signatures did not.
        if (mode === "changedUnsigned") return onDisk("seed", [ranElsewhere]);
        if (mode === "changedSigned") return onDisk("seed", [newRow]);
        return onDisk("seed", [signed(first, "rev-1")]);
      },
    });
    const { result } = setup();
    await settle();
    const version = result.current.assetVersion;

    mode = "changedUnsigned";
    await advance(URL_REFRESH_MS);
    // The OLD report is still on screen: not the changed one without its links, and not
    // an empty grid.
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p1"]);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    expect(result.current.assetVersion).toBe(version);

    // The next tick is signed, and the changed report lands whole — it is still the
    // right report, only unsigned a moment ago.
    mode = "changedSigned";
    await advance(URL_REFRESH_MS);
    expect(result.current.assets.map((a) => a.productId)).toEqual(["p2"]);
    expect(result.current.assets[0].outputUrl).toBe(newRow.outputUrl);
    expect(result.current.assetVersion).toBe(version + 1);
  });

  test("a read that never settles is given up on, and the next tick is issued", async () => {
    // Item 3. `fetchPersistedRun` had no timeout, so a request that never answered held
    // `inFlight` for ever: the `finally` never ran, no timer was armed, and the URLs on
    // screen simply aged out — twenty minutes later there was nothing left to refresh.
    // The handler below honours the signal exactly as a real `fetch` does, which is the
    // one thing the test needs and the reason the mock's `result` handler is handed the
    // request init at all.
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url, init) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        if (read === 1) return onDisk("seed", [signed(first, "rev-1")]);
        if (read === 2) {
          // Never resolves on its own; the abort is the only thing that settles it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          });
        }
        return onDisk("seed", [signed(first, `rev-${read}`)]);
      },
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");

    // The tick fires; the read hangs.
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 1);

    // Past the give-up the read is refused, and nothing on screen changed — a timed-out
    // read is a FAILED read, not an absence and not a report.
    await advance(30_000);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    expect(result.current.assets).toHaveLength(1);

    // And the next tick is really issued, which is the whole point: the URLs still renew.
    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 2);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-3").outputUrl);
  });

  test("a 403 no_membership on the re-read shows the membership error and changes nothing", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let denied = false;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        return denied
          ? json({ code: "no_membership" }, 403)
          : onDisk("seed", [signed(first, "rev-1")]);
      },
    });
    const { result } = setup();
    await settle();
    expect(result.current.membershipError).toBeNull();
    denied = true;

    await advance(URL_REFRESH_MS);

    expect(result.current.membershipError).toBe(NO_ORGANISATION_YET_MESSAGE);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);
    expect(result.current.assets).toHaveLength(1);
  });

  test("a 200 that names no run, and a read that fails, both keep the screen (F6)", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let served = 0;
    let mode: "ok" | "absent" | "broken" = "ok";
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        if (mode === "absent") return json(EMPTY_REPORT);
        if (mode === "broken") return json({ error: "boom" }, 500);
        served += 1;
        return onDisk("seed", [signed(first, `rev-${served}`)]);
      },
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);

    // A successful read that says "there is no run here": an absence, not a reason to
    // empty the grid.
    mode = "absent";
    await advance(URL_REFRESH_MS);
    await settle();
    expect(readsFor("seed")).toBe(baseline + 1);
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);

    // And a read that could not be made at all: also not an absence (D83/F6).
    mode = "broken";
    await advance(URL_REFRESH_MS);
    await settle();
    expect(readsFor("seed")).toBe(baseline + 2);
    expect(result.current.assets).toHaveLength(1);
    expect(result.current.membershipError).toBeNull();

    // The timer brings it back: the next good read commits as usual.
    mode = "ok";
    await advance(URL_REFRESH_MS);
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-2").outputUrl);
  });

  test("a report the server replaced with a halted, log-only run is a DIFFERENT report", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        // No `assets` key at all — a halted run the API still counts as a run, and
        // `fetchPersistedRun` accepts it. It is NOT the report on screen.
        return read === 1
          ? onDisk("seed", [signed(first, "rev-1")])
          : json({ halted: true, log: { entries: [], campaignId: "seed" } });
      },
    });
    const { result } = setup();
    await settle();
    const version = result.current.assetVersion;

    await advance(URL_REFRESH_MS);
    await settle();

    expect(result.current.assets).toHaveLength(0);
    expect(result.current.assetVersion).toBe(version + 1);
    // And with no signed URL left on screen there is nothing to refresh: the effect
    // stands down rather than keeping the timer running over an empty grid.
    const reads = readsFor("seed");
    await advance(60 * 60_000);
    expect(readsFor("seed")).toBe(reads);
  });

  test("a visibility change while a read is in flight starts no second read", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    const held = deferred();
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        return read === 1 ? onDisk("seed", [signed(first, "rev-1")]) : held.promise;
      },
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");

    await advance(URL_REFRESH_MS);
    expect(readsFor("seed")).toBe(baseline + 1);
    visibility("hidden");
    visibility("visible");
    expect(readsFor("seed")).toBe(baseline + 1);

    await act(async () => {
      held.resolve(onDisk("seed", [signed(first, "rev-2")]));
    });
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-2").outputUrl);
  });

  test("a failed read is not retried faster than 30 s, however the trigger arrives", async () => {
    vi.useFakeTimers();
    const first = row();
    const seeded = seedPersistedRun([first]);
    let failing = false;
    let served = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        if (failing) return json({ error: "boom" }, 500);
        served += 1;
        return onDisk("seed", [signed(first, `rev-${served}`)]);
      },
    });
    const { result } = setup();
    await settle();
    const baseline = readsFor("seed");
    failing = true;

    await advance(URL_REFRESH_MS);
    await settle();
    expect(readsFor("seed")).toBe(baseline + 1);
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-1").outputUrl);

    // Five hide/show presses inside the floor: a user toggling tabs is not a signal
    // that the API is back, so not one of them is a request.
    for (let i = 0; i < 5; i += 1) {
      visibility("hidden");
      visibility("visible");
      await advance(1_000);
    }
    expect(readsFor("seed")).toBe(baseline + 1);

    // Past the floor, one more press is exactly one read — and it commits.
    await advance(30_000);
    failing = false;
    visibility("hidden");
    visibility("visible");
    expect(readsFor("seed")).toBe(baseline + 2);
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(s3Urls(first, "rev-2").outputUrl);
  });

  test("after unmount nothing is read, and a switch to an fs-backed campaign stops the old one's reads", async () => {
    vi.useFakeTimers();
    const first = row();
    const other = row({ productId: "p2", outputPath: "p2/1x1.png" });
    const seeded = seedPersistedRun([first]);
    mockPipelineApi({
      opened: seeded,
      result: (url) =>
        String(url).includes("campaignId=other")
          ? onDisk("other", [onFs(other)])
          : String(url).includes("/campaigns/result?campaignId=seed")
            ? onDisk("seed", [signed(first, "rev-1")])
            : onDisk("seed", []),
    });

    // Unmount: the cleanup clears the pending timeout and the listener, and the read
    // that is in flight (if any) is refused by `mountedRef`. **Twice over in this
    // test** — the switch below tears the same provider down a second time, while it
    // is still mounted, which is the late-cleanup case: it must be read-only on the
    // state it does not own, or the new campaign's shell would lose its run.
    const unmounted = setup();
    await settle();
    const beforeUnmount = readsFor("seed");
    expect(beforeUnmount).toBe(1);
    unmounted.unmount();
    await advance(60 * 60_000);
    expect(readsFor("seed")).toBe(beforeUnmount);

    // A deliberate switch to an fs-backed campaign: nothing is armed for it at all, and
    // the campaign left behind is never read again.
    const { result } = setup();
    await settle();
    const seedReads = readsFor("seed");
    await act(async () => {
      result.current.setBrief({ ...result.current.brief, id: "other" } as never);
    });
    await settle();
    expect(result.current.assets[0].outputUrl).toBe(fsUrls(other).outputUrl);
    const otherReads = readsFor("other");
    await advance(60 * 60_000);
    visibility("hidden");
    visibility("visible");
    await advance(60_000);
    expect(readsFor("other")).toBe(otherReads);
    expect(readsFor("seed")).toBe(seedReads);
  });

  test("a read in flight when the campaign changes commits nothing", async () => {
    vi.useFakeTimers();
    const first = row();
    const other = row({ productId: "p2", outputPath: "p2/1x1.png" });
    const seeded = seedPersistedRun([first]);
    const held = deferred();
    let read = 0;
    mockPipelineApi({
      opened: seeded,
      result: (url) => {
        if (String(url).includes("campaignId=other")) return onDisk("other", [onFs(other)]);
        if (!String(url).includes("/campaigns/result?campaignId=seed")) return onDisk("seed", []);
        read += 1;
        return read === 1 ? onDisk("seed", [signed(first, "rev-1")]) : held.promise;
      },
    });
    const { result } = setup();
    await settle();

    await advance(URL_REFRESH_MS);
    expect(read).toBe(2);

    // The user moves to another campaign while the read is out: the effect is cleaned up,
    // which is what the read checks before it commits anything.
    await act(async () => {
      result.current.setBrief({ ...result.current.brief, id: "other" } as never);
    });
    await settle();

    await act(async () => {
      held.resolve(onDisk("seed", [signed(first, "rev-late")]));
    });
    await settle();

    expect(result.current.assets[0].outputUrl).toBe(fsUrls(other).outputUrl);
    const reads = readsFor("seed");
    await advance(60 * 60_000);
    expect(readsFor("seed")).toBe(reads);
  });
});
