import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import {
  ASSET_NAME_PATTERN,
  AUDIO_ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  collectRefs,
  hasAllowedAudioMagic,
  hasAllowedImageMagic,
} from "../asset-files.js";
import type { ScannedCampaign } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * Ref classification for PT-8a (D219, D222): what each distinct ref in a brief IS, so
 * the plan can say what `apply` would have to do with it before anything is written.
 *
 * **The safety decision is `resolveAssetPath`'s, never a second one here** (D226's
 * argument, one ref walk over): that is the function the pipeline already refuses a
 * brief-supplied path with, so an importer that re-derived "safe" would eventually
 * disagree with the reader it is importing FOR — and the disagreement would be the one
 * that reads a file outside `assets/`.
 */

/** The four categories that name a file the importer could actually read. */
export type CleanRefKind = "own-campaign" | "other-campaign" | "root-level" | "other-safe-assets";

/**
 * One ref, and its category — **with the reason required on exactly the three categories
 * that have one.** A union rather than one flat shape with an optional `reason`, so a
 * caller can name the reason of a refusal without a fallback that would print
 * `undefined`: the four clean categories carry none and the three problem ones always do.
 */
export type RefClassification =
  | { readonly ref: string; readonly kind: CleanRefKind }
  | {
      readonly ref: string;
      readonly kind: "missing" | "unsafe" | "refused-file";
      readonly reason: string;
    };

/** The three that block an import (D222), narrowed to the shape that carries a reason. */
export type ProblemRef = Extract<RefClassification, { readonly reason: string }>;

/** Whether this ref is one a campaign cannot be imported with (D222). */
export function blocksImport(ref: RefClassification): ref is ProblemRef {
  return ref.kind === "missing" || ref.kind === "unsafe" || ref.kind === "refused-file";
}

/**
 * D222's three upload rules, in `assets.post.ts`'s own order: name, then size, then magic.
 *
 * **The magic check dispatches on the NAME's extension, never on the bytes alone**, for
 * the reason that route's doc comment gives: a valid PNG magic named `bed.mp3` must fail
 * as audio rather than pass as an image the importer never asked for.
 */
function inputRuleProblem(path: string, name: string): string | undefined {
  if (!ASSET_NAME_PATTERN.test(name)) {
    return `${JSON.stringify(name)} is not a path-safe asset name (lower-case, .png/.jpg/.jpeg/.mp3/.m4a).`;
  }
  if (statSync(path).size > MAX_ASSET_BYTES) {
    return `${JSON.stringify(name)} is over the ${MAX_ASSET_BYTES}-byte (2 MiB) limit.`;
  }
  const bytes = readFileSync(path);
  if (AUDIO_ASSET_NAME_PATTERN.test(name)) {
    return hasAllowedAudioMagic(bytes)
      ? undefined
      : `${JSON.stringify(name)} is not an MP3 or M4A file.`;
  }
  return hasAllowedImageMagic(bytes)
    ? undefined
    : `${JSON.stringify(name)} is not a PNG or JPEG file.`;
}

/**
 * The shape of a ref that resolved under `assets/`, and **nothing else**: the four
 * file-bearing categories. An `unsafe` ref never got this far, so there is no file
 * behind it to be absent or too large — reporting it twice would be two facts about
 * one ref, and D222's "refused with the ref named" only needs the one that is true.
 *
 * **`inputs/<name>` is the root-level demo ref and `inputs/<slug>/<name>` is a
 * campaign's own file**, which is `parseInputRef`'s split (`object-input-assets.ts`)
 * and not a fresh one: a name may itself contain a slash, so `inputs/a/b/c.png` is
 * campaign `a`'s file `b/c.png` rather than a shape to refuse. Under `assets/` but not
 * under `assets/inputs/` is the fourth — a file D219 still writes as an asset of THIS
 * campaign, named by its basename.
 */
function shapeKind(rel: string, slug: string): CleanRefKind {
  const parts = rel.split("/");
  if (parts[0] !== "inputs") return "other-safe-assets";
  if (parts.length < 3) return "root-level";
  return parts[1] === slug ? "own-campaign" : "other-campaign";
}

/** One ref, its category, and — where a rule or the filesystem says so — why. */
function classify(ctx: StepContext, campaign: ScannedCampaign, ref: string): RefClassification {
  const path = resolveAssetPath(ref, ctx.projectRoot);
  if (path === undefined) {
    return { ref, kind: "unsafe", reason: "the ref does not resolve to a path under assets/" };
  }
  const rel = relative(resolve(ctx.projectRoot, "assets"), path);
  const kind = shapeKind(rel, campaign.slug);
  // Existence before the rules: the name, size and magic of a file that is not there
  // describe nothing, and "missing" is the fact. One `statSync` answers both.
  if (!existsSync(path)) {
    return { ref, kind: "missing", reason: `no file at ${JSON.stringify(ref)}` };
  }
  const problem = inputRuleProblem(path, basename(rel));
  return problem === undefined ? { ref, kind } : { ref, kind: "refused-file", reason: problem };
}

/**
 * Every distinct ref in one campaign, classified (req 12).
 *
 * **`collectRefs` is the walk, imported from `asset-files.ts`** (D226, PT-8a0): four
 * fields, deduplicated, so a logo shared by ten products is classified once. The
 * campaign carries the parsed brief because these refs are that brief's — the classifier
 * never re-parses, and a brief the parser already accepted is the only thing that can
 * reach here.
 */
export function classifyRefs(
  ctx: StepContext,
  campaign: ScannedCampaign,
): readonly RefClassification[] {
  return collectRefs(campaign.brief).map((ref) => classify(ctx, campaign, ref));
}
