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

type PoolEntry = { id: string; text: string; status: "approved" | "rejected"; reason?: string };

const poolOf = (entries: PoolEntry[]) => ({
  briefId: "camp-one",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "m",
  entries,
});

/**
 * In-memory copy pool behind the pools routes: GET (404 until generated), POST
 * generate (requires the draft brief inline — the wizard has not saved it yet —
 * then adds `next` entries, or a fixed reply), PATCH approve/reject/edit (an
 * edit containing "miracle" is rejected by the fake legal gate).
 */
const fakePoolApi = (opts: { initial?: PoolEntry[] | null; generate?: () => Response; patch?: () => Response } = {}) => {
  let entries: PoolEntry[] | null = opts.initial ?? null;
  const calls: Array<{ method: string; body: unknown }> = [];
  const handle = (url: string, init: RequestInit): Response | undefined => {
    if (!url.includes("/campaigns/pools")) return undefined;
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    calls.push({ method, body });
    if (method === "GET") return entries === null ? json({ error: "not found" }, 404) : json({ pool: poolOf(entries) });
    if (method === "POST") {
      const inline = (body as { brief?: { id?: unknown; mode?: unknown } }).brief;
      if (typeof inline?.id !== "string" || inline.mode !== "variation") {
        return json({ error: "Campaign brief must be an object." }, 400);
      }
      if (opts.generate) return opts.generate();
      const n = entries?.length ?? 0;
      entries = [...(entries ?? []), { id: `h${n + 1}`, text: `Suggested ${n + 1}`, status: "approved" }];
      return json({ pool: poolOf(entries), added: 1 }, 201);
    }
    if (opts.patch) return opts.patch();
    const patches = (body as { entries: Array<{ id: string; status: "approved" | "rejected"; text?: string }> }).entries;
    entries = (entries ?? []).map((entry) => {
      const patch = patches.find((p) => p.id === entry.id);
      if (!patch) return entry;
      const text = patch.text ?? entry.text;
      if (text.includes("miracle")) return { id: entry.id, text, status: "rejected", reason: "Prohibited terminology: miracle" };
      return { id: entry.id, text, status: patch.status };
    });
    return json({ pool: poolOf(entries) });
  };
  return { handle, calls, entries: () => entries };
};

const routeWizardApi = (opts: {
  plan?: (url: string, init: RequestInit) => Response | Promise<Response>;
  brief?: (url: string, init: RequestInit) => Response;
  asset?: (url: string, init: RequestInit) => Response | Promise<Response>;
  pool?: ReturnType<typeof fakePoolApi>;
} = {}) => {
  const base = mockPipelineApi({
    result: (url) => opts.pool?.handle(url, {}) ?? json({ error: "not found" }, 404),
    post: (url, init) => {
      const pooled = opts.pool?.handle(url, init);
      if (pooled) return pooled;
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
  // mockPipelineApi only hands `init` to POST handlers; route PATCH (pool edits) here.
  const inner = base.getMockImplementation();
  base.mockImplementation((url, init) => {
    const req = (init ?? {}) as RequestInit;
    const patched = req.method === "PATCH" ? opts.pool?.handle(String(url), req) : undefined;
    return patched ? Promise.resolve(patched) : inner!(url, init);
  });
  return base;
};

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
    await user.type(screen.getByLabelText("Min distance"), "8");
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

  test("headline pool: loads, generates, approves, rejects, edits, and unlocks the headline axis", async () => {
    const user = userEvent.setup();
    const pool = fakePoolApi();
    const planned: unknown[] = [];
    routeWizardApi({
      pool,
      plan: (_url, init) => {
        const brief = JSON.parse(String(init.body)) as { variation: { axes: Record<string, unknown> } };
        planned.push(brief.variation.axes.headline);
        const pooled = brief.variation.axes.headline === "pool://copy";
        return json({ policyHash: "h", seed: 1, estimate: { ...estimate, axisProductSize: pooled ? 72 : 36 }, variants: [] });
      },
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    expect(await screen.findByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.getByText("No headlines yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Generate 10 suggestions" }));
    expect(await screen.findByText("Suggested 1")).toBeTruthy();
    expect(screen.getByText("Headline pool (1 approved)")).toBeTruthy();
    // The draft brief travels inline (id, products, message) so Generate works before Save.
    expect(pool.calls.filter((c) => c.method === "POST")[0].body).toEqual({
      brief: expect.objectContaining({
        id: "camp-one",
        mode: "variation",
        products: [expect.objectContaining({ id: "alpha" }), expect.objectContaining({ id: "beta" })],
      }),
      count: 10,
    });

    await user.click(screen.getByRole("button", { name: "Reject h1" }));
    expect(await screen.findByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve h1" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve h1" }));
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    await user.click(screen.getByRole("button", { name: "Cancel h1" }));
    expect(screen.queryByRole("textbox", { name: "Edit h1" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    const editor = screen.getByLabelText("Edit h1");
    await user.clear(editor);
    expect((screen.getByRole("button", { name: "Save h1" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(editor, "A miracle cure");
    await user.click(screen.getByRole("button", { name: "Save h1" }));
    expect(await screen.findByText("Prohibited terminology: miracle")).toBeTruthy();
    expect(screen.getByText("A miracle cure")).toBeTruthy();
    expect(screen.getByText("Headline pool (0 approved)")).toBeTruthy();
    expect(pool.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
      entries: [{ id: "h1", status: "approved", text: "A miracle cure" }],
    });
    // A clean edit keeps the HITL rejection (legal passes, status untouched); approving then unlocks it.
    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    await user.clear(screen.getByRole("textbox", { name: "Edit h1" }));
    await user.type(screen.getByRole("textbox", { name: "Edit h1" }), "Fresh alpine water");
    await user.click(screen.getByRole("button", { name: "Save h1" }));
    expect(await screen.findByText("Fresh alpine water")).toBeTruthy();
    expect(screen.queryByText("Prohibited terminology: miracle")).toBeNull();
    expect(screen.getByText("Headline pool (0 approved)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve h1" }));
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();

    await fillCopy(user);
    expect(screen.getByText("Variation policy")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("36")).toBeTruthy(), { timeout: PLAN_DEBOUNCE_MS + 1000 });
    expect(screen.getByText("1 approved headline")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "pool://copy" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getByText("72")).toBeTruthy(), { timeout: PLAN_DEBOUNCE_MS + 1000 });
    expect(planned.at(-1)).toBe("pool://copy");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/headline: "pool:\/\/copy"/)).toBeTruthy();
  });

  test("headline pool: the axis is blocked without an approved entry and generation is disabled on 503", async () => {
    const user = userEvent.setup();
    const pool = fakePoolApi({
      initial: [{ id: "h1", text: "A miracle", status: "rejected", reason: "Prohibited terminology: miracle" }],
      generate: () => json({ error: "OPENROUTER_API_KEY is not set" }, 503),
    });
    routeWizardApi({ pool });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    expect(await screen.findByText("A miracle")).toBeTruthy();
    expect(screen.getByText("Prohibited terminology: miracle")).toBeTruthy();
    const generate = screen.getByRole("button", { name: "Generate 10 suggestions" }) as HTMLButtonElement;
    await user.click(generate);
    expect(await screen.findByText("OPENROUTER_API_KEY is not set")).toBeTruthy();
    expect(generate.disabled).toBe(true);

    await fillCopy(user);
    const toggle = screen.getByRole("button", { name: "pool://copy" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/no approved entries/)).toBeTruthy();
  });

  test("headline pool: an edit that rejects the last approved entry says the axis was turned off", async () => {
    const user = userEvent.setup();
    const pool = fakePoolApi({ initial: [{ id: "h1", text: "Stay wild", status: "approved" }] });
    routeWizardApi({ pool });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();
    // Rejecting while the axis is off is silent.
    await user.click(screen.getByRole("button", { name: "Reject h1" }));
    expect(await screen.findByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Approve h1" }));
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();

    await fillCopy(user);
    await user.click(screen.getByRole("button", { name: "pool://copy" }));
    expect(screen.getByRole("button", { name: "pool://copy" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Back" }));

    // The edit flips the last approved entry to rejected: the reducer drops the axis; the panel says so.
    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    await user.clear(screen.getByRole("textbox", { name: "Edit h1" }));
    await user.type(screen.getByRole("textbox", { name: "Edit h1" }), "A miracle cure");
    await user.click(screen.getByRole("button", { name: "Save h1" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "No approved headlines — the headline axis was turned off",
    );
    // A further change that still leaves no approvals keeps the notice.
    await user.click(screen.getByRole("button", { name: "Approve h1" }));
    expect(await screen.findByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();

    // The policy step keeps its own message and the toggle is off and blocked.
    await user.click(screen.getByRole("button", { name: "Next" }));
    const toggle = screen.getByRole("button", { name: "pool://copy" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/no approved entries/)).toBeTruthy();

    // The notice survives the step change; approving again clears it.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    await user.clear(screen.getByRole("textbox", { name: "Edit h1" }));
    await user.type(screen.getByRole("textbox", { name: "Edit h1" }), "Fresh alpine water");
    await user.click(screen.getByRole("button", { name: "Save h1" }));
    expect(await screen.findByText("Fresh alpine water")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve h1" }));
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("headline pool: surfaces patch and load failures, pluralises the axis label", async () => {
    const user = userEvent.setup();
    const pool = fakePoolApi({
      initial: [
        { id: "h1", text: "Stay wild", status: "approved" },
        { id: "h2", text: "Go far", status: "approved" },
      ],
      patch: () => json({ error: "disk full" }, 500),
    });
    routeWizardApi({ pool });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    expect(await screen.findByText("Stay wild")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reject h1" }));
    expect(await screen.findByText("disk full")).toBeTruthy();
    expect(screen.getByText("Headline pool (2 approved)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit h1" }));
    await user.type(screen.getByRole("textbox", { name: "Edit h1" }), "!");
    await user.click(screen.getByRole("button", { name: "Save h1" }));
    expect(await screen.findAllByText("disk full")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Edit h1" })).toBeTruthy();

    await fillCopy(user);
    expect(screen.getByText("2 approved headlines")).toBeTruthy();

    mockPipelineApi({ result: () => json({ error: "boom" }, 500) });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("boom")).toBeTruthy();
  });

  test("headline pool: ignores a load that settles after leaving the Copy step", async () => {
    const user = userEvent.setup();
    const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/pools")
          ? new Promise<Response>((resolve, reject) => {
              pending.push({ resolve, reject });
            })
          : json({ halted: false, assets: [], log: null }),
    });
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    expect(screen.getByText("No headlines yet.")).toBeTruthy();
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Back" }));
    pending[0].resolve(json({ pool: poolOf([{ id: "h1", text: "Late", status: "approved" }]) }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.queryByText("Late")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    pending[1].reject(new Error("late failure"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(screen.queryByText("late failure")).toBeNull();
    pending[2].resolve(json({ error: "not found" }, 404));
    expect(await screen.findByText("No headlines yet.")).toBeTruthy();
  });

  test("headline pool: a new brief id clears the pool and drops responses requested for the old one", async () => {
    const user = userEvent.setup();
    const gets: Array<(r: Response) => void> = [];
    const patches: Array<(r: Response) => void> = [];
    const base = mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/pools")
          ? new Promise<Response>((resolve) => {
              gets.push(resolve);
            })
          : json({ halted: false, assets: [], log: null }),
    });
    const inner = base.getMockImplementation();
    base.mockImplementation((url, init) =>
      (init as RequestInit | undefined)?.method === "PATCH"
        ? new Promise<Response>((resolve) => {
            patches.push(resolve);
          })
        : inner!(url, init),
    );
    renderWithRun(<Wizard />);
    await fillType(user, "Randomized");
    await fillProducts(user);
    await waitFor(() => expect(gets).toHaveLength(1));
    // Nothing can be generated or patched until the brief's pool has loaded.
    expect((screen.getByRole("button", { name: "Generate 10 suggestions" }) as HTMLButtonElement).disabled).toBe(true);
    gets[0](json({ pool: poolOf([{ id: "h1", text: "Stay wild", status: "approved" }]) }));
    expect(await screen.findByText("Headline pool (1 approved)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate 10 suggestions" }) as HTMLButtonElement).disabled).toBe(false);

    // A PATCH for camp-one is still in flight when the id changes.
    await user.click(screen.getByRole("button", { name: "Reject h1" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.clear(screen.getByLabelText("Brief ID"));
    await user.type(screen.getByLabelText("Brief ID"), "camp-two");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    // camp-one's entries are gone before camp-two's GET settles, and nothing is actionable meanwhile.
    expect(screen.getByText("Headline pool (0 approved)")).toBeTruthy();
    expect(screen.getByText("No headlines yet.")).toBeTruthy();
    expect(screen.queryByText("Stay wild")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate 10 suggestions" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(gets).toHaveLength(2));

    // The late PATCH (camp-one) and the slow GET (camp-one) both land after the switch and are ignored.
    patches[0](json({ pool: poolOf([{ id: "h1", text: "Stay wild", status: "rejected" }]) }));
    gets[0](json({ pool: poolOf([{ id: "h1", text: "Stay wild", status: "approved" }]) }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(gets).toHaveLength(3));
    expect(screen.queryByText("Stay wild")).toBeNull();
    expect(screen.getByText("Headline pool (0 approved)")).toBeTruthy();

    // camp-two's own pool arrives and is shown.
    gets[2](json({ pool: { ...poolOf([{ id: "h9", text: "Two", status: "approved" }]), briefId: "camp-two" } }));
    expect(await screen.findByText("Two")).toBeTruthy();
    expect(screen.getByText("Headline pool (1 approved)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate 10 suggestions" }) as HTMLButtonElement).disabled).toBe(false);
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
