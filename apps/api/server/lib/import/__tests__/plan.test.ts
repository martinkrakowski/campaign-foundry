import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_IMPORT_JSON_BYTES } from "../census.js";
import { assemblePlan } from "../plan.js";
import type { ScanResult } from "../scan.js";
import type { StepContext } from "../steps.js";
import { dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

/**
 * PT-8a reqs 13, 15 and 16: the plan's reports, pools and decisions sections.
 *
 * **A problem is a fact about ONE file, appended to the run's refusal list with
 * the slug set, and it never removes a campaign** (D223: the report is still
 * imported). Every refusal here is asserted with the reason an operator acts
 * on — the parser's message, the confined path's escape, the extension rule —
 * never a bare "failed".
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

/** The scan assemblePlan takes: importable campaign slugs are enough for every test. */
function scan(...slugs: readonly string[]): ScanResult {
  return {
    campaigns: slugs.map((slug) => ({
      slug,
      sourcePath: join("/", "briefs", `${slug}.yaml`),
      name: null,
      type: null,
      brief: {} as never,
      refs: [],
      sample: false,
    })),
    refusals: [],
    samples: { skipped: 0, imported: 0 },
  };
}

describe("reports (req 13)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a report with all five fields present and valid plans every one of them", async () => {
    root = makeRoot();
    const output = join(root, "output");
    for (const field of ["out.png", "clip.mp4", "fallback.html", "proof.pdf", "bundle.html"]) {
      writeAt(output, `camp-a/${field}`, "bytes\n");
    }
    writeAt(
      output,
      "reports/camp-a.json",
      JSON.stringify({
        outputPath: "camp-a/out.png",
        videoPath: "camp-a/clip.mp4",
        htmlFallbackPath: "camp-a/fallback.html",
        proofPath: "camp-a/proof.pdf",
        htmlBundlePath: "camp-a/bundle.html",
      }),
    );

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports).toEqual([
      {
        slug: "camp-a",
        present: true,
        fields: [
          {
            field: "outputPath",
            path: "camp-a/out.png",
            status: "ok",
            resolved: join(output, "camp-a/out.png"),
          },
          {
            field: "videoPath",
            path: "camp-a/clip.mp4",
            status: "ok",
            resolved: join(output, "camp-a/clip.mp4"),
          },
          {
            field: "htmlFallbackPath",
            path: "camp-a/fallback.html",
            status: "ok",
            resolved: join(output, "camp-a/fallback.html"),
          },
          {
            field: "proofPath",
            path: "camp-a/proof.pdf",
            status: "ok",
            resolved: join(output, "camp-a/proof.pdf"),
          },
          {
            field: "htmlBundlePath",
            path: "camp-a/bundle.html",
            status: "ok",
            resolved: join(output, "camp-a/bundle.html"),
          },
        ],
        problems: [],
      },
    ]);
    expect(plan.refusals).toEqual([]);
  });

  test("a missing file on one field is listed, not thrown", async () => {
    root = makeRoot();
    writeAt(
      join(root, "output"),
      "reports/camp-a.json",
      JSON.stringify({ outputPath: "camp-a/gone.png" }),
    );

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports[0]!.fields[0]).toEqual({
      field: "outputPath",
      path: "camp-a/gone.png",
      status: "refused",
      resolved: join(root, "output", "camp-a/gone.png"),
      reason: 'no file at "camp-a/gone.png"',
    });
    // The field refusal carries the field structurally, and the reason bare.
    expect(plan.refusals).toEqual([
      {
        slug: "camp-a",
        sourcePath: join(root, "output", "reports", "camp-a.json"),
        reason: 'no file at "camp-a/gone.png"',
        field: "outputPath",
      },
    ]);
  });

  test("req 13: an unsupported extension on one report field is listed with contentTypeFor's own refusal", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(output, "camp-a/notes.txt", "text\n");
    writeAt(output, "reports/camp-a.json", JSON.stringify({ outputPath: "camp-a/notes.txt" }));

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports[0]!.fields[0]).toEqual({
      field: "outputPath",
      path: "camp-a/notes.txt",
      status: "refused",
      resolved: join(output, "camp-a/notes.txt"),
      reason: "Refusing to export .txt: no content type is defined for it.",
    });
  });

  test("an escaping field is refused for that field, names nothing, and is never opened", async () => {
    root = makeRoot();
    writeAt(
      join(root, "output"),
      "reports/camp-a.json",
      JSON.stringify({ outputPath: "../../gone/secret.png" }),
    );

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports[0]!.fields[0]).toEqual({
      field: "outputPath",
      path: "../../gone/secret.png",
      status: "refused",
      resolved: null,
      reason: "Path escapes the allowed directory.",
    });
    expect(plan.refusals).toEqual([
      {
        slug: "camp-a",
        sourcePath: join(root, "output", "reports", "camp-a.json"),
        reason: "Path escapes the allowed directory.",
        field: "outputPath",
      },
    ]);
  });

  test("a field naming a symlink inside the root is refused as a symlink and never followed", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const real = writeAt(output, "secret/real.png", "png\n");
    linkAt(output, "camp-a/link.png", real);
    writeAt(output, "reports/camp-a.json", JSON.stringify({ outputPath: "camp-a/link.png" }));

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports[0]!.fields[0]).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("is a symlink; the importer never follows one"),
    });
  });

  test("a field reached THROUGH a symlinked directory is refused at that directory", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(join(root, "elsewhere"), "out.png", "png\n");
    linkAt(output, "camp-a/sub", join(root, "elsewhere"));
    writeAt(output, "reports/camp-a.json", JSON.stringify({ outputPath: "camp-a/sub/out.png" }));

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.reports[0]!.fields[0]).toMatchObject({
      status: "refused",
      reason: '"camp-a/sub" is a symlinked directory; the importer never follows one',
    });
  });

  test("a field naming a DIRECTORY, and one walking THROUGH a file, are refusals of the field", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(output, "camp-a/a-dir/inside.png", "png\n");
    writeAt(output, "reports/camp-a.json", JSON.stringify({ outputPath: "camp-a/a-dir" }));

    const dirTarget = await assemblePlan(context(root), scan("camp-a"));
    expect(dirTarget.reports[0]!.fields[0]).toEqual({
      field: "outputPath",
      path: "camp-a/a-dir",
      status: "refused",
      resolved: join(output, "camp-a/a-dir"),
      reason: '"camp-a/a-dir" is not a regular file.',
    });

    dropRoot(root);
    root = makeRoot();
    writeAt(join(root, "output"), "camp-a/sub", "not a directory\n");
    writeAt(
      join(root, "output"),
      "reports/camp-a.json",
      JSON.stringify({ outputPath: "camp-a/sub/out.png" }),
    );
    const throughFile = await assemblePlan(context(root), scan("camp-a"));
    expect(throughFile.reports[0]!.fields[0]).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("ENOTDIR"),
    });
    // The field's refusal is on the run's list, with the slug set (D223).
    expect(throughFile.refusals.map((one) => one.slug)).toEqual(["camp-a"]);
  });

  test("a report file that is absent, a symlink, a directory, unparseable, or not an object is answered", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");

    // Absent: a normal state, not a refusal.
    const absent = await assemblePlan(context(root), scan("camp-a"));
    expect(absent.reports).toEqual([{ slug: "camp-a", present: false, fields: [], problems: [] }]);

    linkAt(output, "reports/camp-a.json", join(root, "elsewhere.png"));
    const linked = await assemblePlan(context(root), scan("camp-a"));
    expect(linked.reports[0]!.problems[0]).toContain("reports/camp-a.json is a symlink");

    dropRoot(root);
    root = makeRoot();
    // The report path as a DIRECTORY (a file inside it, so the directory exists).
    writeAt(join(root, "output"), "reports/camp-a.json/x", "x\n");
    const notFile = await assemblePlan(context(root), scan("camp-a"));
    expect(notFile.reports[0]!.problems[0]).toContain("is not a regular file.");

    dropRoot(root);
    root = makeRoot();
    writeAt(join(root, "output"), "reports/camp-a.json", "{oops");
    const unparseable = await assemblePlan(context(root), scan("camp-a"));
    expect(unparseable.reports[0]!.problems).toHaveLength(1);
    expect(unparseable.reports[0]!.problems[0]).toContain("JSON");

    dropRoot(root);
    root = makeRoot();
    writeAt(join(root, "output"), "reports/camp-a.json", "[]");
    const notObject = await assemblePlan(context(root), scan("camp-a"));
    expect(notObject.reports[0]!.problems).toEqual(["the report is not an object."]);

    dropRoot(root);
    root = makeRoot();
    writeAt(
      join(root, "output"),
      "reports/camp-a.json",
      Buffer.alloc(MAX_IMPORT_JSON_BYTES + 1, 0x41),
    );
    const oversize = await assemblePlan(context(root), scan("camp-a"));
    expect(oversize.reports[0]!.problems[0]).toContain("the import cap is");

    dropRoot(root);
    root = makeRoot();
    // The reports directory as a FILE: lstat of the report path raises ENOTDIR.
    writeAt(join(root, "output"), "reports", "not a directory\n");
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    const notDir = await assemblePlan(context(root), scan("camp-a"));
    expect(notDir.reports[0]!.problems[0]).toContain("ENOTDIR");
  });
});

describe("pools (req 15)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a valid pools.json passes through, and a shape failure lists copyPoolProblem's message", async () => {
    root = makeRoot();
    const briefs = join(root, "briefs");
    writeAt(
      briefs,
      "camp-a/pools.json",
      JSON.stringify({
        briefId: "camp-a",
        generatedAt: "2026-10-01T00:00:00Z",
        model: "m",
        entries: [],
      }),
    );
    // A second campaign whose parent exists but holds no pools.json: absent is
    // a normal state there too, reached by a DIFFERENT arm than an absent parent.
    mkdirSync(join(briefs, "camp-b"), { recursive: true });

    const valid = await assemblePlan(context(root), scan("camp-a", "camp-b"));
    // The valid pool passes THROUGH with its content (req 15): what apply
    // would copy is in the plan, not just the fact that something is there.
    expect(valid.pools).toEqual([
      {
        slug: "camp-a",
        present: true,
        problems: [],
        pool: { briefId: "camp-a", generatedAt: "2026-10-01T00:00:00Z", model: "m", entries: [] },
      },
      { slug: "camp-b", present: false, problems: [] },
    ]);
    expect(valid.refusals).toEqual([]);

    writeAt(briefs, "camp-a/pools.json", JSON.stringify({ entries: [] }));
    const invalid = await assemblePlan(context(root), scan("camp-a"));
    expect(invalid.pools).toEqual([
      { slug: "camp-a", present: true, problems: ["briefId must be a string"] },
    ]);
    expect(invalid.refusals.map((one) => one.reason)).toEqual(["briefId must be a string"]);
  });

  test("an absent, unparseable, oversize, or unreachable pool file is answered", async () => {
    root = makeRoot();
    const briefs = join(root, "briefs");

    const absent = await assemblePlan(context(root), scan("camp-a"));
    expect(absent.pools).toEqual([{ slug: "camp-a", present: false, problems: [] }]);

    writeAt(briefs, "camp-a/pools.json", "{oops");
    const unparseable = await assemblePlan(context(root), scan("camp-a"));
    expect(unparseable.pools[0]!.problems).toHaveLength(1);
    expect(unparseable.pools[0]!.problems[0]).toContain("JSON");

    writeAt(briefs, "camp-a/pools.json", Buffer.alloc(MAX_IMPORT_JSON_BYTES + 1, 0x41));
    const oversize = await assemblePlan(context(root), scan("camp-a"));
    expect(oversize.pools[0]!.problems[0]).toContain("the import cap is");

    // A symlinked `briefs/<slug>/` is refused at the parent, exactly as
    // `scan.ts:106` refuses it for `campaign.json` — for a slug whose own
    // directory has not been created first.
    linkAt(briefs, "camp-link", join(root, "elsewhere"));
    const linked = await assemblePlan(context(root), scan("camp-link"));
    expect(linked.pools[0]!.problems[0]).toContain("briefs/camp-link is a symlink");

    // `briefs` ITSELF as a FILE: the parent lstat raises ENOTDIR, which the
    // parent check refuses rather than throwing into the run.
    dropRoot(root);
    root = makeRoot();
    writeAt(root, "briefs", "not a directory\n");
    const parentThrow = await assemblePlan(context(root), scan("camp-a"));
    expect(parentThrow.pools[0]!.problems[0]).toContain("ENOTDIR");
  });
});

describe("decisions (req 16)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a valid decisions file passes; a shape failure is ONE refusal for the file", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(
      output,
      "decisions/camp-a.json",
      JSON.stringify({
        "asset-1": { verdict: "approved", actor: "u", at: "2026-10-01T00:00:00.000Z", run: "r1" },
      }),
    );

    const valid = await assemblePlan(context(root), scan("camp-a"));
    expect(valid.decisions).toEqual([{ slug: "camp-a", present: true, problems: [] }]);
    expect(valid.refusals).toEqual([]);

    writeAt(output, "decisions/camp-a.json", "[]");
    const badShape = await assemblePlan(context(root), scan("camp-a"));
    expect(badShape.decisions).toEqual([
      {
        slug: "camp-a",
        present: true,
        problems: ["the decisions must be an object keyed by review key."],
      },
    ]);
    expect(badShape.refusals).toHaveLength(1);
  });

  test("a bad `at` is one refusal naming the key; every record's time is checked", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(
      output,
      "decisions/camp-a.json",
      JSON.stringify({
        "asset-1": { verdict: "approved", actor: "u", at: "not a time", run: "r1" },
        "asset-2": { verdict: "rejected", actor: "u", at: "2026-10-01", run: "r1" },
        "asset-3": { verdict: "approved", actor: "u", at: "2026-10-01T00:00:00.000Z", run: "r1" },
      }),
    );

    const plan = await assemblePlan(context(root), scan("camp-a"));

    expect(plan.decisions[0]!.problems).toHaveLength(2);
    expect(plan.decisions[0]!.problems[0]).toContain('"asset-1"');
    expect(plan.decisions[0]!.problems[1]).toContain('"asset-2"');
    expect(plan.refusals).toHaveLength(2);
  });

  test("every half-shaped record is its own refusal, and the keys are checked in a stable order", async () => {
    const valid = { verdict: "approved", actor: "u", at: "2026-10-01T00:00:00.000Z", run: "r1" };
    for (const [record, expected] of [
      [{ "asset-1": "nope" }, "must be an object."],
      [{ "asset-1": null }, "must be an object."],
      [{ "asset-1": [] }, "must be an object."],
      [{ "asset-1": { ...valid, verdict: "meh" } }, 'has no "approved"/"rejected" verdict.'],
      [{ "asset-1": { ...valid, actor: 5 } }, "has no actor."],
      [{ "asset-1": { ...valid, at: 5 } }, "has no time."],
      [{ "asset-1": { ...valid, run: 5 } }, "has no run."],
    ] as const) {
      root = makeRoot();
      writeAt(root!, join("output", "decisions", "camp-a.json"), JSON.stringify(record));

      const plan = await assemblePlan(context(root!), scan("camp-a"));

      expect(plan.decisions[0]!.problems, JSON.stringify(record)).toHaveLength(1);
      expect(plan.decisions[0]!.problems[0]).toContain(expected);
      dropRoot(root);
      root = undefined;
    }

    // Reverse insertion order exercises the sort's other arm: the file stays
    // valid, and the check still ran over both keys.
    root = makeRoot();
    writeAt(
      root!,
      join("output", "decisions", "camp-a.json"),
      JSON.stringify({
        "z-asset": valid,
        "a-asset": valid,
      }),
    );
    const reversed = await assemblePlan(context(root!), scan("camp-a"));
    expect(reversed.decisions[0]!.problems).toEqual([]);
  });

  test("decisions that are unreadable or unparseable are refusals of the file", async () => {
    root = makeRoot();
    // The decisions DIRECTORY as a FILE: the record path's lstat raises ENOTDIR.
    writeAt(join(root, "output"), "decisions", "not a directory\n");
    const notDir = await assemblePlan(context(root), scan("camp-a"));
    expect(notDir.decisions[0]!.problems[0]).toContain("ENOTDIR");
    expect(notDir.refusals).toHaveLength(1);

    dropRoot(root);
    root = makeRoot();
    writeAt(join(root, "output"), "decisions/camp-a.json", "{oops");
    const unparseable = await assemblePlan(context(root), scan("camp-a"));
    expect(unparseable.decisions[0]!.problems).toHaveLength(1);
    expect(unparseable.decisions[0]!.problems[0]).toContain("JSON");
  });
});
