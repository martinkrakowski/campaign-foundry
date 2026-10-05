import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_IMPORT_JSON_BYTES, assembleCensus, readBounded } from "../census.js";
import type { StepContext } from "../steps.js";
import { dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

/**
 * PT-8a reqs 13's reader, 14 and 17: the D227 census and the ONE reader every
 * file this lane touches goes through.
 *
 * **Nothing here may be silent**: a category the tree has nothing under still
 * answers (count 0), a category the tree cannot read refuses with the reason,
 * and a file the plan could not use still appears — counted, never dropped.
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

/** The fixture scan input: two parse refusals (one a brief file, one not) and skipped samples. */
function scanInput(briefs: string) {
  return {
    refusals: [
      { slug: null, sourcePath: join(briefs, "broken.yaml"), reason: "parse failed" },
      { slug: null, sourcePath: join(briefs, "subdir"), reason: "briefs/ could not be read: boom" },
    ],
    samples: { skipped: 2, imported: 0 },
  };
}

describe("readBounded (req 13's reader)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("a symlink is refused as a symlink and never followed", async () => {
    root = makeRoot();
    const real = writeAt(root, "real.json", "{}\n");
    const link = linkAt(root, "linked.json", real);

    const read = await readBounded(link);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("is a symlink; the importer never follows one");
    }
  });

  test("an oversize file is refused at the 8 MiB cap", async () => {
    root = makeRoot();
    const path = writeAt(root, "big.json", Buffer.alloc(MAX_IMPORT_JSON_BYTES + 1, 0x41));

    const read = await readBounded(path);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain(`the import cap is ${MAX_IMPORT_JSON_BYTES} bytes.`);
    }
  });

  test("a non-file is refused", async () => {
    root = makeRoot();
    const read = await readBounded(root);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toContain("is not a regular file.");
    }
  });
});

describe("assembleCensus (reqs 14 and 17)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("req 17: the census names all thirteen categories with their counts", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(root, "state/last-opened/u.json", "{}");
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    writeAt(briefs, "README.md", "notes\n");
    writeAt(briefs, "broken.yaml", "not a brief\n");
    linkAt(briefs, "ghost-link", join(root, "gone"));

    // The eight reserved top-level names, so none can be mistaken for a slug.
    writeAt(output, "cache/x.png", "png\n");
    writeAt(output, "jobs/j1.json", "{}");
    writeAt(output, "orgs/acme/side.json", "{}");
    writeAt(output, "last-opened/marker.json", "{}");
    writeAt(output, "decisions/camp-a.json", "{}");
    writeAt(output, "reports/camp-a.json", "{}");
    writeAt(output, "packages/plat/x.zip", "zip\n");
    writeAt(output, "report.json", "{}\n");
    // Links inside counted categories: never followed, counted under `symlinks`.
    linkAt(output, "jobs/j-link", join(root, "gone"));
    linkAt(output, "packages/p-link", join(root, "gone"));
    // A stray link and a stray file at the output root itself: the link is a
    // symlinks count of the walk that found it; the file is not a slug and is
    // not a category, so it is nobody's count.
    linkAt(output, "stray-link", join(root, "gone"));
    writeAt(output, "notes.txt", "x\n");

    // One real slug directory: one file a report names, one orphan, a nested
    // render, and one packages subtree.
    writeAt(output, "camp-a/report-target.png", "png\n");
    writeAt(output, "camp-a/orphan.png", "png\n");
    writeAt(output, "camp-a/sub/nested.png", "png\n");
    writeAt(output, "camp-a/packages/platform/x.zip", "zip\n");
    linkAt(output, "camp-a/packages/p-link", join(root, "gone"));
    writeAt(briefs, "camp-a/drafts/u1.json", "{}");
    linkAt(briefs, "camp-a/drafts/d-link", join(root, "gone"));

    const census = await assembleCensus(
      context(root),
      scanInput(briefs),
      new Set([join(output, "camp-a/report-target.png")]),
    );

    expect(Object.keys(census).sort()).toEqual(
      [
        "backgroundCache",
        "drafts",
        "jobs",
        "lastOpened",
        "legacyReportPointer",
        "nonBriefFiles",
        "orphanRenders",
        "packages",
        "providerKeys",
        "refusedBriefs",
        "samples",
        "templates",
        "usage",
      ].sort(),
    );
    expect(census.jobs).toEqual({ count: 1, symlinks: 1 });
    // The cache file is counted EXACTLY once: under the background cache, and
    // never also as an orphan render, because `cache` is a reserved top-level
    // name the slug walk never descends into.
    expect(census.backgroundCache).toEqual({ count: 1 });
    expect(census.orphanRenders).toEqual({
      count: 2,
      symlinks: 1,
    });
    expect(census.drafts).toEqual({ count: 1, symlinks: 1 });
    expect(census.lastOpened).toEqual({ count: 1 });
    expect(census.packages).toEqual({ count: 2, symlinks: 2 });
    expect(census.legacyReportPointer).toEqual({ count: 1 });
    expect(census.nonBriefFiles).toEqual({
      count: 1,
      // The ghost link is recorded ONLY by `symlinks`: its name is not a file
      // the tree holds, so it is not beside the one that is.
      names: ["README.md"],
      symlinks: 1,
    });
    expect(census.refusedBriefs).toEqual({ count: 1 });
    expect(census.samples).toEqual({ count: 2 });
    for (const key of ["usage", "providerKeys", "templates"] as const) {
      expect(census[key]).toEqual({
        count: 0,
        note: "pg-only or in-memory; nothing on disk to import",
      });
    }
  });

  test("req 14: a symlinked directory inside a category is counted under symlinks, not followed", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(briefs, "camp-b.yaml", "id: camp-b\n");
    writeAt(output, "camp-b/orphan.png", "png\n");
    const elsewhere = join(root, "elsewhere");
    writeAt(elsewhere, "hidden.png", "png\n");
    linkAt(output, "camp-b/dir-link", elsewhere);

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    expect(census.orphanRenders).toEqual({
      count: 1,
      symlinks: 1,
    });
  });

  test("a category root that cannot be listed is a per-category refusal, not a throw", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(join(root, "briefs"), "camp-c.yaml", "id: camp-c\n");
    // `jobs` as a FILE: a readdir on it raises ENOTDIR, which the category must
    // answer with a refusal instead of ending the run.
    writeAt(output, "jobs", "not a directory\n");

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    // `jobs` as a FILE: the ROOT lstat answers "is not a directory." instead of
    // letting the readdir raise ENOTDIR.
    expect(census.jobs).toEqual({
      count: 0,
      refusal: expect.stringContaining("is not a directory."),
    });
    expect(census.orphanRenders.count).toBe(0);
  });

  test("a sample sidecar directory is not mistaken for a slug, and census samples follow the flag", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    // A campaign directory with no drafts: the draft count stays 0 (no refusal).
    mkdirSync(join(briefs, "camp-plain"), { recursive: true });
    writeAt(output, "camp-a/orphan.png", "png\n");
    // A skipped sample's two halves: the `briefs/sample-x/` SIDECAR directory
    // and its `<output>/sample-x/` output directory — neither is a campaign,
    // neither is a non-brief file, neither carries drafts, and the sample
    // itself is counted once, under `samples`.
    mkdirSync(join(briefs, "sample-x"), { recursive: true });
    mkdirSync(join(output, "sample-x"), { recursive: true });

    const skipped = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 3, imported: 0 } },
      new Set(),
    );
    expect(skipped.samples).toEqual({ count: 3 });
    expect(skipped.drafts).toEqual({ count: 0 });
    expect(skipped.nonBriefFiles).toEqual({ count: 0 });
    // The empty `<output>/sample-x/` is walked as a slug with nothing in it:
    // no file, no count, no refusal — it is nobody's render.
    expect(skipped.orphanRenders).toEqual({ count: 1 });

    const imported = await assembleCensus(
      { ...context(root), includeSamples: true },
      { refusals: [], samples: { skipped: 0, imported: 3 } },
      new Set(),
    );
    expect(imported.samples).toEqual({ count: 3 });
  });

  test("a census over a tree with NO output root and NO briefs answers every category 0", async () => {
    root = makeRoot();

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    // An absent root is simply nothing to count — no refusal, never a throw.
    expect(census.orphanRenders).toEqual({ count: 0 });
    expect(census.jobs).toEqual({ count: 0 });
    expect(census.backgroundCache).toEqual({ count: 0 });
    expect(census.packages).toEqual({ count: 0 });
    expect(census.legacyReportPointer).toEqual({ count: 0 });
    expect(census.drafts).toEqual({ count: 0 });
    expect(census.nonBriefFiles).toEqual({ count: 0 });
    expect(census.lastOpened).toEqual({ count: 0 });
  });

  test("a census whose output root cannot be listed is refusals, not a throw", async () => {
    root = makeRoot();
    // The output ROOT as a FILE: every category under it answers with its own
    // refusal, and the pointer file's lstat raises ENOTDIR too.
    writeAt(root, "output", "not a directory\n");

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    expect(census.orphanRenders).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
    });
    expect(census.jobs).toEqual({
      count: 0,
      refusal: expect.stringContaining("ENOTDIR"),
    });
    expect(census.legacyReportPointer).toEqual({
      count: 0,
      refusal: expect.stringContaining("ENOTDIR"),
    });
  });

  test("a slug directory that cannot be listed is the orphan category's refusal", async () => {
    root = makeRoot();
    const output = join(root, "output");
    writeAt(join(root, "briefs"), "camp-x.yaml", "id: camp-x\n");
    writeAt(output, "camp-x/orphan.png", "png\n");
    writeAt(output, "camp-x/packages/p.zip", "zip\n");
    // The listing happens at the output root, so the slug dir is only unread
    // afterwards — chmod 000 is what makes THIS readdir fail (EACCES).
    chmodSync(join(output, "camp-x"), 0o000);

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );
    // Put the mode back FIRST: the cleanup must be able to remove the tree.
    chmodSync(join(output, "camp-x"), 0o700);

    expect(census.orphanRenders).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
    });

    // The slug dir readable again but its packages subtree locked: the
    // refusal lands on the PACKAGES count, not on the orphan one.
    chmodSync(join(output, "camp-x", "packages"), 0o000);
    const packagesLocked = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );
    chmodSync(join(output, "camp-x", "packages"), 0o700);
    expect(packagesLocked.orphanRenders.count).toBe(1);
    expect(packagesLocked.packages).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
    });
  });

  test("a refusal inside a category keeps the symlinks it saw before it", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const cache = join(output, "cache");
    writeAt(cache, "x.png", "png\n");
    linkAt(cache, "l-link", join(root, "gone"));
    mkdirSync(join(cache, "locked"), { recursive: true });
    chmodSync(join(cache, "locked"), 0o000);

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );
    chmodSync(join(cache, "locked"), 0o700);

    expect(census.backgroundCache).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
      symlinks: 1,
    });
  });

  test("a symlinked category ROOT is counted as a link, never read through", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    // The target the links point at: real files a following walk WOULD count.
    writeAt(join(root, "outside"), "secret.txt", "top secret\n");
    linkAt(output, "jobs", join(root, "outside"));
    writeAt(output, "camp-a/orphan.png", "png\n");
    linkAt(briefs, "camp-a/drafts", join(root, "outside"));

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    expect(census.jobs).toEqual({ count: 0, symlinks: 1 });
    expect(census.drafts).toEqual({ count: 0, symlinks: 1 });
  });

  test("briefs/ as a file is a refusal on the two categories that read it", async () => {
    root = makeRoot();
    writeAt(root, "briefs", "not a directory\n");

    const census = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );

    expect(census.drafts).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
    });
    expect(census.nonBriefFiles).toEqual({
      count: 0,
      refusal: expect.stringContaining("could not be read"),
    });
  });

  test("the retired pointer as a directory is a refusal; a symlink is a symlinks count", async () => {
    root = makeRoot();
    writeAt(join(root, "output"), "report.json/x", "x\n");
    const notFile = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );
    expect(notFile.legacyReportPointer).toEqual({
      count: 0,
      refusal: expect.stringContaining("is not a regular file."),
    });

    dropRoot(root);
    root = makeRoot();
    linkAt(join(root, "output"), "report.json", join(root, "gone"));
    const linked = await assembleCensus(
      context(root),
      { refusals: [], samples: { skipped: 0, imported: 0 } },
      new Set(),
    );
    expect(linked.legacyReportPointer).toEqual({ count: 0, symlinks: 1 });
  });
});
