import { createHash } from "node:crypto";
import type { PolicyHasher } from "../../domain/value-objects/VariationPolicy.vo.js";

/**
 * Node.js crypto adapter for VariationPolicy hashing.
 * Computes sha256 hex digest of the canonical JSON payload.
 */
export const nodeCryptoPolicyHasher: PolicyHasher = (payloadJson: string): string =>
  createHash("sha256").update(payloadJson).digest("hex");
