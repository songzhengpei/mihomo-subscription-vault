import { describe, it, expect, beforeEach } from "vitest";
import {
  publishProviderVersion,
  getVersionKeys,
  getLatest,
  getProviderMeta,
  getVersionYamlForExport,
  getVersionJsonForExport,
  getLatestJsonForExport,
  rollbackLatest,
  VersionPublishError,
} from "../src/services/storage.ts";
import type { PublishVersionInput, PublishDependencies } from "../src/types.ts";

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

  getRaw(key: string): string | undefined {
    return this.store.get(key);
  }

  tamperContent(key: string, newContent: string): void {
    if (this.store.has(key)) {
      this.store.set(key, newContent);
    }
  }

  deleteKey(key: string): void {
    this.store.delete(key);
    this.etags.delete(key);
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

// ---------------------------------------------------------------------------
// 1. getLatest cross-slug pointer
// ---------------------------------------------------------------------------

describe("getLatest cross-slug trust boundary", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws STORED_VERSION_CORRUPTED when latest.json points to another slug", async () => {
    // Publish a valid version for provider-b
    const inputB = createTestInput({ providerSlug: "provider-b" });
    const depsB = fixedDeps("20260101T000000Z-9e20490d-cs001");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      inputB,
      depsB,
    );

    // Copy provider-b's latest.json to provider-a
    const bLatest = mockBucket.getRaw("providers/provider-b/latest.json")!;
    await mockBucket.put("providers/provider-a/latest.json", bLatest);

    // getLatest("provider-a") must fail — the pointer's providerSlug is "provider-b"
    // but we're resolving under "provider-a"
    await expect(
      getLatest(mockBucket as unknown as R2Bucket, "provider-a"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });
});

// ---------------------------------------------------------------------------
// 2. getLatestJsonForExport cross-slug pointer
// ---------------------------------------------------------------------------

describe("getLatestJsonForExport cross-slug trust boundary", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws when latest.json points to another slug", async () => {
    const inputB = createTestInput({ providerSlug: "provider-b" });
    const depsB = fixedDeps("20260101T000000Z-9e20490d-cs002");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      inputB,
      depsB,
    );

    const bLatest = mockBucket.getRaw("providers/provider-b/latest.json")!;
    await mockBucket.put("providers/provider-a/latest.json", bLatest);

    await expect(
      getLatestJsonForExport(mockBucket as unknown as R2Bucket, "provider-a"),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });
});

// ---------------------------------------------------------------------------
// 3. distribution undefined vs "" creates new version
// ---------------------------------------------------------------------------

describe("distribution undefined vs empty string", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("subscriptionUserinfo: undefined vs '' creates new version", async () => {
    const input1 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        subscriptionUserinfo: undefined,
      },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-du01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        subscriptionUserinfo: "",
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-du02");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-du02");
  });

  it("profileUpdateInterval: undefined vs '' creates new version", async () => {
    const input1 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        profileUpdateInterval: undefined,
      },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-du03");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        profileUpdateInterval: "",
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-du04");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-du04");
  });

  it("profileWebPageUrl: undefined vs '' creates new version", async () => {
    const input1 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        profileWebPageUrl: undefined,
      },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-du05");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        profileWebPageUrl: "",
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-du06");
    const r = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );
    expect(r.versionId).toBe("20260101T000000Z-9e20490d-du06");
  });
});

// ---------------------------------------------------------------------------
// 4. distribution missing field vs undefined is same (idempotent)
// ---------------------------------------------------------------------------

describe("distribution missing field vs explicit undefined", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("missing field and explicit undefined are idempotent", async () => {
    const input1 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        // subscriptionUserinfo is missing (not set)
      },
    });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-dm01");
    const r1 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      distribution: {
        providerName: "Test",
        sourceHost: "h.com",
        subscriptionUserinfo: undefined, // explicitly undefined
      },
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-dm02");
    const r2 = await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Should be idempotent — same versionId
    expect(r2.versionId).toBe(r1.versionId);
  });
});

// ---------------------------------------------------------------------------
// 5. getProviderMeta truly nonexistent returns null
// ---------------------------------------------------------------------------

describe("getProviderMeta nonexistent", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("returns null when both new and legacy meta are absent", async () => {
    const result = await getProviderMeta(
      mockBucket as unknown as R2Bucket,
      "nonexistent",
      "v1",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Non-current history provider.yaml tampered → export fails
// ---------------------------------------------------------------------------

describe("History version provider.yaml tampered", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("getVersionYamlForExport fails when non-current V1 provider.yaml is tampered", async () => {
    const slug = "hist-tamp";
    const input1 = createTestInput({ providerSlug: slug });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-ht01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      providerSlug: slug,
      generatorVersion: "2.0.0",
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-ht02");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Tamper V1's provider.yaml
    const keys1 = getVersionKeys(slug, "20260101T000000Z-9e20490d-ht01");
    mockBucket.tamperContent(keys1.provider, "TAMPERED");

    await expect(
      getVersionYamlForExport(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-ht01",
      ),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });

  it("getVersionJsonForExport fails when non-current V1 provider.yaml is tampered", async () => {
    const slug = "hist-tamp2";
    const input1 = createTestInput({ providerSlug: slug });
    const deps1 = fixedDeps("20260101T000000Z-9e20490d-ht03");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input1,
      deps1,
    );

    const input2 = createTestInput({
      providerSlug: slug,
      generatorVersion: "2.0.0",
    });
    const deps2 = fixedDeps("20260101T000000Z-9e20490d-ht04");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input2,
      deps2,
    );

    // Tamper V1's provider.yaml
    const keys1 = getVersionKeys(slug, "20260101T000000Z-9e20490d-ht03");
    mockBucket.tamperContent(keys1.provider, "TAMPERED");

    await expect(
      getVersionJsonForExport(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-ht03",
      ),
    ).rejects.toMatchObject({ code: "STORED_VERSION_CORRUPTED" });
  });
});

// ---------------------------------------------------------------------------
// 7. Invalid latest.json export fails
// ---------------------------------------------------------------------------

describe("Invalid latest.json export", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws INVALID_STORED_POINTER when latest.json is not valid JSON", async () => {
    await mockBucket.put(
      "providers/bad-export/latest.json",
      "NOT VALID JSON {{{",
    );

    await expect(
      getLatestJsonForExport(mockBucket as unknown as R2Bucket, "bad-export"),
    ).rejects.toMatchObject({ code: "INVALID_STORED_POINTER" });
  });
});

// ---------------------------------------------------------------------------
// 8. Invalid rollback versionId
// ---------------------------------------------------------------------------

describe("Invalid rollback versionId", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("rejects versionId with path traversal ../x", async () => {
    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        "test-provider",
        "../x",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects versionId with slash a/b", async () => {
    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, "test-provider", "a/b"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects versionId with backslash a\\b", async () => {
    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        "test-provider",
        "a\\b",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects versionId with control characters", async () => {
    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        "test-provider",
        "v1\x00evil",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects empty versionId", async () => {
    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, "test-provider", ""),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects invalid slug", async () => {
    await expect(
      rollbackLatest(mockBucket as unknown as R2Bucket, "../evil", "v1"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// ---------------------------------------------------------------------------
// 9. Current latest.json invalid → rollback rejects
// ---------------------------------------------------------------------------

describe("Rollback with invalid current latest.json", () => {
  beforeEach(() => {
    mockBucket.clear();
  });

  it("throws INVALID_STORED_POINTER when current latest.json is corrupt JSON", async () => {
    const slug = "rb-corrupt";
    const input = createTestInput({ providerSlug: slug });
    const deps = fixedDeps("20260101T000000Z-9e20490d-rc01");
    await publishProviderVersion(
      mockBucket as unknown as R2Bucket,
      input,
      deps,
    );

    // Corrupt latest.json
    mockBucket.tamperContent(`providers/${slug}/latest.json`, "NOT JSON");

    await expect(
      rollbackLatest(
        mockBucket as unknown as R2Bucket,
        slug,
        "20260101T000000Z-9e20490d-rc01",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STORED_POINTER" });

    // Verify latest.json was NOT overwritten
    expect(mockBucket.getRaw(`providers/${slug}/latest.json`)).toBe("NOT JSON");
  });
});
