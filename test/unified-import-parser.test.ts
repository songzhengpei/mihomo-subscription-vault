import { describe, expect, it } from "vitest";
import jsYaml from "js-yaml";
import {
  executeUnifiedImport,
  MAX_UNIFIED_IMPORT_BYTES,
  parseUnifiedImport,
  UnifiedImportError,
} from "../src/services/unified-import.ts";
import { precomputeZip } from "../src/services/zip.ts";
import { crc32 } from "../src/services/zip.ts";
import { deflateRawSync } from "node:zlib";
import { handleApi } from "../src/routes/api.ts";
import type { Env } from "../src/types.ts";

const enc = new TextEncoder();
const BASE = "https://vault.example.com";
const UID = "Ree27070f";
const RAW = "123456789012";

function mainConfigYaml(base = BASE): string {
  return `proxy-providers:\n  alpha:\n    type: http\n    url: ${base}/provider/alpha/token\n`;
}

class MockBucket {
  readonly store = new Map<string, string>();
  readonly etags = new Map<string, string>();
  private sequence = 0;
  onGet?: (key: string) => void;
  onHead?: (key: string) => void;

  async get(key: string) {
    this.onGet?.(key);
    const value = this.store.get(key);
    if (value === undefined) return null;
    const etag = this.etags.get(key)!;
    return {
      key,
      etag,
      async text() {
        return value;
      },
      async arrayBuffer() {
        return enc.encode(value).buffer;
      },
    };
  }

  async head(key: string) {
    const result = this.store.has(key)
      ? { key, etag: this.etags.get(key)! }
      : null;
    this.onHead?.(key);
    return result;
  }

  async put(
    key: string,
    body: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ) {
    const current = this.etags.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && current !== undefined)
      return null;
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      options.onlyIf.etagMatches !== current
    )
      return null;
    const value =
      typeof body === "string"
        ? body
        : await new Response(body as BodyInit).text();
    const etag = `etag-${++this.sequence}`;
    this.store.set(key, value);
    this.etags.set(key, etag);
    return { key, etag };
  }

  seed(key: string, value: string) {
    this.store.set(key, value);
    this.etags.set(key, `seed-${++this.sequence}`);
  }
}

function envFor(bucket: MockBucket): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN: "admin-secret",
    DOWNLOAD_TOKEN: "token",
    PUBLIC_BASE_URL: BASE,
  };
}

async function seedArchiveDependencies(bucket: MockBucket): Promise<void> {
  bucket.seed("providers/alpha/versions/v1/raw.yaml", RAW);
  bucket.seed(
    "vault/main-config/identity.json",
    JSON.stringify({
      schemaVersion: 1,
      configId: "c1",
      createdAt: "2026-07-15T00:00:00.000Z",
    }),
  );
  const yaml = mainConfigYaml();
  const yamlHash = await sha(enc.encode(yaml));
  bucket.seed("vault/main-config/versions/m1/main-config.yaml", yaml);
  bucket.seed(
    "vault/main-config/versions/m1/meta.json",
    JSON.stringify({
      schemaVersion: 1,
      configId: "c1",
      versionId: "m1",
      createdAt: "2026-07-15T00:00:00.000Z",
      name: "Main",
      source: "manual",
      artifact: {
        key: "vault/main-config/versions/m1/main-config.yaml",
        sha256: yamlHash,
        contentLength: enc.encode(yaml).length,
      },
    }),
  );
}

async function sha(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function zipBytes(entries: { path: string; data: Uint8Array }[]) {
  const zip = await precomputeZip(entries);
  const out = new Uint8Array(zip.totalSize);
  let offset = 0;
  for (const item of zip.locals) {
    out.set(item.header, offset);
    offset += item.header.length;
    out.set(item.data, offset);
    offset += item.data.length;
  }
  for (const item of zip.centrals) {
    out.set(item.header, offset);
    offset += item.header.length;
  }
  out.set(zip.endRecord, offset);
  return out;
}

async function deflateZip(input: Uint8Array): Promise<Uint8Array> {
  // Rebuild a valid stored test ZIP as a standard Deflate ZIP with data descriptors,
  // matching the shape commonly emitted by Android/Dart archive libraries.
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const entries: Array<{ name: Uint8Array; data: Uint8Array }> = [];
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 22, true);
    const nameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    const name = input.slice(pos + 30, pos + 30 + nameLength);
    const start = pos + 30 + nameLength + extraLength;
    entries.push({ name, data: input.slice(start, start + size) });
    pos = start + size;
  }
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  for (const entry of entries) {
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);
    const localOffset = offset;
    const local = new Uint8Array(30 + entry.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0008, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    push(local);
    push(compressed);
    const descriptor = new Uint8Array(16);
    const dv = new DataView(descriptor.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crc, true);
    dv.setUint32(8, compressed.length, true);
    dv.setUint32(12, entry.data.length, true);
    push(descriptor);
    const cd = new Uint8Array(46 + entry.name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0008, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.name.length, true);
    cv.setUint32(42, localOffset, true);
    cd.set(entry.name, 46);
    central.push(cd);
  }
  const centralOffset = offset;
  for (const cd of central) push(cd);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, offset - centralOffset, true);
  ev.setUint32(16, centralOffset, true);
  push(eocd);
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

async function validArchive(options?: {
  badHash?: boolean;
  path?: string;
  duplicatePath?: boolean;
  profileBase?: string;
  publicBaseUrl?: string;
  format?: string;
  formatVersion?: number;
  omit?: string;
  emptyNodes?: boolean;
  declaredExtra?: boolean;
  omitProfileOption?: boolean;
  invalidProfileAutoUpdate?: boolean;
  profileUpdateInterval?: number;
  metaClientUpdatePolicy?: {
    allowAutoUpdate: boolean;
    updateIntervalMinutes: number;
  };
  generator?: string;
  sourceType?: string;
  profileType?: "remote" | "local";
  profileUrl?: string;
  rawHashMismatch?: boolean;
  rawLengthMismatch?: boolean;
}) {
  const node =
    "  - {name: node-1, type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: test}\n";
  const provider = enc.encode(
    options?.emptyNodes ? "proxies: []\n" : `proxies:\n${node}`,
  );
  const profile = enc.encode(
    options?.emptyNodes
      ? "proxies: []\nrules: [MATCH,DIRECT]\n"
      : `proxies:\n${node}rules: [MATCH,DIRECT]\n`,
  );
  const nodeCount = options?.emptyNodes ? 0 : 1;
  const providerHash = await sha(provider);
  const profileHash = await sha(profile);
  const isSlclash = options?.generator === "slclash";
  const rawHash = isSlclash ? profileHash : await sha(enc.encode(RAW));
  const meta = enc.encode(
    JSON.stringify({
      schemaVersion: 1,
      providerSlug: "alpha",
      subscriptionId: "sub-alpha",
      uid: UID,
      versionId: "v1",
      createdAt: "2026-07-15T00:00:00.000Z",
      sourceSha256: rawHash,
      nodeCount,
      generatorVersion: "1.0.0",
      distribution: {
        providerName: "Alpha",
        sourceHost: "source.example",
        ...(options?.sourceType && { sourceType: options.sourceType }),
        ...(options?.metaClientUpdatePolicy && {
          clientUpdatePolicy: options.metaClientUpdatePolicy,
        }),
      },
      artifacts: {
        raw: {
          key: "providers/alpha/versions/v1/raw.yaml",
          sha256: options?.rawHashMismatch ? "0".repeat(64) : rawHash,
          contentLength: options?.rawLengthMismatch
            ? profile.length + 1
            : isSlclash
              ? profile.length
              : enc.encode(RAW).length,
        },
        provider: {
          key: "providers/alpha/versions/v1/provider.yaml",
          sha256: providerHash,
          contentLength: provider.length,
        },
        profile: {
          key: "providers/alpha/versions/v1/profile.yaml",
          sha256: profileHash,
          contentLength: profile.length,
        },
      },
    }),
  );
  const manifestBase = options?.publicBaseUrl ?? BASE;
  const fixedBase = options?.profileBase ?? manifestBase;
  const files = new Map<string, Uint8Array>([
    ["config.yaml", enc.encode(mainConfigYaml(fixedBase))],
    ["verge.yaml", enc.encode("{}\n")],
    [
      "profiles.yaml",
      enc.encode(
        jsYaml.dump({
          current: UID,
          items: [
            {
              uid: UID,
              type: options?.profileType ?? "remote",
              name: "Alpha",
              file: `${UID}.yaml`,
              ...((options?.profileType ?? "remote") === "remote" && {
                url: options?.profileUrl ?? `${fixedBase}/config/alpha/token`,
              }),
              updated: 1,
              ...(options?.omitProfileOption
                ? {}
                : {
                    option: {
                      allow_auto_update: options?.invalidProfileAutoUpdate
                        ? "invalid"
                        : false,
                      ...(options?.profileUpdateInterval && {
                        update_interval: options.profileUpdateInterval,
                      }),
                    },
                  }),
            },
          ],
        }),
      ),
    ],
    [`profiles/${UID}.yaml`, profile],
    ["providers/alpha/provider.yaml", provider],
    ["providers/alpha/profile.yaml", profile],
    ["providers/alpha/meta.json", meta],
  ]);
  if (options?.declaredExtra) files.set("extra.txt", enc.encode("extra"));
  if (options?.omit) files.delete(options.omit);
  const manifestFiles: Record<string, unknown> = {};
  for (const [path, data] of files) {
    manifestFiles[path] = {
      sha256: await sha(data),
      contentLength: data.length,
      required: !path.startsWith("providers/"),
    };
  }
  if (options?.badHash)
    (manifestFiles["config.yaml"] as { sha256: string }).sha256 = "0".repeat(
      64,
    );
  const manifest = enc.encode(
    JSON.stringify({
      format: options?.format ?? "mihomo-unified-backup",
      formatVersion: options?.formatVersion ?? 1,
      archiveType: "unified-subscription-archive",
      createdAt: "2026-07-15T00:00:00.000Z",
      generator: options?.generator ?? "worker",
      generatorVersion: "1.0.0",
      publicBaseUrl: manifestBase,
      mainConfig: {
        configId: "c1",
        versionId: "m1",
        name: "Main",
        sourceSha256: files.has("config.yaml")
          ? await sha(files.get("config.yaml")!)
          : "0".repeat(64),
      },
      airports: [
        {
          slug: "alpha",
          subscriptionId: "sub-alpha",
          name: "Alpha",
          profileUid: UID,
          versionId: "v1",
          nodeCount,
          providerSha256: providerHash,
          profileSha256: profileHash,
        },
      ],
      files: manifestFiles,
    }),
  );
  const entries = [...files].map(([path, data]) => ({ path, data }));
  entries.push({ path: "manifest.json", data: manifest });
  if (options?.path)
    entries.push({ path: options.path, data: enc.encode("x") });
  if (options?.path && options.duplicatePath)
    entries.push({ path: options.path, data: enc.encode("x") });
  return zipBytes(entries);
}

async function validSlclashBackup(options?: { profileUrl?: string }) {
  const inner = await validArchive();
  const id = Number.parseInt(UID.slice(1), 16);
  const node =
    "  - {name: node-1, type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: test}\n";
  const profile = enc.encode(`proxies:\n${node}rules: [MATCH,DIRECT]\n`);
  return zipBytes([
    {
      path: "metadata.json",
      data: enc.encode(
        JSON.stringify({
          backupType: "profiles_only_v2",
          currentProfileId: id,
          profiles: [
            {
              id,
              label: "Alpha",
              url: options?.profileUrl ?? `${BASE}/config/alpha/token`,
            },
          ],
        }),
      ),
    },
    { path: `profiles/${id}.yaml`, data: profile },
    { path: "subscription-center/worker-v1.zip", data: inner },
  ]);
}

describe("parseUnifiedImport", () => {
  it("preserves an original Slclash subscription URL in the import plan", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({
        generator: "slclash",
        profileUrl: "https://airport.example/subscription?token=secret",
      }),
      BASE,
    );
    expect(plan.providers[0]!.sourceUrl).toBe(
      "https://airport.example/subscription?token=secret",
    );
    expect(plan.providers[0]!.publishInput.profileYaml).toContain("proxies:");
    expect(plan.providers[0]!.publishInput.profileYaml).not.toContain(
      "proxy-providers:",
    );
  });

  it("does not bind this Worker's fixed profile URL as its own upstream", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ generator: "slclash" }),
      BASE,
    );
    expect(plan.providers[0]!.sourceUrl).toBeUndefined();
  });

  it("accepts a local Slclash profile without an upstream URL", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ generator: "slclash", profileType: "local" }),
      BASE,
    );
    expect(plan.providers[0]!.sourceUrl).toBeUndefined();
  });

  it("rejects an unsafe Slclash subscription URL", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({
          generator: "slclash",
          profileUrl: "http://127.0.0.1/subscription",
        }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FIXED_URL" });
  });

  it("preserves a validated Slclash local-file source marker", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ generator: "slclash", sourceType: "local" }),
      BASE,
    );
    expect(plan.providers[0]!.publishInput.distribution.sourceType).toBe(
      "local",
    );
  });

  it("rejects an unknown profile source marker", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({ generator: "slclash", sourceType: "unknown" }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("accepts Slclash-generated profiles without an optional auto-update block", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ omitProfileOption: true }),
      BASE,
    );
    expect(plan.providers.map((item) => item.profileUid)).toEqual([UID]);
  });

  it("still rejects a present but invalid auto-update block", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({ invalidProfileAutoUpdate: true }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("accepts false and binds client policy by profile UID", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({
        generator: "slclash",
        profileUpdateInterval: 1440,
      }),
      BASE,
    );
    expect(
      plan.providers[0]!.publishInput.distribution.clientUpdatePolicy,
    ).toEqual({ allowAutoUpdate: false, updateIntervalMinutes: 1440 });
  });

  it("rejects mismatched profile and meta client policies", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({
          generator: "slclash",
          profileUpdateInterval: 1440,
          metaClientUpdatePolicy: {
            allowAutoUpdate: true,
            updateIntervalMinutes: 1440,
          },
        }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("accepts the existing Slclash v2 backup envelope", async () => {
    const plan = await parseUnifiedImport(await validSlclashBackup(), BASE);
    expect(plan.providers.map((item) => item.slug)).toEqual(["alpha"]);
  });

  it("accepts a Deflate Slclash backup with data descriptors", async () => {
    const backup = await deflateZip(await validSlclashBackup());
    const plan = await parseUnifiedImport(backup, BASE);
    expect(plan.providers.map((item) => item.slug)).toEqual(["alpha"]);
  });

  it("rejects a Slclash envelope that disagrees with the Worker snapshot", async () => {
    await expect(
      parseUnifiedImport(
        await validSlclashBackup({ profileUrl: `${BASE}/config/other/token` }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("returns a publication plan while preserving the raw R2 artifact", async () => {
    const plan = await parseUnifiedImport(await validArchive(), BASE);
    expect(plan).not.toHaveProperty("mainConfig");
    expect(plan.providers).toHaveLength(1);
    expect(plan.providers[0]!.publishInput.providerSlug).toBe("alpha");
    expect(plan.providers[0]!.rawArtifact.key).toContain("/raw.yaml");
    expect(plan.providers[0]!.publishInput).not.toHaveProperty("rawContent");
  });

  it("imports an explicit Slclash snapshot without an existing R2 raw object", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ generator: "slclash" }),
      BASE,
    );
    const bucket = new MockBucket();
    const result = await executeUnifiedImport(
      bucket as unknown as R2Bucket,
      plan,
    );
    expect(result.providers).toHaveLength(1);
    expect(
      [...bucket.store.keys()].some((key) => key.endsWith("/raw.yaml")),
    ).toBe(true);
  });

  it("saves the original URL only after publishing a Slclash snapshot", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({
        generator: "slclash",
        profileUrl: "https://airport.example/subscription?token=secret",
      }),
      BASE,
    );
    const bucket = new MockBucket();
    await executeUnifiedImport(bucket as unknown as R2Bucket, plan);
    expect(
      JSON.parse(bucket.store.get("providers/alpha/source-url.json")!),
    ).toEqual({
      url: "https://airport.example/subscription?token=secret",
    });
  });

  it("keeps an existing upstream when a Slclash snapshot uses this Worker URL", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ generator: "slclash" }),
      BASE,
    );
    const bucket = new MockBucket();
    bucket.seed(
      "providers/alpha/source-url.json",
      JSON.stringify({ url: "https://airport.example/original" }),
    );
    await executeUnifiedImport(bucket as unknown as R2Bucket, plan);
    expect(
      JSON.parse(bucket.store.get("providers/alpha/source-url.json")!),
    ).toEqual({ url: "https://airport.example/original" });
  });

  it.each([{ rawHashMismatch: true }, { rawLengthMismatch: true }])(
    "rejects inconsistent Slclash raw metadata %#",
    async (options) => {
      await expect(
        parseUnifiedImport(
          await validArchive({ generator: "slclash", ...options }),
          BASE,
        ),
      ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
    },
  );

  it("rejects an unknown generator", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ generator: "unknown" }), BASE),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });

  it("rejects a Slclash snapshot outside native V1", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({ generator: "slclash", formatVersion: 2 }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("rejects a manifest hash mismatch", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ badHash: true }), BASE),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("rejects path traversal before manifest processing", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ path: "../secret" }), BASE),
    ).rejects.toBeInstanceOf(UnifiedImportError);
    await expect(
      parseUnifiedImport(await validArchive({ path: "../secret" }), BASE),
    ).rejects.toMatchObject({ code: "UNSAFE_ZIP_PATH" });
  });

  it("rejects an archive for another public origin", async () => {
    await expect(
      parseUnifiedImport(await validArchive(), "https://other.example"),
    ).rejects.toMatchObject({ code: "INVALID_FIXED_URL" });
  });

  it("accepts a configured former origin when importing a backup", async () => {
    const plan = await parseUnifiedImport(
      await validArchive(),
      "https://new-vault.example",
      [BASE],
    );
    expect(plan.providers.map((item) => item.slug)).toEqual(["alpha"]);
  });

  it("accepts a Slclash snapshot from any internally consistent origin", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({
        generator: "slclash",
        publicBaseUrl: "https://standalone.slclash.invalid",
      }),
      BASE,
    );
    expect(plan.providers.map((item) => item.slug)).toEqual(["alpha"]);
  });

  it("rejects empty, non-ZIP, damaged and oversized bodies", async () => {
    for (const bytes of [
      new Uint8Array(),
      enc.encode("not a zip"),
      new Uint8Array(MAX_UNIFIED_IMPORT_BYTES + 1),
    ]) {
      await expect(parseUnifiedImport(bytes, BASE)).rejects.toBeInstanceOf(
        UnifiedImportError,
      );
    }
    const damaged = await validArchive();
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 0xff;
    await expect(parseUnifiedImport(damaged, BASE)).rejects.toBeInstanceOf(
      UnifiedImportError,
    );
  });

  it.each([
    "/absolute",
    "C:/absolute",
    "..\\escape",
    "safe/../escape",
    "nul\0x",
  ])("rejects unsafe ZIP path %s", async (path) => {
    await expect(
      parseUnifiedImport(await validArchive({ path }), BASE),
    ).rejects.toMatchObject({ code: "UNSAFE_ZIP_PATH" });
  });

  it("rejects duplicate ZIP entries", async () => {
    await expect(
      parseUnifiedImport(
        await validArchive({ path: "extra.txt", duplicatePath: true }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_ZIP_PATH" });
  });

  it("rejects missing manifest and required files", async () => {
    await expect(
      parseUnifiedImport(
        await zipBytes([{ path: "config.yaml", data: enc.encode("{}") }]),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    await expect(
      parseUnifiedImport(await validArchive({ omit: "config.yaml" }), BASE),
    ).rejects.toBeInstanceOf(UnifiedImportError);
  });

  it("rejects unsupported format variants and unsafe fixed URLs", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ format: "other" }), BASE),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(
      parseUnifiedImport(
        await validArchive({ profileBase: "https://outside.example" }),
        BASE,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FIXED_URL" });
  });

  it("accepts formatVersion 2", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({ formatVersion: 2 }),
      BASE,
    );
    expect(plan.manifest.formatVersion).toBe(2);
    expect(plan.providers).toHaveLength(1);
  });

  it("rejects a Provider without nodes", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ emptyNodes: true }), BASE),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("rejects an extra file even when manifest declares it", async () => {
    await expect(
      parseUnifiedImport(await validArchive({ declaredExtra: true }), BASE),
    ).rejects.toMatchObject({ code: "INTEGRITY_MISMATCH" });
  });

  it("publishes through existing kernels and is idempotent", async () => {
    const archive = await validArchive();
    const plan = await parseUnifiedImport(archive, BASE);
    const bucket = new MockBucket();
    await seedArchiveDependencies(bucket);

    const first = await executeUnifiedImport(
      bucket as unknown as R2Bucket,
      plan,
    );
    expect(first.providers).toHaveLength(1);
    expect(bucket.store.has("providers/alpha/latest.json")).toBe(true);
    expect(bucket.store.has("vault/main-config/latest.json")).toBe(false);
    const versionKeysBefore = [...bucket.store.keys()].filter((key) =>
      key.startsWith("providers/alpha/versions/"),
    );

    const second = await executeUnifiedImport(
      bucket as unknown as R2Bucket,
      plan,
    );
    expect(second.providers[0]!.versionId).toBe(first.providers[0]!.versionId);
    expect(
      [...bucket.store.keys()].filter((key) =>
        key.startsWith("providers/alpha/versions/"),
      ),
    ).toEqual(versionKeysBefore);
  });

  it("preserves a null Provider CAS baseline against concurrent creation", async () => {
    const plan = await parseUnifiedImport(
      await validArchive({
        generator: "slclash",
        profileUrl: "https://airport.example/subscription?token=secret",
      }),
      BASE,
    );
    const bucket = new MockBucket();
    await seedArchiveDependencies(bucket);
    let injected = false;
    bucket.onHead = (key) => {
      if (key !== "providers/alpha/latest.json" || injected) return;
      injected = true;
      bucket.seed(
        "providers/alpha/latest.json",
        JSON.stringify({
          schemaVersion: 1,
          providerSlug: "alpha",
          subscriptionId: "sub-alpha",
          uid: "provider-uid",
          versionId: "concurrent",
          publishedAt: "2026-07-15T00:00:00.000Z",
          metaKey: "providers/alpha/versions/concurrent/meta.json",
          metaSha256: "0".repeat(64),
        }),
      );
    };

    await expect(
      executeUnifiedImport(bucket as unknown as R2Bucket, plan),
    ).rejects.toMatchObject({ committedProviders: [] });
    expect(
      JSON.parse(bucket.store.get("providers/alpha/latest.json")!).versionId,
    ).toBe("concurrent");
    expect(bucket.store.has("providers/alpha/source-url.json")).toBe(false);
  });
});

describe("POST /api/unified-import", () => {
  it("rejects unauthorized requests without consuming the ZIP body", async () => {
    const request = new Request(`${BASE}/api/unified-import`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: await validArchive(),
    });
    const response = await handleApi(
      request,
      envFor(new MockBucket()),
      "/api/unified-import",
    );
    expect(response?.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires the single application/zip request contract", async () => {
    const response = await handleApi(
      new Request(`${BASE}/api/unified-import`, {
        method: "POST",
        headers: {
          Authorization: "Bearer admin-secret",
          "Content-Type": "multipart/form-data",
        },
        body: "not-a-zip",
      }),
      envFor(new MockBucket()),
      "/api/unified-import",
    );
    expect(response?.status).toBe(415);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_CONTENT_TYPE" },
    });
  });

  it("imports a valid archive and exposes committed pointer state", async () => {
    const bucket = new MockBucket();
    await seedArchiveDependencies(bucket);
    const response = await handleApi(
      new Request(`${BASE}/api/unified-import`, {
        method: "POST",
        headers: {
          Authorization: "Bearer admin-secret",
          "Content-Type": "application/zip",
        },
        body: await validArchive(),
      }),
      envFor(bucket),
      "/api/unified-import",
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      data: { providers: [{ slug: "alpha" }] },
    });
    expect(bucket.store.has("providers/alpha/latest.json")).toBe(true);
    expect(bucket.store.has("vault/main-config/latest.json")).toBe(false);
  });
});
