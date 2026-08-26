import { describe, test, expect, beforeEach } from "vitest";
import { getCapabilities, setCapabilities } from "../capabilities.js";

describe("capabilities", () => {
  beforeEach(() => {
    setCapabilities({ motion: false, reason: "not probed" });
  });

  test("defaults to motion off until a probe records an outcome", () => {
    expect(getCapabilities()).toEqual({ motion: false, reason: "not probed" });
  });

  test("setCapabilities replaces the stored snapshot", () => {
    setCapabilities({ motion: true });
    expect(getCapabilities()).toEqual({ motion: true });
    setCapabilities({ motion: false, reason: "missing binary" });
    expect(getCapabilities()).toEqual({ motion: false, reason: "missing binary" });
  });
});
