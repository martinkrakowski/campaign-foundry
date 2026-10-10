import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LogoField } from "../LogoField";
import * as messages from "../messages";

describe("LogoField", () => {
  test("renders empty state with drop zone and upload button", () => {
    const onUploadFile = vi.fn();
    const onChooseFromBin = vi.fn();
    render(
      <LogoField
        value=""
        onChange={vi.fn()}
        onUploadFile={onUploadFile}
        onChooseFromBin={onChooseFromBin}
        productColor="#ff0000"
      />,
    );

    expect(screen.getByText(messages.logoEmpty)).toBeTruthy();
    const uploadBtn = screen.getByRole("button", { name: "Upload" });
    expect(uploadBtn).toBeTruthy();
    const input = screen.getByLabelText(messages.logoUploadAria) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(uploadBtn);
    expect(clickSpy).toHaveBeenCalled();

    const binBtn = screen.getByRole("button", { name: "Choose from bin" });
    expect(binBtn).toBeTruthy();
    fireEvent.click(binBtn);
    expect(onChooseFromBin).toHaveBeenCalledTimes(1);
  });

  test("renders populated state with filename, TYPE · size meta line, and tinted badge", () => {
    const onChooseFromBin = vi.fn();
    render(
      <LogoField
        value="assets/inputs/camp/hydra-bottle-logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        onChooseFromBin={onChooseFromBin}
        productColor="#1473e6"
        fileSize={2048}
      />,
    );

    expect(screen.getByText("hydra-bottle-logo.png")).toBeTruthy();
    expect(screen.getAllByText("PNG").length).toBe(2);
    expect(screen.getByText("2.0 KB")).toBeTruthy();

    const replaceBtn = screen.getByRole("button", { name: "Replace" });
    expect(replaceBtn).toBeTruthy();
    const input = screen.getByLabelText(messages.logoUploadAria) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(replaceBtn);
    expect(clickSpy).toHaveBeenCalled();

    const binBtn = screen.getByRole("button", { name: "Choose from bin" });
    expect(binBtn).toBeTruthy();
    fireEvent.click(binBtn);
    expect(onChooseFromBin).toHaveBeenCalledTimes(1);
  });

  test("renders plain filename when value has no slashes and default file size label", () => {
    render(<LogoField value="logo.png" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(screen.getByText("file")).toBeTruthy();
  });

  test("renders image preview when direct URL or thumbnailUrl provided", () => {
    render(
      <LogoField
        value="data:image/png;base64,iVBORw0KGgo="
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
      />,
    );

    const img = screen.getByAltText("Product logo preview") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain("data:image/png;base64");
  });

  test("renders string fileSize directly when passed as string", () => {
    render(
      <LogoField
        value="assets/logo.svg"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        fileSize="12 KB"
      />,
    );
    expect(screen.getByText("12 KB")).toBeTruthy();
  });

  test("omits choose from bin button when onChooseFromBin is not provided", () => {
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Choose from bin" })).toBeNull();
  });

  test("displays uploading state when uploading is true for empty and populated states", () => {
    const { unmount } = render(
      <LogoField value="" onChange={vi.fn()} onUploadFile={vi.fn()} uploading={true} />,
    );
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeTruthy();
    unmount();

    render(
      <LogoField value="logo.png" onChange={vi.fn()} onUploadFile={vi.fn()} uploading={true} />,
    );
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeTruthy();
  });

  test("displays error message when provided", () => {
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={vi.fn()} error="File too large" />);
    expect(screen.getByText("File too large")).toBeTruthy();
  });

  test("rendered with aria-describedby, the logo path input carries it", () => {
    render(
      <LogoField
        value="logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        aria-describedby="logo-error-id"
      />,
    );
    const input = screen.getByLabelText(messages.logoPathAria);
    expect(input.getAttribute("aria-describedby")).toBe("logo-error-id");
  });

  // The two handlers below are what make the control editable at all, and neither
  // had a test: the file input's, which forwards the picked file and then clears
  // itself so re-picking the same file fires again, and the mirror's, which is the
  // only route by which a keyboard or a paste can change the ref.
  test("a picked file is uploaded once and the file input is left empty", () => {
    const onUploadFile = vi.fn();
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={onUploadFile} />);
    const input = screen.getByLabelText(messages.logoUploadAria) as HTMLInputElement;
    const file = new File(["png"], "hydra-logo.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(onUploadFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");

    // A dialog the operator cancels fires a change with nothing in it: no upload,
    // and no error either — nothing happened, and it must not read as something did.
    fireEvent.change(input, { target: { files: [] } });
    expect(onUploadFile).toHaveBeenCalledTimes(1);
  });

  test("the mirror input reports its edits to onChange", () => {
    const onChange = vi.fn();
    render(<LogoField value="logo.png" onChange={onChange} onUploadFile={vi.fn()} />);

    const mirror = screen.getByLabelText(messages.logoPathAria);
    fireEvent.change(mirror, { target: { value: "assets/inputs/camp/other.png" } });
    expect(onChange).toHaveBeenCalledWith("assets/inputs/camp/other.png");
  });

  test("an unset logo that is invalid draws its drop zone in the error colour", () => {
    const { container } = render(
      <LogoField value="" onChange={vi.fn()} onUploadFile={vi.fn()} invalid />,
    );
    expect(container.querySelector(".border-error")).not.toBeNull();
  });

  // D203/#666 — under the object backend `value` is a uuid. Everything below is
  // about the one rule that follows from it: nothing a person can read may be that
  // uuid, and everything that reads `value` as a NAME (the label, the title, the
  // extension badge) has to read `displayName` instead.
  describe("an asset id ref", () => {
    const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const NAME = "hydra-bottle-logo.png";

    test("a path ref's tooltip is the full path, an id ref's is the name", () => {
      // Two different questions, two different answers. The tooltip answers "what
      // exactly is in this field", where the directory is the half that distinguishes
      // one campaign's asset from another's with the same basename — so a path ref
      // keeps it. And an id ref never shows a uuid, which `displayName ?? value`
      // guarantees because an id ref always arrives WITH a displayName.
      const path = render(
        <LogoField
          value="assets/inputs/camp/hydra-bottle-logo.png"
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );
      expect(screen.getByText("hydra-bottle-logo.png").getAttribute("title")).toBe(
        "assets/inputs/camp/hydra-bottle-logo.png",
      );
      path.unmount();

      render(<LogoField value={ID} displayName={NAME} onChange={vi.fn()} onUploadFile={vi.fn()} />);
      expect(screen.getByText(NAME).getAttribute("title")).toBe(NAME);
    });

    test("shows displayName as the label and the title, and reads the badge from it", () => {
      render(
        <LogoField
          value={ID}
          displayName={NAME}
          fileSize={2048}
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );

      const label = screen.getByText(NAME);
      expect(label.getAttribute("title")).toBe(NAME);
      // Twice: the badge in the tile and the extension in the meta line. Both come
      // from the name — an id has no extension, so a badge read off `value` would
      // say IMG for every logo on the host.
      expect(screen.getAllByText("PNG")).toHaveLength(2);
      expect(screen.getByText("2.0 KB")).toBeTruthy();
    });

    test("renders the resolved thumbnail", () => {
      const thumbnailUrl = "/api/pipeline/campaigns/assets?briefId=camp-1&name=hydra.png";
      render(
        <LogoField
          value={ID}
          displayName={NAME}
          thumbnailUrl={thumbnailUrl}
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );
      const img = screen.getByAltText(messages.logoPreviewAlt) as HTMLImageElement;
      expect(img.getAttribute("src")).toBe(thumbnailUrl);
    });

    test("shows no uuid anywhere visible, while the mirror input keeps the raw ref", () => {
      const { container } = render(
        <LogoField
          value={ID}
          displayName={messages.assetUnavailable}
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );

      expect(container.textContent).not.toContain(ID);
      for (const titled of container.querySelectorAll("[title]")) {
        expect(titled.getAttribute("title")).not.toContain(ID);
      }
      expect(screen.getByText(messages.assetUnavailable)).toBeTruthy();
      // No thumbnail was resolved, so there is no <img> and the badge degrades to
      // today's IMG rather than inventing an extension the uuid does not carry.
      expect(screen.queryByAltText(messages.logoPreviewAlt)).toBeNull();
      expect(screen.getAllByText("IMG")).toHaveLength(2);

      // The mirror input is the field's OWN editable value: it is what a paste, a
      // test and the server all read back, so it keeps the ref even when the tile
      // refuses to show it.
      const mirror = screen.getByLabelText(messages.logoPathAria) as HTMLInputElement;
      expect(mirror.value).toBe(ID);
    });

    test("a path ref with no displayName renders exactly as before", () => {
      // The control's default has to be untouched, or every filesystem-shaped
      // brief in the product changes shape the moment a field gains a prop.
      const { container } = render(
        <LogoField
          value="assets/inputs/camp/hydra-bottle-logo.png"
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );
      expect(screen.getByText("hydra-bottle-logo.png")).toBeTruthy();
      expect(screen.getAllByText("PNG")).toHaveLength(2);
      expect(container.textContent).not.toContain("assets/inputs/camp/");
    });

    // The mirror input is the one part of the control a screen reader actually
    // READS, and its value is the uuid: "Logo Path, 3f2504e0-4f89-…" is 36
    // characters of nothing. The name the tile shows is the answer, so the field
    // is described by it — and described by nothing at all when there is no name
    // to add, because a description is only ever an addition.
    test("the hidden field is described by the asset's name when the value is an id", () => {
      render(
        <LogoField
          value={ID}
          displayName="hydra-logo.png"
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      const describedBy = (mirror.getAttribute("aria-describedby") ?? "").split(" ");
      const texts = describedBy.map((id) => document.getElementById(id)?.textContent ?? "");
      expect(texts).toContain("Asset: hydra-logo.png");
    });

    test("a caller's own description is kept beside the name", () => {
      render(
        <>
          <span id="hint-1">Required</span>
          <LogoField
            value={ID}
            displayName="hydra-logo.png"
            onChange={vi.fn()}
            onUploadFile={vi.fn()}
            aria-describedby="hint-1"
          />
        </>,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      const ids = (mirror.getAttribute("aria-describedby") ?? "").split(" ");
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe("hint-1");
      expect(document.getElementById(ids[1])?.textContent).toBe("Asset: hydra-logo.png");
    });

    test("with no display name the hidden field has no added description", () => {
      const { container } = render(
        <LogoField value="assets/inputs/camp/logo.png" onChange={vi.fn()} onUploadFile={vi.fn()} />,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      expect(mirror.hasAttribute("aria-describedby")).toBe(false);
      expect(container.textContent).not.toContain("Asset:");
    });

    test("a display name equal to the value adds nothing", () => {
      render(
        <LogoField
          value="hydra-logo.png"
          displayName="hydra-logo.png"
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
        />,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      expect(mirror.hasAttribute("aria-describedby")).toBe(false);
    });

    test("a blank display name adds nothing", () => {
      const { container } = render(
        <LogoField value={ID} displayName="   " onChange={vi.fn()} onUploadFile={vi.fn()} />,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      expect(mirror.hasAttribute("aria-describedby")).toBe(false);
      expect(container.textContent).not.toContain("Asset:");
    });

    test("an empty caller description leaves only the name's id, with no stray space", () => {
      render(
        <LogoField
          value={ID}
          displayName="hydra-logo.png"
          onChange={vi.fn()}
          onUploadFile={vi.fn()}
          aria-describedby=""
        />,
      );

      const mirror = screen.getByLabelText(messages.logoPathAria);
      const described = mirror.getAttribute("aria-describedby") ?? "";
      expect(described).toBe(described.trim());
      expect(described.split(" ")).toHaveLength(1);
      expect(document.getElementById(described)?.textContent).toBe("Asset: hydra-logo.png");
    });
  });
});
