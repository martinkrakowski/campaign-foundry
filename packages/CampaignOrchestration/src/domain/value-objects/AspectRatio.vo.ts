import { ok, err, type Result } from "@campaignforge/shared";

export type AspectRatioValue = "1:1" | "9:16" | "16:9";

/** Canvas pixel dimensions per ratio (DeterministicLayerStacking contract). */
const DIMENSIONS: Record<AspectRatioValue, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};

/**
 * AspectRatio — immutable value object pairing a supported ratio with its
 * canvas dimensions. Compared by value.
 */
export class AspectRatio {
  private constructor(
    readonly value: AspectRatioValue,
    readonly width: number,
    readonly height: number,
  ) {}

  static create(value: string): Result<AspectRatio, Error> {
    if (!(value in DIMENSIONS)) {
      return err(
        new Error(`Unsupported aspect ratio "${value}" (expected one of 1:1, 9:16, 16:9)`),
      );
    }
    const v = value as AspectRatioValue;
    return ok(new AspectRatio(v, DIMENSIONS[v].width, DIMENSIONS[v].height));
  }

  /** Every supported ratio — the full set produced for each product. */
  static all(): AspectRatio[] {
    return (Object.keys(DIMENSIONS) as AspectRatioValue[]).map(
      (v) => new AspectRatio(v, DIMENSIONS[v].width, DIMENSIONS[v].height),
    );
  }

  /** Filesystem-safe form, e.g. "1x1" — colons are invalid in paths. */
  get slug(): string {
    return this.value.replace(":", "x");
  }

  equals(other: AspectRatio): boolean {
    return this.value === other.value;
  }
}
