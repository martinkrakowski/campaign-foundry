import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { scanBriefs } from "../scan.js";
import type { StepContext } from "../steps.js";
import {
  HTML_LAYER_REFUSAL,
  NOT_A_PNG,
  OVER_SIZE,
  PNG,
  briefYaml,
  dropRoot,
  makeRoot,
  writeAt,
  writeBrief,
  writeCampaignMeta,
  writeHtmlLayerBrief,
  writeRawBrief,
} from "./fixtures/tree.js";

/**
 * PT-8a reqs 6–11: what a read-only scan of `briefs/` reports, and what it refuses.
 *
 * **The rule under every test here is F8 and D222: a refusal is a fact about ONE file,
 * never a thrown error and never a silent skip.** So each test plants the problem beside a
 * brief that must still be planned, and asserts both — a scan that refused the whole tree
 * would pass a test that only looked at its refusals.
 */

function context(projectRoot: string, includeSamples = false): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date("2026-10-01T00:00:00Z"),
    projectRoot,
    outputRoot: join(projectRoot, "output"),
    includeSamples,
    fsOnly: true,
  };
}

/** A brief whose one ref is `ref`, so a test is about the brief's ID and not its inputs. */
function campaign(root: string, id: string, ref = "assets/inputs/logo.png"): void {
  writeBrief(root, `${id}.yaml`, {
    id,
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: ref }],
  });
}

/** The one real PNG every passing fixture ref points at. */
function inputs(root: string): void {
  writeAt(root, "assets/inputs/logo.png", PNG);
}

/** One product, pointing at the fixture logo — the shape a slug test's fixture needs. */
function singleRefProduct(): {
  products: [{ id: string; name: string; primaryColor: string; logoPath: string }];
} {
  return {
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
    ],
  };
}

describe("scanBriefs (PT-8a reqs 6-11)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("req 6: one brief's parse failure is its own refusal, with the parser's message", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-ok");
    writeHtmlLayerBrief(root, "legacy-html.yaml", "legacy-html");

    const result = await scanBriefs(context(root));

    // The retired layer costs ONE campaign the plan, not the run and not the neighbour.
    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-ok"]);
    expect(result.refusals).toEqual([
      {
        slug: null,
        sourcePath: join(root, "briefs", "legacy-html.yaml"),
        reason: HTML_LAYER_REFUSAL,
      },
    ]);
  });

  test("req 7: a sibling campaign.json reports name/type, and its absence reports null", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-meta");
    campaign(root, "camp-bare");
    writeCampaignMeta(root, "camp-meta", { name: "Meta campaign", type: "display-ad" });

    const result = await scanBriefs(context(root));
    const bySlug = new Map(result.campaigns.map((one) => [one.slug, one]));

    expect(bySlug.get("camp-meta")).toMatchObject({
      name: "Meta campaign",
      type: "display-ad",
    });
    expect(bySlug.get("camp-bare")).toMatchObject({ name: null, type: null });
  });

  test("req 8: a briefs/<slug>/campaign.json with no brief file is a reservation", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-saved");
    writeCampaignMeta(root, "camp-reserved", { name: "Never saved" });

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-saved"]);
    expect(result.refusals).toEqual([
      {
        slug: "camp-reserved",
        sourcePath: join(root, "briefs", "camp-reserved", "campaign.json"),
        reason:
          "a versionless reservation: briefs/<slug>/campaign.json with no brief file for that slug.",
      },
    ]);
  });

  test("req 7: a campaign.json whose fields are not strings reads as null, not as a guess", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-odd-meta");
    writeCampaignMeta(root, "camp-odd-meta", { name: 7, type: [] });

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => [one.slug, one.name, one.type])).toEqual([
      ["camp-odd-meta", null, null],
    ]);
    expect(result.refusals).toEqual([]);
  });

  /**
   * Fable fix round 1, FIX 5: a `campaign.json` that will not parse REFUSES its campaign.
   *
   * Degrading it to `null`/`null` looked faithful to `FsBriefStore.campaignMeta`'s
   * `hasVersion` branch, but it is not the same fact once the importer is the caller: the
   * plan would show a campaign with no name, `apply` would create it with `name: null`, and
   * nothing anywhere would say a `campaign.json` existed at all. D227 is never silent.
   */
  test("FIX 5: a campaign.json that will not parse REFUSES its campaign", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-broken-meta");
    writeAt(root, join("briefs", "camp-broken-meta", "campaign.json"), "{ not json");

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.slug).toBe("camp-broken-meta");
    expect(result.refusals[0]!.reason).toMatch(
      /^campaign\.json could not be read: .*(JSON|SyntaxError)/,
    );
  });

  test("req 8: a briefs/<slug>/ directory with NO campaign.json is not a reservation", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-saved");
    // A directory and nothing that says a campaign was reserved there — a pool directory,
    // a half-finished Save. A reservation is evidence (`campaign.json`), not a directory.
    writeAt(root, join("briefs", "camp-nothing", "notes.md"), "scratch\n");

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-saved"]);
    expect(result.refusals).toEqual([]);
  });

  /**
   * Fable fix round 1, FIX 2a: a brief that parses but cannot be SERIALISED is a refusal
   * of that one file.
   *
   * `parseBrief` keeps unknown top-level keys, so a self-referencing alias survives as a
   * circular object — and `JSON.stringify` on it throws `TypeError: Converting circular
   * structure to JSON`. Left uncaptured, that throw happened in `plan`, one file from the
   * end, and cost the operator the plan for every campaign.
   */
  test("FIX 2: a CIRCULAR brief is its own refusal, and the neighbour is planned", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-ok");
    writeRawBrief(
      root,
      "looping.yaml",
      `id: looping
targetRegion: DE
targetAudience: aud
campaignMessage: Hello
products:
  - id: p1
    name: P1
    primaryColor: "#111111"
    logoPath: assets/inputs/logo.png
meta: &a
  self: *a
`,
    );

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-ok"]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.sourcePath).toBe(join(root, "briefs", "looping.yaml"));
    expect(result.refusals[0]!.reason).toMatch(/circular structure/i);
  });

  test("req 9: briefs/sample-* is skipped by default, and the count is reported", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-real");
    campaign(root, "sample-demo");

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-real"]);
    expect(result.samples).toEqual({ skipped: 1, imported: 0 });
  });

  test("req 9: --include-samples imports a sample like any other file", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-real");
    campaign(root, "sample-demo");

    const result = await scanBriefs(context(root, true));

    expect(result.campaigns.map((one) => one.slug).sort()).toEqual(["camp-real", "sample-demo"]);
    expect(result.samples).toEqual({ skipped: 0, imported: 1 });
  });

  test("req 9: an OPERATOR-EDITED sample is still skipped by default (F7)", async () => {
    root = makeRoot();
    inputs(root);
    // Bytes that differ from anything the repo tracks, and an id that says so. If the
    // skip ever keyed on content rather than on the name, this would be planned.
    writeAt(
      root,
      join("briefs", "sample-edited.yaml"),
      briefYaml({
        id: "sample-edited",
        campaignMessage: "an operator rewrote this demo",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
        ],
      }),
    );

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(result.samples).toEqual({ skipped: 1, imported: 0 });
  });

  test("req 9: a skipped sample's briefs/<slug>/ sidecar is skipped WITH it, not an orphan", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "sample-pooled");
    writeAt(root, join("briefs", "sample-pooled", "pools.json"), '{"briefId":"sample-pooled"}');

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    // `pools.json` is never an orphan file here — the sample rule took the whole subtree
    // with it — and it is not a SECOND skip either. The brief file IS the skip; counting
    // the sidecar directory as well inflated the number an operator reads as "how many
    // samples did you skip", which is the only thing this count is for.
    expect(result.samples).toEqual({ skipped: 1, imported: 0 });
    expect(result.refusals).toEqual([]);
  });

  test("req 10: a slug that fails SAFE_ID_PATTERN is refused BY THE PARSER, per file", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "Not A Slug");
    campaign(root, "camp-kept");

    const result = await scanBriefs(context(root));

    // D218's `SAFE_ID_PATTERN` half does not need a second check here, and this is the
    // mechanism: `parseBrief` calls `assertSafeId(record.id, "Campaign id")` at
    // `load-brief.ts:1216` with that exact pattern, so an unsafe id never reaches a slug
    // check. It arrives one step earlier as a per-file refusal naming the file, with the
    // parser's wording — the same capture-per-file rule as the retired html layer.
    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    expect(result.refusals).toEqual([
      {
        slug: null,
        sourcePath: join(root, "briefs", "Not A Slug.yaml"),
        reason:
          "Campaign id must be a path-safe slug (lowercase letters, digits, hyphens; " +
          'max 64 chars); got "Not A Slug".',
      },
    ]);
  });

  test("req 10: a RESERVED slug is refused", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "packages");

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    expect(result.refusals).toEqual([
      {
        slug: "packages",
        sourcePath: join(root, "briefs", "packages.yaml"),
        reason: '"packages" is a reserved campaign id.',
      },
    ]);
  });

  test("req 10: TWO files claiming one slug refuse both, and name both files", async () => {
    root = makeRoot();
    inputs(root);
    // Two files, one declared id — the corrupt-root case `FsBriefStore`'s id index has to
    // break a tie for. Neither file may be planned: choosing one would make the other's
    // content depend on which the scan happened to reach first.
    writeBrief(root, "camp-twice-a.yaml", { id: "camp-twice", ...singleRefProduct() });
    writeBrief(root, "zz-camp-twice.yaml", { id: "camp-twice", ...singleRefProduct() });

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    expect(result.refusals.map((one) => one.sourcePath)).toEqual([
      join(root, "briefs", "camp-twice-a.yaml"),
      join(root, "briefs", "zz-camp-twice.yaml"),
    ]);
    for (const refusal of result.refusals) {
      expect(refusal.slug).toBe("camp-twice");
      expect(refusal.reason).toBe(
        '"camp-twice" is declared by 2 source files: "camp-twice-a.yaml", "zz-camp-twice.yaml".',
      );
    }
  });

  test("req 11: a ref whose NAME fails the asset pattern refuses the WHOLE brief", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-kept");
    writeAt(root, "assets/inputs/UPPER.png", PNG);
    campaign(root, "camp-bad-name", "assets/inputs/UPPER.png");

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    expect(result.refusals).toEqual([
      {
        slug: "camp-bad-name",
        sourcePath: join(root, "briefs", "camp-bad-name.yaml"),
        reason:
          'ref "assets/inputs/UPPER.png": "UPPER.png" is not a path-safe asset name ' +
          "(lower-case, .png/.jpg/.jpeg/.mp3/.m4a).",
      },
    ]);
  });

  test("req 11: a ref over MAX_ASSET_BYTES refuses the WHOLE brief", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-kept");
    writeAt(root, "assets/inputs/big.png", OVER_SIZE);
    campaign(root, "camp-too-big", "assets/inputs/big.png");

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.slug).toBe("camp-too-big");
    expect(result.refusals[0]!.reason).toBe(
      'ref "assets/inputs/big.png": "big.png" is over the 2097152-byte (2 MiB) limit.',
    );
  });

  test("req 11: a ref whose MAGIC does not match its extension refuses the WHOLE brief", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-kept");
    writeAt(root, "assets/inputs/fake.png", NOT_A_PNG);
    campaign(root, "camp-fake", "assets/inputs/fake.png");

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    expect(result.refusals).toEqual([
      {
        slug: "camp-fake",
        sourcePath: join(root, "briefs", "camp-fake.yaml"),
        reason: 'ref "assets/inputs/fake.png": "fake.png" is not a PNG or JPEG file.',
      },
    ]);
  });

  test("a project root with NO briefs/ refuses the directory, naming it", async () => {
    root = makeRoot();

    // A refusal rather than an empty plan: pointed at the wrong root, "found nothing" and
    // "there is nothing there to find" are different facts, and only one of them is a
    // reason to go looking.
    expect(await scanBriefs(context(root))).toEqual({
      campaigns: [],
      refusals: [
        {
          slug: null,
          sourcePath: join(root, "briefs"),
          reason: "there is no briefs/ directory to import from.",
        },
      ],
      samples: { skipped: 0, imported: 0 },
    });
  });

  test("a briefs/ that is not a directory is a refusal naming the error, never a throw", async () => {
    root = makeRoot();
    writeAt(root, "briefs", "not a directory\n");

    const result = await scanBriefs(context(root));

    expect(result.campaigns).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.sourcePath).toBe(join(root, "briefs"));
    expect(result.refusals[0]!.reason).toMatch(/^briefs\/ could not be read: /);
  });

  /**
   * Fable fix round 1, FIX 1: this is the test that proves NO THROW escapes `scanBriefs`.
   *
   * `scanBriefs` calls `classifyRefs` OUTSIDE the try that captures a per-file parse
   * failure, so a throw in the classifier used to propagate out of the scan, out of
   * `plan`, and into the entry guard's `.then` — which has no rejection handler — turning
   * one malformed ref in one file into an unhandled-rejection abort of the whole run.
   * `await` on a rejecting promise is the assertion that would fail; a campaign refused
   * with a reason is the assertion that must hold.
   */
  test("FIX 1: a non-string ref is REFUSED, and the scan still resolves", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-kept");
    // `logoPath: 5` — `parseBrief` never type-checks the field, so this is a brief the
    // parser ACCEPTS and the classifier must survive.
    writeRawBrief(
      root,
      "camp-num.yaml",
      `id: camp-num
targetRegion: DE
targetAudience: aud
campaignMessage: Hello
products:
  - id: p1
    name: P1
    primaryColor: "#111111"
    logoPath: 5
`,
    );

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    expect(result.refusals).toEqual([
      {
        slug: "camp-num",
        sourcePath: join(root, "briefs", "camp-num.yaml"),
        reason: 'ref "5": the ref is not a string',
      },
    ]);
  });

  /**
   * Fable fix round 1, FIX 3: a brief that FAILED to parse beside its own
   * `briefs/<stem>/campaign.json` is ONE refusal, not two.
   *
   * The reservation rule turns on "no brief file for that slug". A file that failed to
   * parse IS a brief file for that slug — its id was never read, which is precisely why
   * the importer cannot claim the campaign has no brief. The second refusal asserted
   * something false about the operator's tree.
   */
  test("FIX 3: an unparsed brief beside briefs/<stem>/campaign.json is ONE refusal", async () => {
    root = makeRoot();
    inputs(root);
    campaign(root, "camp-kept");
    writeHtmlLayerBrief(root, "legacy.yaml", "legacy");
    writeCampaignMeta(root, "legacy", { name: "Legacy campaign" });

    const result = await scanBriefs(context(root));

    expect(result.campaigns.map((one) => one.slug)).toEqual(["camp-kept"]);
    // Exactly one, and it is the parser's message — not a second entry claiming there is
    // no brief file for a slug whose brief file is right there.
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.slug).toBeNull();
    expect(result.refusals[0]!.sourcePath).toBe(join(root, "briefs", "legacy.yaml"));
    expect(result.refusals[0]!.reason).toBe(HTML_LAYER_REFUSAL);
  });
});
