import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EstimatePanel } from "../EstimatePanel";
import { initialEditorState, editorReducer, PLAN_DEBOUNCE_MS, type EditorState } from "../editor-state";
import { API } from "@/lib/run-context";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A state canPlan() accepts: variation mode, an id, a product, count >= 1. */
const planReady = (): EditorState => {
  const base = { ...initialEditorState(), mode: "variation" as const, briefId: "camp" };
  return editorReducer(base, { type: "setProduct", key: base.products[0].key, patch: { id: "alpha" } });
};

const OK_PLAN = {
  policyHash: "abc",
  seed: 7,
  estimate: { creatives: 12, axisProductSize: 4, feasible: true, genaiCalls: 3 },
  variants: [],
};

describe("EstimatePanel", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    // mockClear keeps the previous implementation, so a test that installs a rejecting
    // fetch would leak it into the next one. Reinstate a benign default every time.
    vi.mocked(globalThis.fetch).mockClear();
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(json(OK_PLAN)));
  });

  test("asks for nothing until the draft is plannable", () => {
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    render(<EstimatePanel state={initialEditorState()} />);
    expect(screen.getByText("Fill required fields to estimate.")).toBeTruthy();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });

  test("renders the estimate once the plan arrives", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json(OK_PLAN));
    render(<EstimatePanel state={planReady()} />);

    expect(screen.getByText("Estimating…")).toBeTruthy();
    expect(await screen.findByText("12")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("yes")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  test("an infeasible plan shows the reason the API gave", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json({ error: "minDistance exceeds the axes" }, 422));
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText("minDistance exceeds the axes")).toBeTruthy();
  });

  test("a feasible=false estimate still renders as a plan", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      json({ ...OK_PLAN, estimate: { ...OK_PLAN.estimate, feasible: false } }),
    );
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText("no")).toBeTruthy();
  });

  test("a 5xx degrades to 'estimate unavailable' rather than hanging", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json({ error: "boom" }, 503));
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText("estimate unavailable")).toBeTruthy();
  });

  test("a rejection degrades too — the panel must never sit on 'Estimating…' forever", async () => {
    // planCampaign handles fetch failures itself; this is a rejection escaping it,
    // e.g. the body stream failing after the response resolved.
    vi.mocked(globalThis.fetch).mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.reject(new Error("stream died")),
    } as unknown as Response);
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText("estimate unavailable")).toBeTruthy();
  });

  test("a non-Error rejection is handled too", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.reject("not an error object"),
    } as unknown as Response);
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText("estimate unavailable")).toBeTruthy();
  });

  test("an abort is the effect cleaning up, not a failure to report", async () => {
    // planCampaign swallows a rejection from fetch itself, so an abort only reaches the
    // component when it interrupts the body stream after the response resolved.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve({ status: 200, ok: true, text: () => Promise.reject(abort) } as unknown as Response),
    );
    render(<EstimatePanel state={planReady()} />);
    await tick(PLAN_DEBOUNCE_MS + 120);
    // stays on the in-flight message rather than claiming the estimate failed
    expect(screen.getByText("Estimating…")).toBeTruthy();
    expect(screen.queryByText("estimate unavailable")).toBeNull();
  });

  test("a body-stream rejection after unmount is dropped", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        text: () => new Promise((_, rej) => setTimeout(() => rej(new Error("stream died late")), 60)),
      } as unknown as Response),
    );
    const { unmount } = render(<EstimatePanel state={planReady()} />);
    await tick(PLAN_DEBOUNCE_MS + 40);
    unmount();
    await tick(120);
    expect(screen.queryByText("estimate unavailable")).toBeNull();
  });

  test("a plan that resolves after unmount is dropped", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      () => new Promise((res) => setTimeout(() => res(json(OK_PLAN)), 60)),
    );
    const { unmount } = render(<EstimatePanel state={planReady()} />);
    await tick(PLAN_DEBOUNCE_MS + 40); // the debounce fires and the request starts
    unmount();
    await tick(120); // it resolves with nothing left to update
    expect(screen.queryByText("12")).toBeNull();
  });

  test("a rejection after unmount is dropped too", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      () => new Promise((_, rej) => setTimeout(() => rej(new Error("late failure")), 60)),
    );
    const { unmount } = render(<EstimatePanel state={planReady()} />);
    await tick(PLAN_DEBOUNCE_MS + 40);
    unmount();
    await tick(120);
    expect(screen.queryByText("estimate unavailable")).toBeNull();
  });

  test("the request is re-issued when the motion axes change", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(json(OK_PLAN)));
    const ready = planReady();
    const { rerender } = render(<EstimatePanel state={ready} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const before = vi.mocked(globalThis.fetch).mock.calls.length;

    // toBrief carries motion and duration, so a change to either must re-plan
    rerender(<EstimatePanel state={{ ...ready, motion: ["ken-burns-in"], duration: [6] }} />);
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(before));
  });

  test("becoming unplannable clears a rendered estimate", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json(OK_PLAN));
    const ready = planReady();
    const { rerender } = render(<EstimatePanel state={ready} />);
    expect(await screen.findByText("12")).toBeTruthy();

    rerender(<EstimatePanel state={{ ...ready, mode: "brief" }} />);
    expect(screen.getByText("Fill required fields to estimate.")).toBeTruthy();
  });

  test("the request is re-issued when the requested formats change", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json(OK_PLAN));
    const ready = planReady();
    const { rerender } = render(<EstimatePanel state={ready} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const before = vi.mocked(globalThis.fetch).mock.calls.length;

    rerender(<EstimatePanel state={{ ...ready, formats: ["static", "motion"] }} />);
    await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(before));
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toContain(`${API}/campaigns/plan`);
  });
});
