import { describe, test, expect } from "vitest";
import {
  DEFAULT_STYLE,
  resolveStyle,
  styleDiverges,
  type Style,
} from "../creative-style.js";

describe("DEFAULT_STYLE", () => {
  test("every default equals today's literal (D54)", () => {
    expect(DEFAULT_STYLE).toEqual({
      fontFamily: "Inter",
      sizeScale: 0.06,
      lineHeight: 1.25,
      letterSpacing: 0,
      align: "center",
    });
  });
});

describe("resolveStyle", () => {
  test("an absent style resolves every field to the defaults with the tone weight", () => {
    expect(resolveStyle(undefined, "500")).toEqual({
      fontFamily: "Inter",
      fontWeight: "500",
      sizeScale: 0.06,
      lineHeight: 1.25,
      letterSpacing: 0,
      align: "center",
    });
  });

  test("a styled weight overrides the tone-derived one", () => {
    expect(resolveStyle({ fontWeight: 400 }, "bold").fontWeight).toBe("400");
    expect(resolveStyle({ fontWeight: 700 }, "500").fontWeight).toBe("700");
  });

  test("a styled family overrides the deployment fallback family", () => {
    expect(resolveStyle({ fontFamily: "Lora" }, "bold", "Inter").fontFamily).toBe("Lora");
    expect(resolveStyle(undefined, "bold", "Lora").fontFamily).toBe("Lora");
    expect(resolveStyle({}, "bold", "Lora").fontFamily).toBe("Lora");
  });

  test("styled numeric fields override, absent ones fall to the leaf defaults", () => {
    const style: Style = { sizeScale: 0.08, lineHeight: 1.4, letterSpacing: 0.05, align: "left" };
    expect(resolveStyle(style, "bold")).toEqual({
      fontFamily: "Inter",
      fontWeight: "bold",
      sizeScale: 0.08,
      lineHeight: 1.4,
      letterSpacing: 0.05,
      align: "left",
    });
  });
});

describe("styleDiverges", () => {
  test("undefined and an empty block do not diverge", () => {
    expect(styleDiverges(undefined)).toBe(false);
    expect(styleDiverges({})).toBe(false);
  });

  test("a field equal to its default does not diverge", () => {
    expect(styleDiverges({ fontFamily: "Inter" })).toBe(false);
    expect(styleDiverges({ sizeScale: 0.06 })).toBe(false);
    expect(styleDiverges({ lineHeight: 1.25 })).toBe(false);
    expect(styleDiverges({ letterSpacing: 0 })).toBe(false);
    expect(styleDiverges({ align: "center" })).toBe(false);
  });

  test("any named weight diverges — absent means tone-derived, present means fixed", () => {
    expect(styleDiverges({ fontWeight: 400 })).toBe(true);
    expect(styleDiverges({ fontWeight: 700 })).toBe(true);
  });

  test("any field off its default diverges", () => {
    expect(styleDiverges({ fontFamily: "Lora" })).toBe(true);
    expect(styleDiverges({ sizeScale: 0.08 })).toBe(true);
    expect(styleDiverges({ lineHeight: 1.4 })).toBe(true);
    expect(styleDiverges({ letterSpacing: 0.05 })).toBe(true);
    expect(styleDiverges({ align: "left" })).toBe(true);
  });
});
