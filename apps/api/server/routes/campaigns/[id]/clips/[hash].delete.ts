import { errorMessage } from "@campaignfoundry/shared";
import {
  PublicMediaNotConfiguredError,
  UnpublishAdClipUseCase,
} from "@campaignfoundry/CampaignOrchestration";
import { storeBackend } from "../../../../lib/config.js";
import { database } from "../../../../lib/db/database.js";
import { assertSafeId } from "../../../../lib/load-brief.js";
import { publicAdMediaClient } from "../../../../lib/object-store/index.js";
import { getBriefStore } from "../../../../lib/ports/index.js";
import { PgPublishedClipStore } from "../../../../lib/ports/pg-published-clip-store.js";
import { requestTenant } from "../../../../lib/tenant.js";

/** The content hash segment of a published clip's key: lowercase hex SHA-256. */
const CLIP_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * DELETE /campaigns/:id/clips/:hash — unpublish one recorded ad clip
 * (PT-4k). `:id` is a uuid or a slug; `:hash` is the clip's content hash.
 * Missing, cross-org, team-hidden and tombstoned campaigns AND an unknown
 * hash all answer the one 404 `{ error: "Not found." }` (D166, D233) — a
 * caller learns nothing about clips it does not own. 204 on success. 500
 * with a FIXED body when the public media is unconfigured or the store
 * fails: the adapter's own error text never reaches the response.
 *
 * On the file store there is no `published_clip` table and no public media
 * in this deployment's shape, so the route answers the same 404 before
 * `database()` is ever touched — building the pg store there would leak
 * `DATABASE_URL is not set.` as a 500.
 */
export default defineEventHandler(async (event) => {
  let id: string;
  try {
    id = String(getRouterParam(event, "id"));
    assertSafeId(id, "Campaign id");
  } catch (error) {
    setResponseStatus(event, 400);
    return { error: errorMessage(error) };
  }

  const hash = String(getRouterParam(event, "hash"));
  if (!CLIP_HASH_PATTERN.test(hash)) {
    setResponseStatus(event, 400);
    return { error: "Invalid clip hash." };
  }

  const notFound = () => {
    setResponseStatus(event, 404);
    return { error: "Not found." };
  };

  if (storeBackend() !== "postgres") return notFound();

  const scope = requestTenant(event);
  const resolved = await getBriefStore(scope).resolveCampaign(id);
  if (!resolved) return notFound();

  const clipRecords = new PgPublishedClipStore(database());
  const record = await clipRecords.find(scope.orgId, resolved.campaignId, hash);
  if (record === undefined) return notFound();

  try {
    const media = publicAdMediaClient();
    if (media === undefined) throw new PublicMediaNotConfiguredError();
    await new UnpublishAdClipUseCase({
      publicAdMedia: media,
      publishedClipRecord: clipRecords,
    }).execute({
      orgId: scope.orgId,
      campaignId: resolved.campaignId,
      key: record.key,
    });
  } catch {
    // A fixed body: the use case's own errors (and the adapter's) name keys
    // and configuration this deployment must not echo to the caller.
    setResponseStatus(event, 500);
    return { error: "Failed to unpublish clip." };
  }

  setResponseStatus(event, 204);
  return null;
});
