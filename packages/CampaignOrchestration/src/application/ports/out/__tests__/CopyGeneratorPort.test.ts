import { describe, test, expect } from "vitest";
import { CopyGeneratorError } from "../CopyGeneratorPort.js";

describe("CopyGeneratorError", () => {
  test("carries the kind and message and is an Error", () => {
    const error = new CopyGeneratorError("network", "timed out");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CopyGeneratorError");
    expect(error.kind).toBe("network");
    expect(error.message).toBe("timed out");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  test("keeps retryAfterSeconds when the upstream supplied one", () => {
    expect(new CopyGeneratorError("rate_limited", "429", 12).retryAfterSeconds).toBe(12);
  });
});
