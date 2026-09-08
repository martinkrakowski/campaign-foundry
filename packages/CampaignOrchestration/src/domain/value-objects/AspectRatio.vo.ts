import { ok, err, type Result } from "@campaignfoundry/shared";
import {
  RATIO_VALUES,
  nearestSocialRatio,
  resolveCanvas,
  type AspectRatioValue,
  type CanvasSpec,
} from "./aspect-ratios.js";

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
    const { width, height } = resolveCanvas({ ratio: v });
    return ok(new AspectRatio(v, width, height));
  }

  /** Every supported ratio — the full set produced for each product. */
  static all(): AspectRatio[] {
    return RATIO_VALUES.map((v) => {
      const { width, height } = resolveCanvas({ ratio: v });
      return new AspectRatio(v, width, height);
    });
  }

  /**
   * The social ratio a canvas spec resolves its background at (D113): a ratio
   * spec is itself; a display unit asks for the nearest social ratio's
   * orientation, so a leaderboard requests a wide background rather than a
   * square one. The background port speaks ratios only. Cannot fail — the
   * nearest ratio of a valid spec is always in the vocabulary — hence no
   * Result and no failure branch at the call sites.
   */
  static forBackground(spec: CanvasSpec): AspectRatio {
    const value = nearestSocialRatio(spec);
    const { width, height } = resolveCanvas({ ratio: value });
    return new AspectRatio(value, width, height);
  }

  /** Filesystem-safe form, e.g. "1x1" — colons are invalid in paths. */
  get slug(): string {
    return this.value.replace(":", "x");
  }

  equals(other: AspectRatio): boolean {
    return this.value === other.value;
  }
}
