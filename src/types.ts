export interface Env {
  SUBSCRIPTION_BUCKET: R2Bucket;
  INSTANCE_SECRET?: string;
  BROWSER?: Fetcher;
  UPSTREAM_RELAY?: Fetcher;
  ADMIN_TOKEN: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  LOGIN_RATE_LIMITER?: RateLimit;
  DOWNLOAD_TOKEN: string;
  MAX_SOURCE_BYTES?: string;
  MAX_REDIRECTS?: string;
  FETCH_TIMEOUT_MS?: string;
  MAX_MAIN_CONFIG_BYTES?: string;
  PUBLIC_BASE_URL?: string;
  TRUSTED_PUBLIC_ORIGINS?: string;
}

export interface WebDAVConfig {
  url: string;
  username: string;
  password: string;
  remotePath: string;
}

export interface ProviderMeta {
  versionId: string;
  providerSlug: string;
  providerName: string;
  createdAt: string;
  sha256: string;
  nodeCount: number;
  sourceHost: string;
  contentLength: number;
  subscriptionUserinfo?: string;
  profileUpdateInterval?: string;
  profileWebPageUrl?: string;
}

export interface LatestJson {
  versionId: string;
  sha256: string;
  updatedAt: string;
}

export interface ProxyNode {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface ClashConfig {
  proxies?: ProxyNode[];
  "proxy-groups"?: unknown[];
  rules?: unknown[];
  [key: string]: unknown;
}

export interface UpdateRequest {
  name: string;
  sourceUrl: string;
  userAgent?: string;
}

export interface RollbackRequest {
  versionId: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProviderListItem {
  slug: string;
  name: string;
  latestVersion: LatestJson | null;
  nodeCount: number;
  sourceHost: string;
}

/**
 * Provider list projection that also carries its stored source settings, so the
 * admin list can be assembled without a second R2 pass per provider.
 */
export interface ProviderListEntry extends ProviderListItem {
  sourceUrl: string;
  userAgent: string;
}

export interface ProviderOrderDocument {
  schemaVersion: 1;
  slugs: string[];
  updatedAt: string;
}

export interface HistoryItem {
  versionId: string;
  createdAt: string;
  nodeCount: number;
  sha256Prefix: string;
  contentLength: number;
  sourceHost: string;
  isCurrent: boolean;
}

export interface BackupManifest {
  format: string;
  version: number;
  exportedAt: string;
  providers: string[];
  truncatedFiles?: string[];
}

export interface StagingItem {
  requestId: string;
  status: string;
  fetchedAt: string;
  error?: string;
}

// --- Unified Version Publishing Types ---

export interface VersionArtifact {
  key: string;
  sha256: string;
  contentLength: number;
}

// --- Node Statistics (schemaVersion 2) ---

export interface NodeStats {
  inline: number;
  dependencyRaw: number;
  excluded: number;
  effective: number;
}

export interface ProxyProviderEntry {
  name: string;
  type: string;
  url?: string;
  "exclude-filter"?: string[];
  [key: string]: unknown;
}

// Raw proxy-provider as parsed from YAML (before normalization)
export interface RawProxyProviderEntry {
  name?: string;
  type?: string;
  url?: string;
  "exclude-filter"?: string | string[];
  [key: string]: unknown;
}

export interface InternalDependencyInfo {
  slug: string;
  subscriptionId: string;
  uid: string;
  versionId: string;
  nodeCount: number;
  excludedCount: number;
  effectiveCount: number;
  providerSha256: string;
  profileSha256: string;
}

export interface ProviderVersionMeta {
  schemaVersion: 1 | 2;
  providerSlug: string;
  subscriptionId: string;
  uid: string;
  versionId: string;
  createdAt: string;
  sourceSha256: string;
  nodeCount: number;
  generatorVersion: string;
  distribution: ProviderDistributionMetadata;

  artifacts: {
    raw: VersionArtifact;
    provider: VersionArtifact;
    profile: VersionArtifact;
  };

  // schemaVersion 2 optional fields
  nodeStats?: NodeStats;
  internalDependencies?: InternalDependencyInfo[];
}

export interface LatestVersionPointer {
  schemaVersion: 1;
  providerSlug: string;
  subscriptionId: string;
  uid: string;
  versionId: string;
  publishedAt: string;
  metaKey: string;
  metaSha256: string;
}

export type StoredLatestPointer = LatestJson | LatestVersionPointer;

export function isLegacyLatestJson(value: unknown): value is LatestJson {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.versionId === "string" &&
    typeof v.sha256 === "string" &&
    typeof v.updatedAt === "string" &&
    v.schemaVersion === undefined
  );
}

const HEX64 = /^[0-9a-f]{64}$/;

// validateSlug is a pure regex check with no circular dependency on types
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isLatestVersionPointerV1(
  value: unknown,
): value is LatestVersionPointer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    typeof v.providerSlug === "string" &&
    SLUG_RE.test(v.providerSlug) &&
    typeof v.subscriptionId === "string" &&
    v.subscriptionId.length > 0 &&
    typeof v.uid === "string" &&
    v.uid.length > 0 &&
    typeof v.versionId === "string" &&
    v.versionId.length > 0 &&
    typeof v.publishedAt === "string" &&
    v.publishedAt.length > 0 &&
    typeof v.metaKey === "string" &&
    v.metaKey.length > 0 &&
    typeof v.metaSha256 === "string" &&
    HEX64.test(v.metaSha256)
  );
}

export function hasNodeStats(
  meta: ProviderVersionMeta,
): meta is ProviderVersionMeta & { nodeStats: NodeStats } {
  return (
    meta.schemaVersion === 2 &&
    meta.nodeStats !== undefined &&
    typeof meta.nodeStats.inline === "number" &&
    typeof meta.nodeStats.dependencyRaw === "number" &&
    typeof meta.nodeStats.excluded === "number" &&
    typeof meta.nodeStats.effective === "number"
  );
}

export interface ClientUpdatePolicy {
  allowAutoUpdate: boolean;
  updateIntervalMinutes: number;
}

export interface ProviderDistributionMetadata {
  providerName: string;
  sourceHost: string;
  sourceType?: "local" | "remote";
  subscriptionUserinfo?: string;
  profileUpdateInterval?: string;
  profileWebPageUrl?: string;
  clientUpdatePolicy?: ClientUpdatePolicy;
}

export interface PublishVersionInput {
  providerSlug: string;
  subscriptionId: string;
  uid: string;

  rawContent: string;
  providerYaml: string;
  profileYaml: string;
  nodeCount: number;
  generatorVersion: string;

  distribution: ProviderDistributionMetadata;

  /** null requires latest.json to be absent at operation start. */
  expectedLatestEtag?: string | null;

  // schemaVersion 2 optional fields
  nodeStats?: NodeStats;
  internalDependencies?: InternalDependencyInfo[];
}

export interface PublishedVersion {
  versionId: string;
  latest: LatestVersionPointer;
  meta: ProviderVersionMeta;
}

export interface PublishDependencies {
  now(): Date;
  generateVersionId(sourceSha256: string): string | Promise<string>;
}

/**
 * Defer post-publish housekeeping (version pruning) until after the response has
 * been sent. Wired to `ExecutionContext.waitUntil` by the HTTP layer; without it
 * the work is awaited as before.
 */
export type DeferWork = (promise: Promise<unknown>) => void;

// Error codes for version publishing
export type VersionPublishErrorCode =
  | "VERSION_CONFLICT"
  | "VERSION_OBJECT_CONFLICT"
  | "INVALID_INPUT"
  | "INVALID_STORED_POINTER"
  | "STORED_VERSION_CORRUPTED"
  | "PROVIDER_IDENTITY_CONFLICT";

// --- Main Config Types (Phase 3) ---

export interface MainConfigIdentity {
  schemaVersion: 1;
  configId: string;
  createdAt: string;
}

export interface MainConfigArtifact {
  key: string;
  sha256: string;
  contentLength: number;
}

export interface MainConfigVersionMeta {
  schemaVersion: 1;
  configId: string;
  versionId: string;
  createdAt: string;
  name: string;
  source: "manual";
  artifact: MainConfigArtifact;
}

export interface MainConfigLatestPointer {
  schemaVersion: 1;
  configId: string;
  versionId: string;
  status: "active" | "disabled";
  publishedAt: string;
  metaKey: string;
  metaSha256: string;
  disabledAt?: string;
}

export interface PublishMainConfigInput {
  name: string;
  yaml: string;
  /**
   * null = operation start must have no latest.json (first creation).
   * string = operation start latest.json ETag must exactly match.
   * undefined = no precondition check (internal use only).
   */
  expectedLatest?: string | null;
}

export interface MainConfigDependencies {
  now(): Date;
  generateConfigId(): string;
  generateVersionId(contentSha256: string): string | Promise<string>;
}

export interface MainConfigVersionListItem {
  versionId: string;
  name: string;
  createdAt: string;
  sha256: string;
  contentLength: number;
  isCurrent: boolean;
}

export interface MainConfigCurrentView {
  configId: string;
  status: "active" | "disabled";
  versionId: string;
  name: string;
  yaml: string;
  sha256: string;
  contentLength: number;
  createdAt: string;
  publishedAt: string;
  disabledAt: string | null;
}

export interface MainConfigVersionView {
  configId: string;
  versionId: string;
  name: string;
  yaml: string;
  sha256: string;
  contentLength: number;
  createdAt: string;
  isCurrent: boolean;
}

export type MainConfigErrorCode =
  | "INVALID_MAIN_CONFIG"
  | "MAIN_CONFIG_TOO_LARGE"
  | "MAIN_CONFIG_NOT_FOUND"
  | "MAIN_CONFIG_VERSION_NOT_FOUND"
  | "MAIN_CONFIG_PRECONDITION_REQUIRED"
  | "MAIN_CONFIG_CONFLICT"
  | "MAIN_CONFIG_OBJECT_CONFLICT"
  | "INVALID_MAIN_CONFIG_IDENTITY"
  | "INVALID_MAIN_CONFIG_POINTER"
  | "MAIN_CONFIG_IDENTITY_CONFLICT"
  | "MAIN_CONFIG_CORRUPTED";

// --- Public Download Route Types (Phase 4) ---

export type PublicProviderErrorCode =
  "CONFIG_NOT_FOUND" | "CONFIG_NOT_AVAILABLE" | "CONFIG_CORRUPTED";

export interface ResolvedProfileBytes {
  bytes: ArrayBuffer;
  meta: ProviderVersionMeta;
  pointer: LatestVersionPointer;
  sha256: string;
  contentLength: number;
}

export interface ResolvedProfileMetadata {
  exists: boolean;
  size: number;
  meta: ProviderVersionMeta;
  pointer: LatestVersionPointer;
  sha256: string;
  contentLength: number;
}

export interface ResolvedMainConfigBytes {
  bytes: ArrayBuffer;
  pointer: MainConfigLatestPointer;
  meta: MainConfigVersionMeta;
  sha256: string;
  contentLength: number;
}

export interface ResolvedMainConfigMetadata {
  exists: boolean;
  size: number;
  pointer: MainConfigLatestPointer;
  meta: MainConfigVersionMeta;
  sha256: string;
  contentLength: number;
}

// --- Unified Export Types (Phase 5) ---

export type UnifiedExportErrorCode =
  | "INVALID_SLUG"
  | "INVALID_QUERY"
  | "UNAUTHORIZED"
  | "UNIFIED_EXPORT_PROVIDER_NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNIFIED_EXPORT_PROVIDERS_REQUIRED"
  | "UNIFIED_EXPORT_PROVIDER_NOT_AVAILABLE"
  | "UNIFIED_EXPORT_UID_CONFLICT"
  | "UNIFIED_EXPORT_TOO_LARGE"
  | "UNIFIED_EXPORT_CONFIGURATION_ERROR"
  | "UNIFIED_EXPORT_PROVIDER_CORRUPTED"
  | "UNIFIED_EXPORT_GENERATION_FAILED";

export interface ProviderBundle {
  pointer: LatestVersionPointer;
  meta: ProviderVersionMeta;
  metaBytes: Uint8Array;
  providerBytes: Uint8Array;
  profileBytes: Uint8Array;
}

export interface UnifiedManifestFileEntry {
  sha256: string;
  contentLength: number;
  required: boolean;
}

export interface UnifiedManifestAirport {
  slug: string;
  subscriptionId: string;
  name: string;
  profileUid: string;
  versionId: string;
  nodeCount: number;
  providerSha256: string;
  profileSha256: string;
  nodeStats?: NodeStats;
}

export interface UnifiedManifestDependency {
  slug: string;
  subscriptionId: string;
  uid: string;
  versionId: string;
  nodeCount: number;
  providerSha256: string;
  profileSha256: string;
}

export interface UnifiedManifest {
  format: "mihomo-unified-backup";
  formatVersion: 1 | 2;
  archiveType: "unified-subscription-archive";
  createdAt: string;
  generator: "worker" | "slclash";
  generatorVersion: "1.0.0";
  publicBaseUrl: string;
  mainConfig: {
    configId: string;
    versionId: string;
    name: string;
    sourceSha256: string;
  };
  airports: UnifiedManifestAirport[];
  files: Record<string, UnifiedManifestFileEntry>;
  // formatVersion 2 optional fields
  dependencySlugs?: string[];
  dependencies?: UnifiedManifestDependency[];
}

// --- LLM Credential Vault (Phase 6) ---
//
// Deliberately independent from the provider subscription model: these records
// live under the `llm/` R2 prefix, are never enumerated by the subscription
// listing/export code paths, and are never part of the unified backup archive.

/** Non-sensitive identifier for a stored key, used only to tell entries apart. */
export interface LlmSecretHint {
  last4: string;
  length: number;
}

/** AES-GCM envelope persisted at `llm/{slug}/secret.v1.enc.json`. */
export interface LlmSecretEnvelope {
  schemaVersion: 1;
  algorithm: "AES-GCM";
  kdf: "HKDF-SHA256";
  info: string;
  iv: string;
  ciphertext: string;
}

/** Decrypted payload of a secret envelope. */
export interface LlmSecretPlaintext {
  apiKey: string;
  extra: Record<string, unknown>;
}

/** Commit point: readers must verify this hash before decrypting. */
export interface LlmSecretPointer {
  key: string;
  sha256: string;
  updatedAt: string;
  /**
   * ETag of the stored ciphertext, recorded so a rotation can assert the exact
   * revision it replaces without re-reading the object first. Optional: records
   * written before this field existed fall back to a read.
   */
  etag?: string;
}

export interface LlmKeyMeta {
  schemaVersion: 1;
  slug: string;
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  notes: string;
  tags: string[];
  hint: LlmSecretHint;
  secret: LlmSecretPointer;
  createdAt: string;
  updatedAt: string;
}

/** Listing projection. Never carries the key or the ciphertext. */
export interface LlmKeyListItem {
  slug: string;
  name: string;
  provider: string;
  baseUrl: string;
  models: string[];
  tags: string[];
  hint: LlmSecretHint;
  secretPresent: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `corrupted` means the stored ciphertext no longer matches meta.secret.sha256. */
export type LlmIntegrityStatus = "ok" | "missing" | "corrupted";

export interface LlmKeyDetail {
  meta: LlmKeyMeta;
  integrity: LlmIntegrityStatus;
}

export type LlmKeyErrorCode =
  | "INVALID_SLUG"
  | "INVALID_LLM_PAYLOAD"
  | "LLM_KEY_NOT_FOUND"
  | "LLM_KEY_CONFLICT"
  | "LLM_KEY_CORRUPTED"
  | "LLM_STORE_UNAVAILABLE"
  | "LLM_STORE_WRITE_FAILED";
