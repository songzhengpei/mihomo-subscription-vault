import { describe, it, expect, beforeEach } from "vitest";
import {
  publishProviderVersion,
  getVersionKeys,
  getLatest,
  getProviderMeta,
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
// Mock R2Bucket
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

function rollbackDeps(time = "2026-06-15T12:00:00.000Z"): PublishDependencies {
  return {
    now: () => new Date(time),
    generateVersionId: () => "unused",
  };
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function countVersionDirs(
  bucket: MockR2Bucket,
  slug: string,
): Promise<number> {
  const keys = bucket.getRaw("providers/" + slug)
    ? [...bucket["store"].keys()].filter((k) =>
        k.startsWith(`providers/${slug}/versions/`),
      )
    : [...bucket["store"].keys()].filter((k) =>
        k.startsWith(`providers/${slug}/versions/`),
      );
  const versionIds = new Set<string>();
  for (const k of [...bucket["store"].keys()]) {
    if (!k.startsWith(`providers/${slug}/versions/`)) continue;
    const rest = k.slice(`providers/${slug}/versions/`.length);
    const m = rest.match(/^([^/]+)\//);
    if (m?.[1]) versionIds.add(m[1]);
  }
  return versionIds.size;
}

// ---------------------------------------------------------------------------
// 1. Idempotent: all fields identical → returns original
// ---------------------------------------------------------------------------

describe("Idempotent reuse — full field match", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("returns original versionId when all fields match exactly", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-idem001";
    const deps = fixedDeps(versionId);

    const r1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );
    expect(r1.versionId).toBe(versionId);

    const r2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );
    expect(r2.versionId).toBe(versionId);
    expect(r2.meta.artifacts.provider.sha256).toBe(
      r1.meta.artifacts.provider.sha256,
    );

    // Version directory count should not increase
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Same raw, different provider.yaml → new version
// ---------------------------------------------------------------------------

describe("Same raw, different provider.yaml", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("creates new version without STORED_VERSION_CORRUPTED", async () => {
    const raw =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";
    const provider1 =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443";
    const provider2 =
      "proxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443\n  - name: test2\n    type: vmess\n    server: other.com\n    port: 443";

    const input1 = createTestInput({
      rawContent: raw,
      providerYaml: provider1,
      nodeCount: 1,
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-diffp01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      rawContent: raw,
      providerYaml: provider2,
      nodeCount: 2,
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-diffp02");
    const r2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    expect(r2.versionId).toBe("20260101T000000Z-9e20490d-diffp02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Same raw/provider, different profile.yaml → new version
// ---------------------------------------------------------------------------

describe("Same raw/provider, different profile.yaml", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("creates new version when only profile.yaml differs", async () => {
    const input1 = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-diffc01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      profileYaml:
        "mixed-port: 9090\nproxies:\n  - name: test\n    type: ss\n    server: example.com\n    port: 443",
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-diffc02");
    const r2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    expect(r2.versionId).toBe("20260101T000000Z-9e20490d-diffc02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Distribution changes → new version
// ---------------------------------------------------------------------------

describe("Distribution changes create new version", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("subscriptionUserinfo change", async () => {
    const input1 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        subscriptionUserinfo: "upload=0;download=100;total=1000;expire=999",
      },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-dsu01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        subscriptionUserinfo: "upload=0;download=200;total=1000;expire=999",
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-dsu02");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-dsu02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });

  it("providerName change", async () => {
    const input1 = createTestInput({
      distribution: { providerName: "V1 Name", sourceHost: "h.com" },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-dpn01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: { providerName: "V2 Name", sourceHost: "h.com" },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-dpn02");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-dpn02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });

  it("sourceHost change", async () => {
    const input1 = createTestInput({
      distribution: { providerName: "Test", sourceHost: "old.com" },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-dsh01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: { providerName: "Test", sourceHost: "new.com" },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-dsh02");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-dsh02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. nodeCount change → new version
// ---------------------------------------------------------------------------

describe("nodeCount change creates new version", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("different nodeCount creates new version", async () => {
    const input1 = createTestInput({ nodeCount: 5 });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-dnc01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({ nodeCount: 10 });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-dnc02");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-dnc02");
    expect(await countVersionDirs(mockBucket, "test-provider")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Rollback target meta.versionId mismatch → reject
// ---------------------------------------------------------------------------

describe("Rollback target meta.versionId mismatch", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rejects when meta.versionId does not match targetVersionId", async () => {
    const slug = "rb-mismatch";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-rbm01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper meta.json versionId to differ from directory name
    const keys = getVersionKeys(slug, "20260101T000000Z-9e20490d-rbm01");
    const metaRaw = mockBucket.getRaw(keys.meta)!;
    const meta = JSON.parse(metaRaw);
    meta.versionId = "different-id";
    mockBucket.tamperContent(keys.meta, JSON.stringify(meta));

    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-rbm01",
      ),
    ).rejects.toThrow(VersionPublishError);
  });
});

// ---------------------------------------------------------------------------
// 7. Rollback target artifact key points to other version → reject
// ---------------------------------------------------------------------------

describe("Rollback target artifact key tampered", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rejects when artifact key points outside the version directory", async () => {
    const slug = "rb-artkey";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-rbak01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper meta.json: change provider artifact key to point elsewhere
    const keys = getVersionKeys(slug, "20260101T000000Z-9e20490d-rbak01");
    const metaRaw = mockBucket.getRaw(keys.meta)!;
    const meta = JSON.parse(metaRaw);
    meta.artifacts.provider.key = `providers/${slug}/versions/other/provider.yaml`;
    mockBucket.tamperContent(keys.meta, JSON.stringify(meta));

    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-rbak01",
      ),
    ).rejects.toThrow(VersionPublishError);
  });
});

// ---------------------------------------------------------------------------
// 8. V1 rollback identity conflict
// ---------------------------------------------------------------------------

describe("V1 rollback identity conflict", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rejects rollback when target has different subscriptionId", async () => {
    const slug = "rb-ident";
    // Publish V1 with sub-123
    const input1 = createTestInput({ providerSlug: slug });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-rbi01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    // Publish V2 with sub-999 (different identity, different slug context)
    // We need a different slug for the second subscription
    const slug2 = "rb-ident-other";
    const input2 = createTestInput({
      providerSlug: slug2,
      subscriptionId: "sub-999",
      uid: "uid-999",
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-rbi02");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Now tamper V2's meta to claim slug "rb-ident" (simulating cross-identity rollback)
    const keys2 = getVersionKeys(slug2, "20260101T000000Z-9e20490d-rbi02");
    const metaRaw = mockBucket.getRaw(keys2.meta)!;
    const meta = JSON.parse(metaRaw);
    meta.providerSlug = slug;
    // Also update artifact keys to match the new slug
    const newKeys = getVersionKeys(slug, "20260101T000000Z-9e20490d-rbi02");
    meta.artifacts.raw.key = newKeys.raw;
    meta.artifacts.provider.key = newKeys.provider;
    meta.artifacts.profile.key = newKeys.profile;
    mockBucket.tamperContent(keys2.meta, JSON.stringify(meta));

    // Move the meta.json to the correct location for the target slug
    mockBucket.store.set(newKeys.meta, mockBucket.getRaw(keys2.meta)!);

    // Rollback to V2 should fail because subscriptionId differs
    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-rbi02",
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// 9. Rollback publishedAt uses current time
// ---------------------------------------------------------------------------

describe("Rollback publishedAt uses current time", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("V1 rollback uses deps.now() for publishedAt, not meta.createdAt", async () => {
    const input = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-rbtime1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    const input2 = createTestInput({ generatorVersion: "2.0.0" });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-rbtime2");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Rollback with specific clock
    const rbDeps = rollbackDeps("2026-07-01T15:30:00.000Z");
    const result = await rollbackLatest(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      "20260101T000000Z-9e20490d-rbtime1",
      undefined,
      rbDeps,
    );

    expect(isLatestVersionPointerV1(result)).toBe(true);
    const pointer = result as LatestVersionPointer;
    // publishedAt should be the rollback time, NOT the version's createdAt
    expect(pointer.publishedAt).toBe("2026-07-01T15:30:00.000Z");

    // The pointer publishedAt should NOT equal the version's createdAt
    // (which was "2026-01-01T00:00:00.000Z")
    expect(pointer.publishedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 10. Legacy rollback: YAML hash mismatch → reject
// ---------------------------------------------------------------------------

describe("Legacy rollback integrity checks", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rejects when legacy YAML hash does not match meta.sha256", async () => {
    const slug = "leg-hash";
    const yaml =
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443";
    const realSha = await sha256(yaml);

    // Write YAML
    await mockBucket.put(`providers/${slug}/versions/v1.yaml`, yaml);
    // Write meta with WRONG sha256
    await mockBucket.put(
      `providers/${slug}/versions/v1.json`,
      JSON.stringify({
        versionId: "v1",
        providerSlug: slug,
        providerName: "Test",
        createdAt: "2025-01-01T00:00:00Z",
        sha256: "0".repeat(64), // wrong hash
        nodeCount: 1,
        sourceHost: "s.com",
        contentLength: yaml.length,
      }),
    );

    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, slug, "v1"),
    ).rejects.toThrow(/SHA-256/);
  });

  it("rejects when legacy YAML bytes do not match meta.contentLength", async () => {
    const slug = "leg-size";
    const yaml =
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443";

    await mockBucket.put(`providers/${slug}/versions/v1.yaml`, yaml);
    await mockBucket.put(
      `providers/${slug}/versions/v1.json`,
      JSON.stringify({
        versionId: "v1",
        providerSlug: slug,
        providerName: "Test",
        createdAt: "2025-01-01T00:00:00Z",
        sha256: await sha256(yaml),
        nodeCount: 1,
        sourceHost: "s.com",
        contentLength: yaml.length + 100, // wrong size
      }),
    );

    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, slug, "v1"),
    ).rejects.toThrow(/contentLength/);
  });

  it("rejects when legacy meta.versionId mismatches target", async () => {
    const slug = "leg-vid";
    const yaml =
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443";

    await mockBucket.put(`providers/${slug}/versions/v1.yaml`, yaml);
    await mockBucket.put(
      `providers/${slug}/versions/v1.json`,
      JSON.stringify({
        versionId: "different-id",
        providerSlug: slug,
        providerName: "Test",
        createdAt: "2025-01-01T00:00:00Z",
        sha256: await sha256(yaml),
        nodeCount: 1,
        sourceHost: "s.com",
        contentLength: yaml.length,
      }),
    );

    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, slug, "v1"),
    ).rejects.toThrow(/versionId/);
  });

  it("does NOT modify latest.json when legacy rollback rejects", async () => {
    const slug = "leg-nomod";
    const yaml =
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443";

    // Publish a valid V1 version first
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-legnm1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Write a bad legacy version
    await mockBucket.put(`providers/${slug}/versions/v-bad.yaml`, yaml);
    await mockBucket.put(
      `providers/${slug}/versions/v-bad.json`,
      JSON.stringify({
        versionId: "v-bad",
        providerSlug: slug,
        providerName: "Test",
        createdAt: "2025-01-01T00:00:00Z",
        sha256: "0".repeat(64), // wrong hash
        nodeCount: 1,
        sourceHost: "s.com",
        contentLength: yaml.length,
      }),
    );

    // Rollback to bad legacy should fail
    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, slug, "v-bad"),
    ).rejects.toThrow();

    // latest.json should still point to the V1 version
    const latest = await getLatest(mockBucket as unknown as R2Bucket, slug);
    expect(latest).not.toBeNull();
    expect(latest!.versionId).toBe("20260101T000000Z-9e20490d-legnm1");
  });
});

// ---------------------------------------------------------------------------
// 11. getLatest() pointer-meta identity mismatch → STORED_VERSION_CORRUPTED
// ---------------------------------------------------------------------------

describe("getLatest pointer-meta identity mismatch", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws STORED_VERSION_CORRUPTED when pointer.subscriptionId differs from meta", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-pmidm1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper latest.json to change subscriptionId
    const latestRaw = mockBucket.getRaw("providers/test-provider/latest.json")!;
    const pointer = JSON.parse(latestRaw);
    pointer.subscriptionId = "other-sub";
    mockBucket.tamperContent(
      "providers/test-provider/latest.json",
      JSON.stringify(pointer),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, "test-provider"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("throws STORED_VERSION_CORRUPTED when pointer.uid differs from meta", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-pmidu1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const latestRaw = mockBucket.getRaw("providers/test-provider/latest.json")!;
    const pointer = JSON.parse(latestRaw);
    pointer.uid = "other-uid";
    mockBucket.tamperContent(
      "providers/test-provider/latest.json",
      JSON.stringify(pointer),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, "test-provider"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });
});

// ---------------------------------------------------------------------------
// 12. V1 metaKey non-standard path → STORED_VERSION_CORRUPTED
// ---------------------------------------------------------------------------

describe("V1 metaKey non-standard path", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws STORED_VERSION_CORRUPTED when metaKey is not the standard path", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-mkp01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper latest.json metaKey to a non-standard path
    const latestRaw = mockBucket.getRaw("providers/test-provider/latest.json")!;
    const pointer = JSON.parse(latestRaw);
    pointer.metaKey = "providers/test-provider/versions/v1/evil-meta.json";
    mockBucket.tamperContent(
      "providers/test-provider/latest.json",
      JSON.stringify(pointer),
    );

    await expect(
      getLatest(mockBucket as unknown as R2Bucket, "test-provider"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });
});

// ---------------------------------------------------------------------------
// 13. getProviderMeta illegal V1 schema → error
// ---------------------------------------------------------------------------

describe("getProviderMeta strict V1 validation", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws STORED_VERSION_CORRUPTED for invalid V1 meta instead of returning null", async () => {
    const slug = "meta-strict";
    const keys = getVersionKeys(slug, "v1");

    // Write a file at the V1 meta.json path that passes basic JSON but fails schema
    await mockBucket.put(
      keys.meta,
      JSON.stringify({ schemaVersion: 1, providerSlug: slug }),
    );

    await expect(
      getProviderMeta(mockBucket as unknown as R2Bucket, slug, "v1"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("returns null for invalid legacy meta", async () => {
    const slug = "meta-leg";
    await mockBucket.put(
      `providers/${slug}/versions/v1.json`,
      JSON.stringify({ foo: "bar" }), // missing required fields
    );

    const result = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      slug,
      "v1",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. Backup export when provider.yaml is tampered → fail
// ---------------------------------------------------------------------------

describe("Backup export fails on tampered provider.yaml", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("getLatestJsonForExport fails when provider.yaml is tampered", async () => {
    const slug = "export-tamp";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-ext01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper provider.yaml
    const keys = getVersionKeys(slug, "20260101T000000Z-9e20490d-ext01");
    mockBucket.tamperContent(keys.provider, "TAMPERED_CONTENT");

    // Export should fail
    await expect(
      getLatestJsonForExport(mockBucket as unknown as R2Bucket, slug),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("getVersionJsonForExport fails when meta.json is tampered", async () => {
    const slug = "export-meta-tamp";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-ext02");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper meta.json
    const keys = getVersionKeys(slug, "20260101T000000Z-9e20490d-ext02");
    mockBucket.tamperContent(keys.meta, '{"tampered":true}');

    // Export should fail
    await expect(
      getVersionJsonForExport(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-ext02",
      ),
    ).rejects.toThrow(VersionPublishError);
  });
});
