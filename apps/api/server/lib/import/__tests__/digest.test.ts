import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { MAX_IMPORT_JSON_BYTES } from "../census.js";
import { hashBytes } from "../../brief-files.js";
import { digestSourceFiles, planDigest } from "../digest.js";
import type { DigestInputs } from "../digest.js";
import type { ScanResult } from "../scan.js";
import type { StepContext } from "../steps.js";
import { NOT_A_PNG, PNG, dropRoot, linkAt, makeRoot, writeAt } from "./fixtures/tree.js";

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
): ScanResult["campaigns"][number] {
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

const EMPTY_SCAN: ScanResult = {
  campaigns: [],
  refusals: [],
  samples: { skipped: 0, imported: 0 },
};

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
    // A campaign whose parent directory is a symlink: its sidecars are
    // refused, so the bytes behind the link never enter the digest.
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

    const files = await digestSourceFiles(context(root), scan, new Set());

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

  test("a symlinked briefs/<slug>/ hashes neither pools.json nor campaign.json", async () => {
    root = makeRoot();
    const briefs = join(root, "briefs");
    writeAt(briefs, "camp-link.yaml", "id: camp-link\n");
    // Real sidecars, reachable only THROUGH the symlinked briefs/<slug> dir.
    writeAt(join(root, "elsewhere"), "campaign.json", '{"name":"X"}');
    writeAt(join(root, "elsewhere"), "pools.json", "{}");
    linkAt(briefs, "camp-link", join(root, "elsewhere"));

    const files = await digestSourceFiles(
      context(root),
      {
        campaigns: [campaign("camp-link", join(briefs, "camp-link.yaml"))],
        refusals: [],
        samples: { skipped: 0, imported: 0 },
      },
      new Set(),
    );

    // The link is never followed, so the bytes behind it are not what the plan
    // read: neither sidecar enters the digest.
    expect(files.map((one) => one.rel).sort()).toEqual(["briefs/camp-link.yaml"]);
  });

  test("a campaign with no briefs/<slug>/ dir still has its report and refs covered", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const briefs = join(root, "briefs");
    writeAt(briefs, "camp-bare.yaml", "id: camp-bare\n");
    writeAt(output, "reports/camp-bare.json", "{}");
    writeAt(root, "assets/inputs/logo.png", PNG);

    // The report exists and the clean ref resolves, with NO sidecar directory
    // at all: both must enter the digest — a plan whose report moves is a
    // different plan, sidecar or not.
    const files = await digestSourceFiles(
      context(root),
      {
        campaigns: [
          campaign("camp-bare", join(briefs, "camp-bare.yaml"), [
            { ref: "assets/inputs/logo.png", kind: "root-level" },
          ]),
        ],
        refusals: [],
        samples: { skipped: 0, imported: 0 },
      },
      new Set(),
    );

    expect(files.map((one) => one.rel).sort()).toEqual([
      "assets/inputs/logo.png",
      "briefs/camp-bare.yaml",
      "reports/camp-bare.json",
    ]);
  });

  test("a planned render enters as a FINGERPRINT, and a size or mtime change changes the digest", async () => {
    root = makeRoot();
    const output = join(root, "output");
    const render = writeAt(output, "camp-a/out.png", "v1\n");
    const planned = new Set([render]);
    const digestOf = async (): Promise<string> =>
      planDigest({
        files: await digestSourceFiles(context(root!), EMPTY_SCAN, planned),
        orgId: "local",
        switchedAt: "2026-10-01T00:00:00.000Z",
        includeSamples: false,
      });

    const before = await digestOf();
    const files = await digestSourceFiles(context(root), EMPTY_SCAN, planned);
    expect(files).toEqual([
      { rel: "camp-a/out.png", fingerprint: expect.stringMatching(/^size:\d+:mtime:\d+$/) },
    ]);

    // A SIZE change (new bytes) changes the fingerprint, so the digest.
    writeAt(output, "camp-a/out.png", "v1 with more bytes\n");
    expect(await digestOf()).not.toBe(before);

    // An MTIME change over the same size (rewritten in place, same length).
    const sameLength = writeAt(output, "camp-a/out.png", "v2.........\n");
    expect(sameLength).toBe(render);
    await new Promise((resolve) => setTimeout(resolve, 5));
    utimesSync(render, new Date(), new Date());
    expect(await digestOf()).not.toBe(before);
  });

  test("a render larger than the read cap is still fingerprinted, and never read", async () => {
    root = makeRoot();
    const output = join(root, "output");
    // 8 MiB + 1: readBounded would refuse to read it, so a content hash could
    // never cover it — the fingerprint must, without a read.
    writeAt(output, "camp-a/huge.mp4", Buffer.alloc(MAX_IMPORT_JSON_BYTES + 1, 0x41));
    const planned = new Set([join(output, "camp-a/huge.mp4")]);

    const files = await digestSourceFiles(context(root), EMPTY_SCAN, planned);

    expect(files).toEqual([
      {
        rel: "camp-a/huge.mp4",
        fingerprint: expect.stringContaining(`size:${MAX_IMPORT_JSON_BYTES + 1}:`),
      },
    ]);
  });

  test("a refused asset enters as a FINGERPRINT, and its bytes changing changes the digest", async () => {
    root = makeRoot();
    const asset = writeAt(root, "assets/inputs/bad.png", NOT_A_PNG);
    const mkScan = (): ScanResult => ({
      campaigns: [
        campaign("camp-a", join(root!, "briefs", "camp-a.yaml"), [
          { ref: "assets/inputs/bad.png", kind: "refused-file", reason: "not a PNG" },
        ]),
      ],
      refusals: [],
      samples: { skipped: 0, imported: 0 },
    });
    writeAt(join(root, "briefs"), "camp-a.yaml", "id: camp-a\n");
    const digestOf = async (): Promise<string> =>
      planDigest({
        files: await digestSourceFiles(context(root!), mkScan(), new Set()),
        orgId: "local",
        switchedAt: "2026-10-01T00:00:00.000Z",
        includeSamples: false,
      });

    const before = await digestOf();
    expect(
      (await digestSourceFiles(context(root), mkScan(), new Set())).find(
        (one) => one.rel === "assets/inputs/bad.png",
      ),
    ).toMatchObject({ fingerprint: expect.stringMatching(/^size:\d+:mtime:\d+$/) });

    // A post-plan edit to the refused asset is a different digest.
    writeAt(root, "assets/inputs/bad.png", Buffer.concat([NOT_A_PNG, Buffer.from("x")]));
    expect(await digestOf()).not.toBe(before);
    expect(asset).toBe(join(root, "assets/inputs/bad.png"));
  });

  test("a refused asset that is absent, a link, a directory, behind a link, or unread is skipped", async () => {
    root = makeRoot();
    const briefs = join(root, "briefs");
    const ref = (name: string): ScanResult => ({
      campaigns: [
        campaign("camp-a", join(briefs, "camp-a.yaml"), [
          { ref: `assets/inputs/${name}`, kind: "refused-file", reason: "not a PNG" },
        ]),
      ],
      refusals: [],
      samples: { skipped: 0, imported: 0 },
    });

    // Absent: nothing to fingerprint. (The campaign's brief is always hashed;
    // every assertion below is that the REFUSED ASSET adds nothing to it.)
    writeAt(briefs, "camp-a.yaml", "id: camp-a\n");
    expect(
      (await digestSourceFiles(context(root), ref("gone.png"), new Set())).map((one) => one.rel),
    ).toEqual(["briefs/camp-a.yaml"]);

    // A symlink: never followed, never fingerprinted.
    writeAt(join(root, "elsewhere"), "linked.png", "png\n");
    linkAt(root, "assets/inputs/linked.png", join(root, "elsewhere/linked.png"));
    expect(
      (await digestSourceFiles(context(root), ref("linked.png"), new Set())).map((one) => one.rel),
    ).toEqual(["briefs/camp-a.yaml"]);

    // A directory: not a file.
    writeAt(root, "assets/inputs/a-dir/inside.png", "png\n");
    expect(
      (await digestSourceFiles(context(root), ref("a-dir"), new Set())).map((one) => one.rel),
    ).toEqual(["briefs/camp-a.yaml"]);

    // Reached THROUGH a symlinked directory: not the file the tree holds.
    writeAt(join(root, "elsewhere"), "behind.png", "png\n");
    linkAt(root, "assets/inputs/linkdir", join(root, "elsewhere"));
    expect(
      (await digestSourceFiles(context(root), ref("linkdir/behind.png"), new Set())).map(
        (one) => one.rel,
      ),
    ).toEqual(["briefs/camp-a.yaml"]);

    // An unreadable parent (EACCES on lstat): skipped, never a throw.
    mkdirSync(join(root, "assets/inputs/locked"), { recursive: true });
    writeAt(root, "assets/inputs/locked/bad.png", NOT_A_PNG);
    chmodSync(join(root, "assets/inputs/locked"), 0o000);
    expect(
      (await digestSourceFiles(context(root), ref("locked/bad.png"), new Set())).map(
        (one) => one.rel,
      ),
    ).toEqual(["briefs/camp-a.yaml"]);
    chmodSync(join(root, "assets/inputs/locked"), 0o700);
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

  test("a fingerprint entry digests exactly like a sha256 entry of the same rel", () => {
    const fingerprinted = planDigest({
      files: [{ rel: "camp-a/out.png", fingerprint: "size:4:mtime:1000" }],
      orgId: "local",
      switchedAt: "2026-10-01T00:00:00.000Z",
      includeSamples: false,
    });
    const again = planDigest({
      files: [{ rel: "camp-a/out.png", fingerprint: "size:4:mtime:1000" }],
      orgId: "local",
      switchedAt: "2026-10-01T00:00:00.000Z",
      includeSamples: false,
    });
    expect(fingerprinted).toBe(again);
    expect(
      planDigest({
        files: [{ rel: "camp-a/out.png", fingerprint: "size:5:mtime:1000" }],
        orgId: "local",
        switchedAt: "2026-10-01T00:00:00.000Z",
        includeSamples: false,
      }),
    ).not.toBe(fingerprinted);
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
