import { normalizeHueTurns } from "@campaignfoundry/CampaignOrchestration";
import { createCanvas } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";
import { hexToRgb } from "./canvas-util.js";

/**
 * ProceduralBackgroundGenerator — ImageGeneratorPort adapter.
 *
 * Generates a deterministic diagonal gradient from the product's brand colour.
 * Runs fully offline — the GenAI-free default and the graceful fallback. Reuse of
 * a product's inputAsset is handled upstream by AssetReusingImageGenerator, so
 * this adapter has one job: synthesize a background.
 */
export class ProceduralBackgroundGenerator implements ImageGeneratorPort {
  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult> {
    return { image: this.generateGradient(product.primaryColor, ratio, context.paletteShift), source: "procedural" };
  }

  private generateGradient(primaryColor: string, ratio: AspectRatio, paletteShift?: number): Uint8Array {
    const canvas = createCanvas(ratio.width, ratio.height);
    const ctx = canvas.getContext("2d");
    const [r, g, b] = shiftRgb(hexToRgb(primaryColor), paletteShift);
    const gradient = ctx.createLinearGradient(0, 0, ratio.width, ratio.height);
    gradient.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
    gradient.addColorStop(
      1,
      `rgb(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(b * 0.35)})`,
    );
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ratio.width, ratio.height);
    return canvas.toBuffer("image/png");
  }
}

/** Hue-shift only when `paletteShift` is a non-zero finite number of turns (0..1 = one circle). */
function shiftRgb(rgb: [number, number, number], paletteShift?: number): [number, number, number] {
  if (typeof paletteShift !== "number" || !Number.isFinite(paletteShift) || paletteShift === 0) {
    return rgb;
  }
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  // Shared with the editor's swatch preview. The two used to wrap differently, so a
  // negative shift previewed as one colour and rendered as another.
  return hslToRgb(normalizeHueTurns(h + paletteShift), s, l);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}
