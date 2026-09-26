import { describe, test, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { HostSecretKeySealer } from "../host-secret-key-sealer.js";
import type { SealedKey } from "../key-sealer.port.js";
import type { KeyEncryptionSettings } from "../../config.js";

function makeKek(byteVal: number = 1): Buffer {
  return Buffer.alloc(32, byteVal);
}

describe("HostSecretKeySealer (PT-7b1)", () => {
  const v1Key = makeKek(1);
  const v2Key = makeKek(2);

  const singleKeySettings: KeyEncryptionSettings = {
    currentVersion: "v1",
    keys: new Map([["v1", v1Key]]),
  };

  test("round trip: seals and opens plaintext correctly", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);
    const plaintext = "sk-antigravity-provider-secret-key-xyz-12345";
    const sealed = sealer.seal(plaintext);

    expect(sealed.kekVersion).toBe("v1");
    expect(typeof sealed.ciphertext).toBe("string");
    expect(typeof sealed.iv).toBe("string");
    expect(typeof sealed.tag).toBe("string");
    expect(typeof sealed.sealedDek).toBe("string");
    expect(typeof sealed.dekIv).toBe("string");
    expect(typeof sealed.dekTag).toBe("string");

    const opened = sealer.open(sealed);
    expect(opened).toBe(plaintext);
  });

  test("round trip: handles empty string and unicode characters", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);

    const emptySealed = sealer.seal("");
    expect(sealer.open(emptySealed)).toBe("");

    const unicode = "🔑 Secret provider key with emojis 🚀 and accents: éàçü";
    const unicodeSealed = sealer.seal(unicode);
    expect(sealer.open(unicodeSealed)).toBe(unicode);
  });

  test("a new data key per seal: two seals of the same text differ", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);
    const text = "repeatable-text-for-encryption";

    const seal1 = sealer.seal(text);
    const seal2 = sealer.seal(text);

    // Both decrypt to the same original text
    expect(sealer.open(seal1)).toBe(text);
    expect(sealer.open(seal2)).toBe(text);

    // All cryptographic components must differ due to fresh DEK and fresh IVs
    expect(seal1.sealedDek).not.toBe(seal2.sealedDek);
    expect(seal1.ciphertext).not.toBe(seal2.ciphertext);
    expect(seal1.iv).not.toBe(seal2.iv);
    expect(seal1.dekIv).not.toBe(seal2.dekIv);
    expect(seal1.tag).not.toBe(seal2.tag);
    expect(seal1.dekTag).not.toBe(seal2.dekTag);
  });

  test("open after rotation: seal under v1, make v2 current, open still works, and a new seal uses v2", () => {
    const v1Sealer = new HostSecretKeySealer({
      currentVersion: "v1",
      keys: new Map([["v1", v1Key]]),
    });

    const secret = "persisted-provider-secret-token";
    const sealedUnderV1 = v1Sealer.seal(secret);
    expect(sealedUnderV1.kekVersion).toBe("v1");

    // Rotate: now v2 is current, but v1 is still in the keyring
    const rotatedSealer = new HostSecretKeySealer({
      currentVersion: "v2",
      keys: new Map([
        ["v1", v1Key],
        ["v2", v2Key],
      ]),
    });

    // Opening a key sealed under v1 still works
    expect(rotatedSealer.open(sealedUnderV1)).toBe(secret);

    // A new seal uses v2
    const sealedUnderV2 = rotatedSealer.seal("newly-enrolled-key");
    expect(sealedUnderV2.kekVersion).toBe("v2");
    expect(rotatedSealer.open(sealedUnderV2)).toBe("newly-enrolled-key");
  });

  describe("tamper cases", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);
    const text = "confidential-org-provider-key";

    function flipBit(base64Str: string): string {
      const buf = Buffer.from(base64Str, "base64");
      buf[0] ^= 1;
      return buf.toString("base64");
    }

    test("tamper: tampered ciphertext fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, ciphertext: flipBit(sealed.ciphertext) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to decrypt ciphertext/);
    });

    test("tamper: tampered auth tag fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, tag: flipBit(sealed.tag) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to decrypt ciphertext/);
    });

    test("tamper: tampered iv fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, iv: flipBit(sealed.iv) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to decrypt ciphertext/);
    });

    test("tamper: tampered sealedDek fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, sealedDek: flipBit(sealed.sealedDek) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to unseal data encryption key/);
    });

    test("tamper: tampered dekTag fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, dekTag: flipBit(sealed.dekTag) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to unseal data encryption key/);
    });

    test("tamper: tampered dekIv fails open", () => {
      const sealed = sealer.seal(text);
      expect(sealer.open(sealed)).toBe(text);

      const tampered = { ...sealed, dekIv: flipBit(sealed.dekIv) };
      expect(() => sealer.open(tampered)).toThrow(/Failed to unseal data encryption key/);
    });

    test("tamper: unsealed data key with invalid length fails open", () => {
      const shortDek = Buffer.alloc(16);
      const dekIv = randomBytes(12);
      const dekCipher = createCipheriv("aes-256-gcm", v1Key, dekIv);
      const sealedShortDek = Buffer.concat([dekCipher.update(shortDek), dekCipher.final()]);
      const dekTag = dekCipher.getAuthTag();

      const sealed = sealer.seal("hello");
      const malformedSealed: SealedKey = {
        ...sealed,
        sealedDek: sealedShortDek.toString("base64"),
        dekIv: dekIv.toString("base64"),
        dekTag: dekTag.toString("base64"),
      };

      expect(() => sealer.open(malformedSealed)).toThrow(/Failed to unseal data encryption key/);
    });
  });

  test("unknown kekVersion fails open", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);
    const sealed = sealer.seal("some-plaintext");

    const unknownVersionSealed: SealedKey = {
      ...sealed,
      kekVersion: "v999",
    };

    expect(() => sealer.open(unknownVersionSealed)).toThrow(
      'Unknown key encryption version: "v999".',
    );
  });

  test("no error message or SealedKey field contains the plaintext or key material", () => {
    const sealer = new HostSecretKeySealer(singleKeySettings);
    const sensitive = "VERY-SENSITIVE-PLAINTEXT-NEVER-LEAK";
    const sealed = sealer.seal(sensitive);

    // 1. None of the SealedKey fields contains the plaintext
    for (const [key, value] of Object.entries(sealed)) {
      expect(value).not.toContain(sensitive);
      if (key !== "kekVersion") {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        expect(decoded).not.toContain(sensitive);
      }
    }

    // 2. None of the error messages contains the plaintext or KEK material
    const kekBase64 = v1Key.toString("base64");
    const kekHex = v1Key.toString("hex");

    const errorsToTrigger: Array<() => void> = [
      () => sealer.open({ ...sealed, ciphertext: "badct" }),
      () => sealer.open({ ...sealed, tag: "badtag" }),
      () => sealer.open({ ...sealed, sealedDek: "baddek" }),
      () => sealer.open({ ...sealed, dekTag: "baddektag" }),
      () => sealer.open({ ...sealed, kekVersion: "vUnknown" }),
    ];

    for (const trigger of errorsToTrigger) {
      try {
        trigger();
        expect.unreachable("expected error to be thrown");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(sensitive);
        expect(message).not.toContain(kekBase64);
        expect(message).not.toContain(kekHex);
      }
    }
  });

  describe("construction ergonomics and guards", () => {
    test("supports construction from Record<string, Buffer>", () => {
      const sealer = new HostSecretKeySealer({ v1: v1Key }, "v1");
      const sealed = sealer.seal("test-record");
      expect(sealer.open(sealed)).toBe("test-record");
    });

    test("supports construction from Map with separate currentVersion", () => {
      const sealer = new HostSecretKeySealer(new Map([["v1", v1Key]]), "v1");
      const sealed = sealer.seal("test-map");
      expect(sealer.open(sealed)).toBe("test-map");
    });

    test("refuses when currentVersion is not in keys", () => {
      expect(
        () =>
          new HostSecretKeySealer({
            currentVersion: "v2",
            keys: new Map([["v1", v1Key]]),
          }),
      ).toThrow('Current key encryption version "v2" not found in keys.');
    });

    test("refuses when currentVersion is missing in direct construction", () => {
      expect(
        () => new HostSecretKeySealer(new Map([["v1", v1Key]]) as unknown as KeyEncryptionSettings),
      ).toThrow("currentVersion is required");
    });
  });
});
