import type {
  Env,
  LatestJson,
  ProviderMeta,
  ProviderListItem,
  ProviderListEntry,
  WebDAVConfig,
  HistoryItem,
  VersionArtifact,
  ProviderVersionMeta,
  LatestVersionPointer,
  PublishVersionInput,
  PublishedVersion,
  PublishDependencies,
  VersionPublishErrorCode,
  StoredLatestPointer,
  ProviderDistributionMetadata,
  PublicProviderErrorCode,
  ResolvedProfileBytes,
  ResolvedProfileMetadata,
  ProviderBundle,
  NodeStats,
  InternalDependencyInfo,
} from "../types.ts";
import { isLegacyLatestJson, isLatestVersionPointerV1 } from "../types.ts";
import { validateSlug } from "../security/ssrf.ts";

// --- Path helpers (centralized) ---

export function getProviderBaseKey(slug: string): string {
  return `providers/${slug}`;
}

export function getVersionBaseKey(slug: string, versionId: string): string {
  return `${getProviderBaseKey(slug)}/versions/${versionId}`;
}

export function getVersionKeys(slug: string, versionId: string) {
  const base = getVersionBaseKey(slug, versionId);
  return {
    raw: `${base}/raw.yaml`,
    provider: `${base}/provider.yaml`,
    profile: `${base}/profile.yaml`,
    meta: `${base}/meta.json`,
    latest: `${getProviderBaseKey(slug)}/latest.json`,
  };
}

/** Legacy flat paths (pre–version-directory). */
function legacyVersionYamlPath(slug: string, versionId: string): string {
  return `providers/${slug}/versions/${versionId}.yaml`;
}

function legacyVersionJsonPath(slug: string, versionId: string): string {
  return `providers/${slug}/versions/${versionId}.json`;
}

function latestPath(slug: string): string {
  return `${getProviderBaseKey(slug)}/latest.json`;
}

function stagingPath(slug: string, requestId: string): string {
  return `providers/${slug}/staging/${requestId}.json`;
}

function stagingRawPath(slug: string, requestId: string): string {
  return `providers/${slug}/staging/${requestId}.raw`;
}

function generateVersionId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${ts}-${hex}`;
}

// --- SHA-256 helper ---
async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function contentLengthBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

// --- Stable JSON serialization ---
function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

// --- Validation helpers ---

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Safe single path segment. Restricted to the character set actually produced by
 * generateVersionId/generateVersionIdWithHash so that imported archives cannot
 * smuggle quotes or markup into R2 keys, response headers, or the admin UI.
 */
const VERSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;

export function validateVersionId(versionId: string): boolean {
  return VERSION_ID_PATTERN.test(versionId);
}

// --- Stored pointer parsing (centralized) ---

function parseStoredPointer(raw: unknown): StoredLatestPointer {
  if (isLatestVersionPointerV1(raw)) return raw;
  if (isLegacyLatestJson(raw)) return raw;
  throw new VersionPublishError(
    "INVALID_STORED_POINTER",
    "latest.json has unrecognized structure",
  );
}

// --- Error types ---

export class VersionPublishError extends Error {
  constructor(
    public readonly code: VersionPublishErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VersionPublishError";
  }
}

function createError(
  code: VersionPublishErrorCode,
  message: string,
): VersionPublishError {
  return new VersionPublishError(code, message);
}

// --- Strict ProviderVersionMeta type guard ---

export function isProviderVersionMeta(
  value: unknown,
): value is ProviderVersionMeta {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return false;
  if (typeof raw.providerSlug !== "string" || !validateSlug(raw.providerSlug))
    return false;
  if (typeof raw.subscriptionId !== "string" || !raw.subscriptionId)
    return false;
  if (typeof raw.uid !== "string" || !raw.uid) return false;
  if (typeof raw.versionId !== "string" || !validateVersionId(raw.versionId))
    return false;
  if (typeof raw.createdAt !== "string" || !raw.createdAt) return false;
  if (typeof raw.sourceSha256 !== "string" || !HEX64.test(raw.sourceSha256))
    return false;
  if (
    typeof raw.nodeCount !== "number" ||
    !Number.isInteger(raw.nodeCount) ||
    raw.nodeCount < 0
  )
    return false;
  if (typeof raw.generatorVersion !== "string" || !raw.generatorVersion)
    return false;

  // distribution
  const dist = raw.distribution;
  if (typeof dist !== "object" || dist === null) return false;
  const d = dist as Record<string, unknown>;
  if (typeof d.providerName !== "string" || !d.providerName) return false;
  if (typeof d.sourceHost !== "string") return false;
  if (
    d.subscriptionUserinfo !== undefined &&
    typeof d.subscriptionUserinfo !== "string"
  )
    return false;
  if (
    d.profileUpdateInterval !== undefined &&
    typeof d.profileUpdateInterval !== "string"
  )
    return false;
  if (
    d.profileWebPageUrl !== undefined &&
    typeof d.profileWebPageUrl !== "string"
  )
    return false;
  if (
    d.clientUpdatePolicy !== undefined &&
    !isClientUpdatePolicy(d.clientUpdatePolicy)
  )
    return false;

  // artifacts
  const arts = raw.artifacts;
  if (typeof arts !== "object" || arts === null) return false;
  const a = arts as Record<string, unknown>;
  for (const name of ["raw", "provider", "profile"] as const) {
    const art = a[name];
    if (typeof art !== "object" || art === null) return false;
    const ar = art as Record<string, unknown>;
    if (typeof ar.key !== "string" || !ar.key) return false;
    if (typeof ar.sha256 !== "string" || !HEX64.test(ar.sha256)) return false;
    if (
      typeof ar.contentLength !== "number" ||
      !Number.isInteger(ar.contentLength) ||
      ar.contentLength < 0
    )
      return false;
  }

  return true;
}

// --- Unified V1 resolver ---

interface ResolvedV1Version {
  meta: ProviderVersionMeta;
  metaText: string;
  metaSha256: string;
}

/**
 * Read and validate a V1 version directory.
 *
 * Validates: slug, versionId, meta.json at standard path, strict schema,
 * identity consistency (meta ↔ pointer when pointer provided), artifact keys.
 * Does NOT verify artifact object content hashes — callers do that when needed.
 */
async function resolveV1Version(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
  pointer?: LatestVersionPointer,
): Promise<ResolvedV1Version> {
  if (!validateSlug(slug)) {
    throw createError("INVALID_INPUT", `Invalid slug: ${slug}`);
  }
  if (!validateVersionId(versionId)) {
    throw createError("INVALID_INPUT", `Invalid versionId: ${versionId}`);
  }

  const keys = getVersionKeys(slug, versionId);

  // Pointer-level checks
  if (pointer) {
    if (pointer.providerSlug !== slug) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `pointer.providerSlug mismatch: expected ${slug}, got ${pointer.providerSlug}`,
      );
    }
    if (pointer.versionId !== versionId) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `pointer.versionId mismatch: expected ${versionId}, got ${pointer.versionId}`,
      );
    }
    if (pointer.metaKey !== keys.meta) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `pointer.metaKey mismatch: expected ${keys.meta}, got ${pointer.metaKey}`,
      );
    }
  }

  // Read meta.json
  const metaObj = await bucket.get(keys.meta);
  if (!metaObj) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `meta.json missing: ${keys.meta}`,
    );
  }

  const metaText = await metaObj.text();
  let metaRaw: Record<string, unknown>;
  try {
    metaRaw = JSON.parse(metaText) as Record<string, unknown>;
  } catch {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `meta.json invalid JSON: ${keys.meta}`,
    );
  }

  if (!isProviderVersionMeta(metaRaw)) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `meta.json fails strict ProviderVersionMeta schema: ${keys.meta}`,
    );
  }

  const meta = metaRaw as unknown as ProviderVersionMeta;
  const actualMetaSha256 = await sha256Hex(metaText);

  // Pointer SHA-256 check
  if (pointer && actualMetaSha256 !== pointer.metaSha256) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      "meta.json SHA-256 does not match pointer.metaSha256",
    );
  }

  // Meta identity checks
  if (meta.versionId !== versionId) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `meta.versionId mismatch: expected ${versionId}, got ${meta.versionId}`,
    );
  }
  if (meta.providerSlug !== slug) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `meta.providerSlug mismatch: expected ${slug}, got ${meta.providerSlug}`,
    );
  }

  // Pointer ↔ meta identity
  if (pointer) {
    if (meta.subscriptionId !== pointer.subscriptionId) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        "meta.subscriptionId does not match pointer.subscriptionId",
      );
    }
    if (meta.uid !== pointer.uid) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        "meta.uid does not match pointer.uid",
      );
    }
  }

  // Standard artifact keys
  for (const [name, art] of [
    ["raw", meta.artifacts.raw],
    ["provider", meta.artifacts.provider],
    ["profile", meta.artifacts.profile],
  ] as const) {
    if (art.key !== keys[name]) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `artifact ${name} key mismatch: expected ${keys[name]}, got ${art.key}`,
      );
    }
  }

  return { meta, metaText, metaSha256: actualMetaSha256 };
}

// --- Artifact verification (used by publish and rollback) ---

async function verifyObject(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const obj = await bucket.get(key);
  if (!obj) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `Object missing during verification: ${key}`,
    );
  }

  const content = await obj.text();
  const actualSha256 = await sha256Hex(content);
  const actualSize = contentLengthBytes(content);

  if (actualSha256 !== expectedSha256 || actualSize !== expectedSize) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `Object integrity mismatch: ${key}`,
    );
  }
}

/** Verify all 3 artifacts exist and match their meta.json hashes+sizes. */
async function verifyAllArtifacts(
  bucket: R2Bucket,
  meta: ProviderVersionMeta,
): Promise<void> {
  await verifyObject(
    bucket,
    meta.artifacts.raw.key,
    meta.artifacts.raw.sha256,
    meta.artifacts.raw.contentLength,
  );
  await verifyObject(
    bucket,
    meta.artifacts.provider.key,
    meta.artifacts.provider.sha256,
    meta.artifacts.provider.contentLength,
  );
  await verifyObject(
    bucket,
    meta.artifacts.profile.key,
    meta.artifacts.profile.sha256,
    meta.artifacts.profile.contentLength,
  );
}

// --- Public read API (backward-compatible) ---

export async function getLatest(
  bucket: R2Bucket,
  slug: string,
): Promise<LatestJson | null> {
  const obj = await bucket.get(latestPath(slug));
  if (!obj) return null;

  // Read body exactly once
  const rawText = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new VersionPublishError(
      "INVALID_STORED_POINTER",
      "latest.json contains invalid JSON",
    );
  }

  const pointer = parseStoredPointer(raw);

  if (isLegacyLatestJson(pointer)) {
    return pointer;
  }

  // V1 pointer — resolve via unified resolver using caller's slug as trust boundary
  const resolved = await resolveV1Version(
    bucket,
    slug,
    pointer.versionId,
    pointer,
  );

  return {
    versionId: pointer.versionId,
    sha256: resolved.meta.artifacts.provider.sha256,
    updatedAt: pointer.publishedAt,
  };
}

/**
 * Read the raw stored latest pointer without any compatibility projection.
 * Returns the actual StoredLatestPointer (V1 or legacy) plus the R2 etag.
 * Used by updateProvider() to read the real V1 pointer identity.
 */
export async function readStoredLatestPointer(
  bucket: R2Bucket,
  slug: string,
): Promise<{ pointer: StoredLatestPointer; etag: string } | null> {
  const obj = await bucket.get(latestPath(slug));
  if (!obj) return null;
  const rawText = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new VersionPublishError(
      "INVALID_STORED_POINTER",
      "latest.json contains invalid JSON",
    );
  }
  const pointer = parseStoredPointer(raw);
  return { pointer, etag: obj.etag };
}

export async function getProviderMeta(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<ProviderMeta | null> {
  // Try new version-directory path first
  const newKeys = getVersionKeys(slug, versionId);
  const newObj = await bucket.get(newKeys.meta);
  if (newObj) {
    // V1 format — resolve and project; corrupted V1 throws, not returns null
    const resolved = await resolveV1Version(bucket, slug, versionId);
    return projectV1MetaToLegacy(resolved.meta);
  }

  // Fallback to legacy flat path
  const legacyObj = await bucket.get(legacyVersionJsonPath(slug, versionId));
  if (!legacyObj) return null;
  const legacyMeta = (await legacyObj.json()) as Record<string, unknown>;
  if (!isValidLegacyMeta(legacyMeta)) return null;
  return legacyMeta as unknown as ProviderMeta;
}

function isValidLegacyMeta(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.versionId === "string" &&
    typeof raw.providerSlug === "string" &&
    typeof raw.providerName === "string" &&
    typeof raw.createdAt === "string" &&
    typeof raw.sha256 === "string" &&
    typeof raw.nodeCount === "number" &&
    typeof raw.sourceHost === "string" &&
    typeof raw.contentLength === "number"
  );
}

function projectV1MetaToLegacy(meta: ProviderVersionMeta): ProviderMeta {
  return {
    versionId: meta.versionId,
    providerSlug: meta.providerSlug,
    providerName: meta.distribution.providerName,
    createdAt: meta.createdAt,
    sha256: meta.artifacts.provider.sha256,
    nodeCount: meta.nodeCount,
    sourceHost: meta.distribution.sourceHost,
    contentLength: meta.artifacts.provider.contentLength,
    subscriptionUserinfo: meta.distribution.subscriptionUserinfo,
    profileUpdateInterval: meta.distribution.profileUpdateInterval,
    profileWebPageUrl: meta.distribution.profileWebPageUrl,
  };
}

export async function getVersionYaml(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<string | null> {
  // New path first
  const newKeys = getVersionKeys(slug, versionId);
  const newObj = await bucket.get(newKeys.provider);
  if (newObj) return newObj.text();

  // Legacy path fallback
  const legacyObj = await bucket.get(legacyVersionYamlPath(slug, versionId));
  if (!legacyObj) return null;
  return legacyObj.text();
}

export async function writeVersion(
  bucket: R2Bucket,
  slug: string,
  yamlContent: string,
  meta: Omit<ProviderMeta, "versionId">,
): Promise<ProviderMeta> {
  const versionId = generateVersionId();
  const fullMeta: ProviderMeta = { ...meta, versionId };

  // Write immutable version files with If-None-Match: * (write only if object doesn't exist)
  const yamlResult = await bucket.put(
    legacyVersionYamlPath(slug, versionId),
    yamlContent,
    {
      httpMetadata: { contentType: "text/yaml; charset=utf-8" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (!yamlResult) {
    throw new Error("版本 YAML 已存在或条件写入失败");
  }

  const jsonResult = await bucket.put(
    legacyVersionJsonPath(slug, versionId),
    JSON.stringify(fullMeta, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (!jsonResult) {
    throw new Error("版本元数据已存在或条件写入失败");
  }

  // Update latest.json with CAS (compare old ETag)
  const oldLatest = await bucket.get(latestPath(slug));
  const latest: LatestJson = {
    versionId,
    sha256: meta.sha256,
    updatedAt: meta.createdAt,
  };
  const latestResult = await bucket.put(
    latestPath(slug),
    JSON.stringify(latest, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: oldLatest
        ? { etagMatches: oldLatest.etag }
        : { etagDoesNotMatch: "*" },
    },
  );
  if (!latestResult) {
    throw new Error("订阅已被另一更新修改，请重新执行");
  }

  return fullMeta;
}

export async function updateLatest(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
  sha256: string,
  updatedAt: string,
): Promise<void> {
  const oldLatest = await bucket.get(latestPath(slug));
  const latest: LatestJson = { versionId, sha256, updatedAt };
  const result = await bucket.put(
    latestPath(slug),
    JSON.stringify(latest, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: oldLatest
        ? { etagMatches: oldLatest.etag }
        : { etagDoesNotMatch: "*" },
    },
  );
  if (!result) {
    throw new Error("回滚失败：订阅已被另一操作修改，请重试");
  }
}

export async function listSlugs(bucket: R2Bucket): Promise<string[]> {
  const slugs = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await bucket.list({
      prefix: "providers/",
      cursor,
      delimiter: "/",
    });
    for (const prefix of result.delimitedPrefixes) {
      const match = prefix.match(/^providers\/([^/]+)\//);
      if (match?.[1]) slugs.add(match[1]);
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return [...slugs].sort();
}

const PROVIDER_ORDER_KEY = "vault/provider-order.json";

export async function getProviderOrder(bucket: R2Bucket): Promise<string[]> {
  const object = await bucket.get(PROVIDER_ORDER_KEY);
  if (!object) return [];
  try {
    const value = (await object.json()) as {
      schemaVersion?: unknown;
      slugs?: unknown;
    };
    if (value.schemaVersion !== 1 || !Array.isArray(value.slugs)) return [];
    const seen = new Set<string>();
    const slugs: string[] = [];
    for (const slug of value.slugs) {
      if (typeof slug !== "string" || !validateSlug(slug) || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      slugs.push(slug);
    }
    return slugs;
  } catch {
    return [];
  }
}

export async function saveProviderOrder(
  bucket: R2Bucket,
  slugs: string[],
): Promise<void> {
  await bucket.put(
    PROVIDER_ORDER_KEY,
    JSON.stringify({
      schemaVersion: 1,
      slugs,
      updatedAt: new Date().toISOString(),
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function orderProviderSlugs(
  bucket: R2Bucket,
  slugs: string[],
): Promise<string[]> {
  const active = new Set(slugs);
  const ordered = (await getProviderOrder(bucket)).filter((slug) =>
    active.has(slug),
  );
  const included = new Set(ordered);
  return ordered.concat(slugs.filter((slug) => !included.has(slug)).sort());
}

// --- Source URL persistence ---

export async function saveSourceUrl(
  bucket: R2Bucket,
  slug: string,
  sourceUrl: string,
  userAgent?: string,
): Promise<void> {
  await bucket.put(
    `providers/${slug}/source-url.json`,
    JSON.stringify({ url: sourceUrl, userAgent }),
  );
}

export async function getSourceUrl(
  bucket: R2Bucket,
  slug: string,
): Promise<string | null> {
  const obj = await bucket.get(`providers/${slug}/source-url.json`);
  if (!obj) return null;
  try {
    const data = (await obj.json()) as { url?: string };
    return typeof data.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

export async function getSourceUserAgent(
  bucket: R2Bucket,
  slug: string,
): Promise<string | null> {
  const obj = await bucket.get(`providers/${slug}/source-url.json`);
  if (!obj) return null;
  try {
    const data = (await obj.json()) as { userAgent?: string };
    return typeof data.userAgent === "string" ? data.userAgent : null;
  } catch {
    return null;
  }
}

export async function getProviderSourceSettings(
  bucket: R2Bucket,
  slug: string,
): Promise<{ sourceUrl: string; userAgent: string }> {
  const obj = await bucket.get(`providers/${slug}/source-url.json`);
  if (!obj) return { sourceUrl: "", userAgent: "" };
  try {
    const data = (await obj.json()) as { url?: unknown; userAgent?: unknown };
    return {
      sourceUrl: typeof data.url === "string" ? data.url : "",
      userAgent: typeof data.userAgent === "string" ? data.userAgent : "",
    };
  } catch {
    return { sourceUrl: "", userAgent: "" };
  }
}

/**
 * Delete only the latest.json pointer for a provider.
 * Version history and staging data are preserved.
 */
export async function deleteProviderPointer(
  bucket: R2Bucket,
  slug: string,
): Promise<void> {
  if (!validateSlug(slug)) {
    throw new Error("Slug 格式无效");
  }
  await bucket.delete(latestPath(slug));
}

/**
 * Delete a single version (all artifacts: raw.yaml, provider.yaml, profile.yaml, meta.json).
 */
export async function deleteProviderVersion(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<{ deleted: number }> {
  if (!validateSlug(slug)) throw new Error("Slug 格式无效");
  if (!validateVersionId(versionId)) throw new Error("版本 ID 格式无效");
  const latest = await getLatest(bucket, slug);
  if (latest?.versionId === versionId) {
    throw new Error("当前使用的版本不能删除");
  }
  const keys = getVersionKeys(slug, versionId);
  let deleted = 0;
  for (const key of [
    keys.raw,
    keys.provider,
    keys.profile,
    keys.meta,
    legacyVersionYamlPath(slug, versionId),
    legacyVersionJsonPath(slug, versionId),
  ]) {
    const obj = await bucket.get(key);
    if (obj) {
      await bucket.delete(key);
      deleted++;
    }
  }
  return { deleted };
}

export async function pruneProviderVersions(
  bucket: R2Bucket,
  slug: string,
  maxVersions = 3,
): Promise<{ removedVersions: string[]; deletedObjects: number }> {
  if (!Number.isInteger(maxVersions) || maxVersions < 1) {
    throw new Error("保留版本数量无效");
  }
  const versions = await listVersions(bucket, slug);
  const current = versions.find((version) => version.isCurrent);
  const keep = new Set<string>();
  if (current) keep.add(current.versionId);
  for (const version of versions) {
    if (keep.size >= maxVersions) break;
    keep.add(version.versionId);
  }
  const removedVersions: string[] = [];
  let deletedObjects = 0;
  for (const version of versions) {
    if (keep.has(version.versionId)) continue;
    const result = await deleteProviderVersion(bucket, slug, version.versionId);
    removedVersions.push(version.versionId);
    deletedObjects += result.deleted;
  }
  return { removedVersions, deletedObjects };
}

/**
 * Delete a single staging entry (json + raw).
 */
export async function deleteStagingEntry(
  bucket: R2Bucket,
  slug: string,
  requestId: string,
): Promise<{ deleted: number }> {
  if (!validateSlug(slug)) throw new Error("Slug 格式无效");
  const jsonKey = stagingPath(slug, requestId);
  const rawKey = stagingRawPath(slug, requestId);
  let deleted = 0;
  for (const key of [jsonKey, rawKey]) {
    const obj = await bucket.get(key);
    if (obj) {
      await bucket.delete(key);
      deleted++;
    }
  }
  return { deleted };
}

/**
 * Bounded-concurrency map. R2 round trips dominate these code paths, so running
 * them in parallel is the difference between one and N sequential round trips.
 * The limit keeps a long history from opening hundreds of subrequests at once.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function listVersions(
  bucket: R2Bucket,
  slug: string,
): Promise<HistoryItem[]> {
  // Only the pointer id is needed here; reading the raw pointer avoids the
  // extra version-meta read that getLatest() performs for V1 pointers.
  const stored = await readStoredLatestPointer(bucket, slug);
  const latestVersionId = stored?.pointer.versionId;

  // Collect the unique metadata objects for every page first, then read them in
  // parallel. The previous sequential loop cost one R2 round trip per version.
  const candidates: Array<{
    key: string;
    versionId: string;
    isNewFormat: boolean;
  }> = [];
  const seenVersionIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix: `providers/${slug}/versions/`,
      cursor,
    });
    for (const obj of result.objects) {
      const parsed = parseVersionObjectKey(obj.key, slug);
      if (!parsed || seenVersionIds.has(parsed.versionId)) continue;
      seenVersionIds.add(parsed.versionId);
      candidates.push({
        key: obj.key,
        versionId: parsed.versionId,
        isNewFormat: parsed.isNewFormat,
      });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  const resolved = await mapWithConcurrency(
    candidates,
    8,
    async (candidate): Promise<HistoryItem | null> => {
      try {
        const fetched = await bucket.get(candidate.key);
        if (!fetched) return null;
        const rawText = await fetched.text();
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          return null;
        }
        return candidate.isNewFormat
          ? buildHistoryItemFromV1Meta(raw, latestVersionId)
          : buildHistoryItemFromLegacyMeta(raw, latestVersionId);
      } catch {
        // Skip corrupted/malformed version metadata
        return null;
      }
    },
  );

  return resolved
    .filter((item): item is HistoryItem => item !== null)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
}

/** Parse R2 key to determine new vs legacy format. Returns null for non-metadata keys. */
function parseVersionObjectKey(
  key: string,
  slug: string,
): { versionId: string; isNewFormat: boolean } | null {
  const prefix = `providers/${slug}/versions/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);

  // New format: {versionId}/meta.json
  const newMatch = rest.match(/^([^/]+)\/meta\.json$/);
  if (newMatch?.[1]) {
    return { versionId: newMatch[1], isNewFormat: true };
  }

  // Legacy format: {versionId}.json (flat, no slash)
  if (rest.endsWith(".json") && !rest.includes("/")) {
    const versionId = rest.slice(0, -5);
    if (versionId) {
      return { versionId, isNewFormat: false };
    }
  }

  return null;
}

function buildHistoryItemFromV1Meta(
  raw: Record<string, unknown>,
  latestVersionId: string | undefined,
): HistoryItem | null {
  if (!isProviderVersionMeta(raw)) return null;
  const meta = raw as unknown as ProviderVersionMeta;
  return {
    versionId: meta.versionId,
    createdAt: meta.createdAt,
    nodeCount: meta.nodeCount,
    sha256Prefix: meta.artifacts.provider.sha256.slice(0, 8),
    contentLength: meta.artifacts.provider.contentLength,
    sourceHost: meta.distribution.sourceHost,
    isCurrent: latestVersionId === meta.versionId,
  };
}

function buildHistoryItemFromLegacyMeta(
  raw: Record<string, unknown>,
  latestVersionId: string | undefined,
): HistoryItem | null {
  const meta = raw as Record<string, unknown>;
  if (
    typeof meta.versionId !== "string" ||
    typeof meta.createdAt !== "string" ||
    typeof meta.nodeCount !== "number" ||
    typeof meta.sha256 !== "string" ||
    typeof meta.contentLength !== "number" ||
    typeof meta.sourceHost !== "string"
  ) {
    return null;
  }
  return {
    versionId: meta.versionId as string,
    createdAt: meta.createdAt as string,
    nodeCount: meta.nodeCount as number,
    sha256Prefix: (meta.sha256 as string).slice(0, 8),
    contentLength: meta.contentLength as number,
    sourceHost: meta.sourceHost as string,
    isCurrent: latestVersionId === (meta.versionId as string),
  };
}

async function readLegacyProviderMeta(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<ProviderMeta | null> {
  const obj = await bucket.get(legacyVersionJsonPath(slug, versionId));
  if (!obj) return null;
  try {
    const raw = (await obj.json()) as Record<string, unknown>;
    return isValidLegacyMeta(raw) ? (raw as unknown as ProviderMeta) : null;
  } catch {
    return null;
  }
}

/**
 * One list entry per provider with the fewest R2 round trips possible.
 *
 * The naive path (getLatest + getProviderMeta + getProviderSourceSettings) reads
 * the same version meta up to four times per provider. Here the pointer, the
 * source settings and the version meta are each read exactly once, with the two
 * independent reads issued in parallel.
 */
async function readProviderListEntry(
  bucket: R2Bucket,
  slug: string,
): Promise<ProviderListEntry | null> {
  const [stored, settings] = await Promise.all([
    readStoredLatestPointer(bucket, slug),
    getProviderSourceSettings(bucket, slug),
  ]);
  if (!stored) return null;
  const pointer = stored.pointer;

  if (isLegacyLatestJson(pointer)) {
    const meta = await readLegacyProviderMeta(bucket, slug, pointer.versionId);
    return {
      slug,
      name: meta ? meta.providerName : slug,
      latestVersion: pointer,
      nodeCount: meta ? meta.nodeCount : 0,
      sourceHost: meta ? meta.sourceHost : "",
      sourceUrl: settings.sourceUrl,
      userAgent: settings.userAgent,
    };
  }

  // V1: a single resolve yields both the pointer projection and the list fields.
  const resolved = await resolveV1Version(
    bucket,
    slug,
    pointer.versionId,
    pointer,
  );
  const meta = projectV1MetaToLegacy(resolved.meta);
  return {
    slug,
    name: meta.providerName,
    latestVersion: {
      versionId: pointer.versionId,
      sha256: meta.sha256,
      updatedAt: pointer.publishedAt,
    },
    nodeCount: meta.nodeCount,
    sourceHost: meta.sourceHost,
    sourceUrl: settings.sourceUrl,
    userAgent: settings.userAgent,
  };
}

export async function getAllProviderMeta(
  bucket: R2Bucket,
): Promise<ProviderListEntry[]> {
  // The order document does not depend on the slug list, so both start together
  // instead of the order read waiting for every provider to finish.
  const [slugs, order] = await Promise.all([
    listSlugs(bucket),
    getProviderOrder(bucket),
  ]);
  const results = await Promise.all(
    slugs.map((slug) => readProviderListEntry(bucket, slug)),
  );
  // A provider directory may remain because history/staging is intentionally
  // retained after removal. Only a current pointer makes it an active list item.
  const items = results.filter(
    (item): item is ProviderListEntry => item !== null,
  );
  const active = new Set(items.map((item) => item.slug));
  const ordered = order.filter((slug) => active.has(slug));
  const included = new Set(ordered);
  const orderedSlugs = ordered.concat(
    items
      .map((item) => item.slug)
      .filter((slug) => !included.has(slug))
      .sort(),
  );
  const bySlug = new Map(items.map((item) => [item.slug, item]));
  return orderedSlugs.map((slug) => bySlug.get(slug)!).filter(Boolean);
}

export async function providerExists(
  bucket: R2Bucket,
  slug: string,
): Promise<boolean> {
  const latest = await getLatest(bucket, slug);
  return latest !== null;
}

export async function listAllProviderSlugs(
  bucket: R2Bucket,
): Promise<string[]> {
  return listSlugs(bucket);
}

// --- Staging ---

export async function writeStaging(
  bucket: R2Bucket,
  slug: string,
  requestId: string,
  rawContent: string,
  meta: { sourceUrl: string; fetchedAt: string; contentLength: number },
): Promise<void> {
  const staging = {
    slug,
    requestId,
    status: "fetched" as const,
    ...meta,
  };

  await bucket.put(stagingRawPath(slug, requestId), rawContent, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  await bucket.put(
    stagingPath(slug, requestId),
    JSON.stringify(staging, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
}

export async function markStagingCompleted(
  bucket: R2Bucket,
  slug: string,
  requestId: string,
): Promise<void> {
  const obj = await bucket.get(stagingPath(slug, requestId));
  if (!obj) return;
  const staging = (await obj.json()) as Record<string, unknown>;
  staging.status = "completed";
  await bucket.put(
    stagingPath(slug, requestId),
    JSON.stringify(staging, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
}

export async function markStagingFailed(
  bucket: R2Bucket,
  slug: string,
  requestId: string,
  error: string,
): Promise<void> {
  const obj = await bucket.get(stagingPath(slug, requestId));
  if (!obj) return;
  const staging = (await obj.json()) as Record<string, unknown>;
  staging.status = "failed";
  staging.error = error;
  await bucket.put(
    stagingPath(slug, requestId),
    JSON.stringify(staging, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
}

export async function getStagingRaw(
  bucket: R2Bucket,
  slug: string,
  requestId: string,
): Promise<string | null> {
  const obj = await bucket.get(stagingRawPath(slug, requestId));
  if (!obj) return null;
  return obj.text();
}

export async function listStaging(
  bucket: R2Bucket,
  slug: string,
): Promise<
  { requestId: string; status: string; fetchedAt: string; error?: string }[]
> {
  const items: {
    requestId: string;
    status: string;
    fetchedAt: string;
    error?: string;
  }[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix: `providers/${slug}/staging/`,
      cursor,
    });
    for (const obj of result.objects) {
      if (obj.key.endsWith(".json")) {
        const fetched = await bucket.get(obj.key);
        if (fetched) {
          const staging = (await fetched.json()) as Record<string, unknown>;
          items.push({
            requestId: staging.requestId as string,
            status: staging.status as string,
            fetchedAt: staging.fetchedAt as string,
            error: staging.error as string | undefined,
          });
        }
      }
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return items.sort(
    (a, b) => new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime(),
  );
}

// --- Export helpers ---

export async function getVersionYamlForExport(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<Uint8Array | null> {
  // New path: resolve meta and verify provider.yaml integrity
  const newKeys = getVersionKeys(slug, versionId);
  const metaObj = await bucket.get(newKeys.meta);
  if (metaObj) {
    const resolved = await resolveV1Version(bucket, slug, versionId);
    await verifyObject(
      bucket,
      resolved.meta.artifacts.provider.key,
      resolved.meta.artifacts.provider.sha256,
      resolved.meta.artifacts.provider.contentLength,
    );
    const providerObj = await bucket.get(newKeys.provider);
    if (!providerObj) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `provider.yaml missing after verification: ${newKeys.provider}`,
      );
    }
    return new Uint8Array(await providerObj.arrayBuffer());
  }

  // Legacy fallback
  const legacyObj = await bucket.get(legacyVersionYamlPath(slug, versionId));
  if (!legacyObj) return null;
  return new Uint8Array(await legacyObj.arrayBuffer());
}

export async function getVersionProfileForDownload(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<Uint8Array | null> {
  const keys = getVersionKeys(slug, versionId);
  const metaObj = await bucket.get(keys.meta);
  if (!metaObj) return null;
  const resolved = await resolveV1Version(bucket, slug, versionId);
  await verifyObject(
    bucket,
    resolved.meta.artifacts.profile.key,
    resolved.meta.artifacts.profile.sha256,
    resolved.meta.artifacts.profile.contentLength,
  );
  const profileObj = await bucket.get(keys.profile);
  if (!profileObj) {
    throw createError(
      "STORED_VERSION_CORRUPTED",
      `profile.yaml missing after verification: ${keys.profile}`,
    );
  }
  return new Uint8Array(await profileObj.arrayBuffer());
}

export async function getVersionJsonForExport(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<Uint8Array | null> {
  // New path: resolve and verify provider.yaml integrity before projecting
  const newKeys = getVersionKeys(slug, versionId);
  const newObj = await bucket.get(newKeys.meta);
  if (newObj) {
    const resolved = await resolveV1Version(bucket, slug, versionId);
    await verifyObject(
      bucket,
      resolved.meta.artifacts.provider.key,
      resolved.meta.artifacts.provider.sha256,
      resolved.meta.artifacts.provider.contentLength,
    );
    const projected = projectV1MetaToLegacy(resolved.meta);
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(projected, null, 2));
  }

  // Legacy fallback
  const legacyObj = await bucket.get(legacyVersionJsonPath(slug, versionId));
  if (!legacyObj) return null;
  return new Uint8Array(await legacyObj.arrayBuffer());
}

export async function getLatestJsonForExport(
  bucket: R2Bucket,
  slug: string,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(latestPath(slug));
  if (!obj) return null;

  const rawText = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new VersionPublishError(
      "INVALID_STORED_POINTER",
      "latest.json contains invalid JSON",
    );
  }

  const pointer = parseStoredPointer(raw);
  if (isLegacyLatestJson(pointer)) {
    const encoder = new TextEncoder();
    return encoder.encode(JSON.stringify(pointer, null, 2));
  }

  // V1 pointer — resolve using caller's slug as trust boundary
  const resolved = await resolveV1Version(
    bucket,
    slug,
    pointer.versionId,
    pointer,
  );

  // Verify provider.yaml exists and matches meta
  await verifyObject(
    bucket,
    resolved.meta.artifacts.provider.key,
    resolved.meta.artifacts.provider.sha256,
    resolved.meta.artifacts.provider.contentLength,
  );

  const legacyView: LatestJson = {
    versionId: pointer.versionId,
    sha256: resolved.meta.artifacts.provider.sha256,
    updatedAt: pointer.publishedAt,
  };
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(legacyView, null, 2));
}

export { generateVersionId };

// --- Immutable object writer ---

async function writeImmutableObject(
  bucket: R2Bucket,
  key: string,
  content: string,
  contentType: string,
): Promise<void> {
  const result = await bucket.put(key, content, {
    httpMetadata: { contentType },
    onlyIf: { etagDoesNotMatch: "*" },
  });

  if (result) return; // Successfully written

  // Object exists — verify content matches (idempotent retry)
  const existing = await bucket.get(key);
  if (!existing) {
    throw createError(
      "VERSION_OBJECT_CONFLICT",
      `Write failed and existing object not found: ${key}`,
    );
  }

  const existingContent = await existing.text();
  if (existingContent !== content) {
    throw createError(
      "VERSION_OBJECT_CONFLICT",
      `Immutable object already exists with different content: ${key}`,
    );
  }
  // Content matches — idempotent retry is OK
}

// --- Validate distribution metadata ---

function validateDistribution(
  distribution: ProviderDistributionMetadata,
): void {
  if (!distribution.providerName) {
    throw createError("INVALID_INPUT", "distribution.providerName required");
  }
  if (typeof distribution.sourceHost !== "string") {
    throw createError(
      "INVALID_INPUT",
      "distribution.sourceHost must be string",
    );
  }
  if (
    distribution.subscriptionUserinfo !== undefined &&
    typeof distribution.subscriptionUserinfo !== "string"
  ) {
    throw createError(
      "INVALID_INPUT",
      "distribution.subscriptionUserinfo must be string",
    );
  }
  if (
    distribution.profileUpdateInterval !== undefined &&
    typeof distribution.profileUpdateInterval !== "string"
  ) {
    throw createError(
      "INVALID_INPUT",
      "distribution.profileUpdateInterval must be string",
    );
  }
  if (
    distribution.profileWebPageUrl !== undefined &&
    typeof distribution.profileWebPageUrl !== "string"
  ) {
    throw createError(
      "INVALID_INPUT",
      "distribution.profileWebPageUrl must be string",
    );
  }
  if (
    distribution.clientUpdatePolicy !== undefined &&
    !isClientUpdatePolicy(distribution.clientUpdatePolicy)
  ) {
    throw createError(
      "INVALID_INPUT",
      "distribution.clientUpdatePolicy is invalid",
    );
  }
}

const MAX_CLIENT_UPDATE_INTERVAL_MINUTES = 153_722_867_280;

function isClientUpdatePolicy(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.allowAutoUpdate === "boolean" &&
    Number.isSafeInteger(policy.updateIntervalMinutes) &&
    (policy.updateIntervalMinutes as number) > 0 &&
    (policy.updateIntervalMinutes as number) <=
      MAX_CLIENT_UPDATE_INTERVAL_MINUTES &&
    Object.keys(policy).every(
      (key) => key === "allowAutoUpdate" || key === "updateIntervalMinutes",
    )
  );
}

// --- Distribution comparison ---

function isSameDistribution(
  a: ProviderDistributionMetadata,
  b: ProviderDistributionMetadata,
): boolean {
  return (
    a.providerName === b.providerName &&
    a.sourceHost === b.sourceHost &&
    a.subscriptionUserinfo === b.subscriptionUserinfo &&
    a.profileUpdateInterval === b.profileUpdateInterval &&
    a.profileWebPageUrl === b.profileWebPageUrl &&
    a.clientUpdatePolicy?.allowAutoUpdate ===
      b.clientUpdatePolicy?.allowAutoUpdate &&
    a.clientUpdatePolicy?.updateIntervalMinutes ===
      b.clientUpdatePolicy?.updateIntervalMinutes
  );
}

function isSameNodeStats(
  a: NodeStats | undefined,
  b: NodeStats | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.inline === b.inline &&
    a.dependencyRaw === b.dependencyRaw &&
    a.excluded === b.excluded &&
    a.effective === b.effective
  );
}

function isSameDependencies(
  a: InternalDependencyInfo[] | undefined,
  b: InternalDependencyInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (
      ai.slug !== bi.slug ||
      ai.subscriptionId !== bi.subscriptionId ||
      ai.uid !== bi.uid ||
      ai.versionId !== bi.versionId ||
      ai.nodeCount !== bi.nodeCount ||
      ai.excludedCount !== bi.excludedCount ||
      ai.effectiveCount !== bi.effectiveCount ||
      ai.providerSha256 !== bi.providerSha256 ||
      ai.profileSha256 !== bi.profileSha256
    ) {
      return false;
    }
  }
  return true;
}

// --- publishProviderVersion ---

export async function publishProviderVersion(
  bucket: R2Bucket,
  input: PublishVersionInput,
  deps?: PublishDependencies,
): Promise<PublishedVersion> {
  const now = deps?.now ?? (() => new Date());
  const genVersionId =
    deps?.generateVersionId ??
    ((sha: string) => generateVersionIdWithHash(sha, now));

  // 1. Validate input
  if (!validateSlug(input.providerSlug)) {
    throw createError(
      "INVALID_INPUT",
      "Slug must be lowercase alphanumeric/hyphen, 1-63 chars, start/end with alphanumeric",
    );
  }
  if (!input.subscriptionId) {
    throw createError("INVALID_INPUT", "subscriptionId required");
  }
  if (!input.uid) {
    throw createError("INVALID_INPUT", "uid required");
  }
  if (!input.rawContent) {
    throw createError("INVALID_INPUT", "rawContent required");
  }
  if (!input.providerYaml) {
    throw createError("INVALID_INPUT", "providerYaml required");
  }
  if (!input.profileYaml) {
    throw createError("INVALID_INPUT", "profileYaml required");
  }
  if (!input.generatorVersion) {
    throw createError("INVALID_INPUT", "generatorVersion required");
  }
  if (!Number.isInteger(input.nodeCount) || input.nodeCount < 0) {
    throw createError(
      "INVALID_INPUT",
      "nodeCount must be non-negative integer",
    );
  }
  validateDistribution(input.distribution);

  // 2. Snapshot starting latest.json for CAS baseline
  const latestKey = latestPath(input.providerSlug);
  const startingLatestObj = await bucket.get(latestKey);
  const startingLatestEtag: string | null = startingLatestObj?.etag ?? null;
  let startingPointer: StoredLatestPointer | null = null;

  if (startingLatestObj) {
    const rawText = await startingLatestObj.text();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw createError(
        "INVALID_STORED_POINTER",
        "latest.json contains invalid JSON",
      );
    }
    startingPointer = parseStoredPointer(raw);
  }

  // 3. expectedLatestEtag enforcement
  if (input.expectedLatestEtag !== undefined) {
    if (
      (input.expectedLatestEtag === null && startingLatestEtag !== null) ||
      (input.expectedLatestEtag !== null &&
        input.expectedLatestEtag !== startingLatestEtag)
    ) {
      throw createError(
        "VERSION_CONFLICT",
        "expectedLatestEtag does not match current latest.json",
      );
    }
  }

  // 4. Compute input SHA-256s
  const sourceSha256 = await sha256Hex(input.rawContent);
  const inputProviderSha256 = await sha256Hex(input.providerYaml);
  const inputProfileSha256 = await sha256Hex(input.profileYaml);

  // 5. V1: identity check, integrity verification, idempotent reuse
  if (startingPointer && isLatestVersionPointerV1(startingPointer)) {
    // Identity check — slug must own this subscription
    if (
      startingPointer.subscriptionId !== input.subscriptionId ||
      startingPointer.uid !== input.uid
    ) {
      throw createError(
        "PROVIDER_IDENTITY_CONFLICT",
        "Slug is already bound to a different subscriptionId or uid",
      );
    }

    // Resolve and verify current version using its OWN hashes
    const resolved = await resolveV1Version(
      bucket,
      input.providerSlug,
      startingPointer.versionId,
      startingPointer,
    );

    // Verify all artifacts match their own meta hashes (not input hashes)
    await verifyAllArtifacts(bucket, resolved.meta);

    // Current version is intact — check if input matches exactly
    const canReuse =
      resolved.meta.subscriptionId === input.subscriptionId &&
      resolved.meta.uid === input.uid &&
      resolved.meta.versionId === startingPointer.versionId &&
      resolved.meta.sourceSha256 === sourceSha256 &&
      resolved.meta.generatorVersion === input.generatorVersion &&
      resolved.meta.providerSlug === input.providerSlug &&
      resolved.meta.nodeCount === input.nodeCount &&
      resolved.meta.artifacts.raw.sha256 === sourceSha256 &&
      resolved.meta.artifacts.provider.sha256 === inputProviderSha256 &&
      resolved.meta.artifacts.profile.sha256 === inputProfileSha256 &&
      isSameDistribution(resolved.meta.distribution, input.distribution) &&
      isSameNodeStats(resolved.meta.nodeStats, input.nodeStats) &&
      isSameDependencies(
        resolved.meta.internalDependencies,
        input.internalDependencies,
      );

    if (canReuse) {
      await tryPruneProviderVersions(bucket, input.providerSlug);
      return {
        versionId: resolved.meta.versionId,
        latest: startingPointer,
        meta: resolved.meta,
      };
    }

    // Not identical — proceed to create new version (no corruption)
  }

  // 6. Generate versionId
  const versionId = await genVersionId(sourceSha256);
  const keys = getVersionKeys(input.providerSlug, versionId);

  // 7. Write immutable version artifacts
  await writeImmutableObject(
    bucket,
    keys.raw,
    input.rawContent,
    "text/yaml; charset=utf-8",
  );

  await writeImmutableObject(
    bucket,
    keys.provider,
    input.providerYaml,
    "text/yaml; charset=utf-8",
  );

  await writeImmutableObject(
    bucket,
    keys.profile,
    input.profileYaml,
    "text/yaml; charset=utf-8",
  );

  // 8. Construct and write meta.json
  const createdAt = now().toISOString();
  const rawSize = contentLengthBytes(input.rawContent);
  const providerSize = contentLengthBytes(input.providerYaml);
  const profileSize = contentLengthBytes(input.profileYaml);

  const meta: ProviderVersionMeta = {
    schemaVersion: input.nodeStats ? 2 : 1,
    providerSlug: input.providerSlug,
    subscriptionId: input.subscriptionId,
    uid: input.uid,
    versionId,
    createdAt,
    sourceSha256,
    nodeCount: input.nodeCount,
    generatorVersion: input.generatorVersion,
    distribution: { ...input.distribution },
    artifacts: {
      raw: { key: keys.raw, sha256: sourceSha256, contentLength: rawSize },
      provider: {
        key: keys.provider,
        sha256: inputProviderSha256,
        contentLength: providerSize,
      },
      profile: {
        key: keys.profile,
        sha256: inputProfileSha256,
        contentLength: profileSize,
      },
    },
    ...(input.nodeStats && { nodeStats: input.nodeStats }),
    ...(input.internalDependencies && {
      internalDependencies: input.internalDependencies,
    }),
  };

  const metaJson = JSON.stringify(sortKeysDeep(meta), null, 2);
  const metaSha256 = await sha256Hex(metaJson);
  const metaSize = contentLengthBytes(metaJson);

  await writeImmutableObject(bucket, keys.meta, metaJson, "application/json");

  // 9. Verify all version objects
  await verifyObject(bucket, keys.raw, sourceSha256, rawSize);
  await verifyObject(bucket, keys.provider, inputProviderSha256, providerSize);
  await verifyObject(bucket, keys.profile, inputProfileSha256, profileSize);
  await verifyObject(bucket, keys.meta, metaSha256, metaSize);

  // 10. CAS update latest.json using operation-start baseline
  const latestPointer: LatestVersionPointer = {
    schemaVersion: 1,
    providerSlug: input.providerSlug,
    subscriptionId: input.subscriptionId,
    uid: input.uid,
    versionId,
    publishedAt: createdAt,
    metaKey: keys.meta,
    metaSha256,
  };

  const latestJson = JSON.stringify(latestPointer, null, 2);
  const latestResult = await bucket.put(latestKey, latestJson, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: startingLatestObj
      ? { etagMatches: startingLatestEtag! }
      : { etagDoesNotMatch: "*" },
  });

  if (!latestResult) {
    throw createError(
      "VERSION_CONFLICT",
      "latest.json was modified by another request during publish",
    );
  }

  await tryPruneProviderVersions(bucket, input.providerSlug);

  return { versionId, latest: latestPointer, meta };
}

async function tryPruneProviderVersions(
  bucket: R2Bucket,
  slug: string,
): Promise<void> {
  if (typeof (bucket as unknown as { list?: unknown }).list !== "function") {
    return;
  }
  try {
    await pruneProviderVersions(bucket, slug, 3);
  } catch (error) {
    console.error("provider-history:prune-failed", { slug, error });
  }
}

// --- Format-aware rollback ---

export async function rollbackLatest(
  bucket: R2Bucket,
  slug: string,
  targetVersionId: string,
  expectedLatestEtag?: string,
  deps?: PublishDependencies,
): Promise<StoredLatestPointer> {
  // 0. Validate inputs before any R2 reads
  if (!validateSlug(slug)) {
    throw createError("INVALID_INPUT", `Invalid slug: ${slug}`);
  }
  if (!validateVersionId(targetVersionId)) {
    throw createError(
      "INVALID_INPUT",
      `Invalid targetVersionId: ${targetVersionId}`,
    );
  }

  const now = deps?.now ?? (() => new Date());
  const latestKey = latestPath(slug);

  // 1. Snapshot current latest.json for CAS baseline
  const currentLatestObj = await bucket.get(latestKey);
  const currentEtag: string | null = currentLatestObj?.etag ?? null;

  if (expectedLatestEtag !== undefined && expectedLatestEtag !== currentEtag) {
    throw new Error("回滚失败：expectedLatestEtag 不匹配当前 latest.json");
  }

  // Parse current pointer for identity check — corrupted pointer is a hard error
  let currentPointer: StoredLatestPointer | null = null;
  if (currentLatestObj) {
    const rawText = await currentLatestObj.text();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new VersionPublishError(
        "INVALID_STORED_POINTER",
        "latest.json contains invalid JSON",
      );
    }
    currentPointer = parseStoredPointer(raw);
  }

  // 2. Try new-format version first
  const newKeys = getVersionKeys(slug, targetVersionId);
  const metaObj = await bucket.get(newKeys.meta);

  if (metaObj) {
    // Resolve via unified resolver
    const resolved = await resolveV1Version(bucket, slug, targetVersionId);

    // Verify meta.versionId matches target
    if (resolved.meta.versionId !== targetVersionId) {
      throw createError(
        "STORED_VERSION_CORRUPTED",
        `meta.versionId mismatch: expected ${targetVersionId}, got ${resolved.meta.versionId}`,
      );
    }

    // Identity protection: if current is V1, target must share identity
    if (currentPointer && isLatestVersionPointerV1(currentPointer)) {
      if (
        resolved.meta.subscriptionId !== currentPointer.subscriptionId ||
        resolved.meta.uid !== currentPointer.uid
      ) {
        throw createError(
          "PROVIDER_IDENTITY_CONFLICT",
          "Cannot rollback to a version with different subscriptionId or uid",
        );
      }
    }

    // Verify all artifacts
    await verifyAllArtifacts(bucket, resolved.meta);

    // Write V1 pointer with current rollback time
    const publishedAt = now().toISOString();
    const pointer: LatestVersionPointer = {
      schemaVersion: 1,
      providerSlug: slug,
      subscriptionId: resolved.meta.subscriptionId,
      uid: resolved.meta.uid,
      versionId: targetVersionId,
      publishedAt,
      metaKey: newKeys.meta,
      metaSha256: resolved.metaSha256,
    };

    const result = await bucket.put(
      latestKey,
      JSON.stringify(pointer, null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: currentLatestObj
          ? { etagMatches: currentEtag! }
          : { etagDoesNotMatch: "*" },
      },
    );

    if (!result) {
      throw new Error("回滚失败：订阅已被另一操作修改，请重试");
    }

    return pointer;
  }

  // 3. Legacy flat-file version — verify fully
  const legacyYaml = await bucket.get(
    legacyVersionYamlPath(slug, targetVersionId),
  );
  const legacyJson = await bucket.get(
    legacyVersionJsonPath(slug, targetVersionId),
  );

  if (!legacyYaml || !legacyJson) {
    throw new Error("回滚失败：目标版本文件不存在");
  }

  const legacyMetaRaw = (await legacyJson.json()) as Record<string, unknown>;
  if (!isValidLegacyMeta(legacyMetaRaw)) {
    throw new Error("回滚失败：旧版 ProviderMeta 缺少必需字段");
  }
  const legacyMeta = legacyMetaRaw as unknown as ProviderMeta;

  if (legacyMeta.versionId !== targetVersionId) {
    throw new Error(
      `回滚失败：旧版 meta.versionId 不匹配：期望 ${targetVersionId}，实际 ${legacyMeta.versionId}`,
    );
  }
  if (legacyMeta.providerSlug !== slug) {
    throw new Error(
      `回滚失败：旧版 meta.providerSlug 不匹配：期望 ${slug}，实际 ${legacyMeta.providerSlug}`,
    );
  }

  // Verify YAML integrity
  const yamlContent = await legacyYaml.text();
  const yamlSha256 = await sha256Hex(yamlContent);
  const yamlSize = contentLengthBytes(yamlContent);

  if (yamlSha256 !== legacyMeta.sha256) {
    throw new Error(
      "回滚失败：旧版 YAML SHA-256 与 meta.sha256 不一致，数据可能已损坏",
    );
  }
  if (yamlSize !== legacyMeta.contentLength) {
    throw new Error("回滚失败：旧版 YAML 字节数与 meta.contentLength 不一致");
  }

  const legacyLatest: LatestJson = {
    versionId: targetVersionId,
    sha256: legacyMeta.sha256,
    updatedAt: legacyMeta.createdAt,
  };

  const result = await bucket.put(
    latestKey,
    JSON.stringify(legacyLatest, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: currentLatestObj
        ? { etagMatches: currentEtag! }
        : { etagDoesNotMatch: "*" },
    },
  );

  if (!result) {
    throw new Error("回滚失败：订阅已被另一操作修改，请重试");
  }

  return legacyLatest;
}

function generateVersionIdWithHash(
  sourceSha256: string,
  now: () => Date,
): string {
  const ts = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const hashPrefix = sourceSha256.slice(0, 8);
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const randHex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${ts}-${hashPrefix}-${randHex}`;
}

// --- Public download route error type (Phase 4) ---

export class PublicProviderError extends Error {
  constructor(
    public readonly code: PublicProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicProviderError";
  }
}

function publicErr(
  code: PublicProviderErrorCode,
  message: string,
): PublicProviderError {
  return new PublicProviderError(code, message);
}

// --- SHA-256 for ArrayBuffer ---

async function sha256HexBytes(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Strict Profile resolver (Phase 4) ---

/**
 * Shared core: resolve pointer + meta for the current V1 profile artifact.
 * Returns the V1 pointer, validated meta, and the standard profile key.
 * Throws PublicProviderError on any failure.
 */
async function resolveProfileCore(
  bucket: R2Bucket,
  slug: string,
): Promise<{
  pointer: LatestVersionPointer;
  meta: ProviderVersionMeta;
  profileKey: string;
}> {
  // Read latest.json
  const latestObj = await bucket.get(latestPath(slug));
  if (!latestObj) {
    throw publicErr("CONFIG_NOT_FOUND", "latest.json 不存在");
  }

  const rawText = await latestObj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw publicErr("CONFIG_CORRUPTED", "latest.json 包含无效 JSON");
  }

  let pointer: StoredLatestPointer;
  try {
    pointer = parseStoredPointer(raw);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Legacy pointer — no profile.yaml available
  if (isLegacyLatestJson(pointer)) {
    throw publicErr("CONFIG_NOT_AVAILABLE", "当前版本不支持完整配置");
  }

  // V1 pointer — resolve via unified resolver
  let resolved: ResolvedV1Version;
  try {
    resolved = await resolveV1Version(bucket, slug, pointer.versionId, pointer);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Verify profile key matches standard path
  const keys = getVersionKeys(slug, pointer.versionId);
  if (resolved.meta.artifacts.profile.key !== keys.profile) {
    throw publicErr(
      "CONFIG_CORRUPTED",
      `profile key 不一致: 期望 ${keys.profile}, 实际 ${resolved.meta.artifacts.profile.key}`,
    );
  }

  return {
    pointer,
    meta: resolved.meta,
    profileKey: keys.profile,
  };
}

/**
 * Read and verify the current V1 profile.yaml bytes.
 * Full integrity: exists, byte count, SHA-256.
 * Used by GET /config/:slug/:token.
 */
export async function resolveAndVerifyProfileBytes(
  bucket: R2Bucket,
  slug: string,
): Promise<ResolvedProfileBytes> {
  const { pointer, meta, profileKey } = await resolveProfileCore(bucket, slug);

  const obj = await bucket.get(profileKey);
  if (!obj) {
    throw publicErr("CONFIG_CORRUPTED", `profile.yaml 缺失: ${profileKey}`);
  }

  const bytes = await obj.arrayBuffer();
  const actualLength = bytes.byteLength;
  const expectedLength = meta.artifacts.profile.contentLength;

  if (actualLength !== expectedLength) {
    throw publicErr(
      "CONFIG_CORRUPTED",
      `profile.yaml 字节数不一致: 期望 ${expectedLength}, 实际 ${actualLength}`,
    );
  }

  const actualSha256 = await sha256HexBytes(bytes);
  const expectedSha256 = meta.artifacts.profile.sha256;

  if (actualSha256 !== expectedSha256) {
    throw publicErr("CONFIG_CORRUPTED", "profile.yaml SHA-256 不一致");
  }

  return {
    bytes,
    meta,
    pointer,
    sha256: actualSha256,
    contentLength: actualLength,
  };
}

/**
 * Metadata-only verification for the current V1 profile.yaml.
 * Uses R2 head() — checks existence and size, does not read content.
 * Used by HEAD /config/:slug/:token.
 */
export async function resolveProfileMetadata(
  bucket: R2Bucket,
  slug: string,
): Promise<ResolvedProfileMetadata> {
  const { pointer, meta, profileKey } = await resolveProfileCore(bucket, slug);

  const headResult = await bucket.head(profileKey);
  if (!headResult) {
    throw publicErr("CONFIG_CORRUPTED", `profile.yaml 缺失: ${profileKey}`);
  }

  const actualSize = headResult.size;
  const expectedSize = meta.artifacts.profile.contentLength;

  if (actualSize !== expectedSize) {
    throw publicErr(
      "CONFIG_CORRUPTED",
      `profile.yaml 字节数不一致: 期望 ${expectedSize}, 实际 ${actualSize}`,
    );
  }

  return {
    exists: true,
    size: actualSize,
    meta,
    pointer,
    sha256: meta.artifacts.profile.sha256,
    contentLength: expectedSize,
  };
}

/**
 * Compute the Clash Verge profile UID from a subscriptionId.
 * Formula: "R" + sha256(subscriptionId)[0..8]
 */
export async function computeProfileUid(
  subscriptionId: string,
): Promise<string> {
  const hash = await sha256Hex(subscriptionId);
  return "R" + hash.slice(0, 8);
}

/**
 * Resolve and fully verify the current V1 Provider bundle for unified export.
 * Returns pointer, meta, and raw bytes for meta.json, provider.yaml, profile.yaml.
 * Throws PublicProviderError on any failure.
 */
export async function resolveAndVerifyCurrentProviderBundle(
  bucket: R2Bucket,
  slug: string,
): Promise<ProviderBundle> {
  // Read latest.json
  const latestObj = await bucket.get(latestPath(slug));
  if (!latestObj) {
    throw publicErr("CONFIG_NOT_FOUND", "latest.json 不存在");
  }

  const rawText = await latestObj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw publicErr("CONFIG_CORRUPTED", "latest.json 包含无效 JSON");
  }

  let pointer: StoredLatestPointer;
  try {
    pointer = parseStoredPointer(raw);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Reject legacy pointers
  if (isLegacyLatestJson(pointer)) {
    throw publicErr("CONFIG_NOT_AVAILABLE", "当前版本不支持完整配置");
  }

  // V1 pointer — resolve via unified resolver
  let resolved: ResolvedV1Version;
  try {
    resolved = await resolveV1Version(bucket, slug, pointer.versionId, pointer);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Verify all 3 artifacts (raw + provider + profile)
  try {
    await verifyAllArtifacts(bucket, resolved.meta);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Read all artifact bytes
  const keys = getVersionKeys(slug, pointer.versionId);

  const metaObj = await bucket.get(keys.meta);
  if (!metaObj) {
    throw publicErr("CONFIG_CORRUPTED", "meta.json 缺失");
  }
  const metaBytes = new Uint8Array(await metaObj.arrayBuffer());

  const providerObj = await bucket.get(keys.provider);
  if (!providerObj) {
    throw publicErr("CONFIG_CORRUPTED", "provider.yaml 缺失");
  }
  const providerBytes = new Uint8Array(await providerObj.arrayBuffer());

  const profileObj = await bucket.get(keys.profile);
  if (!profileObj) {
    throw publicErr("CONFIG_CORRUPTED", "profile.yaml 缺失");
  }
  const profileBytes = new Uint8Array(await profileObj.arrayBuffer());

  return {
    pointer,
    meta: resolved.meta,
    metaBytes,
    providerBytes,
    profileBytes,
  };
}

/**
 * Resolve and verify a specific V1 Provider version (not necessarily current).
 * Used by unified export to pin a specific version across metadata + artifact reads.
 * Throws PublicProviderError on any failure.
 */
export async function resolveProviderBundleAtVersion(
  bucket: R2Bucket,
  slug: string,
  pointer: LatestVersionPointer,
): Promise<ProviderBundle> {
  // Resolve and verify the specific version
  let resolved: ResolvedV1Version;
  try {
    resolved = await resolveV1Version(bucket, slug, pointer.versionId, pointer);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Verify all 3 artifacts
  try {
    await verifyAllArtifacts(bucket, resolved.meta);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Read artifact bytes
  const keys = getVersionKeys(slug, pointer.versionId);

  const metaObj = await bucket.get(keys.meta);
  if (!metaObj) throw publicErr("CONFIG_CORRUPTED", "meta.json 缺失");
  const metaBytes = new Uint8Array(await metaObj.arrayBuffer());

  const providerObj = await bucket.get(keys.provider);
  if (!providerObj) throw publicErr("CONFIG_CORRUPTED", "provider.yaml 缺失");
  const providerBytes = new Uint8Array(await providerObj.arrayBuffer());

  const profileObj = await bucket.get(keys.profile);
  if (!profileObj) throw publicErr("CONFIG_CORRUPTED", "profile.yaml 缺失");
  const profileBytes = new Uint8Array(await profileObj.arrayBuffer());

  return {
    pointer,
    meta: resolved.meta,
    metaBytes,
    providerBytes,
    profileBytes,
  };
}

/**
 * Resolve a Provider bundle by slug + versionId without requiring a full pointer.
 * Used for dependency export where we only have versionId from parent meta.
 * Validates: version exists, slug/versionId match, artifacts intact.
 */
export async function resolveProviderBundleByVersion(
  bucket: R2Bucket,
  slug: string,
  versionId: string,
): Promise<ProviderBundle> {
  // Resolve version without pointer (skips pointer SHA-256 check)
  let resolved: ResolvedV1Version;
  try {
    resolved = await resolveV1Version(bucket, slug, versionId, undefined);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Verify all 3 artifacts
  try {
    await verifyAllArtifacts(bucket, resolved.meta);
  } catch (e) {
    if (e instanceof VersionPublishError) {
      throw publicErr("CONFIG_CORRUPTED", e.message);
    }
    throw e;
  }

  // Read artifact bytes
  const keys = getVersionKeys(slug, versionId);

  const metaObj = await bucket.get(keys.meta);
  if (!metaObj) throw publicErr("CONFIG_CORRUPTED", "meta.json 缺失");
  const metaBytes = new Uint8Array(await metaObj.arrayBuffer());

  const providerObj = await bucket.get(keys.provider);
  if (!providerObj) throw publicErr("CONFIG_CORRUPTED", "provider.yaml 缺失");
  const providerBytes = new Uint8Array(await providerObj.arrayBuffer());

  const profileObj = await bucket.get(keys.profile);
  if (!profileObj) throw publicErr("CONFIG_CORRUPTED", "profile.yaml 缺失");
  const profileBytes = new Uint8Array(await profileObj.arrayBuffer());

  // Build a synthetic pointer for the return value
  const pointer: LatestVersionPointer = {
    schemaVersion: 1,
    providerSlug: slug,
    subscriptionId: resolved.meta.subscriptionId,
    uid: resolved.meta.uid,
    versionId: resolved.meta.versionId,
    publishedAt: resolved.meta.createdAt,
    metaKey: keys.meta,
    metaSha256: resolved.metaSha256,
  };

  return {
    pointer,
    meta: resolved.meta,
    metaBytes,
    providerBytes,
    profileBytes,
  };
}

/**
 * Resolve metadata only for the current V1 Provider (no artifact bytes loaded).
 * Returns pointer + meta + artifact sizes for size pre-estimation.
 * Throws PublicProviderError on any failure.
 */
export async function resolveProviderBundleMetadata(
  bucket: R2Bucket,
  slug: string,
): Promise<{
  pointer: LatestVersionPointer;
  meta: ProviderVersionMeta;
  metaSize: number;
  providerSize: number;
  profileSize: number;
}> {
  const latestObj = await bucket.get(latestPath(slug));
  if (!latestObj) throw publicErr("CONFIG_NOT_FOUND", "latest.json 不存在");

  const rawText = await latestObj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw publicErr("CONFIG_CORRUPTED", "latest.json 包含无效 JSON");
  }

  let pointer: StoredLatestPointer;
  try {
    pointer = parseStoredPointer(raw);
  } catch (e) {
    if (e instanceof VersionPublishError)
      throw publicErr("CONFIG_CORRUPTED", e.message);
    throw e;
  }

  if (isLegacyLatestJson(pointer)) {
    throw publicErr("CONFIG_NOT_AVAILABLE", "当前版本不支持完整配置");
  }

  let resolved: ResolvedV1Version;
  try {
    resolved = await resolveV1Version(bucket, slug, pointer.versionId, pointer);
  } catch (e) {
    if (e instanceof VersionPublishError)
      throw publicErr("CONFIG_CORRUPTED", e.message);
    throw e;
  }

  // Actual meta.json byte size from the resolved meta text
  const metaSize = new TextEncoder().encode(resolved.metaText).length;

  return {
    pointer,
    meta: resolved.meta,
    metaSize,
    providerSize: resolved.meta.artifacts.provider.contentLength,
    profileSize: resolved.meta.artifacts.profile.contentLength,
  };
}

// ── WebDAV config (stored in R2 at config/webdav.json) ──

const WEBDAV_CONFIG_KEY = "config/webdav.json";

export async function getWebDAVConfig(
  bucket: R2Bucket,
): Promise<WebDAVConfig | null> {
  const obj = await bucket.get(WEBDAV_CONFIG_KEY);
  if (!obj) return null;
  try {
    return (await obj.json()) as WebDAVConfig;
  } catch {
    return null;
  }
}

export async function saveWebDAVConfig(
  bucket: R2Bucket,
  config: WebDAVConfig,
): Promise<void> {
  await bucket.put(WEBDAV_CONFIG_KEY, JSON.stringify(config, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}
