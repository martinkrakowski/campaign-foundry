import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyEncryptionSettings } from "../config.js";
import type { KeySealerPort, SealedKey } from "./key-sealer.port.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV standard for AES-GCM
const KEY_LENGTH = 32; // 256-bit key

/**
 * The context a key is sealed for (PT-7b2 passes `<orgId>:<provider>`), bound in as
 * GCM additional data: a sealed key moved to another org's or provider's row no
 * longer opens. The data key's seal also binds the KEK version, so a sealed key
 * relabelled to another version fails too.
 */
function contextAad(context: string): Buffer {
  if (context === "") throw new Error("A sealed key needs a non-empty context.");
  return Buffer.from(context, "utf8");
}

function dekAad(kekVersion: string, aad: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${kekVersion}\n`, "utf8"), aad]);
}

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

  constructor(settings: KeyEncryptionSettings) {
    // A private copy: a caller mutating its own map later cannot change the
    // keyring, and any ReadonlyMap (not only a native Map) is read by iteration.
    this.keys = new Map(settings.keys);
    this.currentVersion = settings.currentVersion;
    for (const [version, key] of this.keys) {
      if (key.length !== KEY_LENGTH) {
        throw new Error(`Key encryption key "${version}" must be ${KEY_LENGTH} bytes.`);
      }
    }
    if (!this.keys.has(this.currentVersion)) {
      throw new Error("The current key encryption version is not in the keyring.");
    }
  }

  seal(plaintext: string, context: string): SealedKey {
    const aad = contextAad(context);
    const currentKek = this.keys.get(this.currentVersion)!;

    // 1. Generate fresh 32-byte DEK and 12-byte IV for payload
    const dek = randomBytes(KEY_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    // 2. Encrypt plaintext with DEK
    const cipher = createCipheriv(ALGORITHM, dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3. Seal DEK with current KEK using a fresh 12-byte IV
    const dekIv = randomBytes(IV_LENGTH);
    const dekCipher = createCipheriv(ALGORITHM, currentKek, dekIv);
    dekCipher.setAAD(dekAad(this.currentVersion, aad));
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

  open(sealed: SealedKey, context: string): string {
    const aad = contextAad(context);
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
      dekDecipher.setAAD(dekAad(sealed.kekVersion, aad));
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
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(
        "Failed to decrypt ciphertext: authentication check failed or corrupted data.",
      );
    }
  }
}
