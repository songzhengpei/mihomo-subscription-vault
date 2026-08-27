import type {
  Env,
  UnifiedExportErrorCode,
  ProviderBundle,
  UnifiedManifest,
  UnifiedManifestAirport,
  UnifiedManifestDependency,
  ProviderVersionMeta,
  LatestVersionPointer,
  ClientUpdatePolicy,
} from "../types.ts";
import { hasNodeStats } from "../types.ts";
import * as storage from "./storage.ts";
import { precomputeZip, streamZip } from "./zip.ts";
import jsYaml from "js-yaml";
import { validateSlug } from "../security/ssrf.ts";

const MAX_UNIFIED_EXPORT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
export const MINIMAL_COMPAT_CONFIG_YAML =
  "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n";

// --- Error type ---

export class UnifiedExportError extends Error {
  constructor(
    public readonly code: UnifiedExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UnifiedExportError";
  }
}

function uerr(
  code: UnifiedExportErrorCode,
  message: string,
): UnifiedExportError {
  return new UnifiedExportError(code, message);
}

// --- Error code → HTTP status ---

export const UNIFIED_ERROR_HTTP: Record<UnifiedExportErrorCode, number> = {
  INVALID_SLUG: 400,
  INVALID_QUERY: 400,
  UNAUTHORIZED: 401,
  UNIFIED_EXPORT_PROVIDER_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNIFIED_EXPORT_PROVIDERS_REQUIRED: 409,
  UNIFIED_EXPORT_PROVIDER_NOT_AVAILABLE: 409,
  UNIFIED_EXPORT_UID_CONFLICT: 409,
  UNIFIED_EXPORT_TOO_LARGE: 413,
  UNIFIED_EXPORT_CONFIGURATION_ERROR: 500,
  UNIFIED_EXPORT_PROVIDER_CORRUPTED: 500,
  UNIFIED_EXPORT_GENERATION_FAILED: 500,
};

// --- Helpers ---

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validatePublicBaseUrl(env: Env): string {
  const raw = env.PUBLIC_BASE_URL;
  if (!raw || typeof raw !== "string" || raw.trim() === "") {
    throw uerr("UNIFIED_EXPORT_CONFIGURATION_ERROR", "PUBLIC_BASE_URL 未配置");
  }
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "PUBLIC_BASE_URL 格式无效",
    );
  }
  if (url.protocol !== "https:") {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "PUBLIC_BASE_URL 必须使用 HTTPS",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "PUBLIC_BASE_URL 不得包含路径",
    );
  }
  if (url.search || url.hash) {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "PUBLIC_BASE_URL 不得包含查询参数或 fragment",
    );
  }
  if (url.username || url.password) {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "PUBLIC_BASE_URL 不得包含用户名或密码",
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function validateDownloadToken(token: string): void {
  if (!token || !DOWNLOAD_TOKEN_RE.test(token)) {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "DOWNLOAD_TOKEN 包含非法字符",
    );
  }
  if (token === "." || token === "..") {
    throw uerr(
      "UNIFIED_EXPORT_CONFIGURATION_ERROR",
      "DOWNLOAD_TOKEN 不能为 . 或 ..",
    );
  }
}

function parseSubscriptionUserinfo(
  header: string,
): { upload: number; download: number; total: number; expire: number } | null {
  if (!header || typeof header !== "string") return null;
  const result: Record<string, number> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
    const val = parseInt(trimmed.slice(eqIdx + 1).trim(), 10);
    if (!isNaN(val) && val >= 0) {
      result[key] = val;
    }
  }
  if (Object.keys(result).length === 0) return null;
  return {
    upload: result["upload"] ?? 0,
    download: result["download"] ?? 0,
    total: result["total"] ?? 0,
    expire: result["expire"] ?? 0,
  };
}

export function parseLegacyProfileUpdateIntervalHours(
  raw: string | undefined,
): number | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  if (!/^[1-9]\d*$/.test(raw.trim())) return undefined;
  const hours = Number(raw.trim());
  if (!Number.isSafeInteger(hours) || hours <= 0) return undefined;
  const minutes = hours * 60;
  if (!Number.isSafeInteger(minutes) || minutes > 153_722_867_280)
    return undefined;
  return minutes;
}

export function resolveClientUpdatePolicy(
  meta: ProviderVersionMeta,
): ClientUpdatePolicy {
  if (meta.distribution.clientUpdatePolicy) {
    return { ...meta.distribution.clientUpdatePolicy };
  }
  return {
    allowAutoUpdate: false,
    updateIntervalMinutes:
      parseLegacyProfileUpdateIntervalHours(
        meta.distribution.profileUpdateInterval,
      ) ?? 60,
  };
}

function parseCreatedAt(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    throw uerr(
      "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
      "Provider createdAt 不是有效 ISO 时间",
    );
  }
  return Math.floor(timestamp / 1000);
}

// --- Exact ZIP size pre-calculation ---

function estimateZipTotalSize(
  entries: { nameBytes: Uint8Array; dataLength: number }[],
): number {
  let total = 0;
  for (const e of entries) {
    total += 30 + e.nameBytes.length + e.dataLength; // local header + data
    total += 46 + e.nameBytes.length; // central directory header
  }
  total += 22; // EOCD
  return total;
}

// --- Main export function ---

interface ProviderPlanEntry {
  slug: string;
  pointer: LatestVersionPointer;
  meta: ProviderVersionMeta;
  profileUid: string;
  metaSize: number;
  providerSize: number;
  profileSize: number;
}

interface ProviderExportEntry {
  slug: string;
  bundle: ProviderBundle;
  profileUid: string;
}

export async function buildUnifiedExport(
  bucket: R2Bucket,
  env: Env,
  slug?: string,
  options?: { configUrl?: string },
): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  // 1. Validate configuration
  const publicBaseUrl = validatePublicBaseUrl(env);
  const downloadToken = env.DOWNLOAD_TOKEN;
  validateDownloadToken(downloadToken);

  // config.yaml is a non-authoritative Clash Verge compatibility artifact.
  // Subscription state lives exclusively in profiles.yaml + profiles/*.
  const configBytes = new TextEncoder().encode(MINIMAL_COMPAT_CONFIG_YAML);
  const configSha256 = await sha256HexBytes(configBytes);

  // 4. Pass 1: metadata planning — resolve pointers + meta without loading artifact bytes
  const resolveProviderMeta = async (s: string) => {
    try {
      return await storage.resolveProviderBundleMetadata(bucket, s);
    } catch (e) {
      if (e instanceof storage.PublicProviderError) {
        if (e.code === "CONFIG_NOT_FOUND") return null;
        if (e.code === "CONFIG_NOT_AVAILABLE") {
          throw uerr(
            "UNIFIED_EXPORT_PROVIDER_NOT_AVAILABLE",
            slug
              ? "当前 Provider 是 legacy 版本"
              : `Provider ${s} 是 legacy 版本`,
          );
        }
        throw uerr(
          "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
          slug ? "Provider 完整性验证失败" : `Provider ${s} 完整性验证失败`,
        );
      }
      throw uerr("UNIFIED_EXPORT_GENERATION_FAILED", `Provider ${s} 读取失败`);
    }
  };

  const providerPlans: ProviderPlanEntry[] = [];
  const uidMap = new Map<string, string>();
  const encoder = new TextEncoder();

  if (slug) {
    const md = await resolveProviderMeta(slug);
    if (!md)
      throw uerr("UNIFIED_EXPORT_PROVIDER_NOT_FOUND", "指定 Provider 不存在");
    // The persisted UID is authoritative. Never derive a replacement during export:
    // collision handling and identity migrations are publication-time concerns.
    const profileUid = md.pointer.uid;
    providerPlans.push({ slug, ...md, profileUid });
    uidMap.set(profileUid, slug);
  } else {
    const allSlugs = await storage.orderProviderSlugs(
      bucket,
      await storage.listSlugs(bucket),
    );
    for (const s of allSlugs) {
      const md = await resolveProviderMeta(s);
      if (!md) continue;
      const profileUid = md.pointer.uid;
      if (uidMap.has(profileUid)) {
        throw uerr(
          "UNIFIED_EXPORT_UID_CONFLICT",
          "UID 冲突: 两个不同 subscriptionId 产生相同 Profile UID",
        );
      }
      providerPlans.push({ slug: s, ...md, profileUid });
      uidMap.set(profileUid, s);
    }
    if (providerPlans.length === 0) {
      throw uerr(
        "UNIFIED_EXPORT_PROVIDERS_REQUIRED",
        "没有可导出的 V1 Provider",
      );
    }
  }

  // 5. Generate profiles.yaml to know its exact size
  const vergeBytes = encoder.encode("{}\n");
  const profilesYaml = buildProfilesYaml(
    providerPlans,
    publicBaseUrl,
    downloadToken,
    options?.configUrl,
  );
  const profilesBytes = encoder.encode(profilesYaml);

  // 6. Build a preliminary manifest to know its exact size
  const preliminaryManifest = buildManifestFromMetadata(
    configSha256,
    providerPlans,
    publicBaseUrl,
    configBytes,
    profilesBytes,
    vergeBytes,
  );
  const manifestBytes = encoder.encode(
    JSON.stringify(preliminaryManifest, null, 2),
  );

  // 7. Exact ZIP size pre-calculation using actual file sizes from metadata
  const zipPreEntries: { nameBytes: Uint8Array; dataLength: number }[] = [];
  const te = new TextEncoder();

  // Root files
  zipPreEntries.push({
    nameBytes: te.encode("config.yaml"),
    dataLength: configBytes.length,
  });
  zipPreEntries.push({
    nameBytes: te.encode("verge.yaml"),
    dataLength: vergeBytes.length,
  });
  zipPreEntries.push({
    nameBytes: te.encode("profiles.yaml"),
    dataLength: profilesBytes.length,
  });
  // profiles/ directory entry
  zipPreEntries.push({
    nameBytes: te.encode("profiles/"),
    dataLength: 0,
  });
  // Profile files (use metadata size — same content as profile.yaml in R2)
  for (const plan of providerPlans) {
    zipPreEntries.push({
      nameBytes: te.encode(`profiles/${plan.profileUid}.yaml`),
      dataLength: plan.profileSize,
    });
  }
  // Provider extension files
  for (const plan of providerPlans) {
    zipPreEntries.push({
      nameBytes: te.encode(`providers/${plan.slug}/provider.yaml`),
      dataLength: plan.providerSize,
    });
    zipPreEntries.push({
      nameBytes: te.encode(`providers/${plan.slug}/profile.yaml`),
      dataLength: plan.profileSize,
    });
    zipPreEntries.push({
      nameBytes: te.encode(`providers/${plan.slug}/meta.json`),
      dataLength: plan.metaSize,
    });
  }
  // manifest.json
  zipPreEntries.push({
    nameBytes: te.encode("manifest.json"),
    dataLength: manifestBytes.length,
  });

  const estimatedZipSize = estimateZipTotalSize(zipPreEntries);
  if (estimatedZipSize > MAX_UNIFIED_EXPORT_BYTES) {
    throw uerr("UNIFIED_EXPORT_TOO_LARGE", "ZIP 超过 20 MiB 限制");
  }

  // 8. Pass 2: load artifact bytes pinned to the exact versions from Phase 1
  const providerEntries: ProviderExportEntry[] = [];
  for (const plan of providerPlans) {
    let bundle: ProviderBundle;
    try {
      bundle = await storage.resolveProviderBundleAtVersion(
        bucket,
        plan.slug,
        plan.pointer,
      );
    } catch (e) {
      if (e instanceof storage.PublicProviderError) {
        throw uerr(
          "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
          `Provider ${plan.slug} 完整性验证失败`,
        );
      }
      throw uerr(
        "UNIFIED_EXPORT_GENERATION_FAILED",
        `Provider ${plan.slug} 读取失败`,
      );
    }
    providerEntries.push({
      slug: plan.slug,
      bundle,
      profileUid: plan.profileUid,
    });
  }

  // 9. Collect internal dependencies from all providers
  const dependencyBundles = new Map<
    string,
    {
      bundle: ProviderBundle;
      meta: ProviderVersionMeta;
    }
  >();
  const visibleEntries = new Map(providerEntries.map((e) => [e.slug, e]));

  for (const entry of providerEntries) {
    if (!hasNodeStats(entry.bundle.meta)) continue;
    const deps = entry.bundle.meta.internalDependencies;
    if (!deps) continue;
    for (const dep of deps) {
      // Check if dependency already resolved with different version
      const existing = dependencyBundles.get(dep.slug);
      if (existing) {
        // Verify same identity - reject if versions differ
        if (
          existing.meta.subscriptionId !== dep.subscriptionId ||
          existing.meta.uid !== dep.uid ||
          existing.meta.versionId !== dep.versionId ||
          existing.meta.artifacts.provider.sha256 !== dep.providerSha256 ||
          existing.meta.artifacts.profile.sha256 !== dep.profileSha256
        ) {
          throw uerr(
            "UNIFIED_EXPORT_UID_CONFLICT",
            `同一 Provider ${dep.slug} 被不同父配置锁定为不同版本，无法生成一致快照`,
          );
        }
        continue;
      }

      // If dependency is also a visible subscription, verify versions match
      // but do NOT add to dependencyBundles - it will be exported as visible only
      const visible = visibleEntries.get(dep.slug);
      if (visible) {
        const visMeta = visible.bundle.meta;
        if (
          visMeta.subscriptionId !== dep.subscriptionId ||
          visMeta.uid !== dep.uid ||
          visMeta.versionId !== dep.versionId ||
          visMeta.artifacts.provider.sha256 !== dep.providerSha256 ||
          visMeta.artifacts.profile.sha256 !== dep.profileSha256
        ) {
          throw uerr(
            "UNIFIED_EXPORT_UID_CONFLICT",
            `Provider ${dep.slug} 作为可见订阅和隐藏依赖的版本不一致`,
          );
        }
        // Versions match - skip, visible entry will be used directly
        continue;
      }

      // Resolve the dependency bundle using parent's recorded versionId
      let depBundle: ProviderBundle;
      try {
        depBundle = await storage.resolveProviderBundleByVersion(
          bucket,
          dep.slug,
          dep.versionId,
        );
        // Verify the resolved version matches what parent recorded
        if (
          depBundle.meta.subscriptionId !== dep.subscriptionId ||
          depBundle.meta.uid !== dep.uid ||
          depBundle.meta.versionId !== dep.versionId ||
          depBundle.meta.artifacts.provider.sha256 !== dep.providerSha256 ||
          depBundle.meta.artifacts.profile.sha256 !== dep.profileSha256
        ) {
          throw uerr(
            "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
            `依赖 Provider ${dep.slug} 版本与父配置记录不一致`,
          );
        }
        // Reject recursive dependencies (first version limitation)
        if (
          depBundle.meta.schemaVersion === 2 &&
          depBundle.meta.internalDependencies &&
          depBundle.meta.internalDependencies.length > 0
        ) {
          throw uerr(
            "UNIFIED_EXPORT_PROVIDER_NOT_AVAILABLE",
            `依赖 ${dep.slug} 包含递归依赖，当前版本不支持`,
          );
        }
      } catch (e) {
        if (e instanceof UnifiedExportError) throw e;
        if (e instanceof storage.PublicProviderError) {
          throw uerr(
            "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
            `依赖 Provider ${dep.slug} 完整性验证失败`,
          );
        }
        throw uerr(
          "UNIFIED_EXPORT_GENERATION_FAILED",
          `依赖 Provider ${dep.slug} 读取失败`,
        );
      }
      dependencyBundles.set(dep.slug, {
        bundle: depBundle,
        meta: depBundle.meta,
      });
    }
  }

  // 10. Build final ZIP entries
  const zipEntries: { path: string; data: Uint8Array }[] = [];
  zipEntries.push({ path: "config.yaml", data: configBytes });
  zipEntries.push({ path: "verge.yaml", data: vergeBytes });
  zipEntries.push({ path: "profiles.yaml", data: profilesBytes });
  zipEntries.push({ path: "profiles/", data: new Uint8Array(0) });
  for (const entry of providerEntries) {
    zipEntries.push({
      path: `profiles/${entry.profileUid}.yaml`,
      data: entry.bundle.profileBytes,
    });
  }
  for (const entry of providerEntries) {
    zipEntries.push({
      path: `providers/${entry.slug}/provider.yaml`,
      data: entry.bundle.providerBytes,
    });
    zipEntries.push({
      path: `providers/${entry.slug}/profile.yaml`,
      data: entry.bundle.profileBytes,
    });
    zipEntries.push({
      path: `providers/${entry.slug}/meta.json`,
      data: entry.bundle.metaBytes,
    });
  }
  // Add dependency files
  for (const [depSlug, depData] of dependencyBundles) {
    // Read actual raw bytes from R2
    const rawKey = depData.meta.artifacts.raw.key;
    const rawObj = await bucket.get(rawKey);
    if (!rawObj) {
      throw uerr(
        "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
        `依赖 Provider ${depSlug} 的 raw artifact 缺失`,
      );
    }
    const rawBytes = new Uint8Array(await rawObj.arrayBuffer());
    if (
      rawBytes.length !== depData.meta.artifacts.raw.contentLength ||
      (await sha256HexBytes(rawBytes)) !== depData.meta.artifacts.raw.sha256
    ) {
      throw uerr(
        "UNIFIED_EXPORT_PROVIDER_CORRUPTED",
        `依赖 Provider ${depSlug} 的 raw artifact 完整性校验失败`,
      );
    }
    zipEntries.push({
      path: `dependencies/${depSlug}/raw.yaml`,
      data: rawBytes,
    });
    zipEntries.push({
      path: `dependencies/${depSlug}/provider.yaml`,
      data: depData.bundle.providerBytes,
    });
    zipEntries.push({
      path: `dependencies/${depSlug}/profile.yaml`,
      data: depData.bundle.profileBytes,
    });
    zipEntries.push({
      path: `dependencies/${depSlug}/meta.json`,
      data: depData.bundle.metaBytes,
    });
  }
  zipEntries.sort((a, b) => a.path.localeCompare(b.path));

  // 11. Pre-compute ZIP, build final manifest, add manifest.json, re-compute
  const precomputed = await precomputeZip(zipEntries);
  const manifest = buildManifest(
    configSha256,
    providerEntries,
    dependencyBundles,
    precomputed.fileSha256s,
    precomputed.fileSizes,
    publicBaseUrl,
  );
  const finalManifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  zipEntries.push({ path: "manifest.json", data: finalManifestBytes });
  zipEntries.sort((a, b) => a.path.localeCompare(b.path));
  const finalPrecomputed = await precomputeZip(zipEntries);

  // 12. Final exact size check
  if (finalPrecomputed.totalSize > MAX_UNIFIED_EXPORT_BYTES) {
    throw uerr("UNIFIED_EXPORT_TOO_LARGE", "ZIP 超过 20 MiB 限制");
  }

  return {
    stream: streamZip(finalPrecomputed),
    size: finalPrecomputed.totalSize,
  };
}

// --- profiles.yaml builder ---

function buildProfilesYaml(
  entries: ProviderPlanEntry[],
  publicBaseUrl: string,
  downloadToken: string,
  singleConfigUrl?: string,
): string {
  if (singleConfigUrl !== undefined && entries.length !== 1) {
    throw uerr(
      "UNIFIED_EXPORT_GENERATION_FAILED",
      "固定订阅 URL 只能用于单 Provider 导出",
    );
  }
  const current = entries[0]!.profileUid;
  const items = entries.map((e) => {
    const createdAtUnix = parseCreatedAt(e.meta.createdAt);
    const clientUpdatePolicy = resolveClientUpdatePolicy(e.meta);
    const item: Record<string, unknown> = {
      uid: e.profileUid,
      type: "remote",
      name: e.meta.distribution.providerName,
      file: `${e.profileUid}.yaml`,
      url:
        singleConfigUrl ?? `${publicBaseUrl}/config/${e.slug}/${downloadToken}`,
      updated: createdAtUnix,
      option: {
        allow_auto_update: clientUpdatePolicy.allowAutoUpdate,
        update_interval: clientUpdatePolicy.updateIntervalMinutes,
      },
    };

    const userinfo = parseSubscriptionUserinfo(
      e.meta.distribution.subscriptionUserinfo ?? "",
    );
    if (userinfo) {
      item.extra = {
        upload: userinfo.upload,
        download: userinfo.download,
        total: userinfo.total,
        expire: userinfo.expire,
      };
    }

    return item;
  });

  return jsYaml.dump({ current, items }, { lineWidth: -1 });
}

// --- Manifest builder from metadata (for pre-check) ---

function buildManifestFromMetadata(
  configSha256: string,
  providerPlans: ProviderPlanEntry[],
  publicBaseUrl: string,
  configBytes: Uint8Array,
  profilesBytes: Uint8Array,
  vergeBytes: Uint8Array,
): UnifiedManifest {
  const now = new Date().toISOString();
  const files: Record<
    string,
    { sha256: string; contentLength: number; required: boolean }
  > = {};

  // For pre-check, use placeholder SHA-256 (will be recomputed for final manifest)
  // But we need actual sizes — use what we have
  files["config.yaml"] = {
    sha256: "0".repeat(64),
    contentLength: configBytes.length,
    required: true,
  };
  files["verge.yaml"] = {
    sha256: "0".repeat(64),
    contentLength: vergeBytes.length,
    required: true,
  };
  files["profiles.yaml"] = {
    sha256: "0".repeat(64),
    contentLength: profilesBytes.length,
    required: true,
  };

  for (const plan of providerPlans) {
    files[`profiles/${plan.profileUid}.yaml`] = {
      sha256: "0".repeat(64),
      contentLength: plan.profileSize,
      required: true,
    };
    files[`providers/${plan.slug}/provider.yaml`] = {
      sha256: "0".repeat(64),
      contentLength: plan.providerSize,
      required: false,
    };
    files[`providers/${plan.slug}/profile.yaml`] = {
      sha256: "0".repeat(64),
      contentLength: plan.profileSize,
      required: false,
    };
    files[`providers/${plan.slug}/meta.json`] = {
      sha256: "0".repeat(64),
      contentLength: plan.metaSize,
      required: false,
    };
  }

  return {
    format: "mihomo-unified-backup",
    formatVersion: 1,
    archiveType: "unified-subscription-archive",
    createdAt: now,
    generator: "worker",
    generatorVersion: "1.0.0",
    publicBaseUrl,
    mainConfig: {
      configId: "system-minimal-compat",
      versionId: `sha256-${configSha256.slice(0, 16)}`,
      name: "Clash Verge compatibility config",
      sourceSha256: configSha256,
    },
    airports: providerPlans.map((e) => ({
      slug: e.slug,
      subscriptionId: e.pointer.subscriptionId,
      name: e.meta.distribution.providerName,
      profileUid: e.profileUid,
      versionId: e.pointer.versionId,
      nodeCount: e.meta.nodeCount,
      providerSha256: e.meta.artifacts.provider.sha256,
      profileSha256: e.meta.artifacts.profile.sha256,
      ...(hasNodeStats(e.meta) && { nodeStats: e.meta.nodeStats }),
    })),
    files,
  };
}

// --- Final manifest builder (with real SHA-256s) ---

function buildManifest(
  configSha256: string,
  providerEntries: ProviderExportEntry[],
  dependencyBundles: Map<
    string,
    { bundle: ProviderBundle; meta: ProviderVersionMeta }
  >,
  fileSha256s: Map<string, number | string>,
  fileSizes: Map<string, number>,
  publicBaseUrl: string,
): UnifiedManifest {
  const now = new Date().toISOString();
  const REQUIRED_ROOT = new Set(["config.yaml", "verge.yaml", "profiles.yaml"]);

  const mainConfig: UnifiedManifest["mainConfig"] = {
    configId: "system-minimal-compat",
    versionId: `sha256-${configSha256.slice(0, 16)}`,
    name: "Clash Verge compatibility config",
    sourceSha256: configSha256,
  };

  const airports: UnifiedManifestAirport[] = providerEntries.map((e) => ({
    slug: e.slug,
    subscriptionId: e.bundle.pointer.subscriptionId,
    name: e.bundle.meta.distribution.providerName,
    profileUid: e.profileUid,
    versionId: e.bundle.pointer.versionId,
    nodeCount: e.bundle.meta.nodeCount,
    providerSha256: e.bundle.meta.artifacts.provider.sha256,
    profileSha256: e.bundle.meta.artifacts.profile.sha256,
    ...(hasNodeStats(e.bundle.meta) && { nodeStats: e.bundle.meta.nodeStats }),
  }));

  // Build dependencies array
  const dependencies: UnifiedManifestDependency[] = [];
  for (const [depSlug, depData] of dependencyBundles) {
    dependencies.push({
      slug: depSlug,
      subscriptionId: depData.meta.subscriptionId,
      uid: depData.meta.uid,
      versionId: depData.meta.versionId,
      nodeCount: depData.meta.nodeCount,
      providerSha256: depData.meta.artifacts.provider.sha256,
      profileSha256: depData.meta.artifacts.profile.sha256,
    });
  }

  const files: Record<
    string,
    { sha256: string; contentLength: number; required: boolean }
  > = {};
  for (const [path, sha] of fileSha256s.entries()) {
    if (path === "manifest.json") continue;
    if (path.endsWith("/")) continue;
    const size = fileSizes.get(path);
    if (size === undefined) continue;
    const shaStr = typeof sha === "string" ? sha : String(sha);
    const isRequired =
      REQUIRED_ROOT.has(path) ||
      path.startsWith("profiles/") ||
      path.startsWith("dependencies/");
    files[path] = {
      sha256: shaStr,
      contentLength: size,
      required: isRequired,
    };
  }

  return {
    format: "mihomo-unified-backup",
    formatVersion: dependencyBundles.size > 0 ? 2 : 1,
    archiveType: "unified-subscription-archive",
    createdAt: now,
    generator: "worker",
    generatorVersion: "1.0.0",
    publicBaseUrl,
    mainConfig,
    airports,
    files,
    ...(dependencyBundles.size > 0 && {
      dependencySlugs: [...dependencyBundles.keys()].sort(),
      dependencies,
    }),
  };
}
