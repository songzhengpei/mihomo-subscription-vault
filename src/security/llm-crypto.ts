import type { LlmSecretEnvelope, LlmSecretPlaintext } from "../types.ts";

/**
 * Domain-separated key derivation for the LLM credential vault.
 *
 * `instance-config.ts` uses a bare `SHA-256(INSTANCE_SECRET)` as its AES key.
 * This module must not reuse that material, so it derives its own key with an
 * HKDF salt/info unique to this feature. The fallback path keeps the same
 * domain separation when HKDF is unavailable at runtime.
 */
const LLM_KDF_INFO = "msv/llm-credential/v1";
const MIN_INSTANCE_SECRET_BYTES = 32;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_API_KEY_LENGTH = 512;

export function isValidInstanceSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length >= MIN_INSTANCE_SECRET_BYTES
  );
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64URL_RE.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

async function importAesKey(material: Uint8Array): Promise<CryptoKey> {
  if (material.length !== 32) throw new Error("派生密钥长度无效");
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Exported separately so tests can pin the derivation against a known vector.
 */
export async function deriveLlmKeyMaterial(
  instanceSecret: string,
): Promise<Uint8Array> {
  const ikm = new TextEncoder().encode(instanceSecret);
  const info = new TextEncoder().encode(LLM_KDF_INFO);
  try {
    const hkdfKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: info, info },
      hkdfKey,
      256,
    );
    return new Uint8Array(bits);
  } catch {
    // HKDF unavailable: fall back to a domain-separated SHA-256 digest. Still
    // distinct from instance-config's bare SHA-256(INSTANCE_SECRET).
    const concatenated = new Uint8Array(ikm.length + info.length);
    concatenated.set(ikm, 0);
    concatenated.set(info, ikm.length);
    const digest = await crypto.subtle.digest("SHA-256", concatenated);
    return new Uint8Array(digest);
  }
}

export async function deriveLlmEncryptionKey(
  instanceSecret: string,
): Promise<CryptoKey> {
  return importAesKey(await deriveLlmKeyMaterial(instanceSecret));
}

export function isLlmSecretEnvelope(
  value: unknown,
): value is LlmSecretEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.schemaVersion === 1 &&
    envelope.algorithm === "AES-GCM" &&
    envelope.kdf === "HKDF-SHA256" &&
    envelope.info === LLM_KDF_INFO &&
    typeof envelope.iv === "string" &&
    typeof envelope.ciphertext === "string"
  );
}

export function isLlmSecretPlaintext(
  value: unknown,
): value is LlmSecretPlaintext {
  if (typeof value !== "object" || value === null) return false;
  const plaintext = value as Record<string, unknown>;
  const extra = plaintext.extra;
  return (
    typeof plaintext.apiKey === "string" &&
    plaintext.apiKey.length > 0 &&
    plaintext.apiKey.length <= MAX_API_KEY_LENGTH &&
    (extra === undefined ||
      (typeof extra === "object" && extra !== null && !Array.isArray(extra)))
  );
}

export async function encryptLlmSecret(
  plaintext: LlmSecretPlaintext,
  instanceSecret: string,
): Promise<LlmSecretEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveLlmEncryptionKey(instanceSecret);
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  return {
    schemaVersion: 1,
    algorithm: "AES-GCM",
    kdf: "HKDF-SHA256",
    info: LLM_KDF_INFO,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

/** Throws when the envelope is malformed, truncated, or sealed with another key. */
export async function decryptLlmSecret(
  envelope: unknown,
  instanceSecret: string,
): Promise<LlmSecretPlaintext> {
  if (!isLlmSecretEnvelope(envelope)) throw new Error("密文信封格式无效");
  const iv = decodeBase64Url(envelope.iv);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (!iv || iv.length !== 12 || !ciphertext)
    throw new Error("密文信封格式无效");
  const key = await deriveLlmEncryptionKey(instanceSecret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isLlmSecretPlaintext(value)) throw new Error("密文内容无效");
  return {
    apiKey: value.apiKey,
    extra: value.extra ?? {},
  };
}
