import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { hashBytes } from "../../brief-files.js";
import { digestSourceFiles, planDigest } from "../digest.js";
import type { DigestInputs } from "../digest.js";
import type { ScanResult } from "../scan.js";
import type { StepContext } from "../steps.js";
import { PNG, dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

/**
 * PT-8a req 19 (D225): the digest names WHAT the plan read and WHEN it was
 * planned. Two runs over byte-identical trees with the same org, instant and
 * samples flag agree; one byte changed anywhere in a source file, or a
 * different `--switched-at` over an identical tree, does not.
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

function campaign(
  slug: string,
  briefPath: string,
  refs: ScanResult["campaigns"][number]["refs"] = [],
) {
  return {
    slug,
    sourcePath: briefPath,
    name: null,
    type: null,
    brief: {} as never,
    refs,
    sample: false,
  };
}

describe("digestSourceFiles (req 19's file set)", () => {
  let root: string | undefined;

  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("the file set is every source file the plan reads, rel'd to its own root", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(root, "assets/inputs/logo.png", PNG);
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    writeAt(briefs, "camp-a/campaign.json", '{"name":"A"}');
    writeAt(briefs, "camp-a/pools.json", "{}");
    writeAt(output, "reports/camp-a.json", "{}");
    writeAt(output, "decisions/camp-a.json", "{}");
    // A second campaign with no sidecars at all: only its brief can enter.
    writeAt(briefs, "camp-bare.yaml", "id: camp-bare\n");
    // A campaign whose parent directory is a symlink: its pool is refused, so
    // the bytes behind the link never enter the digest.
    writeAt(join(root, "elsewhere"), "pools.json", "{}");
    writeAt(briefs, "camp-link.yaml", "id: camp-link\n");
    linkAt(briefs, "camp-link", join(root, "elsewhere"));
    // Refusals: a parse-failed brief (a regular file — in), the briefs
    // directory itself (not a file — out), a path that does not exist (out),
    // and one under the output root (deduplicated with the campaign's own add).
    writeAt(briefs, "broken.yaml", "not a brief\n");

    const scan: ScanResult = {
      campaigns: [
        campaign("camp-a", join(briefs, "camp-a.yaml"), [
          { ref: "assets/inputs/logo.png", kind: "root-level" },
          { ref: "assets/inputs/gone.png", kind: "missing", reason: "no file" },
        ]),
        campaign("camp-bare", join(briefs, "camp-bare.yaml")),
        campaign("camp-link", join(briefs, "camp-link.yaml")),
      ],
      refusals: [
        { slug: null, sourcePath: join(briefs, "broken.yaml"), reason: "parse failed" },
        { slug: null, sourcePath: briefs, reason: "briefs/ could not be read: boom" },
        { slug: null, sourcePath: join(output, "reports/camp-a.json"), reason: "x" },
        { slug: null, sourcePath: join(root, "never-existed.yaml"), reason: "x" },
      ],
      samples: { skipped: 0, imported: 0 },
    };

    const files = await digestSourceFiles(context(root), scan);

    expect(files.map((one) => one.rel).sort()).toEqual([
      "assets/inputs/logo.png",
      "briefs/broken.yaml",
      "briefs/camp-a.yaml",
      "briefs/camp-a/campaign.json",
      "briefs/camp-a/pools.json",
      "briefs/camp-bare.yaml",
      "briefs/camp-link.yaml",
      "decisions/camp-a.json",
      "reports/camp-a.json",
    ]);
    expect(files.find((one) => one.rel === "assets/inputs/logo.png")).toMatchObject({
      sha256: hashBytes(PNG),
    });
  });
});

describe("planDigest (req 19)", () => {
  const file = (rel: string): { rel: string; sha256: string } => ({
    rel,
    sha256: "0".repeat(64),
  });

  const inputs = (over: Partial<DigestInputs> = {}): DigestInputs => ({
    files: [file("briefs/camp-a.yaml"), file("briefs/camp-a/campaign.json")],
    orgId: "local",
    switchedAt: "2026-10-01T00:00:00.000Z",
    includeSamples: false,
    ...over,
  });

  test("stability: two runs over the same inputs agree, whatever order the files arrive in", () => {
    const first = planDigest(inputs());
    // Reversed order exercises the sort's other arm...
    expect(planDigest(inputs({ files: [...inputs().files].reverse() }))).toBe(first);
    // ...and a caller's duplicated rel is stable over every interleaving too.
    const base = inputs().files;
    const dup = planDigest(inputs({ files: [file("briefs/camp-a.yaml"), ...base] }));
    const interleaved = planDigest(
      inputs({ files: [file("briefs/camp-a.yaml"), base[0]!, base[1]!] }),
    );
    expect(interleaved).toBe(dup);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("content-sensitivity: a one-byte change in a source file changes the digest", () => {
    const before = planDigest(inputs());
    const changed = inputs({
      files: [
        { rel: "briefs/camp-a.yaml", sha256: "1".repeat(64) },
        file("briefs/camp-a/campaign.json"),
      ],
    });
    expect(planDigest(changed)).not.toBe(before);
  });

  test("switched-at-sensitivity: a different instant over an identical tree changes the digest", () => {
    const before = planDigest(inputs());
    expect(planDigest(inputs({ switchedAt: "2026-11-01T00:00:00.000Z" }))).not.toBe(before);
    expect(planDigest(inputs({ orgId: "acme" }))).not.toBe(before);
    expect(planDigest(inputs({ includeSamples: true }))).not.toBe(before);
  });
});
