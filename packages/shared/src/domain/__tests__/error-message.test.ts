import { describe, test, expect } from "vitest";
import { errorMessage } from "../error-message.js";

describe("errorMessage", () => {
  test("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("stringifies a non-Error value", () => {
    expect(errorMessage("kaput")).toBe("kaput");
    expect(errorMessage(42)).toBe("42");
  });
});
