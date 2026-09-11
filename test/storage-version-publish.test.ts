import { describe, it, expect, beforeEach } from "vitest";
import {
  publishProviderVersion,
  getVersionKeys,
  getProviderBaseKey,
  getVersionBaseKey,
  getLatest,
  getVersionYaml,
  getProviderMeta,
  listVersions,
  getVersionProfileForDownload,
  deleteProviderVersion,
  getVersionYamlForExport,
  getVersionJsonForExport,
  getLatestJsonForExport,
  rollbackLatest,
  VersionPublishError,
} from "../src/services/storage.ts";
import { validateSlug } from "../src/security/ssrf.ts";
import type {
  PublishVersionInput,
  ProviderVersionMeta,
  LatestVersionPointer,
  LatestJson,
  PublishDependencies,
  ProviderMeta,
} from "../src/types.ts";
import { isLatestVersionPointerV1 } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Enhanced Mock R2Bucket
// ---------------------------------------------------------------------------

class MockR2Bucket {
  store = new Map<string, string>();
  etags = new Map<string, string>();
  putCallCounts = new Map<string, number>();
  /** Keys whose next conditional put should return null (CAS failure). */
  private casFail = new Set<string>();
  /** Keys whose next get should return null (simulate missing object). */
  private getFail = new Set<string>();

  async get(key: string): Promise<unknown> {
    if (this.getFail.has(key)) {
      this.getFail.delete(key);
      return null;
    }
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
  ): Promise<{ key: string; etag: string } | null> {
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit).text();

    // Track call count
    this.putCallCounts.set(key, (this.getCallCount(key) || 0) + 1);

    if (opts?.onlyIf) {
      if (this.casFail.has(key)) {
        this.casFail.delete(key);
        return null;
      }

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
    return { key, etag: newEtag };
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

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.etags.delete(key);
  }

  clear() {
    this.store.clear();
    this.etags.clear();
    this.putCallCounts.clear();
    this.casFail.clear();
    this.getFail.clear();
  }

  // --- Fault injection ---

  simulateCasConflict(key: string): void {
    this.casFail.add(key);
  }

  simulateGetFailure(key: string): void {
    this.getFail.add(key);
  }

  tamperContent(key: string, newContent: string): void {
    if (this.store.has(key)) {
      this.store.set(key, newContent);
      // Keep same etag to simulate silent corruption
    }
  }

  // --- Introspection ---

  has(key: string): boolean {
    return this.store.has(key);
  }

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  getEtag(key: string): string | undefined {
    return this.etags.get(key);
  }

  getCallCount(key: string): number {
    return this.putCallCounts.get(key) || 0;
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
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

/** Fixed deps for deterministic versionId. */
function fixedDeps(
  versionId = "20260101T000000Z-aaaaaaaa-bbbbbbbbbbbbbbbb",
): PublishDependencies {
  return {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateVersionId: () => versionId,
  };
}

/** Write a legacy-format latest.json directly to the bucket. */
async function writeLegacyLatest(
  bucket: MockR2Bucket,
  slug: string,
  data: LatestJson,
): Promise<void> {
  await bucket.put(
    `${getProviderBaseKey(slug)}/latest.json`,
    JSON.stringify(data),
  );
}

/** Write a legacy-format version meta directly to the bucket. */
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

/** Write a legacy-format version YAML directly to the bucket. */
async function writeLegacyVersionYaml(
  bucket: MockR2Bucket,
  slug: string,
  versionId: string,
  yaml: string,
): Promise<void> {
  await bucket.put(`providers/${slug}/versions/${versionId}.yaml`, yaml);
}

// ---------------------------------------------------------------------------
// Tests: Path generators
// ---------------------------------------------------------------------------

describe("version path generators", () => {
  it("getProviderBaseKey", () => {
    expect(getProviderBaseKey("my-provider")).toBe("providers/my-provider");
  });

  it("getVersionBaseKey", () => {
    expect(getVersionBaseKey("my-provider", "v1")).toBe(
      "providers/my-provider/versions/v1",
    );
  });

  it("getVersionKeys", () => {
    expect(getVersionKeys("my-provider", "v1")).toEqual({
      raw: "providers/my-provider/versions/v1/raw.yaml",
      provider: "providers/my-provider/versions/v1/provider.yaml",
      profile: "providers/my-provider/versions/v1/profile.yaml",
      meta: "providers/my-provider/versions/v1/meta.json",
      latest: "providers/my-provider/latest.json",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: publishProviderVersion
// ---------------------------------------------------------------------------

describe("publishProviderVersion", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  // --- Normal publish ---

  it("publishes all artifacts with correct hashes and sizes", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-0000000000000001");
    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const keys = getVersionKeys("test-provider", result.versionId);
    expect(mockBucket.has(keys.raw)).toBe(true);
    expect(mockBucket.has(keys.provider)).toBe(true);
    expect(mockBucket.has(keys.profile)).toBe(true);
    expect(mockBucket.has(keys.meta)).toBe(true);
    expect(mockBucket.has(keys.latest)).toBe(true);

    expect(result.meta.artifacts.raw.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.meta.artifacts.raw.contentLength).toBe(
      new TextEncoder().encode(input.rawContent).length,
    );
    expect(result.meta.artifacts.provider.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.meta.artifacts.profile.sha256).toMatch(/^[a-f0-9]{64}$/);

    expect(result.latest.schemaVersion).toBe(1);
    expect(result.latest.metaKey).toBe(keys.meta);
    expect(result.latest.metaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.latest.subscriptionId).toBe("sub-123");
    expect(result.latest.uid).toBe("uid-456");
  });

  it("retains the current version and only two rollback versions", async () => {
    const versionIds = [
      "20260101T000001Z-aaaaaaaa-0000000000000001",
      "20260101T000002Z-bbbbbbbb-0000000000000002",
      "20260101T000003Z-cccccccc-0000000000000003",
      "20260101T000004Z-dddddddd-0000000000000004",
    ];
    for (let index = 0; index < versionIds.length; index++) {
      await publishProviderVersion(
        mockBucket as unknown as R2Bucket,
        createTestInput({
          rawContent: `proxies:\n  - name: node-${index}\n    type: ss\n    server: example.com\n    port: 443`,
          providerYaml: `proxies:\n  - name: node-${index}\n    type: ss\n    server: example.com\n    port: 443`,
          profileYaml: `mixed-port: 7890\nproxies:\n  - name: node-${index}\n    type: ss\n    server: example.com\n    port: 443`,
        }),
        {
          now: () => new Date(`2026-01-01T00:00:0${index + 1}.000Z`),
          generateVersionId: () => versionIds[index]!,
        },
      );
    }

    const versions = await listVersions(
      mockBucket as unknown as R2Bucket,
      "test-provider",
    );
    expect(versions.map((version) => version.versionId)).toEqual([
      versionIds[3],
      versionIds[2],
      versionIds[1],
    ]);
    expect(
      mockBucket.has(getVersionKeys("test-provider", versionIds[0]!).meta),
    ).toBe(false);
  });

  it("downloads the full historical profile rather than provider YAML", async () => {
    const input = createTestInput();
    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      fixedDeps(),
    );
    const bytes = await getVersionProfileForDownload(
      mockBucket as unknown as R2Bucket,
      "test-provider",
      result.versionId,
    );

    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe(input.profileYaml);
  });

  it("never deletes the current version", async () => {
    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      createTestInput(),
      fixedDeps(),
    );

    await expect(
      deleteProviderVersion(
        mockBucket as unknown as R2Bucket,
        "test-provider",
        result.versionId,
      ),
    ).rejects.toThrow("当前使用的版本不能删除");
  });

  // --- profile.yaml write failure ---

  it("does not create latest.json when profile.yaml write fails", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-failprofile";
    const deps = fixedDeps(versionId);

    // Pre-create the profile.yaml with different content to force conflict
    const keys = getVersionKeys("test-provider", versionId);
    await mockBucket.put(keys.profile, "tampered");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps),
    ).rejects.toThrow(VersionPublishError);

    expect(mockBucket.has(keys.latest)).toBe(false);
  });

  // --- meta.json write failure ---

  it("does not create latest.json when meta.json write fails", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-failmeta";
    const deps = fixedDeps(versionId);

    // Pre-create meta.json with different content
    const keys = getVersionKeys("test-provider", versionId);
    await mockBucket.put(keys.meta, '{"tampered":true}');

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps),
    ).rejects.toThrow(VersionPublishError);

    expect(mockBucket.has(keys.latest)).toBe(false);
  });

  // --- Verification detects tampered provider.yaml ---

  it("throws STORED_VERSION_CORRUPTED when provider.yaml is tampered after write", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-tampered";
    const deps = fixedDeps(versionId);
    const keys = getVersionKeys("test-provider", versionId);

    // First: let the publish succeed normally
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Tamper the provider.yaml content (same key, different content, keep etag)
    mockBucket.tamperContent(keys.provider, "TAMPERED_CONTENT");

    // Now: attempt another publish with DIFFERENT content that would create
    // the same versionId (fixed deps). The immutable write sees existing
    // content differs → VERSION_OBJECT_CONFLICT, not STORED_VERSION_CORRUPTED.
    // But if we use different deps (new versionId) and the idempotency check
    // finds corrupted data, it should fall through and create new version.
    // The real STORED_VERSION_CORRUPTED path is hit during idempotent
    // reuse verification. Let's test that via the missing-artifact path instead.

    // The tampered content is detected during verification (STORED_VERSION_CORRUPTED)
    // because the idempotency check reads meta.json which still has the correct
    // sha256, then verifyObject reads the tampered provider.yaml and detects mismatch.
    await expect(
      publishProviderVersion(
        mockBucket as unknown as R2Bucket,
        createTestInput(), // same content
        deps,
      ),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });

    expect(mockBucket.has(keys.latest)).toBe(true); // original latest still intact
  });

  // --- Idempotent reuse: missing profile.yaml ---

  it("throws STORED_VERSION_CORRUPTED when profile.yaml is missing during idempotent reuse", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-idem0001";
    const deps1 = fixedDeps(versionId);

    // First publish succeeds
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    // Delete profile.yaml to simulate corruption
    const keys = getVersionKeys("test-provider", versionId);
    mockBucket.store.delete(keys.profile);

    // Second publish with same content should detect corruption
    // and throw STORED_VERSION_CORRUPTED (not return idempotent success)
    await expect(
      publishProviderVersion(
        mockBucket as unknown as R2Bucket,
        input,
        fixedDeps("20260101T000000Z-9e20490d-idem0002"),
      ),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  // --- Idempotent reuse: metaSha256 mismatch (corruption detected) ---

  it("throws STORED_VERSION_CORRUPTED when meta.json SHA-256 mismatches pointer", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-metamis";
    const deps1 = fixedDeps(versionId);

    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    // Tamper meta.json (same key, different content, keep same etag)
    const keys = getVersionKeys("test-provider", versionId);
    mockBucket.tamperContent(keys.meta, '{"tampered":true}');

    // Corruption is detected — must NOT create a new version silently
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-newversion");
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps2),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });

    // No new version should be created
    expect(
      mockBucket.has(
        getVersionKeys("test-provider", "20260101T000000Z-9e20490d-newversion")
          .meta,
      ),
    ).toBe(false);
  });

  // --- CAS conflict ---

  it("throws VERSION_CONFLICT when CAS write to latest.json fails", async () => {
    const input = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-cas00001");

    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    // Simulate CAS conflict for the next conditional write to latest.json
    mockBucket.simulateCasConflict("providers/test-provider/latest.json");

    // Same identity, same content — would normally be idempotent.
    // But idempotent check passes (same content), so it returns early.
    // We need different content to skip idempotency and reach CAS.
    const input2 = createTestInput({ generatorVersion: "2.0.0" });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-cas00002");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input2, deps2),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  // --- First create CAS conflict ---

  it("throws VERSION_CONFLICT when latest.json is created by another request before ours", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-firstcr");

    // Simulate: another request creates latest.json just before our CAS write
    mockBucket.simulateCasConflict("providers/test-provider/latest.json");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  // --- expectedLatestEtag mismatch ---

  it("throws VERSION_CONFLICT when expectedLatestEtag does not match", async () => {
    const input = createTestInput({
      expectedLatestEtag: '"stale-etag"',
    });
    const deps = fixedDeps();

    // No latest.json exists → startingLatestEtag is null → mismatch
    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input, deps),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    // No version objects should be written
    expect(
      mockBucket.keysWithPrefix("providers/test-provider/versions/").length,
    ).toBe(0);
  });

  it("throws VERSION_CONFLICT when expectedLatestEtag provided but object exists with different etag", async () => {
    const input = createTestInput();
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-etago01");

    const result1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps1,
    );

    // Now try with a stale expectedLatestEtag
    const input2 = createTestInput({
      generatorVersion: "2.0.0",
      expectedLatestEtag: '"wrong-etag"',
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-etago02");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input2, deps2),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  // --- Full publish cycle race (A vs B) ---

  it("rejects publish when another request published between snapshot and CAS", async () => {
    // Simulate a true race: both A and B snapshot when latest.json
    // exists (pointing to B's already-published version). A's CAS write
    // then fails because B's pointer was modified concurrently.
    //
    // In practice this means: A snapshots latest.json, B publishes a new
    // version (changing latest.json's etag), then A's CAS write fails
    // because the etag no longer matches A's snapshot.

    // Step 1: Publish initial version
    const inputInitial = createTestInput();
    const depsInitial = fixedDeps("20260101T000000Z-9e20490d-raceInit");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      inputInitial,
      depsInitial,
    );

    // Step 2: Simulate CAS conflict on latest.json
    // This means: A read the etag, but by the time A tries to CAS-write,
    // the etag has changed (B published in between).
    mockBucket.simulateCasConflict("providers/test-provider/latest.json");

    const inputA = createTestInput({ generatorVersion: "2.0.0" });
    const depsA = fixedDeps("20260101T000000Z-9e20490d-raceA001");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, inputA, depsA),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    // Original pointer is still intact (B's or initial's)
    const latestRaw = mockBucket.getRaw("providers/test-provider/latest.json");
    const pointer = JSON.parse(latestRaw!);
    expect(isLatestVersionPointerV1(pointer)).toBe(true);
    expect(pointer.versionId).toBe("20260101T000000Z-9e20490d-raceInit");
  });

  // --- Same version key, same content (idempotent immutable retry) ---

  it("succeeds when immutable object already exists with same content", async () => {
    const input = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-samekey";
    const deps = fixedDeps(versionId);

    // First publish
    const result1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Second publish with same deps (same versionId) and same content
    const result2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    expect(result2.versionId).toBe(versionId);
    expect(result1.meta.sourceSha256).toBe(result2.meta.sourceSha256);
  });

  // --- Same version key, different content ---

  it("throws VERSION_OBJECT_CONFLICT when same version key has different content", async () => {
    const input1 = createTestInput();
    const versionId = "20260101T000000Z-9e20490d-confkey";
    const deps = fixedDeps(versionId);

    // First publish
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps,
    );

    // Second publish with different rawContent but same versionId
    const input2 = createTestInput({
      rawContent:
        "proxies:\n  - name: different\n    type: vmess\n    server: other.com\n    port: 443",
      providerYaml:
        "proxies:\n  - name: different\n    type: vmess\n    server: other.com\n    port: 443",
    });

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input2, deps),
    ).rejects.toMatchObject({ code: "VERSION_OBJECT_CONFLICT" });

    // Original raw.yaml unchanged
    const keys = getVersionKeys("test-provider", versionId);
    expect(mockBucket.getRaw(keys.raw)).toBe(input1.rawContent);
  });

  // --- Legacy latest.json exists ---

  it("publishes safely when legacy latest.json exists", async () => {
    await writeLegacyLatest(mockBucket, "test-provider", {
      versionId: "old-version-id",
      sha256: "aabbccdd",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-legacy01");

    const result = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    expect(result.versionId).toBe("20260101T000000Z-9e20490d-legacy01");
    expect(result.latest.schemaVersion).toBe(1);
  });

  // --- Identity conflict ---

  it("throws PROVIDER_IDENTITY_CONFLICT when subscriptionId differs", async () => {
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-ident01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      createTestInput(),
      deps1,
    );

    const input2 = createTestInput({ subscriptionId: "other-sub" });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-ident02");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input2, deps2),
    ).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CONFLICT" });
  });

  it("throws PROVIDER_IDENTITY_CONFLICT when uid differs", async () => {
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-ident11");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      createTestInput(),
      deps1,
    );

    const input2 = createTestInput({ uid: "other-uid" });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-ident12");

    await expect(
      publishProviderVersion(mockBucket as unknown as R2Bucket, input2, deps2),
    ).rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CONFLICT" });
  });

  // --- Slug validation ---

  it("rejects invalid slugs consistent with validateSlug", async () => {
    // validateSlug rejects: empty, uppercase, spaces, path traversal,
    // leading/trailing hyphens, slashes, >63 chars
    const invalidSlugs = [
      "",
      "  ",
      "../traversal",
      "UPPER",
      "a/b",
      "-starts-dash",
      "ends-dash-",
      "has space",
      "a".repeat(64),
    ];

    for (const slug of invalidSlugs) {
      expect(validateSlug(slug)).toBe(false);
    }

    // Verify valid slugs pass
    expect(validateSlug("test-provider")).toBe(true);
    expect(validateSlug("a")).toBe(true);
    expect(validateSlug("a-b")).toBe(true);
    expect(validateSlug("a".repeat(63))).toBe(true);
  });

  // --- Input validation ---

  it("rejects empty required fields", async () => {
    const cases = [
      { providerSlug: "" },
      { subscriptionId: "" },
      { uid: "" },
      { rawContent: "" },
      { providerYaml: "" },
      { profileYaml: "" },
      { generatorVersion: "" },
      { nodeCount: -1 },
    ];

    for (const overrides of cases) {
      const input = createTestInput(overrides as Partial<PublishVersionInput>);
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
// Tests: Fixed URL compatibility views
// ---------------------------------------------------------------------------

describe("fixed URL compatibility", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("getLatest returns LatestJson for legacy pointer", async () => {
    await writeLegacyLatest(mockBucket, "p1", {
      versionId: "v1",
      sha256: "aabb",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    const result = await getLatest(mockBucket as unknown as R2Bucket, "p1");
    expect(result).not.toBeNull();
    expect(result!.versionId).toBe("v1");
    expect(result!.sha256).toBe("aabb");
    expect(result!.updatedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("getLatest returns LatestJson projection for V1 pointer", async () => {
    const input = createTestInput({ providerSlug: "p2" });
    const deps = fixedDeps("20260101T000000Z-9e20490d-v1compat");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const result = await getLatest(mockBucket as unknown as R2Bucket, "p2");
    expect(result).not.toBeNull();
    expect(result!.versionId).toBe("20260101T000000Z-9e20490d-v1compat");
    expect(result!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.updatedAt).toBeDefined();
  });

  it("getVersionYaml reads from new path, falls back to legacy", async () => {
    const slug = "yaml-compat";

    // Write at new path
    const keys = getVersionKeys(slug, "v-new");
    await mockBucket.put(keys.provider, "new-path-yaml");

    expect(
      await getVersionYaml(mockBucket as unknown as R2Bucket, slug, "v-new"),
    ).toBe("new-path-yaml");

    // Write at legacy path only
    await writeLegacyVersionYaml(mockBucket, slug, "v-old", "legacy-yaml");

    expect(
      await getVersionYaml(mockBucket as unknown as R2Bucket, slug, "v-old"),
    ).toBe("legacy-yaml");
  });

  it("getProviderMeta reads from new path, falls back to legacy", async () => {
    const slug = "meta-compat";

    // New path: publish a version
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-metacompat");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const meta = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      slug,
      "20260101T000000Z-9e20490d-metacompat",
    );
    expect(meta).not.toBeNull();
    expect(meta!.versionId).toBe("20260101T000000Z-9e20490d-metacompat");
    expect(meta!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta!.nodeCount).toBe(1);

    // Legacy path
    await writeLegacyVersionMeta(mockBucket, slug, "v-legacy", {
      versionId: "v-legacy",
      providerSlug: slug,
      providerName: "Legacy Provider",
      createdAt: "2025-01-01T00:00:00Z",
      sha256: "deadbeef",
      nodeCount: 5,
      sourceHost: "example.com",
      contentLength: 100,
    });

    const legacyMeta = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      slug,
      "v-legacy",
    );
    expect(legacyMeta).not.toBeNull();
    expect(legacyMeta!.versionId).toBe("v-legacy");
    expect(legacyMeta!.providerName).toBe("Legacy Provider");
    expect(legacyMeta!.sourceHost).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// Tests: Mixed history (listVersions)
// ---------------------------------------------------------------------------

describe("listVersions with mixed formats", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("lists both new and legacy versions sorted by createdAt", async () => {
    const slug = "mixed-hist";

    // Write legacy version
    await writeLegacyVersionMeta(mockBucket, slug, "v-old", {
      versionId: "v-old",
      createdAt: "2025-06-01T00:00:00Z",
      nodeCount: 3,
      sha256: "aabbccdd00112233",
      contentLength: 200,
      sourceHost: "old.example.com",
    });

    // Write new version
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-mixhist1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Set latest to the new version
    const items = await listVersions(mockBucket as unknown as R2Bucket, slug);

    expect(items.length).toBe(2);
    // New version should be first (more recent)
    expect(items[0]!.versionId).toBe("20260101T000000Z-9e20490d-mixhist1");
    expect(items[1]!.versionId).toBe("v-old");
    expect(items[1]!.sourceHost).toBe("old.example.com");
  });

  it("skips corrupted metadata without crashing", async () => {
    const slug = "corrupt-hist";

    // Write a corrupted .json file in the versions prefix
    await mockBucket.put(
      `providers/${slug}/versions/bad-version.json`,
      "NOT VALID JSON {{{",
    );

    // Write a valid legacy version
    await writeLegacyVersionMeta(mockBucket, slug, "v-good", {
      versionId: "v-good",
      createdAt: "2025-06-01T00:00:00Z",
      nodeCount: 1,
      sha256: "abcdef0123456789",
      contentLength: 100,
      sourceHost: "example.com",
    });

    const items = await listVersions(mockBucket as unknown as R2Bucket, slug);

    // Should return the valid one, skip the corrupted one
    expect(items.length).toBe(1);
    expect(items[0]!.versionId).toBe("v-good");
  });

  it("reads version metadata concurrently instead of serialising round trips", async () => {
    const slug = "parallel-hist";
    const versionIds = ["v1", "v2", "v3", "v4", "v5", "v6"];
    for (const id of versionIds) {
      await writeLegacyVersionMeta(mockBucket, slug, id, {
        versionId: id,
        createdAt: "2025-06-01T00:00:00Z",
        nodeCount: 1,
        sha256: "abcdef0123456789",
        contentLength: 100,
        sourceHost: "example.com",
      });
    }

    // A sequential loop can never have more than one read in flight; the
    // optimised path issues them in parallel.
    const api = mockBucket as unknown as {
      get(key: string): Promise<unknown>;
    };
    const originalGet = api.get.bind(api);
    let inFlight = 0;
    let maxInFlight = 0;
    api.get = async (key: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await originalGet(key);
      } finally {
        inFlight--;
      }
    };

    const items = await listVersions(mockBucket as unknown as R2Bucket, slug);

    expect(items.length).toBe(versionIds.length);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Backup v1 export compatibility
// ---------------------------------------------------------------------------

describe("backup v1 export compatibility", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("getVersionYamlForExport returns provider.yaml for new versions", async () => {
    const slug = "export-new";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-exp0001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const data = await getVersionYamlForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      "20260101T000000Z-9e20490d-exp0001",
    );
    expect(data).not.toBeNull();
    const text = new TextDecoder().decode(data!);
    expect(text).toBe(input.providerYaml);
  });

  it("getVersionJsonForExport returns projected legacy ProviderMeta for new versions", async () => {
    const slug = "export-json";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-expjson1");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const data = await getVersionJsonForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      "20260101T000000Z-9e20490d-expjson1",
    );
    expect(data).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(data!));
    expect(parsed.versionId).toBe("20260101T000000Z-9e20490d-expjson1");
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.nodeCount).toBe(1);
    expect(parsed.providerSlug).toBe("export-json");
  });

  it("getLatestJsonForExport returns legacy LatestJson for V1 pointer", async () => {
    const slug = "export-latest";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-explat01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const data = await getLatestJsonForExport(
      mockBucket as unknown as R2Bucket,
      slug,
    );
    expect(data).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(data!));
    expect(parsed.versionId).toBe("20260101T000000Z-9e20490d-explat01");
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.updatedAt).toBeDefined();
    // Should NOT contain V1-only fields
    expect(parsed.schemaVersion).toBeUndefined();
    expect(parsed.metaKey).toBeUndefined();
  });

  it("getVersionYamlForExport falls back to legacy path", async () => {
    const slug = "export-fallback";
    await writeLegacyVersionYaml(
      mockBucket,
      slug,
      "v-fb",
      "legacy-export-yaml",
    );

    const data = await getVersionYamlForExport(
      mockBucket as unknown as R2Bucket,
      slug,
      "v-fb",
    );
    expect(data).not.toBeNull();
    expect(new TextDecoder().decode(data!)).toBe("legacy-export-yaml");
  });
});

// ---------------------------------------------------------------------------
// Tests: ETag returned is not undefined
// ---------------------------------------------------------------------------

describe("ETag correctness", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("latest.json has a valid etag after publish", async () => {
    const input = createTestInput();
    const deps = fixedDeps("20260101T000000Z-9e20490d-etagtest");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    const etag = mockBucket.getEtag("providers/test-provider/latest.json");
    expect(etag).toBeDefined();
    expect(etag).not.toBe("undefined");
    expect(typeof etag).toBe("string");
    expect(etag!.length).toBeGreaterThan(0);
  });
});
