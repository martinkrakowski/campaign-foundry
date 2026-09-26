import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyEncryptionSettings } from "../config.js";
import type { KeySealerPort, SealedKey } from "./key-sealer.port.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV standard for AES-GCM
const KEY_LENGTH = 32; // 256-bit key

/**
 * Envelope-encrypts provider keys using a host-secret key-encryption key (KEK) (D175, D176).
 *
 * Each `seal` creates a fresh random 32-byte data encryption key (DEK) and 12-byte IV,
 * encrypts the plaintext with AES-256-GCM, and encrypts the DEK under the current KEK
 * with a distinct 12-byte IV.
 *
 * `open` looks up the KEK for `sealed.kekVersion`, unseals the DEK, and decrypts the
 * ciphertext. Tampered data or unknown versions fail with errors that carry no key material.
 */
export class HostSecretKeySealer implements KeySealerPort {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly currentVersion: string;

  constructor(
    keysOrSettings:
      | KeyEncryptionSettings
      | ReadonlyMap<string, Buffer>
      | Map<string, Buffer>
      | Record<string, Buffer>,
    currentVersion?: string,
  ) {
    if (
      keysOrSettings &&
      typeof (keysOrSettings as KeyEncryptionSettings).currentVersion === "string" &&
      "keys" in keysOrSettings
    ) {
      const settings = keysOrSettings as KeyEncryptionSettings;
      this.currentVersion = settings.currentVersion;
      const k = settings.keys;
      this.keys = k instanceof Map ? k : new Map(Object.entries(k));
    } else {
      if (!currentVersion) {
        throw new Error("currentVersion is required when providing keys directly.");
      }
      this.currentVersion = currentVersion;
      this.keys =
        keysOrSettings instanceof Map
          ? keysOrSettings
          : new Map(Object.entries(keysOrSettings as Record<string, Buffer>));
    }

    if (!this.keys.has(this.currentVersion)) {
      throw new Error(`Current key encryption version "${this.currentVersion}" not found in keys.`);
    }
  }

  seal(plaintext: string): SealedKey {
    const currentKek = this.keys.get(this.currentVersion)!;

    // 1. Generate fresh 32-byte DEK and 12-byte IV for payload
    const dek = randomBytes(KEY_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    // 2. Encrypt plaintext with DEK
    const cipher = createCipheriv(ALGORITHM, dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3. Seal DEK with current KEK using a fresh 12-byte IV
    const dekIv = randomBytes(IV_LENGTH);
    const dekCipher = createCipheriv(ALGORITHM, currentKek, dekIv);
    const sealedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekTag = dekCipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      sealedDek: sealedDek.toString("base64"),
      dekIv: dekIv.toString("base64"),
      dekTag: dekTag.toString("base64"),
      kekVersion: this.currentVersion,
    };
  }

  open(sealed: SealedKey): string {
    const kek = this.keys.get(sealed.kekVersion);
    if (!kek) {
      throw new Error(`Unknown key encryption version: "${sealed.kekVersion}".`);
    }

    let dek: Buffer;
    try {
      const dekIv = Buffer.from(sealed.dekIv, "base64");
      const dekTag = Buffer.from(sealed.dekTag, "base64");
      const sealedDek = Buffer.from(sealed.sealedDek, "base64");

      if (dekIv.length !== IV_LENGTH || dekTag.length !== 16) {
        throw new Error("Invalid unseal parameters");
      }

      const dekDecipher = createDecipheriv(ALGORITHM, kek, dekIv);
      dekDecipher.setAuthTag(dekTag);
      dek = Buffer.concat([dekDecipher.update(sealedDek), dekDecipher.final()]);
      if (dek.length !== KEY_LENGTH) {
        throw new Error("Invalid unsealed data key length");
      }
    } catch {
      throw new Error(
        "Failed to unseal data encryption key: authentication check failed or corrupted data.",
      );
    }

    try {
      const iv = Buffer.from(sealed.iv, "base64");
      const tag = Buffer.from(sealed.tag, "base64");
      const ciphertext = Buffer.from(sealed.ciphertext, "base64");

      if (iv.length !== IV_LENGTH || tag.length !== 16) {
        throw new Error("Invalid ciphertext parameters");
      }

      const decipher = createDecipheriv(ALGORITHM, dek, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(
        "Failed to decrypt ciphertext: authentication check failed or corrupted data.",
      );
    }
  }
}
