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
}) {
  const store = new Map<string, { state: unknown; baseRevision: string | null }>();
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let failDeleteFor = opts.failDeleteFor;
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

  test("a reload finding a stale draft (whatever left it — a failed DELETE included) shows the published brief, not the draft", async () => {
    // Stands in for "the DELETE failed, so the draft is still there": from the
    // restore effect's own point of view, a draft that outlived its DELETE
    // attempt is indistinguishable from one that outlived any other reason —
    // its `baseRevision` ("r1") is what decides, compared against the
    // campaign's now-current one ("r2", a Save that landed since).
    const reloaded = draftRoutes({ list: () => json({ briefs: [entry("camp", "r2")] }) });
    const draftState = fromBrief(brief("camp"), { file: "camp.yaml", revision: "r1" });
    reloaded.seed("camp", { ...draftState, campaignMessage: "Stale pre-save draft" }, "r1");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // "r1" no longer matches the campaign's current revision ("r2"): the stale
    // draft is skipped, and the published brief (Headline "Hi") shows instead.
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi");
    expect(screen.queryByDisplayValue("Stale pre-save draft")).toBeNull();
  });
});
