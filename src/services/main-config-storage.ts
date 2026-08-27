import type {
  MainConfigIdentity,
  MainConfigVersionMeta,
  MainConfigLatestPointer,
  MainConfigArtifact,
  PublishMainConfigInput,
  MainConfigDependencies,
  MainConfigVersionListItem,
  MainConfigCurrentView,
  MainConfigVersionView,
  MainConfigErrorCode,
  ResolvedMainConfigBytes,
  ResolvedMainConfigMetadata,
} from "../types.ts";
import jsYaml from "js-yaml";

export type { PublishMainConfigInput };

// --- Constants ---

const DEFAULT_MAX_MAIN_CONFIG_BYTES = 2 * 1024 * 1024;

// --- Path helpers ---

const BASE = "vault/main-config";

export function identityKey(): string {
  return `${BASE}/identity.json`;
}

export function latestKey(): string {
  return `${BASE}/latest.json`;
}

export function versionDir(versionId: string): string {
  return `${BASE}/versions/${versionId}`;
}

export function versionYamlKey(versionId: string): string {
  return `${versionDir(versionId)}/main-config.yaml`;
}

export function versionMetaKey(versionId: string): string {
  return `${versionDir(versionId)}/meta.json`;
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

async function sha256HexBytes(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export function validateVersionId(versionId: string): boolean {
  return (
    versionId.length >= 1 &&
    versionId.length <= 160 &&
    !versionId.includes("/") &&
    !versionId.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(versionId)
  );
}

function validateConfigId(configId: string): boolean {
  return (
    typeof configId === "string" &&
    configId.length > 0 &&
    configId.length <= 128 &&
    !/[\x00-\x1f\x7f]/.test(configId)
  );
}

function isValidIsoTimestamp(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

// --- Error types ---

export class MainConfigError extends Error {
  constructor(
    public readonly code: MainConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MainConfigError";
  }
}

function err(code: MainConfigErrorCode, message: string): MainConfigError {
  return new MainConfigError(code, message);
}

// --- Safe error messages for external responses ---

const SAFE_ERROR_MESSAGES: Record<MainConfigErrorCode, string> = {
  INVALID_MAIN_CONFIG: "主配置格式无效",
  MAIN_CONFIG_TOO_LARGE: "主配置内容超过大小上限",
  MAIN_CONFIG_NOT_FOUND: "主配置不存在",
  MAIN_CONFIG_VERSION_NOT_FOUND: "指定版本不存在",
  MAIN_CONFIG_PRECONDITION_REQUIRED: "缺少必要的前置条件头",
  MAIN_CONFIG_CONFLICT: "操作冲突，请重试",
  MAIN_CONFIG_OBJECT_CONFLICT: "存储对象冲突",
  INVALID_MAIN_CONFIG_IDENTITY: "主配置身份数据损坏",
  INVALID_MAIN_CONFIG_POINTER: "主配置发布指针损坏",
  MAIN_CONFIG_IDENTITY_CONFLICT: "主配置身份冲突",
  MAIN_CONFIG_CORRUPTED: "主配置存储完整性验证失败",
};

export function getSafeErrorMessage(code: MainConfigErrorCode): string {
  return SAFE_ERROR_MESSAGES[code] ?? "主配置操作失败";
}

// --- Type guards ---

function isMainConfigIdentity(
  raw: Record<string, unknown>,
): raw is Record<string, unknown> & MainConfigIdentity {
  return (
    raw.schemaVersion === 1 &&
    typeof raw.configId === "string" &&
    validateConfigId(raw.configId) &&
    typeof raw.createdAt === "string" &&
    isValidIsoTimestamp(raw.createdAt)
  );
}

function isMainConfigLatestPointer(
  raw: Record<string, unknown>,
): raw is Record<string, unknown> & MainConfigLatestPointer {
  if (raw.schemaVersion !== 1) return false;
  if (typeof raw.configId !== "string" || !validateConfigId(raw.configId))
    return false;
  if (typeof raw.versionId !== "string" || !validateVersionId(raw.versionId))
    return false;
  if (raw.status !== "active" && raw.status !== "disabled") return false;
  if (
    typeof raw.publishedAt !== "string" ||
    !isValidIsoTimestamp(raw.publishedAt)
  )
    return false;
  if (typeof raw.metaKey !== "string" || !raw.metaKey) return false;
  if (typeof raw.metaSha256 !== "string" || !HEX64.test(raw.metaSha256))
    return false;
  // status invariant: active → no disabledAt; disabled → valid disabledAt
  if (raw.status === "active") {
    if (raw.disabledAt !== undefined) return false;
  } else {
    if (
      typeof raw.disabledAt !== "string" ||
      !isValidIsoTimestamp(raw.disabledAt)
    )
      return false;
  }
  return true;
}

function isMainConfigVersionMeta(
  raw: Record<string, unknown>,
): raw is Record<string, unknown> & MainConfigVersionMeta {
  if (raw.schemaVersion !== 1) return false;
  if (typeof raw.configId !== "string" || !validateConfigId(raw.configId))
    return false;
  if (typeof raw.versionId !== "string" || !validateVersionId(raw.versionId))
    return false;
  if (typeof raw.createdAt !== "string" || !isValidIsoTimestamp(raw.createdAt))
    return false;
  if (typeof raw.name !== "string" || !raw.name) return false;
  if (raw.source !== "manual") return false;
  const art = raw.artifact;
  if (typeof art !== "object" || art === null) return false;
  const a = art as Record<string, unknown>;
  if (typeof a.key !== "string" || !a.key) return false;
  if (typeof a.sha256 !== "string" || !HEX64.test(a.sha256)) return false;
  if (
    typeof a.contentLength !== "number" ||
    !Number.isInteger(a.contentLength) ||
    a.contentLength < 0
  )
    return false;
  return true;
}

// --- YAML validation ---

export function validateMainConfigYaml(yaml: string): void {
  if (!yaml || typeof yaml !== "string") {
    throw err("INVALID_MAIN_CONFIG", "YAML 内容不能为空");
  }

  let doc: unknown;
  try {
    doc = jsYaml.load(yaml, { json: true });
  } catch {
    // Do not expose js-yaml error details to external callers
    throw err("INVALID_MAIN_CONFIG", "YAML 语法无效");
  }

  if (doc === null || doc === undefined) {
    throw err("INVALID_MAIN_CONFIG", "YAML 内容不能为空文档");
  }

  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw err("INVALID_MAIN_CONFIG", "YAML 根节点必须是映射对象");
  }
}

export function validateMainConfigName(name: string): string {
  if (typeof name !== "string") {
    throw err("INVALID_MAIN_CONFIG", "name 必须是字符串");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw err("INVALID_MAIN_CONFIG", "name 不能为空");
  }
  if (trimmed.length > 128) {
    throw err("INVALID_MAIN_CONFIG", "name 不能超过 128 个字符");
  }
  return trimmed;
}

// --- Identity management ---

async function readIdentity(
  bucket: R2Bucket,
): Promise<{ identity: MainConfigIdentity; etag: string } | null> {
  const obj = await bucket.get(identityKey());
  if (!obj) return null;
  const text = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw err("INVALID_MAIN_CONFIG_IDENTITY", "identity.json 包含无效 JSON");
  }
  if (!isMainConfigIdentity(raw)) {
    throw err("INVALID_MAIN_CONFIG_IDENTITY", "identity.json Schema 不合法");
  }
  return { identity: raw as MainConfigIdentity, etag: obj.etag };
}

async function ensureIdentity(
  bucket: R2Bucket,
  deps: MainConfigDependencies,
): Promise<MainConfigIdentity> {
  const existing = await readIdentity(bucket);
  if (existing) return existing.identity;

  const identity: MainConfigIdentity = {
    schemaVersion: 1,
    configId: deps.generateConfigId(),
    createdAt: deps.now().toISOString(),
  };

  const json = JSON.stringify(sortKeysDeep(identity), null, 2);
  const result = await bucket.put(identityKey(), json, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });

  if (!result) {
    const winner = await readIdentity(bucket);
    if (!winner) {
      throw err(
        "MAIN_CONFIG_IDENTITY_CONFLICT",
        "identity.json 写入失败且无法读取已存在的身份",
      );
    }
    return winner.identity;
  }

  return identity;
}

// --- Read helpers ---

async function readPointer(
  bucket: R2Bucket,
): Promise<{ pointer: MainConfigLatestPointer; etag: string } | null> {
  const obj = await bucket.get(latestKey());
  if (!obj) return null;
  const text = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw err("INVALID_MAIN_CONFIG_POINTER", "latest.json 包含无效 JSON");
  }
  if (!isMainConfigLatestPointer(raw)) {
    throw err("INVALID_MAIN_CONFIG_POINTER", "latest.json Schema 不合法");
  }
  return { pointer: raw as MainConfigLatestPointer, etag: obj.etag };
}

async function readAndVerifyMeta(
  bucket: R2Bucket,
  configId: string,
  versionId: string,
): Promise<{
  meta: MainConfigVersionMeta;
  metaText: string;
  metaSha256: string;
}> {
  const key = versionMetaKey(versionId);
  const obj = await bucket.get(key);
  if (!obj) {
    throw err("MAIN_CONFIG_CORRUPTED", "meta.json 缺失");
  }

  const metaText = await obj.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(metaText) as Record<string, unknown>;
  } catch {
    throw err("MAIN_CONFIG_CORRUPTED", "meta.json 无效 JSON");
  }

  if (!isMainConfigVersionMeta(raw)) {
    throw err("MAIN_CONFIG_CORRUPTED", "meta.json Schema 不合法");
  }

  const meta = raw as unknown as MainConfigVersionMeta;
  const metaSha256 = await sha256Hex(metaText);

  if (meta.configId !== configId) {
    throw err("MAIN_CONFIG_CORRUPTED", "meta.configId 不一致");
  }
  if (meta.versionId !== versionId) {
    throw err("MAIN_CONFIG_CORRUPTED", "meta.versionId 不一致");
  }

  const expectedKey = versionYamlKey(versionId);
  if (meta.artifact.key !== expectedKey) {
    throw err("MAIN_CONFIG_CORRUPTED", "artifact.key 不一致");
  }

  return { meta, metaText, metaSha256 };
}

async function readAndVerifyYaml(
  bucket: R2Bucket,
  versionId: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<string> {
  const key = versionYamlKey(versionId);
  const obj = await bucket.get(key);
  if (!obj) {
    throw err("MAIN_CONFIG_CORRUPTED", "主配置 YAML 缺失");
  }

  const yaml = await obj.text();
  const actualSha256 = await sha256Hex(yaml);
  const actualSize = contentLengthBytes(yaml);

  if (actualSha256 !== expectedSha256 || actualSize !== expectedSize) {
    throw err("MAIN_CONFIG_CORRUPTED", "主配置 YAML 完整性验证失败");
  }

  return yaml;
}

// --- Unified current config resolver ---
// Used by publish, get, disable, enable, rollback

interface ResolvedCurrentConfig {
  identity: MainConfigIdentity;
  pointer: MainConfigLatestPointer;
  pointerEtag: string;
  meta: MainConfigVersionMeta;
  metaSha256: string;
  yaml: string;
}

interface ResolvedCurrentConfigCore {
  identity: MainConfigIdentity;
  pointer: MainConfigLatestPointer;
  pointerEtag: string;
  meta: MainConfigVersionMeta;
  metaSha256: string;
  artifactKey: string;
}

/**
 * Shared core: resolve pointer, identity, and meta for the current main config.
 * Does NOT read the YAML artifact.
 * Throws MainConfigError on corruption; returns null if no latest.json exists.
 */
async function resolveCurrentMainConfigCore(
  bucket: R2Bucket,
): Promise<ResolvedCurrentConfigCore | null> {
  const pointerResult = await readPointer(bucket);
  if (!pointerResult) return null;

  const { pointer, etag: pointerEtag } = pointerResult;

  const identityResult = await readIdentity(bucket);
  if (!identityResult) {
    throw err("MAIN_CONFIG_CORRUPTED", "latest.json 存在但 identity.json 缺失");
  }
  const { identity } = identityResult;

  if (pointer.configId !== identity.configId) {
    throw err(
      "MAIN_CONFIG_CORRUPTED",
      "pointer.configId 与 identity.configId 不一致",
    );
  }

  const expectedMetaKey = versionMetaKey(pointer.versionId);
  if (pointer.metaKey !== expectedMetaKey) {
    throw err("MAIN_CONFIG_CORRUPTED", "pointer.metaKey 不一致");
  }

  const resolved = await readAndVerifyMeta(
    bucket,
    identity.configId,
    pointer.versionId,
  );

  if (resolved.metaSha256 !== pointer.metaSha256) {
    throw err(
      "MAIN_CONFIG_CORRUPTED",
      "meta SHA-256 与 pointer.metaSha256 不一致",
    );
  }

  return {
    identity,
    pointer,
    pointerEtag,
    meta: resolved.meta,
    metaSha256: resolved.metaSha256,
    artifactKey: versionYamlKey(pointer.versionId),
  };
}

async function resolveCurrentMainConfig(
  bucket: R2Bucket,
): Promise<ResolvedCurrentConfig | null> {
  const core = await resolveCurrentMainConfigCore(bucket);
  if (!core) return null;

  const yaml = await readAndVerifyYaml(
    bucket,
    core.pointer.versionId,
    core.meta.artifact.sha256,
    core.meta.artifact.contentLength,
  );

  return {
    identity: core.identity,
    pointer: core.pointer,
    pointerEtag: core.pointerEtag,
    meta: core.meta,
    metaSha256: core.metaSha256,
    yaml,
  };
}

/**
 * Metadata-only verification for the current main config YAML.
 * Uses R2 head() — checks existence and size, does not read content.
 * Used by HEAD /main-config/:token.
 */
export async function resolveCurrentMainConfigMetadata(
  bucket: R2Bucket,
): Promise<ResolvedMainConfigMetadata | null> {
  const core = await resolveCurrentMainConfigCore(bucket);
  if (!core) return null;

  const headResult = await bucket.head(core.artifactKey);
  if (!headResult) {
    throw err("MAIN_CONFIG_CORRUPTED", "主配置 YAML 缺失");
  }

  const actualSize = headResult.size;
  const expectedSize = core.meta.artifact.contentLength;

  if (actualSize !== expectedSize) {
    throw err(
      "MAIN_CONFIG_CORRUPTED",
      `主配置 YAML 字节数不一致: 期望 ${expectedSize}, 实际 ${actualSize}`,
    );
  }

  return {
    exists: true,
    size: actualSize,
    pointer: core.pointer,
    meta: core.meta,
    sha256: core.meta.artifact.sha256,
    contentLength: expectedSize,
  };
}

/**
 * Read and verify the current main config YAML bytes.
 * Full integrity: exists, byte count, SHA-256.
 * Used by GET /main-config/:token.
 */
export async function readAndVerifyCurrentMainConfigBytes(
  bucket: R2Bucket,
): Promise<ResolvedMainConfigBytes | null> {
  const core = await resolveCurrentMainConfigCore(bucket);
  if (!core) return null;

  const obj = await bucket.get(core.artifactKey);
  if (!obj) {
    throw err("MAIN_CONFIG_CORRUPTED", "主配置 YAML 缺失");
  }

  const bytes = await obj.arrayBuffer();
  const actualLength = bytes.byteLength;
  const expectedLength = core.meta.artifact.contentLength;

  if (actualLength !== expectedLength) {
    throw err(
      "MAIN_CONFIG_CORRUPTED",
      `主配置 YAML 字节数不一致: 期望 ${expectedLength}, 实际 ${actualLength}`,
    );
  }

  const actualSha256 = await sha256HexBytes(bytes);
  const expectedSha256 = core.meta.artifact.sha256;

  if (actualSha256 !== expectedSha256) {
    throw err("MAIN_CONFIG_CORRUPTED", "主配置 YAML SHA-256 不一致");
  }

  return {
    bytes,
    pointer: core.pointer,
    meta: core.meta,
    sha256: actualSha256,
    contentLength: actualLength,
  };
}

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

  if (result) return;

  const existing = await bucket.get(key);
  if (!existing) {
    throw err("MAIN_CONFIG_OBJECT_CONFLICT", "写入失败且无法读取已存在对象");
  }

  const existingContent = await existing.text();
  if (existingContent !== content) {
    throw err("MAIN_CONFIG_OBJECT_CONFLICT", "不可变对象已存在且内容不同");
  }
}

// --- publishMainConfig ---

export async function publishMainConfig(
  bucket: R2Bucket,
  input: PublishMainConfigInput,
  deps?: MainConfigDependencies,
  maxYamlBytes?: number,
): Promise<{ versionId: string; etag: string }> {
  const now = deps?.now ?? (() => new Date());
  const genConfigId = deps?.generateConfigId ?? (() => crypto.randomUUID());
  const genVersionId =
    deps?.generateVersionId ??
    ((sha: string) => generateVersionIdWithHash(sha, now));
  const sizeLimit = maxYamlBytes ?? DEFAULT_MAX_MAIN_CONFIG_BYTES;

  // 1. Validate input
  const name = validateMainConfigName(input.name);
  validateMainConfigYaml(input.yaml);

  const yamlBytes = contentLengthBytes(input.yaml);
  if (yamlBytes > sizeLimit) {
    throw err("MAIN_CONFIG_TOO_LARGE", "主配置内容超过大小上限");
  }

  // 2. Snapshot starting latest.json BEFORE any identity operations
  const startingLatest = await readPointer(bucket);
  const startingEtag: string | null = startingLatest?.etag ?? null;

  // 3. Validate expectedLatest precondition IMMEDIATELY — no side effects before this
  if (input.expectedLatest !== undefined) {
    if (input.expectedLatest === null) {
      if (startingLatest !== null) {
        throw err("MAIN_CONFIG_CONFLICT", "latest.json 已存在");
      }
    } else {
      if (startingEtag !== input.expectedLatest) {
        throw err(
          "MAIN_CONFIG_CONFLICT",
          "expectedLatest 与当前 latest.json 不匹配",
        );
      }
    }
  }

  // 4. Identity: if latest exists, identity MUST already exist (no auto-create on update)
  let identity: MainConfigIdentity;
  if (startingLatest) {
    const identityResult = await readIdentity(bucket);
    if (!identityResult) {
      throw err(
        "MAIN_CONFIG_CORRUPTED",
        "latest.json 存在但 identity.json 缺失",
      );
    }
    identity = identityResult.identity;
  } else {
    // First creation — precondition already verified, safe to create identity
    const mcDeps: MainConfigDependencies = {
      now,
      generateConfigId: genConfigId,
      generateVersionId: genVersionId,
    };
    identity = await ensureIdentity(bucket, mcDeps);
  }

  // 5. If pointer exists, run full integrity verification
  if (startingLatest) {
    const pointer = startingLatest.pointer;

    // 6. Validate configId consistency
    if (pointer.configId !== identity.configId) {
      throw err(
        "MAIN_CONFIG_IDENTITY_CONFLICT",
        "pointer.configId 与 identity.configId 不一致",
      );
    }

    // 7. Validate pointer.metaKey standard path
    const expectedMetaKey = versionMetaKey(pointer.versionId);
    if (pointer.metaKey !== expectedMetaKey) {
      throw err("MAIN_CONFIG_CORRUPTED", "pointer.metaKey 不一致");
    }

    // 8. Verify current version's meta using its OWN hashes
    const resolved = await readAndVerifyMeta(
      bucket,
      identity.configId,
      pointer.versionId,
    );

    // 9. Verify pointer.metaSha256
    if (resolved.metaSha256 !== pointer.metaSha256) {
      throw err(
        "MAIN_CONFIG_CORRUPTED",
        "meta SHA-256 与 pointer.metaSha256 不一致",
      );
    }

    // 10. Verify current version's YAML using its OWN hashes
    await readAndVerifyYaml(
      bucket,
      pointer.versionId,
      resolved.meta.artifact.sha256,
      resolved.meta.artifact.contentLength,
    );

    // Current version is intact — check idempotent reuse
    const inputSha256 = await sha256Hex(input.yaml);
    const inputSize = contentLengthBytes(input.yaml);

    const canReuse =
      resolved.meta.configId === identity.configId &&
      resolved.meta.name === name &&
      resolved.meta.artifact.sha256 === inputSha256 &&
      resolved.meta.artifact.contentLength === inputSize;

    if (canReuse) {
      if (pointer.status === "active") {
        return { versionId: pointer.versionId, etag: startingLatest.etag };
      }

      // disabled + same content → CAS to reactivate
      const publishedAt = now().toISOString();
      const newPointer: MainConfigLatestPointer = {
        schemaVersion: 1,
        configId: identity.configId,
        versionId: pointer.versionId,
        status: "active",
        publishedAt,
        metaKey: versionMetaKey(pointer.versionId),
        metaSha256: resolved.metaSha256,
      };

      const pointerJson = JSON.stringify(sortKeysDeep(newPointer), null, 2);
      const result = await bucket.put(latestKey(), pointerJson, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: startingEtag! },
      });

      if (!result) {
        throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
      }

      const newLatestObj = await bucket.get(latestKey());
      return {
        versionId: pointer.versionId,
        etag: newLatestObj?.etag ?? "",
      };
    }

    // Not identical — proceed to create new version
  }

  // 11. Generate versionId
  const inputSha256 = await sha256Hex(input.yaml);
  const versionId = await genVersionId(inputSha256);
  const yamlKey = versionYamlKey(versionId);
  const metaKeyPath = versionMetaKey(versionId);

  // 12. Immutable write main-config.yaml
  await writeImmutableObject(
    bucket,
    yamlKey,
    input.yaml,
    "text/yaml; charset=utf-8",
  );

  // 13. Construct and write meta.json
  const createdAt = now().toISOString();
  const artifact: MainConfigArtifact = {
    key: yamlKey,
    sha256: inputSha256,
    contentLength: contentLengthBytes(input.yaml),
  };

  const meta: MainConfigVersionMeta = {
    schemaVersion: 1,
    configId: identity.configId,
    versionId,
    createdAt,
    name,
    source: "manual",
    artifact,
  };

  const metaJson = JSON.stringify(sortKeysDeep(meta), null, 2);
  const metaSha256 = await sha256Hex(metaJson);

  await writeImmutableObject(bucket, metaKeyPath, metaJson, "application/json");

  // 14. Verify both objects
  const verifyYamlObj = await bucket.get(yamlKey);
  if (!verifyYamlObj) {
    throw err("MAIN_CONFIG_CORRUPTED", "写入后验证失败");
  }
  const verifyYaml = await verifyYamlObj.text();
  const verifyYamlSha = await sha256Hex(verifyYaml);
  if (
    verifyYamlSha !== inputSha256 ||
    contentLengthBytes(verifyYaml) !== artifact.contentLength
  ) {
    throw err("MAIN_CONFIG_CORRUPTED", "写入后完整性验证失败");
  }

  const verifyMetaObj = await bucket.get(metaKeyPath);
  if (!verifyMetaObj) {
    throw err("MAIN_CONFIG_CORRUPTED", "写入后验证失败");
  }
  const verifyMetaText = await verifyMetaObj.text();
  const verifyMetaSha = await sha256Hex(verifyMetaText);
  if (verifyMetaSha !== metaSha256) {
    throw err("MAIN_CONFIG_CORRUPTED", "写入后完整性验证失败");
  }

  // 15. CAS update latest.json using operation-start baseline
  const publishedAt = now().toISOString();
  const pointer: MainConfigLatestPointer = {
    schemaVersion: 1,
    configId: identity.configId,
    versionId,
    status: "active",
    publishedAt,
    metaKey: metaKeyPath,
    metaSha256,
  };

  const pointerJson = JSON.stringify(sortKeysDeep(pointer), null, 2);
  const result = await bucket.put(latestKey(), pointerJson, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: startingLatest
      ? { etagMatches: startingEtag! }
      : { etagDoesNotMatch: "*" },
  });

  if (!result) {
    throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
  }

  const newLatestObj = await bucket.get(latestKey());
  return {
    versionId,
    etag: newLatestObj?.etag ?? "",
  };
}

// --- getMainConfig ---

export async function getMainConfig(
  bucket: R2Bucket,
): Promise<{ view: MainConfigCurrentView; etag: string } | null> {
  const resolved = await resolveCurrentMainConfig(bucket);
  if (!resolved) return null;

  const { pointer, pointerEtag, meta, yaml } = resolved;

  const view: MainConfigCurrentView = {
    configId: pointer.configId,
    status: pointer.status,
    versionId: pointer.versionId,
    name: meta.name,
    yaml,
    sha256: meta.artifact.sha256,
    contentLength: meta.artifact.contentLength,
    createdAt: meta.createdAt,
    publishedAt: pointer.publishedAt,
    disabledAt: pointer.disabledAt ?? null,
  };

  return { view, etag: pointerEtag };
}

// --- listMainConfigVersions ---

export async function listMainConfigVersions(
  bucket: R2Bucket,
): Promise<MainConfigVersionListItem[]> {
  // Fully verify the current published version first.
  // This catches: latest+no-identity, corrupted pointer, corrupted meta, corrupted YAML.
  // Throws MAIN_CONFIG_CORRUPTED if latest exists but any integrity check fails.
  const current = await resolveCurrentMainConfig(bucket);
  const currentVersionId = current?.pointer.versionId;

  // If no current version, check if identity exists for orphaned history
  const configId =
    current?.identity.configId ??
    (await readIdentity(bucket))?.identity.configId;
  if (!configId) return [];

  const items: MainConfigVersionListItem[] = [];
  const seenVersionIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix: `${BASE}/versions/`,
      cursor,
    });
    for (const obj of result.objects) {
      try {
        const parsed = parseVersionObjectKey(obj.key);
        if (!parsed) continue;
        if (seenVersionIds.has(parsed.versionId)) continue;

        // Skip the current version — already fully verified by resolveCurrentMainConfig
        if (currentVersionId === parsed.versionId) {
          seenVersionIds.add(parsed.versionId);
          if (current) {
            items.push({
              versionId: current.meta.versionId,
              name: current.meta.name,
              createdAt: current.meta.createdAt,
              sha256: current.meta.artifact.sha256,
              contentLength: current.meta.artifact.contentLength,
              isCurrent: true,
            });
          }
          continue;
        }

        // Non-current historical versions: validate but skip on corruption
        const fetched = await bucket.get(obj.key);
        if (!fetched) continue;
        const rawText = await fetched.text();
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (!isMainConfigVersionMeta(raw)) continue;
        const meta = raw as unknown as MainConfigVersionMeta;

        if (meta.configId !== configId) continue;
        if (meta.versionId !== parsed.versionId) continue;
        const expectedArtifactKey = versionYamlKey(parsed.versionId);
        if (meta.artifact.key !== expectedArtifactKey) continue;

        seenVersionIds.add(parsed.versionId);
        items.push({
          versionId: meta.versionId,
          name: meta.name,
          createdAt: meta.createdAt,
          sha256: meta.artifact.sha256,
          contentLength: meta.artifact.contentLength,
          isCurrent: false,
        });
      } catch {
        // Skip corrupted/malformed non-current version metadata
      }
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return items.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function parseVersionObjectKey(key: string): { versionId: string } | null {
  const prefix = `${BASE}/versions/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);

  const match = rest.match(/^([^/]+)\/meta\.json$/);
  if (match?.[1]) {
    return { versionId: match[1] };
  }

  return null;
}

// --- getMainConfigVersion ---

export async function getMainConfigVersion(
  bucket: R2Bucket,
  versionId: string,
): Promise<{ view: MainConfigVersionView; etag: string } | null> {
  if (!validateVersionId(versionId)) {
    throw err("MAIN_CONFIG_VERSION_NOT_FOUND", "versionId 格式无效");
  }

  // Resolve current config first to catch any corruption (latest+no-identity, etc.)
  const current = await resolveCurrentMainConfig(bucket);
  const currentVersionId = current?.pointer.versionId;

  // If this is the current version, return it directly from the resolved data
  if (current && currentVersionId === versionId) {
    const metaObj = await bucket.get(versionMetaKey(versionId));
    return {
      view: {
        configId: current.meta.configId,
        versionId: current.meta.versionId,
        name: current.meta.name,
        yaml: current.yaml,
        sha256: current.meta.artifact.sha256,
        contentLength: current.meta.artifact.contentLength,
        createdAt: current.meta.createdAt,
        isCurrent: true,
      },
      etag: metaObj?.etag ?? "",
    };
  }

  // Non-current version: need identity for configId
  const configId =
    current?.identity.configId ??
    (await readIdentity(bucket))?.identity.configId;
  if (!configId) return null;

  const metaExists = await bucket.get(versionMetaKey(versionId));
  if (!metaExists) return null;

  const resolved = await readAndVerifyMeta(bucket, configId, versionId);

  const yaml = await readAndVerifyYaml(
    bucket,
    versionId,
    resolved.meta.artifact.sha256,
    resolved.meta.artifact.contentLength,
  );

  const view: MainConfigVersionView = {
    configId: resolved.meta.configId,
    versionId: resolved.meta.versionId,
    name: resolved.meta.name,
    yaml,
    sha256: resolved.meta.artifact.sha256,
    contentLength: resolved.meta.artifact.contentLength,
    createdAt: resolved.meta.createdAt,
    isCurrent: false,
  };

  const metaObj = await bucket.get(versionMetaKey(versionId));
  return { view, etag: metaObj?.etag ?? "" };
}

// --- rollbackMainConfig ---

export async function rollbackMainConfig(
  bucket: R2Bucket,
  targetVersionId: string,
  expectedLatestEtag: string,
  deps?: MainConfigDependencies,
): Promise<{ versionId: string; etag: string }> {
  const now = deps?.now ?? (() => new Date());

  if (!validateVersionId(targetVersionId)) {
    throw err("MAIN_CONFIG_VERSION_NOT_FOUND", "versionId 格式无效");
  }

  // Verify current config integrity first
  const current = await resolveCurrentMainConfig(bucket);
  if (!current) {
    throw err("MAIN_CONFIG_NOT_FOUND", "主配置不存在");
  }

  const { identity, pointerEtag } = current;

  if (expectedLatestEtag !== pointerEtag) {
    throw err(
      "MAIN_CONFIG_CONFLICT",
      "expectedLatestEtag 与当前 latest.json 不匹配",
    );
  }

  // Verify target version exists before deep verification
  const targetMetaExists = await bucket.get(versionMetaKey(targetVersionId));
  if (!targetMetaExists) {
    throw err("MAIN_CONFIG_VERSION_NOT_FOUND", "目标版本不存在");
  }

  const resolved = await readAndVerifyMeta(
    bucket,
    identity.configId,
    targetVersionId,
  );
  await readAndVerifyYaml(
    bucket,
    targetVersionId,
    resolved.meta.artifact.sha256,
    resolved.meta.artifact.contentLength,
  );

  // CAS update latest.json
  const publishedAt = now().toISOString();
  const pointer: MainConfigLatestPointer = {
    schemaVersion: 1,
    configId: identity.configId,
    versionId: targetVersionId,
    status: "active",
    publishedAt,
    metaKey: versionMetaKey(targetVersionId),
    metaSha256: resolved.metaSha256,
  };

  const pointerJson = JSON.stringify(sortKeysDeep(pointer), null, 2);
  const result = await bucket.put(latestKey(), pointerJson, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: pointerEtag },
  });

  if (!result) {
    throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
  }

  const newLatestObj = await bucket.get(latestKey());
  return {
    versionId: targetVersionId,
    etag: newLatestObj?.etag ?? "",
  };
}

// --- disableMainConfig ---

export async function disableMainConfig(
  bucket: R2Bucket,
  expectedLatestEtag: string,
  deps?: MainConfigDependencies,
): Promise<{ etag: string }> {
  const now = deps?.now ?? (() => new Date());

  // Verify current config integrity
  const current = await resolveCurrentMainConfig(bucket);
  if (!current) {
    throw err("MAIN_CONFIG_NOT_FOUND", "主配置不存在");
  }

  const { identity, pointer, pointerEtag } = current;

  if (expectedLatestEtag !== pointerEtag) {
    throw err(
      "MAIN_CONFIG_CONFLICT",
      "expectedLatestEtag 与当前 latest.json 不匹配",
    );
  }

  // Already disabled — idempotent CAS
  if (pointer.status === "disabled") {
    const result = await bucket.put(
      latestKey(),
      JSON.stringify(sortKeysDeep(pointer), null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: pointerEtag },
      },
    );
    if (!result) {
      throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
    }
    const newLatestObj = await bucket.get(latestKey());
    return { etag: newLatestObj?.etag ?? "" };
  }

  const disabledAt = now().toISOString();
  const newPointer: MainConfigLatestPointer = {
    schemaVersion: 1,
    configId: identity.configId,
    versionId: pointer.versionId,
    status: "disabled",
    publishedAt: disabledAt,
    metaKey: pointer.metaKey,
    metaSha256: pointer.metaSha256,
    disabledAt,
  };

  const pointerJson = JSON.stringify(sortKeysDeep(newPointer), null, 2);
  const result = await bucket.put(latestKey(), pointerJson, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: pointerEtag },
  });

  if (!result) {
    throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
  }

  const newLatestObj = await bucket.get(latestKey());
  return { etag: newLatestObj?.etag ?? "" };
}

// --- enableMainConfig ---

export async function enableMainConfig(
  bucket: R2Bucket,
  expectedLatestEtag: string,
  deps?: MainConfigDependencies,
): Promise<{ etag: string }> {
  const now = deps?.now ?? (() => new Date());

  // Verify current config integrity
  const current = await resolveCurrentMainConfig(bucket);
  if (!current) {
    throw err("MAIN_CONFIG_NOT_FOUND", "主配置不存在");
  }

  const { identity, pointer, pointerEtag } = current;

  if (expectedLatestEtag !== pointerEtag) {
    throw err(
      "MAIN_CONFIG_CONFLICT",
      "expectedLatestEtag 与当前 latest.json 不匹配",
    );
  }

  // Already active — idempotent CAS
  if (pointer.status === "active") {
    const result = await bucket.put(
      latestKey(),
      JSON.stringify(sortKeysDeep(pointer), null, 2),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: pointerEtag },
      },
    );
    if (!result) {
      throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
    }
    const newLatestObj = await bucket.get(latestKey());
    return { etag: newLatestObj?.etag ?? "" };
  }

  const publishedAt = now().toISOString();
  const newPointer: MainConfigLatestPointer = {
    schemaVersion: 1,
    configId: identity.configId,
    versionId: pointer.versionId,
    status: "active",
    publishedAt,
    metaKey: pointer.metaKey,
    metaSha256: pointer.metaSha256,
  };

  const pointerJson = JSON.stringify(sortKeysDeep(newPointer), null, 2);
  const result = await bucket.put(latestKey(), pointerJson, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: pointerEtag },
  });

  if (!result) {
    throw err("MAIN_CONFIG_CONFLICT", "latest.json 已被另一操作修改");
  }

  const newLatestObj = await bucket.get(latestKey());
  return { etag: newLatestObj?.etag ?? "" };
}

// --- Helpers ---

function generateVersionIdWithHash(
  contentSha256: string,
  now: () => Date,
): string {
  const ts = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const hashPrefix = contentSha256.slice(0, 8);
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const randHex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${ts}-${hashPrefix}-${randHex}`;
}
