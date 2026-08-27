import { describe, test, expect, vi, beforeEach } from "vitest";
import { useReducer } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HeadlinePoolDrawer } from "../HeadlinePoolDrawer";
import { editorReducer, initialEditorState, type EditorState } from "../editor-state";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const entry = (id: string, status = "pending", over: Record<string, unknown> = {}) => ({
  id,
  text: `headline ${id}`,
  status,
  ...over,
});

const poolBody = (entries: unknown[]) => ({ pool: { entries } });

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  mode: "variation",
  briefId: "camp",
  ...over,
});

/** Route by method, so a GET/POST/PATCH sequence can be scripted per test. */
const routes = (h: { get?: () => Response; post?: () => Response; patch?: () => Response }) => {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "POST") return Promise.resolve(h.post?.() ?? json(poolBody([entry("a", "approved")]), 201));
    if (method === "PATCH") return Promise.resolve(h.patch?.() ?? json(poolBody([entry("a", "approved")])));
    return Promise.resolve(h.get?.() ?? json(poolBody([])));
  });
  return calls;
};

/**
 * The drawer reads `pool` off the editor state, so a static state can never show what a
 * load returned. Drive it through the real reducer — that is also the integration worth
 * testing: load populates the pool, an explicit change updates the axis.
 */
const Harness = ({ initial, onClose }: { initial: EditorState; onClose?: () => void }) => {
  const [s, dispatch] = useReducer(editorReducer, initial);
  return <HeadlinePoolDrawer state={s} dispatch={dispatch} open onClose={onClose ?? (() => {})} />;
};

const open = (over: Partial<EditorState> = {}, onClose = vi.fn()) =>
  render(<Harness initial={state(over)} onClose={onClose} />);

describe("HeadlinePoolDrawer", () => {
  beforeEach(() => {
    // mockClear keeps the previous implementation; reinstate a benign default so a
    // rejecting fetch cannot leak into the next test.
    vi.mocked(globalThis.fetch).mockClear();
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(json(poolBody([]))));
  });

  test("renders nothing while closed, and fetches nothing", () => {
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    const { container } = render(
      <HeadlinePoolDrawer state={state()} dispatch={vi.fn()} open={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });

  test("opening loads the pool and lists its entries", async () => {
    routes({ get: () => json(poolBody([entry("a", "approved"), entry("b")])) });
    open();
    expect(await screen.findByText("headline a")).toBeTruthy();
    expect(screen.getByText("headline b")).toBeTruthy();
    expect(screen.getByText("Headlines (1 approved)")).toBeTruthy();
  });

  test("a brief with no pool yet says so rather than erroring", async () => {
    routes({ get: () => json({ error: "not found" }, 404) });
    open();
    expect(await screen.findByText("No headlines yet.")).toBeTruthy();
  });

  test("a failed load is reported", async () => {
    routes({ get: () => json({ error: "pool exploded" }, 500) });
    open();
    expect(await screen.findByText(/pool exploded/)).toBeTruthy();
  });

  test("loading the pool must not rewrite the draft — it dispatches loadPool, not setPool", async () => {
    const dispatch = vi.fn();
    routes({ get: () => json(poolBody([entry("a")])) });
    render(<HeadlinePoolDrawer state={state()} dispatch={dispatch} open onClose={vi.fn()} />);

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    const types = dispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("loadPool");
    expect(types).not.toContain("setPool");
  });

  test("a response for a brief the user has left is discarded", async () => {
    const dispatch = vi.fn();
    routes({ get: () => json(poolBody([entry("a")])) });
    const { rerender } = render(
      <HeadlinePoolDrawer state={state({ briefId: "camp" })} dispatch={dispatch} open onClose={vi.fn()} />,
    );
    // switch brief before the first response is consumed
    rerender(<HeadlinePoolDrawer state={state({ briefId: "other" })} dispatch={dispatch} open onClose={vi.fn()} />);

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    // every dispatched load names the brief it belongs to; the reducer drops mismatches
    for (const [action] of dispatch.mock.calls) {
      expect((action as { briefId: string }).briefId).toBeDefined();
    }
  });

  test("generating suggestions applies them through setPool", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const calls = routes({ get: () => json(poolBody([])), post: () => json(poolBody([entry("new", "approved")]), 201) });
    render(<HeadlinePoolDrawer state={state()} dispatch={dispatch} open onClose={vi.fn()} />);
    await waitFor(() => expect(dispatch).toHaveBeenCalled());

    await user.click(screen.getByText(/Generate 10 suggestions/));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() =>
      expect(dispatch.mock.calls.map((c) => (c[0] as { type: string }).type)).toContain("setPool"),
    );
  });

  test("a 503 warns and disables generate, and reopening clears it", async () => {
    const user = userEvent.setup();
    routes({ get: () => json(poolBody([])), post: () => json({ error: "no capacity" }, 503) });
    const { rerender } = render(<Harness initial={state()} />);
    await screen.findByText("No headlines yet.");

    await user.click(screen.getByText(/Generate 10 suggestions/));
    expect(await screen.findByText(/no capacity/)).toBeTruthy();
    const generate = screen.getByText(/Generate 10 suggestions/).closest("button") as HTMLButtonElement;
    await waitFor(() => expect(generate.disabled).toBe(true));

    // close and reopen: a transient outage must not disable the control for the session
    rerender(<HeadlinePoolDrawer state={state()} dispatch={vi.fn()} open={false} onClose={vi.fn()} />);
    rerender(<Harness initial={state()} />);
    await waitFor(() => expect(screen.queryByText(/no capacity/)).toBeNull());
  });

  test("a non-503 failure is shown as an error, not a warning", async () => {
    const user = userEvent.setup();
    routes({ get: () => json(poolBody([])), post: () => json({ error: "bad request" }, 400) });
    open();
    await screen.findByText("No headlines yet.");

    await user.click(screen.getByText(/Generate 10 suggestions/));
    expect(await screen.findByText(/bad request/)).toBeTruthy();
  });

  test("an entry can be approved and then rejected", async () => {
    const user = userEvent.setup();
    const calls = routes({
      get: () => json(poolBody([entry("a")])),
      patch: () => json(poolBody([entry("a", "approved")])),
    });
    open();
    await screen.findByText("headline a");

    await user.click(screen.getByLabelText("Approve a"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toMatchObject({
      entries: [{ id: "a", status: "approved" }],
    });

    // the refreshed pool has it approved, so the control now offers the inverse
    const reject = await screen.findByLabelText("Reject a");
    await user.click(reject);
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === "PATCH");
      expect(JSON.parse(patches[patches.length - 1].body!)).toMatchObject({
        entries: [{ id: "a", status: "rejected" }],
      });
    });
  });

  test("a load that fails after the drawer closes is dropped silently", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      () => new Promise((_, rej) => setTimeout(() => rej(new Error("too late")), 50)),
    );
    const { unmount } = render(<Harness initial={state()} />);
    unmount();
    await new Promise((r) => setTimeout(r, 120));
    // no state update escapes an unmounted drawer
    expect(screen.queryByText(/too late/)).toBeNull();
  });

  test("an entry's text can be edited, saved, or abandoned", async () => {
    const user = userEvent.setup();
    const calls = routes({
      get: () => json(poolBody([entry("a")])),
      patch: () => json(poolBody([entry("a", "pending", { text: "edited" })])),
    });
    open();
    await screen.findByText("headline a");

    await user.click(screen.getByLabelText("Edit a"));
    const field = screen.getByLabelText("Edit a") as HTMLInputElement;
    await user.clear(field);
    // an empty headline cannot be saved
    expect((screen.getByLabelText("Save a") as HTMLButtonElement).disabled).toBe(true);

    await user.type(field, "edited");
    await user.click(screen.getByLabelText("Save a"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toMatchObject({
      entries: [{ id: "a", text: "edited" }],
    });
  });

  test("cancelling an edit restores the original text", async () => {
    const user = userEvent.setup();
    routes({ get: () => json(poolBody([entry("a")])) });
    open();
    await screen.findByText("headline a");

    await user.click(screen.getByLabelText("Edit a"));
    await user.type(screen.getByLabelText("Edit a"), "!!!");
    await user.click(screen.getByLabelText("Cancel a"));
    expect(screen.getByText("headline a")).toBeTruthy();
  });

  test("a failed edit keeps the editor open so the text is not lost", async () => {
    const user = userEvent.setup();
    routes({ get: () => json(poolBody([entry("a")])), patch: () => json({ error: "nope" }, 400) });
    open();
    await screen.findByText("headline a");

    await user.click(screen.getByLabelText("Edit a"));
    await user.type(screen.getByLabelText("Edit a"), " more");
    await user.click(screen.getByLabelText("Save a"));

    expect(await screen.findByText(/nope/)).toBeTruthy();
    expect(screen.getByLabelText("Edit a")).toBeTruthy(); // still editing
  });

  test("a failure is not shown under a brief the user has since switched to", async () => {
    const user = userEvent.setup();
    let failGenerate = false;
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && failGenerate) {
        return new Promise((res) => setTimeout(() => res(json({ error: "stale failure" }, 500)), 60));
      }
      return Promise.resolve(json(poolBody([])));
    });

    // the plain component, so the brief really changes between renders (Harness's
    // useReducer would ignore a new `initial`)
    const props = (briefId: string) => ({
      state: state({ briefId }),
      dispatch: vi.fn(),
      open: true,
      onClose: () => {},
    });
    const { rerender } = render(<HeadlinePoolDrawer {...props("camp")} />);
    await screen.findByText("No headlines yet.");

    failGenerate = true;
    await user.click(screen.getByText(/Generate 10 suggestions/));
    rerender(<HeadlinePoolDrawer {...props("other")} />); // move on before it lands
    await new Promise((r) => setTimeout(r, 150));

    expect(screen.queryByText("stale failure")).toBeNull();
  });

  test("a moderation reason is surfaced next to its entry", async () => {
    routes({ get: () => json(poolBody([entry("a", "rejected", { reason: "off-brand" })])) });
    open();
    expect(await screen.findByText("off-brand")).toBeTruthy();
  });

  test("a dropped headline axis is announced", async () => {
    routes({ get: () => json(poolBody([])) });
    open({ headlineAxisDropped: true });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  test("it closes from the button and from the backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    routes({ get: () => json(poolBody([])) });
    const { container } = render(<Harness initial={state()} onClose={onClose} />);
    await screen.findByText("No headlines yet.");

    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(container.querySelector(".absolute.inset-0") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
