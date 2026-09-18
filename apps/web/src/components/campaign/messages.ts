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

// The leaf, never the barrel: the type vocabulary rides the same rule as the
// one `display-names.ts` spells out. Type-only, so nothing is pulled in at
// runtime by the file every other one imports.
import type { Frame } from "@campaignfoundry/CampaignOrchestration/html-element";

// --- Identity ---

/** `briefId` */
export const briefId =
  "Brief ID can only use small letters, numbers and dashes — try something like summer-spark.";
/** `briefId.duplicate` */
export function briefIdDuplicate(conflictingId: string): string {
  return `A brief called ${conflictingId} already exists — pick a different Brief ID.`;
}
/**
 * Save-as: the id field wants a slug while the user is thinking of a name, so the
 * slugified form of what they typed is offered as a click — never applied silently.
 */
export function saveAsIdSuggestion(slug: string): string {
  return `Try "${slug}" instead`;
}
/** `targetRegion` */
export const targetRegion = "No region yet — pick one of the region chips.";
/** `targetAudience` */
export const targetAudience = "No audience yet — tell us who this campaign is for.";
export const campaignNameLabel = "Campaign Name";
export const campaignNamePlaceholder = "e.g. Summer Spark";
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
/** Legal compliance warning for prohibited terminology in copy fields (R1). */
export function prohibitedTerminology(terms: readonly string[] | string): string {
  const list = Array.isArray(terms) ? terms : [terms];
  const named = joinList(list.map((term) => `"${term}"`));
  return `Contains prohibited ${list.length === 1 ? "term" : "terms"} ${named} — remove before generation.`;
}

// --- Products ---

/** `products` — `mode` is the display label ("Classic" / "Randomized"). */
export function products(min: number, mode: string): string {
  const need = min === 1 ? "at least one product" : "two different products";
  const add = min === 1 ? "one" : "a second one";
  return `A ${mode} campaign needs ${need} — add ${add} below.`;
}
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
export const productId =
  "Product ID can only use small letters, numbers and dashes — try something like acrobat-pro.";
/** `product-N-id.duplicate` */
export function productIdDuplicate(id: string): string {
  return `Two products share the ID ${id} — give this one its own.`;
}
/** `product-N-name` */
export const productName = "This product has no name yet — type one in.";
/** `product-N-color` */
export const productColor =
  "That colour is not one we can read — pick it with the swatch, or type one like #1473E6.";
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
export const treatmentId =
  "Treatment ID can only use small letters, numbers and dashes — try something like bold-hero.";
/** `treatment-N-id.duplicate` */
export function treatmentIdDuplicate(id: string): string {
  return `Two treatments share the ID ${id} — give this one its own.`;
}
/** `treatment-N-layout` */
export const treatmentLayout =
  "That layout is not one of the choices — pick one in the Layout panel.";
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
export const perProduct =
  "Coverage per product needs a whole number — set it with the stepper, or leave it blank.";
/** `perRatio` */
export const perRatio =
  "Coverage per ratio needs a whole number — set it with the stepper, or leave it blank.";
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
/** `anchor` */
export const anchor =
  "No anchor picked — tap at least one anchor card; Top, Middle and Bottom can all be on.";
/** `anchor.propConflict` (R-D4) */
export const anchorPropConflict =
  "A layer in this template already fixes its own anchor — clear it before picking anchor cards here; you can't set both.";
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
/**
 * `formats.outOfType` (X14) — `format` and `creativeType` both hold display
 * labels (fix2: the raw `image-text` id must never reach this copy). The
 * platform cards already hide what the type cannot ship; this names the
 * mismatch a loaded draft still carries.
 */
export function formatsOutOfType(format: string, creativeType: string): string {
  return `${format} is not something the ${creativeType} creative type can make — turn it off, or start the campaign from a type that ships ${format}.`;
}
/**
 * `platforms.unknown` — `ids` are the entries no platform matches (a loaded file can
 * carry one). There is no display label for an id we do not know, so the value itself
 * is named: it is the thing to find and remove.
 */
export function platformsUnknown(ids: string[]): string {
  const named = joinList(ids.map((id) => `"${id}"`));
  return ids.length === 1
    ? `${named} is not a platform these ads can run on — remove it under "Where will the ads run?".`
    : `${named} are not platforms these ads can run on — remove them under "Where will the ads run?".`;
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
/** `motion.kindUnknown` — the video-style list holds a kind the picker never offered (a loaded brief can). */
export const motionKindUnknown =
  "That video style is not one of the choices — pick again in the Video styles panel.";
/** `duration` */
export const duration = "No clip length yet — add one with the stepper, like 6 seconds.";
/** `duration.range` */
export function durationRange(min: number, max: number): string {
  return `Clip lengths must be whole seconds from ${min} to ${max} — change the one outside that range.`;
}
/** `duration.duplicate` */
export const durationDuplicate = "Two clip lengths are the same — remove one of them.";

// --- Status ---

/**
 * `status.applied` — the draft is committed (saved, or loaded from a file) and clean.
 * D35: "applied" no longer appears in rendered copy — committing and running are one
 * continuous story now, and the run verb is Generate, wherever it lives.
 */
export function statusApplied(briefId: string): string {
  return `Saved — press Validate, then Generate, to make ${briefId}.`;
}
/** `status.applyRefusal` — committed, but the host cannot run video (its own string, not the field error). */
export const statusApplyRefusal =
  "The brief is complete, but video cannot be made on this computer right now — Generate will wait until it is set up.";
/** `status.leavePrompt` */
export const statusLeavePrompt = "You have changes that are not saved yet — leave anyway?";
export const confirmDialogTitle = "Unsaved edits";
export const confirmDialogStay = "Stay";
export const confirmDialogLeave = "Leave";
/**
 * `status.replacePrompt` — the editor's own replace confirmation (D14). Revert and
 * the blank route's New brief both throw away unsaved work; the question is the
 * shell guard's, asked where the gesture stands rather than at a navigation.
 */
export const statusReplacePrompt = "You have changes that are not saved yet — discard them?";
/** The replace confirmation's confirm verb: the draft is thrown away. */
export const confirmDialogDiscard = "Discard changes";
/**
 * `saveAs.overwrite` — Save as… found the id taken (the listing knew, or the API's
 * 409 backstop said so). The overwrite is the user's decision, asked here, never
 * re-sent automatically.
 */
export const saveAsOverwriteTitle = "Overwrite brief?";
export function saveAsOverwritePrompt(id: string): string {
  return `A brief called ${id} already exists — overwrite it with this copy?`;
}
export const saveAsOverwriteConfirm = "Overwrite";
/** `status.saveFailed` */
export const statusSaveFailed = "Could not save — try Save again.";
/**
 * `status.saveConflict` — the conditional write was refused because the file
 * changed on disk since it was loaded. The fresh revision has been adopted, so a
 * second Save will answer the guard: the overwrite is the user's call, never an
 * automatic re-send.
 */
export const statusSaveConflict =
  "This brief changed on disk while you were editing — press Save again to keep your version and overwrite the other changes.";
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
export const hintSeed =
  "Optional — keep the same number to get the same set of creatives every time";
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
    lead: `Not saved yet — ${errorCount} ${errorCount === 1 ? "thing" : "things"} to fix in`,
    tail: `. Fix the marked ${errorCount === 1 ? "field" : "fields"}, then Save.`,
  };
}

// SG-D10 moved the run verb out of the top header and into this bar, so the three
// sentences that named its old home name the slot beside them instead — and they name
// Validate first, because SG-D11 puts that verb in the slot until the document has
// validated clean.
export const statusReady = "Ready — Save to keep it, or press Validate to check it first.";

export function statusLoaded(briefId: string): string {
  return `Loaded ${briefId} — press Validate, then Generate, to run it.`;
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
  /**
   * VE5b2 — present only when the plan's timeline names a background
   * (`VariationEstimate.sceneBackgrounds`, set by a conditional spread that never
   * writes `false`). Read with `=== true`, not truthiness: the API never sends
   * anything else, but a malformed payload's value survives `isEstimate`
   * unvalidated (`briefs-api.ts`, same as the pre-existing `frames` field), so a
   * stray `false` or non-boolean must not read as "on".
   */
  readonly sceneBackgrounds?: true;
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
  const scene =
    parts.sceneBackgrounds === true
      ? " Backgrounds come from your uploaded images, so they add nothing."
      : "";
  return `You will get ${ads}${split} for ${products}. ${ai}${scene}`;
}

/** The estimate cannot be drawn yet, because the brief is not far enough along. */
export const estimateNotReady = "Fill in the brief and the estimate appears here.";
/** The estimate is being worked out. */
export const estimateWorking = "Working out what you will get…";
/** The planner could not be reached; the brief is unaffected. */
export const estimateUnavailable = "Cannot work out the estimate right now.";

// --- The Sections outline (D25) ---

/** The sidebar group's legend above the numbered rows. */
export const outlineLegend = "Sections";
/** The aside: no issues, or how many things across the draft a visitor still has to fix. */
export function outlineIssueCount(count: number): string {
  return count === 0 ? "No issues" : `${count} ${count === 1 ? "thing" : "things"} to fix`;
}

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
/** More distinct per-beat backgrounds than a timeline may name (VE-D10). */
export function timelineTooManyBackgrounds(max: number): string {
  return `A sequence names at most ${max} different backgrounds — reuse one or remove the extras to save.`;
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

// --- Creative preview (W9) ---

/** The dock/rail's legend. */
export const previewLegend = "Preview";
/** The preview's caption when no platform has been picked yet. */
export const previewNoPlatform = "no platform yet";
/** The preview's caption — ratio and platform are display labels, never raw values (D18). */
export function previewCaption(ratioLabel: string, platformLabel: string): string {
  return `${ratioLabel} · ${platformLabel}`;
}
/**
 * The preview's caption when the creative moves (D50): the style names itself in
 * words — `MOTION_KIND_META`'s display labels, never a raw kind id (D18) — so the
 * reading is not the only carrier of the meaning.
 */
export function previewCaptionMotion(
  ratioLabel: string,
  platformLabel: string,
  styleLabel: string,
): string {
  return `${ratioLabel} · ${platformLabel} · ${styleLabel}`;
}
/**
 * The step caption when the template carries a text effect (T6, the D50
 * pattern): the frame is a still — the effect's rest pose — so its NAME is what
 * says the delivered video animates. A display label via `TEXT_EFFECT_META`,
 * never a raw kind id (D18).
 */
export function previewCaptionTextEffect(
  ratioLabel: string,
  platformLabel: string,
  effectLabel: string,
): string {
  return `${ratioLabel} · ${platformLabel} · ${effectLabel}`;
}
/**
 * D142 — the rail's empty state before the first product has an id: names
 * the missing field, never "add a product" (the Products step already shows
 * one stub) and never a fabricated placeholder creative (D26).
 */
export const previewNeedsProductId =
  "The first product has no ID yet — name it on the Products step to see its preview.";

// --- The middle column's views (SG-D4) ---

/**
 * SG4 — the switcher's group label. It used to read "Preview views" and sat
 * inside the rail, naming what the RAIL showed; SG-D4 moves the one switch onto
 * the middle column, so the name had to move with it or the control would
 * announce the wrong surface to a screen reader. The rail is preview-only now
 * and has no switcher to label.
 *
 * Review proposed "Column view selector" and it is declined on §6.3 (no jargon):
 * "column" and "selector" are words for the app's own layout and widgets, not for
 * anything the operator has a name for — this string is read aloud, and what a
 * screen-reader user needs is the surface it controls. "Editor views" is also the
 * one-word edit to the name it replaced ("Preview views"), which is what keeps the
 * lineage legible to a returning operator.
 */
export const columnViews = "Editor views";
/** The first segment: the brief's form, which is what the column normally is. */
export const columnEditorView = "Show the editor";
/** The second segment: the document the pipeline reads, as the projection writes it. */
export const columnYamlView = "Show the YAML view";
/**
 * SG10 — the third segment (SG-D13), the one SG4 deliberately withheld until the
 * view existed. Spelled like its two siblings ("Show the …") because the three are
 * read in a row by anything announcing the group, and a segment that broke the
 * pattern would sound like a different kind of control.
 */
export const columnValidateView = "Show the validation";

// --- The validation view (SG10 / SG-D13, SG-D14) ---

/**
 * The panel's heading. Not "Validation errors": the panel is what the operator
 * reads when the document is CLEAN as well, and a heading that names only the
 * failure would make a passing document look like an empty error list.
 */
export const validationViewTitle = "Validation";

/**
 * The refresh control's accessible name (SG-D14). It names the ACT — re-running
 * the validation — and not the icon, because an icon-only control has no text of
 * its own; and it is the same verb the toolbar's `Validate` carries, because it is
 * literally the same handler.
 */
export const validationRefresh = "Re-run the validation";

/** The Copy control's resting name, matching the drawer's phrasing for its own log. */
export const validationCopy = "Copy the validation report to clipboard";

/**
 * Clean, and the operator has said so — `isValidationFresh` holds, so the toolbar
 * is offering Generate.
 *
 * The pair below is red fault 5: "no problems" and "nobody has looked yet" are two
 * different facts and this repo has collapsed them before. Both sentences open with
 * the same finding (the view is LIVE, so it always reports the current document) and
 * differ on what the gate knows — which is the half a live view cannot show on its
 * own.
 */
export const validationCleanValidated = "No problems found. This document is validated.";

/** Clean, but nobody has pressed Validate — the gate is shut and Generate is absent. */
export const validationCleanUnvalidated =
  "No problems found. Press Re-run the validation to validate this document.";

/**
 * The jump chips' group label. The rows of the panel are plain text — a
 * `LogPanelEntry.message` is a `string` rendered in a bare `<span>`, so a row
 * cannot BE a control without changing LP1's type, which this lane consumes
 * rather than edits. The per-section chips are the reveal affordance the editor
 * already has (F6's `JumpStrip` via `ErrorStrip`), so the view wears that rather
 * than inventing a second navigation concept.
 */
export const validationJumps = "Jump to a section with errors";

// --- The column resizer (SG2) ---

/**
 * The separator between the shell row's middle column and the preview rail. It
 * names the ACTION and the column it moves, because that is all a keyboard user
 * has: the control is a 4px line with no visible label of its own.
 */
export const previewColumnResize = "Resize the preview column";

// --- Theme (W3) ---

/**
 * The theme toggle's name while the app is dark. It names the *action*, not the state:
 * "Light theme" would leave a screen reader announcing where the user already is, and
 * the control would need a second mechanism to say what a press does.
 */
export const themeToLight = "Switch to the light theme";
/** The theme toggle's name while the app is light. */
export const themeToDark = "Switch to the dark theme";

// --- The editor's run slot (SG-D10 … SG-D12, SG-D22) ---

/**
 * The run verb. SG-D10 took it out of the top header — the owner's retraction of a
 * placement made in error — and put it in the editor's own action bar, following the
 * grid toolbar's pattern (`CommandBar`): never disabled, and a credit-spending
 * confirm before it runs.
 *
 * SG-D11: it shares one slot with `editorValidate`, and only one of the two is ever
 * on screen. Generate renders exactly while the stored validation is fresh, so the
 * slot is never a dead button — it changes verb.
 */
export const generate = "Generate";
/**
 * SG-D11's other verb, in the same slot: shown until the operator has seen this
 * document validate clean. Pressing it is the consent step, not a computation —
 * `validateState` is pure and synchronous and there is no server validation, so
 * nothing is being "run"; what the press records is that the operator looked.
 */
export const editorValidate = "Validate";
export const confirmCancel = "Cancel";

/* ── Generate's credit-spending confirm (SG-D10, after CommandBar.tsx:164) ── */

/**
 * The grid toolbar's confirm is the reason its run verb is safe, so the editor's
 * copies it rather than running on a single click. SG8 adds the pre-flight figures
 * (creatives, layers, platforms) to this dialog; this lane ships the warning without
 * them, because a count the editor guesses is worse than none.
 */
export const generateConfirmTitle = "Run the entire pipeline?";
export const generateConfirmPrompt =
  "This makes every creative the brief asks for and may consume GenAI quota/credits. It runs the brief exactly as it appears here.";

/* ── The brief routes (D37) ── */

/**
 * `brief.notFound` — a route id that names no brief (M3): the empty state names the
 * id the URL carried, never a silent new draft, and the two links below are the ways
 * out (the grid, or a new brief).
 */
export function briefNotFound(id: string): string {
  return `There is no brief called ${id} — it may have been deleted, or the link is wrong.`;
}
export const briefNotFoundGrid = "Back to the grid";
export const briefNotFoundNew = "Start a new brief";

/* ── The editor's action-bar verbs (D35/D40) ── */

/** The bar's primary verb: one press writes the file, and the shell runs what was written (D35 — every persist path applies). */
export const editorSave = "Save";
/** The copy verb, in the overflow (⋯): the same, under a new id. */
export const editorSaveAs = "Save as…";
/**
 * SG10-b — the overflow item that opens the YAML view, which used to be a segment
 * of the switcher. It is the only item in the `⋯` that is a navigation rather than
 * a write, so it sits first.
 *
 * Named for what the view IS rather than for the act of opening it ("Show the
 * YAML view" is the switcher's old aria-label, and it reads as an instruction in a
 * menu of nouns-and-verbs). The owner's sentence is the definition: *"the yaml view
 * displays the code configuration for the creative and is only intended for
 * importing and exporting the configuration"* — so the item names the
 * configuration, and leads with the word an operator scans for.
 */
export const editorYamlItem = "YAML configuration";
/**
 * D40: the exit verb. It leaves the editor for the grid, prompting through the dirty
 * guard when there is unsaved work — the prompt the user's report asked for.
 */
export const editorCancel = "Cancel";
/**
 * D40: the destructive verb, split out of the old Discard. It restores the last
 * saved state and asks first, through the same confirmation every other replace
 * path uses.
 */
export const editorRevert = "Revert";
/**
 * The header's telemetry control. It opens a panel rather than performing an action on
 * a draft, so the name names the panel — it never trips the unsaved-changes guard.
 */
export const telemetryButton = "System telemetry";
/**
 * Said when the image model changes: the choice has no visible effect until the next
 * run, so the header states what that run will use (D2's "<what is missing or wrong> —
 * <the one thing to do>" shape, here a plain statement of what is now true).
 */
export function modelChanged(modelLabel: string): string {
  return `${modelLabel} will make the next set of creatives.`;
}

/* ── The Layout section (T7) ─────────────────────────────────────────────── */

/**
 * The Effect row's no-effect chip face (T6): the absent field, which names
 * itself. The raw vocabulary has deliberately no "none" member — absence is
 * the default — so this is the one display label with no kind behind it.
 */
export const styleEffectNone = "None";

/**
 * The size slider's readout (D55): the type size is stored as a fraction of the
 * canvas width, and DISPLAYED as the pixels it means at the previewed ratio —
 * derived text, never the stored fraction.
 */
export function styleSizeReadout(pixels: number, ratioLabel: string): string {
  return `~${pixels} px at ${ratioLabel}`;
}

/* ── The step segbar and the step gestures (W7) ───────────────────────────── */

/** The segbar's own name: it is the step walk, in one row. */
export const segBarLabel = "Steps";

/** Where a segment stands — the four states a segment is painted in (WIZ-10). */
export type SegBarState = "current" | "done" | "issues" | "unvisited";

const SEG_BAR_STATE: Record<SegBarState, string> = {
  current: "current step",
  done: "done",
  issues: "has something to fix",
  unvisited: "not filled in yet",
};

/**
 * One segment's name (WIZ-13). A segment is a bare bar, so its label has to carry
 * everything a visitor with sight reads off the heading above it: where the step
 * sits in the walk, what it is called, and where it stands.
 */
export function segBarSegment(
  position: number,
  total: number,
  label: string,
  state: SegBarState,
): string {
  return `Step ${position} of ${total}: ${label}, ${SEG_BAR_STATE[state]}`;
}

/**
 * T2 (template plan, F6): the lock-or-vary semantics of a variation axis, spoken.
 * The min-one guard means a single selected value IS the lock — the planner draws
 * only that value for every variant — but nothing on the cards said so.
 */
export function axisLocked(value: string): string {
  return `Locked — every creative uses ${value.replace(/-/g, " ").trim()}.`;
}
export function axisVaries(count: number): string {
  return `Varies — each creative gets one of the ${count} selected.`;
}

/* ── The orchestrator bar's Execute answer (H2) ──────────────────────────────── */

/**
 * Execute pressed while the estimate is still being worked out — or hung. The confirm
 * spends credits, so it is not opened on a guess; pressing again later answers
 * differently once the estimate lands (or times out).
 */
export const executeStillEstimating =
  "Still working out the estimate — press Execute again in a moment.";
/**
 * The estimate could not be worked out (or gave up waiting). It is advisory only:
 * the run may still go, and the server refuses an impossible one. Said while the
 * confirm opens, so the user knows what pressing on means.
 */
export const executeNoEstimate =
  "Couldn't work out the estimate — the run will still go, and the server will refuse it if the plan is impossible.";

/* ── The header's model selector ─────────────────────────────────────────────── */

/** The trigger's tooltip; assistive tech reads it as the control's name too. */
export const modelSelectorTriggerTitle = "Change image model";
/** The modal's accessible name. */
export const modelSelectorDialogLabel = "Select image model";
/** The modal's heading. */
export const modelSelectorHeading = "Image model";
/** The modal close button's accessible name. */
export const modelSelectorClose = "Close";
/**
 * The modal footer: the selected model is a preference, never a dependency — the
 * fallback chain (models.ts) means a dead model does not block a run.
 */
export const modelSelectorFallbackNote =
  "Selected model is the primary; the pipeline falls back automatically if it's unavailable.";
/** The pill beside the trigger when a product carries an input asset the run may reuse. */
export const modelReuseNote = "reuse brief · model may be skipped";
export const modelReuseNoteAria =
  "Reuse brief: a product sets inputAsset, so the selected image model may be skipped for it. A missing or unreadable asset falls back to model generation.";
export const modelReuseNoteTitle =
  "This brief sets inputAsset on a product. When that image resolves, it's reused and the selected model is skipped for that product; a missing or unreadable asset falls back to model generation.";

// --- Real-frame preview (T1b) ---

/**
 * The preview caption's stand-in suffix (D52): while the brief's background axis
 * asks for a generated or pooled source, the frame the compositor draws here
 * carries a procedural stand-in background, and the caption must say so — the
 * preview can never imply an image the run will not deliver. Axis ids stay out
 * of the copy (D18); a procedural brief gets no suffix, because its frame IS the
 * real background.
 */
export const previewFrameStandInBackground = "background is a stand-in until the run";

/* ── The create dialog (W1 / D65–D67) ─────────────────────────────────────── */

/** The dialog's title — it is the Identity step in a door (D66). */
export const createCampaignTitle = "Create a campaign";
/** The mode field's label, over the two mode cards the editor opens with. */
export const createModeLabel = "Campaign mode";
/** The dialog's primary verb, in the foot beside Cancel. */
export const createCampaignConfirm = "Create campaign";
/**
 * `campaignName.required` — the dialog's one new refusal: the Identity step's only
 * name sentence is about the slug (a rule and a value this dialog never shows — D65),
 * so the missing name gets its own sentence in the house voice.
 */
export const campaignNameRequired = "No name yet — give the campaign a name.";
/**
 * `create.storageBlocked` — the seed write was refused (private window, quota,
 * disabled store). The dialog stays open and says so; nothing was published.
 */
export const createCampaignBlocked =
  "Could not create the campaign — this window cannot keep the answers. Try Create campaign again in a regular window.";
/**
 * W3 (F19) — the two-way the create dialog asks before a seed overwrites an
 * abandoned draft. Its own question inside its own dialog, never the navigation
 * guard's: the guard speaks about the editor the user is leaving, this one about
 * the draft the seed would replace.
 */
export const resumeDraftTitle = "Resume your draft?";
export const resumeDraftQuestion =
  "An earlier session left an unfinished brief behind. Resume it, or overwrite it with the new campaign?";
/** The two-way's protective answer: open the abandoned draft, publish nothing. */
export const resumeDraftResume = "Resume draft";
/** The two-way's proceed answer: the create the user originally asked for. */
export const resumeDraftStartOver = "Start over";

/* ── Start from an existing campaign (W2 / D71) ───────────────────────────── */

/** The picker's label, over the source list and its blank default row. */
export const startFromExistingLabel = "Start from an existing campaign";
/**
 * The default row — no source chosen. A blank create is the common case, so it is
 * the selection the dialog opens with, not a choice the user must make.
 */
export const startFromExistingBlank = "Start from a blank campaign";
/** While the source list is on its way. */
export const startFromExistingLoading = "Loading campaigns…";
/** An empty store is not an error: it means this create will be the first campaign. */
export const startFromExistingEmpty = "No campaigns yet — this create will be the first one.";
/** The list could not be read (M3: name the fact, offer the way out). */
export const startFromExistingError =
  "Could not load the campaign list — nothing can be started from right now. Close this window and try again.";
/** One row's meta line: products, treatments and region, exactly as the brief picker derives them. */
export function startFromRowMeta(
  productCount: number,
  treatmentCount: number,
  region: string,
): string {
  return `${productCount} product${productCount === 1 ? "" : "s"} · ${treatmentCount} treatment${treatmentCount === 1 ? "" : "s"} · ${region}`;
}
/**
 * The mode field becomes this sentence while a source is chosen: the copy inherits
 * the source's mode (the duplicate route refuses a mode override, for a reason it
 * documents), and the wizard can change it. A sentence, never a disabled toggle —
 * DESIGN.md §5 lets only work in flight disable a control.
 */
export function createModeInherited(mode: string): string {
  return `This copy starts as a ${mode} campaign — change it in the wizard.`;
}
/**
 * `create.duplicate.conflict` — the derived name already names a campaign (a 409).
 * Distinct from `createCampaignBlocked`, whose private-window story is false here.
 */
export const createCampaignDuplicateConflict =
  "A campaign with that name already exists — change the campaign name and create again.";
/** Any other refused duplicate (a server failure, a dropped connection): nothing was created. */
export const createCampaignDuplicateFailed =
  "Could not start from the chosen campaign — nothing was created. Try again.";

/* ── The create dialog's numbered sections (W1 / D86) ─────────────────────── */

/** `01` — region and audience, the two answers that say who the campaign is for. */
export const createSectionTargeting = "Targeting";
export const createSectionTargetingHint = "Pick where the campaign runs, and say who it is for.";
/** `02` — the start-from picker's section: blank, or an existing campaign's copy. */
export const createSectionStartFrom = "Start from";
export const createSectionStartFromHint = "Begin blank, or pick an existing campaign to copy from.";
/** `03` — the mode panel's section: one design, or a set of variations. */
export const createSectionMode = "Mode";
export const createSectionModeHint =
  "Classic makes one design; Randomized makes a set of variations.";

/* ── A campaign listing that failed (D83 / F-A) ──────────────────────────── */

/**
 * `brief.listFailed` — the campaign list could not be read, which says nothing
 * about whether the route's brief exists (D83: a failed read is never presented
 * as an empty result, and never answered with "start a new brief" — that remedy
 * invites a duplicate of a campaign that may be fine). The way out is the retry
 * beside it, in the same voice the not-found state names its id.
 */
export function briefListFailed(id: string): string {
  return `The campaign list could not be read, so it is not known whether a brief called ${id} exists — nothing has been changed.`;
}
/** The failed listing's way out: re-read the store where the user is standing. */
export const briefListFailedRetry = "Try again";

/* ── The create dialog's inline discard guard (W2(a) / D90) ───────────────── */

/**
 * The guard's question. It replaces the footer's button row in place when a
 * close gesture (Cancel, Escape, the scrim, the head's close) lands on a draft
 * with work in it — a cancelled create still leaves nothing behind (D67), it is
 * now confirmed rather than implicit.
 */
export const discardGuardTitle = "Discard this draft?";
/**
 * The guard's protective answer: the guard comes down and every typed answer
 * is exactly where the user left it.
 */
export const discardGuardKeepEditing = "Keep editing";
/** The guard's destructive answer: the one control that may destroy the draft. */
export const discardGuardDiscardClose = "Discard and close";
/**
 * The guard's detail line names what would actually be dropped — the draft's
 * own answer set, never a generic sentence. Type is deliberately absent: it has
 * a default the user may never have touched, so it is not work in the draft
 * (D90). A formatter rather than a fixed string because the sentence is only
 * honest when it lists the answers that are really filled in. The part string
 * is an exported const so the jargon gate scans it; the formatter composes from
 * that, never from a literal of its own. Region, audience and source left with
 * the fields; the dialog is the only caller, so the signature is `(hasName)`.
 */
export const discardGuardPartName = "a name";
export function discardGuardDetail(hasName: boolean): string {
  const parts = [hasName ? discardGuardPartName : null].filter(
    (part): part is string => part !== null,
  );
  return `Closing now discards ${joinList(parts)} from this draft.`;
}

/* ── G3 — start-from rail ─────────────────────────────────────────────────── */

/**
 * The mono corner caption on the blank card's preview panel: three dashed
 * frames holding nothing, because nothing has been made yet.
 */
export const startFromBlankCaption = "Empty";
/**
 * One brief card's corner caption: how many ratios its creatives render at.
 * A count, never the raw ids — D18, and the mockup's own `3 ratios` readout.
 */
export function startFromRatioCaption(ratios: readonly string[]): string {
  const count = ratios.length;
  return `${count} ${count === 1 ? "ratio" : "ratios"}`;
}
// G2 — mode tiles

/**
 * The mode tile's classification word — the pill beside the name (the mockup's
 * tag). Not format words (the mockup's STILLS / CLIPS lie about a mode): the
 * honest pair is how the set relates to the design.
 */
export const modeTileTagBrief = "Uniform";
export const modeTileTagVariation = "Varied";
/** The mode tile's one-sentence body: what the mode produces. */
export const modeTileBlurbBrief = "One design for the whole set — every creative matches.";
export const modeTileBlurbVariation =
  "A set of creatives, each a different take on the same brief.";
/** The mode tile's preview panel caption, in its bottom-right corner. */
export const modeTileCaptionBrief = "one design";
export const modeTileCaptionVariation = "six variations";

/* ── M2 — the map in the dialog ───────────────────────────────────────────── */

/**
 * The map footprint's display name, keyed by `REGION_OPTIONS` value. The kit owns
 * geometry, not copy (D94 as review corrected it on #207) — the dialog supplies
 * `labelFor` from here, so the names leave the kit and live in the one voice.
 * An exported record, not literals at the call site, so the jargon gate scans it.
 */
export const regionDisplayNames: Readonly<Record<string, string>> = {
  GLOBAL: "Global",
  EU: "Europe",
  DE: "Germany",
  UK: "United Kingdom",
  US: "United States",
  APAC: "Asia-Pacific",
};
/** A region value's display name; a value outside the table names itself. */
export function regionDisplayName(value: string): string {
  return regionDisplayNames[value] ?? value;
}
/**
 * The map's visually-hidden fallback hint: the SVG is `aria-hidden` and the chips
 * remain the accessible and keyboard control (D94), so a screen reader is told
 * where the same choice is really made.
 */
export const worldMapFallbackHint =
  "The map is a pointer view only — or use the chips below to pick the region.";
/**
 * The map's visible hint, written against F2 and deliberately against the mockup:
 * the region reaches generation only as prompt text — it shapes the generated
 * backgrounds and copy, and nothing dispatches or fans out per region (D94).
 */
export const worldMapRegionHint = "The region shapes the generated backgrounds and copy.";

/* ── S4 — the mode flip's dropped format (D99/F1) ─────────────────────────── */

/**
 * Said in a `role="status"` line beside the mode tiles while Classic still
 * holds the Video format the run paths refuse. Derived from
 * `mode === "brief" && formats.includes("motion")` — no latch. The copy names
 * the remedy: the mode that can carry Video again (D99).
 */
export const modeDroppedVideo =
  "Switching to Classic turned Video off — switch back to Randomized to turn it on again.";

// T3 — the two-field create

/**
 * The two-line lead under the create dialog's title (T3): name and type, then
 * the editor.
 */
export const createCampaignLead =
  "Give the campaign a name and pick a type. Create opens the editor so you can fill in the rest.";
/** The type field's group label, over the three type tiles. */
export const createTypeLabel = "Campaign type";
/**
 * One line on each type tile: how many platforms the preset seeds, and which
 * formats, as display words the caller already converted (D18). Never a raw
 * format id — the jargon gate forbids those here.
 */
export function typeTileGives(platformCount: number, formats: string): string {
  return `${Number(platformCount) || 0} platforms · ${formats}`;
}
/**
 * D110 — the short-video tile's extra line: the type must run as Randomized or
 * the API refuses it. `mode` is the display word (`modeDisplayName("variation")`).
 */
export function typeTileRunsAs(mode: string): string {
  return `Runs as a ${mode} campaign.`;
}
/**
 * A5 (D117/D116) — the display-ad tile's extra line: the display placements the
 * preset seeds, as display words the caller already converted (D18). Never a
 * raw platform id — the jargon gate forbids those here.
 */
export function typeTilePlacements(placements: string): string {
  return `Runs on ${placements}.`;
}

/* ── The Template step (L5, D124) ─────────────────────────────────────────── */

/**
 * The ordered layer list's name, said above it and used as its accessible
 * name: the order is the depth of the picture, bottom first (D128).
 */
export const templateListLabel = "Layers, bottom first";

/**
 * Why some layers carry no remove control (D124): the kinds every creative of
 * this type is made of — display names the caller already converted (D18).
 * One sentence, said once under the list.
 */
export function templateRequiredNote(names: string[]): string {
  return `${joinList(names)} ${names.length === 1 ? "is" : "are"} part of every creative and cannot be removed.`;
}

/** The add row's group name. */
export const templateAddLabel = "Add a layer";

/**
 * A row's select control (CC3, D139): the same D18 contract as every other
 * control in the stack — the accessible name is the raw layer id and the words
 * live here. "Pick" rather than "select": the selection is ephemeral editor
 * state, not a field of the document, so nothing about it is saved.
 */
export function layerSelectDescription(name: string): string {
  return `Pick ${name}`;
}

/**
 * A hit region on the creative itself (CE1): the same D18 contract again — the
 * region's accessible name is the raw layer id, and these are the words that
 * say which layer it is and which of that layer's elements sits here. It reads
 * "Pick" for the same reason the row's does: the two controls are one selection
 * reached two ways, and neither writes a document byte (D139).
 */
export function previewRegionDescription(layerName: string, elementName: string): string {
  return `Pick ${layerName} — its ${elementName} element`;
}

/**
 * The Template step, after CC3 moved the stack into the creative rail: the step
 * says where its controls went rather than going quiet. The stack itself is
 * mounted exactly once (the plan's §4.6), so this is a pointer, never a second
 * copy of the offers.
 */
export const templateStackInRail =
  "Layers are edited beside the creative, in the preview rail: pick one, hide it, reorder it, add or remove.";

/**
 * The heading over one html layer's element editor, now that the editor no
 * longer rides inside that layer's stack row and cannot borrow the row's
 * context. The layer's raw id, because that is what the rail's row shows and
 * what the brief carries — a display name would name the kind, of which a
 * template may hold several.
 */
export function templateHtmlLayerLabel(layerId: string): string {
  return `Elements of layer ${layerId}`;
}

/**
 * An add control's description: the control's accessible name is the raw kind
 * id (the kit contract, as `PlatformCard` pins it) — the words live here,
 * reached through `aria-describedby`, never inside the name. `name` is a
 * display label (`layerKindDisplayName`), never a raw id (D18).
 */
export function templateAddDescription(name: string): string {
  return `Add ${name}`;
}

/** A remove control's description — the same contract, the layer's words. */
export function templateRemoveDescription(name: string): string {
  return `Remove ${name}`;
}

/** A move-up control's description (D18, D128): moves toward the top of the stack. */
export function templateMoveUpDescription(name: string): string {
  return `Move ${name} up`;
}

/** A move-down control's description (D18, D128): moves toward the bottom of the stack. */
export function templateMoveDownDescription(name: string): string {
  return `Move ${name} down`;
}

/**
 * A layer toggle's description while the layer draws (L9, D129) — the same
 * contract as the other row controls: the accessible name is the raw layer id
 * and the words live here. "Hide" is what the toggle does to the picture: the
 * layer stays in the brief, in its slot, and simply stops drawing.
 */
export function templateDisableDescription(name: string): string {
  return `Hide ${name}`;
}

/** The same toggle once the layer is off: the words say it comes back. */
export function templateEnableDescription(name: string): string {
  return `Show ${name}`;
}

/**
 * Advisory note when a layer reposition creates an occlusion (D135, D136).
 * Names both layers and describes what happens in the quiet-note idiom.
 * Formatters receive display labels (D18): "Shade", "Static text", etc.
 */
export function templateOcclusionNote(
  aboveName: string,
  belowName: string,
  effect: "hide" | "mute" | "overlap",
): string {
  const below =
    belowName.toLowerCase() === "static text" || belowName.toLowerCase() === "animated text"
      ? "the headline"
      : `the ${belowName.toLowerCase()}`;
  const verb =
    effect === "hide" ? "hide it" : effect === "mute" ? "mute it" : "overlap where it sits";
  return `the ${aboveName.toLowerCase()} layer now sits above ${below} and will ${verb}`;
}

/** Accessible name for the video preview's scrub range control (VE-D5). */
export const previewScrubLabel = "Scrub preview";

/* ── The click destination (HL5b, HL-D3) ─────────────────────────────────── */

/** The destination input's label. */
export const clickDestinationLabel = "Click destination";
/** The helper line under the input: optional, and what it does. */
export const clickDestinationHelp =
  "Where the ad goes when someone clicks it — leave blank for no destination.";
/** The input's example, so the absolute-URL shape is visible before the error is. */
export const clickDestinationPlaceholder = "https://example.com/landing";
/**
 * `clickDestination` — the domain's problem, in the editor's voice (D2). The
 * `must` clause is the domain's own (`clickDestinationProblem`); the web app
 * never writes a second URL check, so the two cannot disagree. Named for the
 * failure it formats, not the domain function it wraps: two exported functions
 * called `clickDestinationProblem` invited reviewers to confuse the decision
 * with its sentence.
 */
export function clickDestinationInvalid(problem: { readonly must: string }): string {
  return `That is not a destination we can use — it must ${problem.must}.`;
}

/* ── The html layer's elements (HL5a, HL-D1, HL-D2) ──────────────────────── */

/** The element list's name, said above it and used as its accessible name. */
export const htmlElementsLabel = "Elements";

/** Said while the layer holds none — the offer below it is the next step. */
export const htmlElementsEmpty = "No elements yet — add one below.";

/** The add row's group name. */
export const htmlElementAddLabel = "Add an element";

/**
 * An add control's description (D18): the control's accessible name is the raw
 * kind id — `text`, `button`, `image` — the way a layer's add control names
 * itself by its kind; the words live here. `kindName` is a display label
 * (`htmlElementKindLabel`), never a raw id.
 */
export function htmlElementAddDescription(kindName: string): string {
  return `Add ${kindName}`;
}

/**
 * An element row's accessible name: its position in the list, one-based. An
 * element has no id of its own, so the position it holds in the layer is the
 * identity every control on the row is named by — the same reason a beat's
 * controls name themselves by position.
 */
export function htmlElementName(position: number): string {
  return `Element ${position}`;
}

/** A move-up control's description: up is toward the start of the list. */
export function htmlElementMoveUpDescription(position: number): string {
  return `Move element ${position} up`;
}

/** A move-down control's description: down is toward the end of the list. */
export function htmlElementMoveDownDescription(position: number): string {
  return `Move element ${position} down`;
}

/** A remove control's description — the same contract as the row's other controls. */
export function htmlElementRemoveDescription(position: number): string {
  return `Remove element ${position}`;
}

/**
 * The copy input's label — carried by the `text` and `button` kinds only. An
 * `image` element has no copy, so it carries no input rather than a disabled
 * one (DESIGN.md §1.5).
 */
export function htmlElementTextLabel(position: number): string {
  return `Element ${position} text`;
}

/**
 * A frame's numeric fields — the ones an element editor gives a number input.
 * Derived from the domain's own `Frame`, so a fifth field is a field with no
 * words below rather than a raw key on a label.
 */
export type FrameNumberField = Exclude<keyof Frame, "anchor">;

/**
 * What a frame field is called, in words (D18): the label is read aloud by a
 * screen reader and read on screen by a person, and neither of them is reading
 * a schema — `x` on a label is a letter, "horizontal position" is a place.
 * Keyed by the field, so a frame field with no words here is a compile error.
 */
const FRAME_FIELD_WORDS: Readonly<Record<FrameNumberField, string>> = {
  x: "horizontal position",
  y: "vertical position",
  w: "width",
  h: "height",
};

/** A frame input's label; `field` is the frame's own key, named here in words. */
export function htmlElementFrameLabel(position: number, field: FrameNumberField): string {
  return `Element ${position} ${FRAME_FIELD_WORDS[field]}`;
}

/** The anchor select's label. */
export function htmlElementAnchorLabel(position: number): string {
  return `Element ${position} anchor`;
}

/* ── The element style override (HL5e, HL-D4, HL-D8) ─────────────────────── */

/**
 * The face of both style selects that writes the ABSENT key — the element
 * follows the brief's own `creative-style`, which is what HL-D4 says style
 * comes from; the override is the exception a row can state.
 */
export const htmlElementStyleDefault = "Brief default";

/** The weight select's label (carried by the `text` and `button` rows only). */
export function htmlElementWeightLabel(position: number): string {
  return `Element ${position} weight`;
}

/** The typeface select's label — the brief-level control's word, per element. */
export function htmlElementFamilyLabel(position: number): string {
  return `Element ${position} typeface`;
}

/**
 * The copy a new element starts with (HL5a): something a person can see and
 * replace, never an empty field — an element with nothing to say is an element
 * neither renderer can place. Only the `text` and `button` kinds ask: an
 * `image` element carries no copy at all, and the domain refuses it one.
 */
export function htmlElementDefaultCopy(kind: string): string {
  return kind === "button" ? "Shop now" : "Your message here";
}

/**
 * Display words for an element kind (HL5a, D18) — the LAYER_KIND_META pattern
 * one file up. The kind's raw id stays the accessible name of the control that
 * offers it; these are the words the eye reads and the description carries. An
 * unknown kind reads as itself rather than as an empty label.
 */
export function htmlElementKindLabel(kind: string): string {
  if (kind === "text") return "Text";
  if (kind === "button") return "Button";
  if (kind === "image") return "Image";
  return kind;
}

/* ── The html weight meter (HL5c, HL-D6) ─────────────────────────────────── */

/**
 * A byte count in the meter's voice: whole KB. Rounded UP, so the meter never
 * talks about "0 KB" for markup that is not empty, and an overage never
 * rounds away to nothing — a lower bound shown as zero is a lie of the exact
 * kind HL-D6 exists to remove.
 */
export function weightKb(bytes: number): string {
  return String(Math.ceil(bytes / 1024));
}

/** The meter's sentence: what the markup weighs, against which placement. */
export function htmlWeightMeterText(bytes: number, maxBytes: number, profileLabel: string): string {
  return `${weightKb(bytes)} KB of ${weightKb(maxBytes)} KB for ${profileLabel}.`;
}

/**
 * Why the meter's figure is a lower bound, said beside it: the fallback joins
 * the same budget at packaging, and its bytes do not exist until generation.
 */
export const htmlWeightFallbackNote =
  "The raster fallback image is added at packaging and counts toward the same budget — its size is unknown until the unit is generated, so packaging's check is the one that enforces it.";

/** The over-budget sentence — the meter's warning and the draft's warning, in one voice. */
export function htmlWeightOverage(overBytes: number): string {
  return `Over budget by ${weightKb(overBytes)} KB.`;
}

/* ── The timeline tape (TS1) ─────────────────────────────────────────────── */

/** The tape's own heading. Display words only — "scrollport" is not vocabulary. */
export const tapeLegend = "Timeline";
/** The tape's idle sentence: what the surface is for, and that it scrolls. */
export const tapeIdleStatus = "Drag the playhead to scrub. Scroll sideways for later seconds.";
/** After a commit: the frame on screen is the encoded one at that second (VE-D6). */
export function tapeCommittedStatus(label: string): string {
  return `Frame at ${label} — matches the encoded frame.`;
}
/** The named playhead — the native range, never the painted diamond. */
export const tapePlayheadName = "Playhead";
/** The zoom control's name. */
export const tapeZoomName = "Timeline zoom";
/** The nudges. Action names, because they are buttons that do a thing. */
export const tapeNudgeBack = "Back one second";
export const tapeNudgeForward = "Forward one second";
/**
 * What the nudge buttons SHOW. Operator-facing, so they live here with every
 * other word the operator reads (§7) rather than as literals in the component —
 * and the minus is U+2212, not a hyphen, which is the kind of thing that only
 * stays right when one file owns it.
 */
export const tapeNudgeBackGlyph = "−1s";
export const tapeNudgeForwardGlyph = "+1s";
/** A title clip's stable name: its position, never its live seconds. */
export function tapeBeatName(position: number): string {
  return `Beat ${position}`;
}
/** The video lane's name and its single clip's name. */
export const tapeLaneVideo = "Video";
export const tapeVideoClip = "Video clip";
/** The title lane's name. */
export const tapeLaneTitle = "Title";
/** The zoom readout, in mono. A unit, not jargon (§7). */
export function tapePxPerSecond(pxPerSec: number): string {
  return `${pxPerSec} px/s`;
}
/** A ruler tick's label, e.g. "4s". */
export function tapeTick(seconds: number): string {
  return `${seconds}s`;
}
