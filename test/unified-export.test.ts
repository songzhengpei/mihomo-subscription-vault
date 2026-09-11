import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/types.ts";
import * as storage from "../src/services/storage.ts";

// --- Mock R2 Bucket ---

class MockR2Bucket {
  store = new Map<string, string>();
  etags = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    const rawData = this.store.get(key);
    if (rawData === undefined) return null;
    const data: string = rawData;
    const etag = this.etags.get(key) || `"${data.length}"`;
    let bodyUsed = false;
    function consume(): string {
      if (bodyUsed) throw new TypeError("Body has already been used");
      bodyUsed = true;
      return data;
    }
    return {
      key,
      etag,
      httpEtag: etag,
      get bodyUsed(): boolean {
        return bodyUsed;
      },
      body: new TextEncoder().encode(data),
      async json() {
        return JSON.parse(consume());
      },
      async text() {
        return consume();
      },
      async arrayBuffer() {
        return new TextEncoder().encode(consume()).buffer;
      },
      size: new TextEncoder().encode(data).length,
      checksums: {},
      writeHttpMetadata() {},
      storageClass: null,
      customMetadata: null,
      uploaded: new Date(),
      httpMetadata: null,
    };
  }

  async head(key: string): Promise<unknown> {
    const stored = this.store.get(key);
    if (stored === undefined) return null;
    return {
      key,
      size: new TextEncoder().encode(stored).length,
      etag: this.etags.get(key) || `"${stored.length}"`,
      httpEtag: this.etags.get(key) || `"${stored.length}"`,
      checksums: {},
      writeHttpMetadata() {},
      storageClass: null,
      customMetadata: null,
      uploaded: new Date(),
      httpMetadata: null,
    };
  }

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer,
    opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<{ key: string; etag: string } | null> {
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit).text();
    if (opts?.onlyIf) {
      const cur = this.etags.get(key);
      if (opts.onlyIf.etagDoesNotMatch === "*") {
        if (cur !== undefined) return null;
      } else if (opts.onlyIf.etagMatches !== undefined) {
        if (!cur || cur !== opts.onlyIf.etagMatches) return null;
      }
    }
    const newEtag = `"${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}"`;
    this.store.set(key, text);
    this.etags.set(key, newEtag);
    return { key, etag: newEtag };
  }

  async list(opts?: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts?.prefix || "";
    const delimiter = opts?.delimiter || "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));

    if (delimiter) {
      const dirs = new Set<string>();
      const objects: { key: string }[] = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const di = rest.indexOf(delimiter);
        if (di >= 0) {
          dirs.add(prefix + rest.slice(0, di + 1));
        } else {
          objects.push({ key: k });
        }
      }
      return {
        objects,
        delimitedPrefixes: [...dirs],
        truncated: false,
        cursor: undefined,
      };
    }

    return {
      objects: keys.map((k) => ({ key: k })),
      delimitedPrefixes: [],
      truncated: false,
      cursor: undefined,
    };
  }

  clear() {
    this.store.clear();
    this.etags.clear();
  }
}

// --- Helpers ---

function makeEnv(bucket: MockR2Bucket, overrides?: Partial<Env>): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN: "admin-test-token",
    DOWNLOAD_TOKEN: "test-download-token",
    PUBLIC_BASE_URL: "https://vault.example.com",
    ...overrides,
  } as Env;
}

async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clb(content: string): number {
  return new TextEncoder().encode(content).length;
}

function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort())
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  return sorted;
}

function makeRequest(
  method: string,
  path: string,
  opts?: { headers?: Record<string, string> },
): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: new Headers(opts?.headers),
  });
}

// Minimal ZIP parser for assertions
function parseZip(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  while (pos < data.length - 3) {
    const sig = view.getUint32(pos, true);
    if (sig === 0x04034b50) {
      // local file header
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);
      const compSize = view.getUint32(pos + 18, true);
      const name = new TextDecoder().decode(
        data.slice(pos + 30, pos + 30 + nameLen),
      );
      const fileData = data.slice(
        pos + 30 + nameLen + extraLen,
        pos + 30 + nameLen + extraLen + compSize,
      );
      files.set(name, fileData);
      pos = pos + 30 + nameLen + extraLen + compSize;
    } else {
      break;
    }
  }
  return files;
}

// --- Seed helpers ---

async function seedV1Provider(
  bucket: MockR2Bucket,
  opts: {
    slug?: string;
    subscriptionId?: string;
    uid?: string;
    versionId?: string;
    profileYaml?: string;
    providerYaml?: string;
    rawContent?: string;
    providerName?: string;
    subscriptionUserinfo?: string;
    profileUpdateInterval?: string;
    clientUpdatePolicy?: {
      allowAutoUpdate: boolean;
      updateIntervalMinutes: number;
    };
    legacy?: boolean;
    corruptProfileSha?: boolean;
    missingProfile?: boolean;
    corruptMetaSha?: boolean;
    missingMeta?: boolean;
    corruptMetaJson?: boolean;
    wrongPointerSlug?: boolean;
    wrongPointerMetaKey?: boolean;
    wrongMetaVersionId?: boolean;
    wrongMetaSlug?: boolean;
    wrongMetaSubId?: boolean;
    wrongMetaUid?: boolean;
    wrongArtifactKey?: boolean;
    missingProvider?: boolean;
    corruptProviderSha?: boolean;
  } = {},
) {
  const slug = opts.slug ?? "test-provider";
  const subId = opts.subscriptionId ?? "sub-001";
  const uid = opts.uid ?? `R${(await sha256Hex(subId)).slice(0, 8)}`;
  const vid = opts.versionId ?? "20260715T120000Z-abcd1234";
  const pYaml =
    opts.profileYaml ?? "mixed-port: 7890\nallow-lan: true\nmode: rule\n";
  const prYaml =
    opts.providerYaml ?? "- name: node1\n  type: ss\n  server: 1.2.3.4\n";
  const raw = opts.rawContent ?? "raw subscription content\n";
  const pSha = await sha256Hex(pYaml);
  const prSha = await sha256Hex(prYaml);
  const rSha = await sha256Hex(raw);

  const keys = {
    raw: `providers/${slug}/versions/${vid}/raw.yaml`,
    provider: `providers/${slug}/versions/${vid}/provider.yaml`,
    profile: `providers/${slug}/versions/${vid}/profile.yaml`,
    meta: `providers/${slug}/versions/${vid}/meta.json`,
    latest: `providers/${slug}/latest.json`,
  };

  if (opts.legacy) {
    bucket.store.set(
      keys.latest,
      JSON.stringify({
        versionId: vid,
        sha256: prSha,
        updatedAt: "2026-07-15T12:00:00.000Z",
      }),
    );
    return { slug, versionId: vid };
  }

  const meta = {
    schemaVersion: 1,
    providerSlug: opts.wrongMetaSlug ? "wrong-slug" : slug,
    subscriptionId: opts.wrongMetaSubId ? "wrong-sub" : subId,
    uid: opts.wrongMetaUid ? "wrong-uid" : uid,
    versionId: opts.wrongMetaVersionId ? "wrong-vid" : vid,
    createdAt: "2026-07-15T12:00:00.000Z",
    sourceSha256: rSha,
    nodeCount: 3,
    generatorVersion: "1.0.0",
    distribution: {
      providerName: opts.providerName ?? "Test Provider",
      sourceHost: "example.com",
      subscriptionUserinfo: opts.subscriptionUserinfo,
      profileUpdateInterval: opts.profileUpdateInterval,
      clientUpdatePolicy: opts.clientUpdatePolicy,
    },
    artifacts: {
      raw: { key: keys.raw, sha256: rSha, contentLength: clb(raw) },
      provider: {
        key: opts.wrongArtifactKey
          ? `providers/${slug}/versions/${vid}/wrong.yaml`
          : keys.provider,
        sha256: opts.corruptProviderSha ? "a".repeat(64) : prSha,
        contentLength: clb(prYaml),
      },
      profile: {
        key: keys.profile,
        sha256: opts.corruptProfileSha ? "a".repeat(64) : pSha,
        contentLength: clb(pYaml),
      },
    },
  };

  const metaJson = JSON.stringify(sortKeysDeep(meta), null, 2);
  const metaSha = opts.corruptMetaSha
    ? "b".repeat(64)
    : await sha256Hex(metaJson);

  const pointer = {
    schemaVersion: 1,
    providerSlug: opts.wrongPointerSlug ? "wrong-slug" : slug,
    subscriptionId: subId,
    uid,
    versionId: vid,
    publishedAt: "2026-07-15T12:00:00.000Z",
    metaKey: opts.wrongPointerMetaKey
      ? `providers/${slug}/versions/${vid}/wrong.json`
      : keys.meta,
    metaSha256: metaSha,
  };

  bucket.store.set(keys.latest, JSON.stringify(pointer, null, 2));
  if (!opts.missingMeta) {
    if (opts.corruptMetaJson) bucket.store.set(keys.meta, "not valid json{{{");
    else bucket.store.set(keys.meta, metaJson);
  }
  bucket.store.set(keys.raw, raw);
  if (!opts.missingProvider) bucket.store.set(keys.provider, prYaml);
  if (!opts.missingProfile) bucket.store.set(keys.profile, pYaml);

  return {
    slug,
    versionId: vid,
    subscriptionId: subId,
    uid,
    profileSha256: pSha,
    providerSha256: prSha,
    profileContentLength: clb(pYaml),
    providerContentLength: clb(prYaml),
    metaSha256: metaSha,
  };
}

async function seedMainConfig(
  bucket: MockR2Bucket,
  opts: {
    yaml?: string;
    name?: string;
    status?: "active" | "disabled";
    missingIdentity?: boolean;
    wrongConfigId?: boolean;
    missingMeta?: boolean;
    corruptMetaSha?: boolean;
    missingYaml?: boolean;
    corruptYamlSha?: boolean;
    corruptYamlSize?: boolean;
  } = {},
) {
  const yaml =
    opts.yaml ??
    "proxy-providers:\n  airport-a:\n    type: http\n    url: https://old.example.com/sub\n    interval: 3600\nproxy-groups: []\nrules: []\n";
  const name = opts.name ?? "my-config";
  const status = opts.status ?? "active";
  const cid = "test-config-id-001";
  const vid = "mc-v0001";
  const ySha = await sha256Hex(yaml);

  const art = {
    key: `vault/main-config/versions/${vid}/main-config.yaml`,
    sha256: opts.corruptYamlSha ? "c".repeat(64) : ySha,
    contentLength: opts.corruptYamlSize ? clb(yaml) + 100 : clb(yaml),
  };
  const meta = {
    schemaVersion: 1,
    configId: cid,
    versionId: vid,
    createdAt: "2026-07-15T12:00:00.000Z",
    name,
    source: "manual" as const,
    artifact: art,
  };
  const metaJson = JSON.stringify(sortKeysDeep(meta), null, 2);
  const metaSha = opts.corruptMetaSha
    ? "d".repeat(64)
    : await sha256Hex(metaJson);

  const identity = {
    schemaVersion: 1,
    configId: opts.wrongConfigId ? "wrong-cid" : cid,
    createdAt: "2026-07-14T00:00:00.000Z",
  };
  const pointer: Record<string, unknown> = {
    schemaVersion: 1,
    configId: cid,
    versionId: vid,
    status,
    publishedAt: "2026-07-15T12:00:00.000Z",
    metaKey: `vault/main-config/versions/${vid}/meta.json`,
    metaSha256: metaSha,
  };
  if (status === "disabled") pointer.disabledAt = "2026-07-15T13:00:00.000Z";

  bucket.store.set(
    "vault/main-config/latest.json",
    JSON.stringify(pointer, null, 2),
  );
  if (!opts.missingIdentity) {
    bucket.store.set(
      "vault/main-config/identity.json",
      JSON.stringify(identity, null, 2),
    );
  }
  if (!opts.missingMeta) {
    bucket.store.set(`vault/main-config/versions/${vid}/meta.json`, metaJson);
  }
  if (!opts.missingYaml) {
    bucket.store.set(
      `vault/main-config/versions/${vid}/main-config.yaml`,
      yaml,
    );
  }

  return {
    yaml,
    yamlSha256: ySha,
    yamlContentLength: clb(yaml),
    configId: cid,
    versionId: vid,
  };
}

// --- Route-level test helper ---

async function callHandleApi(
  req: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const { handleApi } = await import("../src/routes/api.ts");
  const res = await handleApi(req, env, path);
  expect(res).not.toBeNull();
  return res!;
}

async function callUnifiedExport(
  bucket: MockR2Bucket,
  envOverrides?: Partial<Env>,
  slug?: string,
): Promise<Response> {
  const env = makeEnv(bucket, envOverrides);
  const urlPath = slug
    ? `/api/unified-export?slug=${slug}`
    : "/api/unified-export";
  const req = makeRequest("GET", urlPath, {
    headers: { Authorization: "Bearer admin-test-token" },
  });
  return callHandleApi(req, env, "/api/unified-export");
}

// ============================================================
// Tests
// ============================================================

describe("unified-export", () => {
  let bucket: MockR2Bucket;

  beforeEach(() => {
    bucket = new MockR2Bucket();
  });

  // ----------------------------------------------------------
  // A. Route and auth
  // ----------------------------------------------------------
  describe("A. route and auth", () => {
    it("A1: 401 without Authorization header", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/unified-export");
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(401);
    });

    it("A2: 401 with wrong Bearer token", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/unified-export", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(401);
    });

    it("A3: 405 for POST", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("POST", "/api/unified-export", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    it("A4: 405 for HEAD", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("HEAD", "/api/unified-export", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(405);
    });

    it("A5: 405 for DELETE", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("DELETE", "/api/unified-export", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(405);
    });

    it("A6: 400 for unknown query parameter", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/unified-export?unknown=1", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_QUERY");
    });

    it("A7: 400 for empty slug", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/unified-export?slug=", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(400);
    });

    it("A8: 400 for invalid slug format", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/unified-export?slug=INVALID!", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const res = await callHandleApi(req, env, "/api/unified-export");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_SLUG");
    });

    it("A9: obsolete /api/export is not routed", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/export", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const { handleApi } = await import("../src/routes/api.ts");
      const res = await handleApi(req, env, "/api/export");
      expect(res).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // B. Canonical origin / configuration
  // ----------------------------------------------------------
  describe("B. canonical origin", () => {
    it("B1: missing PUBLIC_BASE_URL → 500 CONFIGURATION_ERROR", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: undefined,
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_CONFIGURATION_ERROR");
    });

    it("B2: empty PUBLIC_BASE_URL → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, { PUBLIC_BASE_URL: "  " });
      expect(res.status).toBe(500);
    });

    it("B3: HTTP URL → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "http://example.com",
      });
      expect(res.status).toBe(500);
    });

    it("B4: URL with path → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "https://example.com/sub",
      });
      expect(res.status).toBe(500);
    });

    it("B5: URL with query → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "https://example.com?x=1",
      });
      expect(res.status).toBe(500);
    });

    it("B6: URL with fragment → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "https://example.com#frag",
      });
      expect(res.status).toBe(500);
    });

    it("B7: URL with userinfo → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "https://user:pass@example.com",
      });
      expect(res.status).toBe(500);
    });

    it("B8: DOWNLOAD_TOKEN with illegal chars → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        DOWNLOAD_TOKEN: "token/with/slashes",
      });
      expect(res.status).toBe(500);
    });

    it("B9: trailing slash on origin normalized", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, {
        PUBLIC_BASE_URL: "https://vault.example.com/",
      });
      expect(res.status).toBe(200);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toBe(
        "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n",
      );
    });
  });

  // ----------------------------------------------------------
  // C. MainConfig
  // ----------------------------------------------------------
  describe.skip("C. obsolete stored main config behavior", () => {
    it("C1: no main config → 409 MAIN_CONFIG_REQUIRED", async () => {
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_MAIN_CONFIG_REQUIRED");
    });

    it("C2: disabled main config → 409 MAIN_CONFIG_DISABLED", async () => {
      await seedMainConfig(bucket, { status: "disabled" });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_MAIN_CONFIG_DISABLED");
    });

    it("C3: missing identity → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { missingIdentity: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_MAIN_CONFIG_CORRUPTED");
    });

    it("C4: wrong configId → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { wrongConfigId: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C5: missing meta → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { missingMeta: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C6: corrupt meta SHA → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { corruptMetaSha: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C7: missing YAML → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { missingYaml: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C8: corrupt YAML SHA → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { corruptYamlSha: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C9: corrupt YAML size → 500 MAIN_CONFIG_CORRUPTED", async () => {
      await seedMainConfig(bucket, { corruptYamlSize: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("C10: error response contains no tokens or SHA", async () => {
      await seedMainConfig(bucket, { missingIdentity: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const text = await res.text();
      expect(text).not.toContain("test-download-token");
      expect(text).not.toContain("admin-test-token");
    });
  });

  describe("C2. generated compatibility config", () => {
    it("exports without any stored main config", async () => {
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(200);
      const files = parseZip(new Uint8Array(await res.arrayBuffer()));
      expect(new TextDecoder().decode(files.get("config.yaml")!)).toBe(
        "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n",
      );
    });

    it("ignores obsolete stored main-config state", async () => {
      await seedMainConfig(bucket, { corruptMetaSha: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(200);
    });
  });

  // ----------------------------------------------------------
  // D. Provider
  // ----------------------------------------------------------
  describe("D. provider", () => {
    it("D1: single V1 provider → 200 with ZIP", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
    });

    it("D2: specified slug not found → 404", async () => {
      await seedMainConfig(bucket);
      const res = await callUnifiedExport(bucket, {}, "nonexistent");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_PROVIDER_NOT_FOUND");
    });

    it("D3: legacy provider → 409 PROVIDER_NOT_AVAILABLE", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { legacy: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_PROVIDER_NOT_AVAILABLE");
    });

    it("D4: legacy single slug → 409", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "leg", legacy: true });
      const res = await callUnifiedExport(bucket, {}, "leg");
      expect(res.status).toBe(409);
    });

    it("D5: corrupt profile SHA → 500 PROVIDER_CORRUPTED", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { corruptProfileSha: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_PROVIDER_CORRUPTED");
    });

    it("D6: missing profile → 500 PROVIDER_CORRUPTED", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { missingProfile: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D7: corrupt meta SHA → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { corruptMetaSha: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D8: missing meta → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { missingMeta: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D9: wrong pointer slug → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { wrongPointerSlug: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D10: wrong pointer metaKey → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { wrongPointerMetaKey: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D11: wrong meta versionId → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { wrongMetaVersionId: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D12: wrong meta subscriptionId → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { wrongMetaSubId: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D13: corrupt provider SHA → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { corruptProviderSha: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D14: missing provider artifact → 500", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { missingProvider: true });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(500);
    });

    it("D15: full export with no providers → 409 PROVIDERS_REQUIRED", async () => {
      await seedMainConfig(bucket);
      // No providers seeded
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_PROVIDERS_REQUIRED");
    });

    it("D16: multiple V1 providers → 200", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "alpha", subscriptionId: "sub-a" });
      await seedV1Provider(bucket, { slug: "beta", subscriptionId: "sub-b" });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(200);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      expect(files.has("providers/alpha/provider.yaml")).toBe(true);
      expect(files.has("providers/beta/provider.yaml")).toBe(true);
    });

    it("D17: meta.json uses original stored bytes", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const metaBytes = files.get("providers/test-provider/meta.json")!;
      const meta = JSON.parse(new TextDecoder().decode(metaBytes));
      expect(meta.schemaVersion).toBe(1);
      expect(meta.providerSlug).toBe("test-provider");
    });
  });

  // ----------------------------------------------------------
  // E. UID
  // ----------------------------------------------------------
  describe("E. profile UID", () => {
    it("E1: UID based on subscriptionId", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, {
        slug: "test",
        subscriptionId: "sub-abc-123",
      });
      const expectedUid = "R" + (await sha256Hex("sub-abc-123")).slice(0, 8);
      const res = await callUnifiedExport(bucket, {}, "test");
      expect(res.status).toBe(200);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      expect(files.has(`profiles/${expectedUid}.yaml`)).toBe(true);
    });

    it("E2: slug rename doesn't change UID", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, {
        slug: "old-name",
        subscriptionId: "sub-fixed",
      });
      const uid = "R" + (await sha256Hex("sub-fixed")).slice(0, 8);
      const res = await callUnifiedExport(bucket, {}, "old-name");
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      expect(files.has(`profiles/${uid}.yaml`)).toBe(true);
    });

    it("E3: UID format is R + 8 hex chars", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { subscriptionId: "sub-format-test" });
      const res = await callUnifiedExport(bucket, {});
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profileKeys = [...files.keys()].filter((k) =>
        k.startsWith("profiles/R"),
      );
      expect(profileKeys.length).toBe(1);
      const uid = profileKeys[0]!.replace("profiles/", "").replace(".yaml", "");
      expect(uid).toMatch(/^R[0-9a-f]{8}$/);
    });

    it("E4: two different subscriptionIds with colliding UID → 409", async () => {
      await seedMainConfig(bucket);
      // We need two subscriptionIds that hash to the same 8-char prefix.
      // Use brute force: generate until collision found, or mock.
      // For a deterministic test, we'll compute UIDs for many IDs and find a collision.
      // But this is impractical. Instead, test the collision detection logic
      // by using the same subscriptionId (which trivially collides).
      // Actually the collision check is based on the UID, not subscriptionId.
      // Two different subscriptionIds with same UID prefix would be needed.
      // Let's use a known collision pair or just verify the error path exists.
      // For practicality, we seed two providers with the same subscriptionId
      // (which will produce the same UID) and verify the error.
      await seedV1Provider(bucket, {
        slug: "one",
        subscriptionId: "sub-same",
      });
      await seedV1Provider(bucket, {
        slug: "two",
        subscriptionId: "sub-same",
      });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_UID_CONFLICT");
    });

    it("E5: UID is restored from persisted meta.uid", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, {
        slug: "test",
        subscriptionId: "sub-uid-test",
        uid: "custom-uid-value",
      });
      const res = await callUnifiedExport(bucket, {}, "test");
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      expect(files.has("profiles/custom-uid-value.yaml")).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // F. config.yaml rewriting
  // ----------------------------------------------------------
  describe.skip("F. obsolete config.yaml rewriting", () => {
    it("F1: proxy-providers URLs rewritten to PUBLIC_BASE_URL", async () => {
      await seedMainConfig(bucket, {
        yaml: "proxy-providers:\n  airport-a:\n    type: http\n    url: https://old.example.com/sub\n    interval: 3600\n",
      });
      await seedV1Provider(bucket, { slug: "airport-a" });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(200);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toContain(
        "https://vault.example.com/provider/airport-a/test-download-token",
      );
      expect(configYaml).not.toContain("old.example.com");
    });

    it("F2: non-URL providers not modified", async () => {
      const yaml =
        "proxy-providers:\n  local-file:\n    type: file\n    path: ./local.yaml\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, { slug: "test" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toContain("type: file");
      expect(configYaml).toContain("path: ./local.yaml");
    });

    it("F3: proxy-groups not modified", async () => {
      const yaml =
        "proxy-providers:\n  airport-a:\n    type: http\n    url: https://x.com/sub\nproxy-groups:\n  - name: auto\n    type: url-test\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, { slug: "airport-a" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toContain("name: auto");
      expect(configYaml).toContain("type: url-test");
    });

    it("F4: rules not modified", async () => {
      const yaml =
        "proxy-providers:\n  airport-a:\n    type: http\n    url: https://x.com/sub\nrules:\n  - MATCH,auto\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, { slug: "airport-a" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toContain("- MATCH,auto");
    });

    it("F5: slug export preserves full config topology", async () => {
      const yaml =
        "proxy-providers:\n  airport-a:\n    type: http\n    url: https://a.com/sub\n  airport-b:\n    type: http\n    url: https://b.com/sub\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, {
        slug: "airport-a",
        subscriptionId: "sub-a",
      });
      await seedV1Provider(bucket, {
        slug: "airport-b",
        subscriptionId: "sub-b",
      });
      // Export only airport-a but config.yaml should contain both providers
      const res = await callUnifiedExport(bucket, {}, "airport-a");
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      // Both providers should still be in config.yaml (topology preserved)
      expect(configYaml).toContain("airport-a:");
      expect(configYaml).toContain("airport-b:");
      // But only airport-a's profile should be in profiles/
      expect(
        files.has(
          "profiles/R" + (await sha256Hex("sub-a")).slice(0, 8) + ".yaml",
        ),
      ).toBe(true);
      // airport-b's profile should NOT be present
      const profileKeys = [...files.keys()].filter(
        (k) => k.startsWith("profiles/") && k.endsWith(".yaml"),
      );
      expect(profileKeys.length).toBe(1);
    });

    it("F6: invalid provider key → 409 CONFIG_MAPPING_INVALID", async () => {
      const yaml =
        "proxy-providers:\n  INVALID_KEY:\n    type: http\n    url: https://x.com/sub\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, { slug: "test" });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_CONFIG_MAPPING_INVALID");
    });

    it("F7: output YAML is re-parseable", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      // Should not throw
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(configYaml);
      expect(typeof parsed).toBe("object");
    });

    it("F8: no original subscription URL in ZIP or error", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(data);
      expect(text).not.toContain("https://old.example.com");
    });
  });

  // ----------------------------------------------------------
  // G. profiles.yaml
  // ----------------------------------------------------------
  describe("G. profiles.yaml", () => {
    it("uses the persisted subscription order", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "alpha", subscriptionId: "sub-a" });
      await seedV1Provider(bucket, { slug: "beta", subscriptionId: "sub-b" });
      await storage.saveProviderOrder(bucket as unknown as R2Bucket, [
        "beta",
        "alpha",
      ]);
      const res = await callUnifiedExport(bucket);
      const files = parseZip(new Uint8Array(await res.arrayBuffer()));
      const jsYaml = await import("js-yaml");
      const profiles = jsYaml.load(
        new TextDecoder().decode(files.get("profiles.yaml")!),
      ) as {
        items: Array<{ url: string }>;
      };
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      ) as {
        airports: Array<{ slug: string }>;
      };

      expect(profiles.items.map((item) => item.url)).toEqual([
        "https://vault.example.com/config/beta/test-download-token",
        "https://vault.example.com/config/alpha/test-download-token",
      ]);
      expect(manifest.airports.map((airport) => airport.slug)).toEqual([
        "beta",
        "alpha",
      ]);
    });

    it("G1: current points to first UID", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "alpha", subscriptionId: "sub-a" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        current: string;
        items: unknown[];
      };
      const expectedUid = "R" + (await sha256Hex("sub-a")).slice(0, 8);
      expect(parsed.current).toBe(expectedUid);
    });

    it("G2: items contain uid, type, name, file, url", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, {
        slug: "test-slug",
        subscriptionId: "sub-test",
        providerName: "My Airport",
      });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const item = parsed.items[0]!;
      expect(item.uid).toBe("R" + (await sha256Hex("sub-test")).slice(0, 8));
      expect(item.type).toBe("remote");
      expect(item.name).toBe("My Airport");
      expect(item.file).toBe(
        `R${(await sha256Hex("sub-test")).slice(0, 8)}.yaml`,
      );
      expect(item.url).toContain("/config/test-slug/test-download-token");
    });

    it("G3: native Worker Provider defaults auto update to false", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.allow_auto_update).toBe(false);
      expect(option.update_interval).toBe(60);
    });

    it("G4: profileUpdateInterval=24 → update_interval=1440", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { profileUpdateInterval: "24" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.update_interval).toBe(1440);
    });

    it("G4b: client policy minutes round-trip without conversion", async () => {
      for (const [index, minutes] of [60, 120, 1440].entries()) {
        await seedV1Provider(bucket, {
          slug: `policy-${minutes}`,
          subscriptionId: `policy-sub-${minutes}`,
          uid: `R${(0x20000000 + index).toString(16)}`,
          clientUpdatePolicy: {
            allowAutoUpdate: minutes === 1440,
            updateIntervalMinutes: minutes,
          },
        });
      }
      const res = await callUnifiedExport(bucket);
      const files = parseZip(new Uint8Array(await res.arrayBuffer()));
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(
        new TextDecoder().decode(files.get("profiles.yaml")!),
      ) as { items: Array<Record<string, unknown>> };
      const policies = Object.fromEntries(
        parsed.items.map((item) => [
          new URL(item.url as string).pathname.split("/")[2],
          item.option as Record<string, unknown>,
        ]),
      );
      expect(policies["policy-60"]!.update_interval).toBe(60);
      expect(policies["policy-120"]!.update_interval).toBe(120);
      expect(policies["policy-1440"]!.update_interval).toBe(1440);
      expect(policies["policy-60"]!.allow_auto_update).toBe(false);
      expect(policies["policy-1440"]!.allow_auto_update).toBe(true);
    });

    it("G5: invalid legacy interval falls back to 60", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { profileUpdateInterval: "not-a-number" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.update_interval).toBe(60);
    });

    it("G6: subscriptionUserinfo parsed into extra", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, {
        subscriptionUserinfo:
          "upload=100; download=200; total=1000; expire=1800000000",
      });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const extra = (parsed.items[0] as Record<string, unknown>)
        .extra as Record<string, unknown>;
      expect(extra.upload).toBe(100);
      expect(extra.download).toBe(200);
      expect(extra.total).toBe(1000);
      expect(extra.expire).toBe(1800000000);
    });

    it("G7: no subscriptionUserinfo → no extra", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket); // no subscriptionUserinfo
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      expect(
        (parsed.items[0] as Record<string, unknown>).extra,
      ).toBeUndefined();
    });

    it("G8: updated is Unix seconds", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const updated = (parsed.items[0] as Record<string, unknown>)
        .updated as number;
      // "2026-07-15T12:00:00.000Z" → Unix seconds
      expect(updated).toBe(
        Math.floor(new Date("2026-07-15T12:00:00.000Z").getTime() / 1000),
      );
    });

    it("G9: URL uses /config path, not /provider", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "my-slug" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      expect(profilesYaml).toContain("/config/my-slug/");
      expect(profilesYaml).not.toContain("/provider/");
    });
  });

  // ----------------------------------------------------------
  // H. manifest and integrity
  // ----------------------------------------------------------
  describe("H. manifest", () => {
    it("H1: format is mihomo-unified-backup", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      expect(manifest.format).toBe("mihomo-unified-backup");
      expect(manifest.formatVersion).toBe(1);
      expect(manifest.archiveType).toBe("unified-subscription-archive");
    });

    it("H2: only files field for integrity, no integrity.fileHashes", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      expect(manifest.files).toBeDefined();
      expect(manifest.integrity).toBeUndefined();
      expect(manifest.truncatedFiles).toBeUndefined();
    });

    it("H3: manifest.json not listed in files", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      expect(manifest.files["manifest.json"]).toBeUndefined();
    });

    it("H4: all ZIP files listed in manifest", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      for (const [name] of zipFiles) {
        if (name === "manifest.json") continue;
        if (name.endsWith("/")) continue; // directory entries
        expect(manifest.files[name]).toBeDefined();
      }
    });

    it("H5: SHA-256 matches actual content", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      for (const [name, content] of zipFiles) {
        if (name === "manifest.json" || name.endsWith("/")) continue;
        const expected = manifest.files[name];
        expect(expected).toBeDefined();
        const actualSha = await sha256HexBytes(content);
        expect(expected.sha256).toBe(actualSha);
      }
    });

    it("H6: contentLength matches actual size", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      for (const [name, content] of zipFiles) {
        if (name === "manifest.json" || name.endsWith("/")) continue;
        const expected = manifest.files[name];
        expect(expected.contentLength).toBe(content.length);
      }
    });

    it("H7: airports array matches providers", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "alpha", subscriptionId: "sub-a" });
      await seedV1Provider(bucket, { slug: "beta", subscriptionId: "sub-b" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      expect(manifest.airports.length).toBe(2);
      const slugs = manifest.airports.map((a: { slug: string }) => a.slug);
      expect(slugs).toContain("alpha");
      expect(slugs).toContain("beta");
    });

    it("H8: manifest contains publicBaseUrl", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      expect(manifest.publicBaseUrl).toBe("https://vault.example.com");
    });

    it("H9: manifest identifies the generated compatibility config", async () => {
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      expect(manifest.mainConfig.configId).toBe("system-minimal-compat");
      expect(manifest.mainConfig.versionId).toMatch(/^sha256-[a-f0-9]{16}$/);
      expect(manifest.mainConfig.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("H10: manifest does not contain tokens or full URLs", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifestText = new TextDecoder().decode(
        zipFiles.get("manifest.json")!,
      );
      expect(manifestText).not.toContain("test-download-token");
      expect(manifestText).not.toContain("https://vault.example.com/provider/");
      expect(manifestText).not.toContain("https://vault.example.com/config/");
    });

    it("H11: required=true for files, false for directories", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const zipFiles = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(zipFiles.get("manifest.json")!),
      );
      expect(manifest.files["config.yaml"].required).toBe(true);
      expect(manifest.files["verge.yaml"].required).toBe(true);
      expect(manifest.files["profiles.yaml"].required).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // I. ZIP format
  // ----------------------------------------------------------
  describe("I. ZIP format", () => {
    it("I1: no wrapper directory", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      for (const name of files.keys()) {
        // No leading directory wrapper
        expect(name.startsWith("backup/")).toBe(false);
        expect(name.startsWith("mihomo-")).toBe(false);
      }
    });

    it("I2: profiles/ directory entry exists", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      expect(files.has("profiles/")).toBe(true);
    });

    it("I3: required root files exist and are non-empty", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      for (const name of [
        "config.yaml",
        "verge.yaml",
        "profiles.yaml",
        "manifest.json",
      ]) {
        expect(files.has(name)).toBe(true);
        const content = files.get(name)!;
        expect(content.length).toBeGreaterThan(0);
      }
    });

    it("I4: verge.yaml is {}", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const verge = new TextDecoder().decode(files.get("verge.yaml")!);
      expect(verge).toBe("{}\n");
    });

    it("I5: stored compression (method=0)", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      // Check compression method in local headers
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let pos = 0;
      while (pos < data.length - 3) {
        const sig = view.getUint32(pos, true);
        if (sig === 0x04034b50) {
          const method = view.getUint16(pos + 8, true);
          expect(method).toBe(0); // stored
          const nameLen = view.getUint16(pos + 26, true);
          const extraLen = view.getUint16(pos + 28, true);
          const compSize = view.getUint32(pos + 18, true);
          pos = pos + 30 + nameLen + extraLen + compSize;
        } else {
          break;
        }
      }
    });

    it("I6: Content-Length matches ZIP size", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const clHeader = res.headers.get("Content-Length");
      expect(clHeader).toBeTruthy();
      const data = new Uint8Array(await res.arrayBuffer());
      expect(data.length).toBe(parseInt(clHeader!, 10));
    });

    it("I7: response headers correct", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Disposition")).toContain(
        "mihomo-unified-backup-v1-",
      );
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Pragma")).toBe("no-cache");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("I8: ZIP can be parsed (valid structure)", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      // Should have at least: config.yaml, verge.yaml, profiles.yaml,
      // profiles/, profiles/R*.yaml, providers/*/provider.yaml,
      // providers/*/profile.yaml, providers/*/meta.json, manifest.json
      expect(files.size).toBeGreaterThanOrEqual(8);
    });

    it("I9: UTF-8 content preserved", async () => {
      const yaml =
        "proxy-providers:\n  airport-a:\n    type: http\n    url: https://x.com/sub\nproxy-groups: []\nrules: []\n";
      await seedMainConfig(bucket, { yaml });
      await seedV1Provider(bucket, { slug: "airport-a" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const configYaml = new TextDecoder().decode(files.get("config.yaml")!);
      expect(configYaml).toBe(
        "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n",
      );
    });
  });

  // ----------------------------------------------------------
  // J. Security and side effects
  // ----------------------------------------------------------
  describe("J. security and side effects", () => {
    it.skip("J1: obsolete main-config error contains no tokens", async () => {
      await seedMainConfig(bucket, { missingIdentity: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const text = await res.text();
      expect(text).not.toContain("admin-test-token");
      expect(text).not.toContain("test-download-token");
    });

    it.skip("J2: obsolete main-config error contains no R2 keys", async () => {
      await seedMainConfig(bucket, { missingIdentity: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const text = await res.text();
      expect(text).not.toContain("vault/main-config");
      expect(text).not.toContain("providers/");
    });

    it.skip("J3: obsolete main-config error contains no SHA-256", async () => {
      await seedMainConfig(bucket, { corruptMetaSha: true });
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const text = await res.text();
      // Should not contain any 64-char hex string
      expect(text).not.toMatch(/[a-f0-9]{64}/);
    });

    it("J4: no R2 writes during export", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const storeBefore = new Map(bucket.store);
      await callUnifiedExport(bucket);
      expect(bucket.store.size).toBe(storeBefore.size);
      // Verify no new keys were added
      for (const key of bucket.store.keys()) {
        expect(storeBefore.has(key)).toBe(true);
      }
    });

    it("J5: exports are independent (no shared mutable state)", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "a", subscriptionId: "sub-a" });
      await seedV1Provider(bucket, { slug: "b", subscriptionId: "sub-b" });
      const [res1, res2] = await Promise.all([
        callUnifiedExport(bucket, {}, "a"),
        callUnifiedExport(bucket, {}, "b"),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });
  });

  // ----------------------------------------------------------
  // K. Obsolete export removal
  // ----------------------------------------------------------
  describe("K. obsolete /api/export removal", () => {
    it("K1: /api/export is no longer routed", async () => {
      const env = makeEnv(bucket);
      const req = makeRequest("GET", "/api/export", {
        headers: { Authorization: "Bearer admin-test-token" },
      });
      const { handleApi } = await import("../src/routes/api.ts");
      const res = await handleApi(req, env, "/api/export");
      expect(res).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // L. Audit fixes (P2)
  // ----------------------------------------------------------
  describe("L. audit fixes", () => {
    it("L1: profileUpdateInterval='24abc' → default 60", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { profileUpdateInterval: "24abc" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.update_interval).toBe(60);
    });

    it("L2: profileUpdateInterval='1.5' → default 60", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { profileUpdateInterval: "1.5" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.update_interval).toBe(60);
    });

    it("L3: profileUpdateInterval='12h' → default 60", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { profileUpdateInterval: "12h" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const profilesYaml = new TextDecoder().decode(
        files.get("profiles.yaml")!,
      );
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(profilesYaml) as {
        items: Record<string, unknown>[];
      };
      const option = (parsed.items[0] as Record<string, unknown>)
        .option as Record<string, unknown>;
      expect(option.update_interval).toBe(60);
    });

    it("L4: DOWNLOAD_TOKEN='.' → 500 CONFIGURATION_ERROR", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, { DOWNLOAD_TOKEN: "." });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_CONFIGURATION_ERROR");
    });

    it("L5: DOWNLOAD_TOKEN='..' → 500 CONFIGURATION_ERROR", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket, { DOWNLOAD_TOKEN: ".." });
      expect(res.status).toBe(500);
    });

    it("L6: UID collision — two providers with same UID → 409", async () => {
      await seedMainConfig(bucket);
      // Two providers sharing the same subscriptionId → same computed UID.
      // The collision detection code checks uidMap.has(profileUid),
      // which is the same code path as a real SHA-256 prefix collision.
      await seedV1Provider(bucket, {
        slug: "alpha",
        subscriptionId: "sub-same-uid",
      });
      await seedV1Provider(bucket, {
        slug: "beta",
        subscriptionId: "sub-same-uid",
      });
      const res = await callUnifiedExport(bucket);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNIFIED_EXPORT_UID_CONFLICT");
    });

    it("L7: manifest excludes directory entries", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      for (const key of Object.keys(manifest.files)) {
        expect(key.endsWith("/")).toBe(false);
      }
    });

    it("L8: provider extension files are required=false", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket, { slug: "my-provider" });
      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      expect(manifest.files["config.yaml"].required).toBe(true);
      expect(manifest.files["verge.yaml"].required).toBe(true);
      expect(manifest.files["profiles.yaml"].required).toBe(true);
      expect(
        manifest.files["providers/my-provider/provider.yaml"].required,
      ).toBe(false);
      expect(
        manifest.files["providers/my-provider/profile.yaml"].required,
      ).toBe(false);
      expect(manifest.files["providers/my-provider/meta.json"].required).toBe(
        false,
      );
    });

    it("L9: llm/ credential objects never enter the archive", async () => {
      await seedMainConfig(bucket);
      await seedV1Provider(bucket);
      // Credentials are stored under their own prefix; the export must stay
      // structurally blind to them so they cannot reach a WebDAV backup.
      bucket.store.set("llm/deepseek-main/meta.v1.json", "{}");
      bucket.store.set(
        "llm/deepseek-main/secret.v1.enc.json",
        '{"schemaVersion":1,"ciphertext":"AAAA"}',
      );

      const res = await callUnifiedExport(bucket);
      const data = new Uint8Array(await res.arrayBuffer());
      const files = parseZip(data);

      for (const [name] of files) {
        expect(name.startsWith("llm/")).toBe(false);
      }
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      );
      for (const name of Object.keys(manifest.files)) {
        expect(name.startsWith("llm/")).toBe(false);
      }
      expect(manifest.airports).toHaveLength(1);
    });
  });
});
