import { pbkdf2Sync, timingSafeEqual } from "node:crypto";

const ITERATIONS = 100_000;
const PASSWORD_HASH_PATTERN =
  /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function createPasswordHash(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

export function isPasswordHash(value: string): boolean {
  return PASSWORD_HASH_PATTERN.test(value);
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const match = PASSWORD_HASH_PATTERN.exec(encodedHash);
  if (!match) return false;
  const iterations = Number(match[1]);
  const salt = decodeBase64Url(match[2]!);
  const expected = decodeBase64Url(match[3]!);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 1_000_000 ||
    !salt ||
    salt.length < 16 ||
    !expected ||
    expected.length !== 32
  ) {
    return false;
  }
  const actual = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return timingSafeEqual(actual, expected);
}
