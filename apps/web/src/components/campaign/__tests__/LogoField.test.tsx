import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogoField } from "../LogoField";

describe("LogoField", () => {
  test("unset state renders dashed tile, upload prompt, and Upload button", async () => {
    const user = userEvent.setup();
    const onUploadFile = vi.fn();
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={onUploadFile} />);

    expect(screen.getByText("No logo yet — upload a PNG or JPEG")).toBeTruthy();
    const uploadButton = screen.getByRole("button", { name: "Upload" });
    expect(uploadButton).toBeTruthy();

    const fileInput = screen.getByLabelText("Upload product logo") as HTMLInputElement;
    expect(fileInput.type).toBe("file");
    expect(fileInput.className).toContain("hidden");

    const clickSpy = vi.spyOn(fileInput, "click");
    await user.click(uploadButton);
    expect(clickSpy).toHaveBeenCalled();
  });

  test("does not render Choose from bin button when onChooseFromBin is not provided (L5 seam)", () => {
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Choose from bin" })).toBeNull();
  });

  test("renders Choose from bin button when onChooseFromBin is provided on unset state", async () => {
    const user = userEvent.setup();
    const onChooseFromBin = vi.fn();
    render(
      <LogoField
        value=""
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        onChooseFromBin={onChooseFromBin}
      />,
    );

    const binButton = screen.getByRole("button", { name: "Choose from bin" });
    expect(binButton).toBeTruthy();
    await user.click(binButton);
    expect(onChooseFromBin).toHaveBeenCalled();
  });

  test("renders Choose from bin button when onChooseFromBin is provided on set state", async () => {
    const user = userEvent.setup();
    const onChooseFromBin = vi.fn();
    render(
      <LogoField
        value="assets/inputs/camp/logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        onChooseFromBin={onChooseFromBin}
      />,
    );

    const binButton = screen.getByRole("button", { name: "Choose from bin" });
    expect(binButton).toBeTruthy();
    await user.click(binButton);
    expect(onChooseFromBin).toHaveBeenCalled();
  });

  test("set state without direct image URL renders file extension badge, path meta, and Replace button", async () => {
    const user = userEvent.setup();
    const onUploadFile = vi.fn();
    render(
      <LogoField
        value="assets/inputs/camp/logo.png"
        onChange={vi.fn()}
        onUploadFile={onUploadFile}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("assets/inputs/camp/logo.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();

    const fileInput = screen.getByLabelText("Upload product logo") as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(clickSpy).toHaveBeenCalled();
  });

  test("set state with filename lacking extension degrades to IMG badge", () => {
    render(<LogoField value="custom-logo" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("IMG")).toBeTruthy();
  });

  test("renders image thumbnail when thumbnailUrl prop is provided", () => {
    render(
      <LogoField
        value="assets/inputs/camp/logo.png"
        thumbnailUrl="data:image/png;base64,thumbdata"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
      />,
    );

    const img = screen.getByRole("img", { name: "Product logo preview" }) as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe("data:image/png;base64,thumbdata");
  });

  test("supports data URI, blob URL, and http URLs for image preview", () => {
    const { rerender } = render(
      <LogoField value="data:image/png;base64,123" onChange={vi.fn()} onUploadFile={vi.fn()} />,
    );
    let img = screen.getByRole("img", { name: "Product logo preview" }) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,123");

    rerender(<LogoField value="blob:http://localhost/1234" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    img = screen.getByRole("img", { name: "Product logo preview" }) as HTMLImageElement;
    expect(img.src).toBe("blob:http://localhost/1234");

    rerender(<LogoField value="https://example.com/logo.png" onChange={vi.fn()} onUploadFile={vi.fn()} />);
    img = screen.getByRole("img", { name: "Product logo preview" }) as HTMLImageElement;
    expect(img.src).toBe("https://example.com/logo.png");
  });

  test("selecting a file triggers onUploadFile", () => {
    const onUploadFile = vi.fn();
    render(<LogoField value="" onChange={vi.fn()} onUploadFile={onUploadFile} />);

    const fileInput = screen.getByLabelText("Upload product logo") as HTMLInputElement;
    const file = new File(["dummy"], "logo.png", { type: "image/png" });

    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(onUploadFile).toHaveBeenCalledWith(file);

    // Empty files change does nothing
    fireEvent.change(fileInput, { target: { files: [] } });
  });

  test("uploading state shows Uploading text and disables actions", () => {
    render(
      <LogoField
        value=""
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        uploading={true}
        onChooseFromBin={vi.fn()}
      />,
    );

    const uploadButton = screen.getByRole("button", { name: "Uploading..." }) as HTMLButtonElement;
    expect(uploadButton.disabled).toBe(true);

    const binButton = screen.getByRole("button", { name: "Choose from bin" }) as HTMLButtonElement;
    expect(binButton.disabled).toBe(true);
  });

  test("uploading state on set logo disables Replace and bin button", () => {
    render(
      <LogoField
        value="logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        uploading={true}
        onChooseFromBin={vi.fn()}
      />,
    );

    const replaceButton = screen.getByRole("button", { name: "Uploading..." }) as HTMLButtonElement;
    expect(replaceButton.disabled).toBe(true);

    const binButton = screen.getByRole("button", { name: "Choose from bin" }) as HTMLButtonElement;
    expect(binButton.disabled).toBe(true);
  });

  test("renders error message and invalid styling when props are provided", () => {
    render(
      <LogoField
        value=""
        invalid={true}
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        error="No logo yet — upload one with the Logo button."
      />,
    );

    expect(screen.getByText("No logo yet — upload one with the Logo button.")).toBeTruthy();
  });

  test("accessible text input reflects value and fires onChange", () => {
    const onChange = vi.fn();
    render(<LogoField value="test.png" onChange={onChange} onUploadFile={vi.fn()} />);

    const input = screen.getByLabelText("Logo Path") as HTMLInputElement;
    expect(input.value).toBe("test.png");

    fireEvent.change(input, { target: { value: "updated.png" } });
    expect(onChange).toHaveBeenCalledWith("updated.png");
  });
});
