import type {
  LlmIntegrityStatus,
  LlmKeyDetail,
  LlmKeyErrorCode,
  LlmKeyListItem,
  LlmKeyMeta,
  LlmSecretHint,
} from "../types.ts";
import {
  decryptLlmSecret,
  encryptLlmSecret,
  isValidInstanceSecret,
  sha256HexText,
} from "../security/llm-crypto.ts";
import { validateSlug } from "../security/ssrf.ts";

/**
 * LLM credentials live under their own R2 prefix and are never part of the
 * provider subscription model. Nothing in the subscription listing, ordering,
 * export, or WebDAV code paths enumerates `llm/`, so storing credentials here
 * cannot leak into a unified backup archive.
 */
export const LLM_PREFIX = "llm/";

const NAME_MAX = 64;
const PROVIDER_MAX = 32;
const PROVIDER_RE = /^[a-z0-9._-]{1,32}$/;
const BASE_URL_MAX = 512;
const NOTES_MAX = 2000;
const MODELS_MAX = 100;
const MODEL_LEN_MAX = 128;
const TAGS_MAX = 20;
const TAG_LEN_MAX = 32;
const API_KEY_MIN = 8;
const API_KEY_MAX = 512;

export class LlmKeyError extends Error {
  constructor(
    public readonly code: LlmKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LlmKeyError";
  }
}

export function isLlmKeyError(value: unknown): value is LlmKeyError {
  return value instanceof LlmKeyError;
}

export function llmMetaKey(slug: string): string {
  return `${LLM_PREFIX}${slug}/meta.v1.json`;
}

export function llmSecretKey(slug: string): string {
  return `${LLM_PREFIX}${slug}/secret.v1.enc.json`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalidPayload(message: string): LlmKeyError {
  return new LlmKeyError("INVALID_LLM_PAYLOAD", message);
}

function invalidSlug(): LlmKeyError {
  return new LlmKeyError("INVALID_SLUG", "Slug 不合法");
}

function requireSlug(value: unknown): string {
  if (typeof value !== "string" || !validateSlug(value)) throw invalidSlug();
  return value;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw invalidPayload(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalidPayload(`${field} 不能为空`);
  if (trimmed.length > max) {
    throw invalidPayload(`${field} 长度不能超过 ${max} 个字符`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidPayload(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw invalidPayload(`${field} 长度不能超过 ${max} 个字符`);
  }
  return trimmed;
}

function requireStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidPayload(`${field} 必须是数组`);
  if (value.length > maxItems) {
    throw invalidPayload(`${field} 最多只能有 ${maxItems} 项`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw invalidPayload(`${field} 的每一项都必须是字符串`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > maxLength) {
      throw invalidPayload(`${field} 的每一项不能超过 ${maxLength} 个字符`);
    }
    if (!result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

function optionalBaseUrl(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidPayload("baseUrl 必须是字符串");
  const raw = value.trim();
  // Optional: the management UI only collects name/slug/apiKey.
  if (raw.length === 0) return "";
  if (raw.length > BASE_URL_MAX) {
    throw invalidPayload(`baseUrl 长度不能超过 ${BASE_URL_MAX} 个字符`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidPayload("baseUrl 不是合法的 URL");
  }
  if (url.protocol !== "https:") {
    throw invalidPayload("baseUrl 必须使用 https");
  }
  if (url.username || url.password) {
    throw invalidPayload("baseUrl 不能内嵌用户名或密码");
  }
  return raw;
}

function optionalProvider(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidPayload("provider 必须是字符串");
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (!PROVIDER_RE.test(trimmed)) {
    throw invalidPayload(
      "provider 只能是 1-32 位小写字母、数字、点、下划线或连字符",
    );
  }
  return trimmed;
}

function requireApiKey(value: unknown): string {
  if (typeof value !== "string") throw invalidPayload("apiKey 必须是字符串");
  const key = value.trim();
  if (key.length < API_KEY_MIN) {
    throw invalidPayload(`apiKey 长度不能少于 ${API_KEY_MIN} 个字符`);
  }
  if (key.length > API_KEY_MAX) {
    throw invalidPayload(`apiKey 长度不能超过 ${API_KEY_MAX} 个字符`);
  }
  if (/\s/.test(key)) throw invalidPayload("apiKey 不能包含空白字符");
  return key;
}

export interface LlmKeyCreateInput {
  slug: string;
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  notes: string;
  tags: string[];
  apiKey: string;
}

export interface LlmKeyUpdateInput {
  name?: string;
  provider?: string;
  baseUrl?: string;
  models?: string[];
  notes?: string;
  tags?: string[];
  apiKey?: string;
}

export function normalizeLlmKeyCreate(raw: unknown): LlmKeyCreateInput {
  if (typeof raw !== "object" || raw === null) {
    throw invalidPayload("请求体必须是 JSON 对象");
  }
  const input = raw as Record<string, unknown>;
  return {
    slug: requireSlug(input.slug),
    name: requireText(input.name, "name", NAME_MAX),
    provider: optionalProvider(input.provider),
    baseUrl: optionalBaseUrl(input.baseUrl),
    models: requireStringList(
      input.models,
      "models",
      MODELS_MAX,
      MODEL_LEN_MAX,
    ),
    notes: optionalText(input.notes, "notes", NOTES_MAX),
    tags: requireStringList(input.tags, "tags", TAGS_MAX, TAG_LEN_MAX),
    apiKey: requireApiKey(input.apiKey),
  };
}

export function normalizeLlmKeyUpdate(raw: unknown): LlmKeyUpdateInput {
  if (typeof raw !== "object" || raw === null) {
    throw invalidPayload("请求体必须是 JSON 对象");
  }
  const input = raw as Record<string, unknown>;
  const patch: LlmKeyUpdateInput = {};
  if (input.name !== undefined) {
    patch.name = requireText(input.name, "name", NAME_MAX);
  }
  if (input.provider !== undefined) {
    patch.provider = optionalProvider(input.provider);
  }
  if (input.baseUrl !== undefined) {
    patch.baseUrl = optionalBaseUrl(input.baseUrl);
  }
  if (input.models !== undefined) {
    patch.models = requireStringList(
      input.models,
      "models",
      MODELS_MAX,
      MODEL_LEN_MAX,
    );
  }
  if (input.notes !== undefined) {
    patch.notes = optionalText(input.notes, "notes", NOTES_MAX);
  }
  if (input.tags !== undefined) {
    patch.tags = requireStringList(input.tags, "tags", TAGS_MAX, TAG_LEN_MAX);
  }
  if (input.apiKey !== undefined) {
    patch.apiKey = requireApiKey(input.apiKey);
  }
  if (Object.keys(patch).length === 0) {
    throw invalidPayload("没有需要更新的字段");
  }
  return patch;
}

function buildHint(apiKey: string): LlmSecretHint {
  return { last4: apiKey.slice(-4), length: apiKey.length };
}

function isLlmKeyMeta(value: unknown): value is LlmKeyMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  const secret = meta.secret as Record<string, unknown> | undefined;
  const hint = meta.hint as Record<string, unknown> | undefined;
  return (
    meta.schemaVersion === 1 &&
    typeof meta.slug === "string" &&
    validateSlug(meta.slug) &&
    typeof meta.name === "string" &&
    typeof meta.provider === "string" &&
    typeof meta.baseUrl === "string" &&
    Array.isArray(meta.models) &&
    typeof meta.notes === "string" &&
    Array.isArray(meta.tags) &&
    typeof hint === "object" &&
    hint !== null &&
    typeof hint.last4 === "string" &&
    typeof hint.length === "number" &&
    typeof secret === "object" &&
    secret !== null &&
    typeof secret.key === "string" &&
    typeof secret.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(secret.sha256) &&
    typeof secret.updatedAt === "string" &&
    typeof meta.createdAt === "string" &&
    typeof meta.updatedAt === "string"
  );
}

function parseMeta(text: string): LlmKeyMeta | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLlmKeyMeta(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

interface ObjectRecord {
  text: string;
  etag: string;
}

async function readObject(
  bucket: R2Bucket,
  key: string,
): Promise<ObjectRecord | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return { text: await object.text(), etag: object.etag };
}

/**
 * Single listing pass over the `llm/` prefix. Returns the slugs **and** every
 * object key, so callers can tell whether a ciphertext exists without issuing a
 * separate HEAD per credential.
 */
async function listLlmObjects(
  bucket: R2Bucket,
): Promise<{ slugs: string[]; keys: Set<string> }> {
  const slugs = new Set<string>();
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await bucket.list({ prefix: LLM_PREFIX, cursor });
    for (const object of result.objects) {
      keys.add(object.key);
      const match = object.key.match(/^llm\/([^/]+)\//);
      if (match && validateSlug(match[1]!)) slugs.add(match[1]!);
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return { slugs: [...slugs].sort(), keys };
}

export async function listLlmSlugs(bucket: R2Bucket): Promise<string[]> {
  return (await listLlmObjects(bucket)).slugs;
}

// ---------------------------------------------------------------------------
// Store operations
// ---------------------------------------------------------------------------

function requireSecret(instanceSecret: unknown): string {
  if (!isValidInstanceSecret(instanceSecret)) {
    throw new LlmKeyError(
      "LLM_STORE_UNAVAILABLE",
      "当前实例没有配置有效的 INSTANCE_SECRET，无法加密或解密凭据",
    );
  }
  return instanceSecret;
}

export async function createLlmKey(
  bucket: R2Bucket,
  instanceSecret: string | undefined,
  rawInput: unknown,
  now = new Date(),
): Promise<LlmKeyMeta> {
  const secret = requireSecret(instanceSecret);
  const input = normalizeLlmKeyCreate(rawInput);
  const metaKey = llmMetaKey(input.slug);
  const timestamp = now.toISOString();
  const envelope = await encryptLlmSecret(
    { apiKey: input.apiKey, extra: {} },
    secret,
  );
  const serialized = JSON.stringify(envelope);
  const secretKey = llmSecretKey(input.slug);
  // The conditional create *is* the existence check: an unconditional
  // pre-flight read would cost a whole extra round trip. A pre-existing
  // ciphertext makes this put fail, so nothing is overwritten.
  const secretPut = await bucket.put(secretKey, serialized, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!secretPut) {
    throw new LlmKeyError("LLM_KEY_CONFLICT", "该 Slug 已存在");
  }

  const meta: LlmKeyMeta = {
    schemaVersion: 1,
    slug: input.slug,
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    models: input.models,
    notes: input.notes,
    tags: input.tags,
    hint: buildHint(input.apiKey),
    secret: {
      key: secretKey,
      sha256: await sha256HexText(serialized),
      updatedAt: timestamp,
      etag: secretPut.etag,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const metaPut = await bucket.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!metaPut) {
    // The slug already had a meta record but no ciphertext (a pointer left
    // behind by a manual delete). Undo our ciphertext write so the entry keeps
    // its previous "missing" state instead of becoming hash-mismatched.
    await bucket.delete(secretKey);
    throw new LlmKeyError("LLM_KEY_CONFLICT", "该 Slug 已存在");
  }
  return meta;
}

export async function listLlmKeys(bucket: R2Bucket): Promise<LlmKeyListItem[]> {
  // One list pass replaces a HEAD request per credential.
  const { slugs, keys } = await listLlmObjects(bucket);
  const items = await Promise.all(
    slugs.map(async (slug): Promise<LlmKeyListItem | null> => {
      const record = await readObject(bucket, llmMetaKey(slug));
      if (!record) return null;
      const meta = parseMeta(record.text);
      if (!meta) return null;
      return {
        slug: meta.slug,
        name: meta.name,
        provider: meta.provider,
        baseUrl: meta.baseUrl,
        models: meta.models,
        tags: meta.tags,
        hint: meta.hint,
        secretPresent: keys.has(meta.secret.key),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      };
    }),
  );
  return items
    .filter((item): item is LlmKeyListItem => item !== null)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug),
    );
}

export async function getLlmKey(
  bucket: R2Bucket,
  slug: string,
): Promise<LlmKeyDetail | null> {
  if (!validateSlug(slug)) throw invalidSlug();
  const metaRecord = await readObject(bucket, llmMetaKey(slug));
  if (!metaRecord) return null;
  const meta = parseMeta(metaRecord.text);
  if (!meta) {
    throw new LlmKeyError("LLM_KEY_CORRUPTED", "凭据元数据已损坏");
  }
  const secretRecord = await readObject(bucket, meta.secret.key);
  if (!secretRecord) return { meta, integrity: "missing" };
  const sha256 = await sha256HexText(secretRecord.text);
  const integrity: LlmIntegrityStatus =
    sha256 === meta.secret.sha256 ? "ok" : "corrupted";
  return { meta, integrity };
}

export async function updateLlmKey(
  bucket: R2Bucket,
  instanceSecret: string | undefined,
  slug: string,
  rawPatch: unknown,
  now = new Date(),
): Promise<LlmKeyMeta> {
  if (!validateSlug(slug)) throw invalidSlug();
  const patch = normalizeLlmKeyUpdate(rawPatch);
  const metaKey = llmMetaKey(slug);
  const metaRecord = await readObject(bucket, metaKey);
  if (!metaRecord) {
    throw new LlmKeyError("LLM_KEY_NOT_FOUND", "凭据不存在");
  }
  const current = parseMeta(metaRecord.text);
  if (!current) {
    throw new LlmKeyError("LLM_KEY_CORRUPTED", "凭据元数据已损坏");
  }

  const timestamp = now.toISOString();
  let pointer = current.secret;
  if (patch.apiKey !== undefined) {
    const secret = requireSecret(instanceSecret);
    const secretKey = current.secret.key || llmSecretKey(slug);
    // Assert the exact revision being replaced. The ETag recorded on create or
    // the last rotation avoids re-reading the ciphertext; records written before
    // that field existed fall back to a read.
    const expectedEtag =
      current.secret.etag ?? (await readObject(bucket, secretKey))?.etag;
    const envelope = await encryptLlmSecret(
      { apiKey: patch.apiKey, extra: {} },
      secret,
    );
    const serialized = JSON.stringify(envelope);
    const secretPut = await bucket.put(secretKey, serialized, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: expectedEtag
        ? { etagMatches: expectedEtag }
        : { etagDoesNotMatch: "*" },
    });
    if (!secretPut) {
      throw new LlmKeyError(
        "LLM_KEY_CONFLICT",
        "密钥正被并发修改，请刷新后重试",
      );
    }
    pointer = {
      key: secretKey,
      sha256: await sha256HexText(serialized),
      updatedAt: timestamp,
      etag: secretPut.etag,
    };
  }

  const next: LlmKeyMeta = {
    ...current,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.provider !== undefined && { provider: patch.provider }),
    ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl }),
    ...(patch.models !== undefined && { models: patch.models }),
    ...(patch.notes !== undefined && { notes: patch.notes }),
    ...(patch.tags !== undefined && { tags: patch.tags }),
    ...(patch.apiKey !== undefined && { hint: buildHint(patch.apiKey) }),
    secret: pointer,
    updatedAt: timestamp,
  };
  const metaPut = await bucket.put(metaKey, JSON.stringify(next), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: metaRecord.etag },
  });
  if (!metaPut) {
    throw new LlmKeyError(
      "LLM_KEY_CONFLICT",
      "凭据元数据正被并发修改，请刷新后重试",
    );
  }
  return next;
}

export async function deleteLlmKey(
  bucket: R2Bucket,
  slug: string,
): Promise<boolean> {
  if (!validateSlug(slug)) throw invalidSlug();
  const metaKey = llmMetaKey(slug);
  const metaRecord = await readObject(bucket, metaKey);
  if (!metaRecord) return false;
  const meta = parseMeta(metaRecord.text);
  // Meta first so the entry disappears from listings immediately; a leftover
  // ciphertext is harmless and gets overwritten by the next create.
  await bucket.delete(metaKey);
  await bucket.delete(meta?.secret.key ?? llmSecretKey(slug));
  return true;
}

export async function revealLlmKey(
  bucket: R2Bucket,
  instanceSecret: string | undefined,
  slug: string,
): Promise<{ meta: LlmKeyMeta; apiKey: string }> {
  const secret = requireSecret(instanceSecret);
  if (!validateSlug(slug)) throw invalidSlug();
  // Single pass: read the meta and the ciphertext once each, then verify and
  // decrypt from the very same bytes. (getLlmKey() would read the ciphertext a
  // second time just to hash it.)
  const metaRecord = await readObject(bucket, llmMetaKey(slug));
  if (!metaRecord) {
    throw new LlmKeyError("LLM_KEY_NOT_FOUND", "凭据不存在");
  }
  const meta = parseMeta(metaRecord.text);
  if (!meta) {
    throw new LlmKeyError("LLM_KEY_CORRUPTED", "凭据元数据已损坏");
  }
  const record = await readObject(bucket, meta.secret.key);
  if (!record) {
    throw new LlmKeyError("LLM_KEY_CORRUPTED", "凭据密文缺失");
  }
  if ((await sha256HexText(record.text)) !== meta.secret.sha256) {
    // Fail closed: never return a stale or unverifiable key.
    throw new LlmKeyError(
      "LLM_KEY_CORRUPTED",
      "凭据完整性校验失败，请重新保存该凭据",
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(record.text);
  } catch {
    throw new LlmKeyError("LLM_KEY_CORRUPTED", "凭据密文格式无效");
  }
  try {
    const plaintext = await decryptLlmSecret(envelope, secret);
    return { meta, apiKey: plaintext.apiKey };
  } catch {
    throw new LlmKeyError(
      "LLM_KEY_CORRUPTED",
      "凭据无法解密，可能是 INSTANCE_SECRET 已更换",
    );
  }
}
