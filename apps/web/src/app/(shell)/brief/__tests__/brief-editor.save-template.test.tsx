import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun as renderWithShell, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * CFRW22C — the rail's "Save as template" action, through the editor that ships.
 *
 * The rail's gate is the editor's own state, not the dialog's: the button is
 * disabled (with the reason named beside it) only while the look has no layers
 * or the draft carries unsaved validation errors, and a save posts the look
 * verbatim — `{ name, unit, creativeType, layers }` — with no identity field,
 * because the server derives who is saving from the session.
 */

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, WorldMap: () => <div data-testid="world-map-stub" /> };
});

const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

const brief = {
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "clip",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
};

type Call = { url: string; method: string; body?: Record<string, unknown> };

const routes = (): Call[] => {
  const calls: Call[] = [];
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
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(json({ briefs: [{ file: "clip.yaml", revision: "r1", brief }] }));
    }
    if (method === "POST" && u === `${API}/campaigns/templates`) {
      return Promise.resolve(
        json({ template: { ...brief.template, id: "house-look", name: "My look" } }, 201),
      );
    }
    if (u.includes("/campaigns/preview-frame")) {
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
        }),
      );
    }
    return Promise.resolve(json({}, 200));
  });
  return calls;
};

const saveCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url === `${API}/campaigns/templates`);

const mountEditor = async () => {
  const calls = routes();
  renderWithRun(<BriefEditor briefId="clip" />);
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
  );
  return calls;
};

describe("the rail's Save as template action (CFRW22C)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  test("a valid loaded brief offers the action, and saving posts the look and closes", async () => {
    const calls = await mountEditor();
    const button = screen.getByRole("button", { name: "Save as template" }) as HTMLButtonElement;
    // The gate reads `isDirtySinceSave`, which is briefly true while the load
    // effect is still settling the saved snapshot — wait for it to settle.
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(document.getElementById("save-template-reason")).toBeNull();
    const user = userEvent.setup();
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Save as template" });
    await user.type(within(dialog).getByLabelText("Template name"), "My look");
    await user.click(within(dialog).getByRole("button", { name: "Save template" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Save as template" })).toBeNull(),
    );
    expect(saveCalls(calls)).toHaveLength(1);
    // The look, verbatim — and no identity field: the server derives who is
    // saving from the session, so the body never carries one.
    expect(saveCalls(calls)[0].body).toEqual({
      name: "My look",
      unit: brief.template.unit,
      creativeType: brief.template.creativeType,
      layers: brief.template.layers,
    });
    expect(Object.keys(saveCalls(calls)[0].body ?? {})).not.toContain("briefId");
    expect(Object.keys(saveCalls(calls)[0].body ?? {})).not.toContain("orgId");
  });

  test("an unsaved validation error disables the action and names the reason", async () => {
    await mountEditor();
    const button = screen.getByRole("button", { name: "Save as template" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    const user = userEvent.setup();
    await user.clear(screen.getByRole("textbox", { name: messages.headlineLabel }));
    await waitFor(() => expect(button).toHaveProperty("disabled", true));
    expect(
      screen.getByText("Fix unsaved validation errors before saving as a template."),
    ).toBeTruthy();
  });
});
