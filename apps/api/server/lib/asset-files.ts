import { extname } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { projectRoot } from "@campaignfoundry/shared";
import { resolveConfined } from "./confined-path.js";
/**
 * Asset basename: a SAFE_ID_PATTERN stem plus a png/jpg/jpeg/mp3/m4a extension.
 * Dots, slashes, and `..` are rejected so the join `assets/inputs/<briefId>/<name>`
 * cannot escape the brief's input directory or overwrite demo logos at
 * `assets/inputs/*.png`.
 *
 * VE3b2 adds mp3/m4a for a brief's music bed (`audio.path`, VE-D8). The 2 MiB
 * cap (`MAX_ASSET_BYTES`) is the binding limit, so format choice is a duration
 * budget: at a typical 128 kbps CBR (16,000 B/s) mp3/m4a admit
 * 2,097,152 / 16,000 ≈ 131 s (2 min 11 s) — comfortably past a single motion
 * clip's duration. Uncompressed wav (CD quality: 44.1 kHz × 16-bit × 2 ch =
 * 176,400 B/s) would admit only 2,097,152 / 176,400 ≈ 11.9 s, too short to be
 * useful as a bed under the same cap — wav is deliberately not accepted.
 */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpg|jpeg|mp3|m4a)$/;

/** The audio subset of ASSET_NAME_PATTERN — selects the magic check and error message. */
export const AUDIO_ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.(mp3|m4a)$/;

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** ID3v2 tag, present at the start of most tagged mp3 files. */
const MP3_ID3_MAGIC = Buffer.from([0x49, 0x44, 0x33]);
/** ISO-BMFF "ftyp" box tag, at byte offset 4 in every mp4-family container (incl. m4a). */
const M4A_FTYP_MAGIC = Buffer.from("ftyp", "ascii");
/**
 * ISO-BMFF major brands that name an AUDIO-ONLY file — never the generic
 * `isom`/`mp42` brands shared with video mp4, so a video file renamed `.m4a`
 * is still refused. `M4A ` is exactly what the pinned `ffmpeg-static` binary
 * writes for `-c:a aac out.m4a` (verified against the vendored binary);
 * `M4B `/`M4P ` (audiobook / protected) are the same registry family.
 */
const M4A_AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);

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

/** ID3v2 tag, or a bare MPEG frame sync (11 leading set bits: 0xff then top 3 bits of the next byte). */
function hasMp3Magic(bytes: Buffer): boolean {
  if (bytes.length >= MP3_ID3_MAGIC.length && bytes.subarray(0, MP3_ID3_MAGIC.length).equals(MP3_ID3_MAGIC)) {
    return true;
  }
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

/** `ftyp` box at byte offset 4, with a major brand from the audio-only allowlist. */
function hasM4aMagic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (!bytes.subarray(4, 8).equals(M4A_FTYP_MAGIC)) return false;
  return M4A_AUDIO_BRANDS.has(bytes.subarray(8, 12).toString("ascii"));
}

export function hasAllowedAudioMagic(bytes: Buffer): boolean {
  return hasMp3Magic(bytes) || hasM4aMagic(bytes);
}

/** Content type for an asset basename matching ASSET_NAME_PATTERN. */
export function assetContentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    default:
      return "image/png";
  }
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
 * `assets/inputs/<toBriefId>/...`. If pathMap contains an explicit mapping for the
 * path or subpath, that mapped target path is used (e.g. for collision resolution).
 * Any other path (e.g. shared demo assets at `assets/inputs/*.png`) is returned unchanged.
 */
export function rewriteAssetPath(
  path: string,
  fromBriefId: string,
  toBriefId: string,
  pathMap?: Record<string, string>,
): string {
  if (pathMap && path in pathMap) {
    return pathMap[path];
  }
  const prefix = `assets/inputs/${fromBriefId}/`;
  if (path.startsWith(prefix)) {
    const subpath = path.slice(prefix.length);
    if (pathMap && subpath in pathMap) {
      return `assets/inputs/${toBriefId}/${pathMap[subpath]}`;
    }
    return `assets/inputs/${toBriefId}/${subpath}`;
  }
  return path;
}

/**
 * Rewrite all brief-scoped asset paths (`logoPath` and `inputAsset` across all products,
 * the brief-level `audio.path` (VE-D8), and every `copy.timeline.beats[].background`
 * (VE5b2)) on a brief from `fromBriefId` to `toBriefId`. Shared root assets
 * (`assets/inputs/*.png`) are left untouched.
 */
export function rewriteAssetPaths(
  brief: CampaignBrief,
  fromBriefId: string,
  toBriefId: string,
  pathMap?: Record<string, string>,
): CampaignBrief {
  if (!brief.products || !Array.isArray(brief.products)) return brief;
  const products = brief.products.map((product) => {
    let updated = product;
    if (typeof product.logoPath === "string") {
      const rewrittenLogo = rewriteAssetPath(product.logoPath, fromBriefId, toBriefId, pathMap);
      if (rewrittenLogo !== product.logoPath) {
        updated = { ...updated, logoPath: rewrittenLogo };
      }
    }
    if (typeof product.inputAsset === "string") {
      const rewrittenInput = rewriteAssetPath(product.inputAsset, fromBriefId, toBriefId, pathMap);
      if (rewrittenInput !== product.inputAsset) {
        updated = { ...updated, inputAsset: rewrittenInput };
      }
    }
    return updated;
  });
  let updated: CampaignBrief = { ...brief, products };

  // Absent audio stays absent (VE-D3): only ever replace the key when it was
  // already present, never fabricate one a byte-identity comparison ("key in
  // object") must never see.
  if (brief.audio !== undefined) {
    const rewrittenAudioPath = rewriteAssetPath(brief.audio.path, fromBriefId, toBriefId, pathMap);
    if (rewrittenAudioPath !== brief.audio.path) {
      updated = { ...updated, audio: { ...brief.audio, path: rewrittenAudioPath } };
    }
  }

  // Same discipline for copy.timeline.beats[].background (VE5b2): absent copy,
  // absent timeline, or a beat naming no background is untouched — a beat
  // without `background` must never gain a `background: undefined` key.
  const timeline = brief.copy?.timeline;
  if (timeline !== undefined) {
    let beatsChanged = false;
    const beats = timeline.beats.map((beat) => {
      if (typeof beat.background !== "string") return beat;
      const rewritten = rewriteAssetPath(beat.background, fromBriefId, toBriefId, pathMap);
      if (rewritten === beat.background) return beat;
      beatsChanged = true;
      return { ...beat, background: rewritten };
    });
    if (beatsChanged) {
      updated = { ...updated, copy: { ...brief.copy, timeline: { ...timeline, beats } } };
    }
  }

  return updated;
}

/**
 * Extract distinct source brief IDs referenced by any brief-scoped asset paths
 * (`assets/inputs/<fromId>/...`) in a brief's products, its `audio.path` (VE-D8),
 * and every `copy.timeline.beats[].background` (VE5b2).
 */
export function extractSourceAssetBriefIds(brief: CampaignBrief, targetBriefId: string): string[] {
  const fromIds = new Set<string>();
  const addSource = (p: string): void => {
    const match = /^assets\/inputs\/([^/]+)\/.+$/.exec(p);
    if (match && match[1] !== targetBriefId) {
      fromIds.add(match[1]);
    }
  };
  // Malformed/missing products is its own guard, scoped to the products walk
  // only — audio.path and beat backgrounds must still be scanned even when a
  // brief has no products, or a duplicate silently keeps their source paths
  // (the exact bug this function exists to prevent).
  if (brief.products && Array.isArray(brief.products)) {
    for (const product of brief.products) {
      for (const p of [product.logoPath, product.inputAsset]) {
        if (typeof p === "string") addSource(p);
      }
    }
  }
  if (brief.audio !== undefined) {
    addSource(brief.audio.path);
  }
  for (const beat of brief.copy?.timeline?.beats ?? []) {
    if (typeof beat.background === "string") addSource(beat.background);
  }
  return Array.from(fromIds);
}
