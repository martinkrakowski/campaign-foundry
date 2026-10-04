import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief } from "@campaignfoundry/shared";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

/**
 * A legacy tree on disk, for PT-8a's scan and classification.
 *
 * **Every brief here is written through `dumpBrief`, the serializer `createBrief` uses**,
 * so a fixture is a real brief by construction rather than by hand-checked YAML that a
 * schema change could quietly invalidate. The one exception is the retired-`html` layer,
 * which no serializer will ever emit — it is a string edit on real output, because that
 * is exactly what an operator's legacy tree contains.
 */

/** A 1x1 PNG, the bytes `assets/inputs/` fixtures are made of. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Not audio, not an image: the bytes a `.png` must be refused on (D222's magic rule). */
export const NOT_A_PNG = Buffer.from("this is not an image, whatever the extension says\n");

/** A bare MPEG frame sync, which is what `hasMp3Magic` accepts without an ID3 tag. */
export const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(64, 0x00)]);

/** A file one byte over the 2 MiB cap. The bytes are irrelevant: size is checked first. */
export const OVER_SIZE = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);

/** A temp project root, removed by {@link dropRoot}. */
export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "cf-import-"));
}

export function dropRoot(root: string | undefined): void {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
}

/** Write `bytes` at `<root>/<rel>`, creating the directories it needs. */
export function writeAt(root: string, rel: string, bytes: Buffer | string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/**
 * A brief file written from TEXT rather than from a serialized body.
 *
 * For the shapes `dumpBrief` will not emit and a test still needs on disk: a `logoPath`
 * that is not a string, a self-referencing YAML alias. Both are things a legacy tree
 * really contains, and neither survives a round trip through the domain type.
 */
export function writeRawBrief(root: string, file: string, yaml: string): string {
  return writeAt(root, join("briefs", file), yaml);
}

/** A symlink at `<root>/<rel>` pointing at `target`. Used for the symlink refusals. */
export function linkAt(root: string, rel: string, target: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

/** The fields every fixture brief shares, so a test states only what it is about. */
export type BriefOverrides = Partial<CampaignBrief> & { readonly id: string };

export function briefBody(overrides: BriefOverrides): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    targetRegion: "DE",
    targetAudience: "aud",
    campaignMessage: "Hello",
    products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" }],
    ...overrides,
  } as CampaignBrief;
}

/** The bytes a fixture brief file holds — the same text a write to `briefs/` would put there. */
export function briefYaml(overrides: BriefOverrides): string {
  return dumpBrief(briefBody(overrides));
}

/** A valid brief file, serialized the way the store writes one. */
export function writeBrief(root: string, file: string, overrides: BriefOverrides): string {
  return writeAt(root, join("briefs", file), briefYaml(overrides));
}

/**
 * A brief carrying the retired `kind: "html"` layer, which `load-brief.ts:270-272` refuses
 * at parse time. Produced by editing real `dumpBrief` output rather than hand-writing
 * YAML, because this is the ONE shape a serializer will not emit.
 */
export function writeHtmlLayerBrief(root: string, file: string, id: string): string {
  return writeAt(
    root,
    join("briefs", file),
    briefYaml({ id }).replace("kind: static-text", "kind: html"),
  );
}

/** The parser's own message for that layer, so a test asserts the real refusal. */
export const HTML_LAYER_REFUSAL =
  'Campaign brief field "template.layers[3].kind" "html" is retired; delete the layer and ' +
  "author the copy as a static-text layer.";

/** `briefs/<slug>/campaign.json`, the name/type an import writes through `createCampaign`. */
export function writeCampaignMeta(root: string, slug: string, meta: unknown): string {
  return writeAt(root, join("briefs", slug, "campaign.json"), JSON.stringify(meta));
}
