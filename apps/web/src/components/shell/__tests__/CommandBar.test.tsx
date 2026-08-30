import { describe, test, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { useEffect } from "react";
import { renderWithRun, seedPersistedRun, makeAsset, exerciseFocusTrap, json, mockPipelineApi } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import { CommandBar } from "../CommandBar";

const variationBrief = {
  id: "seed",
  mode: "variation" as const,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
};

const seedVariation = () => {
  localStorage.setItem("cf:brief-picked", "1");
  localStorage.setItem("cf:brief", JSON.stringify(variationBrief));
};

const okEstimate = { creatives: 12, axisProductSize: 36, feasible: true, genaiCalls: 0 };

const okPlan = (over: Record<string, unknown> = {}) =>
  json({
    policyHash: "h1",
    seed: 1,
    estimate: okEstimate,
    variants: [],
    ...over,
  });

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("CommandBar", () => {
  test("toggles the telemetry drawer", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithRun(<CommandBar onToggleTelemetry={onToggle} />);
    await user.click(screen.getByLabelText("Toggle telemetry logs"));
    expect(onToggle).toHaveBeenCalled();
  });

  test("confirms and runs the full pipeline", async () => {
    const user = userEvent.setup();
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(screen.getByText(/Standing by/)).toBeTruthy();
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog", { name: "Confirm pipeline action" });
    expect(within(dialog).getByText(/every product × aspect ratio × treatment/)).toBeTruthy();
    await user.click(within(dialog).getByText("Generate"));
    await waitFor(() => expect(screen.getByText(/Execution complete|Standing by|Orchestrating/)).toBeTruthy());
  });

  test("cancel closes the confirm dialog without running", async () => {
    const user = userEvent.setup();
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog");
    exerciseFocusTrap(dialog);
    await user.keyboard("{Escape}"); // Escape closes the confirm dialog
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByText(/Execute/));
    await screen.findByRole("dialog");
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("shows a regenerate action once creatives are rejected", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected" }));
    seedPersistedRun([makeAsset(), makeAsset({ productId: "beta", outputPath: "beta/1x1.png" })]);
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    const regen = await screen.findByText(/Regenerate/);
    await user.click(regen);
    const dialog = await screen.findByRole("dialog", { name: "Confirm pipeline action" });
    expect(within(dialog).getByText(/1 rejected/)).toBeTruthy();
    await user.click(within(dialog).getByText("Regenerate rejected"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("cannot re-roll a classic run once the brief is randomized — the control still answers, and says why", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected" }));
    seedPersistedRun([makeAsset()]);
    // switch the (same) brief to a randomized campaign after the classic run is showing
    const Randomize = () => {
      const { brief, setBrief, hasRun } = useRun();
      // only once the persisted run has attached — setBrief before that would race the restore
      useEffect(() => {
        if (hasRun && brief.mode !== "variation") {
          setBrief({ ...brief, mode: "variation", variation: { count: 1 } } as never);
        }
      }, [hasRun, brief, setBrief]);
      return null;
    };
    renderWithRun(
      <>
        <Randomize />
        <CommandBar onToggleTelemetry={() => {}} />
      </>,
    );
    const regen = (await screen.findByText(/Regenerate/)).closest("button") as HTMLButtonElement;
    // The verb stays live: disabling it made the tap do nothing at all, and `title` is
    // unreachable on a touch device, so the refusal never reached the user.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /came from a classic run, but the brief is now a randomized campaign/,
      ),
    );
    expect(regen.disabled).toBe(false);
    // The refusal is reachable without the (touch-invisible) title tooltip.
    const describedBy = regen.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/came from a classic run/);
    await user.click(regen);
    // Refused, so no confirm — but the bar now states the reason as well.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getAllByText(/came from a classic run, but the brief is now a randomized campaign/)).toHaveLength(2),
    );
  });

  test("does not call /campaigns/plan for a classic brief", async () => {
    const plan = vi.fn(() => okPlan());
    mockPipelineApi({ plan });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(screen.getByText(/Standing by/)).toBeTruthy();
    expect(screen.queryByText("Estimating…")).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(plan).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("shows a feasible variation estimate and keeps Execute enabled", async () => {
    const user = userEvent.setup();
    seedVariation();
    mockPipelineApi({ plan: () => okPlan() });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(screen.getByText("Estimating…")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("12")).toBeTruthy();
    expect(screen.getByText("36")).toBeTruthy();
    expect(screen.getByText("yes")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: /Execute/ }));
    expect(within(await screen.findByRole("dialog")).getByText(/from the variation plan/)).toBeTruthy();
  });

  test("shows frames and the encode estimate for a motion plan", async () => {
    seedVariation();
    mockPipelineApi({ plan: () => okPlan({ estimate: { ...okEstimate, frames: 3600 } }) });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(await screen.findByText("3600")).toBeTruthy();
    expect(screen.getByText("frames")).toBeTruthy();
    expect(screen.getByText("≈ 0.4 min")).toBeTruthy();
  });

  test("shows an infeasible 422 message verbatim and disables Execute", async () => {
    seedVariation();
    mockPipelineApi({
      plan: () => json({ error: "shortfall: accepted 4 of 100" }, 422),
    });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(await screen.findByText("shortfall: accepted 4 of 100")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("shows estimate unavailable on a plan network error", async () => {
    seedVariation();
    mockPipelineApi({
      plan: () => {
        throw new TypeError("offline");
      },
    });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(await screen.findByText("estimate unavailable")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("warns when the plan will make GenAI calls and shows feasible=no", async () => {
    seedVariation();
    mockPipelineApi({
      plan: () =>
        okPlan({
          estimate: { creatives: 8, axisProductSize: 10, feasible: false, genaiCalls: 4 },
        }),
    });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(await screen.findByText("Cost warning: this plan makes 4 GenAI calls.")).toBeTruthy();
    expect(screen.getByText("no")).toBeTruthy();
  });

  test("skips a UI replace when a refetch returns the same policyHash", async () => {
    function Tweak() {
      const { setBrief, brief } = useRun();
      return createElement(Fragment, null,
        createElement("button", {
          onClick: () => setBrief({ ...brief, campaignMessage: "Stay wilder" }),
        }, "tweak"),
        createElement(CommandBar, { onToggleTelemetry: () => {} }),
      );
    }
    const user = userEvent.setup();
    seedVariation();
    let calls = 0;
    mockPipelineApi({
      plan: () => {
        calls += 1;
        return okPlan({ policyHash: "same-hash" });
      },
    });
    renderWithRun(<Tweak />);
    expect(await screen.findByText("12")).toBeTruthy();
    expect(calls).toBe(1);
    await user.click(screen.getByText("tweak"));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(screen.queryByText("Estimating…")).toBeNull());
    expect(screen.getByText("12")).toBeTruthy();
  });

  test("a brief change disables Execute until the new estimate arrives", async () => {
    function Tweak() {
      const { setBrief, brief, estimateStatus } = useRun();
      return createElement(Fragment, null,
        createElement("button", {
          onClick: () => setBrief({ ...brief, campaignMessage: "Stay wilder" }),
        }, "tweak"),
        createElement("span", null, `status:${estimateStatus}`),
        createElement(CommandBar, { onToggleTelemetry: () => {} }),
      );
    }
    const user = userEvent.setup();
    seedVariation();
    let calls = 0;
    let resolveSecond: ((r: Response) => void) | undefined;
    mockPipelineApi({
      plan: () => {
        calls += 1;
        if (calls === 1) return okPlan();
        return new Promise<Response>((res) => {
          resolveSecond = res;
        });
      },
    });
    renderWithRun(<Tweak />);
    expect(await screen.findByText("12")).toBeTruthy();
    expect(screen.getByText("status:ok")).toBeTruthy();
    const execute = () => screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement;
    expect(execute().disabled).toBe(false);
    await user.click(screen.getByText("tweak"));
    // Immediately — before the debounce fires — the stale plan is gone and Run is blocked.
    expect(screen.getByText("Estimating…")).toBeTruthy();
    expect(screen.getByText("status:loading")).toBeTruthy();
    expect(execute().disabled).toBe(true);
    expect(calls).toBe(1);
    await waitFor(() => expect(resolveSecond).toEqual(expect.any(Function)));
    expect(execute().disabled).toBe(true);
    resolveSecond?.(okPlan({ policyHash: "h2", estimate: { ...okEstimate, creatives: 7 } }));
    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.getByText("status:ok")).toBeTruthy();
    expect(execute().disabled).toBe(false);
  });

  test("replaces a cached ok estimate when a later plan is infeasible", async () => {
    function Tweak() {
      const { setBrief, brief } = useRun();
      return createElement(Fragment, null,
        createElement("button", {
          onClick: () => setBrief({ ...brief, campaignMessage: "Stay wilder" }),
        }, "tweak"),
        createElement(CommandBar, { onToggleTelemetry: () => {} }),
      );
    }
    const user = userEvent.setup();
    seedVariation();
    let calls = 0;
    mockPipelineApi({
      plan: () => {
        calls += 1;
        if (calls === 1) return okPlan();
        return json({ error: "shortfall: accepted 4 of 100" }, 422);
      },
    });
    renderWithRun(<Tweak />);
    expect(await screen.findByText("12")).toBeTruthy();
    await user.click(screen.getByText("tweak"));
    expect(await screen.findByText("shortfall: accepted 4 of 100")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Execute/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("aborts an in-flight plan on unmount", async () => {
    seedVariation();
    let resolvePlan: ((r: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    mockPipelineApi({
      plan: (_url, init) => {
        signal = init.signal;
        return new Promise<Response>((res) => {
          resolvePlan = res;
        });
      },
    });
    const { unmount } = renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(screen.getByText("Estimating…")).toBeTruthy();
    await waitFor(() => expect(resolvePlan).toEqual(expect.any(Function)));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    resolvePlan?.(okPlan());
    await waitFor(() => expect(screen.queryByText("Estimating…")).toBeNull());
  });
});

/**
 * The control-boundary token (WCAG 1.4.11): these controls are identified only by
 * their hairline, so it must be `border-border-control` (≥ 3:1 on every ground).
 * jsdom applies no CSS, so the class list is the only observable — split, because
 * `border-border` is a substring of `border-border-control`.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("CommandBar — control boundaries carry border-control", () => {
  test("the telemetry toggle and the confirm dialog's Cancel keep the ≥3:1 hairline", async () => {
    const user = userEvent.setup();
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);

    const telemetry = screen.getByRole("button", { name: "Toggle telemetry logs" });
    expect(classes(telemetry)).toContain("border-border-control");
    expect(classes(telemetry)).not.toContain("border-border");

    // The dialog's Cancel pill: no fill, the hairline is the entire control.
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(classes(cancel)).toContain("border-border-control");
    expect(classes(cancel)).not.toContain("border-border");
  });
});
