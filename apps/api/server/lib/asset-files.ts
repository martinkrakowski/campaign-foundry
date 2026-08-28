import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "./confined-path.js";
/**
 * Asset basename: a SAFE_ID_PATTERN stem plus a png/jpg/jpeg extension.
 * Dots, slashes, and `..` are rejected so the join `assets/inputs/<briefId>/<name>`
 * cannot escape the brief's input directory or overwrite demo logos at
 * `assets/inputs/*.png`.
 */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpg|jpeg)$/;

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Decode standard base64; undefined on empty, non-string, or invalid alphabet. */
export function decodeBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  return Buffer.from(value, "base64");
}

export function hasAllowedImageMagic(bytes: Buffer): boolean {
  return (
    (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) ||
    (bytes.length >= JPEG_MAGIC.length && bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC))
  );
}

/** Repo-relative path a brief can put in `logoPath` / `inputAsset`. */
export function assetRelPath(briefId: string, name: string): string {
  return `assets/inputs/${briefId}/${name}`;
}

/**
 * Absolute write path under `assets/inputs/<briefId>/<name>`.
 * Confined first to the brief directory, then to the basename, so `../` in
 * `name` cannot reach `assets/inputs/hydra-logo.png`.
 */
export function assetAbsPath(briefId: string, name: string): string {
  const dir = resolveConfined(projectRoot(), "assets", "inputs", briefId);
  return resolveConfined(dir, name);
}


/**
 * Rewrite a single repo-relative asset path from `fromBriefId` to `toBriefId`.
 * If the path starts with `assets/inputs/<fromBriefId>/`, it is rewritten to
 * `assets/inputs/<toBriefId>/...`. Any other path (e.g. shared demo assets at
 * `assets/inputs/*.png`) is returned unchanged.
 */
export function rewriteAssetPath(path: string, fromBriefId: string, toBriefId: string): string {
  const prefix = `assets/inputs/${fromBriefId}/`;
  if (path.startsWith(prefix)) {
    return `assets/inputs/${toBriefId}/${path.slice(prefix.length)}`;
  }
  return path;
}

/**
 * Rewrite all brief-scoped asset paths (`logoPath` and `inputAsset` across all products)
 * on a brief from `fromBriefId` to `toBriefId`. Shared root assets (`assets/inputs/*.png`)
 * are left untouched.
 */
export function rewriteAssetPaths(
  brief: CampaignBrief,
  fromBriefId: string,
  toBriefId: string,
): CampaignBrief {
  if (!brief.products || !Array.isArray(brief.products)) return brief;
  const products = brief.products.map((product) => {
    let updated = product;
    if (typeof product.logoPath === "string") {
      const rewrittenLogo = rewriteAssetPath(product.logoPath, fromBriefId, toBriefId);
      if (rewrittenLogo !== product.logoPath) {
        updated = { ...updated, logoPath: rewrittenLogo };
      }
    }
    if (typeof product.inputAsset === "string") {
      const rewrittenInput = rewriteAssetPath(product.inputAsset, fromBriefId, toBriefId);
      if (rewrittenInput !== product.inputAsset) {
        updated = { ...updated, inputAsset: rewrittenInput };
      }
    }
    return updated;
  });
  return { ...brief, products };
}

/**
 * Extract distinct source brief IDs referenced by any brief-scoped asset paths
 * (`assets/inputs/<fromId>/...`) in a brief's products.
 */
export function extractSourceAssetBriefIds(brief: CampaignBrief, targetBriefId: string): string[] {
  if (!brief.products || !Array.isArray(brief.products)) return [];
  const fromIds = new Set<string>();
  for (const product of brief.products) {
    for (const p of [product.logoPath, product.inputAsset]) {
      if (typeof p === "string") {
        const match = /^assets\/inputs\/([^/]+)\/.+$/.exec(p);
        if (match && match[1] !== targetBriefId) {
          fromIds.add(match[1]);
        }
      }
    }
  }
  return Array.from(fromIds);
}
