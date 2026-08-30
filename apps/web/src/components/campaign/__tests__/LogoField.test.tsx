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
    render(
      <LogoField
        value="logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
      />,
    );
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
      <LogoField
        value=""
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        uploading={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeTruthy();
    unmount();

    render(
      <LogoField
        value="logo.png"
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        uploading={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Uploading..." })).toBeTruthy();
  });

  test("displays error message when provided", () => {
    render(
      <LogoField
        value=""
        onChange={vi.fn()}
        onUploadFile={vi.fn()}
        error="File too large"
      />,
    );
    expect(screen.getByText("File too large")).toBeTruthy();
  });
});
