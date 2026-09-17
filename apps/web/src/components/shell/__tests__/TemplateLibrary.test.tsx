import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import { RunProvider, useRun } from "@/lib/run-context";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { EditorDirtyProvider } from "@/lib/editor-dirty-context";
import { blankBrief } from "@/components/campaign/editor-state";
import { TemplateLibrary } from "../TemplateLibrary";
import { BrowseBriefsButton } from "../Sidebar";
import { EMPTY_REPORT, json, mockPipelineApi } from "@/__tests__/helpers";

const imageText = (version: number): CreativeTemplate => ({
  ...CANONICAL_TEMPLATES["image-text"],
  version,
});
/**
 * A record outside `CANONICAL_TEMPLATE_IDS` — served by the routes' own shape
 * (nothing in the port constrains `CreativeTemplate.id`) but not representable
 * as a brief's pinned reference. Also the second card in the `image-text`
 * group, which is what makes a sort observable.
 */
const housePromo: CreativeTemplate = {
  ...CANONICAL_TEMPLATES["image-text"],
  id: "house-promo",
  name: "Alpha promo",
  version: 2,
};

const PNG = new Uint8Array([137, 80, 78, 71]);

const pngResponse = () =>
  new Response(PNG, { status: 200, headers: { "x-preview-frame-cache-key": "cache-key" } });

interface LibraryMock {
  readonly templates?: readonly unknown[];
  /** Non-zero → the list route answers that status instead of a list. */
  readonly templatesStatus?: number;
  readonly briefs?: readonly unknown[];
  readonly briefsFail?: boolean;
  readonly preview?: () => Response;
}

const mockLibrary = (opts: LibraryMock = {}) =>
  mockPipelineApi({
    result: (url) => {
      if (url.includes("/campaigns/templates")) {
        return opts.templatesStatus === undefined
          ? json({ templates: opts.templates ?? [] })
          : json({ error: "Could not read templates: EACCES" }, opts.templatesStatus);
      }
      if (url.includes("/campaigns/briefs")) {
        return opts.briefsFail === true
          ? json({ error: "Could not read briefs" }, 500)
          : json({ briefs: opts.briefs ?? [] });
      }
      return json(EMPTY_REPORT);
    },
    post: (url) =>
      url.includes("/campaigns/preview-frame")
        ? (opts.preview ?? pngResponse)()
        : json({ jobId: "job-1" }, 202),
  });

/**
 * The shell's two providers plus the three affordances a test needs from
 * outside the modal: the entry point, a way to release the campaign (what
 * `/brief/new` does — a brief with no products), and a readout of the pin the
 * modal writes.
 */
function Harness(): ReactNode {
  const { openTemplateLibrary } = useCreateCampaign();
  const { brief, setBrief } = useRun();
  return (
    <>
      <button type="button" onClick={openTemplateLibrary}>
        open the library
      </button>
      <button type="button" onClick={() => setBrief(blankBrief())}>
        release the campaign
      </button>
      <p data-testid="pinned">{`${brief.template.id}@${brief.template.version}`}</p>
      <TemplateLibrary />
    </>
  );
}

const renderLibrary = () =>
  render(
    <RunProvider>
      <CreateCampaignProvider>
        <Harness />
      </CreateCampaignProvider>
    </RunProvider>,
  );

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "open the library" }));
  return screen.findByRole("dialog");
};

const cardNames = () =>
  screen
    .getAllByRole("button")
    .filter((node) => node.hasAttribute("data-template-card"))
    .map((node) => node.getAttribute("data-template-card"));

/** Every `/campaigns/preview-frame` request this test has made so far. */
const previewCalls = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) => String(url).includes("/campaigns/preview-frame"));

describe("the listing (TM2)", () => {
  test("a 500 renders an error and NEVER an empty library", async () => {
    mockLibrary({ templatesStatus: 500 });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    expect(await screen.findByText(/Could not load the template library/)).toBeTruthy();
    expect(screen.queryByText("No templates yet.")).toBeNull();
  });

  test("a genuinely empty library renders 'no templates yet'", async () => {
    mockLibrary({ templates: [] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    expect(await screen.findByText("No templates yet.")).toBeTruthy();
    expect(screen.queryByText(/Could not load the template library/)).toBeNull();
  });

  /**
   * The lane's first red fault, stated as the comparison it actually is:
   * collapsing a failed read into "no templates yet" is this repo's recurring
   * defect, and the list route's own doc comment names it. Neither test above
   * can catch the collapse alone — an implementation that showed the error text
   * for both would pass the first, and one that showed the empty text for both
   * would pass the second. The difference is the assertion.
   */
  test("the two states are DIFFERENT text, driven over the same component", async () => {
    mockLibrary({ templatesStatus: 500 });
    const user = userEvent.setup();
    const failed = renderLibrary();
    await open(user);
    const onFailure = (await screen.findByTestId("template-list")).textContent;
    failed.unmount();

    mockLibrary({ templates: [] });
    renderLibrary();
    await open(user);
    const onEmpty = (await screen.findByTestId("template-list")).textContent;

    expect(onFailure).not.toBe(onEmpty);
    expect(onFailure).toMatch(/Could not load/);
    expect(onEmpty).toMatch(/No templates yet/);
  });

  /**
   * The lane's second red fault. `listTemplates()` answers one record per
   * version, so a grid that renders the answer raw shows this template three
   * times. The chip must read the HIGHEST version, not merely *a* version: a
   * first-wins collapse also yields one card and would pass a count.
   */
  test("three versions of one template are ONE card, chipped at the latest", async () => {
    mockLibrary({ templates: [imageText(2), imageText(3), imageText(1)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Canonical Image & Text/ });
    expect(cardNames()).toEqual(["canonical-image-text"]);
    expect(screen.getByText("v3")).toBeTruthy();
    expect(screen.queryByText("v1")).toBeNull();
    expect(screen.queryByText("v2")).toBeNull();
  });

  test("groups by creative type, and a type with no match has no heading", async () => {
    mockLibrary({ templates: [imageText(1), CANONICAL_TEMPLATES.video] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("heading", { name: "Image & text" });
    expect(screen.getByRole("heading", { name: "Video" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "HTML" })).toBeNull();
  });

  test("the thumbnail is drawn from `layers` — one band per layer, and no fetch", async () => {
    mockLibrary({ templates: [CANONICAL_TEMPLATES.video] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    const thumb = await screen.findByTestId("template-thumb");
    expect(thumb.querySelectorAll("rect")).toHaveLength(CANONICAL_TEMPLATES.video.layers.length);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes("thumbnail")),
    ).toHaveLength(0);
  });

  test("search filters the rendered cards by name", async () => {
    mockLibrary({ templates: [imageText(3), housePromo, CANONICAL_TEMPLATES.video] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Alpha promo/ });
    await user.type(screen.getByLabelText("Search templates by name"), "alpha");
    await waitFor(() => expect(cardNames()).toEqual(["house-promo"]));
  });

  test("a search that matches nothing says so, and is not the empty library", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Canonical Image & Text/ });
    await user.type(screen.getByLabelText("Search templates by name"), "zzz");
    expect(await screen.findByText(/No template matches/)).toBeTruthy();
    expect(screen.queryByText("No templates yet.")).toBeNull();
  });

  test("the sort changes the RENDERED order, not just internal state", async () => {
    mockLibrary({ templates: [imageText(3), housePromo] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Alpha promo/ });
    // By name: "Alpha promo" before "Canonical Image & Text".
    expect(cardNames()).toEqual(["house-promo", "canonical-image-text"]);
    await user.selectOptions(screen.getByLabelText("Sort templates"), "version");
    // By newest version: v3 before v2.
    await waitFor(() => expect(cardNames()).toEqual(["canonical-image-text", "house-promo"]));
  });
});

describe("the detail view (TM3)", () => {
  const openDetail = async (
    user: ReturnType<typeof userEvent.setup>,
    name: RegExp = /Canonical Image & Text/,
  ) => {
    await open(user);
    await user.click(await screen.findByRole("button", { name }));
    return screen.findByRole("button", { name: "Render preview" });
  };

  /**
   * The credit-safety gate (T-D4), counted in NETWORK CALLS rather than
   * renders: "the final creative as generated" is a `/preview-frame`
   * composite, and browsing a library is a casual gesture — an automatic fetch
   * would spend the owner's GenAI credits for a look nobody asked to see. The
   * count is taken after the button has rendered, so every mount effect in the
   * detail view has already committed.
   */
  test("opening the detail view issues ZERO /preview-frame calls", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await openDetail(user);
    expect(previewCalls()).toHaveLength(0);
    // And it stays at zero: nothing debounced is in flight behind it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(previewCalls()).toHaveLength(0);
  });

  test("pressing Render preview issues EXACTLY ONE, and paints the frame", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    const button = await openDetail(user);
    await user.click(button);
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    expect(await screen.findByTestId("template-preview")).toBeTruthy();
    // The request carries the record on screen as the brief's pinned template.
    const body = JSON.parse(String((previewCalls()[0][1] as RequestInit).body)) as {
      brief: { template: { id: string; version: number } };
      cell: { productId: string };
    };
    expect(body.brief.template).toMatchObject({ id: "canonical-image-text", version: 3 });
    expect(body.cell.productId).toBe("hydra-bottle");
    // Still one: the press is the only trigger there is.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(previewCalls()).toHaveLength(1);
  });

  test("a failed render says so and keeps the structural thumbnail", async () => {
    mockLibrary({
      templates: [imageText(3)],
      preview: () => json({ error: "no compositor" }, 500),
    });
    const user = userEvent.setup();
    renderLibrary();
    const button = await openDetail(user);
    await user.click(button);
    expect(await screen.findByText("Could not render a preview.")).toBeTruthy();
    expect(screen.getAllByTestId("template-thumb").length).toBeGreaterThan(0);
  });

  test("a campaign with no product cannot render, and the button says why", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await user.click(screen.getByRole("button", { name: "release the campaign" }));
    const button = await openDetail(user);
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText(/A preview needs an open campaign with a product/)).toBeTruthy();
    expect(previewCalls()).toHaveLength(0);
  });

  test("the layers are listed read-only, in the record's own z-order", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await openDetail(user);
    const rows = [...(await screen.findByTestId("template-layers")).querySelectorAll("li")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "imageImage",
      "shadeShade",
      "accentAccent",
      "static-textStatic text",
      "logoLogo",
    ]);
    // Read-only: no control inside the list.
    expect((await screen.findByTestId("template-layers")).querySelectorAll("button")).toHaveLength(
      0,
    );
  });

  test("the version history reaches an older version without a fetch", async () => {
    mockLibrary({ templates: [imageText(1), imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await openDetail(user);
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    const history = await screen.findByTestId("template-versions");
    const v1 = [...history.querySelectorAll("button")].find((node) => node.textContent === "v1");
    await user.click(v1 as HTMLButtonElement);
    expect(await screen.findByText(/Image & text · standard-web · v1/)).toBeTruthy();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });
});

describe("provenance (T-D5)", () => {
  const usedBy = (id: string, version: number) => ({
    file: `${id}.json`,
    brief: {
      id,
      products: [],
      template: { id: "canonical-image-text", version },
    },
  });

  test("names the campaign that pinned this exact version, labelled as provenance", async () => {
    mockLibrary({ templates: [imageText(3)], briefs: [usedBy("spring-launch", 3)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    expect(await screen.findByText("Last used by", { exact: false })).toBeTruthy();
    expect(screen.getByText("spring-launch")).toBeTruthy();
  });

  /**
   * A template is ownerless (D123), so nothing having pinned it shows NOTHING —
   * not a placeholder, and never the template's own fields dressed up as brief
   * details, which would be the category error T7 names and a fabrication D26
   * forbids. The three non-matches are distinct: a different version of the
   * same id, a different id, and a stored brief carrying no template at all
   * (`listBriefs` validates `products`, not `template`).
   */
  test("nothing has pinned it ⇒ nothing is shown", async () => {
    mockLibrary({
      templates: [imageText(3)],
      briefs: [
        usedBy("older", 1),
        {
          file: "other.json",
          brief: { id: "other", products: [], template: { id: "canonical-video", version: 3 } },
        },
        { file: "legacy.json", brief: { id: "legacy", products: [] } },
      ],
    });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    await screen.findByRole("heading", { name: "Provenance" });
    expect(screen.queryByText("Last used by", { exact: false })).toBeNull();
    expect(screen.queryByText(/Could not read the campaign briefs/)).toBeNull();
  });

  test("a brief listing that failed says so — not that nothing has used it", async () => {
    mockLibrary({ templates: [imageText(3)], briefsFail: true });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    expect(await screen.findByText(/Could not read the campaign briefs/)).toBeTruthy();
  });
});

describe("one DialogShell, ever (T6/F22)", () => {
  test("exactly one [role=dialog] is mounted in the listing AND in the detail view", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Canonical Image & Text/ });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /Canonical Image & Text/ }));
    await screen.findByRole("button", { name: "Render preview" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Back to the listing" }));
    await screen.findByRole("button", { name: /Canonical Image & Text/ });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  test("Escape closes the whole modal from the detail view", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    await screen.findByRole("button", { name: "Render preview" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Back is a view swap, not a dismissal", () => {
  test("restores the search term, the scroll offset AND the focus", async () => {
    mockLibrary({ templates: [imageText(3), housePromo] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await screen.findByRole("button", { name: /Alpha promo/ });

    await user.type(screen.getByLabelText("Search templates by name"), "canonical");
    await waitFor(() => expect(cardNames()).toEqual(["canonical-image-text"]));
    const list = screen.getByTestId("template-list");
    fireEvent.scroll(list, { target: { scrollTop: 120 } });

    await user.click(screen.getByRole("button", { name: /Canonical Image & Text/ }));
    await screen.findByRole("button", { name: "Render preview" });
    expect(screen.queryByTestId("template-list")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back to the listing" }));
    const card = await screen.findByRole("button", { name: /Canonical Image & Text/ });
    expect(screen.getByLabelText("Search templates by name")).toHaveProperty("value", "canonical");
    expect(screen.getByTestId("template-list").scrollTop).toBe(120);
    expect(document.activeElement).toBe(card);
  });
});

describe("Use this template (TM4)", () => {
  /**
   * The lane's fourth red fault: the VERSION, not only the id. The fixture is
   * deliberately v3 — the canonical library ships v1, so a pin that was dropped
   * and fell back to `templateFromCanonical` would still read
   * `canonical-image-text@1` and a test that pinned v1 could not tell.
   */
  test("writes template@version onto the campaign, and closes the modal", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    expect(screen.getByTestId("pinned").textContent).toBe("canonical-image-text@1");
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    await user.click(await screen.findByRole("button", { name: "Use this template" }));
    await waitFor(() =>
      expect(screen.getByTestId("pinned").textContent).toBe("canonical-image-text@3"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * The finding this lane records rather than fixes: `BriefTemplate.id` is
   * `CanonicalTemplateId`, so a record outside the canonical set is not
   * representable as a pin. Refused visibly, with the reason, rather than cast
   * through to fail at the editor's restore boundary.
   */
  test("a record no brief can pin refuses, and says why", async () => {
    mockLibrary({ templates: [housePromo] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Alpha promo/ }));
    const use = await screen.findByRole("button", { name: "Use this template" });
    expect(use).toHaveProperty("disabled", true);
    expect(screen.getByText(/not one a brief can pin/)).toBeTruthy();
    await user.click(use);
    expect(screen.getByTestId("pinned").textContent).toBe("canonical-image-text@1");
  });
});

describe("the entry point (TM4)", () => {
  const renderEntry = (onActivate?: () => void) =>
    render(
      <RunProvider>
        <EditorDirtyProvider>
          <CreateCampaignProvider>
            <BrowseBriefsButton onActivate={onActivate} />
            <TemplateLibrary />
          </CreateCampaignProvider>
        </EditorDirtyProvider>
      </RunProvider>,
    );

  test("the left column's Browse templates button opens the library", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderEntry();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Browse templates" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Canonical Image & Text/ })).toBeTruthy();
    // Exactly one shell, from the real entry point.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  /** The mobile menu dismisses itself before the overlay opens, as it does for the picker. */
  test("the caller's onActivate fires first", async () => {
    mockLibrary({ templates: [] });
    const onActivate = vi.fn();
    const user = userEvent.setup();
    renderEntry(onActivate);
    await user.click(screen.getByRole("button", { name: "Browse templates" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("the modal reloads on each open", () => {
  test("a close and a reopen re-reads the library and lands on the listing", async () => {
    mockLibrary({ templates: [imageText(3)] });
    const user = userEvent.setup();
    renderLibrary();
    await open(user);
    await user.click(await screen.findByRole("button", { name: /Canonical Image & Text/ }));
    await screen.findByRole("button", { name: "Render preview" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await open(user);
    // The detail view did not survive the close: the listing is what reopens.
    expect(await screen.findByRole("button", { name: /Canonical Image & Text/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Render preview" })).toBeNull();
  });
});
