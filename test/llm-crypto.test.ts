import { describe, expect, it } from "vitest";
import { hkdfSync } from "node:crypto";
import {
  decodeBase64Url,
  decryptLlmSecret,
  deriveLlmKeyMaterial,
  encodeBase64Url,
  encryptLlmSecret,
  isLlmSecretEnvelope,
  isValidInstanceSecret,
  sha256HexBytes,
  sha256HexText,
} from "../src/security/llm-crypto.ts";

const INSTANCE_SECRET = "test-instance-secret-0123456789abcdef";
const OTHER_SECRET = "another-instance-secret-0123456789abcd";

describe("llm-crypto", () => {
  it("accepts only instance secrets of at least 32 bytes", () => {
    expect(isValidInstanceSecret(INSTANCE_SECRET)).toBe(true);
    expect(isValidInstanceSecret("a".repeat(32))).toBe(true);
    expect(isValidInstanceSecret("a".repeat(31))).toBe(false);
    expect(isValidInstanceSecret("")).toBe(false);
    expect(isValidInstanceSecret(undefined)).toBe(false);
    expect(isValidInstanceSecret(123)).toBe(false);
    // Byte length, not character count.
    expect(isValidInstanceSecret("密".repeat(11))).toBe(true);
    expect(isValidInstanceSecret("密".repeat(10))).toBe(false);
  });

  it("round-trips base64url and rejects foreign alphabets", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toEqual(bytes);
    expect(decodeBase64Url("")).toBeNull();
    expect(decodeBase64Url("ab+cd")).toBeNull();
    expect(decodeBase64Url("ab/cd")).toBeNull();
  });

  it("hashes bytes and text to lowercase hex", async () => {
    const hex = await sha256HexText("abc");
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex).toHaveLength(64);
    expect(await sha256HexBytes(new TextEncoder().encode("abc"))).toBe(hex);
  });

  it("derives the key with the documented HKDF parameters", async () => {
    // Pins salt/info/domain separation: any silent change here would break
    // every ciphertext already stored in R2.
    const expected = new Uint8Array(
      hkdfSync(
        "sha256",
        INSTANCE_SECRET,
        "msv/llm-credential/v1",
        "msv/llm-credential/v1",
        32,
      ),
    );
    expect(await deriveLlmKeyMaterial(INSTANCE_SECRET)).toEqual(expected);
  });

  it("derives deterministic but secret-specific key material", async () => {
    const first = await deriveLlmKeyMaterial(INSTANCE_SECRET);
    const second = await deriveLlmKeyMaterial(INSTANCE_SECRET);
    const other = await deriveLlmKeyMaterial(OTHER_SECRET);
    expect(first).toHaveLength(32);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    // Must not collapse into the bare SHA-256 material used by instance-config.
    const bare = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(INSTANCE_SECRET),
      ),
    );
    expect(first).not.toEqual(bare);
  });

  it("encrypts and decrypts a payload", async () => {
    const envelope = await encryptLlmSecret(
      { apiKey: "sk-example-key-value", extra: {} },
      INSTANCE_SECRET,
    );
    expect(isLlmSecretEnvelope(envelope)).toBe(true);
    expect(envelope.kdf).toBe("HKDF-SHA256");
    expect(envelope.algorithm).toBe("AES-GCM");
    expect(envelope.info).toBe("msv/llm-credential/v1");
    expect(envelope.ciphertext).not.toContain("sk-example-key-value");

    const plaintext = await decryptLlmSecret(envelope, INSTANCE_SECRET);
    expect(plaintext.apiKey).toBe("sk-example-key-value");
    expect(plaintext.extra).toEqual({});
  });

  it("uses a fresh IV per encryption", async () => {
    const first = await encryptLlmSecret(
      { apiKey: "sk-example-key-value", extra: {} },
      INSTANCE_SECRET,
    );
    const second = await encryptLlmSecret(
      { apiKey: "sk-example-key-value", extra: {} },
      INSTANCE_SECRET,
    );
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("refuses to decrypt with the wrong instance secret", async () => {
    const envelope = await encryptLlmSecret(
      { apiKey: "sk-example-key-value", extra: {} },
      INSTANCE_SECRET,
    );
    await expect(decryptLlmSecret(envelope, OTHER_SECRET)).rejects.toThrow();
  });

  it("refuses tampered or malformed envelopes", async () => {
    const envelope = await encryptLlmSecret(
      { apiKey: "sk-example-key-value", extra: {} },
      INSTANCE_SECRET,
    );
    const tampered = {
      ...envelope,
      ciphertext: encodeBase64Url(
        new Uint8Array([...decodeBase64Url(envelope.ciphertext)!, 0]),
      ),
    };
    await expect(decryptLlmSecret(tampered, INSTANCE_SECRET)).rejects.toThrow();

    await expect(
      decryptLlmSecret({ ...envelope, iv: "!!!" }, INSTANCE_SECRET),
    ).rejects.toThrow();
    await expect(
      decryptLlmSecret({ ...envelope, info: "other" }, INSTANCE_SECRET),
    ).rejects.toThrow();
    await expect(decryptLlmSecret(null, INSTANCE_SECRET)).rejects.toThrow();
    await expect(decryptLlmSecret("nope", INSTANCE_SECRET)).rejects.toThrow();
  });
});
