import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as messages from "../messages";
import { EstimatePanel } from "../EstimatePanel";
import { classicAdCount } from "../derive";
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
  variants: [
    ...Array.from({ length: 6 }, () => ({ aspectRatio: "1:1", productId: "alpha" })),
    ...Array.from({ length: 6 }, () => ({ aspectRatio: "9:16", productId: "alpha" })),
  ],
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
    expect(screen.getByText(messages.estimateNotReady)).toBeTruthy();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });

  test("renders the estimate once the plan arrives", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json(OK_PLAN));
    render(<EstimatePanel state={planReady()} />);

    expect(screen.getByText(messages.estimateWorking)).toBeTruthy();
    // D2/D6: a sentence, not a field dump — the total, how it splits across the
    // ratios by their display names, the products it covers, and the AI cost.
    expect(await screen.findByText(/You will get 12 ads/)).toBeTruthy();
    const sentence = screen.getByText(/You will get 12 ads/).textContent ?? "";
    expect(sentence).toContain("6 square, 6 tall");
    expect(sentence).toMatch(/for \d+ products?\./);
    expect(sentence).toContain("3 AI image calls.");
    // and none of the planner's own vocabulary leaks out
    expect(sentence).not.toMatch(/axisProductSize|genaiCalls|feasible|9:16/);
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
    // feasibility is not a word the sentence uses: an infeasible plan comes back as
    // kind "infeasible" and says why. A feasible=false "ok" plan still reads normally.
    expect(await screen.findByText(/You will get/)).toBeTruthy();
  });

  test("a 5xx degrades to 'estimate unavailable' rather than hanging", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(json({ error: "boom" }, 503));
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText(messages.estimateUnavailable)).toBeTruthy();
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
    expect(await screen.findByText(messages.estimateUnavailable)).toBeTruthy();
  });

  test("a non-Error rejection is handled too", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.reject("not an error object"),
    } as unknown as Response);
    render(<EstimatePanel state={planReady()} />);
    expect(await screen.findByText(messages.estimateUnavailable)).toBeTruthy();
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
    expect(screen.getByText(messages.estimateWorking)).toBeTruthy();
    expect(screen.queryByText(messages.estimateUnavailable)).toBeNull();
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
    expect(screen.queryByText(messages.estimateUnavailable)).toBeNull();
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
    expect(screen.queryByText(messages.estimateUnavailable)).toBeNull();
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
    expect(await screen.findByText(/You will get 12 ads/)).toBeTruthy();

    rerender(<EstimatePanel state={{ ...ready, mode: "brief" }} />);
    expect(screen.getByText(messages.estimateNotReady)).toBeTruthy();
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

describe("EstimatePanel — the classic draft (W4.3)", () => {
  const classicWith = (treatments: number): EditorState => {
    let s = planReady(); // a product with an id, but mode variation
    s = editorReducer(s, { type: "setMode", mode: "brief" });
    for (let i = 0; i < treatments; i += 1) s = editorReducer(s, { type: "addTreatment" });
    return s;
  };

  test("a blank classic brief shows the not-ready sentence", () => {
    render(<EstimatePanel state={initialEditorState()} />);
    expect(screen.getByText(messages.estimateNotReady)).toBeTruthy();
  });

  test("a classic draft derives its count from products × ratios × treatments", () => {
    render(<EstimatePanel state={classicWith(1)} />);
    const sentence = screen.getByText(/You will get 3 ads/);
    expect(sentence.textContent).toBe(
      "You will get 3 ads — 1 square, 1 tall, 1 wide — for 1 product. No AI image calls.",
    );
  });

  test("classic derivation is shared with the CommandBar, so both spell the count alike", () => {
    // classicAdCount is the single formula the panel and the command bar both read.
    expect(classicAdCount(2, 4)).toBe(24);
  });
});

describe("EstimatePanel — the ratio split", () => {
  test("a variant without a ratio joins no bucket, and the total still comes from the estimate", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      json({
        ...OK_PLAN,
        estimate: { ...OK_PLAN.estimate, creatives: 3, genaiCalls: 0 },
        variants: [{ aspectRatio: "1:1" }, { productId: "alpha" }, { aspectRatio: "1:1" }],
      }),
    );
    render(<EstimatePanel state={planReady()} />);
    const sentence = await screen.findByText(/You will get 3 ads/);
    // two of the three carry a ratio, so the split names one bucket and is left off;
    // the count the user reads is the planner's, not the buckets' sum
    expect(sentence.textContent).toBe("You will get 3 ads for 1 product. No AI image calls.");
  });
});

describe("countReadout", () => {
  test("counts its ads, singular and plural, always against the ceiling", () => {
    expect(messages.countReadout(1, 24)).toBe("1 ad · up to 24");
    expect(messages.countReadout(12, 24)).toBe("12 ads · up to 24");
    expect(messages.countReadout(0, 24)).toBe("0 ads · up to 24");
  });
});

describe("estimateSentence", () => {
  const parts = {
    creatives: 12,
    ratios: [
      { label: "Square", count: 6 },
      { label: "Tall", count: 6 },
    ],
    products: 2,
    genaiCalls: 0,
  };

  test("reads as the plan's own sentence", () => {
    expect(messages.estimateSentence(parts)).toBe(
      "You will get 12 ads — 6 square, 6 tall — for 2 products. No AI image calls.",
    );
  });

  test("a single ratio needs no split, and one of anything is singular", () => {
    expect(
      messages.estimateSentence({
        creatives: 1,
        ratios: [{ label: "Square", count: 1 }],
        products: 1,
        genaiCalls: 1,
      }),
    ).toBe("You will get 1 ad for 1 product. 1 AI image call.");
  });

  test("no ratios at all still says what you get", () => {
    expect(messages.estimateSentence({ creatives: 4, ratios: [], products: 2, genaiCalls: 9 })).toBe(
      "You will get 4 ads for 2 products. 9 AI image calls.",
    );
  });
});
