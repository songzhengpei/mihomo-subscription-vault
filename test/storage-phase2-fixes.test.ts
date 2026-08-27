import { describe, it, expect, beforeEach } from "vitest";
import {
  publishProviderVersion,
  getVersionKeys,
  getLatest,
  getVersionYaml,
  getProviderMeta,
  listVersions,
  getVersionYamlForExport,
  getVersionJsonForExport,
  getLatestJsonForExport,
  rollbackLatest,
  VersionPublishError,
} from "../src/services/storage.ts";
import { isLatestVersionPointerV1 } from "../src/types.ts";
import type {
  PublishVersionInput,
  PublishDependencies,
  LatestJson,
  LatestVersionPointer,
  StoredLatestPointer,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Enhanced Mock R2Bucket with bodyUsed tracking
// ---------------------------------------------------------------------------

class MockR2Bucket {
  store = new Map<string, string>();
  etags = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    const stored = this.store.get(key);
    if (stored === undefined) return null;
    const data: string = stored;
    const etag = this.etags.get(key) || `"${data.length}"`;
    let bodyUsed = false;

    function consume(): string {
      if (bodyUsed) {
        throw new TypeError("Body has already been used");
      }
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
      async blob() {
        return new Blob([new TextEncoder().encode(consume())]);
      },
      size: new TextEncoder().encode(data).length,
      checksums: {},
      writeHttpMetadata(_headers: Record<string, string>) {},
      range: null,
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
  ): Promise<{ key: string } | null> {
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit).text();

    if (opts?.onlyIf) {
      const currentEtag = this.etags.get(key);
      if (opts.onlyIf.etagDoesNotMatch === "*") {
        if (currentEtag !== undefined) return null;
      } else if (opts.onlyIf.etagMatches !== undefined) {
        if (!currentEtag || currentEtag !== opts.onlyIf.etagMatches)
          return null;
      }
    }

    const newEtag = `"${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}"`;
    this.store.set(key, text);
    this.etags.set(key, newEtag);
    return { key };
  }

  async list(opts?: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts?.prefix || "";
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
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

  has(key: string): boolean {
    return this.store.has(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  tamperContent(key: string, newContent: string): void {
    if (this.store.has(key)) {
      this.store.set(key, newContent);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockBucket = new MockR2Bucket();

function createTestInput(
  overrides: Partial<PublishVersionInput> = {},
): PublishVersionInput {
  return {
    providerSlug: "test-provider",
    subscriptionId: "sub-123",
    uid: "uid-456",
    rawContent:
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443",
    providerYaml:
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443",
    profileYaml:
      "mixed-port: 7890\nproxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443",
    nodeCount: 1,
    generatorVersion: "1.0.0",
    distribution: {
      providerName: "Test Provider",
      sourceHost: "example.com",
    },
    ...overrides,
  };
}

function fixedDeps(
  versionId = "20260101T000000Z-aaaaaaaa-bbbbbbbbbbbbbbbb",
): PublishDependencies {
  return {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateVersionId: () => versionId,
  };
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function writeLegacyLatest(
  bucket: MockR2Bucket,
  slug: string,
  data: LatestJson,
): Promise<void> {
  await bucket.put(`providers/${slug}/latest.json`, JSON.stringify(data));
}

async function writeLegacyVersionYaml(
  bucket: MockR2Bucket,
  slug: string,
  versionId: string,
  yaml: string,
): Promise<void> {
  await bucket.put(`providers/${slug}/versions/${versionId}.yaml`, yaml);
}

async function writeLegacyVersionMeta(
  bucket: MockR2Bucket,
  slug: string,
  versionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await bucket.put(
    `providers/${slug}/versions/${versionId}.json`,
    JSON.stringify(meta),
  );
}

// ---------------------------------------------------------------------------
// 1. R2 Body single consumption
// ---------------------------------------------------------------------------

describe("R2 Body single consumption", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("second call on same R2ObjectBody throws TypeError", async () => {
    await mockBucket.put("test-key", "hello");
    const obj = (await mockBucket.get("test-key")) as any;

    expect(obj).not.toBeNull();
    expect(obj.bodyUsed).toBe(false);

    await obj.text();
    expect(obj.bodyUsed).toBe(true);

    await expect(obj.text()).rejects.toThrow(TypeError);
    await expect(obj.json()).rejects.toThrow(TypeError);
    await expect(obj.arrayBuffer()).rejects.toThrow(TypeError);
    await expect(obj.blob()).rejects.toThrow(TypeError);
  });

  it("idempotent reuse succeeds without double body consumption", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-body001";
    const deps = fixedDeps(versionId);

    const result1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const result2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    expect(result2.versionId).toBe(versionId);
    expect(result1.meta.sourceSha256).toBe(result2.meta.sourceSha256);
  });
});

// ---------------------------------------------------------------------------
// 2. SHA-256 uses provider.yaml hash, not rawContent
// ---------------------------------------------------------------------------

describe("SHA-256 uses provider.yaml hash", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rawContent and providerYaml can differ — sha256 tracks provider.yaml", async () => {
    const rawContent =
      "mixed-port: 7890\n# extra comment\nproxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443\nproxy-groups:\n  - name: auto\n    type: url-test";
    const providerYaml =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";

    const input = createTestInput({ rawContent, providerYaml });
    const deps = fixedDeps("20260101T000000Z-9e20490d-sha001");
    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const providerSha = await sha256(providerYaml);
    const rawSha = await sha256(rawContent);

    expect(result.meta.artifacts.provider.sha256).toBe(providerSha);
    expect(result.meta.artifacts.provider.sha256).not.toBe(rawSha);
    expect(result.meta.sourceSha256).toBe(rawSha);
  });

  it("getLatest().sha256 returns provider.yaml hash for V1 pointer", async () => {
    const rawContent =
      "extra stuff\nproxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";
    const providerYaml =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";

    const input = createTestInput({ rawContent, providerYaml });
    const deps = fixedDeps("20260101T000000Z-9e20490d-sha002");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const latest = await getLatest(
      mockBucket as unknown as R2Bucket,
      "test-provider",
    );
    expect(latest).not.toBeNull();
    expect(latest!.sha256).toBe(await sha256(providerYaml));
  });

  it("getProviderMeta().sha256 returns provider.yaml hash for V1 version", async () => {
    const rawContent =
      "extra stuff\nproxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";
    const providerYaml =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";

    const input = createTestInput({ rawContent, providerYaml });
    const deps = fixedDeps("20260101T000000Z-9e20490d-sha003");
    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const meta = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      result.versionId,
    );
    expect(meta).not.toBeNull();
    expect(meta!.sha256).toBe(await sha256(providerYaml));
  });
});

// ---------------------------------------------------------------------------
// 3. New-format rollback
// ---------------------------------------------------------------------------

describe("New-format rollback", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rolls back from V2 to V1 while preserving V1 pointer format", async () => {
    const input = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-rb0001");
    const result1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    const input2 = createTestInput({
      generatorVersion: "2.0.0",
      distribution: {
        providerName: "Test Provider V2",
        sourceHost: "v2.example.com",
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-rb0002");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    const rollbackResult = await rollbackLatest(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      result1.versionId,
    );

    // Must be V1 pointer, not legacy
    expect(isLatestVersionPointerV1(rollbackResult)).toBe(true);
    const pointer = rollbackResult as LatestVersionPointer;
    expect(pointer.subscriptionId).toBe("sub-123");
    expect(pointer.uid).toBe("uid-456");
    expect(pointer.versionId).toBe(result1.versionId);

    // Fixed URL can read V1's provider.yaml
    const latest = await getLatest(
      mockBucket as unknown as R2Bucket,
      "test-provider",
    );
    expect(latest).not.toBeNull();
    expect(latest!.versionId).toBe(result1.versionId);
    expect(latest!.sha256).toBe(await sha256(input.providerYaml));

    const yaml = await getVersionYaml(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      result1.versionId,
    );
    expect(yaml).toBe(input.providerYaml);
  });

  it("identity protection still works after rollback", async () => {
    const input = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-rb0010");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    const input2 = createTestInput({ generatorVersion: "2.0.0" });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-rb0011");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Rollback to V1
    await rollbackLatest(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      await deps1.generateVersionId(""),
    );

    // Different subscriptionId should still conflict
    const input3 = createTestInput({ subscriptionId: "other-sub" });
    const deps3 = fixedDeps("20260101T000000Z-9e20490d-rb0012");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input3, deps3),
    ).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// 4. Legacy rollback
// ---------------------------------------------------------------------------

describe("Legacy rollback", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rolls back to legacy flat-file version and writes legacy pointer", async () => {
    const slug = "legacy-rollback";

    // Write legacy version
    const yaml =
      "proxies:\n  - name: legacy\n    type: ss\n    server: old.com\n    port: 443";
    await writeLegacyVersionYaml(mockBucket, slug, "v-legacy", yaml);
    await writeLegacyVersionMeta(mockBucket, slug, "v-legacy", {
      versionId: "v-legacy",
      providerSlug: slug,
      providerName: "Legacy",
      createdAt: "2025-01-01T00:00:00Z",
      sha256: await sha256(yaml),
      nodeCount: 1,
      sourceHost: "old.com",
      contentLength: yaml.length,
    });

    // Write V1 version
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-lgrb01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Rollback to legacy version
    const result = await rollbackLatest(
      mockBucket as unknown as R2Bucket,
      slug,
      "v-legacy",
    );

    // Must be legacy pointer
    expect(isLatestVersionPointerV1(result)).toBe(false);
    const legacy = result as LatestJson;
    expect(legacy.versionId).toBe("v-legacy");
    expect(legacy.sha256).toBe(await sha256(yaml));
  });
});

// ---------------------------------------------------------------------------
// 5. Backup v1 hash consistency
// ---------------------------------------------------------------------------

describe("Backup v1 hash consistency", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("exported YAML hash matches exported JSON sha256 and latest JSON sha256", async () => {
    const slug = "hash-consist";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-hc0001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const yamlBytes = await getVersionYamlForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      await deps.generateVersionId(""),
    );
    expect(yamlBytes).not.toBeNull();
    const yamlText = new TextDecoder().decode(yamlBytes!);

    const jsonBytes = await getVersionJsonForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      await deps.generateVersionId(""),
    );
    expect(jsonBytes).not.toBeNull();
    const jsonParsed = JSON.parse(new TextDecoder().decode(jsonBytes!));

    const latestBytes = await getLatestJsonForExport(
      mockBucket as unknown as R2Bucket,
      slug,
    );
    expect(latestBytes).not.toBeNull();
    const latestParsed = JSON.parse(new TextDecoder().decode(latestBytes!));

    // All three must use provider.yaml SHA-256
    const expectedSha = await sha256(yamlText);
    expect(jsonParsed.sha256).toBe(expectedSha);
    expect(latestParsed.sha256).toBe(expectedSha);
  });
});

// ---------------------------------------------------------------------------
// 6. Distribution metadata
// ---------------------------------------------------------------------------

describe("Distribution metadata persistence", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("persists and projects full distribution metadata", async () => {
    const slug = "dist-meta";
    const input = createTestInput({
      providerSlug: slug,
      distribution: {
        providerName: "My Airport",
        sourceHost: "airport.example.com",
        sourceType: "local",
        subscriptionUserinfo: "upload=100;download=200;total=1000;expire=99999",
        profileUpdateInterval: "24",
        profileWebPageUrl: "https://airport.example.com/dashboard",
        clientUpdatePolicy: {
          allowAutoUpdate: false,
          updateIntervalMinutes: 1440,
        },
      },
    });
    const deps = fixedDeps("20260101T000000Z-9e20490d-dst001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // meta.json should contain distribution
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    const metaRaw = mockBucket.getRaw(keys.meta);
    expect(metaRaw).toBeDefined();
    const metaParsed = JSON.parse(metaRaw!);
    expect(metaParsed.distribution.providerName).toBe("My Airport");
    expect(metaParsed.distribution.sourceHost).toBe("airport.example.com");
    expect(metaParsed.distribution.sourceType).toBe("local");
    expect(metaParsed.distribution.subscriptionUserinfo).toBe(
      "upload=100;download=200;total=1000;expire=99999",
    );
    expect(metaParsed.distribution.profileUpdateInterval).toBe("24");
    expect(metaParsed.distribution.clientUpdatePolicy).toEqual({
      allowAutoUpdate: false,
      updateIntervalMinutes: 1440,
    });
    expect(metaParsed.distribution.profileWebPageUrl).toBe(
      "https://airport.example.com/dashboard",
    );

    // getProviderMeta projects correctly
    const meta = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      slug,
      await deps.generateVersionId(""),
    );
    expect(meta).not.toBeNull();
    expect(meta!.providerName).toBe("My Airport");
    expect(meta!.sourceHost).toBe("airport.example.com");
    expect(meta!.subscriptionUserinfo).toBe(
      "upload=100;download=200;total=1000;expire=99999",
    );
    expect(meta!.profileUpdateInterval).toBe("24");
    expect(meta!.profileWebPageUrl).toBe(
      "https://airport.example.com/dashboard",
    );

    // listVersions sourceHost from distribution
    const items = await listVersions(mockBucket as unknown as R2Bucket, slug);
    expect(items.length).toBe(1);
    expect(items[0]!.sourceHost).toBe("airport.example.com");

    // backup v1 JSON has correct distribution in legacy projection
    const jsonBytes = await getVersionJsonForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      await deps.generateVersionId(""),
    );
    const jsonParsed = JSON.parse(new TextDecoder().decode(jsonBytes!));
    expect(jsonParsed.providerName).toBe("My Airport");
    expect(jsonParsed.sourceHost).toBe("airport.example.com");
    expect(jsonParsed.subscriptionUserinfo).toBe(
      "upload=100;download=200;total=1000;expire=99999",
    );
    expect(jsonParsed.profileUpdateInterval).toBe("24");
    expect(jsonParsed.profileWebPageUrl).toBe(
      "https://airport.example.com/dashboard",
    );
  });

  it("rejects publish when distribution.providerName is empty", async () => {
    const input = createTestInput({
      distribution: { providerName: "", sourceHost: "x" },
    });
    await expect(
      publishProviderVersion(
        mockBucket as unknown as R2Bucket,
        input,
        fixedDeps(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects incomplete or invalid client update policy", async () => {
    for (const clientUpdatePolicy of [
      { allowAutoUpdate: false },
      { allowAutoUpdate: "false", updateIntervalMinutes: 60 },
      { allowAutoUpdate: false, updateIntervalMinutes: 0 },
    ]) {
      const input = createTestInput({
        distribution: {
          providerName: "Test",
          sourceHost: "example.com",
          clientUpdatePolicy,
        } as never,
      });
      await expect(
        publishProviderVersion(
          mockBucket as unknown as R2Bucket,
          input,
          fixedDeps(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Corrupted current version → STORED_VERSION_CORRUPTED
// ---------------------------------------------------------------------------

describe("Corrupted current version detection", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws when meta.json is missing", async () => {
    const slug = "corr-miss";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-cm0001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Delete meta.json
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.store.delete(keys.meta);

    // New publish should detect corruption
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cm0002");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws when meta.json is invalid JSON", async () => {
    const slug = "corr-json";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-cj0001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper meta.json with invalid JSON
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.tamperContent(keys.meta, "NOT JSON {{{");

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cj0002");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws when meta.json SHA-256 mismatches pointer", async () => {
    const slug = "corr-sha";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-cs0001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper meta.json content (keeps etag but content differs)
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.tamperContent(keys.meta, '{"schemaVersion":1,"tampered":true}');

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cs0002");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws when meta.json fails strict schema", async () => {
    const slug = "corr-schema";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-csc01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Replace meta.json with valid JSON but missing required fields
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.tamperContent(
      keys.meta,
      JSON.stringify({ schemaVersion: 1, providerSlug: slug }),
    );

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-csc02");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws when artifact is missing", async () => {
    const slug = "corr-art";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-ca001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Delete provider.yaml
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.store.delete(keys.provider);

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-ca002");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws when artifact SHA-256 mismatches", async () => {
    const slug = "corr-ash";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-cas1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper provider.yaml content
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.tamperContent(keys.provider, "TAMPERED");

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cas2");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("does NOT create new version when current is corrupted", async () => {
    const slug = "corr-nocreate";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-cn01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Corrupt meta.json
    const keys = getVersionKeys(slug, await deps.generateVersionId(""));
    mockBucket.tamperContent(keys.meta, "CORRUPTED");

    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cn02");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });

    // No new version directory should be created
    const newKeys = getVersionKeys(slug, "20260101T000000Z-9e20490d-cn02");
    expect(mockBucket.has(newKeys.meta)).toBe(false);
    expect(mockBucket.has(newKeys.provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid V1 pointer → INVALID_STORED_POINTER
// ---------------------------------------------------------------------------

describe("Invalid V1 pointer detection", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws INVALID_STORED_POINTER when pointer is missing providerSlug", async () => {
    const slug = "bad-ptr";
    await mockBucket.put(
      `providers/${slug}/latest.json`,
      JSON.stringify({
        schemaVersion: 1,
        subscriptionId: "sub",
        uid: "uid",
        versionId: "v1",
        publishedAt: "2026-01-01",
        metaKey: `providers/${slug}/versions/v1/meta.json`,
        metaSha256: "a".repeat(64),
      }),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, slug),
    ).rejects.toMatchObject({ code: "INVALID_STORED_POINTER" });
  });

  it("throws INVALID_STORED_POINTER when pointer is missing publishedAt", async () => {
    const slug = "bad-ptr2";
    await mockBucket.put(
      `providers/${slug}/latest.json`,
      JSON.stringify({
        schemaVersion: 1,
        providerSlug: slug,
        subscriptionId: "sub",
        uid: "uid",
        versionId: "v1",
        metaKey: `providers/${slug}/versions/v1/meta.json`,
        metaSha256: "a".repeat(64),
      }),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, slug),
    ).rejects.toMatchObject({ code: "INVALID_STORED_POINTER" });
  });

  it("throws INVALID_STORED_POINTER when metaSha256 is not 64 hex chars", async () => {
    const slug = "bad-ptr3";
    await mockBucket.put(
      `providers/${slug}/latest.json`,
      JSON.stringify({
        schemaVersion: 1,
        providerSlug: slug,
        subscriptionId: "sub",
        uid: "uid",
        versionId: "v1",
        publishedAt: "2026-01-01",
        metaKey: `providers/${slug}/versions/v1/meta.json`,
        metaSha256: "not-a-valid-sha",
      }),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, slug),
    ).rejects.toMatchObject({ code: "INVALID_STORED_POINTER" });
  });
});
