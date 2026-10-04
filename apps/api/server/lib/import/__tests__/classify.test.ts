import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectRoot as processProjectRoot } from "@campaignfoundry/shared";
import { parseBriefText } from "../../load-brief.js";
import { classifyRefs } from "../classify.js";
import { scanBriefs, type ScannedCampaign } from "../scan.js";
import type { StepContext } from "../steps.js";
import {
  MP3,
  NOT_A_PNG,
  PNG,
  briefYaml,
  dropRoot,
  linkAt,
  makeRoot,
  writeAt,
} from "./fixtures/tree.js";

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

/**
 * One campaign holding one ref, parsed but not yet classified.
 *
 * **`ref` is `unknown` on purpose**: `parseBrief` never type-checks
 * `products[].logoPath`, so a non-string is a shape a legacy brief really carries, and a
 * fixture helper that only accepted `string` could not build one.
 */
function campaignFor(root: string, id: string, ref: unknown): ScannedCampaign {
  const overrides = {
    id,
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: ref }],
  };
  const yaml = briefYaml(overrides as never);
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

/**
 * Fable fix round 1: `classifyRefs` is TOTAL.
 *
 * Every ref a legacy brief can carry must come back as a classification, because
 * `scanBriefs` calls this OUTSIDE the try that captures a parse failure — so a throw here
 * escapes the scan, escapes `plan`, and lands in the entry guard's `.then`, which has no
 * rejection handler. One bad ref in one file would then abort the whole run instead of
 * costing that one campaign its place in the plan.
 */
describe("classifyRefs is total (PT-8a1 fix round 1, FIX 1)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a ref that walks THROUGH a regular file is refused-file, not a thrown ENOTDIR", () => {
    root = makeRoot();
    // `throwIfNoEntry` suppresses ENOENT only: `lstat` on a path whose parent is a FILE
    // throws ENOTDIR, which used to escape classify and end the whole run (Fable re-check).
    writeAt(root, "assets/inputs/camp-notdir/logo.png", PNG);
    const ref = "assets/inputs/camp-notdir/logo.png/x.png";
    const [result] = classifyRefs(context(root), campaignFor(root, "camp-notdir", ref));

    expect(result).toMatchObject({
      ref,
      kind: "refused-file",
      reason: expect.stringMatching(/^could not be read: ENOTDIR/),
    });
  });

  test("a SYMLINKED PARENT directory is unsafe: lstat on the leaf alone reads through it", () => {
    root = makeRoot();
    // `lstat` refuses to follow only the FINAL component. Without the parent walk this
    // answers own-campaign, and the magic check passing proves the bytes were read from
    // OUTSIDE assets/.
    writeAt(root, "elsewhere/photo.png", PNG);
    linkAt(root, join("assets", "inputs", "camp-dirlink"), join(root, "elsewhere"));
    const ref = "assets/inputs/camp-dirlink/photo.png";

    expect(classifyRefs(context(root), campaignFor(root, "camp-dirlink", ref))).toEqual([
      {
        ref,
        kind: "unsafe",
        reason: '"inputs/camp-dirlink" is a symlinked directory; the importer never follows one',
      },
    ]);
  });

  test("a ref that is not a string is unsafe, not a thrown ERR_INVALID_ARG_TYPE", () => {
    root = makeRoot();
    // `parseBrief` never type-checks `products[].logoPath`, so `5` reaches
    // `resolveAssetPath` exactly as it does in production — and `resolve(root, 5)` throws.
    const campaign = campaignFor(root, "camp-num", 5);

    expect(classifyRefs(context(root), campaign)).toEqual([
      { ref: "5", kind: "unsafe", reason: "the ref is not a string" },
    ]);
  });

  test("a DIRECTORY at the ref path is refused-file, not an EISDIR read", () => {
    root = makeRoot();
    // Size is not consulted for a directory, so this used to reach `readFileSync` and
    // throw EISDIR — an operator's `briefs/` directory left where an asset was expected.
    mkdirSync(join(root, "assets", "inputs", "camp-dir", "logo.png"), { recursive: true });
    const campaign = campaignFor(root, "camp-dir", "assets/inputs/camp-dir/logo.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-dir/logo.png",
        kind: "refused-file",
        reason: '"logo.png" is not a regular file.',
      },
    ]);
  });

  test("a SYMLINK at the ref path is unsafe: the importer never follows one", () => {
    root = makeRoot();
    // Points at a real PNG, so nothing about the bytes is wrong — only the NAME of the
    // thing is. `lstat` is the whole point: `existsSync`/`stat` follow the link and read
    // through it, which is how a legacy tree's `logo.png` becomes `/etc/hosts`.
    writeAt(root, "elsewhere/target.png", PNG);
    linkAt(
      root,
      join("assets", "inputs", "camp-link", "logo.png"),
      join(root, "elsewhere/target.png"),
    );
    const campaign = campaignFor(root, "camp-link", "assets/inputs/camp-link/logo.png");

    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-link/logo.png",
        kind: "unsafe",
        reason: "the ref is a symlink; the importer never follows one",
      },
    ]);
  });

  test("a DANGLING symlink is unsafe, not missing", () => {
    root = makeRoot();
    linkAt(root, join("assets", "inputs", "camp-dangle", "logo.png"), join(root, "gone.png"));
    const campaign = campaignFor(root, "camp-dangle", "assets/inputs/camp-dangle/logo.png");

    // The distinction is the point: `existsSync` follows the link, finds no target, and
    // answers `missing` — which would tell the operator to put the file back at a path
    // that is a symlink, when the link itself is what must go.
    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-dangle/logo.png",
        kind: "unsafe",
        reason: "the ref is a symlink; the importer never follows one",
      },
    ]);
  });

  test("an UNREADABLE file is refused-file, not a thrown EACCES", () => {
    root = makeRoot();
    writeAt(root, "assets/inputs/camp-locked/logo.png", PNG);
    const path = join(root, "assets/inputs/camp-locked/logo.png");
    chmodSync(path, 0o000);
    const campaign = campaignFor(root, "camp-locked", "assets/inputs/camp-locked/logo.png");

    // Node's own message, path and all: the operator needs to be told WHICH file was
    // unreadable, and `briefs/` can hold a great many of them.
    expect(classifyRefs(context(root), campaign)).toEqual([
      {
        ref: "assets/inputs/camp-locked/logo.png",
        kind: "refused-file",
        reason: `could not be read: EACCES: permission denied, open '${path}'`,
      },
    ]);
  });
});
