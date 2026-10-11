import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { bodyDrift, ownInputs } from "../normalise-inputs.js";
import type { StepContext } from "../steps.js";
import {
  MP3,
  NOT_A_PNG,
  OVER_SIZE,
  PNG,
  dropRoot,
  linkAt,
  makeRoot,
  writeAt,
} from "./fixtures/tree.js";

function ctxWith(root: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date("2026-10-01T00:00:00Z"),
    projectRoot: root,
    outputRoot: join(root, "output"),
    includeSamples: false,
    fsOnly: false,
  };
}

describe("ownInputs: a live campaign's own input files against the upload rules", () => {
  let root: string | undefined;
  afterEach(() => {
    dropRoot(root);
    root = undefined;
  });

  test("every file that passes the upload rules is listed ok, in name order, with the path to read", () => {
    root = makeRoot();
    const logo = writeAt(root, "assets/inputs/camp/logo.png", PNG);
    const bed = writeAt(root, "assets/inputs/camp/bed.mp3", MP3);
    writeAt(root, "assets/inputs/other/logo.png", PNG);
    writeAt(root, "assets/inputs/root.png", PNG);
    expect(ownInputs(ctxWith(root), "camp")).toEqual([
      { name: "bed.mp3", ref: "assets/inputs/camp/bed.mp3", state: "ok", path: bed },
      { name: "logo.png", ref: "assets/inputs/camp/logo.png", state: "ok", path: logo },
    ]);
  });

  test("a campaign with no inputs folder has no own inputs", () => {
    root = makeRoot();
    writeAt(root, "assets/inputs/root.png", PNG);
    expect(ownInputs(ctxWith(root), "camp")).toEqual([]);
  });
  test("a file that fails a rule is listed failed with the rule's reason, beside the ones that pass", () => {
    root = makeRoot();
    const good = writeAt(root, "assets/inputs/camp/good.png", PNG);
    writeAt(root, "assets/inputs/camp/Logo.PNG", PNG);
    writeAt(root, "assets/inputs/camp/big.png", OVER_SIZE);
    writeAt(root, "assets/inputs/camp/notpng.png", NOT_A_PNG);
    writeAt(root, "assets/inputs/camp/sub/inner.png", PNG);
    linkAt(root, "assets/inputs/camp/link.png", good);
    const failed = (name: string, reason: string) => ({
      name,
      ref: `assets/inputs/camp/${name}`,
      state: "failed",
      reason,
    });
    expect(ownInputs(ctxWith(root), "camp")).toEqual([
      failed(
        "Logo.PNG",
        '"Logo.PNG" is not a path-safe asset name (lower-case, .png/.jpg/.jpeg/.mp3/.m4a).',
      ),
      failed("big.png", '"big.png" is over the 2097152-byte (2 MiB) limit.'),
      { name: "good.png", ref: "assets/inputs/camp/good.png", state: "ok", path: good },
      failed("link.png", "the ref is a symlink; the importer never follows one"),
      failed("notpng.png", '"notpng.png" is not a PNG or JPEG file.'),
      failed("sub", '"sub" is not a regular file.'),
    ]);
  });

  test("a symlinked inputs folder is never read through: every entry is failed", () => {
    root = makeRoot();
    writeAt(root, "elsewhere/logo.png", PNG);
    linkAt(root, "assets/inputs/camp", join(root, "elsewhere"));
    expect(ownInputs(ctxWith(root), "camp")).toEqual([
      {
        name: "logo.png",
        ref: "assets/inputs/camp/logo.png",
        state: "failed",
        reason: '"inputs/camp" is a symlinked directory; the importer never follows one',
      },
    ]);
  });

  test("an inputs folder that cannot be listed throws; it is not an empty list", () => {
    root = makeRoot();
    writeAt(root, "assets/inputs/camp", PNG);
    const ctx = ctxWith(root);
    expect(() => ownInputs(ctx, "camp")).toThrow(/ENOTDIR/);
  });
});

describe("bodyDrift: would the normalise change a stored body outside its refs", () => {
  const brief = { id: "camp", products: [{ id: "p1", logoPath: "assets/inputs/a.png" }] };
  const asBrief = brief as unknown as CampaignBrief;
  const body = JSON.stringify(brief);

  test("a body that is exactly what the brief serialises to has no drift", () => {
    expect(bodyDrift(body, asBrief)).toBeUndefined();
  });

  test("a body with the same content in another key order, or with other spacing, drifts", () => {
    const reordered = JSON.stringify({ products: brief.products, id: "camp" });
    expect(reordered).toHaveLength(body.length);
    expect(bodyDrift(reordered, asBrief)).toBe(
      "the stored body is not what the import would write back (first difference at character 2): " +
        "normalising would change more than the refs",
    );
    expect(bodyDrift(JSON.stringify(brief, null, 1), asBrief)).toMatch(
      /first difference at character 1\)/,
    );
  });

  test("a body that is longer or shorter than the serialised brief drifts at the shorter one's end", () => {
    expect(bodyDrift(`${body} `, asBrief)).toMatch(
      new RegExp(`first difference at character ${body.length}\\)`),
    );
    expect(bodyDrift(body.slice(0, -1), asBrief)).toMatch(
      new RegExp(`first difference at character ${body.length - 1}\\)`),
    );
  });
});
