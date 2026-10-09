import type { ListedObject } from "@campaignfoundry/CampaignOrchestration";

/**
 * One page of a ListObjectsV2 response, as far as the adapter needs it.
 */
export interface ListObjectsV2Page {
  readonly contents: ListedObject[];
  /** True when the store has more keys under the same prefix. */
  readonly truncated: boolean;
  readonly nextContinuationToken?: string;
}

/** S3 quotes an ETag; the port's `etag` is unquoted so a fake and a store agree. */
function unquote(value: string | undefined): string | undefined {
  return value?.replace(/^"(.*)"$/, "$1");
}

/**
 * Decode the five XML predefined entities plus numeric character references.
 *
 * An entity this map does not know is left as written: a store that escapes a
 * key with its own entity set must not have that entity silently eaten, and the
 * key that comes out is confined by `assertObjectKey` before anything acts on it.
 */
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\dA-Fa-f]+)|([A-Za-z]+));/g,
    (match, decimal: string, hex: string, name: string) => {
      if (decimal !== undefined) return codePoint(Number(decimal));
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
      // `Object.hasOwn`, not `in` and not `??`: an entity name is only
      // `[A-Za-z]+`, so `&toString;` is a well-formed entity whose name is an
      // INHERITED property — `PREDEFINED_ENTITIES.toString` would hand back a
      // function. The own-property question is the only correct one.
      if (Object.hasOwn(PREDEFINED_ENTITIES, name)) return PREDEFINED_ENTITIES[name];
      return match;
    },
  );
}

/**
 * A character reference as the character it names, or a refusal.
 *
 * `String.fromCodePoint` throws a bare `RangeError` past U+10FFFF, and that
 * RangeError would surface out of `list()` with no hint that a listing was the
 * thing at fault. So the range is checked here and refused in this parser's own
 * words.
 *
 * `Number.isInteger` comes first and is not redundant: `\d+` cannot express a
 * fraction, but it CAN overflow — `&#` plus four hundred nines parses to
 * `Infinity`, which is not an integer and which `fromCodePoint` would also
 * refuse. There is no lower bound to check, because `\d+` and `[\dA-Fa-f]+`
 * cannot spell a negative number.
 */
function codePoint(value: number): string {
  if (!Number.isInteger(value) || value > 0x10ffff) {
    throw new Error("Refusing a listing with an out-of-range character reference.");
  }
  return String.fromCodePoint(value);
}

/** The decoded text of the first `<tag>` in `xml`, or undefined when it has none. */
function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match === null ? undefined : decodeXmlText(match[1] as string);
}

/**
 * Parse a ListObjectsV2 body, by hand, with no XML dependency (D202).
 *
 * A DOCTYPE or ENTITY declaration is REFUSED before a single byte is read as
 * markup. An S3-compatible store has no reason to send one, and a body that
 * declares entities is the shape an XXE or an entity-expansion bomb takes; the
 * cost of refusing is one clear error, and the cost of not refusing is a parser
 * that resolves whatever the body asked it to.
 *
 * `<Contents>` without a `Key`, `Size` or `LastModified` is refused too: those
 * three are mandatory in the response schema, so a block missing one is a body
 * this parser has been asked to guess about, and a guessed listing that silently
 * drops an object is worse than an error.
 *
 * And a `Size` that is not a plain count, or a `LastModified` that is not a
 * date, is refused the same way. `Number("seven")` is `NaN` and
 * `new Date("whenever")` is an Invalid Date, both of which would travel on as
 * ordinary-looking values: a caller summing sizes gets `NaN`, and a caller
 * sorting by `lastModified` gets an order decided by `NaN` comparisons. Each
 * message names the FIELD, never the value — the value came from the store and
 * has not earned a place in a log.
 */
export function parseListObjectsV2(xml: string): ListObjectsV2Page {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error("Refusing a listing that declares a DOCTYPE or an XML entity.");
  }

  const contents: ListedObject[] = [];
  for (const block of xml.match(/<Contents>([\s\S]*?)<\/Contents>/g) ?? []) {
    const key = tagText(block, "Key");
    const size = tagText(block, "Size");
    const lastModified = tagText(block, "LastModified");
    if (key === undefined || size === undefined || lastModified === undefined) {
      throw new Error("Refusing a listing entry with no Key, Size or LastModified.");
    }
    if (!/^\d+$/.test(size)) {
      throw new Error("Refusing a listing entry whose Size is not a whole number of bytes.");
    }
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Refusing a listing entry whose Size is not a safe whole number of bytes.");
    }
    const modified = new Date(lastModified);
    if (Number.isNaN(modified.getTime())) {
      throw new Error("Refusing a listing entry whose LastModified is not a date.");
    }
    contents.push({
      key,
      size: bytes,
      etag: unquote(tagText(block, "ETag")),
      lastModified: modified,
    });
  }

  const truncated = tagText(xml, "IsTruncated") === "true";
  const nextContinuationToken = tagText(xml, "NextContinuationToken");
  if (truncated && nextContinuationToken === undefined) {
    throw new Error("Refusing a truncated listing with no NextContinuationToken.");
  }
  return { contents, truncated, nextContinuationToken };
}
