import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { initialEditorState, emptyProduct, type EditorState } from "../editor-state";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection } from "../sections";
import { ErrorStrip } from "../ErrorStrip";
import * as messages from "../messages";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockFetch = (handler: (url: string) => Response) => {
  vi.mocked(globalThis.fetch).mockImplementation((url) => Promise.resolve(handler(String(url))));
};

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  briefId: "camp",
  ...over,
});

describe("IdentitySection", () => {
  test("dispatches a patch for each field", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<IdentitySection state={state({ briefId: "", campaignName: "" })} dispatch={dispatch} errors={{}} />);

    fireEvent.change(screen.getByLabelText("Campaign Name"), { target: { value: "New Name" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { campaignName: "New Name" } });
    await user.type(screen.getByLabelText("Target Region"), "D");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetRegion: "D" } });
    await user.type(screen.getByLabelText("Target Audience"), "a");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetAudience: "a" } });
  });

  test("the brief id is editable on a new draft and read-only once loaded from a file", () => {
    const { unmount } = render(<IdentitySection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByLabelText("Campaign Name").hasAttribute("readonly")).toBe(false);
    unmount();

    render(
      <IdentitySection
        state={state({ source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: undefined } })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByLabelText("Campaign Name").hasAttribute("readonly")).toBe(true);
  });

  test("copy brief ID writes to clipboard and shows temporary feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const { unmount } = render(<IdentitySection state={state({ briefId: "camp-summer" })} dispatch={vi.fn()} errors={{}} />);

    const copyBtn = screen.getByRole("button", { name: "Copy brief ID" });
    expect(copyBtn.textContent).toBe("Copy");

    // Click once
    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("camp-summer");
    // Re-query after click to verify accessible name changes
const copiedBtn = await screen.findByRole("button", { name: "Copied ✓" });
expect(copiedBtn.textContent).toBe("Copied ✓");

    // Click second time while timer active
    fireEvent.click(copyBtn);

    // Unmount while timer active to exercise cleanup
    unmount();
  });

  test("copy brief ID resets feedback after timeout", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<IdentitySection state={state({ briefId: "camp-summer" })} dispatch={vi.fn()} errors={{}} />);
    const copyBtn = screen.getByRole("button", { name: "Copy brief ID" });

    fireEvent.click(copyBtn);
    // Re-query after click to verify accessible name changes
const copiedBtn = await screen.findByRole("button", { name: "Copied ✓" });
expect(copiedBtn.textContent).toBe("Copied ✓");

    await new Promise((r) => setTimeout(r, 1600));
    expect(copyBtn.textContent).toBe("Copy");
  });

  test("copy brief ID does nothing when clipboard is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    render(<IdentitySection state={state({ briefId: "camp-summer" })} dispatch={vi.fn()} errors={{}} />);
    const copyBtn = screen.getByRole("button", { name: "Copy brief ID" });

    fireEvent.click(copyBtn);
    expect(copyBtn.textContent).toBe("Copy");
  });

  test("copy brief ID handles clipboard errors gracefully", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<IdentitySection state={state({ briefId: "camp-summer" })} dispatch={vi.fn()} errors={{}} />);
    const copyBtn = screen.getByRole("button", { name: "Copy brief ID" });

    fireEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("camp-summer");
  });

  test("empty brief id disables copy button and shows placeholder", () => {
    render(<IdentitySection state={state({ briefId: "", campaignName: "" })} dispatch={vi.fn()} errors={{}} />);
    const copyBtn = screen.getByRole("button", { name: "Copy brief ID" }) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
    expect(screen.getByText("This is the brief id — made from the name")).toBeTruthy();
  });

  test("shows a per-field error and a count badge on the heading", () => {
    render(<IdentitySection state={state()} dispatch={vi.fn()} errors={{ briefId: "bad id", targetRegion: "required" }} />);
    expect(screen.getByText("bad id")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Identity/ }).textContent).toContain("2");
  });
});

describe("CopySection", () => {
  test("dispatches both message fields and renders their errors", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<CopySection state={state()} dispatch={dispatch} errors={{ campaignMessage: "required", localizedMessage: "odd" }} />);

    await user.type(screen.getByLabelText("Headline"), "H");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { campaignMessage: "H" } });
    await user.type(screen.getByLabelText("Localized headline (optional)"), "x");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { localizedMessage: "x" } });
    expect(screen.getByText("required")).toBeTruthy();
    expect(screen.getByText("odd")).toBeTruthy();
  });

  test("renders live character counter and warns on exceeding max limit", () => {
    const { unmount } = render(<CopySection state={state({ campaignMessage: "Stay wild" })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText("9 / 60")).toBeTruthy();
    unmount();

    render(<CopySection state={state({ campaignMessage: "a".repeat(65) })} dispatch={vi.fn()} errors={{}} />);
    const counter = screen.getByText("65 / 60");
    expect(counter).toBeTruthy();
    expect(counter.className).toContain("text-error");
  });

  test("renders headline suggestions and clicking one applies it", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const testPool = {
      briefId: "camp",
      generatedAt: "2026-01-01T00:00:00Z",
      model: "test-model",
      entries: [
        { id: "h1", text: "Reach New Heights", status: "approved" as const },
        { id: "h2", text: "Conquer the Summit", status: "approved" as const },
        { id: "h3", text: "Rejected Idea", status: "rejected" as const },
      ],
    };
    render(
      <CopySection
        state={state({ pool: testPool, campaignMessage: "Reach New Heights" })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    expect(screen.getByText("Suggestions")).toBeTruthy();
    expect(screen.getByText("Reach New Heights")).toBeTruthy();
    expect(screen.getByText("Conquer the Summit")).toBeTruthy();
    expect(screen.queryByText("Rejected Idea")).toBeNull();

    const firstCard = screen.getByRole("button", { name: "Reach New Heights" });
    expect(firstCard.getAttribute("aria-pressed")).toBe("true");

    const secondCard = screen.getByRole("button", { name: "Conquer the Summit" });
    expect(secondCard.getAttribute("aria-pressed")).toBe("false");
    await user.click(secondCard);
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { campaignMessage: "Conquer the Summit" } });
  });

  test("clicking More ideas button calls onOpenPool in variation mode", async () => {
    const user = userEvent.setup();
    const onOpenPool = vi.fn();
    render(
      <CopySection
        state={state({ mode: "variation" })}
        dispatch={vi.fn()}
        errors={{}}
        onOpenPool={onOpenPool}
      />,
    );

    const btn = screen.getByRole("button", { name: /More ideas/i });
    await user.click(btn);
    expect(onOpenPool).toHaveBeenCalledTimes(1);
  });

  test("auto-fetches pool when pool is null and dispatches loadPool", async () => {
    const dispatch = vi.fn();
    mockFetch(() =>
      json({
        pool: {
          briefId: "camp",
          entries: [{ id: "h1", text: "Loaded Headline", status: "approved" }],
        },
      }),
    );

    const { unmount } = render(<CopySection state={state({ pool: null })} dispatch={dispatch} errors={{}} />);

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "loadPool",
        briefId: "camp",
        pool: {
          briefId: "camp",
          entries: [{ id: "h1", text: "Loaded Headline", status: "approved" }],
        },
      }),
    );
    unmount();
  });

  test("auto-fetch failure is caught gracefully", async () => {
    const dispatch = vi.fn();
    mockFetch(() => new Response("500", { status: 500 }));

    render(<CopySection state={state({ pool: null })} dispatch={dispatch} errors={{}} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "loadPool" }));
  });
});

describe("OutputSection", () => {
  test("toggles a format and a platform", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<OutputSection state={state()} dispatch={dispatch} errors={{}} />);

    await user.click(screen.getByRole("button", { name: "static" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleFormat", value: "static" });
    await user.click(screen.getByRole("button", { name: "linkedin" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "togglePlatform", value: "linkedin" });
  });

  test("motion is selectable once the capability is known to be on (or unknown)", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    // Classic mode gates Video at the FormatPanel (needs Randomized), so exercise the
    // capability path on a Randomized draft where the format card is ungated.
    render(<OutputSection state={state({ mode: "variation" })} dispatch={dispatch} errors={{}} />);

    const motion = screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;
    expect(motion.disabled).toBe(false);
    await user.click(motion);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleFormat", value: "motion" });
  });

  test("motion stays unavailable with the standard notice while the capability is off", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({ capabilities: { motion: false, reason: "no ffmpeg" } })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    const motion = screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;
    expect(motion.disabled).toBe(true);
    // D7: the notice is a fixed sentence (never a concatenation of the probe reason),
    // shown on the gated format card rather than as a red field error.
    expect(screen.getAllByText(messages.formatsMotionUnavailable)).toBeTruthy();
    await user.click(motion);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "toggleFormat", value: "motion" });
  });

  test("a capability-off probe without a reason shows the same fixed sentence", () => {
    render(<OutputSection state={state({ capabilities: { motion: false } })} dispatch={vi.fn()} errors={{}} />);
    // no "capability off" fallback string: the one fixed sentence covers every reason
    expect(screen.getAllByText(messages.formatsMotionUnavailable).length).toBeGreaterThan(0);
  });

  test("a brief that already declares motion still shows it as selected", () => {
    render(<OutputSection state={state({ formats: ["static", "motion"] })} dispatch={vi.fn()} errors={{}} />);
    const motion = screen.getByRole("button", { name: "motion" });
    const staticFmt = screen.getByRole("button", { name: "static" });
    expect(motion.className).toBe(staticFmt.className.replace(/\s*$/, ""));
  });

  test("an unselected platform renders in the secondary style", () => {
    const selected = state();
    const partial = { ...selected, platforms: [selected.platforms[0]] };
    render(<OutputSection state={partial} dispatch={vi.fn()} errors={{}} />);
    const on = screen.getByRole("button", { name: partial.platforms[0] });
    const off = screen.getByRole("button", { name: "linkedin" });
    expect(on.className).not.toBe(off.className);
  });

  test("renders format and platform errors", () => {
    render(<OutputSection state={state()} dispatch={vi.fn()} errors={{ formats: "pick a format", platforms: "pick a platform" }} />);
    expect(screen.getByText("pick a format")).toBeTruthy();
    expect(screen.getByText("pick a platform")).toBeTruthy();
  });

  test("motion kinds and durations appear only when motion is a requested format", () => {
    const { unmount } = render(<OutputSection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.queryByRole("button", { name: "ken-burns-in" })).toBeNull();
    expect(screen.queryByText("Clip lengths")).toBeNull();
    unmount();

    render(<OutputSection state={state({ formats: ["static", "motion"] })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "ken-burns-in" })).toBeTruthy();
    expect(screen.getByText("Clip lengths")).toBeTruthy();
  });

  test("motion kinds toggle, durations edit, add and remove", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const { container } = render(
      <OutputSection
        state={state({ mode: "variation", formats: ["motion"], motion: ["ken-burns-in"], duration: [5] })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "accent-wipe" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleMotion", value: "accent-wipe" });

    // durations are role="slider" beads on the 0..30 s film strip: nudge to the next
    // free second, delete to remove, and click the empty track to add a new one
    const bead = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    fireEvent.keyDown(bead, { key: "ArrowRight" });
    expect(dispatch).toHaveBeenCalledWith({ type: "setDuration", index: 0, value: 6 });
    fireEvent.keyDown(bead, { key: "Delete" });
    expect(dispatch).toHaveBeenCalledWith({ type: "removeDuration", index: 0 });

    const strip = container.querySelector(".select-none") as HTMLElement;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 300, bottom: 50, width: 300, height: 50, x: 0, y: 0, toJSON: () => {},
    });
    fireEvent.click(strip, { clientX: 150 });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "addDuration" }));
  });

  test("a capability-off host gates the format card but keeps motion kinds operable (D12)", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({
          formats: ["static", "motion"],
          motion: ["ken-burns-in"],
          duration: [6],
          capabilities: { motion: false, reason: "no ffmpeg" },
        })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    // Per-card gating (L4.4) guards the format *choice*; the loaded motion kinds and
    // durations stay operable so the brief persists verbatim (D12). The unselected
    // motion format card is the thing that is disabled on this host.
    expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("slider", { name: "Duration 1 (seconds)" }).getAttribute("tabindex")).toBe("0");
    expect((screen.getByRole("button", { name: "Remove duration 6 s" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "ken-burns-in" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleMotion", value: "ken-burns-in" });
  });

  test("renders motion kind and duration errors", () => {
    render(
      <OutputSection state={state({ formats: ["motion"] })} dispatch={vi.fn()} errors={{ motion: "pick a kind", duration: "pick a duration" }} />,
    );
    expect(screen.getByText("pick a kind")).toBeTruthy();
    expect(screen.getByText("pick a duration")).toBeTruthy();
  });

  test("only platforms compatible with the requested formats are offered", () => {
    // static only: the motion platforms are not offered
    const { unmount } = render(<OutputSection state={state({ formats: ["static"] })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "instagram-feed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "instagram-reel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "tiktok" })).toBeNull();
    unmount();

    // static + motion: every profile is offered
    render(<OutputSection state={state({ formats: ["static", "motion"] })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "instagram-story" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "youtube-short" })).toBeTruthy();
  });

  test("a capability-off host hides motion platforms but keeps the brief's own read-only (D12)", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({
          formats: ["static", "motion"],
          platforms: ["instagram-feed", "instagram-reel"],
          capabilities: { motion: false, reason: "no ffmpeg" },
        })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    const reel = screen.getByRole("button", { name: "instagram-reel" }) as HTMLButtonElement;
    expect(reel.disabled).toBe(true);
    await user.click(reel);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "togglePlatform", value: "instagram-reel" });
    expect(screen.queryByRole("button", { name: "tiktok" })).toBeNull();
    expect((screen.getByRole("button", { name: "instagram-feed" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("a format-mismatched platform can still be deselected so the error has a way out", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({ formats: ["motion"], platforms: ["instagram-feed", "instagram-reel"] })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    // instagram-feed packages only static and only motion is requested — offered?
    // No: it is not offered, but it is selected, so it stays visible and clickable.
    const feed = screen.getByRole("button", { name: "instagram-feed" }) as HTMLButtonElement;
    expect(feed.disabled).toBe(false);
    await user.click(feed);
    expect(dispatch).toHaveBeenCalledWith({ type: "togglePlatform", value: "instagram-feed" });
  });

  test("the exclusion remedy asks for a photo output, not a platform toggle (L4.7)", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({ formats: ["motion"], platforms: ["instagram-reel", "x"] })}
        dispatch={dispatch}
        errors={{}}
      />,
    );
    // reel (9:16) and x (16:9) package motion, so the holding shape is named
    expect(screen.getByText((text) => text.includes("Not used for video"))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: messages.addPhotoPlatform }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addPhotoOutput" });
  });

  test("the exclusion line names no shapes when no offered platform packages motion", () => {
    render(
      <OutputSection state={state({ formats: ["motion"], platforms: [] })} dispatch={vi.fn()} errors={{}} />,
    );
    expect(screen.getByText(messages.ratioExcludedNone())).toBeTruthy();
    expect(screen.queryByRole("button", { name: messages.addPhotoPlatform })).toBeTruthy();
  });

  test("a selected platform id with no profile is skipped defensively", () => {
    render(<OutputSection state={state({ platforms: ["nonexistent"] })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.queryByRole("button", { name: "nonexistent" })).toBeNull();
  });
});

describe("TreatmentsSection", () => {
  test("renders nothing outside classic mode", () => {
    const { container } = render(<TreatmentsSection state={state({ mode: "variation" })} dispatch={vi.fn()} errors={{}} />);
    expect(container.innerHTML).toBe("");
  });

  test("explains the default when the list is empty and adds one on request", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<TreatmentsSection state={state()} dispatch={dispatch} errors={{}} />);
    expect(screen.getByText(/The default treatment will be used/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add treatment" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addTreatment" });
  });

  test("edits id, layout and tone, and removes a row", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const withOne = state({ treatments: [{ id: "bold", layout: "headline-top", tone: "bold" }] });
    render(<TreatmentsSection state={withOne} dispatch={dispatch} errors={{ treatments: "list problem" }} />);

    expect(screen.getByText("list problem")).toBeTruthy();
    await user.type(screen.getByLabelText("ID"), "x");
    expect(dispatch).toHaveBeenCalledWith({ type: "setTreatment", index: 0, patch: { id: "boldx" } });

    await user.selectOptions(screen.getByLabelText("Layout"), "headline-bottom");
    expect(dispatch).toHaveBeenCalledWith({ type: "setTreatment", index: 0, patch: { layout: "headline-bottom" } });
    await user.selectOptions(screen.getByLabelText("Tone"), "subtle");
    expect(dispatch).toHaveBeenCalledWith({ type: "setTreatment", index: 0, patch: { tone: "subtle" } });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "removeTreatment", index: 0 });
  });

  test("shows per-field treatment errors", () => {
    render(
      <TreatmentsSection
        state={state({ treatments: [{ id: "", layout: "x", tone: "y" }] })}
        dispatch={vi.fn()}
        errors={{ "treatment-0-id": "bad id", "treatment-0-layout": "bad layout", "treatment-0-tone": "bad tone" }}
      />,
    );
    expect(screen.getByText("bad id")).toBeTruthy();
    expect(screen.getByText("bad layout")).toBeTruthy();
    expect(screen.getByText("bad tone")).toBeTruthy();
  });
});

describe("ProductsSection", () => {
  const logoInput = (): HTMLInputElement =>
    screen.getAllByLabelText("Upload product logo")[0] as HTMLInputElement;

  const uploadFile = async (input: HTMLInputElement) => {
    const user = userEvent.setup();
    await user.upload(input, new File(["x"], "logo.png", { type: "image/png" }));
  };

  test("adds, edits every field, and removes", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state();
    const key = s.products[0].key;
    render(<ProductsSection state={s} dispatch={dispatch} errors={{ products: "need two" }} />);

    expect(screen.getByText("need two")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add product" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addProduct" });

    await user.type(screen.getAllByLabelText("Name")[0], "A");
    expect(dispatch).toHaveBeenCalledWith({ type: "setProduct", key, patch: { name: "A" } });
    await user.type(screen.getAllByLabelText("ID")[0], "a");
    expect(dispatch).toHaveBeenCalledWith({ type: "setProduct", key, patch: { id: "a" } });
    await user.type(screen.getAllByLabelText("Primary Colour")[0], "0");
    expect(dispatch).toHaveBeenCalledWith({ type: "setProduct", key, patch: { primaryColor: "#1473E60" } });
    await user.type(screen.getAllByLabelText("Logo Path")[0], "l");
    expect(dispatch).toHaveBeenCalledWith({ type: "setProduct", key, patch: { logoPath: "l" } });

    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(dispatch).toHaveBeenCalledWith({ type: "removeProduct", key });
  });

  test("clicking Edit reveals the product ID text input", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state({ products: [{ key: 1, id: "hydra", name: "Hydra", primaryColor: "#1473E6", logoPath: "", inputAsset: "", idTouched: false }] });
    render(<ProductsSection state={s} dispatch={dispatch} errors={{}} />);

    const editBtn = screen.getByRole("button", { name: "Edit product ID" });
    expect(editBtn).toBeTruthy();
    await user.click(editBtn);

    const input = screen.getByDisplayValue("hydra");
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "hydra-v2" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setProduct", key: 1, patch: { id: "hydra-v2" } });
  });

  test("classic mode shows a hint when only one product exists", () => {
    const s = state({ mode: "brief", products: [emptyProduct(1)] });
    render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText("Classic mode needs two different products — add a second one below.")).toBeTruthy();
  });

  test("an upload stores the path the API returns", async () => {
    const dispatch = vi.fn();
    mockFetch(() => json({ path: "assets/inputs/camp/alpha-logo.png" }, 201));
    const s = state();
    render(<ProductsSection state={s} dispatch={dispatch} errors={{}} />);

    await uploadFile(logoInput());

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "setProduct",
        key: s.products[0].key,
        patch: { logoPath: "assets/inputs/camp/alpha-logo.png" },
      }),
    );
  });

  test("a 409 means the asset already exists, so the conventional path is used", async () => {
    const dispatch = vi.fn();
    mockFetch(() => json({ error: "exists" }, 409));
    const s = state();
    render(<ProductsSection state={s} dispatch={dispatch} errors={{}} />);

    await uploadFile(logoInput());

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "setProduct",
        key: s.products[0].key,
        patch: { logoPath: "assets/inputs/camp/product-logo.png" },
      }),
    );
  });

  test("any other upload failure is surfaced in the section", async () => {
    mockFetch(() => json({ error: "disk full" }, 500));
    const s = state();
    render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);

    await uploadFile(logoInput());

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("the Upload button opens the hidden file input", async () => {
    const user = userEvent.setup();
    const s = state();
    render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);
    const input = logoInput();
    const click = vi.spyOn(input, "click");
    await user.click(screen.getAllByText("Upload")[0]);
    expect(click).toHaveBeenCalled();
  });

  test("a change event with no file selected does nothing", () => {
    const s = state();
    render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);
    const input = logoInput();
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });

  test("renders identical file-input ids from two independent initial states, and no id or data-* attribute embeds a product key", () => {
    // SSR/CSR determinism (D16): server-render twice from two independently
    // constructed states — different temp id, different session — then hydrate.
    // The ids derive from useId's position in the tree, never from the draft, so
    // they must be identical all the way through. (Client-side useId is a global
    // counter that never resets across mounts, so "identical" is only observable
    // server-to-server and through hydration — exactly where the pre-D16
    // `logo-upload-${product.key}` ids threw the hydration mismatch.)
    const ssrFileIds = (html: string) =>
      Array.from(html.matchAll(/id="(logo-upload-[^"]*)"/g)).map((m) => m[1]);
    const attrValues = (html: string) =>
      Array.from(html.matchAll(/\s(?:id|data-[\w-]+)="([^"]*)"/g)).map((m) => m[1]);
    const first = initialEditorState();
    const second = initialEditorState();
    const html1 = renderToString(<ProductsSection state={first} dispatch={vi.fn()} errors={{}} />);
    const html2 = renderToString(<ProductsSection state={second} dispatch={vi.fn()} errors={{}} />);
    expect(ssrFileIds(html2)).toEqual(ssrFileIds(html1));
    expect(ssrFileIds(html1)).toHaveLength(first.products.length);

    // The same tree keyed differently (41) must render the same ids — if an
    // id embedded its product key, moving the keys would move the ids.
    const keyed: EditorState = { ...initialEditorState(), products: [emptyProduct(41)] };
    const html3 = renderToString(<ProductsSection state={keyed} dispatch={vi.fn()} errors={{}} />);
    expect(ssrFileIds(html3)).toEqual(ssrFileIds(html1));

    const container = document.createElement("div");
    container.innerHTML = html1;
    const { unmount } = render(<ProductsSection state={first} dispatch={vi.fn()} errors={{}} />, {
      hydrate: true,
      container,
    });
    expect(
      Array.from(container.querySelectorAll('input[type="file"]')).map((el) => el.getAttribute("id")),
    ).toEqual(ssrFileIds(html1));

    // The literal probe: keys (41, 42) cannot occur in this tree's positional ids,
    // so a hit inside any id or data-* attribute value could only mean a
    // key-derived identifier.
    const domAttrValues = Array.from(container.querySelectorAll("*")).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => attr.name === "id" || attr.name.startsWith("data-"))
        .map((attr) => attr.value),
    );
    for (const value of [...attrValues(html1), ...attrValues(html3), ...domAttrValues]) {
      expect(value).not.toContain("41");
      expect(value).not.toContain("42");
    }
    unmount();
  });
});

describe("ErrorStrip", () => {
  test("renders nothing when every section is clean", () => {
    const { container } = render(<ErrorStrip errors={{ identity: {}, copy: {} }} />);
    expect(container.innerHTML).toBe("");
  });

  test("shows a chip per failing section with its count, and reports clicks", async () => {
    const user = userEvent.setup();
    const onErrorClick = vi.fn();
    render(
      <ErrorStrip
        errors={{ identity: { briefId: "x" }, copy: { a: "1", b: "2" }, clean: {} }}
        onErrorClick={onErrorClick}
      />,
    );
    expect(screen.getByRole("button", { name: /Identity/ }).textContent).toContain("1");
    expect(screen.getByRole("button", { name: /Copy/ }).textContent).toContain("2");
    await user.click(screen.getByRole("button", { name: /Identity/ }));
    expect(onErrorClick).toHaveBeenCalledWith("identity");
  });

  test("falls back to the raw key for an unknown section and tolerates no click handler", async () => {
    const user = userEvent.setup();
    render(<ErrorStrip errors={{ mystery: { a: "1" } }} />);
    const button = screen.getByRole("button", { name: /mystery/ });
    await user.click(button);
    expect(button).toBeTruthy();
  });
});

