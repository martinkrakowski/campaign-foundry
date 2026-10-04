import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { projectRoot as processProjectRoot } from "@campaignfoundry/shared";
import { parseBriefText } from "../../load-brief.js";
import { classifyRefs } from "../classify.js";
import { scanBriefs, type ScannedCampaign } from "../scan.js";
import type { StepContext } from "../steps.js";
import { MP3, NOT_A_PNG, PNG, briefYaml, dropRoot, makeRoot, writeAt } from "./fixtures/tree.js";

/**
 * PT-8a req 12: every distinct ref in a campaign, in exactly one of seven categories.
 *
 * **The seven are exhaustive on purpose** — D222's whole refusal rule is built from the
 * last three of them, so a category that exists but cannot refuse a campaign would make
 * "refused with the ref named" untrue. Each test therefore asserts the `kind` a real ref
 * lands in, and the six that need a file on disk build one.
 *
 * The classifier is called directly, with a campaign whose brief was parsed by
 * `parseBriefText` — the same parser `scanBriefs` uses — so nothing here goes through a
 * scan that would have refused the campaign first, which is the decision under test in
 * `scan.test.ts` and not this file's.
 */

function context(projectRoot: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date("2026-10-01T00:00:00Z"),
    projectRoot,
    outputRoot: join(projectRoot, "output"),
    includeSamples: false,
    fsOnly: true,
  };
}

/** One campaign holding one ref, parsed but not yet classified. */
function campaignFor(root: string, id: string, ref: string): ScannedCampaign {
  const overrides = {
    id,
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: ref }],
  };
  const yaml = briefYaml(overrides);
  const path = writeAt(root, join("briefs", `${id}.yaml`), yaml);
  return {
    slug: id,
    sourcePath: path,
    name: null,
    type: null,
    brief: parseBriefText(path, yaml),
    refs: [],
    sample: false,
  };
}

describe("classifyRefs (PT-8a req 12, D219)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a ref under the campaign's OWN slug is that campaign's own file", () => {
    root = makeRoot();
    writeAt(root, "assets/inputs/camp-own/logo.png", PNG);
    const campaign = campaignFor(root, "camp-own", "assets/inputs/camp-own/logo.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      { ref: "assets/inputs/camp-own/logo.png", kind: "own-campaign" },
    ]);
  });

  test("a ref under ANOTHER campaign's slug is another campaign's file", () => {
    root = makeRoot();
    writeAt(root, "assets/inputs/camp-other/logo.png", PNG);
    const campaign = campaignFor(root, "camp-mine", "assets/inputs/camp-other/logo.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      { ref: "assets/inputs/camp-other/logo.png", kind: "other-campaign" },
    ]);
  });

  test("the TRACKED root-level ref assets/inputs/hydra-logo.png is root-level", async () => {
    // Read from the repository's own tree, not a fixture: this is the ref the sample
    // briefs ship and the one D219 singles out as becoming an asset of the importing
    // campaign. A hand-written copy of it would be the same string with no provenance.
    const repo = processProjectRoot();
    const result = await scanBriefs({ ...context(repo), includeSamples: true });
    const summer = result.campaigns.find((one) => one.slug === "summer-hydration-2026");

    expect(summer?.refs).toEqual([
      { ref: "assets/inputs/hydra-logo.png", kind: "root-level" },
      { ref: "assets/inputs/trail-logo.png", kind: "root-level" },
    ]);
    // Nothing in the repository's own tree is refused: the demo briefs are the tree this
    // importer exists to read, and a plan that refused them would refuse its own fixture.
    expect(result.refusals).toEqual([]);
  });

  test("a safe path under assets/ but NOT under assets/inputs/ is other-safe-assets", () => {
    root = makeRoot();
    writeAt(root, "assets/logos/brand.png", PNG);
    const campaign = campaignFor(root, "camp-assets", "assets/logos/brand.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      { ref: "assets/logos/brand.png", kind: "other-safe-assets" },
    ]);
  });

  test("a ref whose file is not there is missing", () => {
    root = makeRoot();
    const campaign = campaignFor(root, "camp-missing", "assets/inputs/camp-missing/nope.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-missing/nope.png",
        kind: "missing",
        reason: 'no file at "assets/inputs/camp-missing/nope.png"',
      },
    ]);
  });

  test("a ref that does not resolve under assets/ is unsafe, and never read", () => {
    root = makeRoot();
    writeAt(root, "etc/passwd", "not read\n");
    const campaign = campaignFor(root, "camp-unsafe", "etc/passwd");

    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "etc/passwd",
        kind: "unsafe",
        reason: "the ref does not resolve to a path under assets/",
      },
    ]);
  });

  test("a ref whose file passes name and size but not the magic rule is refused-file", () => {
    root = makeRoot();
    // Named `.png` and small enough, so the ONLY rule it can fail is the magic one —
    // which is what makes this the seventh category rather than the first or the second.
    writeAt(root, "assets/inputs/camp-magic/fake.png", NOT_A_PNG);
    const campaign = campaignFor(root, "camp-magic", "assets/inputs/camp-magic/fake.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-magic/fake.png",
        kind: "refused-file",
        reason: '"fake.png" is not a PNG or JPEG file.',
      },
    ]);
  });

  test("the magic check dispatches on the NAME: an mp3 is checked as AUDIO, both ways", () => {
    root = makeRoot();
    // Two `.mp3` files, one with real audio bytes and one with PNG bytes. `assets.post.ts`'s
    // stated reason is that a valid PNG magic named `bed.mp3` must fail AS AUDIO rather
    // than pass as an image the importer never asked for, so both answers of the audio
    // branch have to be pinned — not just the refusal.
    writeAt(root, "assets/inputs/camp-audio/bed.mp3", PNG);
    writeAt(root, "assets/inputs/camp-audio/song.mp3", MP3);
    const real = campaignFor(root, "camp-audio", "assets/inputs/camp-audio/song.mp3");
    const misnamed = campaignFor(root, "camp-bed", "assets/inputs/camp-audio/bed.mp3");

    expect(classifyRefs(context(root), real)).toEqual([
      { ref: "assets/inputs/camp-audio/song.mp3", kind: "own-campaign" },
    ]);
    expect(classifyRefs(context(root), misnamed)).toEqual([
      {
        ref: "assets/inputs/camp-audio/bed.mp3",
        kind: "refused-file",
        reason: '"bed.mp3" is not an MP3 or M4A file.',
      },
    ]);
  });
});
