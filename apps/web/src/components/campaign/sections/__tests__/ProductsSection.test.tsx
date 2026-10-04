import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AssetEntry } from "@/lib/briefs-api";
import { ProductsSection } from "../ProductsSection";
import { initialEditorState } from "../../editor-state";
import * as messages from "../../messages";
import type { FieldErrors } from "../../validate";

function renderWithErrors(errors: FieldErrors) {
  const state = initialEditorState();
  const dispatch = vi.fn();
  const onChooseFromBin = vi.fn();
  render(
    <ProductsSection
      state={state}
      dispatch={dispatch}
      errors={errors}
      onChooseFromBin={onChooseFromBin}
    />,
  );
  return { dispatch, onChooseFromBin };
}

describe("ProductsSection", () => {
  test("the heading renders through Eyebrow as an h3 on the token", () => {
    renderWithErrors({});
    const heading = screen.getByRole("heading", { name: "Products (1)", level: 3 });
    expect(heading.className).toContain("tracking-eyebrow");
    expect(heading.className).not.toContain("tracking-widest");
  });

  test("renders product-0-name error and sets aria-invalid on name input", () => {
    renderWithErrors({ "product-0-name": "Name is required." });
    expect(screen.getByText("Name is required.")).toBeTruthy();
    const nameInput = screen.getAllByLabelText("Name")[0] as HTMLInputElement;
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-id error and sets aria-invalid on id input", () => {
    renderWithErrors({ "product-0-id": "ID is required." });
    expect(screen.getByText("ID is required.")).toBeTruthy();
    const idInput = screen.getAllByLabelText("ID")[0] as HTMLInputElement;
    expect(idInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-color error and sets aria-invalid on color input", () => {
    renderWithErrors({ "product-0-color": "Colour is required." });
    expect(screen.getByText("Colour is required.")).toBeTruthy();
    const colorInput = screen.getAllByLabelText("Primary Colour")[0] as HTMLInputElement;
    expect(colorInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("renders product-0-logo error and sets aria-invalid on logo input", () => {
    renderWithErrors({ "product-0-logo": "Logo is required." });
    expect(screen.getByText("Logo is required.")).toBeTruthy();
    const logoInput = screen.getAllByLabelText("Logo Path")[0] as HTMLInputElement;
    expect(logoInput.getAttribute("aria-invalid")).toBe("true");
  });

  test("the hidden logo file input answers to its aria-label, not a product key", () => {
    renderWithErrors({});
    const input = screen.getAllByLabelText("Upload product logo")[0] as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.className).toContain("hidden");
  });

  test("choosing from the bin publishes the product key whose logo the bin would fill", async () => {
    const user = userEvent.setup();
    const state = initialEditorState();
    const dispatch = vi.fn();
    const onChooseFromBin = vi.fn();

    // M7: the drawer itself is hoisted to BriefEditor's root (the transformed step
    // card traps `fixed` descendants), so this section keeps the trigger only — its
    // contract is the request it publishes, carrying the product's key.
    render(
      <ProductsSection
        state={state}
        dispatch={dispatch}
        errors={{}}
        onChooseFromBin={onChooseFromBin}
      />,
    );

    const chooseBtn = screen.getAllByRole("button", { name: "Choose from bin" })[0];
    await user.click(chooseBtn);
    expect(onChooseFromBin).toHaveBeenCalledWith(state.products[0].key);
    // No drawer inside the section: the bin is the editor's, not the card's.
    expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull();
  });
});

// D203/#666 — a product's `logoPath` is an asset row's uuid under the object
// backend, and PT-4k2b1 rewrites every stored ref to one on save. So a brief saved
// on s3 and reopened HERE arrives holding a uuid in `logoPath`, with no name on it.
describe("ProductsSection — a logo stored as an asset id", () => {
  const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const NAME = "alpha-logo.png";
  const THUMBNAIL = "/api/pipeline/campaigns/assets?briefId=camp&name=alpha-logo.png";
  const listing: AssetEntry[] = [
    { id: ID, name: NAME, type: "image/png", size: 2048, thumbnailUrl: THUMBNAIL },
  ];

  const renderWithLogo = (logoPath: string, assets?: readonly AssetEntry[]) => {
    const base = initialEditorState();
    const dispatch = vi.fn();
    const { container } = render(
      <ProductsSection
        state={{
          ...base,
          briefId: "camp",
          products: [{ ...base.products[0], logoPath }],
        }}
        dispatch={dispatch}
        errors={{}}
        onChooseFromBin={vi.fn()}
        assets={assets}
      />,
    );
    // `textContent` and not the mirror input's `.value`: the raw ref is the field's
    // own editable value and is SUPPOSED to be there. What must never show it is
    // anything a person reads.
    return { container, dispatch };
  };

  test("shows the listing entry's name and its thumbnail", () => {
    const { container } = renderWithLogo(ID, listing);
    expect(screen.getByText(NAME)).toBeTruthy();
    expect(container.textContent).not.toContain(ID);
    const img = screen.getByAltText(messages.logoPreviewAlt) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(THUMBNAIL);
    // Once a thumbnail resolves the tile shows the image, so the extension is read
    // once — in the meta line — and it is read from the NAME, not from the id.
    expect(screen.getAllByText("PNG")).toHaveLength(1);
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });

  test("says the asset is unavailable when the listing does not have it, never the uuid", () => {
    // `[]`, not `undefined`: an empty listing is an ANSWER, so this must not be
    // satisfiable by the pending label. A listing that failed resolves to `[]` for
    // the same reason — otherwise the field reads "Loading…" for the session.
    const { container } = renderWithLogo(ID, []);
    expect(screen.getByText(messages.assetUnavailable)).toBeTruthy();
    expect(container.textContent).not.toContain(ID);
    expect(screen.queryByText(messages.assetPending)).toBeNull();
    expect(screen.queryByAltText(messages.logoPreviewAlt)).toBeNull();
    for (const titled of container.querySelectorAll("[title]")) {
      expect(titled.getAttribute("title")).not.toContain(ID);
    }
  });

  test("says it is loading while the listing has not arrived", () => {
    const { container } = renderWithLogo(ID);
    expect(screen.getByText(messages.assetPending)).toBeTruthy();
    expect(container.textContent).not.toContain(ID);
  });

  test("a path logo takes none of the resolved props and renders exactly as before", () => {
    // The fs path through this row is byte-identical to what it always was: no
    // displayName, no thumbnail, no size, and the basename from the ref itself.
    renderWithLogo("assets/inputs/camp/alpha-logo.png", listing);
    expect(screen.getByText(NAME)).toBeTruthy();
    // `fileSize` was never passed for a path ref, so the meta line reads "file".
    expect(screen.getByText("file")).toBeTruthy();
    expect(screen.queryByText("2.0 KB")).toBeNull();
    expect(screen.queryByAltText(messages.logoPreviewAlt)).toBeNull();
  });

  test("an empty logo path renders the empty state whatever the listing holds", () => {
    renderWithLogo("", listing);
    expect(screen.getByText(messages.logoEmpty)).toBeTruthy();
    expect(screen.queryByText(messages.assetPending)).toBeNull();
  });
});
