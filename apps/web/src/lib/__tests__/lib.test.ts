import { describe, test, expect } from "vitest";
import { cn } from "@/lib/cn";
import { MODELS, labelFor } from "@/lib/models";
import { ASPECT_RATIOS } from "@/lib/aspect-ratios";
import { theme } from "@/styles/theme";

describe("cn", () => {
  test("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });
  test("a later Tailwind class wins the conflict", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
  test("flattens conditional and array inputs", () => {
    expect(cn("a", false, ["c", null, undefined])).toBe("a c");
  });
});

describe("models", () => {
  test("labelFor returns Auto for null", () => {
    expect(labelFor(null)).toBe("Auto");
  });
  test("labelFor returns the label for a known id", () => {
    expect(labelFor("imagen")).toBe("Google Imagen");
  });
  test("labelFor falls back to Auto for an unknown id", () => {
    expect(labelFor("nope")).toBe("Auto");
  });
  test("MODELS includes the Auto and procedural options", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain(null);
    expect(ids).toContain("procedural");
  });
});

describe("aspect-ratios", () => {
  test("lists the three ratios in display order", () => {
    expect(ASPECT_RATIOS).toEqual(["1:1", "9:16", "16:9"]);
  });
});

describe("theme", () => {
  test("exposes token var() references", () => {
    expect(theme.colors.brand.primary).toBe("var(--color-brand-primary)");
    expect(theme.font.mono).toBe("var(--font-mono)");
  });
});
