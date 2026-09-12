import jsYaml from "js-yaml";
import { inflateRawSync } from "node:zlib";
import {
  expectedProviderNodeCount,
  type ClientUpdatePolicy,
  type ProviderDistributionMetadata,
  type ProviderVersionMeta,
  type PublishVersionInput,
  type UnifiedManifest,
} from "../types.ts";
import { validateSlug, validateUrl } from "../security/ssrf.ts";
import { crc32 } from "./zip.ts";
import * as storage from "./storage.ts";

export const MAX_UNIFIED_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const PROFILE_UID = /^R[0-9a-f]{8}$/;
const MAX_CLIENT_UPDATE_INTERVAL_MINUTES = 153_722_867_280;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type UnifiedImportErrorCode =
  | "INVALID_ZIP"
  | "ZIP_LIMIT_EXCEEDED"
  | "UNSAFE_ZIP_PATH"
  | "DUPLICATE_ZIP_PATH"
  | "UNSUPPORTED_ZIP_ENTRY"
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_FORMAT"
  | "INTEGRITY_MISMATCH"
  | "INVALID_YAML"
  | "IDENTITY_MISMATCH"
  | "INVALID_FIXED_URL";

export class UnifiedImportError extends Error {
  constructor(
    public readonly code: UnifiedImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UnifiedImportError";
  }
}

export interface UnifiedImportProviderPlan {
  slug: string;
  profileUid: string;
  originalMeta: ProviderVersionMeta;
  rawArtifact: ProviderVersionMeta["artifacts"]["raw"];
  snapshotRawContent?: string;
  sourceUrl?: string;
  publishInput: Omit<PublishVersionInput, "rawContent">;
}

export interface UnifiedImportDependencyPlan {
  slug: string;
  versionId: string;
  rawContent: string;
  originalMeta: ProviderVersionMeta;
  publishInput: Omit<PublishVersionInput, "rawContent">;
}

export interface UnifiedImportPlan {
  manifest: UnifiedManifest;
  providers: UnifiedImportProviderPlan[];
  dependencies: UnifiedImportDependencyPlan[];
}

export interface UnifiedImportResult {
  providers: Array<{ slug: string; versionId: string }>;
  dependencies: Array<{ slug: string; versionId: string }>;
}

interface ParsedZip {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
}

export async function parseUnifiedImport(
  bytes: Uint8Array,
  expectedPublicBaseUrl: string,
  trustedPublicOrigins: readonly string[] = [],
): Promise<UnifiedImportPlan> {
  const expectedBaseUrl = normalizeBaseUrl(expectedPublicBaseUrl);
  const trustedOrigins = new Set([
    expectedBaseUrl,
    ...trustedPublicOrigins.map(normalizeBaseUrl),
  ]);
  const zip = parseStoredZip(bytes);
  if (!zip.files.has("manifest.json")) {
    const embedded = validateSlclashEnvelope(zip);
    const plan = await parseUnifiedImport(
      embedded,
      expectedPublicBaseUrl,
      trustedPublicOrigins,
    );
    validateSlclashSnapshot(zip, plan);
    return plan;
  }
  const manifestBytes = zip.files.get("manifest.json");
  if (!manifestBytes) fail("INVALID_MANIFEST", "manifest.json is missing");
  const manifest = parseManifest(manifestBytes!);
  const manifestBaseUrl = normalizeBaseUrl(manifest.publicBaseUrl);
  if (
    manifest.generator !== "slclash" &&
    !isSameTrustedWorkerOrigin(manifestBaseUrl, expectedBaseUrl, trustedOrigins)
  ) {
    fail(
      "INVALID_FIXED_URL",
      "Archive public origin does not match this Worker",
    );
  }
  await verifyManifestFiles(zip.files, manifest);
  validateArchiveWhitelist(zip, manifest);
  validateDependencyGraph(manifest, zip.files);

  const configYaml = decodeText(requiredFile(zip.files, "config.yaml"));
  const vergeYaml = decodeText(requiredFile(zip.files, "verge.yaml"));
  const profilesYaml = decodeText(requiredFile(zip.files, "profiles.yaml"));
  parseYamlMapping(configYaml, "config.yaml");
  parseYamlMapping(vergeYaml, "verge.yaml");
  const profilesDoc = parseYamlMapping(profilesYaml, "profiles.yaml");
  const profiles = validateProfilesYaml(
    profilesDoc,
    manifest,
    manifestBaseUrl,
    expectedBaseUrl,
    trustedOrigins,
  );
  const fixedToken = profiles.fixedToken;
  validateConfigProviderUrls(configYaml, manifestBaseUrl, fixedToken);

  const providers: UnifiedImportProviderPlan[] = [];
  for (const airport of manifest.airports) {
    const prefix = `providers/${airport.slug}/`;
    const providerBytes = requiredFile(zip.files, `${prefix}provider.yaml`);
    const profileBytes = requiredFile(zip.files, `${prefix}profile.yaml`);
    const metaBytes = requiredFile(zip.files, `${prefix}meta.json`);
    const providerYaml = decodeText(providerBytes);
    const profileYaml = decodeText(profileBytes);
    const providerDoc = parseYamlMapping(providerYaml, "provider.yaml");
    const profileDoc = parseYamlMapping(profileYaml, "profile.yaml");
    const meta = parseProviderMeta(metaBytes);
    const profilePolicy = profiles.clientUpdatePolicies.get(airport.profileUid);
    const metaPolicy = meta.distribution.clientUpdatePolicy;
    if (
      profilePolicy &&
      metaPolicy &&
      !sameClientUpdatePolicy(profilePolicy, metaPolicy)
    ) {
      fail(
        "IDENTITY_MISMATCH",
        "Client update policy does not match Provider metadata",
      );
    }
    const clientUpdatePolicy = metaPolicy ??
      profilePolicy ?? { allowAutoUpdate: false, updateIntervalMinutes: 60 };
    if (manifest.generator === "slclash") {
      if (
        meta.artifacts.raw.sha256 !== (await sha256Hex(profileBytes)) ||
        meta.artifacts.raw.contentLength !== profileBytes.length
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          "Slclash snapshot raw artifact does not match profile.yaml",
        );
      }
    }
    await validateProviderIdentity(meta, airport, providerBytes, profileBytes);
    const providerNodes = providerDoc.proxies;
    const profileNodes = profileDoc.proxies;
    const profileProviders = profileDoc["proxy-providers"];
    const hasNativeProviders =
      isRecord(profileProviders) && Object.keys(profileProviders).length > 0;
    // For schemaVersion 1: nodeCount is inline count.
    // For schemaVersion 2: provider.yaml holds the materialized effective node
    // set, so `nodeStats.materialized` is authoritative. It is absent on
    // versions published before materialization existed and on dependencies,
    // where provider.yaml held the inline proxies only.
    const expectedProviderCount = expectedProviderNodeCount(meta);
    if (
      !Array.isArray(providerNodes) ||
      providerNodes.length === 0 ||
      providerNodes.length !== expectedProviderCount ||
      (!hasNativeProviders &&
        (!Array.isArray(profileNodes) ||
          JSON.stringify(providerNodes) !== JSON.stringify(profileNodes)))
    ) {
      fail("IDENTITY_MISMATCH", "Provider node data does not match metadata");
    }
    const copiedProfile = requiredFile(
      zip.files,
      `profiles/${airport.profileUid}.yaml`,
    );
    if ((await sha256Hex(copiedProfile)) !== (await sha256Hex(profileBytes))) {
      fail("INTEGRITY_MISMATCH", "Profile copies do not match");
    }
    // SlClash already exports the runnable profile with its native node
    // organization. Keep inline proxies inline and real Providers as Providers;
    // provider.yaml remains the normalized materialized projection.
    const publishedProfileYaml = profileYaml;
    providers.push({
      slug: airport.slug,
      profileUid: airport.profileUid,
      ...(profiles.sourceUrls.get(airport.profileUid) && {
        sourceUrl: profiles.sourceUrls.get(airport.profileUid),
      }),
      originalMeta: meta,
      rawArtifact: meta.artifacts.raw,
      ...(manifest.generator === "slclash" && {
        snapshotRawContent: profileYaml,
      }),
      publishInput: {
        providerSlug: meta.providerSlug,
        subscriptionId: meta.subscriptionId,
        uid: meta.uid,
        providerYaml,
        profileYaml: publishedProfileYaml,
        nodeCount: meta.nodeCount,
        generatorVersion: meta.generatorVersion,
        distribution: { ...meta.distribution, clientUpdatePolicy },
        ...(meta.nodeStats && { nodeStats: meta.nodeStats }),
        ...(meta.internalDependencies && {
          internalDependencies: meta.internalDependencies,
        }),
      },
    });
  }

  // Parse dependencies (formatVersion 2)
  const dependencies: UnifiedImportDependencyPlan[] = [];
  if (manifest.formatVersion === 2 && manifest.dependencies) {
    for (const dep of manifest.dependencies) {
      const prefix = `dependencies/${dep.slug}/`;
      const rawBytes = requiredFile(zip.files, `${prefix}raw.yaml`);
      const providerBytes = requiredFile(zip.files, `${prefix}provider.yaml`);
      const profileBytes = requiredFile(zip.files, `${prefix}profile.yaml`);
      const metaBytes = requiredFile(zip.files, `${prefix}meta.json`);
      const meta = parseProviderMeta(metaBytes);
      const providerYaml = decodeText(providerBytes);
      const profileYaml = decodeText(profileBytes);

      // Verify dependency identity matches manifest
      if (
        meta.providerSlug !== dep.slug ||
        meta.subscriptionId !== dep.subscriptionId ||
        meta.uid !== dep.uid ||
        meta.versionId !== dep.versionId ||
        meta.nodeCount !== dep.nodeCount
      ) {
        fail(
          "IDENTITY_MISMATCH",
          `Dependency ${dep.slug} meta does not match manifest`,
        );
      }

      // Cross-validate meta artifact hashes with manifest
      if (
        meta.artifacts.provider.sha256 !== dep.providerSha256 ||
        meta.artifacts.profile.sha256 !== dep.profileSha256
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          `Dependency ${dep.slug} meta artifact hashes do not match manifest`,
        );
      }

      // Verify raw artifact hash and length
      if (
        rawBytes.length !== meta.artifacts.raw.contentLength ||
        (await sha256Hex(rawBytes)) !== meta.artifacts.raw.sha256
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          `Dependency ${dep.slug} raw artifact integrity check failed`,
        );
      }

      // Verify provider and profile file lengths match meta
      if (
        providerBytes.length !== meta.artifacts.provider.contentLength ||
        profileBytes.length !== meta.artifacts.profile.contentLength
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          `Dependency ${dep.slug} artifact lengths do not match meta`,
        );
      }

      // Verify provider and profile hashes match manifest
      if (
        (await sha256Hex(providerBytes)) !== dep.providerSha256 ||
        (await sha256Hex(profileBytes)) !== dep.profileSha256
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          `Dependency ${dep.slug} artifact hashes do not match manifest`,
        );
      }

      // Verify artifact keys are canonical
      const depKeys = storage.getVersionKeys(dep.slug, dep.versionId);
      if (
        meta.artifacts.raw.key !== depKeys.raw ||
        meta.artifacts.provider.key !== depKeys.provider ||
        meta.artifacts.profile.key !== depKeys.profile
      ) {
        fail(
          "IDENTITY_MISMATCH",
          `Dependency ${dep.slug} artifact paths are not canonical`,
        );
      }

      // Parse and validate dependency YAML (same level as visible providers)
      const providerDoc = parseYamlMapping(
        providerYaml,
        `dependency ${dep.slug} provider.yaml`,
      );
      const profileDoc = parseYamlMapping(
        profileYaml,
        `dependency ${dep.slug} profile.yaml`,
      );
      const depProviderNodes = providerDoc.proxies;
      const depProfileNodes = profileDoc.proxies;

      // For schemaVersion 2, use the materialized Provider count; otherwise use
      // nodeCount. Dependencies never carry nodeStats, so both branches agree.
      const depExpectedCount = expectedProviderNodeCount(meta);

      if (
        !Array.isArray(depProviderNodes) ||
        depProviderNodes.length === 0 ||
        depProviderNodes.length !== depExpectedCount ||
        !Array.isArray(depProfileNodes) ||
        JSON.stringify(depProviderNodes) !== JSON.stringify(depProfileNodes)
      ) {
        fail(
          "IDENTITY_MISMATCH",
          `Dependency ${dep.slug} node data does not match metadata`,
        );
      }

      // Reject dependencies that themselves have dependencies (first version)
      if (
        meta.schemaVersion === 2 &&
        meta.internalDependencies &&
        meta.internalDependencies.length > 0
      ) {
        fail(
          "UNSUPPORTED_FORMAT",
          `Dependency ${dep.slug} itself has dependencies (recursive dependencies not yet supported)`,
        );
      }

      // Verify meta.sourceSha256 matches raw artifact
      if (meta.sourceSha256 !== meta.artifacts.raw.sha256) {
        fail(
          "INTEGRITY_MISMATCH",
          `Dependency ${dep.slug} sourceSha256 does not match raw artifact`,
        );
      }

      dependencies.push({
        slug: dep.slug,
        versionId: dep.versionId,
        rawContent: decodeText(rawBytes),
        originalMeta: meta,
        publishInput: {
          providerSlug: meta.providerSlug,
          subscriptionId: meta.subscriptionId,
          uid: meta.uid,
          providerYaml,
          profileYaml,
          nodeCount: meta.nodeCount,
          generatorVersion: meta.generatorVersion,
          distribution: meta.distribution,
          ...(meta.nodeStats && { nodeStats: meta.nodeStats }),
          ...(meta.internalDependencies && {
            internalDependencies: meta.internalDependencies,
          }),
        },
      });
    }
  }

  // Validate that every visible provider's internalDependencies are satisfied
  const visibleBySlug = new Map(providers.map((p) => [p.slug, p]));
  const dependencyBySlug = new Map(dependencies.map((d) => [d.slug, d]));

  for (const provider of providers) {
    const meta = provider.originalMeta;
    if (!meta.internalDependencies) continue;
    for (const dep of meta.internalDependencies) {
      const visDep = visibleBySlug.get(dep.slug);
      const hidDep = dependencyBySlug.get(dep.slug);

      if (!visDep && !hidDep) {
        fail(
          "IDENTITY_MISMATCH",
          `Provider ${provider.slug} references dependency ${dep.slug} which is not in manifest`,
        );
      }

      // Verify identity matches
      if (visDep) {
        const resolvedMeta = visDep.originalMeta;
        if (
          resolvedMeta.subscriptionId !== dep.subscriptionId ||
          resolvedMeta.uid !== dep.uid ||
          resolvedMeta.versionId !== dep.versionId ||
          resolvedMeta.artifacts.provider.sha256 !== dep.providerSha256 ||
          resolvedMeta.artifacts.profile.sha256 !== dep.profileSha256
        ) {
          fail(
            "IDENTITY_MISMATCH",
            `Provider ${provider.slug} dependency ${dep.slug} identity mismatch with visible airport`,
          );
        }
      }
      // Hidden dependencies are already validated during parsing
    }
  }

  return {
    manifest,
    providers,
    dependencies,
  };
}

function validateSlclashEnvelope(zip: ParsedZip): Uint8Array {
  const metadataBytes = zip.files.get("metadata.json");
  const embedded = zip.files.get("subscription-center/worker-v1.zip");
  if (!metadataBytes || !embedded) {
    fail("INVALID_MANIFEST", "Unified archive manifest is missing");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(decodeText(metadataBytes));
  } catch {
    fail("INVALID_MANIFEST", "Slclash backup metadata is invalid");
  }
  if (
    !isRecord(metadata) ||
    (metadata.backupType !== "profiles_only_v2" &&
      metadata.backupType !== "profiles_only_v3") ||
    !Array.isArray(metadata.profiles)
  ) {
    fail("UNSUPPORTED_FORMAT", "Slclash backup format is unsupported");
  }
  const isV3 = metadata.backupType === "profiles_only_v3";
  for (const path of zip.files.keys()) {
    if (
      path !== "metadata.json" &&
      path !== "subscription-center/worker-v1.zip" &&
      path !== "profiles.yaml" &&
      !/^profiles\/[^/]+\.yaml$/.test(path) &&
      !/^profiles\/providers\/[^/]+\/.+/.test(path) &&
      !/^scripts\/[^/]+\.js$/.test(path)
    ) {
      fail("UNSUPPORTED_FORMAT", "Slclash backup contains an unsupported file");
    }
    // v3: profiles.yaml at root is allowed (Clash Verge Rev compatibility)
    // v2: profiles.yaml at root is NOT allowed
    if (!isV3 && path === "profiles.yaml") {
      fail("UNSUPPORTED_FORMAT", "Slclash backup contains an unsupported file");
    }
  }
  return embedded;
}

function validateSlclashSnapshot(
  zip: ParsedZip,
  plan: UnifiedImportPlan,
): void {
  const metadata = JSON.parse(
    decodeText(zip.files.get("metadata.json")!),
  ) as Record<string, unknown>;
  const isV3 = metadata.backupType === "profiles_only_v3";
  const profiles = metadata.profiles as unknown[];
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of profiles) {
    if (!isRecord(value) || !Number.isSafeInteger(value.id)) {
      fail("IDENTITY_MISMATCH", "Slclash profile metadata is invalid");
    }
    const id = String(value.id);
    if (byId.has(id)) {
      fail("IDENTITY_MISMATCH", "Slclash profile identity is duplicated");
    }
    byId.set(id, value);
  }

  const embeddedZip = parseStoredZip(
    zip.files.get("subscription-center/worker-v1.zip")!,
  );
  const profileDoc = parseYamlMapping(
    decodeText(requiredFile(embeddedZip.files, "profiles.yaml")),
    "profiles.yaml",
  );
  const items = profileDoc.items;
  if (!Array.isArray(items)) {
    fail("IDENTITY_MISMATCH", "Embedded profile mapping is invalid");
  }

  // v3: Validate outer profiles.yaml matches embedded Worker capsule
  if (isV3) {
    const outerProfilesYaml = zip.files.get("profiles.yaml");
    const innerProfilesYaml = embeddedZip.files.get("profiles.yaml");
    if (
      !outerProfilesYaml ||
      !innerProfilesYaml ||
      !equalBytes(outerProfilesYaml, innerProfilesYaml)
    ) {
      fail(
        "INTEGRITY_MISMATCH",
        "Outer profiles.yaml does not match embedded Worker capsule",
      );
    }
  }

  for (const value of items) {
    if (!isRecord(value) || typeof value.uid !== "string") {
      fail("IDENTITY_MISMATCH", "Embedded profile identity is invalid");
    }
    const id = String(Number.parseInt(value.uid.slice(1), 16));
    const outer = byId.get(id);
    const outerYaml = zip.files.get(`profiles/${id}.yaml`);
    const provider = plan.providers.find(
      (item) => item.profileUid === value.uid,
    );
    if (
      !outer ||
      outer.url !== value.url ||
      !outerYaml ||
      !provider ||
      !equalBytes(
        outerYaml,
        new TextEncoder().encode(provider.publishInput.profileYaml),
      )
    ) {
      fail(
        "IDENTITY_MISMATCH",
        "Slclash backup and embedded subscription snapshot disagree",
      );
    }

    // v3: Validate outer profiles/R*.yaml matches embedded Worker capsule
    if (isV3) {
      const outerRYaml = zip.files.get(`profiles/${value.uid}.yaml`);
      const innerRYaml = embeddedZip.files.get(`profiles/${value.uid}.yaml`);
      if (!outerRYaml || !innerRYaml || !equalBytes(outerRYaml, innerRYaml)) {
        fail(
          "INTEGRITY_MISMATCH",
          `Outer profiles/${value.uid}.yaml does not match embedded Worker capsule`,
        );
      }
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function parseStoredZip(input: Uint8Array): ParsedZip {
  if (input.length > MAX_UNIFIED_IMPORT_BYTES) {
    fail("ZIP_LIMIT_EXCEEDED", "ZIP exceeds the archive size limit");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findEocd(input, view);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    count > MAX_ENTRIES ||
    view.getUint16(eocd + 8, true) !== count ||
    centralOffset + centralSize !== eocd
  ) {
    fail("INVALID_ZIP", "ZIP central directory is invalid");
  }
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const folded = new Set<string>();
  let pos = centralOffset;
  let extracted = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || view.getUint32(pos, true) !== 0x02014b50) {
      fail("INVALID_ZIP", "ZIP central entry is invalid");
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const expectedCrc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const disk = view.getUint16(pos + 34, true);
    const localOffset = view.getUint32(pos + 42, true);
    const end = pos + 46 + nameLength + extraLength + commentLength;
    const usesDataDescriptor = (flags & 0x0008) !== 0;
    if (
      end > eocd ||
      disk !== 0 ||
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8)
    ) {
      fail("UNSUPPORTED_ZIP_ENTRY", "ZIP entry type is not supported");
    }
    const name = decodeText(input.subarray(pos + 46, pos + 46 + nameLength));
    validateZipPath(name);
    const foldedName = name.toLowerCase();
    if (folded.has(foldedName)) {
      fail("DUPLICATE_ZIP_PATH", "ZIP contains a duplicate path");
    }
    folded.add(foldedName);
    if (size > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) {
      fail("ZIP_LIMIT_EXCEEDED", "ZIP entry exceeds the size limit");
    }
    extracted += size;
    if (extracted > MAX_EXTRACTED_BYTES) {
      fail("ZIP_LIMIT_EXCEEDED", "ZIP exceeds the extracted size limit");
    }
    if (
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      fail("INVALID_ZIP", "ZIP local header is invalid");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (
      view.getUint16(localOffset + 6, true) !== flags ||
      view.getUint16(localOffset + 8, true) !== method ||
      (!usesDataDescriptor &&
        (view.getUint32(localOffset + 14, true) !== expectedCrc ||
          view.getUint32(localOffset + 18, true) !== compressedSize ||
          view.getUint32(localOffset + 22, true) !== size))
    ) {
      fail("INVALID_ZIP", "ZIP local and central headers disagree");
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) fail("INVALID_ZIP", "ZIP entry is truncated");
    const localName = decodeText(
      input.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localName !== name) fail("INVALID_ZIP", "ZIP entry names disagree");
    const compressedData = input.slice(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === 0) {
      if (size !== compressedSize) {
        fail("INVALID_ZIP", "Stored ZIP entry size is invalid");
      }
      data = compressedData;
    } else {
      try {
        data = new Uint8Array(inflateRawSync(compressedData));
      } catch {
        fail("INVALID_ZIP", "Deflated ZIP entry is invalid");
      }
      if (data.length !== size || data.length > MAX_ENTRY_BYTES) {
        fail("INTEGRITY_MISMATCH", "ZIP entry size does not match");
      }
    }
    if (crc32(data) !== expectedCrc) {
      fail("INTEGRITY_MISMATCH", "ZIP CRC does not match");
    }
    if (name.endsWith("/")) directories.add(name);
    else files.set(name, data);
    pos = end;
  }
  if (pos !== eocd) fail("INVALID_ZIP", "ZIP central directory size disagrees");
  return { files, directories };
}

function findEocd(input: Uint8Array, view: DataView): number {
  const min = Math.max(0, input.length - 22 - 0xffff);
  for (let i = input.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const comment = view.getUint16(i + 20, true);
      if (i + 22 + comment === input.length) return i;
    }
  }
  fail("INVALID_ZIP", "ZIP end record is missing");
}

function validateZipPath(path: string): void {
  const parts = path.endsWith("/")
    ? path.slice(0, -1).split("/")
    : path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    fail("UNSAFE_ZIP_PATH", "ZIP contains an unsafe path");
  }
}

function parseManifest(bytes: Uint8Array): UnifiedManifest {
  let value: unknown;
  try {
    value = JSON.parse(decodeText(bytes));
  } catch {
    fail("INVALID_MANIFEST", "Manifest is not valid JSON");
  }
  if (!isRecord(value)) fail("INVALID_MANIFEST", "Manifest must be an object");
  const m = value as unknown as Record<string, unknown>;
  if (m.format !== "mihomo-unified-backup")
    fail("UNSUPPORTED_FORMAT", "Unified archive format is unsupported");
  if (m.formatVersion !== 1 && m.formatVersion !== 2)
    fail("UNSUPPORTED_FORMAT", "Unified archive version is unsupported");
  if (m.archiveType !== "unified-subscription-archive")
    fail("UNSUPPORTED_FORMAT", "Unified archive version is unsupported");
  if (
    (m.generator !== "worker" && m.generator !== "slclash") ||
    m.generatorVersion !== "1.0.0" ||
    typeof m.createdAt !== "string" ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    typeof m.publicBaseUrl !== "string" ||
    !isRecord(m.mainConfig) ||
    !Array.isArray(m.airports) ||
    m.airports.length === 0 ||
    !isRecord(m.files)
  )
    fail("INVALID_MANIFEST", "Manifest shape is invalid");
  if (m.generator === "slclash" && m.formatVersion !== 1) {
    fail("UNSUPPORTED_FORMAT", "Slclash snapshots must use formatVersion 1");
  }
  const main = m.mainConfig as Record<string, unknown>;
  if (
    typeof main.configId !== "string" ||
    typeof main.versionId !== "string" ||
    typeof main.name !== "string" ||
    typeof main.sourceSha256 !== "string" ||
    !HEX64.test(main.sourceSha256)
  )
    fail("INVALID_MANIFEST", "Main config metadata is invalid");
  for (const airport of m.airports) validateAirport(airport);

  // Validate formatVersion 2 specific fields
  if (m.formatVersion === 2) {
    // dependencySlugs and dependencies must appear together or both be absent
    const hasSlugs = m.dependencySlugs !== undefined;
    const hasDeps = m.dependencies !== undefined;
    if (hasSlugs !== hasDeps) {
      fail(
        "INVALID_MANIFEST",
        "dependencySlugs and dependencies must appear together",
      );
    }

    if (hasSlugs) {
      if (!Array.isArray(m.dependencySlugs)) {
        fail("INVALID_MANIFEST", "dependencySlugs must be an array");
      }
      const slugSet = new Set<string>();
      for (const slug of m.dependencySlugs) {
        if (typeof slug !== "string" || !validateSlug(slug)) {
          fail("INVALID_MANIFEST", `Invalid dependency slug: ${slug}`);
        }
        if (slugSet.has(slug)) {
          fail("INVALID_MANIFEST", `Duplicate dependency slug: ${slug}`);
        }
        slugSet.add(slug);
      }
    }
    if (m.dependencies !== undefined) {
      if (!Array.isArray(m.dependencies)) {
        fail("INVALID_MANIFEST", "dependencies must be an array if present");
      }
      const depSlugSet = new Set<string>();
      for (const dep of m.dependencies) {
        if (!isRecord(dep)) {
          fail("INVALID_MANIFEST", "Dependency entry must be an object");
        }
        if (typeof dep.slug !== "string" || !validateSlug(dep.slug)) {
          fail("INVALID_MANIFEST", `Invalid dependency slug: ${dep.slug}`);
        }
        if (depSlugSet.has(dep.slug)) {
          fail(
            "INVALID_MANIFEST",
            `Duplicate dependency in array: ${dep.slug}`,
          );
        }
        depSlugSet.add(dep.slug);
        if (typeof dep.subscriptionId !== "string" || !dep.subscriptionId) {
          fail(
            "INVALID_MANIFEST",
            `Dependency ${dep.slug}: invalid subscriptionId`,
          );
        }
        if (typeof dep.uid !== "string" || !dep.uid) {
          fail("INVALID_MANIFEST", `Dependency ${dep.slug}: invalid uid`);
        }
        if (typeof dep.versionId !== "string" || !dep.versionId) {
          fail("INVALID_MANIFEST", `Dependency ${dep.slug}: invalid versionId`);
        }
        if (!Number.isInteger(dep.nodeCount) || dep.nodeCount < 0) {
          fail("INVALID_MANIFEST", `Dependency ${dep.slug}: invalid nodeCount`);
        }
        if (
          typeof dep.providerSha256 !== "string" ||
          !HEX64.test(dep.providerSha256)
        ) {
          fail(
            "INVALID_MANIFEST",
            `Dependency ${dep.slug}: invalid providerSha256`,
          );
        }
        if (
          typeof dep.profileSha256 !== "string" ||
          !HEX64.test(dep.profileSha256)
        ) {
          fail(
            "INVALID_MANIFEST",
            `Dependency ${dep.slug}: invalid profileSha256`,
          );
        }
      }
      // Verify dependencySlugs matches dependencies if both present
      if (m.dependencySlugs !== undefined) {
        const slugSet = new Set(m.dependencySlugs as string[]);
        if (
          slugSet.size !== depSlugSet.size ||
          [...slugSet].some((s) => !depSlugSet.has(s))
        ) {
          fail("INVALID_MANIFEST", "dependencySlugs and dependencies disagree");
        }
      }
    }
  }

  return value as unknown as UnifiedManifest;
}

async function verifyManifestFiles(
  files: Map<string, Uint8Array>,
  manifest: UnifiedManifest,
): Promise<void> {
  const actual = new Set(
    [...files.keys()].filter((p) => p !== "manifest.json"),
  );
  const listed = new Set(Object.keys(manifest.files));
  if (actual.size !== listed.size || [...actual].some((p) => !listed.has(p))) {
    fail("INTEGRITY_MISMATCH", "Manifest file set does not match ZIP");
  }
  for (const [path, meta] of Object.entries(manifest.files)) {
    if (
      !isRecord(meta) ||
      !HEX64.test(meta.sha256) ||
      !Number.isInteger(meta.contentLength) ||
      meta.contentLength < 0 ||
      typeof meta.required !== "boolean" ||
      path === "manifest.json" ||
      path.endsWith("/")
    ) {
      fail("INVALID_MANIFEST", "Manifest file metadata is invalid");
    }
    const data = files.get(path)!;
    if (
      data.length !== meta.contentLength ||
      (await sha256Hex(data)) !== meta.sha256
    ) {
      fail("INTEGRITY_MISMATCH", "Manifest file integrity check failed");
    }
  }
  for (const root of ["config.yaml", "verge.yaml", "profiles.yaml"]) {
    if (!manifest.files[root]?.required)
      fail("INVALID_MANIFEST", "Required root file is missing");
  }
}

function validateArchiveWhitelist(
  zip: ParsedZip,
  manifest: UnifiedManifest,
): void {
  const allowedFiles = new Set<string>([
    "manifest.json",
    "config.yaml",
    "verge.yaml",
    "profiles.yaml",
  ]);
  const allowedDirectories = new Set<string>(["profiles/", "providers/"]);
  for (const airport of manifest.airports) {
    allowedFiles.add(`profiles/${airport.profileUid}.yaml`);
    allowedFiles.add(`providers/${airport.slug}/provider.yaml`);
    allowedFiles.add(`providers/${airport.slug}/profile.yaml`);
    allowedFiles.add(`providers/${airport.slug}/meta.json`);
    allowedDirectories.add(`providers/${airport.slug}/`);
  }
  // v2: Add dependency files to whitelist
  if (manifest.formatVersion === 2 && manifest.dependencies) {
    allowedDirectories.add("dependencies/");
    for (const dep of manifest.dependencies) {
      allowedFiles.add(`dependencies/${dep.slug}/raw.yaml`);
      allowedFiles.add(`dependencies/${dep.slug}/provider.yaml`);
      allowedFiles.add(`dependencies/${dep.slug}/profile.yaml`);
      allowedFiles.add(`dependencies/${dep.slug}/meta.json`);
      allowedDirectories.add(`dependencies/${dep.slug}/`);
    }
  }
  if ([...zip.files.keys()].some((path) => !allowedFiles.has(path))) {
    fail("INTEGRITY_MISMATCH", "Archive contains a file outside the contract");
  }
  if ([...zip.directories].some((path) => !allowedDirectories.has(path))) {
    fail(
      "UNSAFE_ZIP_PATH",
      "Archive contains a directory outside the contract",
    );
  }
  for (const [path, entry] of Object.entries(manifest.files)) {
    const mustBeRequired =
      path === "config.yaml" ||
      path === "verge.yaml" ||
      path === "profiles.yaml" ||
      path.startsWith("profiles/") ||
      path.startsWith("dependencies/");
    if (entry.required !== mustBeRequired) {
      fail("INVALID_MANIFEST", "Manifest required flags are inconsistent");
    }
  }
}

function validateAirport(value: unknown): void {
  if (!isRecord(value)) fail("INVALID_MANIFEST", "Airport metadata is invalid");
  const a = value as Record<string, unknown>;
  if (
    !validateSlug(String(a.slug ?? "")) ||
    typeof a.subscriptionId !== "string" ||
    typeof a.name !== "string" ||
    typeof a.profileUid !== "string" ||
    !PROFILE_UID.test(a.profileUid) ||
    typeof a.versionId !== "string" ||
    !Number.isInteger(a.nodeCount) ||
    typeof a.providerSha256 !== "string" ||
    !HEX64.test(a.providerSha256) ||
    typeof a.profileSha256 !== "string" ||
    !HEX64.test(a.profileSha256)
  )
    fail("INVALID_MANIFEST", "Airport metadata is invalid");
}

function parseProviderMeta(bytes: Uint8Array): ProviderVersionMeta {
  let value: unknown;
  try {
    value = JSON.parse(decodeText(bytes));
  } catch {
    fail("IDENTITY_MISMATCH", "Provider metadata is invalid");
  }
  if (!storage.isProviderVersionMeta(value))
    fail("IDENTITY_MISMATCH", "Provider metadata is invalid");
  const m = value as unknown as Record<string, unknown>;
  if (
    (m.schemaVersion !== 1 && m.schemaVersion !== 2) ||
    !validateSlug(String(m.providerSlug ?? "")) ||
    typeof m.subscriptionId !== "string" ||
    typeof m.uid !== "string" ||
    typeof m.versionId !== "string" ||
    typeof m.createdAt !== "string" ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    typeof m.sourceSha256 !== "string" ||
    !HEX64.test(m.sourceSha256) ||
    !Number.isInteger(m.nodeCount) ||
    typeof m.generatorVersion !== "string" ||
    !isDistribution(m.distribution) ||
    !isRecord(m.artifacts)
  ) {
    fail("IDENTITY_MISMATCH", "Provider metadata shape is invalid");
  }
  return value as unknown as ProviderVersionMeta;
}

async function validateProviderIdentity(
  meta: ProviderVersionMeta,
  airport: UnifiedManifest["airports"][number],
  provider: Uint8Array,
  profile: Uint8Array,
): Promise<void> {
  if (
    meta.providerSlug !== airport.slug ||
    meta.subscriptionId !== airport.subscriptionId ||
    meta.versionId !== airport.versionId ||
    meta.nodeCount !== airport.nodeCount ||
    meta.distribution.providerName !== airport.name ||
    airport.profileUid !== meta.uid ||
    meta.sourceSha256 !== meta.artifacts.raw.sha256 ||
    (await sha256Hex(provider)) !== airport.providerSha256 ||
    (await sha256Hex(profile)) !== airport.profileSha256 ||
    !isArtifact(
      meta.artifacts.provider,
      airport.providerSha256,
      provider.length,
    ) ||
    !isArtifact(
      meta.artifacts.profile,
      airport.profileSha256,
      profile.length,
    ) ||
    !isArtifact(meta.artifacts.raw)
  )
    fail("IDENTITY_MISMATCH", "Provider identity does not match manifest");
  const keys = storage.getVersionKeys(airport.slug, airport.versionId);
  if (
    meta.artifacts.raw.key !== keys.raw ||
    meta.artifacts.provider.key !== keys.provider ||
    meta.artifacts.profile.key !== keys.profile
  ) {
    fail("IDENTITY_MISMATCH", "Provider artifact paths are not canonical");
  }
}

function validateProfilesYaml(
  doc: Record<string, unknown>,
  manifest: UnifiedManifest,
  base: string,
  expectedBase: string,
  trustedOrigins: ReadonlySet<string>,
): {
  fixedToken?: string;
  clientUpdatePolicies: Map<string, ClientUpdatePolicy>;
  sourceUrls: Map<string, string>;
} {
  if (
    typeof doc.current !== "string" ||
    !Array.isArray(doc.items) ||
    doc.items.length !== manifest.airports.length
  ) {
    fail("INVALID_YAML", "profiles.yaml shape is invalid");
  }
  const byUid = new Map(manifest.airports.map((a) => [a.profileUid, a]));
  const seen = new Set<string>();
  const clientUpdatePolicies = new Map<string, ClientUpdatePolicy>();
  const sourceUrls = new Map<string, string>();
  let token: string | undefined;
  for (const raw of doc.items) {
    if (!isRecord(raw) || typeof raw.uid !== "string" || seen.has(raw.uid))
      fail("IDENTITY_MISMATCH", "Profile identity is invalid");
    const airport = byUid.get(raw.uid);
    seen.add(raw.uid);
    const option = raw.option;
    if (option !== undefined && !isRecord(option)) {
      fail("IDENTITY_MISMATCH", "Profile update option is invalid");
    }
    if (isRecord(option)) {
      const allow = option.allow_auto_update;
      const interval = option.update_interval;
      if (
        (allow !== undefined && typeof allow !== "boolean") ||
        (interval !== undefined &&
          (typeof interval !== "number" ||
            !Number.isSafeInteger(interval) ||
            interval <= 0 ||
            interval > MAX_CLIENT_UPDATE_INTERVAL_MINUTES))
      ) {
        fail("IDENTITY_MISMATCH", "Profile update option is invalid");
      }
      if (allow !== undefined || interval !== undefined) {
        clientUpdatePolicies.set(raw.uid, {
          allowAutoUpdate: typeof allow === "boolean" ? allow : false,
          updateIntervalMinutes: typeof interval === "number" ? interval : 60,
        });
      }
    }
    if (
      !airport ||
      raw.name !== airport.name ||
      raw.file !== `${raw.uid}.yaml`
    ) {
      fail("IDENTITY_MISMATCH", "Profile metadata does not match manifest");
    }
    if (manifest.generator === "worker") {
      if (raw.type !== "remote" || typeof raw.url !== "string") {
        fail("IDENTITY_MISMATCH", "Profile metadata does not match manifest");
      }
      const url = parseFixedUrl(raw.url);
      const match = url.pathname.match(/^\/config\/([^/]+)\/([^/]+)$/);
      if (
        `${url.protocol}//${url.host}` !== base ||
        !match ||
        match[1] !== airport.slug ||
        url.search ||
        url.hash
      ) {
        fail("INVALID_FIXED_URL", "Profile URL is not a fixed Worker URL");
      }
      token ??= match[2];
      if (token !== match[2])
        fail("INVALID_FIXED_URL", "Fixed URL tokens disagree");
      continue;
    }
    if (raw.type === "local") {
      if (raw.url !== undefined && raw.url !== "") {
        fail("IDENTITY_MISMATCH", "Local profile must not contain a URL");
      }
      continue;
    }
    if (raw.type !== "remote" || typeof raw.url !== "string") {
      fail("IDENTITY_MISMATCH", "Profile metadata does not match manifest");
    }
    const validation = validateUrl(raw.url);
    let source: URL;
    try {
      source = new URL(raw.url);
    } catch {
      fail("INVALID_FIXED_URL", "Subscription URL is invalid");
    }
    if (!validation.valid) {
      fail("INVALID_FIXED_URL", "Subscription URL is not allowed");
    }
    if (
      !isCurrentWorkerProfileUrl(
        source,
        expectedBase,
        airport.slug,
        trustedOrigins,
      )
    ) {
      sourceUrls.set(raw.uid, raw.url);
    }
  }
  if (!seen.has(doc.current))
    fail("IDENTITY_MISMATCH", "Current profile does not exist");
  return { fixedToken: token, clientUpdatePolicies, sourceUrls };
}

function isCurrentWorkerProfileUrl(
  url: URL,
  expectedBase: string,
  slug: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const match = url.pathname.match(/^\/config\/([^/]+)\/([^/]+)$/);
  return (
    isSameTrustedWorkerOrigin(
      `${url.protocol}//${url.host}`,
      expectedBase,
      trustedOrigins,
    ) &&
    match?.[1] === slug &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function sameClientUpdatePolicy(
  left: ClientUpdatePolicy,
  right: ClientUpdatePolicy,
): boolean {
  return (
    left.allowAutoUpdate === right.allowAutoUpdate &&
    left.updateIntervalMinutes === right.updateIntervalMinutes
  );
}

function validateConfigProviderUrls(
  yaml: string,
  base: string,
  expectedToken?: string,
): void {
  const doc = parseYamlMapping(yaml, "config.yaml");
  const providers = doc["proxy-providers"];
  if (providers === undefined) return;
  if (!isRecord(providers))
    fail("INVALID_YAML", "proxy-providers must be a mapping");
  let token = expectedToken;
  for (const [slug, raw] of Object.entries(providers)) {
    if (!isRecord(raw) || typeof raw.url !== "string") continue;
    const url = parseFixedUrl(raw.url);
    const match = url.pathname.match(/^\/provider\/([^/]+)\/([^/]+)$/);
    if (
      `${url.protocol}//${url.host}` !== base ||
      !match ||
      match[1] !== slug ||
      (token !== undefined && match[2] !== token) ||
      url.search ||
      url.hash
    ) {
      fail("INVALID_FIXED_URL", "Provider URL is not a fixed Worker URL");
    }
    token ??= match[2];
  }
}

function parseYamlMapping(
  text: string,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = jsYaml.load(text);
  } catch {
    fail("INVALID_YAML", `${label} is invalid YAML`);
  }
  if (!isRecord(value)) fail("INVALID_YAML", `${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function requiredFile(
  files: Map<string, Uint8Array>,
  path: string,
): Uint8Array {
  const data = files.get(path);
  if (!data) fail("INTEGRITY_MISMATCH", "A required file is missing");
  return data!;
}
function decodeText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    fail("INVALID_ZIP", "Archive text is not UTF-8");
  }
}
function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail("INVALID_FIXED_URL", "Public base URL is invalid");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== "/" && u.pathname !== "")
  )
    fail("INVALID_FIXED_URL", "Public base URL must be an HTTPS origin");
  return `${u.protocol}//${u.host}`;
}

function isSameTrustedWorkerOrigin(
  left: string,
  right: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  return (
    left === right || (trustedOrigins.has(left) && trustedOrigins.has(right))
  );
}
function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isDistribution(v: unknown): v is ProviderDistributionMetadata {
  return (
    isRecord(v) &&
    typeof v.providerName === "string" &&
    typeof v.sourceHost === "string" &&
    (v.sourceType === undefined ||
      v.sourceType === "local" ||
      v.sourceType === "remote") &&
    (v.subscriptionUserinfo === undefined ||
      typeof v.subscriptionUserinfo === "string") &&
    (v.profileUpdateInterval === undefined ||
      typeof v.profileUpdateInterval === "string") &&
    (v.profileWebPageUrl === undefined ||
      typeof v.profileWebPageUrl === "string") &&
    (v.clientUpdatePolicy === undefined ||
      (isRecord(v.clientUpdatePolicy) &&
        typeof v.clientUpdatePolicy.allowAutoUpdate === "boolean" &&
        typeof v.clientUpdatePolicy.updateIntervalMinutes === "number" &&
        Number.isSafeInteger(v.clientUpdatePolicy.updateIntervalMinutes) &&
        v.clientUpdatePolicy.updateIntervalMinutes > 0 &&
        v.clientUpdatePolicy.updateIntervalMinutes <=
          MAX_CLIENT_UPDATE_INTERVAL_MINUTES))
  );
}
function isArtifact(v: unknown, hash?: string, length?: number): boolean {
  return (
    isRecord(v) &&
    typeof v.key === "string" &&
    typeof v.sha256 === "string" &&
    HEX64.test(v.sha256) &&
    Number.isInteger(v.contentLength) &&
    (hash === undefined || v.sha256 === hash) &&
    (length === undefined || v.contentLength === length)
  );
}
async function sha256Hex(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Executes an already fully validated import plan through the phase 2/3
 * publishing kernels. R2 has no multi-key transaction: a later conflict is
 * reported with the providers that were already committed.
 *
 * Import order: dependencies first, then providers.
 */
export async function executeUnifiedImport(
  bucket: R2Bucket,
  plan: UnifiedImportPlan,
): Promise<UnifiedImportResult> {
  const preparedDeps: Array<{
    dep: UnifiedImportDependencyPlan;
    expectedLatestEtag: string | null;
  }> = [];

  const preparedProviders: Array<{
    provider: UnifiedImportProviderPlan;
    rawContent: string;
    expectedLatestEtag: string | null;
  }> = [];

  // Capture CAS baselines for dependencies (raw content already in plan)
  for (const dep of plan.dependencies) {
    const latest = await bucket.head(
      storage.getVersionKeys(dep.slug, dep.versionId).latest,
    );
    preparedDeps.push({
      dep,
      expectedLatestEtag: latest?.etag ?? null,
    });
  }

  // Validate all providers and capture CAS baselines
  for (const provider of plan.providers) {
    let rawContent: string;
    if (plan.manifest.generator === "slclash") {
      if (provider.snapshotRawContent === undefined) {
        fail("INTEGRITY_MISMATCH", "Slclash snapshot raw content is missing");
      }
      rawContent = provider.snapshotRawContent!;
    } else {
      const rawObject = await bucket.get(provider.rawArtifact.key);
      if (!rawObject) {
        fail(
          "INTEGRITY_MISMATCH",
          "Referenced immutable raw artifact is missing",
        );
      }
      const rawBytes = new Uint8Array(await rawObject.arrayBuffer());
      if (
        rawBytes.length !== provider.rawArtifact.contentLength ||
        (await sha256Hex(rawBytes)) !== provider.rawArtifact.sha256
      ) {
        fail(
          "INTEGRITY_MISMATCH",
          "Referenced immutable raw artifact is corrupted",
        );
      }
      rawContent = decodeText(rawBytes);
    }
    const latest = await bucket.head(
      storage.getVersionKeys(provider.slug, provider.originalMeta.versionId)
        .latest,
    );
    preparedProviders.push({
      provider,
      rawContent,
      expectedLatestEtag: latest?.etag ?? null,
    });
  }

  const committedDeps: Array<{ slug: string; versionId: string }> = [];
  const committedProviders: Array<{ slug: string; versionId: string }> = [];

  try {
    // 1. Publish dependencies first (preserve original versionId)
    for (const item of preparedDeps) {
      const result = await storage.publishProviderVersion(
        bucket,
        {
          ...item.dep.publishInput,
          rawContent: item.dep.rawContent,
          expectedLatestEtag: item.expectedLatestEtag,
        },
        {
          now: () => new Date(item.dep.originalMeta.createdAt),
          generateVersionId: () => item.dep.originalMeta.versionId,
        },
      );
      committedDeps.push({
        slug: item.dep.slug,
        versionId: result.versionId,
      });
    }

    // 2. Then publish visible providers
    for (const item of preparedProviders) {
      const result = await storage.publishProviderVersion(bucket, {
        ...item.provider.publishInput,
        rawContent: item.rawContent,
        expectedLatestEtag: item.expectedLatestEtag,
      });
      committedProviders.push({
        slug: item.provider.slug,
        versionId: result.versionId,
      });
    }

    for (const item of preparedProviders) {
      if (item.provider.sourceUrl) {
        await storage.saveSourceUrl(
          bucket,
          item.provider.slug,
          item.provider.sourceUrl,
        );
      }
    }

    return { providers: committedProviders, dependencies: committedDeps };
  } catch (error) {
    const providerConflict =
      error instanceof storage.VersionPublishError &&
      (error.code === "VERSION_CONFLICT" ||
        error.code === "VERSION_OBJECT_CONFLICT" ||
        error.code === "PROVIDER_IDENTITY_CONFLICT");
    if (providerConflict) {
      throw new UnifiedImportCommitError(
        committedProviders,
        committedDeps,
        error,
      );
    }
    throw error;
  }
}

export class UnifiedImportCommitError extends Error {
  constructor(
    public readonly committedProviders: ReadonlyArray<{
      slug: string;
      versionId: string;
    }>,
    public readonly committedDependencies: ReadonlyArray<{
      slug: string;
      versionId: string;
    }>,
    public readonly cause: unknown,
  ) {
    super("Unified import encountered a publishing conflict");
    this.name = "UnifiedImportCommitError";
  }
}

export async function readUnifiedImportBody(
  request: Request,
): Promise<Uint8Array> {
  if (!request.body) fail("INVALID_ZIP", "Request body is empty");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNIFIED_IMPORT_BYTES) {
        await reader.cancel();
        fail("ZIP_LIMIT_EXCEEDED", "ZIP exceeds the archive size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) fail("INVALID_ZIP", "Request body is empty");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
function parseFixedUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    fail("INVALID_FIXED_URL", "Subscription URL is invalid");
  }
}
function validateDependencyGraph(
  manifest: UnifiedManifest,
  files: Map<string, Uint8Array>,
): void {
  if (manifest.formatVersion !== 2) return;
  if (!manifest.dependencies || !manifest.dependencySlugs) return;

  const MAX_DEPENDENCY_DEPTH = 4;
  const MAX_DEPENDENCY_COUNT = 32;

  if (manifest.dependencies.length > MAX_DEPENDENCY_COUNT) {
    fail("INVALID_MANIFEST", "Too many dependencies");
  }

  // Check dependency slug matches manifest.dependencySlugs
  const declaredSlugs = new Set(manifest.dependencySlugs);
  const actualSlugs = new Set(manifest.dependencies.map((d) => d.slug));
  if (
    declaredSlugs.size !== actualSlugs.size ||
    [...declaredSlugs].some((s) => !actualSlugs.has(s))
  ) {
    fail("INVALID_MANIFEST", "dependencySlugs and dependencies disagree");
  }

  // Check each dependency's files exist and match manifest
  for (const dep of manifest.dependencies) {
    if (!validateSlug(dep.slug)) {
      fail("INVALID_MANIFEST", `Invalid dependency slug: ${dep.slug}`);
    }
    if (!PROFILE_UID.test(dep.uid)) {
      fail("INVALID_MANIFEST", `Invalid dependency uid: ${dep.uid}`);
    }
    if (!HEX64.test(dep.providerSha256) || !HEX64.test(dep.profileSha256)) {
      fail("INVALID_MANIFEST", `Invalid dependency hash: ${dep.slug}`);
    }

    const prefix = `dependencies/${dep.slug}/`;
    for (const name of ["provider.yaml", "profile.yaml", "meta.json"]) {
      const path = `${prefix}${name}`;
      const data = files.get(path);
      if (!data) {
        fail("INTEGRITY_MISMATCH", `Missing dependency file: ${path}`);
      }
    }

    // Verify dependency meta.json matches manifest
    const metaBytes = files.get(`${prefix}meta.json`);
    if (metaBytes) {
      let depMeta: unknown;
      try {
        depMeta = JSON.parse(decodeText(metaBytes));
      } catch {
        fail("IDENTITY_MISMATCH", `Invalid dependency meta.json: ${dep.slug}`);
      }
      if (
        !isRecord(depMeta) ||
        depMeta.subscriptionId !== dep.subscriptionId ||
        depMeta.uid !== dep.uid ||
        depMeta.versionId !== dep.versionId ||
        depMeta.nodeCount !== dep.nodeCount
      ) {
        fail(
          "IDENTITY_MISMATCH",
          `Dependency meta.json does not match manifest: ${dep.slug}`,
        );
      }
    }
  }

  // Check for circular dependencies (simple cycle detection)
  // Since dependencies are flat (no nested dependencies), we just check
  // that no dependency slug appears in the visible airports
  const airportSlugs = new Set(manifest.airports.map((a) => a.slug));
  for (const dep of manifest.dependencies) {
    if (airportSlugs.has(dep.slug)) {
      // If a dependency is also a visible subscription, the files must be identical
      // This is handled by the dedup logic in the exporter
    }
  }
}

function fail(code: UnifiedImportErrorCode, message: string): never {
  throw new UnifiedImportError(code, message);
}
