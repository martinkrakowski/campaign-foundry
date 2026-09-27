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
 * A client-chosen slug (an unsaved draft's id) never looks like this, so a ref
 * shaped like one is a real campaign reference (D178) rather than a brand-new
 * draft id — if it fails to resolve, the campaign genuinely does not exist,
 * unlike a fresh slug (which this route has always accepted, creating the
 * asset directory for a not-yet-saved brief).
 */
const CAMPAIGN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  // unconditional-write behaviour from before campaign refs existed.
  const resolved = briefs.supportsTeams ? await briefs.resolveCampaign(briefId) : undefined;
  if (!resolved && briefs.supportsTeams && CAMPAIGN_UUID_PATTERN.test(briefId)) {
    setResponseStatus(event, 404);
    return { error: `Campaign "${briefId}" not found.` };
  }
  // A slug that did not resolve passes through unchanged (an unsaved draft
  // has no campaign row yet, and this route has always let a caller create
  // its asset directory ahead of the brief being saved).
  const slug = resolved?.slug ?? briefId;
  if (briefs.supportsTeams && (await briefs.campaignVisibility(slug)) === "hidden") {
    setResponseStatus(event, 404);
    return { error: `Campaign "${briefId}" not found.` };
  }

  try {
    const result = await getAssetStore(scope).writeAsset(slug, name, bytes);
    setResponseStatus(event, 201);
    return { path: result.path };
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
