import type { Env } from "../types.ts";
import { createPasswordHash, isPasswordHash } from "../security/password.ts";

const INSTANCE_CONFIG_KEY = "config/instance.v1.enc.json";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

interface InstanceConfig {
  schemaVersion: 1;
  adminUsername: string;
  adminPasswordHash: string;
  adminToken: string;
  downloadToken: string;
  sessionSecret: string;
  createdAt: string;
}

interface EncryptedInstanceConfig {
  schemaVersion: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export interface InstanceCredentials {
  adminToken: string;
  downloadToken: string;
}

export type RuntimeEnvResult =
  | { configured: true; env: Env }
  | {
      configured: false;
      reason: "INSTANCE_SECRET_REQUIRED" | "SETUP_REQUIRED";
    };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!TOKEN_PATTERN.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function randomToken(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function hasValidInstanceSecret(env: Env): env is Env & {
  INSTANCE_SECRET: string;
} {
  return (
    typeof env.INSTANCE_SECRET === "string" &&
    new TextEncoder().encode(env.INSTANCE_SECRET).length >= 32
  );
}

export function hasLegacyConfiguration(env: Env): boolean {
  return (
    typeof env.ADMIN_TOKEN === "string" &&
    env.ADMIN_TOKEN.length > 0 &&
    typeof env.DOWNLOAD_TOKEN === "string" &&
    env.DOWNLOAD_TOKEN.length > 0
  );
}

async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function isInstanceConfig(value: unknown): value is InstanceConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    config.schemaVersion === 1 &&
    typeof config.adminUsername === "string" &&
    config.adminUsername.length >= 3 &&
    config.adminUsername.length <= 64 &&
    typeof config.adminPasswordHash === "string" &&
    isPasswordHash(config.adminPasswordHash) &&
    typeof config.adminToken === "string" &&
    TOKEN_PATTERN.test(config.adminToken) &&
    typeof config.downloadToken === "string" &&
    TOKEN_PATTERN.test(config.downloadToken) &&
    typeof config.sessionSecret === "string" &&
    new TextEncoder().encode(config.sessionSecret).length >= 32 &&
    typeof config.createdAt === "string"
  );
}

function isEncryptedConfig(value: unknown): value is EncryptedInstanceConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    config.schemaVersion === 1 &&
    config.algorithm === "AES-GCM" &&
    typeof config.iv === "string" &&
    typeof config.ciphertext === "string"
  );
}

async function encryptConfig(
  config: InstanceConfig,
  secret: string,
): Promise<EncryptedInstanceConfig> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(config));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return {
    schemaVersion: 1,
    algorithm: "AES-GCM",
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

async function decryptConfig(
  stored: EncryptedInstanceConfig,
  secret: string,
): Promise<InstanceConfig> {
  const iv = decodeBase64Url(stored.iv);
  const ciphertext = decodeBase64Url(stored.ciphertext);
  if (!iv || iv.length !== 12 || !ciphertext) {
    throw new Error("实例配置格式无效");
  }
  const key = await deriveEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isInstanceConfig(value)) throw new Error("实例配置内容无效");
  return value;
}

async function readEncryptedConfig(
  bucket: R2Bucket,
): Promise<EncryptedInstanceConfig | null> {
  const object = await bucket.get(INSTANCE_CONFIG_KEY);
  if (!object) return null;
  const value: unknown = await object.json();
  if (!isEncryptedConfig(value)) throw new Error("实例配置文件无效");
  return value;
}

export async function isInstanceConfigured(env: Env): Promise<boolean> {
  if (hasLegacyConfiguration(env)) return true;
  return (await env.SUBSCRIPTION_BUCKET.head(INSTANCE_CONFIG_KEY)) !== null;
}

export async function resolveRuntimeEnv(
  env: Env,
  requestOrigin: string,
): Promise<RuntimeEnvResult> {
  if (hasLegacyConfiguration(env)) {
    return {
      configured: true,
      env: { ...env, PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || requestOrigin },
    };
  }
  if (!hasValidInstanceSecret(env)) {
    return { configured: false, reason: "INSTANCE_SECRET_REQUIRED" };
  }
  const stored = await readEncryptedConfig(env.SUBSCRIPTION_BUCKET);
  if (!stored) return { configured: false, reason: "SETUP_REQUIRED" };
  const config = await decryptConfig(stored, env.INSTANCE_SECRET);
  return {
    configured: true,
    env: {
      ...env,
      ADMIN_TOKEN: config.adminToken,
      DOWNLOAD_TOKEN: config.downloadToken,
      ADMIN_USERNAME: config.adminUsername,
      ADMIN_PASSWORD_HASH: config.adminPasswordHash,
      SESSION_SECRET: config.sessionSecret,
      PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || requestOrigin,
    },
  };
}

export async function secretsMatch(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function createInstanceConfiguration(
  env: Env,
  username: string,
  password: string,
  now = new Date(),
): Promise<InstanceCredentials> {
  if (!hasValidInstanceSecret(env)) {
    throw new Error("INSTANCE_SECRET 未配置或长度不足");
  }
  const config: InstanceConfig = {
    schemaVersion: 1,
    adminUsername: username,
    adminPasswordHash: createPasswordHash(password),
    adminToken: randomToken(32),
    downloadToken: randomToken(24),
    sessionSecret: randomToken(48),
    createdAt: now.toISOString(),
  };
  const encrypted = await encryptConfig(config, env.INSTANCE_SECRET);
  const result = await env.SUBSCRIPTION_BUCKET.put(
    INSTANCE_CONFIG_KEY,
    JSON.stringify(encrypted),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (!result) throw new Error("实例已完成初始化");
  return {
    adminToken: config.adminToken,
    downloadToken: config.downloadToken,
  };
}
