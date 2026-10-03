import { errorMessage } from "@campaignfoundry/shared";
import {
  ASSET_NAME_PATTERN,
  AUDIO_ASSET_NAME_PATTERN,
  MAX_ASSET_BYTES,
  decodeBase64,
  hasAllowedImageMagic,
  hasAllowedAudioMagic,
} from "../../lib/asset-files.js";
import { isExistsError } from "../../lib/brief-files.js";
import { assertSafeId } from "../../lib/load-brief.js";
import { getAssetStore, getBriefStore } from "../../lib/ports/index.js";

import { requestTenant } from "../../lib/tenant.js";
/**
 * POST /campaigns/assets — store a PNG/JPEG/MP3/M4A under `assets/inputs/<briefId>/<name>`.
 *
 * Local authoring tool: writes are confined to `assets/inputs/<briefId>/` and never
 * touch demo logos at `assets/inputs/*.png`. Body `{ briefId, name, contentBase64 }`;
 * `name` is a SAFE_ID_PATTERN stem plus `.png`/`.jpg`/`.jpeg`/`.mp3`/`.m4a`. The magic
 * check dispatches on the name's extension (AUDIO_ASSET_NAME_PATTERN), never on the
 * decoded bytes alone — a valid PNG magic named `bed.mp3` must fail as audio, not
 * pass as an image the caller never asked for. 400 on bad input or magic, 413 over
 * 2 MiB (checked before decode and again after), 409 if the file already exists.
 * The 201 body is `{ path }`, plus `id` on the backends that mint one (s3,
 * PT-4k1) — the key is absent, not null, everywhere else.
 */
export default defineEventHandler(async (event) => {
  const scope = requestTenant(event);
  let briefId: string;
  let name: string;
  let bytes: Buffer;
  try {
    const body: unknown = await readBody(event);
    if (typeof body !== "object" || body === null) {
      throw new Error("Asset upload must be an object.");
    }
    const record = body as Record<string, unknown>;
    assertSafeId(record.briefId, "briefId");
    if (typeof record.name !== "string" || !ASSET_NAME_PATTERN.test(record.name)) {
      throw new Error(
        `name must be a path-safe basename (slug + .png/.jpg/.jpeg/.mp3/.m4a); got ${JSON.stringify(record.name)}.`,
      );
    }
    if (typeof record.contentBase64 !== "string") {
      throw new Error("contentBase64 must be standard base64.");
    }
    if (record.contentBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) {
      setResponseStatus(event, 413);
      return { error: "Asset exceeds the 2 MiB size limit." };
    }
    const decoded = decodeBase64(record.contentBase64);
    if (!decoded) {
      throw new Error("contentBase64 must be standard base64.");
    }
    briefId = record.briefId;
    name = record.name;
    bytes = decoded;
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  if (bytes.length > MAX_ASSET_BYTES) {
    setResponseStatus(event, 413);
    return { error: "Asset exceeds the 2 MiB size limit." };
  }
  if (AUDIO_ASSET_NAME_PATTERN.test(name)) {
    if (!hasAllowedAudioMagic(bytes)) {
      setResponseStatus(event, 400);
      return { error: "Asset must be an MP3 or M4A audio file." };
    }
  } else if (!hasAllowedImageMagic(bytes)) {
    setResponseStatus(event, 400);
    return { error: "Asset must be a PNG or JPEG image." };
  }

  const briefs = getBriefStore(scope);
  // On fs the id IS the slug (D179): no lookup runs there at all (no
  // uuid concept exists on that backend either), matching this route's
  // unconditional-write behaviour from before campaign refs existed — an
  // unsaved draft's own id creates its asset directory here, which H5
  // depends on and which the fs backend still does.
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(briefId) : undefined;
  // D166 (PT-2c, PT-4b): a ref that does not resolve and one hidden from this
  // caller by team answer the SAME 404 with the SAME body, so the answer never
  // says which applies. `PgBriefStore.resolveCampaign` already refuses a
  // campaign this caller may not see (it filters on team visibility as it
  // looks), which is why there is no second `campaignVisibility` check here:
  // it could only ever repeat the answer below.
  //
  // On Postgres this is also no longer a special case for a uuid-shaped ref
  // (D178). PT-5c2 made every Postgres campaign a minted row, and under
  // `OBJECT_STORE=s3` an asset is an `asset` row carrying that row's uuid
  // (C7) — a key built from a slug would put a renameable, user-chosen string
  // in the object store's namespace. So an unresolved ref is a ref with no
  // campaign to own the bytes, and it writes nothing.
  if (briefs.supportsTeams && resolved === undefined) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${briefId}" not found.` };
  }
  const slug = resolved?.slug ?? briefId;

  try {
    const result = await getAssetStore(scope).writeAsset(slug, name, bytes);
    setResponseStatus(event, 201);
    // CONDITIONALLY spread, and that is what keeps fs byte-identical: an fs store
    // mints no id, and a response carrying `id: undefined` is not the same JSON as
    // one without the key — `Object.keys` differs, and so does any `toEqual` on
    // the parsed body. Under `s3` the id is what PT-4l's editor stores as the
    // brief's ref, so it rides along with the path the web still writes until
    // then (PT-4k1; the save-time normalisation of a path ref is PT-4k2).
    return result.id === undefined ? { path: result.path } : { path: result.path, id: result.id };
  } catch (error) {
    if (isExistsError(error)) {
      setResponseStatus(event, 409);
      return {
        error: `Asset "${getAssetStore(scope).assetRelPath(slug, name)}" already exists.`,
      };
    }
    throw error;
  }
});
