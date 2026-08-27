import { ok, err, type Result } from "@campaignfoundry/shared";
import { RATIO_DIMENSIONS, RATIO_VALUES, type AspectRatioValue } from "./aspect-ratios.js";

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
    if (!(RATIO_VALUES as readonly string[]).includes(value)) {
      return err(
        new Error(`Unsupported aspect ratio "${value}" (expected one of ${RATIO_VALUES.join(", ")})`),
      );
    }
    const v = value as AspectRatioValue;
    return ok(new AspectRatio(v, RATIO_DIMENSIONS[v].width, RATIO_DIMENSIONS[v].height));
  }

  /** Every supported ratio — the full set produced for each product. */
  static all(): AspectRatio[] {
    return RATIO_VALUES.map((v) => new AspectRatio(v, RATIO_DIMENSIONS[v].width, RATIO_DIMENSIONS[v].height));
  }

  /** Filesystem-safe form, e.g. "1x1" — colons are invalid in paths. */
  get slug(): string {
    return this.value.replace(":", "x");
  }

  equals(other: AspectRatio): boolean {
    return this.value === other.value;
  }
}
