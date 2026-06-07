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

/** A brand-colour pixel density below this fails the visual check (MinimumBrandColorDensity). */
const MIN_BRAND_COLOR_DENSITY = 0.02;
/** Per-channel tolerance (±) when matching a pixel to the target brand colour. */
const CHANNEL_TOLERANCE = 10;
/**
 * The compositor draws the brand logo width-relative: a `width * 0.16` box with a
 * `width * 0.04` margin, pinned top-right (see NodeCanvasCompositor). We sample
 * that same box — anchored the same way — so the density tracks the deterministic
 * brand layer across every aspect ratio, rather than a height-relative guess from
 * the top edge that clipped the logo on 16:9 and over-diluted it on 9:16. A GenAI
 * photo background may legitimately carry no brand colour anywhere else.
 */
const LOGO_BOX = 0.16; // compositor: target = width * 0.16
const LOGO_MARGIN = 0.04; // compositor: margin = width * 0.04

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
    const hits = PROHIBITED_TERMS.filter((term) => lower.includes(term));
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

    // Sample the compositor's logo box (top-right, width-relative) plus a small
    // slack for anti-aliased edges and taller logos, clamped to the canvas so
    // getImageData never reads out of bounds.
    const { width, height } = image;
    const span = Math.round(width * (LOGO_BOX + 2 * LOGO_MARGIN)); // ~0.24·width
    const regionX = Math.max(0, Math.round(width * (1 - LOGO_BOX - 2 * LOGO_MARGIN)));
    const regionY = Math.round(width * LOGO_MARGIN); // matches the compositor's y origin
    const regionW = Math.max(1, Math.min(span, width - regionX));
    const regionH = Math.max(1, Math.min(span, height - regionY));
    const { data } = ctx.getImageData(regionX, regionY, regionW, regionH);

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

    const score = total > 0 ? matched / total : 0;
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
