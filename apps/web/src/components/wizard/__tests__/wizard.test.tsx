import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { json, mockPipelineApi, nextMock, renderWithRun } from "@/__tests__/helpers";
import NewCampaignPage from "@/app/(shell)/new/page";
import { Wizard } from "../Wizard";
import { PLAN_DEBOUNCE_MS } from "../wizard-state";

beforeEach(() => {
  localStorage.setItem("cf:brief-picked", "1");
  nextMock().router.push.mockClear();
  nextMock().router.back.mockClear();
});

const estimate = { creatives: 12, axisProductSize: 36, feasible: true, genaiCalls: 0 };

const routeWizardApi = (opts: {
  plan?: (url: string, init: RequestInit) => Response | Promise<Response>;
  brief?: (url: string, init: RequestInit) => Response;
  asset?: (url: string, init: RequestInit) => Response | Promise<Response>;
} = {}) =>
  mockPipelineApi({
    post: (url, init) => {
      if (url.includes("/campaigns/plan")) {
        return opts.plan
          ? opts.plan(url, init)
          : json({ policyHash: "h", seed: 1, estimate, variants: [] });
      }
      if (url.includes("/campaigns/assets")) {
        if (opts.asset) return opts.asset(url, init);
        const body = JSON.parse(String(init.body)) as { briefId: string; name: string };
        return json({ path: `assets/inputs/${body.briefId}/${body.name}` }, 201);
      }
      if (url.includes("/campaigns/briefs")) {
        return opts.brief
          ? opts.brief(url, init)
          : json({ file: "camp-one.yaml", brief: JSON.parse(String(init.body)) }, 201);
      }
      return json({ jobId: "job-1" }, 202);
    },
  });

async function fillType(user: UserEvent, mode: "Classic" | "Randomized", id = "camp-one") {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${mode}`) }));
  await user.type(screen.getByLabelText("Brief ID"), id);
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function fillProducts(user: UserEvent) {
  const names = screen.getAllByLabelText("Name");
  await user.type(names[0], "Alpha");
  await user.type(names[1], "Beta");
  const logos = screen.getAllByLabelText("Logo Path");
  await user.type(logos[0], "a.png");
  await user.type(logos[1], "b.png");
  await user.type(screen.getAllByLabelText("Input asset (optional)")[0], "bg.png");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function fillCopy(user: UserEvent) {
  await user.type(screen.getByLabelText("Target Region"), "DE");
  await user.type(screen.getByLabelText("Target Audience"), "fans");
  await user.type(screen.getByLabelText("Campaign Message"), "Hello world");
  await user.type(screen.getByLabelText("Localized Message (optional)"), "Hallo");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

describe("NewCampaignPage", () => {
  test("renders the wizard", () => {
    renderWithRun(<NewCampaignPage />);
    expect(screen.getByText("New campaign")).toBeTruthy();
  });
});

describe("Wizard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("marks the current step and moves focus to the heading after Next/Back", async () => {
    const user = userEvent.setup();
    renderWithRun(<Wizard />);
    expect(screen.getByText("1. Campaign type").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Campaign type" }));
    await fillType(user, "Classic");
    const productsHeading = screen.getByRole("heading", { name: "Brand & products" });
    expect(document.activeElement).toBe(productsHeading);
    expect(screen.getByText("2. Brand & products").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Campaign type" }));
    expect(screen.getByText("1. Campaign type").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  test("blocks next on an invalid type step, then authors a classic brief", async () => {
    const user = userEvent.setup();
    routeWizardApi();
    renderWithRun(<Wizard />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Lowercase letters, digits and hyphens/)).toBeTruthy();
    await fillType(user, "Classic");
    expect(screen.getByText("Brand & products")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Campaign type")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await fillProducts(user);
    expect(screen.getByText("Copy")).toBeTruthy();
    await fillCopy(user);
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.queryByText("Variation policy")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText(/mode: brief/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief"));
    expect(JSON.parse(localStorage.getItem("cf:brief") ?? "{}").id).toBe("camp-one");
  });

  test("validates products, copy, output, and policy", async () => {
    const user = userEvent.setup();
    routeWizardApi();
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/randomized campaign requires at least 1/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.click(screen.getAllByText("Remove")[2]);
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "Solo");
    await user.type(names[1], "Solo");
    await user.clear(screen.getAllByLabelText("ID")[1]);
    await user.type(screen.getAllByLabelText("ID")[1], "solo");
    await user.clear(screen.getAllByLabelText("Primary Colour")[0]);
    await user.type(screen.getAllByLabelText("Primary Colour")[0], "blue");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/hex value/)).toBeTruthy();
    expect(screen.getByText(/Duplicate product id/)).toBeTruthy();
    await user.clear(screen.getAllByLabelText("Primary Colour")[0]);
    await user.type(screen.getAllByLabelText("Primary Colour")[0], "#1473E6");
    await user.clear(screen.getAllByLabelText("ID")[1]);
    await user.type(screen.getAllByLabelText("ID")[1], "other");
    await user.type(screen.getAllByLabelText("Logo Path")[0], "a.png");
    await user.type(screen.getAllByLabelText("Logo Path")[1], "b.png");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Target region is required/)).toBeTruthy();
    await fillCopy(user);
    expect(screen.getByText("Variation policy")).toBeTruthy();
    await user.clear(screen.getByLabelText("Count"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/variation.count must be an integer/)).toBeTruthy();
    await user.type(screen.getByLabelText("Count"), "12");
    await user.type(screen.getByLabelText("Seed (optional)"), "1.5");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/variation.seed must be an integer in \[0, 2\^32\)/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Seed (optional)"));
    await user.clear(screen.getByLabelText("Min distance"));
    await user.type(screen.getByLabelText("Min distance"), "7");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/variation.minDistance must be an integer in \[0, 6\]/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Min distance"));
    await user.type(screen.getByLabelText("Min distance"), "2");
    await user.click(screen.getByRole("button", { name: "headline-top" }));
    await user.click(screen.getByRole("button", { name: "headline-bottom" }));
    await user.click(screen.getByRole("button", { name: "bold" }));
    await user.click(screen.getByRole("button", { name: "subtle" }));
    await user.click(screen.getByRole("button", { name: "procedural" }));
    await user.click(screen.getByRole("button", { name: "0" }));
    await user.click(screen.getByRole("button", { name: "0.1" }));
    await user.click(screen.getByRole("button", { name: "0.2" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Select at least one layout/)).toBeTruthy();
    expect(screen.getByText(/Select at least one tone/)).toBeTruthy();
    expect(screen.getByText(/Select at least one background source/)).toBeTruthy();
    expect(screen.getByText(/Select at least one palette shift/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "headline-top" }));
    await user.click(screen.getByRole("button", { name: "bold" }));
    await user.click(screen.getByRole("button", { name: "procedural" }));
    await user.click(screen.getByRole("button", { name: "0" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText("instagram-feed"));
    await user.click(screen.getByLabelText("linkedin"));
    await user.click(screen.getByLabelText("x"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Select at least one platform/)).toBeTruthy();
    await user.click(screen.getByLabelText("linkedin"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Review")).toBeTruthy();
  });

  test("shows a live estimate, a 422 message, and estimate unavailable on 404", async () => {
    const user = userEvent.setup();
    let planMode: "ok" | "fail" | "missing" | "no" = "ok";
    routeWizardApi({
      plan: () => {
        if (planMode === "fail") return json({ error: "shortfall: accepted 4 of 100" }, 422);
        if (planMode === "missing") return json({ error: "no" }, 404);
        if (planMode === "no") {
          return json({
            policyHash: "h",
            seed: 1,
            estimate: { ...estimate, feasible: false },
            variants: [],
          });
        }
        return json({ policyHash: "h", seed: 1, estimate, variants: [] });
      },
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "Alpha");
    await user.type(names[1], "Beta");
    const logos = screen.getAllByLabelText("Logo Path");
    await user.type(logos[0], "a.png");
    await user.type(logos[1], "b.png");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await fillCopy(user);
    expect(await screen.findByText("Estimating…")).toBeTruthy();
    await waitFor(
      () => expect(screen.getByText("axisProductSize")).toBeTruthy(),
      { timeout: PLAN_DEBOUNCE_MS + 1000 },
    );
    expect(screen.getByText("yes")).toBeTruthy();

    planMode = "no";
    await user.click(screen.getByRole("button", { name: "0.1" }));
    await waitFor(() => expect(screen.getByText("no")).toBeTruthy(), { timeout: PLAN_DEBOUNCE_MS + 1000 });

    planMode = "fail";
    await user.click(screen.getByRole("button", { name: "bold" }));
    await waitFor(
      () => expect(screen.getByText(/shortfall: accepted 4 of 100/)).toBeTruthy(),
      { timeout: PLAN_DEBOUNCE_MS + 1000 },
    );

    planMode = "missing";
    await user.click(screen.getByRole("button", { name: "subtle" }));
    await waitFor(
      () => expect(screen.getByText("estimate unavailable")).toBeTruthy(),
      { timeout: PLAN_DEBOUNCE_MS + 1000 },
    );

    await user.clear(screen.getByLabelText("Count"));
    expect(await screen.findByText("Fill required fields to estimate.")).toBeTruthy();
  });

  test("aborts the in-flight plan request when leaving the step", async () => {
    const user = userEvent.setup();
    let captured: AbortSignal | undefined;
    let resolvePlan: ((value: Response) => void) | undefined;
    routeWizardApi({
      plan: (_url, init) =>
        new Promise((resolve, reject) => {
          captured = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          resolvePlan = resolve;
        }),
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "Alpha");
    await user.type(names[1], "Beta");
    await user.type(screen.getAllByLabelText("Logo Path")[0], "a.png");
    await user.type(screen.getAllByLabelText("Logo Path")[1], "b.png");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByLabelText("Target Region"), "DE");
    await user.type(screen.getByLabelText("Target Audience"), "fans");
    await user.type(screen.getByLabelText("Campaign Message"), "Hello world");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText("Estimating…")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(PLAN_DEBOUNCE_MS);
      expect(captured?.aborted).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(captured?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    resolvePlan?.(json({ policyHash: "h", seed: 1, estimate, variants: [] }));
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  test("uploads a logo, ignores an empty file list, and surfaces an upload error", async () => {
    const user = userEvent.setup();
    routeWizardApi({ asset: () => json({ error: "too big" }, 413) });
    renderWithRun(<Wizard />);
    await fillType(user, "Classic");
    const fileInput = screen.getAllByLabelText("Logo file")[0] as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [] } });
    await user.upload(fileInput, new File([new Uint8Array([1, 2, 3])], "Hydra Logo.PNG", { type: "image/png" }));
    expect(await screen.findByText("too big")).toBeTruthy();

    routeWizardApi();
    const okInput = screen.getAllByLabelText("Logo file")[0] as HTMLInputElement;
    await user.upload(okInput, new File([new Uint8Array([1, 2, 3])], "Hydra Logo.PNG", { type: "image/png" }));
    await waitFor(() =>
      expect((screen.getAllByLabelText("Logo Path")[0] as HTMLInputElement).value).toBe(
        "assets/inputs/camp-one/product-hydra-logo.png",
      ),
    );
  });

  test("namespaces uploads by product id, treats a 409 as the existing path, and applies by key", async () => {
    const user = userEvent.setup();
    const namesPosted: string[] = [];
    let resolveSecond: ((value: Response) => void) | undefined;
    let secondStarted = false;
    routeWizardApi({
      asset: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { name: string };
        namesPosted.push(body.name);
        if (body.name.startsWith("beta-")) {
          secondStarted = true;
          return new Promise((resolve) => {
            resolveSecond = resolve;
          });
        }
        return json({ error: `Asset "assets/inputs/camp-one/${body.name}" already exists.` }, 409);
      },
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Classic");
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "Alpha");
    await user.type(names[1], "Beta");
    const fileInputs = screen.getAllByLabelText("Logo file") as HTMLInputElement[];
    await user.upload(fileInputs[0], new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
    await waitFor(() =>
      expect((screen.getAllByLabelText("Logo Path")[0] as HTMLInputElement).value).toBe(
        "assets/inputs/camp-one/alpha-logo.png",
      ),
    );

    await user.upload(fileInputs[1], new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
    await waitFor(() => expect(secondStarted).toBe(true));
    expect((screen.getAllByText("Remove")[1] as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getAllByText("Remove")[0]);
    resolveSecond?.(json({ path: "assets/inputs/camp-one/beta-logo.png" }, 201));
    await waitFor(() =>
      expect((screen.getAllByLabelText("Logo Path")[0] as HTMLInputElement).value).toBe(
        "assets/inputs/camp-one/beta-logo.png",
      ),
    );
    expect(namesPosted).toEqual(["alpha-logo.png", "beta-logo.png"]);
  });

  test("toggles remaining axes and saves a randomized brief, offering Replace on 409", async () => {
    const user = userEvent.setup();
    let replaced = false;
    const posted: unknown[] = [];
    routeWizardApi({
      brief: (url, init) => {
        posted.push(JSON.parse(String(init.body)));
        if (url.includes("replace=1")) {
          replaced = true;
          return json({ file: "camp-one.yaml", brief: JSON.parse(String(init.body)) }, 201);
        }
        return json({ error: 'Brief "camp-one" already exists.' }, 409);
      },
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    await fillCopy(user);
    await user.click(screen.getByRole("button", { name: "headline-top" }));
    await user.click(screen.getByRole("button", { name: "procedural" }));
    await user.click(screen.getByRole("button", { name: "asset-pool" }));
    await user.click(screen.getByRole("button", { name: "0" }));
    await user.type(screen.getByLabelText("Seed (optional)"), "7");
    await user.clear(screen.getByLabelText("Min distance"));
    await user.type(screen.getByLabelText("Min distance"), "1");
    await user.clear(screen.getByLabelText("Coverage per product"));
    await user.type(screen.getByLabelText("Coverage per product"), "1");
    await user.clear(screen.getByLabelText("Coverage per ratio"));
    await user.type(screen.getByLabelText("Coverage per ratio"), "1");
    await waitFor(() => expect(screen.getByText("axisProductSize")).toBeTruthy(), {
      timeout: PLAN_DEBOUNCE_MS + 1000,
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief"));
    expect(replaced).toBe(true);
    expect((posted[0] as { mode: string }).mode).toBe("variation");
  });

  test("surfaces a non-conflict save error", async () => {
    const user = userEvent.setup();
    routeWizardApi({
      brief: () => json({ error: "disk full" }, 500),
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Classic");
    await fillProducts(user);
    await fillCopy(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("disk full")).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalledWith("/brief");
  });
});
