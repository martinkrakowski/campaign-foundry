import { lstatSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { resolveAssetPath } from "@campaignfoundry/CreativeGeneration";
import { errorMessage } from "@campaignfoundry/shared";
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
  if (lstatSync(path).size > MAX_ASSET_BYTES) {
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

/**
 * One ref, its category, and — where a rule or the filesystem says so — why.
 *
 * **TOTAL BY CONSTRUCTION (fix round 1, FIX 1).** `scanBriefs` calls `classifyRefs`
 * OUTSIDE the try that captures a parse failure, so a throw here escapes the scan, escapes
 * `plan`, and lands in the entry guard's `.then`, which has no rejection handler: one bad
 * ref in one file used to abort the whole run instead of costing that campaign its place in
 * the plan. Every filesystem answer below is therefore a value, never an exception —
 * including the three that are only reachable because the path came off a legacy disk:
 * a directory (EISDIR), a symlink (followed OUT of both roots), and an unreadable file
 * (EACCES).
 *
 * **`lstatSync`, never `stat`/`existsSync`.** Those follow a symlink, and following one is
 * the whole hazard: a legacy tree's `logo.png` can point at `/etc/hosts`, and a link to
 * `/dev/zero` makes `readFileSync` block forever on a FIFO-shaped target. `lstat` asks what
 * the NAME is, so a symlink is refused as a symlink and never read through. This is
 * STRICTER than the live pipeline — `FileSystemInputAssets` follows a link — and stricter on
 * purpose, matching `fs-brief-store.ts:381-382`'s own refusal of a symlinked brief, so the
 * importer and the store agree that a link in a tree is a thing to fix, not to follow.
 */
function classify(ctx: StepContext, campaign: ScannedCampaign, ref: unknown): RefClassification {
  // Before `resolveAssetPath`, which does `resolve(root, input)` and therefore throws
  // ERR_INVALID_ARG_TYPE on a number. `parseBrief` never type-checks `products[].logoPath`
  // or `.inputAsset`, so a non-string really does arrive.
  if (typeof ref !== "string") {
    return { ref: String(ref), kind: "unsafe", reason: "the ref is not a string" };
  }
  const path = resolveAssetPath(ref, ctx.projectRoot);
  if (path === undefined) {
    return { ref, kind: "unsafe", reason: "the ref does not resolve to a path under assets/" };
  }
  const rel = relative(resolve(ctx.projectRoot, "assets"), path);
  const kind = shapeKind(rel, campaign.slug);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) {
    return { ref, kind: "missing", reason: `no file at ${JSON.stringify(ref)}` };
  }
  if (st.isSymbolicLink()) {
    return { ref, kind: "unsafe", reason: "the ref is a symlink; the importer never follows one" };
  }
  // Not a file and not a link: a directory left where an asset belongs, or a FIFO, whose
  // `st.size` is 0 — so the size cap would pass it and the read would never return.
  if (!st.isFile()) {
    return {
      ref,
      kind: "refused-file",
      reason: `${JSON.stringify(basename(rel))} is not a regular file.`,
    };
  }
  try {
    const problem = inputRuleProblem(path, basename(rel));
    return problem === undefined ? { ref, kind } : { ref, kind: "refused-file", reason: problem };
  } catch (error) {
    // EACCES on a mode-000 file, and anything else the read can raise. A refusal naming the
    // reason is the same KIND of fact the three upload rules produce, so it belongs here.
    return { ref, kind: "refused-file", reason: `could not be read: ${errorMessage(error)}` };
  }
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
