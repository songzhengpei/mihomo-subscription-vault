import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/types.ts";
import { handleConfig, handleMainConfig } from "../src/routes/config.ts";
import { parseUnifiedImport } from "../src/services/unified-import.ts";
import { isProviderVersionMeta } from "../src/services/storage.ts";
import jsYaml from "js-yaml";

class MockR2Bucket {
  store = new Map<string, string>();
  etags = new Map<string, string>();
  headCalls: string[] = [];
  getCalls: string[] = [];

  async get(key: string): Promise<unknown> {
    this.getCalls.push(key);
    const stored = this.store.get(key);
    if (stored === undefined) return null;
    const data: string = stored;
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
      range: null,
      storageClass: null,
      customMetadata: null,
      uploaded: new Date(),
      httpMetadata: null,
    };
  }

  async head(key: string): Promise<unknown> {
    this.headCalls.push(key);
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

  async list(opts?: { prefix?: string }) {
    const prefix = opts?.prefix || "";
    return {
      objects: [...this.store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k })),
      delimitedPrefixes: [],
      truncated: false,
      cursor: undefined,
    };
  }

  clear() {
    this.store.clear();
    this.etags.clear();
    this.headCalls = [];
    this.getCalls = [];
  }
  resetSpies() {
    this.headCalls = [];
    this.getCalls = [];
  }
}

function makeEnv(bucket: MockR2Bucket) {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN: "admin-test-token",
    DOWNLOAD_TOKEN: "test-download-token",
    PUBLIC_BASE_URL: "https://example.com",
  } as Env;
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
async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
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
async function readError(res: Response) {
  return res.json() as Promise<{
    ok: boolean;
    error: { code: string; message: string };
  }>;
}

function parseStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (
    offset + 30 <= bytes.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

// --- Seed helpers ---

async function seedV1Provider(
  bucket: MockR2Bucket,
  opts?: {
    slug?: string;
    versionId?: string;
    profileYaml?: string;
    providerYaml?: string;
    rawContent?: string;
    subscriptionUserinfo?: string;
    profileUpdateInterval?: string;
    profileWebPageUrl?: string;
    legacy?: boolean;
    corruptProfileSha?: boolean;
    corruptProfileSize?: boolean;
    missingProfile?: boolean;
    corruptMetaSha?: boolean;
    wrongPointerSlug?: boolean;
    wrongPointerMetaKey?: boolean;
  },
) {
  const slug = opts?.slug ?? "test-provider";
  const vid = opts?.versionId ?? "20260715T120000Z-abcd1234";
  const pYaml =
    opts?.profileYaml ?? "mixed-port: 7890\nallow-lan: true\nmode: rule\n";
  const prYaml =
    opts?.providerYaml ?? "- name: node1\n  type: ss\n  server: 1.2.3.4\n";
  const raw = opts?.rawContent ?? "raw subscription content\n";
  const pSha = await sha256Hex(pYaml),
    prSha = await sha256Hex(prYaml),
    rSha = await sha256Hex(raw);
  const keys = {
    raw: `providers/${slug}/versions/${vid}/raw.yaml`,
    provider: `providers/${slug}/versions/${vid}/provider.yaml`,
    profile: `providers/${slug}/versions/${vid}/profile.yaml`,
    meta: `providers/${slug}/versions/${vid}/meta.json`,
    latest: `providers/${slug}/latest.json`,
  };
  const meta = {
    schemaVersion: 1,
    providerSlug: slug,
    subscriptionId: "sub-001",
    uid: "R12345678",
    versionId: vid,
    createdAt: "2026-07-15T12:00:00.000Z",
    sourceSha256: rSha,
    nodeCount: 1,
    generatorVersion: "1.0.0",
    distribution: {
      providerName: "Test Provider",
      sourceHost: "example.com",
      subscriptionUserinfo: opts?.subscriptionUserinfo,
      profileUpdateInterval: opts?.profileUpdateInterval,
      profileWebPageUrl: opts?.profileWebPageUrl,
    },
    artifacts: {
      raw: { key: keys.raw, sha256: rSha, contentLength: clb(raw) },
      provider: {
        key: keys.provider,
        sha256: prSha,
        contentLength: clb(prYaml),
      },
      profile: {
        key: keys.profile,
        sha256: opts?.corruptProfileSha ? "a".repeat(64) : pSha,
        contentLength: opts?.corruptProfileSize ? clb(pYaml) + 100 : clb(pYaml),
      },
    },
  };
  if (opts?.legacy) {
    bucket.store.set(
      keys.latest,
      JSON.stringify(
        {
          versionId: vid,
          sha256: prSha,
          updatedAt: "2026-07-15T12:00:00.000Z",
        },
        null,
        2,
      ),
    );
    bucket.store.set(
      `providers/${slug}/versions/${vid}.json`,
      JSON.stringify(
        {
          versionId: vid,
          providerSlug: slug,
          providerName: "Test",
          createdAt: "2026-07-15T12:00:00.000Z",
          sha256: prSha,
          nodeCount: 1,
          sourceHost: "example.com",
          contentLength: clb(prYaml),
        },
        null,
        2,
      ),
    );
    bucket.store.set(`providers/${slug}/versions/${vid}.yaml`, prYaml);
    return {
      slug,
      versionId: vid,
      profileSha256: pSha,
      profileContentLength: clb(pYaml),
      metaSha256: "",
      pointerEtag: "",
    };
  }
  const metaJson = JSON.stringify(sortKeysDeep(meta), null, 2);
  const metaSha = opts?.corruptMetaSha
    ? "b".repeat(64)
    : await sha256Hex(metaJson);
  const pointer = {
    schemaVersion: 1,
    providerSlug: opts?.wrongPointerSlug ? "wrong-slug" : slug,
    subscriptionId: "sub-001",
    uid: "R12345678",
    versionId: vid,
    publishedAt: "2026-07-15T12:00:00.000Z",
    metaKey: opts?.wrongPointerMetaKey
      ? `providers/${slug}/versions/${vid}/wrong.json`
      : keys.meta,
    metaSha256: metaSha,
  };
  const pEtag = `"pointer-${Date.now()}"`;
  bucket.store.set(keys.latest, JSON.stringify(pointer, null, 2));
  bucket.etags.set(keys.latest, pEtag);
  bucket.store.set(keys.meta, metaJson);
  bucket.store.set(keys.raw, raw);
  bucket.store.set(keys.provider, prYaml);
  if (!opts?.missingProfile) bucket.store.set(keys.profile, pYaml);
  return {
    slug,
    versionId: vid,
    profileSha256: pSha,
    profileContentLength: clb(pYaml),
    metaSha256: metaSha,
    pointerEtag: pEtag,
  };
}

async function seedMainConfig(
  bucket: MockR2Bucket,
  opts?: {
    name?: string;
    yaml?: string;
    status?: "active" | "disabled";
    corruptLatestJson?: boolean;
    corruptLatestSchema?: boolean;
    missingIdentity?: boolean;
    corruptIdentityJson?: boolean;
    corruptIdentitySchema?: boolean;
    wrongConfigId?: boolean;
    wrongMetaKey?: boolean;
    missingMeta?: boolean;
    corruptMetaJson?: boolean;
    corruptMetaSha?: boolean;
    wrongArtifactKey?: boolean;
    missingYaml?: boolean;
    corruptYamlSize?: boolean;
    corruptYamlSha?: boolean;
  },
) {
  const yaml = opts?.yaml ?? "mixed-port: 7890\nallow-lan: true\nmode: rule\n";
  const name = opts?.name ?? "my-config";
  const status = opts?.status ?? "active";
  const cid = "test-config-id-001",
    vid = "mc-v0001";
  const ySha = await sha256Hex(yaml);
  const art = {
    key: opts?.wrongArtifactKey
      ? `vault/main-config/versions/${vid}/wrong.yaml`
      : `vault/main-config/versions/${vid}/main-config.yaml`,
    sha256: ySha,
    contentLength: opts?.corruptYamlSize ? clb(yaml) + 100 : clb(yaml),
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
  const metaSha = opts?.corruptMetaSha
    ? "c".repeat(64)
    : await sha256Hex(metaJson);
  const identity = {
    schemaVersion: 1,
    configId: opts?.wrongConfigId ? "wrong-cid" : cid,
    createdAt: "2026-07-14T00:00:00.000Z",
  };
  const pointer: Record<string, unknown> = {
    schemaVersion: 1,
    configId: cid,
    versionId: vid,
    status,
    publishedAt: "2026-07-15T12:00:00.000Z",
    metaKey: opts?.wrongMetaKey
      ? `vault/main-config/versions/${vid}/wrong.json`
      : `vault/main-config/versions/${vid}/meta.json`,
    metaSha256: metaSha,
  };
  if (status === "disabled") pointer.disabledAt = "2026-07-15T13:00:00.000Z";
  if (opts?.corruptLatestJson)
    bucket.store.set("vault/main-config/latest.json", "bad json");
  else if (opts?.corruptLatestSchema)
    bucket.store.set(
      "vault/main-config/latest.json",
      JSON.stringify({ bad: "schema" }),
    );
  else
    bucket.store.set(
      "vault/main-config/latest.json",
      JSON.stringify(pointer, null, 2),
    );
  if (!opts?.missingIdentity) {
    if (opts?.corruptIdentityJson)
      bucket.store.set("vault/main-config/identity.json", "bad json");
    else if (opts?.corruptIdentitySchema)
      bucket.store.set(
        "vault/main-config/identity.json",
        JSON.stringify({ bad: "schema" }),
      );
    else
      bucket.store.set(
        "vault/main-config/identity.json",
        JSON.stringify(identity, null, 2),
      );
  }
  if (!opts?.missingMeta) {
    if (opts?.corruptMetaJson)
      bucket.store.set(
        `vault/main-config/versions/${vid}/meta.json`,
        "bad json",
      );
    else
      bucket.store.set(`vault/main-config/versions/${vid}/meta.json`, metaJson);
  }
  if (!opts?.missingYaml)
    bucket.store.set(
      `vault/main-config/versions/${vid}/main-config.yaml`,
      opts?.corruptYamlSha ? yaml + "\n# extra" : yaml,
    );
  return {
    yamlSha256: ySha,
    yamlContentLength: clb(yaml),
    metaSha256: metaSha,
  };
}

describe("/config/:slug/:token", () => {
  let bucket: MockR2Bucket;
  let env: Env;
  beforeEach(() => {
    bucket = new MockR2Bucket();
    env = makeEnv(bucket);
  });

  describe("A. Route and auth", () => {
    it("A1: GET valid token → 200", async () => {
      await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(200);
    });
    it("A2: HEAD uses head() not get() for profile", async () => {
      await seedV1Provider(bucket);
      bucket.resetSpies();
      await handleConfig(
        makeRequest("HEAD", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(bucket.headCalls.length).toBeGreaterThan(0);
      expect(bucket.getCalls).not.toContain(
        "providers/test-provider/versions/20260715T120000Z-abcd1234/profile.yaml",
      );
    });
    it("A5: POST → 405 Allow: GET, HEAD", async () => {
      const res = await handleConfig(
        makeRequest("POST", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
      expect((await readError(res)).error.code).toBe("METHOD_NOT_ALLOWED");
    });
    it("A5: PUT → 405", async () => {
      expect(
        (
          await handleConfig(
            makeRequest("PUT", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(405);
    });
    it("A5: DELETE → 405", async () => {
      expect(
        (
          await handleConfig(
            makeRequest("DELETE", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(405);
    });
    it("A6: Bad token → 403", async () => {
      await seedV1Provider(bucket);
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/wrong"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(403);
      expect((await readError(res)).error.code).toBe("FORBIDDEN");
    });
    it("A8: Bad slug → 400", async () => {
      const res = await handleConfig(
        makeRequest("GET", "/config/BAD/test-download-token"),
        env,
        "BAD",
      );
      expect(res.status).toBe(400);
      expect((await readError(res)).error.code).toBe("INVALID_SLUG");
    });
    it("A10: Error body has no token", async () => {
      const body = await (
        await handleConfig(
          makeRequest("GET", "/config/test-provider/wrong-token"),
          env,
          "test-provider",
        )
      ).text();
      expect(body).not.toContain("wrong-token");
      expect(body).not.toContain("test-download-token");
    });
  });

  describe("B. Success", () => {
    it("B0: negotiated Worker v1 capsule preserves authoritative identity and artifacts", async () => {
      const providerYaml =
        "proxies:\n  - {name: node-1, type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: test}\n";
      const profileYaml = `${providerYaml}proxy-groups:\n  - {name: Proxy, type: select, proxies: [node-1]}\nrules:\n  - MATCH,Proxy\n`;
      await seedV1Provider(bucket, { providerYaml, profileYaml });

      const requestUrl =
        "https://example.com/config/test-provider/test-download-token";
      const response = await handleConfig(
        new Request(requestUrl, {
          headers: {
            Accept: "application/vnd.mihomo-unified-backup+zip; version=1",
          },
        }),
        env,
        "test-provider",
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/vnd.mihomo-unified-backup+zip; version=1",
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

      const archive = new Uint8Array(await response.arrayBuffer());
      const files = parseStoredZip(archive);
      const expectedPaths = [
        "manifest.json",
        "config.yaml",
        "verge.yaml",
        "profiles.yaml",
        "profiles/R12345678.yaml",
        "providers/test-provider/provider.yaml",
        "providers/test-provider/profile.yaml",
        "providers/test-provider/meta.json",
      ];
      for (const path of expectedPaths) expect(files.has(path)).toBe(true);

      expect(new TextDecoder().decode(files.get("config.yaml")!)).toBe(
        "mixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\n",
      );
      expect(files.get("providers/test-provider/provider.yaml")).toEqual(
        new TextEncoder().encode(providerYaml),
      );
      expect(files.get("providers/test-provider/profile.yaml")).toEqual(
        new TextEncoder().encode(profileYaml),
      );
      expect(files.get("profiles/R12345678.yaml")).toEqual(
        new TextEncoder().encode(profileYaml),
      );

      const meta = JSON.parse(
        new TextDecoder().decode(
          files.get("providers/test-provider/meta.json")!,
        ),
      );
      expect(isProviderVersionMeta(meta)).toBe(true);

      const profiles = jsYaml.load(
        new TextDecoder().decode(files.get("profiles.yaml")!),
      ) as { items: Array<{ uid: string; url: string }> };
      expect(profiles.items).toEqual([
        expect.objectContaining({ uid: "R12345678", url: requestUrl }),
      ]);

      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")!),
      ) as {
        format: string;
        formatVersion: number;
        archiveType: string;
        mainConfig: Record<string, string>;
        airports: Array<Record<string, unknown>>;
        files: Record<string, { sha256: string; contentLength: number }>;
      };
      expect(manifest).toMatchObject({
        format: "mihomo-unified-backup",
        formatVersion: 1,
        archiveType: "unified-subscription-archive",
        mainConfig: {
          configId: "system-minimal-compat",
          versionId: "sha256-451444cc8d6401ec",
          name: "Clash Verge compatibility config",
          sourceSha256:
            "451444cc8d6401ec9a7b57ed977053039e00a8b451827ec37b0e15ca8f808ec9",
        },
        airports: [
          expect.objectContaining({
            slug: "test-provider",
            subscriptionId: "sub-001",
            profileUid: "R12345678",
            versionId: "20260715T120000Z-abcd1234",
          }),
        ],
      });
      for (const [path, declared] of Object.entries(manifest.files)) {
        const actual = files.get(path)!;
        const digest = await crypto.subtle.digest("SHA-256", actual);
        const hex = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        expect(declared.contentLength, path).toBe(actual.length);
        expect(declared.sha256, path).toBe(hex);
      }

      await expect(
        parseUnifiedImport(archive, "https://example.com"),
      ).resolves.toMatchObject({ providers: [{ profileUid: "R12345678" }] });
    });

    it("B1: Returns profile.yaml not provider.yaml", async () => {
      await seedV1Provider(bucket, {
        profileYaml: "profile: true\n",
        providerYaml: "provider: true\n",
      });
      expect(
        await (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).text(),
      ).toBe("profile: true\n");
    });
    it("B2: Bytes match R2", async () => {
      await seedV1Provider(bucket, { profileYaml: "a: b\n" });
      const buf = await (
        await handleConfig(
          makeRequest("GET", "/config/test-provider/test-download-token"),
          env,
          "test-provider",
        )
      ).arrayBuffer();
      expect(new Uint8Array(buf)).toEqual(new TextEncoder().encode("a: b\n"));
    });
    it("B3: ETag = profile SHA-256", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).headers.get("ETag"),
      ).toBe(`"${profileSha256}"`);
    });
    it("B4: Content-Length correct", async () => {
      const { profileContentLength } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).headers.get("Content-Length"),
      ).toBe(String(profileContentLength));
    });
    it("B5: Optional headers present", async () => {
      await seedV1Provider(bucket, {
        subscriptionUserinfo: "up=1",
        profileUpdateInterval: "24",
        profileWebPageUrl: "https://x.com",
      });
      const h = (
        await handleConfig(
          makeRequest("GET", "/config/test-provider/test-download-token"),
          env,
          "test-provider",
        )
      ).headers;
      expect(h.get("subscription-userinfo")).toBe("up=1");
      expect(h.get("profile-update-interval")).toBe("24");
      expect(h.get("profile-web-page-url")).toBe("https://x.com");
    });
    it("B6: Optional headers absent", async () => {
      await seedV1Provider(bucket);
      const h = (
        await handleConfig(
          makeRequest("GET", "/config/test-provider/test-download-token"),
          env,
          "test-provider",
        )
      ).headers;
      expect(h.get("subscription-userinfo")).toBeNull();
    });
    it("B6: CR/LF filtered", async () => {
      await seedV1Provider(bucket, { subscriptionUserinfo: "val\r\ninjected" });
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).headers.get("subscription-userinfo"),
      ).toBeNull();
    });
    it("B7: HEAD 200 no body correct headers", async () => {
      const { profileSha256, profileContentLength } =
        await seedV1Provider(bucket);
      const res = await handleConfig(
        makeRequest("HEAD", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe(`"${profileSha256}"`);
      expect(res.headers.get("Content-Length")).toBe(
        String(profileContentLength),
      );
    });
    it("B8: HEAD only calls head() for profile", async () => {
      await seedV1Provider(bucket);
      bucket.resetSpies();
      await handleConfig(
        makeRequest("HEAD", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(bucket.headCalls).toContain(
        "providers/test-provider/versions/20260715T120000Z-abcd1234/profile.yaml",
      );
      expect(bucket.getCalls).not.toContain(
        "providers/test-provider/versions/20260715T120000Z-abcd1234/profile.yaml",
      );
    });
  });

  describe("C. Corruption", () => {
    it("C1: Missing → 404", async () => {
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/nope/test-download-token"),
            env,
            "nope",
          )
        ).status,
      ).toBe(404);
    });
    it("C2: No latest → 404", async () => {
      bucket.store.set("providers/test-provider/staging/s1.json", "{}");
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(404);
    });
    it("C3: Legacy → 409", async () => {
      await seedV1Provider(bucket, { legacy: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(409);
      expect((await readError(res)).error.code).toBe("CONFIG_NOT_AVAILABLE");
    });
    it("C4: Bad JSON → 500", async () => {
      bucket.store.set("providers/test-provider/latest.json", "bad");
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C5: Bad Pointer Schema → 500", async () => {
      bucket.store.set(
        "providers/test-provider/latest.json",
        JSON.stringify({ bad: "schema" }),
      );
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C6: Pointer slug mismatch → 500", async () => {
      await seedV1Provider(bucket, { wrongPointerSlug: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C7: Pointer metaKey wrong → 500", async () => {
      await seedV1Provider(bucket, { wrongPointerMetaKey: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C8: meta missing → 500", async () => {
      bucket.store.set(
        "providers/p/latest.json",
        JSON.stringify(
          {
            schemaVersion: 1,
            providerSlug: "p",
            subscriptionId: "s",
            uid: "u",
            versionId: "v1",
            publishedAt: "2026-07-15T12:00:00.000Z",
            metaKey: "providers/p/versions/v1/meta.json",
            metaSha256: "a".repeat(64),
          },
          null,
          2,
        ),
      );
      const res = await handleConfig(
        makeRequest("GET", "/config/p/test-download-token"),
        env,
        "p",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C10: meta SHA mismatch → 500", async () => {
      await seedV1Provider(bucket, { corruptMetaSha: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C12: profile missing GET → 500", async () => {
      await seedV1Provider(bucket, { missingProfile: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C12: profile missing HEAD → 500", async () => {
      await seedV1Provider(bucket, { missingProfile: true });
      expect(
        (
          await handleConfig(
            makeRequest("HEAD", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(500);
    });
    it("C13: profile size wrong GET → 500", async () => {
      await seedV1Provider(bucket, { corruptProfileSize: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C13: profile size wrong HEAD → 500", async () => {
      await seedV1Provider(bucket, { corruptProfileSize: true });
      expect(
        (
          await handleConfig(
            makeRequest("HEAD", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(500);
    });
    it("C14: profile same size bad SHA → 500", async () => {
      await seedV1Provider(bucket, { corruptProfileSha: true });
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token"),
        env,
        "test-provider",
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("CONFIG_CORRUPTED");
    });
    it("C15: No fallback on corruption", async () => {
      await seedV1Provider(bucket, { profileYaml: "v1\n" });
      bucket.store.set(
        "providers/test-provider/versions/20260715T120000Z-abcd1234/profile.yaml",
        "corrupted",
      );
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token"),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(500);
    });
    it("G7: Error body has no R2 keys", async () => {
      await seedV1Provider(bucket, { missingProfile: true });
      const body = await (
        await handleConfig(
          makeRequest("GET", "/config/test-provider/test-download-token"),
          env,
          "test-provider",
        )
      ).text();
      expect(body).not.toContain("providers/test-provider");
      expect(body).not.toContain("meta.json");
    });
  });

  describe("E. Conditional", () => {
    it("E1: Strong ETag hit → 304", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `"${profileSha256}"` },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(304);
    });
    it("E2: ETag hit but corrupted → 500", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      bucket.store.set(
        "providers/test-provider/versions/20260715T120000Z-abcd1234/profile.yaml",
        "corrupted",
      );
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `"${profileSha256}"` },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(500);
    });
    it("E3: ETag miss → 200", async () => {
      await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": '"wrong"' },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(200);
    });
    it("E4: HEAD ETag hit → 304", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("HEAD", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `"${profileSha256}"` },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(304);
    });
    it("E6: Weak ETag → miss", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `W/"${profileSha256}"` },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(200);
    });
    it("E7: Multiple ETags → miss", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `"${profileSha256}", "other"` },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(200);
    });
    it("E8: * → miss", async () => {
      await seedV1Provider(bucket);
      expect(
        (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": "*" },
            }),
            env,
            "test-provider",
          )
        ).status,
      ).toBe(200);
    });
    it("E9: 304 preserves headers", async () => {
      const { profileSha256, profileContentLength } = await seedV1Provider(
        bucket,
        {
          subscriptionUserinfo: "up=1",
          profileUpdateInterval: "12",
          profileWebPageUrl: "https://x.com",
        },
      );
      const res = await handleConfig(
        makeRequest("GET", "/config/test-provider/test-download-token", {
          headers: { "If-None-Match": `"${profileSha256}"` },
        }),
        env,
        "test-provider",
      );
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(`"${profileSha256}"`);
      expect(res.headers.get("Content-Length")).toBe(
        String(profileContentLength),
      );
      expect(res.headers.get("subscription-userinfo")).toBe("up=1");
    });
    it("E10: 304 no body", async () => {
      const { profileSha256 } = await seedV1Provider(bucket);
      expect(
        await (
          await handleConfig(
            makeRequest("GET", "/config/test-provider/test-download-token", {
              headers: { "If-None-Match": `"${profileSha256}"` },
            }),
            env,
            "test-provider",
          )
        ).text(),
      ).toBe("");
    });
  });
});

describe("/main-config/:token", () => {
  let bucket: MockR2Bucket;
  let env: Env;
  beforeEach(() => {
    bucket = new MockR2Bucket();
    env = makeEnv(bucket);
  });

  describe("A. Route and auth", () => {
    it("A3: GET valid token → 200", async () => {
      await seedMainConfig(bucket);
      expect(
        (
          await handleMainConfig(
            makeRequest("GET", "/main-config/test-download-token"),
            env,
          )
        ).status,
      ).toBe(200);
    });
    it("A4: HEAD uses head() not get()", async () => {
      await seedMainConfig(bucket);
      bucket.resetSpies();
      await handleMainConfig(
        makeRequest("HEAD", "/main-config/test-download-token"),
        env,
      );
      expect(bucket.headCalls.some((k) => k.includes("main-config.yaml"))).toBe(
        true,
      );
      expect(
        bucket.getCalls.filter((k) => k.includes("main-config.yaml")).length,
      ).toBe(0);
    });
    it("A5: POST → 405", async () => {
      expect(
        (
          await handleMainConfig(
            makeRequest("POST", "/main-config/test-download-token"),
            env,
          )
        ).status,
      ).toBe(405);
    });
    it("A6: Bad token → 403", async () => {
      await seedMainConfig(bucket);
      expect(
        (await handleMainConfig(makeRequest("GET", "/main-config/wrong"), env))
          .status,
      ).toBe(403);
    });
    it("A10: Error body has no token", async () => {
      const body = await (
        await handleMainConfig(makeRequest("GET", "/main-config/wrong"), env)
      ).text();
      expect(body).not.toContain("wrong");
    });
  });

  describe("D. Corruption", () => {
    it("D1: Never created → 404", async () => {
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(404);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_NOT_FOUND");
    });
    it("D3: Disabled GET → 404", async () => {
      await seedMainConfig(bucket, { status: "disabled" });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(404);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_NOT_FOUND");
    });
    it("D3: Disabled HEAD → 404", async () => {
      await seedMainConfig(bucket, { status: "disabled" });
      expect(
        (
          await handleMainConfig(
            makeRequest("HEAD", "/main-config/test-download-token"),
            env,
          )
        ).status,
      ).toBe(404);
    });
    it("D4: Bad latest JSON → 500", async () => {
      await seedMainConfig(bucket, { corruptLatestJson: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D5: Identity missing → 500", async () => {
      await seedMainConfig(bucket, { missingIdentity: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D6: Bad identity JSON → 500", async () => {
      await seedMainConfig(bucket, { corruptIdentityJson: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D6: Bad identity Schema → 500", async () => {
      await seedMainConfig(bucket, { corruptIdentitySchema: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D7: configId mismatch → 500", async () => {
      await seedMainConfig(bucket, { wrongConfigId: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D8: metaKey wrong → 500", async () => {
      await seedMainConfig(bucket, { wrongMetaKey: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D9: meta missing → 500", async () => {
      await seedMainConfig(bucket, { missingMeta: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D10: meta bad JSON → 500", async () => {
      await seedMainConfig(bucket, { corruptMetaJson: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D11: meta SHA wrong → 500", async () => {
      await seedMainConfig(bucket, { corruptMetaSha: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D12: artifact key wrong → 500", async () => {
      await seedMainConfig(bucket, { wrongArtifactKey: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D13: YAML missing → 500", async () => {
      await seedMainConfig(bucket, { missingYaml: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D14: YAML size wrong → 500", async () => {
      await seedMainConfig(bucket, { corruptYamlSize: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D15: YAML same size bad SHA → 500", async () => {
      await seedMainConfig(bucket, { corruptYamlSha: true });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
      expect((await readError(res)).error.code).toBe("MAIN_CONFIG_CORRUPTED");
    });
    it("D16: Disabled + YAML corrupted GET → 500", async () => {
      await seedMainConfig(bucket, {
        status: "disabled",
        corruptYamlSha: true,
      });
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
    });
    it("D16: Disabled + YAML missing HEAD → 500", async () => {
      await seedMainConfig(bucket, { status: "disabled", missingYaml: true });
      const res = await handleMainConfig(
        makeRequest("HEAD", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
    });
    it("D16: Disabled + meta SHA wrong HEAD → 500 (detected by core resolver)", async () => {
      await seedMainConfig(bucket, {
        status: "disabled",
        corruptMetaSha: true,
      });
      const res = await handleMainConfig(
        makeRequest("HEAD", "/main-config/test-download-token"),
        env,
      );
      expect(res.status).toBe(500);
    });
    it("G7: Error body has no R2 keys", async () => {
      await seedMainConfig(bucket, { missingYaml: true });
      const body = await (
        await handleMainConfig(
          makeRequest("GET", "/main-config/test-download-token"),
          env,
        )
      ).text();
      expect(body).not.toContain("vault/main-config");
      expect(body).not.toContain("meta.json");
    });
  });

  describe("E. Conditional", () => {
    it("E1: Strong ETag hit → 304", async () => {
      const { yamlSha256 } = await seedMainConfig(bucket);
      expect(
        (
          await handleMainConfig(
            makeRequest("GET", "/main-config/test-download-token", {
              headers: { "If-None-Match": `"${yamlSha256}"` },
            }),
            env,
          )
        ).status,
      ).toBe(304);
    });
    it("E3: ETag miss → 200", async () => {
      await seedMainConfig(bucket);
      expect(
        (
          await handleMainConfig(
            makeRequest("GET", "/main-config/test-download-token", {
              headers: { "If-None-Match": '"wrong"' },
            }),
            env,
          )
        ).status,
      ).toBe(200);
    });
    it("E9: 304 preserves headers", async () => {
      const { yamlSha256, yamlContentLength } = await seedMainConfig(bucket);
      const res = await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token", {
          headers: { "If-None-Match": `"${yamlSha256}"` },
        }),
        env,
      );
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(`"${yamlSha256}"`);
      expect(res.headers.get("Content-Length")).toBe(String(yamlContentLength));
    });
    it("E10: 304 no body", async () => {
      const { yamlSha256 } = await seedMainConfig(bucket);
      expect(
        await (
          await handleMainConfig(
            makeRequest("GET", "/main-config/test-download-token", {
              headers: { "If-None-Match": `"${yamlSha256}"` },
            }),
            env,
          )
        ).text(),
      ).toBe("");
    });
  });

  describe("F. ETag lifecycle", () => {
    it("F3: Different YAML → different ETag", async () => {
      const { yamlSha256: s1 } = await seedMainConfig(bucket, { yaml: "v1\n" });
      bucket.clear();
      const { yamlSha256: s2 } = await seedMainConfig(bucket, { yaml: "v2\n" });
      expect(s1).not.toBe(s2);
    });
    it("F4: Same YAML different name → same ETag", async () => {
      const { yamlSha256: s1 } = await seedMainConfig(bucket, {
        yaml: "x\n",
        name: "A",
      });
      bucket.clear();
      const { yamlSha256: s2 } = await seedMainConfig(bucket, {
        yaml: "x\n",
        name: "B",
      });
      expect(s1).toBe(s2);
    });
    it("F5: Disable/enable same content → same ETag", async () => {
      const { yamlSha256: s1 } = await seedMainConfig(bucket, {
        yaml: "x\n",
        status: "active",
      });
      bucket.clear();
      const { yamlSha256: s2 } = await seedMainConfig(bucket, {
        yaml: "x\n",
        status: "disabled",
      });
      expect(s1).toBe(s2);
    });
  });

  describe("G. Side effects", () => {
    it("G4: 0 R2 writes on public GET", async () => {
      await seedMainConfig(bucket);
      let putCount = 0;
      const orig = bucket.put.bind(bucket);
      bucket.put = async (...a: Parameters<typeof orig>) => {
        putCount++;
        return orig(...a);
      };
      await handleMainConfig(
        makeRequest("GET", "/main-config/test-download-token"),
        env,
      );
      expect(putCount).toBe(0);
    });
  });
});
