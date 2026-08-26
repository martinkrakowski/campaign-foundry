import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

export async function writeAssetFile(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
