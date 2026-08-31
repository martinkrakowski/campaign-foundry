import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { CompliancePort, ComplianceResult } from "@campaignfoundry/CampaignOrchestration";

/** Prohibited promotional terminology — any hit fails the legal gate (ZeroToleranceLegalGate). */
const PROHIBITED_TERMS = [
  "guaranteed",
  "miracle",
  "cure",
  "risk-free",
  "100% safe",
  "no side effects",
  "clinically proven",
  "best in the world",
];

/** Escape regex metacharacters so the term list stays data, never a pattern — "100% safe" must not become a regex injection. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One anchored matcher per term, built once at module scope. The head is a
 * lookbehind over [a-z0-9], NOT \b: \b counts "_" as a word character, so no
 * boundary exists beside it and terms adjacent to an underscore slipped past
 * ("_guaranteed", "results_guaranteed", "a_miracle" were lost true positives).
 * What the gate actually wants is that the term is not preceded by a letter or
 * a digit — text is lowercased before matching, so the lookbehind expresses
 * exactly that: embedded substrings ("secure", "obscure", "procurement",
 * "manicure") still do not match because "cure" there is preceded by a letter,
 * while underscore-adjacent terms match again. The term may run on through
 * word characters, so inflections that extend it ("cure" → "cures", "cured")
 * still hit. Stem changes are not reached: "curing", "curative" are not
 * "cure" + suffix, so \w* cannot extend into them and they do not match. That
 * under-matching is unchanged from the previous matcher — a gap in the term
 * list, closed only by adding stems to PROHIBITED_TERMS (a product and legal
 * decision, out of scope here). No tail anchor: \w* is greedy through "_", so
 * a term followed by an underscore is over-matched and still halts — the safe
 * direction for a zero-tolerance gate; a tail lookahead could only turn that
 * into a miss ("cure_milk" escaping the gate).
 */
const PROHIBITED_PATTERNS = PROHIBITED_TERMS.map(
  (term) => [new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}\\w*`), term] as const,
);

/** A brand-colour pixel density below this fails the visual check (MinimumBrandColorDensity). */
const MIN_BRAND_COLOR_DENSITY = 0.02;
/** Per-channel tolerance (±) when matching a pixel to the target brand colour. */
const CHANNEL_TOLERANCE = 10;
/*
 * Density is sampled over the WHOLE creative. The compositor's brand-colour accent
 * band (a solid, full-width strip on the headline edge) guarantees a layout- and
 * ratio-invariant brand-colour floor (~5%), so whole-image sampling is a real
 * signal — not a height-relative guess that clipped/diluted on extreme ratios.
 *
 * This supersedes the earlier logo-box sampling: that measured brand colour via a
 * proxy (the logo, pinned top-right) and broke once layouts could move the logo.
 * Logo presence is its own signal (GeneratedAsset.logoApplied) — kept distinct
 * here so density measures density.
 */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * BrandComplianceChecker — CompliancePort adapter. The automated circuit breaker
 * for legal copy and visual brand adherence. Always returns a ComplianceResult;
 * never throws — the caller owns the halt decision.
 */
export class BrandComplianceChecker implements CompliancePort {
  async validateLegalCopy(text: string): Promise<ComplianceResult> {
    const lower = text.toLowerCase();
    const hits = PROHIBITED_PATTERNS.filter(([pattern]) => pattern.test(lower)).map(
      ([, term]) => term,
    );
    return hits.length > 0
      ? { passed: false, reason: `Prohibited terminology: ${hits.join(", ")}` }
      : { passed: true };
  }

  async validateBrandColorDensity(
    imageBuffer: Uint8Array,
    targetHex: string,
  ): Promise<ComplianceResult> {
    const [tr, tg, tb] = hexToRgb(targetHex);
    const image = await loadImage(Buffer.from(imageBuffer));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);

    const total = data.length / 4;
    let matched = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - tr) <= CHANNEL_TOLERANCE &&
        Math.abs(data[i + 1] - tg) <= CHANNEL_TOLERANCE &&
        Math.abs(data[i + 2] - tb) <= CHANNEL_TOLERANCE
      ) {
        matched++;
      }
    }

    // A decodable image always has ≥1 pixel; Math.max keeps the divide safe
    // without a dead total-zero branch.
    const score = matched / Math.max(total, 1);
    const passed = score >= MIN_BRAND_COLOR_DENSITY;
    return {
      passed,
      score,
      reason: passed
        ? undefined
        : `Brand-colour density ${score.toFixed(4)} is below the ${MIN_BRAND_COLOR_DENSITY} threshold`,
    };
  }
}
