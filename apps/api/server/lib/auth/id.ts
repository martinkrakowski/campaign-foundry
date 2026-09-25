import { randomBytes } from "node:crypto";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";

/**
 * Better Auth's id for every model (PT-1a item 7): lowercase hex is already a
 * subset of `SAFE_ID_PATTERN` (`^[a-z0-9][a-z0-9-]{0,63}$`), so no alphabet
 * conversion is needed the way a base32 or mixed-case id generator would. 16
 * bytes (32 hex characters) keeps collisions astronomically unlikely while
 * staying well under the pattern's 64-character cap.
 *
 * Better Auth calls this once per row it creates, for every model — `org`
 * (0001, tightened by 0008 to this same pattern) included, so a user- or
 * Google-provisioned organisation's id is exactly as safe as `local`'s.
 */
export function safeId(): string {
  return randomBytes(16).toString("hex");
}

/** A defensive check: `safeId()`'s output must always satisfy the pattern it exists to satisfy. */
export function isSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}
