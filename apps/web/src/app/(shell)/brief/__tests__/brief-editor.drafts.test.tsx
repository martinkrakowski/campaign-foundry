import { describe, test, expect, afterEach, vi } from "vitest";
import { screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { renderWithRun, json, ShellProviders } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { EditorUnloadGuard } from "@/components/shell/EditorUnloadGuard";
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

/**
 * D185 — the two write states the shell's leave guard reads, rendered beside
 * the editor inside the same `EditorDirtyProvider` (which `renderWithRun`
 * mounts) so the assertion is on what the editor PUBLISHED, not on anything it
 * holds privately.
 */
const WriteFlags = () => {
  const { hasPendingWrite, hasFailedWrite } = useEditorDirty();
  return (
    <>
      <span data-testid="pending-write">{String(hasPendingWrite)}</span>
      <span data-testid="failed-write">{String(hasFailedWrite)}</span>
    </>
  );
};

const flag = (name: "pending-write" | "failed-write") => screen.getByTestId(name).textContent;

/** `cancelable: true` is not optional here: happy-dom defaults it to false, and
 *  on such an event `preventDefault()` does nothing, so a guard that had
 *  registered nothing at all would satisfy the assertion. */
const unload = (): Event => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

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
   * Fix round (bots) — hold every draft DELETE for this campaign id open until
   * `releaseDelete()` is called, instead of answering inline. A DELETE is the
   * one write on the chain that carries no unsaved work, and "no unsaved work
   * while one is on the wire" is only observable if the wire can be made to
   * stay out: an inline DELETE settles in the same tick it is queued, so the
   * window the leave guard has to be disarmed in is never open.
   */
  deferDeleteFor?: string;
  /**
   * D185 — force the next draft PUT for this campaign id to answer 500, once.
   * `fetch` resolves for a 500, so this is a write that LOOKED like it landed
   * and did not: the case the failed-write flag exists for, and the only way to
   * put it in reach of a test.
   */
  failPutFor?: string;
  /**
   * Fix round item 3 (grok-4.7) — hold the next draft GET for this campaign
   * id open until `releaseGet()` is called, instead of answering it inline:
   * exercising "a keystroke lands while the restore fetch is still in
   * flight" needs a real gap between the request going out and its answer
   * landing, which a same-tick `Promise.resolve` never leaves.
   */
  deferGetFor?: string;
  /**
   * Fix round (bots) — hold every draft PUT for this campaign id open until
   * `releasePut()` is called (FIFO — each call releases the oldest still
   * held), instead of answering inline: exercising "a second PUT is never
   * DISPATCHED before the first settles" (the write-chain fix) and "an
   * in-flight PUT completing after Revert's own DELETE" both need a real
   * gap between a PUT going out and its answer landing.
   *
   * Fix round (Qodo) — a LIST as well as a single id, because "one editor's
   * settlement must not clear another editor's pending write" needs two
   * campaigns' PUTs held open at once, and holding one would let the other
   * answer inline and settle before the assertion could mean anything.
   */
  deferPutFor?: string | string[];
}) {
  const store = new Map<string, { state: unknown; baseRevision: string | null }>();
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let failDeleteFor = opts.failDeleteFor;
  let failPutFor = opts.failPutFor;
  let releaseGet: ((response: Response) => void) | undefined;
  const heldGet = opts.deferGetFor
    ? new Promise<Response>((resolve) => {
        releaseGet = resolve;
      })
    : undefined;
  const deferPutFor = new Set(
    opts.deferPutFor === undefined
      ? []
      : typeof opts.deferPutFor === "string"
        ? [opts.deferPutFor]
        : opts.deferPutFor,
  );
  const pendingPuts: {
    id: string;
    state: unknown;
    baseRevision: string | null;
    release: (r: Response) => void;
  }[] = [];
  const heldDeletes: { id: string; release: (r: Response) => void }[] = [];
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
        if (failPutFor === id) {
          failPutFor = undefined;
          return Promise.resolve(json({ error: "boom" }, 500));
        }
        const state = parsed?.state;
        const baseRevision = typeof parsed?.baseRevision === "string" ? parsed.baseRevision : null;
        if (deferPutFor.has(id)) {
          return new Promise<Response>((resolve) => {
            pendingPuts.push({ id, state, baseRevision, release: resolve });
          });
        }
        store.set(id, { state, baseRevision });
        return Promise.resolve(json({ draft: { state, baseRevision, updatedAt: "t" } }));
      }
      if (method === "DELETE") {
        if (failDeleteFor === id) {
          failDeleteFor = undefined;
          return Promise.resolve(json({ error: "boom" }, 500));
        }
        if (opts.deferDeleteFor === id) {
          return new Promise<Response>((resolve) => {
            heldDeletes.push({ id, release: resolve });
          });
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
    /** How many deferred PUTs are currently held, unreleased. */
    pendingPutCount: () => pendingPuts.length,
    /** Release the OLDEST still-held PUT, performing its store write now
     *  (simulating the server only actually committing once this "request"
     *  is allowed to complete) and answering with its own content. */
    releasePut: () => {
      const next = pendingPuts.shift();
      if (!next) throw new Error("releasePut: nothing is held");
      store.set(next.id, { state: next.state, baseRevision: next.baseRevision });
      next.release(json({ draft: { ...next, updatedAt: "t" } }));
    },
    /** How many deferred DELETEs are currently held, unreleased. */
    pendingDeleteCount: () => heldDeletes.length,
    /** Release the OLDEST still-held DELETE, performing its store delete now. */
    releaseDelete: () => {
      const next = heldDeletes.shift();
      if (!next) throw new Error("releaseDelete: nothing is held");
      store.delete(next.id);
      next.release(json({ deleted: true }));
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
    // draft — still carrying its own "r1" — survives in the store. A reload
    // (a fresh mount at the same route) must not resurrect it: "r1" no
    // longer matches the campaign's now-current revision, so the restore
    // effect skips it and the freshly reloaded, published brief shows.
    //
    // The campaign's OWN starting revision is "r0", never "r1" — the
    // seeded draft's own baseRevision — on purpose: matching them would let
    // the FIRST mount's restore effect legitimately fire (its baseRevision
    // check has nothing to do with the Save/DELETE race this test is about)
    // and put the draft's content on screen before Save is even clicked,
    // contaminating what gets saved and turning `draftDivergedRef` genuinely
    // true — which races the deliberate post-Save DELETE below with a
    // SECOND, autosave-effect-driven delete that has nothing to fail
    // against. Mismatched from the start, restore never fires on either
    // mount, and the only DELETE in play is the deliberate one this test
    // means to force.
    let revision = "r0";
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

describe("draft write ordering and flush (fix round, bots)", () => {
  test("a second autosave PUT is never dispatched before the first one settles (Qodo — closes an out-of-order overwrite)", async () => {
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      deferPutFor: "camp",
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const headline = screen.getByLabelText("Headline") as HTMLInputElement;
      act(() => {
        fireEvent.change(headline, { target: { value: "Edit one" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(routed.pendingPutCount()).toBe(1);

      act(() => {
        fireEvent.change(headline, { target: { value: "Edit two" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      // The SECOND edit's own timer has fired — its `putServerDraft` call is
      // enqueued onto the write chain, but must not have been DISPATCHED
      // (no fetch sent) while the first is still held. Without the chain,
      // this would already be 2.
      expect(routed.pendingPutCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    // Releasing the first lets the chain move on to the second.
    routed.releasePut();
    await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
    routed.releasePut();
    await waitFor(() => {
      const stored = routed.stored("camp");
      expect((stored?.state as { campaignMessage?: string } | undefined)?.campaignMessage).toBe(
        "Edit two",
      );
    });
  });

  test("an edit inside the debounce window is still sent when the route unmounts before the timer fires (CodeRabbit + Qodo)", async () => {
    const routed = draftRoutes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    const view = renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const headline = screen.getByLabelText("Headline") as HTMLInputElement;
      act(() => {
        fireEvent.change(headline, { target: { value: "Almost lost" } });
      });
      // Well short of the 1 s window — the timer has not fired.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(routed.calls.some((c) => c.method === "PUT" && c.url.endsWith("/draft"))).toBe(false);
      // The route unmounts before the debounce would otherwise have flushed
      // it — the old behaviour just cancelled the timer and lost the edit.
      view.unmount();
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(routed.has("camp")).toBe(true));
    expect(
      (routed.stored("camp")?.state as { campaignMessage?: string } | undefined)?.campaignMessage,
    ).toBe("Almost lost");
  });

  test("a PUT already in flight when Revert's DELETE fires does not resurrect the discarded draft (Qodo)", async () => {
    const user = userEvent.setup();
    const routed = draftRoutes({
      meta: () =>
        json({ campaignId: "fresh", slug: "fresh", name: null, type: null, hasVersion: false }),
      deferPutFor: "fresh",
    });
    renderWithRun(<Editor id="fresh" />);
    await waitFor(() => expect(screen.getByText("fresh")).toBeTruthy());

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        fireEvent.change(screen.getByLabelText("Target Audience"), { target: { value: "x" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
    // The autosave PUT is in flight, held — nothing written yet.
    await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
    expect(routed.has("fresh")).toBe(false);

    // Revert fires while that PUT is still held. Its own DELETE is enqueued
    // onto the SAME write chain as the PUT, strictly AFTER it (program
    // order) — so it cannot even be DISPATCHED yet, only once the PUT ahead
    // of it in the chain has settled. This is the mechanism itself: without
    // it, DELETE would fire immediately, and the held PUT completing
    // afterward would resurrect the draft Revert just discarded.
    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));
    expect(
      routed.calls.some((c) => c.method === "DELETE" && c.url === `${API}/campaigns/fresh/draft`),
    ).toBe(false);

    // Now the held PUT is allowed to complete — the chain moves on to the
    // enqueued DELETE, which runs after it and wins: the draft ends up
    // gone, never resurrected with the discarded content.
    routed.releasePut();
    await waitFor(() =>
      expect(
        routed.calls.some((c) => c.method === "DELETE" && c.url === `${API}/campaigns/fresh/draft`),
      ).toBe(true),
    );
    await waitFor(() => expect(routed.has("fresh")).toBe(false));
  });
});

describe("the write flags the shell's leave guard reads (D185)", () => {
  /** Arm the debounce for the current draft and let its timer fire. */
  const flushDebounce = async (headline: HTMLInputElement, value: string) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        fireEvent.change(headline, { target: { value } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
  };

  test("a draft PUT answered 500 sets the failed flag, and a later PUT that lands clears it", async () => {
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      failPutFor: "camp",
    });
    renderWithRun(
      <>
        <Editor id="camp" />
        <WriteFlags />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // A freshly loaded campaign has written nothing: no write is in flight, and
    // none has failed.
    expect(flag("pending-write")).toBe("false");
    expect(flag("failed-write")).toBe("false");

    const headline = screen.getByLabelText("Headline") as HTMLInputElement;
    await flushDebounce(headline, "Lost to a 500");

    // The PUT was dispatched and answered 500. `fetch` RESOLVES for that — the
    // status is the only thing saying the edits are not on the server, which is
    // why the flag exists and why a 500 is not a "probably fine".
    await waitFor(() => expect(flag("failed-write")).toBe("true"));
    // Settled, not pending: the write finished, it just did not land.
    expect(flag("pending-write")).toBe("false");
    expect(routed.stored("camp")).toBeUndefined();

    // The next edit's PUT lands, and the work is on the server again — so the
    // failure is no longer lost work, and the flag comes back down.
    await flushDebounce(headline, "Landed for real");
    await waitFor(() => expect(flag("failed-write")).toBe("false"));
    expect(routed.has("camp")).toBe(true);
  });

  test("a draft PUT still on the write chain holds the pending flag until it is answered", async () => {
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      deferPutFor: "camp",
    });
    renderWithRun(
      <>
        <Editor id="camp" />
        <WriteFlags />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    const headline = screen.getByLabelText("Headline") as HTMLInputElement;
    await flushDebounce(headline, "In flight");

    // The debounce timer has already fired — `draftPutTimerRef` is null again,
    // which is exactly why the flag cannot be read off it. The write itself is
    // dispatched and held, unanswered.
    await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
    expect(flag("pending-write")).toBe("true");
    expect(flag("failed-write")).toBe("false");

    routed.releasePut();
    await waitFor(() => expect(flag("pending-write")).toBe("false"));
  });

  test("the pending flag survives an earlier write settling while a later one is still queued", async () => {
    // The chain's state, not a single write's: two edits in two debounce
    // windows queue two PUTs, and the second is not even dispatched until the
    // first settles. A flag lowered by the FIRST write settling would report
    // the chain idle while the second is still on it — and a close in that
    // window would lose the queued write without a prompt.
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      deferPutFor: "camp",
    });
    renderWithRun(
      <>
        <Editor id="camp" />
        <WriteFlags />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    const headline = screen.getByLabelText("Headline") as HTMLInputElement;
    await flushDebounce(headline, "Edit one");
    await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
    await flushDebounce(headline, "Edit two");
    // The second PUT is queued behind the first and has not been dispatched.
    expect(routed.pendingPutCount()).toBe(1);
    expect(flag("pending-write")).toBe("true");

    // The first settles and the second takes its place — still pending, because
    // it is still on the chain.
    routed.releasePut();
    await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
    expect(flag("pending-write")).toBe("true");

    routed.releasePut();
    await waitFor(() => expect(flag("pending-write")).toBe("false"));
    expect(
      (routed.stored("camp")?.state as { campaignMessage?: string } | undefined)?.campaignMessage,
    ).toBe("Edit two");
  });

  /**
   * Fix round (Qodo) — the four cases below all came from the same mistake, the
   * two write states being shell-wide booleans that every editor instance
   * assigned as though it were the only writer. Each test here is written so
   * that it fails against that shape and passes only against a per-editor
   * registration, and each names the case its own assertion is the witness for.
   */
  describe("fix round (Qodo) — the write state belongs to the editor, not the shell", () => {
    test("an unmount with a PUT still in flight keeps the tab guarded until that PUT answers", async () => {
      // Qodo 1. Closing the tab while a dispatched PUT is unresolved abandons
      // the request, so the operator's edits go with it — which is the whole
      // reason the pending flag exists. An unmount that cleared it to keep the
      // shell tidy left exactly that window unguarded, and the provider
      // outlives the route, so nothing downstream would ever re-arm it.
      const routed = draftRoutes({
        list: () => json({ briefs: [entry("camp", "r1")] }),
        deferPutFor: "camp",
      });
      const view = renderWithRun(
        <>
          <Editor id="camp" />
          <EditorUnloadGuard />
          <WriteFlags />
        </>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "Still on the wire");
      await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
      expect(flag("pending-write")).toBe("true");

      // Navigate away, keeping the shell's own providers mounted around the
      // route that went: `ShellProviders` is the same component element, so
      // `EditorDirtyProvider` — and the state its guard reads — survives the
      // editor's unmount, which is what a route change in the real app does.
      view.rerender(
        <ShellProviders>
          <EditorUnloadGuard />
          <WriteFlags />
        </ShellProviders>,
      );
      expect(flag("pending-write")).toBe("true");
      expect(unload().defaultPrevented).toBe(true);

      // The PUT answers, and only then does the writer have nothing left to
      // represent — the registry takes the entry out, and the guard releases.
      routed.releasePut();
      await waitFor(() => expect(flag("pending-write")).toBe("false"));
      expect(unload().defaultPrevented).toBe(false);
    });

    test("one editor's write settling cannot clear another editor's pending write (Qodo 2)", async () => {
      // Qodo 2. Two instances, in that order: the first queues a PUT, is
      // unmounted while it is still in flight, and the second queues one of
      // its own. The first's write then answers — and with one shared boolean
      // its settlement is what the shell would read as "idle", because the
      // identity check that used to gate it compared the FIRST editor's
      // private ref, which still matched its own last link. The second
      // editor's write is queued, undispatched, and would be lost on a close
      // with no warning at all.
      const routed = draftRoutes({
        list: () => json({ briefs: [entry("camp", "r1"), entry("other", "r1")] }),
        deferPutFor: ["camp", "other"],
      });
      const view = renderWithRun(
        <>
          {/* Keyed so this is a genuine second INSTANCE, not one instance told
              a different campaign: two writers are the thing under test. */}
          <Editor key="first" id="camp" />
          <WriteFlags />
        </>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "The first brief's edit");
      await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
      expect(flag("pending-write")).toBe("true");

      view.rerender(
        <ShellProviders>
          <Editor key="second" id="other" />
          <WriteFlags />
        </ShellProviders>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("other"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "The second brief's edit");
      await waitFor(() => expect(routed.pendingPutCount()).toBe(2));

      // The first editor's PUT answers. It belongs to a writer that is no
      // longer mounted, and it has no standing to say anything about the
      // second editor's write — which is still sitting on ITS chain.
      routed.releasePut();
      await waitFor(() => expect(routed.pendingPutCount()).toBe(1));
      expect(flag("pending-write")).toBe("true");

      routed.releasePut();
      await waitFor(() => expect(flag("pending-write")).toBe("false"));
      expect(
        (routed.stored("other")?.state as { campaignMessage?: string } | undefined)
          ?.campaignMessage,
      ).toBe("The second brief's edit");
    });

    test("a draft DELETE on the write chain is not a pending write, so a superseded editor's guard is released (Qodo 3)", async () => {
      // Qodo 3. A DELETE is a decision ABOUT the draft, not a copy of the
      // operator's edits, and it is queued on the same chain as every PUT so
      // it cannot be overtaken by one. Counting it as unsaved work kept the
      // guard armed on an editor that had just been saved or reverted: the
      // edits are in the published brief, and the DELETE pending means only
      // that a draft nobody needs is being swept up. The DELETE is HELD here,
      // because an inline one settles in the tick it is queued and the window
      // would never be open to look at.
      const user = userEvent.setup();
      const routed = draftRoutes({
        list: () => json({ briefs: [entry("camp", "r1")] }),
        deferDeleteFor: "camp",
      });
      renderWithRun(
        <>
          <Editor id="camp" />
          <EditorUnloadGuard />
          <WriteFlags />
        </>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "Saved, then swept up");
      await waitFor(() => expect(routed.has("camp")).toBe(true));
      expect(flag("pending-write")).toBe("false");

      // Revert back to the published brief. Its draft is discarded — the
      // DELETE goes out on the write chain and is held there.
      await user.click(screen.getByText("⋯"));
      await user.click(screen.getByText(messages.editorRevert));
      const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
      await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));
      await waitFor(() => expect(routed.pendingDeleteCount()).toBe(1));

      // The editor is clean, and the only thing on its chain is a DELETE: there
      // is nothing a close can lose, so the guard must be released even though
      // the chain is not idle.
      expect(flag("pending-write")).toBe("false");
      expect(flag("failed-write")).toBe("false");
      expect(unload().defaultPrevented).toBe(false);

      routed.releaseDelete();
      await waitFor(() => expect(routed.has("camp")).toBe(false));
      expect(flag("pending-write")).toBe("false");
    });

    test("a Save that supersedes a failed draft clears the failed flag (Qodo 4)", async () => {
      // Qodo 4, first discard path. The failed flag means the operator's edits
      // are on the screen and nowhere else; Save has just put them in the
      // published brief, so there is nothing left to warn about. Left set, it
      // kept the guard armed on a clean editor, and no later event in the
      // component's life would ever come along to clear it.
      const routed = draftRoutes({
        list: () => json({ briefs: [entry("camp", "r1")] }),
        failPutFor: "camp",
        put: (_url, body) =>
          json({ file: "camp.yaml", brief: { ...brief("camp"), ...body }, revision: "r2" }, 200),
      });
      renderWithRun(
        <>
          <Editor id="camp" />
          <EditorUnloadGuard />
          <WriteFlags />
        </>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "Never stored");
      await waitFor(() => expect(flag("failed-write")).toBe("true"));
      expect(unload().defaultPrevented).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
      await waitFor(() => expect(flag("failed-write")).toBe("false"));
      // The guard STAYS armed here, and rightly: a Save does not make the
      // editor clean (`save`, not `load` — edits made while the request was in
      // flight survive and stay dirty), so `isDirty` is arming it now. What
      // the test is about is that the failure is no longer contributing.
      expect(unload().defaultPrevented).toBe(true);
      // And the Save really did land — the clear is the supersede doing its
      // job, not a flag quietly forgotten.
      await waitFor(() =>
        expect(
          routed.calls.some(
            (c) => c.method === "PUT" && c.url.startsWith(`${API}/campaigns/briefs/camp`),
          ),
        ).toBe(true),
      );
    });

    test("a Revert that supersedes a failed draft clears the failed flag (Qodo 4, second discard path)", async () => {
      // Qodo 4, second discard path, and the one that reaches the draft
      // somewhere else: Revert on a "file" source has no local draft of its
      // own to discard, so it clears the failure on the autosave effect's own
      // pristine transition instead. Both are the same claim — the editor is
      // back to what the published brief already says — and a guard still
      // armed afterwards is warning about a clean editor for the rest of the
      // session.
      const user = userEvent.setup();
      const routed = draftRoutes({
        list: () => json({ briefs: [entry("camp", "r1")] }),
        failPutFor: "camp",
      });
      renderWithRun(
        <>
          <Editor id="camp" />
          <EditorUnloadGuard />
          <WriteFlags />
        </>,
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
      );
      await flushDebounce(screen.getByLabelText("Headline"), "Never stored");
      await waitFor(() => expect(flag("failed-write")).toBe("true"));
      expect(unload().defaultPrevented).toBe(true);

      await user.click(screen.getByText("⋯"));
      await user.click(screen.getByText(messages.editorRevert));
      const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
      await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));

      await waitFor(() => expect(flag("failed-write")).toBe("false"));
      expect(flag("pending-write")).toBe("false");
      expect(unload().defaultPrevented).toBe(false);
      await waitFor(() =>
        expect(
          routed.calls.some(
            (c) => c.method === "DELETE" && c.url === `${API}/campaigns/camp/draft`,
          ),
        ).toBe(true),
      );
    });
  });
});

describe("the leave guard over a real draft write (D185)", () => {
  test("a draft PUT answered 500 keeps the tab guarded, and the guard releases nothing until the editor does", async () => {
    // The two halves met: the editor's write flags and the shell's one
    // `beforeunload` listener, with the debounce, the chain and the PUT's own
    // status in between. What is left un-proved here — that a later PUT that
    // lands RELEASES the listener — cannot be, because an edited editor that
    // was never saved stays dirty on its own account, so the guard would
    // rightly stay armed whatever the write did.
    const routed = draftRoutes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      failPutFor: "camp",
    });
    renderWithRun(
      <>
        <Editor id="camp" />
        <EditorUnloadGuard />
        <WriteFlags />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    const headline = screen.getByLabelText("Headline") as HTMLInputElement;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        fireEvent.change(headline, { target: { value: "Never stored" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => expect(flag("failed-write")).toBe("true"));
    // The edits are on the screen and nowhere else, so closing the tab now
    // loses them: the browser's own prompt is the only warning there is.
    expect(unload().defaultPrevented).toBe(true);

    // A later PUT lands, and the failed-write flag comes back down with it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        fireEvent.change(headline, { target: { value: "Stored at last" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(flag("failed-write")).toBe("false"));
    expect(routed.has("camp")).toBe(true);
  });
});
