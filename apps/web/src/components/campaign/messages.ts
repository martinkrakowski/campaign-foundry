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
export const campaignNameLabel = "Campaign Name";
export const campaignNamePlaceholder = "e.g. Summer Launch";
export const briefIdReadout = "This is the brief id — made from the name";
export const briefIdCopy = "Copy";
export const briefIdCopied = "Copied ✓";
export const briefIdCopyAria = "Copy brief ID";
export const targetRegionLabel = "Target Region";
export const targetRegionOther = "Other…";
export const targetRegionOtherPlaceholder = "e.g. LATAM";
/** Names the free-text box the Other… chip reveals; the group label cannot name it. */
export const targetRegionOtherInputLabel = "Target Region — other";
export const targetAudienceLabel = "Target Audience";
export const targetAudiencePlaceholder = "e.g. urban outdoor enthusiasts, 25-40";

// --- Copy ---

/** `campaignMessage` */
export const campaignMessage = "No message yet — write the one line you want people to remember.";
/** `campaignMessage.length` */
export const campaignMessageTooLong = "Headline is longer than 60 characters — make it shorter.";
export const headlineLabel = "Headline";
export const headlinePlaceholder = "e.g. Stay wild. Stay hydrated.";
export function headlineCounter(current: number, max = 60): string {
  return `${current} / ${max}`;
}
export const localizedHeadlineLabel = "Localized headline (optional)";
export const localizedHeadlinePlaceholder = "e.g. Bleib wild. Bleib hydriert.";
export const extraHeadlines = "Extra headlines…";
export const extraHeadlinesAria = "Manage Headline Pool";
export const moreIdeas = "More ideas…";
export const moreIdeasAria = "Manage Headline Pool";
export const headlineSuggestionsLabel = "Suggestions";

// --- Products ---

/** `products` — `mode` is the display label ("Classic" / "Randomized"). */
export function products(min: number, mode: string): string {
  const need = min === 1 ? "at least one product" : "two different products";
  const add = min === 1 ? "one" : "a second one";
  return `A ${mode} campaign needs ${need} — add ${add} below.`;
}
export const productsClassicHint = "Classic mode needs two different products — add a second one below.";
export function productsHeading(count: number): string {
  return `Products (${count})`;
}
export const addProduct = "Add product";
export const productNameLabel = "Name";
export const productNamePlaceholder = "e.g. Hydra Bottle";
export const productIdLabel = "ID";
export const productIdPlaceholder = "e.g. hydra-bottle";
export const productIdReadout = "derived from name";
export const productIdEdit = "Edit";
export const productIdEditAria = "Edit product ID";
export const productColorLabel = "Primary Colour";
export const productColorPlaceholder = "#1473E6";
export const productLogoLabel = "Logo";
export const productRemove = "Remove";
export const productUploadErrorFallback = "Upload failed";
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

// --- Logo Field ---

export const logoUploadAria = "Upload product logo";
export const logoPathAria = "Logo Path";
export const logoPreviewAlt = "Product logo preview";
export const logoReplace = "Replace";
export const logoUploading = "Uploading...";
export const logoChooseFromBin = "Choose from bin";
export const logoEmpty = "No logo yet — upload a PNG or JPEG";
export const logoUpload = "Upload";

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
export const addPhotoPlatform = "Add a photo platform";
export const turnOnStillImages = "Turn on Still images";
export const shapesFromPlatforms = "from your platforms";


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

/**
 * The estimate as a sentence rather than a field dump (D2/D6): a first-timer should
 * learn what they are about to get without knowing what an "axis product size" is.
 * The ratio labels are display names — the raw values stay on the ratio panels (D18).
 */
export function estimateSentence(parts: {
  readonly creatives: number;
  readonly ratios: readonly { readonly label: string; readonly count: number }[];
  readonly products: number;
  readonly genaiCalls: number;
}): string {
  const ads = `${parts.creatives} ad${parts.creatives === 1 ? "" : "s"}`;
  const split =
    parts.ratios.length > 1
      ? ` — ${parts.ratios.map((r) => `${r.count} ${r.label.toLowerCase()}`).join(", ")} —`
      : "";
  const products = `${parts.products} product${parts.products === 1 ? "" : "s"}`;
  const ai =
    parts.genaiCalls === 0
      ? "No AI image calls."
      : `${parts.genaiCalls} AI image call${parts.genaiCalls === 1 ? "" : "s"}.`;
  return `You will get ${ads}${split} for ${products}. ${ai}`;
}

/** The estimate cannot be drawn yet, because the brief is not far enough along. */
export const estimateNotReady = "Fill in the brief and the estimate appears here.";
/** The estimate is being worked out. */
export const estimateWorking = "Working out what you will get…";
/** The planner could not be reached; the brief is unaffected. */
export const estimateUnavailable = "Cannot work out the estimate right now.";

/** The count slider's readout: what you asked for, against what the axes can make. */
export function countReadout(count: number, ceiling: number): string {
  return `${count} ad${count === 1 ? "" : "s"} · up to ${ceiling}`;
}

/**
 * Said once, when narrowing an axis leaves the requested count impossible. It reports
 * rather than blames: the number moved, and this is why.
 */
export function countLowered(ceiling: number): string {
  return `Lowered to ${ceiling} — that is every different ad these choices can make.`;
}

/** The four legends of the Output section, in the order a user meets them. */
export const outputPlatformsLegend = "Where will the ads run?";
export const outputFormatsLegend = "Formats";
export const outputMotionLegend = "Video styles";
export const outputDurationLegend = "Clip lengths";

/** What each format card says under its picture. */
export const formatStillMeta = "still · one frame";
export function formatMotionMeta(fps: number, min: number, max: number): string {
  return `clip · ${fps} fps · ${min}–${max} s`;
}

/** A Classic brief cannot produce video; the pipeline branches on mode alone. */
export const formatsMotionNeedsRandomizedMode =
  "Video needs a Randomized campaign — switch the mode, or turn Video off.";

/* ── The copy timeline (L6-E5) ───────────────────────────────────────────────── */

/** The sub-panel's own legend, inside the Copy section. */
export const timelineLegend = "Copy sequence";
/**
 * Said once, above the rows. The clip length is the *shortest* selected, because that is
 * the one the readability floor is measured against.
 */
export const timelineHelp = "Each beat holds the screen for its share of the clip.";
export const timelineEmpty = "No sequence — the headline holds the whole clip.";

export const timelineAddBeat = "Add beat";
/** Why *Add beat* is unavailable: adding one would leave a beat too brief to read. */
export function timelineAddBlockedFloor(shortestSec: number, floorSec: number): string {
  return `Another beat would leave one under ${floorSec}s on the ${shortestSec}s clip — too brief to read.`;
}
/** Why *Add beat* is unavailable: the sequence is already as long as a clip can carry. */
export function timelineAddBlockedMax(max: number): string {
  return `A sequence holds at most ${max} beats.`;
}

export function timelineBeatTextLabel(position: number): string {
  return `Beat ${position} text`;
}
export function timelineBeatWeightLabel(position: number): string {
  return `Beat ${position} share`;
}
export function timelineRemoveBeat(position: number): string {
  return `Remove beat ${position}`;
}
export function timelineMoveBeatUp(position: number): string {
  return `Move beat ${position} earlier`;
}
export function timelineMoveBeatDown(position: number): string {
  return `Move beat ${position} later`;
}
export const timelineBeatPlaceholder = "What this beat says";

/** The poster beat — the frame the still preview and the export thumbnail show. */
export const timelineKeyBeatLegend = "Poster frame";
export function timelineKeyBeatLabel(position: number): string {
  return `Show beat ${position} on the poster`;
}

export const timelineTransitionLegend = "Between beats";
export const timelineTransitionCut = "Cut";
export const timelineTransitionFade = "Fade";

/** The proportion bar's caption: which clip length its seconds are measured against. */
export function timelineProportionCaption(durationSec: number): string {
  return `${durationSec}s clip`;
}
/** One beat's dwell on one clip length, e.g. "1.8s". */
export function timelineDwell(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}
/** A beat whose dwell is under the floor on this clip length. */
export function timelineDwellUnderFloor(seconds: number, floorSec: number): string {
  return `${seconds.toFixed(1)}s — under the ${floorSec}s floor`;
}

/* ── Timeline problems, in the editor's voice (E5.5) ─────────────────────────── */

/**
 * These mirror `timelineProblem`'s conditions, not its wording. The domain's messages name
 * fields as a brief file spells them — `copy.timeline.beats[0].weight` — which is the right
 * thing to tell someone editing YAML and the wrong thing to put on screen (D2, D18).
 */
export function timelineTooManyBeats(max: number): string {
  return `A sequence holds at most ${max} beats — remove the extras to save.`;
}
export function timelineBeatWeightOutOfRange(position: number, max: number): string {
  return `Beat ${position}'s share must be a whole number between 1 and ${max}.`;
}
export const timelineKeyBeatMissing = "The poster points at a beat that is no longer there.";
/** A beat too brief to read on the shortest clip — the one the floor is measured against. */
export function timelineBeatUnderFloor(
  position: number,
  dwellSec: number,
  floorSec: number,
  shortestSec: number,
): string {
  return `Beat ${position} holds for ${dwellSec.toFixed(1)}s on the ${shortestSec}s clip — under the ${floorSec}s floor. Give it more share, or drop a beat.`;
}

/** Inserting approved copy into the sequence (E5.4). */
export const timelineInsertLegend = "Approved copy";
export function timelineInsertBeat(text: string): string {
  return `Add "${text}" as a beat`;
}

// --- Descriptors ---

/** `descriptor.beats` */
export function descriptorBeats(count: number): string {
  return `${count} ${count === 1 ? "beat" : "beats"}`;
}

/** `descriptor.headline` */
export function descriptorHeadline(text: string): string {
  return `"${text}"`;
}
