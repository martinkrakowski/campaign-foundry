import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssetPickerDrawer, formatBytes } from "../AssetPickerDrawer";
import * as briefsApi from "@/lib/briefs-api";

describe("formatBytes", () => {
  test("formats byte sizes correctly across B, KB, and MB", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2560)).toBe("2.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(2097152)).toBe("2.0 MB");
  });
});

describe("AssetPickerDrawer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders nothing when closed", () => {
    const { container } = render(
      <AssetPickerDrawer briefId="camp-1" open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("shows loading state and then renders empty state when no assets exist", async () => {
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: [] });

    render(<AssetPickerDrawer briefId="camp-1" open={true} onClose={() => {}} />);

    expect(screen.getByRole("status").textContent).toContain("Loading assets…");

    await waitFor(() => {
      expect(screen.getByText("No assets uploaded yet.")).toBeTruthy();
    });
    expect(screen.getByText("Assets (0)")).toBeTruthy();
  });

  test("renders error message when asset listing fails", async () => {
    vi.spyOn(briefsApi, "listAssets").mockRejectedValueOnce(new Error("Server error"));

    render(<AssetPickerDrawer briefId="camp-1" open={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Server error");
    });
  });

  test("renders asset list with thumbnails, names, types, sizes, and hero star when onSelect is omitted", async () => {
    const mockAssets: briefsApi.AssetEntry[] = [
      {
        name: "logo.png",
        type: "image/png",
        size: 2048,
        thumbnailUrl: "data:image/png;base64,AAA",
      },
      {
        name: "banner.jpg",
        type: "image/jpeg",
        size: 512000,
        thumbnailUrl: "",
      },
      {
        name: "fallback.png",
        type: undefined as unknown as string,
        size: undefined as unknown as number,
        thumbnailUrl: "",
      },
    ];
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: mockAssets });

    render(<AssetPickerDrawer briefId="camp-1" open={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("logo.png")).toBeTruthy();
    });

    expect(screen.getByText("banner.jpg")).toBeTruthy();
    expect(screen.getByText("fallback.png")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("500.0 KB")).toBeTruthy();
    expect(screen.getByText("0 B")).toBeTruthy();
    expect(screen.getAllByLabelText("Hero asset")).toHaveLength(3);

    const img = screen.getByAltText("logo.png");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  test("calls onSelect and onClose when an asset is chosen", async () => {
    const user = userEvent.setup();
    const mockAssets: briefsApi.AssetEntry[] = [
      {
        name: "logo.png",
        type: "image/png",
        size: 2048,
        thumbnailUrl: "data:image/png;base64,AAA",
      },
    ];
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: mockAssets });
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <AssetPickerDrawer
        briefId="camp-1"
        open={true}
        onClose={onClose}
        onSelect={onSelect}
        selectedPath="assets/inputs/camp-1/other.png"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Choose logo.png" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Choose logo.png" }));
    expect(onSelect).toHaveBeenCalledWith(mockAssets[0]);
    expect(onClose).toHaveBeenCalled();
  });

  test("shows Selected variant when selectedPath matches", async () => {
    const mockAssets: briefsApi.AssetEntry[] = [
      {
        name: "logo.png",
        type: "image/png",
        size: 2048,
        thumbnailUrl: "data:image/png;base64,AAA",
      },
    ];
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: mockAssets });

    render(
      <AssetPickerDrawer
        briefId="camp-1"
        open={true}
        onClose={() => {}}
        onSelect={() => {}}
        selectedPath="assets/inputs/camp-1/logo.png"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Selected")).toBeTruthy();
    });
  });

  test("shows Selected variant when selectedPath matches basename", async () => {
    const mockAssets: briefsApi.AssetEntry[] = [
      {
        name: "logo.png",
        type: "image/png",
        size: 2048,
        thumbnailUrl: "data:image/png;base64,AAA",
      },
    ];
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: mockAssets });

    render(
      <AssetPickerDrawer
        briefId="camp-1"
        open={true}
        onClose={() => {}}
        onSelect={() => {}}
        selectedPath="logo.png"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Selected")).toBeTruthy();
    });
  });

  test("aborts in-flight request and ignores late responses when unmounted during fetch", async () => {
    let capturedSignal1: AbortSignal | undefined;
    let resolvePromise: (value: { assets: briefsApi.AssetEntry[] }) => void = () => {};
    const pendingPromise = new Promise<{ assets: briefsApi.AssetEntry[] }>((r) => {
      resolvePromise = r;
    });
    vi.spyOn(briefsApi, "listAssets").mockImplementationOnce((_id, signal) => {
      capturedSignal1 = signal;
      return pendingPromise;
    });

    const { unmount } = render(
      <AssetPickerDrawer briefId="camp-1" open={true} onClose={() => {}} />,
    );
    expect(capturedSignal1?.aborted).toBe(false);
    unmount();
    expect(capturedSignal1?.aborted).toBe(true);
    resolvePromise({ assets: [{ name: "a.png", type: "image/png", size: 10, thumbnailUrl: "" }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("a.png")).toBeNull();

    // Also test rejection during cancellation
    let capturedSignal2: AbortSignal | undefined;
    let rejectPromise: (err: unknown) => void = () => {};
    const pendingReject = new Promise<{ assets: briefsApi.AssetEntry[] }>((_, r) => {
      rejectPromise = r;
    });
    vi.spyOn(briefsApi, "listAssets").mockImplementationOnce((_id, signal) => {
      capturedSignal2 = signal;
      return pendingReject;
    });
    const { unmount: unmount2 } = render(
      <AssetPickerDrawer briefId="camp-1" open={true} onClose={() => {}} />,
    );
    expect(capturedSignal2?.aborted).toBe(false);
    unmount2();
    expect(capturedSignal2?.aborted).toBe(true);
    rejectPromise(new Error("abort"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("clicking Close button or backdrop calls onClose", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: [] });
    const onClose = vi.fn();

    const { container } = render(
      <AssetPickerDrawer briefId="camp-1" open={true} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Backdrop click
    const backdrop = container.querySelector(".backdrop-blur-sm");
    expect(backdrop).toBeTruthy();
    if (backdrop) await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
