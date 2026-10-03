import {
  assertObjectKey,
  type ExportPort,
  type ObjectKey,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import { buildPrintProof } from "../print-proof.js";

/**
 * The content type each exportable extension is STORED with. A store that is
 * handed no type answers `application/octet-stream` on a later GET, which a
 * browser downloads rather than renders — so the type is part of the write, not
 * something the read side guesses.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".html": "text/html",
  ".pdf": "application/pdf",
};

/**
 * Where one campaign's renders go, and which leading path segment they are
 * allowed to carry.
 *
 * `campaignSegment` is the run's brief id — the slug — and it is kept ONLY to
 * be checked and then dropped. The use case builds every relative path through
 * `campaignScoped(brief.id, …)`, so this is the one value that ties a path to
 * the campaign whose prefix it will land under; holding it lets the adapter
 * REFUSE a path belonging to somebody else's campaign rather than writing those
 * bytes into this one's namespace, where the report would name them and the
 * bytes would be somebody else's.
 */
export interface ObjectExporterOptions {
  /** `org/<orgId>/campaign/<campaignId>/renders/`, from `renderPrefix`. */
  readonly prefix: string;
  /** The brief id every path this exporter accepts starts with. Never stored. */
  readonly campaignSegment: string;
}

/**
 * The one object key an export can produce: `prefix` plus everything the
 * relative path carries BELOW its campaign segment.
 *
 * **This is the only implementation, and both refusals are the point of it.**
 *
 * The obvious implementation is `prefix + relativePath.slice(campaignSegment.length + 1)`,
 * which is a blind strip: it takes whatever the caller passed at face value and
 * joins the remainder onto the prefix. That works for every path the use case
 * produces today and is wrong for every path it does not — a `campaignSegment`
 * of `camp` and a path of `other-camp/alpha/1x1.png` become the same key, so the
 * mismatch is invisible until one campaign's render is served to another. The
 * segment is therefore CHECKED against the one the prefix was built for, and
 * `..` is refused rather than resolved: a key that climbs out of `renders/` is
 * a key the campaign's prefix no longer describes.
 *
 * The empty remainder is refused too, and it is not a theoretical case: the
 * campaign segment alone is what a path that named no product would look like,
 * and `prefix` alone is the whole renders prefix — a `delete` of which would
 * empty the campaign.
 */
export function renderObjectKey(
  prefix: string,
  campaignSegment: string,
  relativePath: string,
): ObjectKey {
  const segments = relativePath.split("/");
  if (segments[0] !== campaignSegment) {
    // Never the path: it is the one string here that has not been through
    // anything, and it carries the slug a refusal must not echo into a log.
    throw new Error(
      "Refusing an object key: a render path must start with the campaign segment its prefix was built for.",
    );
  }
  const rest = segments.slice(1).join("/");
  if (rest === "") {
    throw new Error(
      "Refusing an object key: a render path must name something below its campaign.",
    );
  }
  const key = `${prefix}${rest}`;
  // The composed key through the port's own rule, so this adapter never has to
  // re-derive whether the result stays inside the store.
  assertObjectKey(key);
  return key;
}

/**
 * The content type an export is stored with, from the path's extension.
 *
 * An extension nobody has declared a type for is REFUSED, never defaulted:
 * `application/octet-stream` would store happily and then be downloaded rather
 * than shown, and the failure would surface in a browser with nothing in the
 * run's log — which is the one place that could have named the file.
 *
 * **Exported so a packaged copy is stored with the SAME type** (PT-4h1): the
 * bytes of a package are the bytes of a render, and a table keyed by extension
 * that two modules each held a copy of would be free to disagree about `.mp4`.
 */
export function contentTypeFor(relativePath: string): string {
  const dot = relativePath.lastIndexOf(".");
  const slash = relativePath.lastIndexOf("/");
  // A dot before the last slash is inside a directory name (`alpha/1.0/…`), not
  // an extension, so the segment after it is the only candidate.
  const ext = dot > slash ? relativePath.slice(dot) : "";
  const contentType = CONTENT_TYPES[ext];
  if (contentType === undefined) {
    throw new Error(
      ext === ""
        ? "Refusing to export a path with no extension: no content type is defined for it."
        : `Refusing to export ${ext}: no content type is defined for it.`,
    );
  }
  return contentType;
}

/**
 * ObjectExporter — `ExportPort` over `ObjectStorePort` (PT-4e, D203).
 *
 * The fs exporter's counterpart under `OBJECT_STORE=s3`: same relative paths,
 * same methods, same idempotency — a different place to put the bytes. It
 * creates no directories and no temporary files, because a PUT is atomic: the
 * reader either sees the whole object or does not see it at all, so the
 * tmp-plus-rename dance the fs background cache needs has no meaning here.
 *
 * It holds no store state of its own, so one instance serves a whole run.
 */
export class ObjectExporter implements ExportPort {
  constructor(
    private readonly store: ObjectStorePort,
    private readonly options: ObjectExporterOptions,
  ) {}

  async saveToDirectory(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    await this.store.put(this.keyFor(relativePath), imageBuffer, {
      contentType: contentTypeFor(relativePath),
    });
  }

  async generatePrintProof(imageBuffer: Uint8Array, relativePath: string): Promise<void> {
    // The SAME bytes the fs exporter writes: `buildPrintProof` is shared, so a
    // proof is the same document on both backends.
    await this.store.put(this.keyFor(relativePath), await buildPrintProof(imageBuffer), {
      contentType: contentTypeFor(relativePath),
    });
  }

  /** Idempotent, as on fs: `ObjectStorePort.delete` swallows a missing key. */
  async remove(relativePath: string): Promise<void> {
    await this.store.delete(this.keyFor(relativePath));
  }

  private keyFor(relativePath: string): ObjectKey {
    return renderObjectKey(this.options.prefix, this.options.campaignSegment, relativePath);
  }
}
