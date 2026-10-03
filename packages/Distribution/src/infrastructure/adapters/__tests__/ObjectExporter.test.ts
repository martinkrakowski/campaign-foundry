import { describe, test, expect, beforeEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { ObjectExporter, renderObjectKey } from "../ObjectExporter.js";

const ORG = "acme";
const CAMPAIGN = "3f1b7a52-0c4d-4a6e-9b21-5d8e7c6a5b4c";
const OTHER_CAMPAIGN = "00000000-0000-4000-8000-000000000001";
const PREFIX = `org/${ORG}/campaign/${CAMPAIGN}/renders/`;
const OTHER_PREFIX = `org/globex/campaign/${OTHER_CAMPAIGN}/renders/`;
const SLUG = "summer-launch";

/** A small valid PNG, for both a render and the proof's embedded image. */
const png = (): Uint8Array => {
  const c = createCanvas(8, 8);
  const g = c.getContext("2d");
  g.fillStyle = "#1473E6";
  g.fillRect(0, 0, 8, 8);
  return c.toBuffer("image/png");
};

describe("renderObjectKey", () => {
  test("drops the campaign segment and joins the rest onto the prefix", () => {
    // The two shapes the use case produces: a variant still (`<slug>/…`) and a
    // proof (`<slug>/proofs/…`, PT-4e's second example).
    expect(renderObjectKey(PREFIX, SLUG, `${SLUG}/alpha/1x1/v1.png`)).toBe(
      `${PREFIX}alpha/1x1/v1.png`,
    );
    expect(renderObjectKey(PREFIX, SLUG, `${SLUG}/proofs/alpha.pdf`)).toBe(
      `${PREFIX}proofs/alpha.pdf`,
    );
    // The html bundle's own two files, nested under a treatment directory.
    expect(renderObjectKey(PREFIX, SLUG, `${SLUG}/beta/9x16/headline-bottom/fallback.png`)).toBe(
      `${PREFIX}beta/9x16/headline-bottom/fallback.png`,
    );
  });

  test("REFUSES a path whose leading segment is another campaign's", () => {
    // The blind-strip implementation answers this with a key and writes one
    // campaign's bytes into another campaign's prefix. Nothing else could see
    // it: the report names the prefix's campaign, and the bytes are the other's.
    expect(() => renderObjectKey(PREFIX, SLUG, "other-camp/alpha/1x1.png")).toThrow(
      /Refusing an object key: a render path must start with the campaign segment/,
    );
    // A leading slash is an empty first segment, so it fails the same check.
    expect(() => renderObjectKey(PREFIX, SLUG, `/${SLUG}/alpha.png`)).toThrow(
      /Refusing an object key/,
    );
  });

  test("REFUSES a traversal rather than resolving it", () => {
    // The composed key goes through `assertObjectKey`, which is what catches a
    // `..` that would climb out of `renders/` and out of the prefix the report
    // names. It is the FIRST segment's check that catches `…/camp/../camp/…`.
    expect(() => renderObjectKey(PREFIX, SLUG, `${SLUG}/alpha/../../escape.png`)).toThrow(
      /must not contain a "\.\." segment/,
    );
    expect(() => renderObjectKey(PREFIX, SLUG, `${SLUG}/./alpha.png`)).toThrow(
      /must not contain a "\." segment/,
    );
    expect(() => renderObjectKey(PREFIX, SLUG, `${SLUG}/${SLUG}/../escape.png`)).toThrow(
      /must not contain a "\.\." segment/,
    );
  });

  test("REFUSES a path that names nothing below its campaign", () => {
    // The campaign segment ALONE is the whole renders prefix, and a `remove` of
    // that key would empty the campaign.
    expect(() => renderObjectKey(PREFIX, SLUG, SLUG)).toThrow(
      /must name something below its campaign/,
    );
    // A trailing separator is the same path with one more empty segment: a key
    // with an empty segment is refused by the port's own rule.
    expect(() => renderObjectKey(PREFIX, SLUG, `${SLUG}/`)).toThrow(/Refusing an object key/);
  });

  test("never echoes the path it refused", () => {
    // The slug is in every path the use case builds; a refusal that quoted it
    // would put a user-chosen string into whatever logged the throw.
    let thrown: unknown;
    try {
      renderObjectKey(PREFIX, SLUG, "MARKER-7f3a/alpha.png");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("MARKER-7f3a");
  });
});

describe("ObjectExporter", () => {
  let store: InMemoryObjectStore;
  let exporter: ObjectExporter;
  /** Every key under this campaign's renders, in store order. */
  const keys = () => store.list(PREFIX).then((entries) => entries.map((entry) => entry.key));

  beforeEach(() => {
    store = new InMemoryObjectStore();
    exporter = new ObjectExporter(store, { prefix: PREFIX, campaignSegment: SLUG });
  });

  test("saveToDirectory round-trips the bytes under the right key and content type", async () => {
    const bytes = png();
    await exporter.saveToDirectory(bytes, `${SLUG}/alpha/1x1/v1.png`);
    const read = await store.get(`${PREFIX}alpha/1x1/v1.png`);
    expect(Buffer.from(read!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(read!.contentType).toBe("image/png");
  });

  test("an mp4 is stored as video/mp4, not as a PNG (the mutation's target)", async () => {
    // The motion variant's clip. A wrong type here is invisible on fs —
    // `writeFile` records none — so this assertion is the only place the
    // question is ever asked.
    const clip = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    await exporter.saveToDirectory(clip, `${SLUG}/alpha/9x16/v0.mp4`);
    expect((await store.get(`${PREFIX}alpha/9x16/v0.mp4`))!.contentType).toBe("video/mp4");
    expect((await store.head(`${PREFIX}alpha/9x16/v0.mp4`))!.contentType).toBe("video/mp4");
  });

  test("the html bundle and its fallback keep their own types", async () => {
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1/index.html`);
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1/fallback.png`);
    expect((await store.get(`${PREFIX}alpha/1x1/index.html`))!.contentType).toBe("text/html");
    expect((await store.get(`${PREFIX}alpha/1x1/fallback.png`))!.contentType).toBe("image/png");
  });

  test("generatePrintProof writes the same PDF the fs exporter writes", async () => {
    await exporter.generatePrintProof(png(), `${SLUG}/proofs/alpha.pdf`);
    const read = await store.get(`${PREFIX}proofs/alpha.pdf`);
    expect(Buffer.from(read!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(read!.bytes.length).toBeGreaterThan(100);
    expect(read!.contentType).toBe("application/pdf");
  });

  test("remove deletes the object and is idempotent", async () => {
    await exporter.saveToDirectory(new Uint8Array([1, 2, 3]), `${SLUG}/alpha/9x16/v0.mp4`);
    await exporter.remove(`${SLUG}/alpha/9x16/v0.mp4`);
    expect(await store.get(`${PREFIX}alpha/9x16/v0.mp4`)).toBeUndefined();
    await expect(exporter.remove(`${SLUG}/alpha/9x16/v0.mp4`)).resolves.toBeUndefined();
    await expect(exporter.remove(`${SLUG}/never/written.mp4`)).resolves.toBeUndefined();
  });

  test("every method refuses a foreign campaign's path, before any write", async () => {
    await expect(exporter.saveToDirectory(png(), "other/alpha.png")).rejects.toThrow(
      /must start with the campaign segment/,
    );
    await expect(exporter.generatePrintProof(png(), "other/proofs/alpha.pdf")).rejects.toThrow(
      /must start with the campaign segment/,
    );
    await expect(exporter.remove("other/alpha.png")).rejects.toThrow(
      /must start with the campaign segment/,
    );
    expect(await keys()).toEqual([]);
  });

  test("an extension with no declared content type is refused, not defaulted", async () => {
    // Defaulting would store happily and be downloaded rather than shown, with
    // nothing in the run's log — the one place that could have named the file.
    await expect(exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1/v1.webp`)).rejects.toThrow(
      "Refusing to export .webp: no content type is defined for it.",
    );
    await expect(exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1/v1`)).rejects.toThrow(
      "Refusing to export a path with no extension: no content type is defined for it.",
    );
    // A dot inside a DIRECTORY name is not this file's extension.
    await expect(exporter.saveToDirectory(png(), `${SLUG}/1.0/alpha.png`)).resolves.toBeUndefined();
    expect(await keys()).toEqual([`${PREFIX}1.0/alpha.png`]);
  });

  test("DoD 3: after a full export, no key carries the campaign's slug", async () => {
    // Every shape `GenerateCampaignUseCase` can hand this adapter in one
    // campaign: the still, the clip, the poster (the same key written twice),
    // the html bundle's two files and the proof.
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1.png`);
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/9x16/v0.mp4`);
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/9x16/v0.mp4`);
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/9x16/headline-bottom/index.html`);
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/9x16/headline-bottom/fallback.png`);
    await exporter.generatePrintProof(png(), `${SLUG}/proofs/alpha.pdf`);

    const written = await keys();
    expect(written).toHaveLength(5);
    for (const key of written) {
      expect(key).not.toContain(SLUG);
      expect(key.startsWith(PREFIX)).toBe(true);
    }
  });

  test("cross-tenant: an exporter built for one org writes only under that org", async () => {
    // Two orgs, one store, one run each. The prefix is the ONLY thing separating
    // them, so this is the case a key builder with no `org_id` would answer
    // wrongly. A second org answering *absent* is the right answer too: the two
    // campaigns are both named `summer-launch`, and one org must never see it.
    const other = new ObjectExporter(store, {
      prefix: OTHER_PREFIX,
      campaignSegment: SLUG,
    });
    await exporter.saveToDirectory(png(), `${SLUG}/alpha/1x1.png`);
    await other.saveToDirectory(png(), `${SLUG}/alpha/1x1.png`);

    expect(await keys()).toEqual([`${PREFIX}alpha/1x1.png`]);
    expect(await store.list(`${OTHER_PREFIX}`).then((e) => e.map((x) => x.key))).toEqual([
      `${OTHER_PREFIX}alpha/1x1.png`,
    ]);
    // And a remove from one leaves the other alone: the ids do not merely
    // partition the names, they partition the deletions.
    await exporter.remove(`${SLUG}/alpha/1x1.png`);
    expect(await store.get(`${OTHER_PREFIX}alpha/1x1.png`)).toBeDefined();
  });
});
