import { ok, err, type Result } from "@campaignfoundry/shared";
import {
  RATIO_VALUES,
  nearestRatioForAspect,
  nearestSocialRatio,
  resolveCanvas,
  type AspectRatioValue,
  type CanvasSpec,
} from "./aspect-ratios.js";
import { resolveLayerFrame, type LayerFrame } from "./creative-geometry.js";

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
        new Error(
          `Unsupported aspect ratio "${value}" (expected one of ${RATIO_VALUES.join(", ")})`,
        ),
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
   * The social ratio a canvas spec resolves its background at (D113, D132): a
   * ratio spec is itself; a display unit asks for the nearest social ratio's
   * orientation, so a leaderboard requests a wide background rather than a
   * square one. The background port speaks ratios only. Cannot fail — the
   * nearest ratio of a valid spec is always in the vocabulary — hence no
   * Result and no failure branch at the call sites.
   *
   * **`groundFrame` is D132's region, settled (2026-09-21).** D132 proposed a
   * separate `region` field that would "drive generation as well as clipping".
   * D130's `frame` shipped first and is already that rect — the compositor
   * clips a generative ground to it through `layerPixelRect` — so a second
   * rect beside it would be the two-sources-of-truth defect D134 warns about.
   * The remaining half is this one: a ground that fills half the canvas should
   * not ask for a square picture.
   *
   * It borrows the nearest ratio rather than requesting the box's exact aspect,
   * because that is **the same answer this function already gives a display
   * size** — a 728×90 leaderboard asks for 16:9, not 728:90. An exact aspect
   * would need a vocabulary the port does not have and would move the
   * background cache key for every request, not just framed ones.
   *
   * The frame is resolved FOR THIS SPEC, so a `byFamily` override can make a
   * 300×250 cell answer differently from a 1:1 one. Absent, this is the
   * pre-D132 path exactly.
   */
  static forBackground(spec: CanvasSpec, groundFrame?: LayerFrame): AspectRatio {
    const rect = resolveLayerFrame(groundFrame, spec);
    if (rect === undefined) {
      const value = nearestSocialRatio(spec);
      const { width, height } = resolveCanvas({ ratio: value });
      return new AspectRatio(value, width, height);
    }
    const canvas = resolveCanvas(spec);
    const value = nearestRatioForAspect((rect.w * canvas.width) / (rect.h * canvas.height));
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
