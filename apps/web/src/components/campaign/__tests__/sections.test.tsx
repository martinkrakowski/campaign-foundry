import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initialEditorState, type EditorState } from "../editor-state";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection } from "../sections";
import { ErrorStrip } from "../ErrorStrip";

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
    render(<IdentitySection state={state()} dispatch={dispatch} errors={{}} />);

    await user.type(screen.getByLabelText("Target Region"), "D");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetRegion: "D" } });
    await user.type(screen.getByLabelText("Target Audience"), "a");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetAudience: "a" } });
  });

  test("the brief id is editable on a new draft and read-only once loaded from a file", () => {
    const { unmount } = render(<IdentitySection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByLabelText("Brief ID").hasAttribute("readonly")).toBe(false);
    unmount();

    render(
      <IdentitySection
        state={state({ source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: undefined } })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByLabelText("Brief ID").hasAttribute("readonly")).toBe(true);
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

    await user.type(screen.getByLabelText("Campaign Message"), "H");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { campaignMessage: "H" } });
    await user.type(screen.getByLabelText("Localized Message (optional)"), "x");
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { localizedMessage: "x" } });
    expect(screen.getByText("required")).toBeTruthy();
    expect(screen.getByText("odd")).toBeTruthy();
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
    render(<OutputSection state={state()} dispatch={dispatch} errors={{}} />);

    const motion = screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;
    expect(motion.disabled).toBe(false);
    await user.click(motion);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleFormat", value: "motion" });
  });

  test("motion stays unavailable with the probe's reason while the capability is off", async () => {
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
    expect(screen.getByText(/Motion is not available on this host: no ffmpeg/)).toBeTruthy();
    await user.click(motion);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "toggleFormat", value: "motion" });
  });

  test("a capability-off probe without a reason falls back to a generic one", () => {
    render(<OutputSection state={state({ capabilities: { motion: false } })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/Motion is not available on this host: capability off/)).toBeTruthy();
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
    expect(screen.queryByText("Durations (seconds)")).toBeNull();
    unmount();

    render(<OutputSection state={state({ formats: ["static", "motion"] })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "ken-burns-in" })).toBeTruthy();
    expect(screen.getByText("Durations (seconds)")).toBeTruthy();
  });

  test("motion kinds toggle, durations edit, add and remove", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={state({ formats: ["motion"], motion: ["ken-burns-in"], duration: [5] })}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "accent-wipe" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleMotion", value: "accent-wipe" });

    fireEvent.change(screen.getByLabelText("Duration 1 (seconds)"), { target: { value: "8" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setDuration", index: 0, value: 8 });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "removeDuration", index: 0 });

    await user.click(screen.getByRole("button", { name: "Add duration" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addDuration" });
  });

  test("motion controls are disabled with the reason while the capability is off (D12)", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <OutputSection
        state={{
          ...state({
            formats: ["static", "motion"],
            motion: ["ken-burns-in"],
            duration: [6],
            capabilities: { motion: false, reason: "no ffmpeg" },
          }),
        }}
        dispatch={dispatch}
        errors={{}}
      />,
    );

    expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Duration 1 (seconds)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add duration" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "ken-burns-in" }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: "toggleMotion", value: "ken-burns-in" });
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
  const uploadFile = async (container: HTMLElement, key: number) => {
    const user = userEvent.setup();
    const input = container.querySelector(`#logo-upload-${key}`) as HTMLInputElement;
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

  test("an upload stores the path the API returns", async () => {
    const dispatch = vi.fn();
    mockFetch(() => json({ path: "assets/inputs/camp/alpha-logo.png" }, 201));
    const s = state();
    const { container } = render(<ProductsSection state={s} dispatch={dispatch} errors={{}} />);

    await uploadFile(container, s.products[0].key);

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
    const { container } = render(<ProductsSection state={s} dispatch={dispatch} errors={{}} />);

    await uploadFile(container, s.products[0].key);

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
    const { container } = render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);

    await uploadFile(container, s.products[0].key);

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("the Upload button opens the hidden file input", async () => {
    const user = userEvent.setup();
    const s = state();
    const { container } = render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);
    const input = container.querySelector(`#logo-upload-${s.products[0].key}`) as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    await user.click(screen.getAllByText("Upload")[0]);
    expect(click).toHaveBeenCalled();
  });

  test("a change event with no file selected does nothing", () => {
    const s = state();
    const { container } = render(<ProductsSection state={s} dispatch={vi.fn()} errors={{}} />);
    const input = container.querySelector(`#logo-upload-${s.products[0].key}`) as HTMLInputElement;
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
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

