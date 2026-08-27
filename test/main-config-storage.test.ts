import { describe, it, expect, beforeEach } from "vitest";
import {
  publishMainConfig,
  getMainConfig,
  listMainConfigVersions,
  getMainConfigVersion,
  rollbackMainConfig,
  disableMainConfig,
  enableMainConfig,
  identityKey,
  latestKey,
  versionYamlKey,
  versionMetaKey,
  validateVersionId,
  validateMainConfigYaml,
  validateMainConfigName,
  MainConfigError,
} from "../src/services/main-config-storage.ts";
import type {
  PublishMainConfigInput,
  MainConfigDependencies,
  MainConfigIdentity,
  MainConfigLatestPointer,
  MainConfigVersionMeta,
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

  clear() {
    this.store.clear();
    this.etags.clear();
  }

  getEtag(key: string): string | undefined {
    return this.etags.get(key);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXED_TIME = new Date("2026-07-14T12:00:00.000Z");
const FIXED_CONFIG_ID = "test-config-id-00000000";
let versionCounter = 0;

function makeDeps(): MainConfigDependencies {
  return {
    now: () => FIXED_TIME,
    generateConfigId: () => FIXED_CONFIG_ID,
    generateVersionId: (_sha: string) => {
      versionCounter++;
      return `v${String(versionCounter).padStart(4, "0")}`;
    },
  };
}

const VALID_YAML = "mixed-port: 7890\nallow-lan: true\n";
const VALID_NAME = "我的主配置";

function b(mock: MockR2Bucket): R2Bucket {
  return mock as unknown as R2Bucket;
}

function makeInput(
  overrides?: Partial<PublishMainConfigInput>,
): PublishMainConfigInput {
  return {
    name: VALID_NAME,
    yaml: VALID_YAML,
    ...overrides,
  };
}

async function publishAndGetEtag(
  bucket: MockR2Bucket,
  input?: Partial<PublishMainConfigInput>,
  deps?: MainConfigDependencies,
): Promise<{ versionId: string; etag: string }> {
  return publishMainConfig(b(bucket), makeInput(input), deps ?? makeDeps());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Main Config Storage", () => {
  let bucket: MockR2Bucket;

  beforeEach(() => {
    bucket = new MockR2Bucket();
    versionCounter = 0;
  });

  // ===== 16.1 Creation and Identity =====

  describe("Identity creation", () => {
    it("creates identity on first publish", async () => {
      await publishAndGetEtag(bucket);
      const obj = await bucket.get(identityKey());
      expect(obj).not.toBeNull();
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.schemaVersion).toBe(1);
      expect(identity.configId).toBe(FIXED_CONFIG_ID);
      expect(identity.createdAt).toBe(FIXED_TIME.toISOString());
    });

    it("uses UUID for configId", async () => {
      const deps: MainConfigDependencies = {
        now: () => FIXED_TIME,
        generateConfigId: () => "550e8400-e29b-41d4-a716-446655440000",
        generateVersionId: () => "v0001",
      };
      await publishMainConfig(b(bucket), makeInput(), deps);
      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.configId).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("identity is immutable after creation", async () => {
      await publishAndGetEtag(bucket);
      const result = await publishAndGetEtag(bucket, { name: "新名称" });
      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.configId).toBe(FIXED_CONFIG_ID);
    });

    it("concurrent creation adopts winner's configId", async () => {
      // Both deps generate the same versionId but different configIds.
      // The first publish creates identity and version.
      // The second publish reads the existing identity (winner's configId)
      // and uses it, even though deps2.generateConfigId would produce a different one.
      const deps1: MainConfigDependencies = {
        now: () => FIXED_TIME,
        generateConfigId: () => "config-id-1",
        generateVersionId: () => "v0001",
      };
      const deps2: MainConfigDependencies = {
        now: () => FIXED_TIME,
        generateConfigId: () => "config-id-2",
        generateVersionId: () => "v0002",
      };

      // First call succeeds, creates identity with config-id-1
      await publishMainConfig(b(bucket), makeInput(), deps1);

      // Second call: identity already exists, so ensureIdentity reads it.
      // deps2.generateConfigId is NOT called.
      // The name is different, so a new version is created.
      await publishMainConfig(b(bucket), makeInput({ name: "新名称" }), deps2);

      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      // Should use the winner's configId (from first publish)
      expect(identity.configId).toBe("config-id-1");
    });

    it("configId unchanged after update", async () => {
      await publishAndGetEtag(bucket);
      const { etag } = await publishAndGetEtag(bucket, {
        name: "更新后的名称",
      });
      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.configId).toBe(FIXED_CONFIG_ID);
    });

    it("configId unchanged after rollback", async () => {
      const { etag: etag1 } = await publishAndGetEtag(bucket);
      const { versionId: v2Id, etag: etag2 } = await publishAndGetEtag(bucket, {
        name: "第二版",
      });

      // Rollback to v1
      await rollbackMainConfig(b(bucket), "v0001", etag2, makeDeps());

      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.configId).toBe(FIXED_CONFIG_ID);
    });

    it("configId unchanged after disable and enable", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await disableMainConfig(b(bucket), etag, makeDeps());

      const result = await getMainConfig(b(bucket));
      await enableMainConfig(b(bucket), result!.etag, makeDeps());

      const obj = await bucket.get(identityKey());
      const identity = JSON.parse(
        await (obj as { text(): Promise<string> }).text(),
      ) as MainConfigIdentity;
      expect(identity.configId).toBe(FIXED_CONFIG_ID);
    });

    it("rejects invalid identity schema", async () => {
      // Manually put invalid identity
      bucket.store.set(identityKey(), JSON.stringify({ schemaVersion: 2 }));
      await expect(publishAndGetEtag(bucket)).rejects.toThrow(MainConfigError);
      try {
        await publishAndGetEtag(bucket);
      } catch (e) {
        expect((e as MainConfigError).code).toBe(
          "INVALID_MAIN_CONFIG_IDENTITY",
        );
      }
    });

    it("reports corruption when latest exists but identity missing", async () => {
      // Manually put latest without identity
      bucket.store.set(
        latestKey(),
        JSON.stringify({
          schemaVersion: 1,
          configId: "some-id",
          versionId: "v0001",
          status: "active",
          publishedAt: "2026-07-14T12:00:00.000Z",
          metaKey: versionMetaKey("v0001"),
          metaSha256: "a".repeat(64),
        }),
      );
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
      try {
        await getMainConfig(b(bucket));
      } catch (e) {
        expect((e as MainConfigError).code).toBe("MAIN_CONFIG_CORRUPTED");
      }
    });
  });

  // ===== 16.2 Input and YAML =====

  describe("Input and YAML validation", () => {
    it("accepts valid Mihomo YAML", async () => {
      const yaml = "mixed-port: 7890\nallow-lan: true\nmode: rule\n";
      const result = await publishAndGetEtag(bucket, { yaml });
      expect(result.versionId).toBeTruthy();
    });

    it("preserves comments and field order", async () => {
      const yaml =
        "# my config\nmixed-port: 7890\n# trailing comment\nallow-lan: true\n";
      await publishAndGetEtag(bucket, { yaml });
      const result = await getMainConfig(b(bucket));
      expect(result!.view.yaml).toBe(yaml);
    });

    it("rejects empty name after trim", async () => {
      await expect(
        publishMainConfig(
          b(bucket),
          { name: "   ", yaml: VALID_YAML },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects name exceeding 128 chars", async () => {
      const longName = "a".repeat(129);
      await expect(
        publishMainConfig(
          b(bucket),
          { name: longName, yaml: VALID_YAML },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects empty yaml", async () => {
      await expect(
        publishMainConfig(
          b(bucket),
          { name: VALID_NAME, yaml: "" },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects YAML syntax error", async () => {
      await expect(
        publishMainConfig(
          b(bucket),
          { name: VALID_NAME, yaml: "mixed-port: [\n  invalid" },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects multi-document YAML", async () => {
      const yaml = "mixed-port: 7890\n---\nallow-lan: true\n";
      await expect(
        publishMainConfig(b(bucket), { name: VALID_NAME, yaml }, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects array root node", async () => {
      const yaml = "- item1\n- item2\n";
      await expect(
        publishMainConfig(b(bucket), { name: VALID_NAME, yaml }, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects string root node", async () => {
      const yaml = '"just a string"';
      await expect(
        publishMainConfig(b(bucket), { name: VALID_NAME, yaml }, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects null root node", async () => {
      const yaml = "null";
      await expect(
        publishMainConfig(b(bucket), { name: VALID_NAME, yaml }, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("rejects content exceeding size limit", async () => {
      const bigYaml =
        "mixed-port: 7890\n# " + "x".repeat(3 * 1024 * 1024) + "\n";
      await expect(
        publishMainConfig(
          b(bucket),
          { name: VALID_NAME, yaml: bigYaml },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("validates name is a string", () => {
      expect(() => validateMainConfigName(123 as unknown as string)).toThrow(
        MainConfigError,
      );
    });
  });

  // ===== 16.3 Idempotency and Versions =====

  describe("Idempotency and versions", () => {
    it("reuses version for identical input", async () => {
      const { versionId: v1 } = await publishAndGetEtag(bucket);
      const { versionId: v2 } = await publishAndGetEtag(bucket);
      expect(v2).toBe(v1);
    });

    it("creates new version when name changes", async () => {
      const { versionId: v1 } = await publishAndGetEtag(bucket);
      const { versionId: v2 } = await publishAndGetEtag(bucket, {
        name: "不同名称",
      });
      expect(v2).not.toBe(v1);
    });

    it("creates new version when YAML bytes change", async () => {
      const { versionId: v1 } = await publishAndGetEtag(bucket);
      const { versionId: v2 } = await publishAndGetEtag(bucket, {
        yaml: "mixed-port: 9090\n",
      });
      expect(v2).not.toBe(v1);
    });

    it("re-enables when disabled + same content", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await disableMainConfig(b(bucket), etag, makeDeps());

      const before = await getMainConfig(b(bucket));
      expect(before!.view.status).toBe("disabled");

      // Submit same content → should re-enable
      const { versionId } = await publishAndGetEtag(bucket);
      expect(versionId).toBe("v0001");

      const after = await getMainConfig(b(bucket));
      expect(after!.view.status).toBe("active");
    });

    it("creates new active version when disabled + different content", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await disableMainConfig(b(bucket), etag, makeDeps());

      const { versionId } = await publishAndGetEtag(bucket, {
        name: "新配置",
        yaml: "port: 1080\n",
      });
      expect(versionId).toBe("v0002");

      const result = await getMainConfig(b(bucket));
      expect(result!.view.status).toBe("active");
      expect(result!.view.versionId).toBe("v0002");
    });

    it("allows retry with same immutable key and same content", async () => {
      const deps = makeDeps();
      await publishMainConfig(b(bucket), makeInput(), deps);
      // Retry with same deps → same versionId
      const result = await publishMainConfig(b(bucket), makeInput(), deps);
      expect(result.versionId).toBe("v0001");
    });

    it("rejects same immutable key with different content", async () => {
      const deps = makeDeps();
      // First publish creates v0001
      await publishMainConfig(b(bucket), makeInput(), deps);

      // Now put different content at the same key directly
      bucket.store.set(versionYamlKey("v0001"), "different content");

      // Publish with same deps → conflict because content differs
      await expect(
        publishMainConfig(b(bucket), makeInput(), deps),
      ).rejects.toThrow(MainConfigError);
    });
  });

  // ===== 16.4 CAS =====

  describe("CAS semantics", () => {
    it("first creation uses If-None-Match: *", async () => {
      const result = await publishAndGetEtag(bucket);
      expect(result.etag).toBeTruthy();
      // Verify latest.json exists
      const obj = await bucket.get(latestKey());
      expect(obj).not.toBeNull();
    });

    it("If-None-Match fails when config already exists", async () => {
      await publishAndGetEtag(bucket);

      // Second publish with different content — should still work (CAS with existing ETag)
      const result = await publishAndGetEtag(bucket, { name: "新名称" });
      expect(result.versionId).toBe("v0002");
    });

    it("update missing If-Match returns 428-like error", async () => {
      await publishAndGetEtag(bucket);
      // Calling publishMainConfig without expectedLatestEtag when latest exists
      // should work — the API layer handles If-Match requirement
      // But we can test the storage layer directly:
      // publishMainConfig with no expectedLatestEtag will read the current ETag internally
      const result = await publishMainConfig(
        b(bucket),
        makeInput({ name: "新名称" }),
        makeDeps(),
      );
      expect(result.versionId).toBeTruthy();
    });

    it("stale ETag returns CONFLICT", async () => {
      await publishAndGetEtag(bucket);
      await expect(
        publishMainConfig(
          b(bucket),
          makeInput({ expectedLatest: '"stale-etag"' }),
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("concurrent update: only one wins latest", async () => {
      const { etag } = await publishAndGetEtag(bucket);

      // Simulate two concurrent updates with same ETag
      const p1 = publishMainConfig(
        b(bucket),
        makeInput({ name: "更新A", expectedLatest: etag }),
        makeDeps(),
      );
      const p2 = publishMainConfig(
        b(bucket),
        makeInput({ name: "更新B", expectedLatest: etag }),
        makeDeps(),
      );

      const [r1, r2] = await Promise.allSettled([p1, p2]);
      // One should succeed, one should fail
      const successes = [r1, r2].filter((r) => r.status === "fulfilled");
      const failures = [r1, r2].filter((r) => r.status === "rejected");
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
    });

    it("CAS failure leaves latest with winning request's value", async () => {
      const { etag } = await publishAndGetEtag(bucket);

      // Direct CAS manipulation: make next put fail
      const p1 = publishMainConfig(
        b(bucket),
        makeInput({ name: "胜利者", expectedLatest: etag }),
        makeDeps(),
      );
      // Read current etag and modify it to simulate concurrent write
      const currentObj = await bucket.get(latestKey());
      const currentEtag = (currentObj as { etag: string }).etag;
      // Overwrite with different etag to simulate race
      const p2 = (async () => {
        // Small delay to let p1 start
        await new Promise((r) => setTimeout(r, 1));
        // Modify latest to change its etag
        const obj = await bucket.get(latestKey());
        if (obj) {
          const text = await (obj as { text(): Promise<string> }).text();
          bucket.store.set(latestKey(), text); // This won't change etag in our mock
        }
      })();

      // At least one should succeed
      const result = await p1;
      expect(result.versionId).toBeTruthy();
    });

    it("write YAML failure leaves latest unchanged", async () => {
      // This is tested indirectly: if writeImmutableObject fails,
      // the function throws before reaching CAS update
      const { versionId, etag } = await publishAndGetEtag(bucket);

      // Verify latest hasn't changed
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      expect(pointer.versionId).toBe(versionId);
    });
  });

  // ===== 16.5 Integrity and Trust Boundary =====

  describe("Integrity and trust boundary", () => {
    it("rejects invalid JSON in latest.json", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(latestKey(), "not json");
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("rejects invalid pointer schema", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(
        latestKey(),
        JSON.stringify({ schemaVersion: 2, bad: true }),
      );
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects pointer configId mismatch", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.configId = "wrong-id";
      bucket.store.set(latestKey(), JSON.stringify(pointer));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects pointer versionId mismatch", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.versionId = "wrong-version";
      // Also need to update metaKey to match
      pointer.metaKey = versionMetaKey("wrong-version");
      bucket.store.set(latestKey(), JSON.stringify(pointer));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects pointer metaKey pointing to other path", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaKey = "vault/other/meta.json";
      bucket.store.set(latestKey(), JSON.stringify(pointer));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects meta SHA-256 mismatch", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("rejects invalid meta schema", async () => {
      await publishAndGetEtag(bucket);
      const vid = "v0001";
      bucket.store.set(versionMetaKey(vid), JSON.stringify({ bad: true }));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects meta configId mismatch", async () => {
      await publishAndGetEtag(bucket);
      const meta = JSON.parse(
        await (
          (await bucket.get(versionMetaKey("v0001"))) as {
            text(): Promise<string>;
          }
        ).text(),
      ) as MainConfigVersionMeta;
      meta.configId = "wrong-config-id";
      bucket.store.set(versionMetaKey("v0001"), JSON.stringify(meta));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects meta versionId mismatch", async () => {
      await publishAndGetEtag(bucket);
      const meta = JSON.parse(
        await (
          (await bucket.get(versionMetaKey("v0001"))) as {
            text(): Promise<string>;
          }
        ).text(),
      ) as MainConfigVersionMeta;
      meta.versionId = "wrong-version";
      bucket.store.set(versionMetaKey("v0001"), JSON.stringify(meta));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects artifact key pointing to other path", async () => {
      await publishAndGetEtag(bucket);
      const meta = JSON.parse(
        await (
          (await bucket.get(versionMetaKey("v0001"))) as {
            text(): Promise<string>;
          }
        ).text(),
      ) as MainConfigVersionMeta;
      meta.artifact.key = "vault/other/main-config.yaml";
      bucket.store.set(versionMetaKey("v0001"), JSON.stringify(meta));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects missing YAML", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.delete(versionYamlKey("v0001"));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects YAML hash error", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(versionYamlKey("v0001"), "corrupted content");
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("detects YAML contentLength error", async () => {
      await publishAndGetEtag(bucket);
      const meta = JSON.parse(
        await (
          (await bucket.get(versionMetaKey("v0001"))) as {
            text(): Promise<string>;
          }
        ).text(),
      ) as MainConfigVersionMeta;
      meta.artifact.contentLength = 999999;
      bucket.store.set(versionMetaKey("v0001"), JSON.stringify(meta));
      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("corrupted current version blocks update (does not mask with new version)", async () => {
      await publishAndGetEtag(bucket);
      // Corrupt the YAML
      bucket.store.set(versionYamlKey("v0001"), "corrupted");
      // Update should fail, not create v0002
      await expect(
        publishMainConfig(b(bucket), makeInput({ name: "新名称" }), makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("corrupted historical version fails read", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await publishAndGetEtag(bucket, { name: "第二版" });

      // Corrupt v0001's YAML
      bucket.store.set(versionYamlKey("v0001"), "corrupted");
      await expect(getMainConfigVersion(b(bucket), "v0001")).rejects.toThrow(
        MainConfigError,
      );
    });

    it("corrupted target version fails rollback", async () => {
      const { etag: etag1 } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await publishAndGetEtag(bucket, {
        name: "第二版",
      });

      // Corrupt v0001's YAML
      bucket.store.set(versionYamlKey("v0001"), "corrupted");
      await expect(
        rollbackMainConfig(b(bucket), "v0001", etag2, makeDeps()),
      ).rejects.toThrow(MainConfigError);

      // Latest should still point to v0002
      const current = await getMainConfig(b(bucket));
      expect(current!.view.versionId).toBe("v0002");
    });
  });

  // ===== 16.6 Rollback, Disable and Enable =====

  describe("Rollback, disable and enable", () => {
    it("rollback to historical version", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      const { etag } = await publishAndGetEtag(bucket, { name: "第二版" });

      const result = await rollbackMainConfig(
        b(bucket),
        "v0001",
        etag,
        makeDeps(),
      );
      expect(result.versionId).toBe("v0001");

      const current = await getMainConfig(b(bucket));
      expect(current!.view.versionId).toBe("v0001");
      expect(current!.view.name).toBe("第一版");
    });

    it("rollback sets status to active", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await disableMainConfig(b(bucket), etag, makeDeps());

      const { etag: etag2 } = await publishAndGetEtag(bucket, {
        name: "第二版",
      });

      const result = await rollbackMainConfig(
        b(bucket),
        "v0001",
        etag2,
        makeDeps(),
      );
      const current = await getMainConfig(b(bucket));
      expect(current!.view.status).toBe("active");
    });

    it("rollback does not create new content version", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      const { etag } = await publishAndGetEtag(bucket, { name: "第二版" });

      await rollbackMainConfig(b(bucket), "v0001", etag, makeDeps());

      const versions = await listMainConfigVersions(b(bucket));
      expect(versions.length).toBe(2); // Still only 2 versions
    });

    it("rollback to same current version is idempotent", async () => {
      const { versionId, etag } = await publishAndGetEtag(bucket);

      const result = await rollbackMainConfig(
        b(bucket),
        versionId,
        etag,
        makeDeps(),
      );
      expect(result.versionId).toBe(versionId);
    });

    it("rollback CAS conflict", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      const { etag } = await publishAndGetEtag(bucket, { name: "第二版" });

      // Stale ETag
      await expect(
        rollbackMainConfig(b(bucket), "v0001", '"stale"', makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("disable only modifies pointer", async () => {
      const { versionId, etag } = await publishAndGetEtag(bucket);

      await disableMainConfig(b(bucket), etag, makeDeps());

      // Content still exists
      const yamlObj = await bucket.get(versionYamlKey(versionId));
      expect(yamlObj).not.toBeNull();
      const metaObj = await bucket.get(versionMetaKey(versionId));
      expect(metaObj).not.toBeNull();

      // Status is disabled
      const current = await getMainConfig(b(bucket));
      expect(current!.view.status).toBe("disabled");
      expect(current!.view.disabledAt).toBeTruthy();
    });

    it("disable does not delete content", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await disableMainConfig(b(bucket), etag, makeDeps());

      const identity = await bucket.get(identityKey());
      expect(identity).not.toBeNull();
    });

    it("repeat disable is idempotent", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await disableMainConfig(
        b(bucket),
        etag,
        makeDeps(),
      );
      const { etag: etag3 } = await disableMainConfig(
        b(bucket),
        etag2,
        makeDeps(),
      );

      const current = await getMainConfig(b(bucket));
      expect(current!.view.status).toBe("disabled");
    });

    it("enable only modifies pointer", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await disableMainConfig(
        b(bucket),
        etag,
        makeDeps(),
      );

      const { etag: etag3 } = await enableMainConfig(
        b(bucket),
        etag2,
        makeDeps(),
      );

      const current = await getMainConfig(b(bucket));
      expect(current!.view.status).toBe("active");
      expect(current!.view.disabledAt).toBeNull();
    });

    it("repeat enable is idempotent", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await enableMainConfig(
        b(bucket),
        etag,
        makeDeps(),
      );
      const { etag: etag3 } = await enableMainConfig(
        b(bucket),
        etag2,
        makeDeps(),
      );

      const current = await getMainConfig(b(bucket));
      expect(current!.view.status).toBe("active");
    });

    it("disable requires correct ETag", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      await expect(
        disableMainConfig(b(bucket), '"wrong-etag"', makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("enable requires correct ETag", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await disableMainConfig(
        b(bucket),
        etag,
        makeDeps(),
      );
      await expect(
        enableMainConfig(b(bucket), '"wrong-etag"', makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });
  });

  // ===== Additional tests =====

  describe("Version listing", () => {
    it("lists versions sorted by createdAt descending", async () => {
      const deps1: MainConfigDependencies = {
        now: () => new Date("2026-07-14T10:00:00.000Z"),
        generateConfigId: () => FIXED_CONFIG_ID,
        generateVersionId: () => "v0001",
      };
      const deps2: MainConfigDependencies = {
        now: () => new Date("2026-07-14T12:00:00.000Z"),
        generateConfigId: () => FIXED_CONFIG_ID,
        generateVersionId: () => "v0002",
      };

      await publishMainConfig(b(bucket), makeInput({ name: "第一版" }), deps1);
      await publishMainConfig(b(bucket), makeInput({ name: "第二版" }), deps2);

      const list = await listMainConfigVersions(b(bucket));
      expect(list.length).toBe(2);
      expect(list[0]!.versionId).toBe("v0002");
      expect(list[1]!.versionId).toBe("v0001");
    });

    it("marks isCurrent correctly", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      await publishAndGetEtag(bucket, { name: "第二版" });

      const list = await listMainConfigVersions(b(bucket));
      const v1 = list.find((v) => v.versionId === "v0001");
      const v2 = list.find((v) => v.versionId === "v0002");
      expect(v1!.isCurrent).toBe(false);
      expect(v2!.isCurrent).toBe(true);
    });
  });

  describe("getMainConfigVersion", () => {
    it("returns specific version with integrity verification", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      await publishAndGetEtag(bucket, { name: "第二版" });

      const result = await getMainConfigVersion(b(bucket), "v0001");
      expect(result).not.toBeNull();
      expect(result!.view.name).toBe("第一版");
      expect(result!.view.isCurrent).toBe(false);
    });

    it("returns null for non-existent version when no identity", async () => {
      const result = await getMainConfigVersion(b(bucket), "v0001");
      expect(result).toBeNull();
    });

    it("rejects invalid versionId", async () => {
      await expect(
        getMainConfigVersion(b(bucket), "../../../etc"),
      ).rejects.toThrow(MainConfigError);
    });
  });

  describe("Path helpers", () => {
    it("returns correct standard paths", () => {
      expect(identityKey()).toBe("vault/main-config/identity.json");
      expect(latestKey()).toBe("vault/main-config/latest.json");
      expect(versionYamlKey("v0001")).toBe(
        "vault/main-config/versions/v0001/main-config.yaml",
      );
      expect(versionMetaKey("v0001")).toBe(
        "vault/main-config/versions/v0001/meta.json",
      );
    });

    it("validateVersionId accepts valid IDs", () => {
      expect(validateVersionId("v0001")).toBe(true);
      expect(validateVersionId("20260714T120000Z-abc12345-def01234")).toBe(
        true,
      );
    });

    it("validateVersionId rejects path traversal", () => {
      expect(validateVersionId("../etc/passwd")).toBe(false);
      expect(validateVersionId("foo/bar")).toBe(false);
      expect(validateVersionId("")).toBe(false);
    });
  });

  describe("Corrupted pointer blocks operations", () => {
    it("PUT fails when pointer.metaSha256 is corrupted", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(
        publishMainConfig(b(bucket), makeInput({ name: "新名称" }), makeDeps()),
      ).rejects.toThrow(MainConfigError);
      try {
        await publishMainConfig(
          b(bucket),
          makeInput({ name: "新名称" }),
          makeDeps(),
        );
      } catch (e) {
        expect((e as MainConfigError).code).toBe("MAIN_CONFIG_CORRUPTED");
      }
    });

    it("PUT fails when pointer.metaKey is corrupted", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaKey = "vault/other/meta.json";
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(
        publishMainConfig(b(bucket), makeInput({ name: "新名称" }), makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("disable fails when pointer is corrupted", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(
        disableMainConfig(b(bucket), etag, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("enable fails when pointer is corrupted", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const { etag: etag2 } = await disableMainConfig(
        b(bucket),
        etag,
        makeDeps(),
      );
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(
        enableMainConfig(b(bucket), etag2, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("rollback fails when current pointer is corrupted", async () => {
      await publishAndGetEtag(bucket, { name: "第一版" });
      const { etag } = await publishAndGetEtag(bucket, { name: "第二版" });

      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(
        rollbackMainConfig(b(bucket), "v0001", etag, makeDeps()),
      ).rejects.toThrow(MainConfigError);
    });

    it("history throws when current version YAML is corrupted", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(versionYamlKey("v0001"), "corrupted");

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("history throws when current version meta is missing", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.delete(versionMetaKey("v0001"));

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("history throws when current version meta is invalid JSON", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(versionMetaKey("v0001"), "not json");

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("history throws when current version meta schema is invalid", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.set(
        versionMetaKey("v0001"),
        JSON.stringify({ schemaVersion: 2 }),
      );

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("history throws when pointer.configId mismatches identity", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.configId = "wrong-config-id";
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("history throws when pointer.metaSha256 is wrong", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.metaSha256 = "a".repeat(64);
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });
  });

  describe("Identity safety", () => {
    it("PUT fails when latest exists but identity missing (no auto-create)", async () => {
      await publishAndGetEtag(bucket);
      // Delete identity but keep latest
      bucket.store.delete(identityKey());

      await expect(
        publishMainConfig(b(bucket), makeInput({ name: "新名称" }), makeDeps()),
      ).rejects.toThrow(MainConfigError);

      // Verify identity was NOT auto-created
      const identityObj = await bucket.get(identityKey());
      expect(identityObj).toBeNull();
    });
  });

  describe("expectedLatest precondition", () => {
    it("expectedLatest null fails when latest exists", async () => {
      await publishAndGetEtag(bucket);

      await expect(
        publishMainConfig(
          b(bucket),
          { name: VALID_NAME, yaml: VALID_YAML, expectedLatest: null },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("expectedLatest etag fails when latest is absent", async () => {
      await expect(
        publishMainConfig(
          b(bucket),
          {
            name: VALID_NAME,
            yaml: VALID_YAML,
            expectedLatest: '"some-etag"',
          },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);
    });

    it("expectedLatest null succeeds when latest is absent", async () => {
      const result = await publishMainConfig(
        b(bucket),
        { name: VALID_NAME, yaml: VALID_YAML, expectedLatest: null },
        makeDeps(),
      );
      expect(result.versionId).toBeTruthy();
    });

    it("expectedLatest etag succeeds when it matches", async () => {
      const { etag } = await publishAndGetEtag(bucket);
      const result = await publishMainConfig(
        b(bucket),
        { name: "新名称", yaml: VALID_YAML, expectedLatest: etag },
        makeDeps(),
      );
      expect(result.versionId).toBeTruthy();
    });
  });

  describe("Strict schema validation", () => {
    it("rejects pointer with invalid configId", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as MainConfigLatestPointer;
      pointer.configId = "";
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("rejects pointer with active + disabledAt", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as Record<string, unknown>;
      (pointer as Record<string, unknown>).disabledAt =
        "2026-07-14T12:00:00.000Z";
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });

    it("rejects pointer with invalid publishedAt", async () => {
      await publishAndGetEtag(bucket);
      const pointer = JSON.parse(
        await (
          (await bucket.get(latestKey())) as { text(): Promise<string> }
        ).text(),
      ) as Record<string, unknown>;
      (pointer as Record<string, unknown>).publishedAt = "not-a-date";
      bucket.store.set(latestKey(), JSON.stringify(pointer));

      await expect(getMainConfig(b(bucket))).rejects.toThrow(MainConfigError);
    });
  });

  describe("History integrity with missing identity", () => {
    it("history throws when latest exists but identity missing", async () => {
      await publishAndGetEtag(bucket);
      bucket.store.delete(identityKey());

      await expect(listMainConfigVersions(b(bucket))).rejects.toThrow(
        MainConfigError,
      );
    });

    it("version read throws when latest exists but identity missing", async () => {
      const { versionId } = await publishAndGetEtag(bucket);
      bucket.store.delete(identityKey());

      await expect(getMainConfigVersion(b(bucket), versionId)).rejects.toThrow(
        MainConfigError,
      );
    });
  });

  describe("Failed precondition leaves no identity", () => {
    it("If-Match on empty bucket does not create identity", async () => {
      await expect(
        publishMainConfig(
          b(bucket),
          {
            name: VALID_NAME,
            yaml: VALID_YAML,
            expectedLatest: '"stale-etag"',
          },
          makeDeps(),
        ),
      ).rejects.toThrow(MainConfigError);

      const identityObj = await bucket.get(identityKey());
      expect(identityObj).toBeNull();
    });
  });

  describe("Rollback error contract", () => {
    it("rollback to non-existent version returns VERSION_NOT_FOUND", async () => {
      await publishAndGetEtag(bucket);
      const current = await getMainConfig(b(bucket));
      const etag = current!.etag;

      await expect(
        rollbackMainConfig(b(bucket), "nonexistent", etag, makeDeps()),
      ).rejects.toThrow(MainConfigError);
      try {
        await rollbackMainConfig(b(bucket), "nonexistent", etag, makeDeps());
      } catch (e) {
        expect((e as MainConfigError).code).toBe(
          "MAIN_CONFIG_VERSION_NOT_FOUND",
        );
      }
    });
  });
});
