import { describe, test, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { renderWithRun, seedPersistedRun, makeAsset } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import RunsPage from "../page";

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("RunsPage — estimate summary", () => {
  test("shows the estimate summary when one is on the run context", async () => {
    function Harness() {
      const { setEstimate } = useRun();
      return createElement(
        Fragment,
        null,
        createElement(
          "button",
          {
            onClick: () =>
              setEstimate({
                status: "ok",
                estimate: { creatives: 12, axisProductSize: 36, feasible: true, genaiCalls: 2 },
                error: null,
              }),
          },
          "seed-ok",
        ),
        createElement(
          "button",
          {
            onClick: () =>
              setEstimate({
                status: "ok",
                estimate: { creatives: 1, axisProductSize: 2, feasible: false, genaiCalls: 0 },
                error: null,
              }),
          },
          "seed-no",
        ),
        createElement(
          "button",
          {
            onClick: () =>
              setEstimate({ status: "infeasible", estimate: null, error: "shortfall: accepted 4 of 100" }),
          },
          "seed-bad",
        ),
        createElement(RunsPage, null),
      );
    }
    seedPersistedRun([makeAsset()]);
    const user = userEvent.setup();
    renderWithRun(<Harness />);
    expect(await screen.findByText("complete")).toBeTruthy();
    await user.click(screen.getByText("seed-ok"));
    expect(await screen.findByText("Creatives")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("36")).toBeTruthy();
    expect(screen.getByText("yes")).toBeTruthy();
    await user.click(screen.getByText("seed-no"));
    expect(await screen.findByText("no")).toBeTruthy();
    await user.click(screen.getByText("seed-bad"));
    expect(await screen.findByText("shortfall: accepted 4 of 100")).toBeTruthy();
  });
});
