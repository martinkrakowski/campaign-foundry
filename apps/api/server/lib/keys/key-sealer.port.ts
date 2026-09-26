/**
 * Envelope-encrypted key representation (D175, D176).
 *
 * Each cryptographic field is a base64-encoded string, plus `kekVersion`
 * naming the key-encryption key (KEK) version that sealed the data key.
 */
export interface SealedKey {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly sealedDek: string;
  readonly dekIv: string;
  readonly dekTag: string;
  readonly kekVersion: string;
}

/**
 * Envelope encryption for org provider keys (D175, D176).
 *
 * `seal` generates a fresh random 32-byte data encryption key (DEK) per call,
 * encrypts the plaintext with it using AES-256-GCM, and seals the DEK with the
 * current KEK using AES-256-GCM.
 *
 * `open` picks the KEK by `kekVersion`, unseals the DEK, and decrypts the
 * ciphertext with AES-256-GCM authentication.
 */
export interface KeySealerPort {
  /** `context` names what the key belongs to (`<orgId>:<provider>`); `open` must pass the same one. */
  seal(plaintext: string, context: string): SealedKey;
  open(sealed: SealedKey, context: string): string;
}
