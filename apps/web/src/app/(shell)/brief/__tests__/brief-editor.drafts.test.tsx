import { describe, test, expect, afterEach, vi } from "vitest";
import { screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { renderWithRun, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import { fromBrief } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";

/**
 * PT-5d — the autosave/restore/post-Save-delete effects, isolated from
 * `brief-editor.test.tsx`'s 298 real-timer `waitFor`s (that file's own
 * comment names the asyncUtilTimeout headroom those cost): the debounce
 * assertions here need fake timers, which would fight RTL's own internal
 * polling (also `setTimeout`-based) if mixed into that file. Fake timers are
 * scoped to each test's own debounce-sensitive window, entered only after the
 * initial mount has settled under REAL timers — `waitFor`'s internal polling
 * needs a real `setTimeout` to ever resolve.
 */

const Editor = ({ id }: { id?: string }) => <BriefEditor briefId={id} />;

afterEach(() => {
  vi.useRealTimers();
});

const brief = (id: string): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
});

const entry = (id: string, revision?: string) => ({
  file: `${id}.yaml`,
  brief: brief(id),
  revision,
});

/**
 * A minimal per-campaign draft store, backing `GET`/`PUT`/`DELETE
 * /campaigns/:id/draft` for whichever campaign ids these tests name. Distinct
 * from `brief-editor.test.tsx`'s own richer `routes()` (not exported, and
 * this file needs only the draft surface plus a listing/meta/save default).
 */
function draftRoutes(opts: {
  list?: () => Response;
  meta?: (id: string) => Response;
  put?: (url: string, body?: Record<string, unknown>) => Response;
  /** Force the next DELETE for this campaign id to answer 500. */
  failDeleteFor?: string;
  /**
   * Fix round item 3 (grok-4.7) — hold the next draft GET for this campaign
   * id open until `releaseGet()` is called, instead of answering it inline:
   * exercising "a keystroke lands while the restore fetch is still in
   * flight" needs a real gap between the request going out and its answer
   * landing, which a same-tick `Promise.resolve` never leaves.
   */
  deferGetFor?: string;
}) {
  const store = new Map<string, { state: unknown; baseRevision: string | null }>();
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let failDeleteFor = opts.failDeleteFor;
  let releaseGet: ((response: Response) => void) | undefined;
  const heldGet = opts.deferGetFor
    ? new Promise<Response>((resolve) => {
        releaseGet = resolve;
      })
    : undefined;
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const parsed =
      typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    calls.push({ url: u, method, ...(parsed ? { body: parsed } : {}) });

    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(json({ motion: true }));
    }
    if (method === "GET" && u === `${API}/campaigns/briefs/draft`) {
      return Promise.resolve(json({ latest: null }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(opts.list?.() ?? json({ briefs: [] }));
    }
    const draftMatch = /^\/campaigns\/([^/]+)\/draft$/.exec(u.slice(API.length));
    if (draftMatch) {
      const id = draftMatch[1]!;
      if (method === "GET") {
        if (opts.deferGetFor === id && heldGet) return heldGet;
        const rec = store.get(id);
        return Promise.resolve(json({ draft: rec ? { ...rec, updatedAt: "t" } : null }));
      }
      if (method === "PUT") {
        const state = parsed?.state;
        const baseRevision = typeof parsed?.baseRevision === "string" ? parsed.baseRevision : null;
        store.set(id, { state, baseRevision });
        return Promise.resolve(json({ draft: { state, baseRevision, updatedAt: "t" } }));
      }
      if (method === "DELETE") {
        if (failDeleteFor === id) {
          failDeleteFor = undefined;
          return Promise.resolve(json({ error: "boom" }, 500));
        }
        store.delete(id);
        return Promise.resolve(json({ deleted: true }));
      }
    }
    if (
      opts.meta &&
      method === "GET" &&
      u.startsWith(`${API}/campaigns/`) &&
      !u.startsWith(`${API}/campaigns/briefs`) &&
      !u.startsWith(`${API}/campaigns/capabilities`) &&
      !u.slice(`${API}/campaigns/`.length).includes("/")
    ) {
      return Promise.resolve(opts.meta(u.slice(u.lastIndexOf("/") + 1)));
    }
    if (method === "PUT") {
      return Promise.resolve(
        opts.put?.(u, parsed) ?? json({ file: "x.yaml", brief: brief("x"), revision: "rev-new" }),
      );
    }
    return Promise.resolve(json({}, 404));
  });
  return {
    calls,
    seed: (id: string, state: unknown, baseRevision: string | null) =>
      store.set(id, { state, baseRevision }),
    has: (id: string) => store.has(id),
    stored: (id: string) => store.get(id),
    /** Answer the held draft GET now, with whatever `seed` last put there. */
    releaseGet: () => {
      const id = opts.deferGetFor!;
      const rec = store.get(id);
      releaseGet?.(json({ draft: rec ? { ...rec, updatedAt: "t" } : null }));
    },
  };
}

describe("draft autosave debounce (PT-5d item 4)", () => {
  test("two edits inside one 1 s window make exactly one PUT, with the second edit's content", async () => {
    const { calls } = draftRoutes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    const putsSoFar = () =>
      calls.filter((c) => c.method === "PUT" && c.url.endsWith("/draft")).length;
    expect(putsSoFar()).toBe(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const headline = screen.getByLabelText("Headline") as HTMLInputElement;
      act(() => {
        fireEvent.change(headline, { target: { value: "Hi one" } });
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(putsSoFar()).toBe(0);
      act(() => {
        fireEvent.change(headline, { target: { value: "Hi two" } });
      });
      // Just short of the full window since the SECOND edit: still nothing.
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(putsSoFar()).toBe(0);
      // The last millisecond of the window since the second edit: exactly one PUT.
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    expect(putsSoFar()).toBe(1);
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/draft"));
    expect((put?.body?.state as { campaignMessage?: string } | undefined)?.campaignMessage).toBe(
      "Hi two",
    );
  });
});

describe("draft restore (PT-5d item 4)", () => {
  test("a draft is restored only when its base_revision equals the campaign's current revision", async () => {
    const matching = draftRoutes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    matching.seed("camp", { ...draftState, campaignMessage: "Unsaved work" }, "r1");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Unsaved work"),
    );
  });

  test("restore is skipped when the draft's base_revision is stale, leaving the published brief on screen", async () => {
    const stale = draftRoutes({ list: () => json({ briefs: [entry("camp", "r2")] }) });
    // The draft was taken against "r1"; the campaign has since moved to "r2".
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    stale.seed("camp", { ...draftState, campaignMessage: "Stale unsaved work" }, "r1");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // The published brief's own Headline stands — never the stale draft's.
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi");
    expect(screen.queryByDisplayValue("Stale unsaved work")).toBeNull();
  });

  test("a file source with no revision at all (a legacy listing entry) computes a null current revision", async () => {
    const user = userEvent.setup();
    // `entry()` with no revision — `state.source.revision` is `undefined`,
    // not a string, so both the restore effect's and the autosave effect's
    // own `state.source.revision ?? null` must fall through to `null` rather
    // than leaking `undefined` into a JSON body as a missing key.
    const legacy = draftRoutes({ list: () => json({ briefs: [entry("camp")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    await user.type(screen.getByLabelText("Target Audience"), "x");
    await waitFor(() => expect(legacy.has("camp")).toBe(true));
    expect(legacy.stored("camp")?.baseRevision).toBeNull();
  });

  test("the restore effect fetches once per route, not on every re-render", async () => {
    const once = draftRoutes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    once.seed("camp", { ...draftState, campaignMessage: "Unsaved work" }, "r1");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Unsaved work"),
    );
    const draftGets = () =>
      once.calls.filter((c) => c.method === "GET" && c.url === `${API}/campaigns/camp/draft`)
        .length;
    expect(draftGets()).toBe(1);

    // An unrelated re-render (another keystroke) must not re-fetch the draft
    // it already restored — `restoredDraftForRouteRef` is keyed on the route,
    // not on `state`, which the restore itself changes.
    act(() => {
      fireEvent.change(screen.getByLabelText("Target Audience"), { target: { value: "more" } });
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Target Audience") as HTMLInputElement).value).toBe("more"),
    );
    expect(draftGets()).toBe(1);
  });

  test("a keystroke landing while the draft GET is still in flight survives the restore, not the other way round (fix round item 3, grok-4.7)", async () => {
    const user = userEvent.setup();
    const held = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      deferGetFor: "camp",
    });
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    held.seed("camp", { ...draftState, campaignMessage: "Old unsaved work" }, "r1");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // The restore fetch is out and held — nothing has been dispatched yet.
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi");

    // A keystroke lands while that GET is still pending.
    await user.clear(screen.getByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Fresh typing");
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Fresh typing"),
    );

    // Now the draft answer lands — restoring it would clobber what was just
    // typed. It must not: the live state moved since this effect started.
    act(() => {
      held.releaseGet();
    });
    // Give the restore effect's microtask a turn to (not) dispatch.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Fresh typing");
    expect(screen.queryByDisplayValue("Old unsaved work")).toBeNull();
  });

  test("a seeded, versionless campaign's autosave PUT carries a null base_revision", async () => {
    const user = userEvent.setup();
    const calls = draftRoutes({
      meta: () =>
        json({ campaignId: "fresh", slug: "fresh", name: null, type: null, hasVersion: false }),
    });
    renderWithRun(<Editor id="fresh" />);
    await waitFor(() => expect(screen.getByText("fresh")).toBeTruthy());
    await user.type(screen.getByLabelText("Target Audience"), "x");
    await waitFor(() => expect(calls.has("fresh")).toBe(true));
    // No published version exists yet (D177: "no published version" is
    // itself the value this carries) — never a string, and never omitted.
    expect(calls.stored("fresh")?.baseRevision).toBeNull();
  });
});

describe("draft delete on Revert (PT-5d item 4)", () => {
  test("reverting a seeded, versionless campaign's unsaved edits deletes its server draft", async () => {
    const user = userEvent.setup();
    const routed = draftRoutes({
      meta: () =>
        json({ campaignId: "fresh", slug: "fresh", name: null, type: null, hasVersion: false }),
    });
    renderWithRun(<Editor id="fresh" />);
    await waitFor(() => expect(screen.getByText("fresh")).toBeTruthy());
    await user.type(screen.getByLabelText("Target Audience"), "x");
    await waitFor(() => expect(routed.has("fresh")).toBe(true));

    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));

    await waitFor(() =>
      expect(
        routed.calls.some((c) => c.method === "DELETE" && c.url === `${API}/campaigns/fresh/draft`),
      ).toBe(true),
    );
  });
});

describe("a reload after a Save whose DELETE failed (PT-5d item 4)", () => {
  test("a failed post-Save DELETE does not surface an error, and the Save itself still lands", async () => {
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: (_url, body) =>
        json({ file: "camp.yaml", brief: { ...brief("camp"), ...body }, revision: "r2" }, 200),
      failDeleteFor: "camp",
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // The Save completes normally — deleteServerDraft is fire-and-forget
    // (editor-state.ts), so its 500 never reaches the Save flow at all.
    await waitFor(() =>
      expect(
        routed.calls.some(
          (c) => c.method === "PUT" && c.url.startsWith(`${API}/campaigns/briefs/camp`),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
  });

  test("a reload after a Save whose DELETE failed shows the published brief, not the leftover draft (fix round item 5, grok-4.7)", async () => {
    // The real sequence, not a stand-in for it: a draft exists (as autosave
    // would have left one, seeded directly here); Save lands and bumps the
    // campaign to "r2"; its own post-Save DELETE is forced to fail, so the
    // draft — still carrying the PRE-save "r1" — survives in the store. A
    // reload (a fresh mount at the same route) must not resurrect it: "r1"
    // no longer matches the campaign's now-current revision, so the restore
    // effect skips it and the freshly reloaded, published brief shows.
    let revision = "r1";
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", revision)] }),
      put: (_url, body) => {
        revision = "r2";
        return json({ file: "camp.yaml", brief: { ...brief("camp"), ...body }, revision }, 200);
      },
      failDeleteFor: "camp",
    });
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    routed.seed("camp", { ...draftState, campaignMessage: "Stale pre-save draft" }, "r1");

    const first = renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(
        routed.calls.some(
          (c) => c.method === "PUT" && c.url.startsWith(`${API}/campaigns/briefs/camp`),
        ),
      ).toBe(true),
    );
    // The DELETE was attempted (and made to fail) — the draft is still there.
    await waitFor(() =>
      expect(
        routed.calls.some((c) => c.method === "DELETE" && c.url === `${API}/campaigns/camp/draft`),
      ).toBe(true),
    );
    expect(routed.has("camp")).toBe(true);
    expect(routed.stored("camp")?.baseRevision).toBe("r1");

    // The reload: a fresh mount at the same route, listing now answering the
    // Save's own "r2".
    const draftGetsBeforeReload = routed.calls.filter(
      (c) => c.method === "GET" && c.url === `${API}/campaigns/camp/draft`,
    ).length;
    first.unmount();
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // Wait for the RELOAD's own restore fetch to land — not just render — so
    // a bug that would restore the leftover draft has actually had its
    // chance to dispatch before the assertions below run; asserting right
    // after the listing settles would let a would-be restore's own pending
    // microtask slip past unnoticed, passing by accident rather than by
    // proof (exactly the "never reloads" gap the fix round called out).
    await waitFor(() =>
      expect(
        routed.calls.filter((c) => c.method === "GET" && c.url === `${API}/campaigns/camp/draft`)
          .length,
      ).toBeGreaterThan(draftGetsBeforeReload),
    );
    // One more turn for that GET's own `.then` (the restore effect's
    // compare-and-maybe-dispatch) to actually run.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi");
    expect(screen.queryByDisplayValue("Stale pre-save draft")).toBeNull();
  });
});
