/**
 * One voice, one file (D2): every user-facing error, warning, hint and status
 * string the brief editor can show, in the house style of DESIGN.md §Copy —
 * "<what is missing or wrong> — <the one thing to do>", naming the control the
 * user will touch. `validate.ts` and `page.tsx` import from here and never
 * define copy of their own; `messages.test.ts` enforces the jargon rules over
 * every string below.
 *
 * Formatters receive *display labels*, never raw values (D18): a format, ratio,
 * platform or mode is interpolated as "Still images", "Tall", "Instagram Reel",
 * "Randomized" — the caller converts via `display-names.ts`.
 */

// --- Identity ---

/** `briefId` */
export const briefId = "Brief ID can only use small letters, numbers and dashes — try something like summer-launch.";
/** `briefId.duplicate` */
export function briefIdDuplicate(conflictingId: string): string {
  return `A brief called ${conflictingId} already exists — pick a different Brief ID.`;
}
/** `targetRegion` */
export const targetRegion = "No region yet — pick one of the region chips.";
/** `targetAudience` */
export const targetAudience = "No audience yet — tell us who this campaign is for.";
/** `campaignMessage` */
export const campaignMessage = "No message yet — write the one line you want people to remember.";

// --- Products ---

/** `products` — `mode` is the display label ("Classic" / "Randomized"). */
export function products(min: number, mode: string): string {
  const need = min === 1 ? "at least one product" : "two different products";
  const add = min === 1 ? "one" : "a second one";
  return `A ${mode} campaign needs ${need} — add ${add} below.`;
}
/** `product-N-id` */
export const productId = "Product ID can only use small letters, numbers and dashes — try something like acrobat-pro.";
/** `product-N-id.duplicate` */
export function productIdDuplicate(id: string): string {
  return `Two products share the ID ${id} — give this one its own.`;
}
/** `product-N-name` */
export const productName = "This product has no name yet — type one in.";
/** `product-N-color` */
export const productColor = "That colour is not one we can read — pick it with the swatch, or type one like #1473E6.";
/** `product-N-logo` */
export const productLogo = "No logo yet — upload one with the Logo button.";

// --- Treatments ---

/** `treatment-N-id` */
export const treatmentId = "Treatment ID can only use small letters, numbers and dashes — try something like bold-hero.";
/** `treatment-N-id.duplicate` */
export function treatmentIdDuplicate(id: string): string {
  return `Two treatments share the ID ${id} — give this one its own.`;
}
/** `treatment-N-layout` */
export const treatmentLayout = "That layout is not one of the choices — pick one in the Layout panel.";
/** `treatment-N-tone` */
export const treatmentTone = "That tone is not one of the choices — pick one in the Tone panel.";

// --- Policy ---

/** `count` */
export const count = "Count is empty — set it to 1 or more with the Count slider.";
/** `seed` */
export const seed = "Seed needs a whole number — press Random, or leave it blank.";
/** `minDistance` */
export function minDistance(maxDistance: number): string {
  return `Min distance can be 0 to ${maxDistance} right now — move the Min distance slider back into that range.`;
}
/** `perProduct` */
export const perProduct = "Coverage per product needs a whole number — set it with the stepper, or leave it blank.";
/** `perRatio` */
export const perRatio = "Coverage per ratio needs a whole number — set it with the stepper, or leave it blank.";
/** `perRatio.exceeds` */
export function perRatioExceeds(drawableCount: number, floor: number, count: number): string {
  return `${drawableCount} ratios at ${floor} each need more creatives than your Count of ${count} — raise Count, or lower Coverage per ratio.`;
}
/** `ratio` */
export const ratio = "No aspect ratio picked — tap at least one shape.";
/** `ratio.noneDrawable.packaged` — `packaged` holds ratio display labels. */
export function ratioNoneDrawablePackaged(packaged: string[]): string {
  return `Video only comes in ${joinList(packaged)} for these platforms — pick one of those shapes, or turn on Still images too.`;
}
/** `ratio.noneDrawable.none` */
export function ratioNoneDrawableNone(): string {
  return "None of your platforms play video — turn on Still images, or add a platform that does.";
}
/** `ratio.excluded.packaged` — `motionRatios` holds ratio display labels. */
export function ratioExcludedPackaged(motionRatios: string[]): string {
  return `Not used for video — it only comes in ${joinList(motionRatios)}. Turn on Still images to use this shape too.`;
}
/** `ratio.excluded.none` */
export function ratioExcludedNone(): string {
  return "Not used for video — none of your platforms play video. Turn on Still images to use this shape.";
}
/** `layout` */
export const layout = "No layout picked — tap at least one layout card; you can pick them all.";
/** `tone` */
export const tone = "No tone picked — tap at least one tone card; Bold and Subtle can both be on.";
/** `background` */
export const background = "No background picked — tap at least one background card.";
/** `paletteShift` */
export const paletteShift = "No colour mood picked — tap at least one colour card.";

// --- Output ---

/** `formats` */
export const formats = "Nothing to make yet — turn on Still images, Video, or both.";
/** `platforms` */
export const platforms = "No platform picked yet — choose where these creatives will go.";
/** `platforms.incompatible` — `platform` is a display label; `formats` holds format display labels. */
export function platformsIncompatible(platform: string, formats: string[]): string {
  return `${platform} only takes ${formats.join(" or ")} — turn that on under Formats, or take the platform off.`;
}
/** `formats.unsupported` — `format` and `candidates` hold display labels. */
export function formatsUnsupported(format: string, candidates: string[]): string {
  return `None of your platforms can take ${format} — add one of ${joinList(candidates)}, or turn ${format} off.`;
}
/** `formats.motionUnavailable` — a fixed sentence: the probe's reason is server vocabulary. */
export const formatsMotionUnavailable =
  "Video cannot be made on this computer right now — your brief is safe to save and will run once video is set up.";
/** `formats.motionNeedsRandomized` */
export const formatsMotionNeedsRandomized =
  "Video only works in a Randomized campaign — switch the mode toggle to Randomized, or turn Video off.";

// --- Motion ---

/** `motion` */
export const motion = "No video style picked — tap at least one video card.";
/** `duration` */
export const duration = "No clip length yet — add one with the stepper, like 6 seconds.";
/** `duration.range` */
export function durationRange(min: number, max: number): string {
  return `Clip lengths must be whole seconds from ${min} to ${max} — change the one outside that range.`;
}
/** `duration.duplicate` */
export const durationDuplicate = "Two clip lengths are the same — remove one of them.";

// --- Status ---

/** `status.applied` */
export function statusApplied(briefId: string): string {
  return `Applied — press Generate in the top bar to make ${briefId}.`;
}
/** `status.applyRefusal` — applied, but the host cannot run video (its own string, not the field error). */
export const statusApplyRefusal =
  "Applied, but video cannot be made on this computer right now — Generate will wait until it is set up.";
/** `status.leavePrompt` */
export const statusLeavePrompt = "You have changes that are not saved yet — leave anyway?";
/** `status.saveFailed` */
export const statusSaveFailed = "Could not save — try Save again.";
/** `status.saveAsFailed` */
export const statusSaveAsFailed = "Could not save the copy — try Save as again.";

// --- Hints (defined here; wired into PolicySection by lanes L2/L4, who own that file) ---

/** `hint.count` */
export function hintCount(axisMax: number): string {
  return `How many creatives to make — up to ${axisMax} with what you have picked`;
}
/** `hint.minDistance` */
export function hintMinDistance(max: number): string {
  return `How different any two creatives must be — 0 means any two can match, ${max} means they differ in everything`;
}
/** `hint.seed` */
export const hintSeed = "Optional — keep the same number to get the same set of creatives every time";
/** `hint.perRatio` */
export const hintPerRatio = "Optional — make sure every shape gets at least this many";
/** `hint.perProduct` */
export const hintPerProduct = "Optional — make sure every product gets at least this many";

// --- Readouts (defined here; wired into PolicySection by lanes L2/L4, who own that file) ---

/** `readout.ratioFloor` */
export function readoutRatioFloor(
  drawableCount: number,
  floor: number,
  ratioFloorTotal: number,
  count: number,
  over: boolean,
): string {
  return `${drawableCount} shapes at ${floor} each use ${ratioFloorTotal} of your ${count} creatives${
    over ? " — that is too many; raise Count, or lower this" : ""
  }`;
}
/** `readout.ratioFloor.unset` */
export const readoutRatioFloorUnset = "Any amount";

// --- The floating bar's progressive sentence (D3) ---
// The section names inside these sentences are scroll-and-focus links, so the
// sentence is a lead/tail pair the StatusLine interleaves with link nodes —
// keeping the words here, in the one voice.

export interface SectionSentence {
  lead: string;
  tail: string;
}

export function statusNewBrief(): SectionSentence {
  return { lead: "New brief — fill", tail: " to make it runnable." };
}

export function statusAlmostThere(): SectionSentence {
  return { lead: "Almost there — fill", tail: " to make it runnable." };
}

export function statusNotApplied(errorCount: number): SectionSentence {
  return {
    lead: `Not applied — ${errorCount} ${errorCount === 1 ? "thing" : "things"} to fix in`,
    tail: `. Fix the marked ${errorCount === 1 ? "field" : "fields"}, or Save without applying.`,
  };
}

export const statusReady = "Ready — Apply to run, or Save & apply to keep it.";

export function statusLoaded(briefId: string): string {
  return `Loaded ${briefId} — Apply to run to stage it.`;
}

/** Join list items the way a sentence reads them: "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
