import { describe, expect, it, beforeEach } from "vitest";
import {
  createLlmKey,
  deleteLlmKey,
  getLlmKey,
  listLlmKeys,
  listLlmSlugs,
  llmMetaKey,
  llmSecretKey,
  normalizeLlmKeyCreate,
  normalizeLlmKeyUpdate,
  revealLlmKey,
  updateLlmKey,
  LlmKeyError,
} from "../src/services/llm-key-store.ts";
import * as storage from "../src/services/storage.ts";
import { sha256HexText } from "../src/security/llm-crypto.ts";

// ---------------------------------------------------------------------------
// Mock R2Bucket (supports delimiter listing, head, delete)
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

  async head(key: string): Promise<unknown> {
    const stored = this.store.get(key);
    if (stored === undefined) return null;
    return {
      key,
      etag: this.etags.get(key) || `"${stored.length}"`,
      size: new TextEncoder().encode(stored).length,
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
      const current = this.etags.get(key);
      if (opts.onlyIf.etagDoesNotMatch === "*") {
        if (current !== undefined) return null;
      } else if (opts.onlyIf.etagMatches !== undefined) {
        if (!current || current !== opts.onlyIf.etagMatches) return null;
      }
    }
    const newEtag = `"${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}"`;
    this.store.set(key, text);
    this.etags.set(key, newEtag);
    return { key, etag: newEtag };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.etags.delete(key);
  }

  async list(opts?: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts?.prefix || "";
    const delimiter = opts?.delimiter || "";
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix));
    if (!delimiter) {
      return {
        objects: keys.map((key) => ({ key })),
        delimitedPrefixes: [] as string[],
        truncated: false,
        cursor: undefined as string | undefined,
      };
    }
    const dirs = new Set<string>();
    const objects: { key: string }[] = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index >= 0) {
        dirs.add(prefix + rest.slice(0, index + delimiter.length));
      } else {
        objects.push({ key });
      }
    }
    return {
      objects,
      delimitedPrefixes: [...dirs],
      truncated: false,
      cursor: undefined as string | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INSTANCE_SECRET = "test-instance-secret-0123456789abcdef";
const OTHER_SECRET = "another-instance-secret-0123456789abcd";
const FIXED_TIME = new Date("2026-08-27T10:00:00.000Z");
const API_KEY = "sk-example-deepseek-0001";

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: "deepseek-main",
    name: "DeepSeek 主账号",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat"],
    notes: "",
    tags: [],
    apiKey: API_KEY,
    ...overrides,
  };
}

let mock: MockR2Bucket;
// The double implements only the R2 surface the credential store touches, so
// it is cast once here instead of at every call site.
let bucket: R2Bucket;

beforeEach(() => {
  mock = new MockR2Bucket();
  bucket = mock as unknown as R2Bucket;
});

async function expectLlmError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LlmKeyError);
  expect((caught as LlmKeyError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Creation and storage shape
// ---------------------------------------------------------------------------

describe("llm-key-store: create", () => {
  it("stores encrypted ciphertext plus plaintext metadata", async () => {
    const meta = await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      makeInput(),
      FIXED_TIME,
    );

    expect(meta.slug).toBe("deepseek-main");
    expect(meta.hint).toEqual({ last4: "0001", length: API_KEY.length });
    expect(meta.createdAt).toBe(FIXED_TIME.toISOString());

    const storedMeta = mock.store.get(llmMetaKey("deepseek-main"))!;
    expect(storedMeta).not.toContain(API_KEY);
    expect(JSON.parse(storedMeta).secret.sha256).toHaveLength(64);

    const storedSecret = mock.store.get(llmSecretKey("deepseek-main"))!;
    expect(storedSecret).not.toContain(API_KEY);
    expect(JSON.parse(storedSecret).algorithm).toBe("AES-GCM");
    // The meta hash is the commit point for the ciphertext on disk.
    expect(JSON.parse(storedMeta).secret.sha256).toBe(
      await sha256HexText(storedSecret),
    );
  });

  it("rejects a duplicate slug without touching the stored secret", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    const before = mock.store.get(llmSecretKey("deepseek-main"));

    await expectLlmError(
      createLlmKey(
        bucket,
        INSTANCE_SECRET,
        makeInput({ apiKey: "sk-another-key-0002" }),
        FIXED_TIME,
      ),
      "LLM_KEY_CONFLICT",
    );
    expect(mock.store.get(llmSecretKey("deepseek-main"))).toBe(before);
  });

  it("creates without a pre-flight existence read", async () => {
    const api = mock as unknown as {
      get(key: string): Promise<unknown>;
      head(key: string): Promise<unknown>;
    };
    const originalGet = api.get.bind(api);
    const originalHead = api.head.bind(api);
    let reads = 0;
    api.get = async (key: string) => {
      reads++;
      return originalGet(key);
    };
    api.head = async (key: string) => {
      reads++;
      return originalHead(key);
    };

    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);

    // The conditional put is the conflict check, so create is write-only.
    expect(reads).toBe(0);
  });

  it("records the ciphertext ETag so a rotation needs no extra read", async () => {
    const created = await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      makeInput(),
      FIXED_TIME,
    );
    expect(created.secret.etag).toBeTruthy();

    const api = mock as unknown as { get(key: string): Promise<unknown> };
    const originalGet = api.get.bind(api);
    let secretReads = 0;
    api.get = async (key: string) => {
      if (key === llmSecretKey("deepseek-main")) secretReads++;
      return originalGet(key);
    };

    await updateLlmKey(
      bucket,
      INSTANCE_SECRET,
      "deepseek-main",
      { apiKey: "sk-rotated-key-9999" },
      FIXED_TIME,
    );
    expect(secretReads).toBe(0);

    // A record written before the ETag field existed still works: it falls back
    // to reading the ciphertext once.
    const metaRecord = JSON.parse(mock.store.get(llmMetaKey("deepseek-main"))!);
    delete metaRecord.secret.etag;
    mock.store.set(llmMetaKey("deepseek-main"), JSON.stringify(metaRecord));
    await updateLlmKey(
      bucket,
      INSTANCE_SECRET,
      "deepseek-main",
      { apiKey: "sk-rotated-again-8888" },
      FIXED_TIME,
    );
    expect(secretReads).toBe(1);
  });

  it("refuses to store anything without a usable INSTANCE_SECRET", async () => {
    await expectLlmError(
      createLlmKey(bucket, undefined, makeInput(), FIXED_TIME),
      "LLM_STORE_UNAVAILABLE",
    );
    await expectLlmError(
      createLlmKey(bucket, "too-short", makeInput(), FIXED_TIME),
      "LLM_STORE_UNAVAILABLE",
    );
    expect(mock.store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

describe("llm-key-store: validation", () => {
  it("rejects invalid slugs", async () => {
    for (const slug of [
      "UPPER",
      "with space",
      "-leading",
      "a".repeat(64),
      "",
    ]) {
      await expectLlmError(
        createLlmKey(bucket, INSTANCE_SECRET, makeInput({ slug }), FIXED_TIME),
        "INVALID_SLUG",
      );
    }
  });

  it("rejects unsafe or malformed base URLs", () => {
    const cases = [
      "http://api.deepseek.com",
      "https://user:pass@api.deepseek.com",
      "not-a-url",
    ];
    for (const baseUrl of cases) {
      expect(() => normalizeLlmKeyCreate(makeInput({ baseUrl }))).toThrow(
        LlmKeyError,
      );
    }
    expect(
      normalizeLlmKeyCreate(makeInput({ baseUrl: "https://api.deepseek.com" }))
        .baseUrl,
    ).toBe("https://api.deepseek.com");
  });

  it("accepts name/slug/apiKey alone", async () => {
    // The management UI only collects these three fields.
    const minimal = {
      slug: "deepseek",
      name: "DeepSeek 主账号",
      apiKey: "sk-minimal-payload-0001",
    };
    const normalized = normalizeLlmKeyCreate(minimal);
    expect(normalized.provider).toBe("");
    expect(normalized.baseUrl).toBe("");
    expect(normalized.models).toEqual([]);
    expect(normalized.notes).toBe("");
    expect(normalized.tags).toEqual([]);

    const meta = await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      minimal,
      FIXED_TIME,
    );
    expect(meta.slug).toBe("deepseek");
    expect(meta.provider).toBe("");
    expect(
      (await revealLlmKey(bucket, INSTANCE_SECRET, "deepseek")).apiKey,
    ).toBe("sk-minimal-payload-0001");
  });

  it("allows clearing provider and baseUrl on update", () => {
    expect(normalizeLlmKeyUpdate({ provider: "", baseUrl: "" })).toEqual({
      provider: "",
      baseUrl: "",
    });
  });

  it("rejects malformed names, providers, models and keys", () => {
    expect(() => normalizeLlmKeyCreate(makeInput({ name: "" }))).toThrow();
    expect(() =>
      normalizeLlmKeyCreate(makeInput({ name: "x".repeat(65) })),
    ).toThrow();
    expect(() =>
      normalizeLlmKeyCreate(makeInput({ provider: "DeepSeek" })),
    ).toThrow();
    expect(() =>
      normalizeLlmKeyCreate(
        makeInput({ models: Array.from({ length: 101 }, (_, i) => `m${i}`) }),
      ),
    ).toThrow();
    expect(() =>
      normalizeLlmKeyCreate(makeInput({ apiKey: "short" })),
    ).toThrow();
    expect(() =>
      normalizeLlmKeyCreate(makeInput({ apiKey: "sk-has space-0001" })),
    ).toThrow();
  });

  it("normalizes optional fields and de-duplicates lists", () => {
    const normalized = normalizeLlmKeyCreate(
      makeInput({
        notes: "  备注  ",
        tags: ["a", "a", "b"],
        models: [" m1 ", "m1", "m2"],
      }),
    );
    expect(normalized.notes).toBe("备注");
    expect(normalized.tags).toEqual(["a", "b"]);
    expect(normalized.models).toEqual(["m1", "m2"]);
  });

  it("requires at least one field on update", () => {
    expect(() => normalizeLlmKeyUpdate({})).toThrow(LlmKeyError);
    expect(normalizeLlmKeyUpdate({ name: "新名字" }).name).toBe("新名字");
  });
});

// ---------------------------------------------------------------------------
// Listing and isolation
// ---------------------------------------------------------------------------

describe("llm-key-store: listing and isolation", () => {
  it("lists projections without the key or ciphertext", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      makeInput({
        slug: "mimo-main",
        provider: "xiaomi",
        apiKey: "sk-mimo-0002",
      }),
      new Date("2026-08-27T11:00:00.000Z"),
    );

    const items = await listLlmKeys(bucket);
    expect(items.map((item) => item.slug)).toEqual([
      "mimo-main",
      "deepseek-main",
    ]);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("sk-mimo-0002");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain(llmSecretKey("deepseek-main"));
    expect(items[0]!.secretPresent).toBe(true);
    expect(items[0]!.hint.last4).toBe("0002");
  });

  it("never mixes llm/ objects with the providers/ namespace", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    mock.store.set("providers/airport-a/latest.json", "{}");
    mock.store.set("providers/airport-a/versions/v1/meta.json", "{}");

    expect(await listLlmSlugs(bucket)).toEqual(["deepseek-main"]);
    // The subscription listing keeps ignoring llm/ entirely.
    expect(await storage.listSlugs(bucket)).toEqual(["airport-a"]);
  });

  it("reports integrity as missing when the ciphertext is gone", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    await mock.delete(llmSecretKey("deepseek-main"));

    const detail = await getLlmKey(bucket, "deepseek-main");
    expect(detail!.integrity).toBe("missing");
    const items = await listLlmKeys(bucket);
    expect(items[0]!.secretPresent).toBe(false);
  });

  it("returns null for an unknown slug", async () => {
    expect(await getLlmKey(bucket, "nope")).toBeNull();
  });

  it("lists with one R2 list call and no per-key HEAD", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      makeInput({ slug: "mimo-main", apiKey: "sk-mimo-0002" }),
      FIXED_TIME,
    );

    const api = mock as unknown as {
      list(opts?: unknown): Promise<unknown>;
      head(key: string): Promise<unknown>;
    };
    const originalList = api.list.bind(api);
    const originalHead = api.head.bind(api);
    let listCalls = 0;
    let headCalls = 0;
    api.list = async (opts?: unknown) => {
      listCalls++;
      return originalList(opts);
    };
    api.head = async (key: string) => {
      headCalls++;
      return originalHead(key);
    };

    const items = await listLlmKeys(bucket);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.secretPresent)).toBe(true);
    // Presence comes from the single listing pass, not a HEAD per credential.
    expect(listCalls).toBe(1);
    expect(headCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Update, rotation and concurrency
// ---------------------------------------------------------------------------

describe("llm-key-store: update", () => {
  it("updates metadata without rotating the key", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    const secretBefore = mock.store.get(llmSecretKey("deepseek-main"));

    const updated = await updateLlmKey(
      bucket,
      INSTANCE_SECRET,
      "deepseek-main",
      { name: "改名后", tags: ["prod"] },
      new Date("2026-08-27T12:00:00.000Z"),
    );

    expect(updated.name).toBe("改名后");
    expect(updated.tags).toEqual(["prod"]);
    expect(updated.hint).toEqual({ last4: "0001", length: API_KEY.length });
    expect(mock.store.get(llmSecretKey("deepseek-main"))).toBe(secretBefore);
    expect(
      (await revealLlmKey(bucket, INSTANCE_SECRET, "deepseek-main")).apiKey,
    ).toBe(API_KEY);
  });

  it("rotates the key and publishes a new hash", async () => {
    const created = await createLlmKey(
      bucket,
      INSTANCE_SECRET,
      makeInput(),
      FIXED_TIME,
    );
    const rotated = await updateLlmKey(
      bucket,
      INSTANCE_SECRET,
      "deepseek-main",
      { apiKey: "sk-rotated-key-9999" },
      new Date("2026-08-27T12:00:00.000Z"),
    );

    expect(rotated.hint).toEqual({ last4: "9999", length: 19 });
    expect(rotated.secret.sha256).not.toBe(created.secret.sha256);
    expect(rotated.secret.sha256).toBe(
      await sha256HexText(mock.store.get(llmSecretKey("deepseek-main"))!),
    );
    expect(
      (await revealLlmKey(bucket, INSTANCE_SECRET, "deepseek-main")).apiKey,
    ).toBe("sk-rotated-key-9999");
  });

  it("fails closed when the ciphertext was replaced after the read", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    const originalPut = bucket.put.bind(bucket);
    mock.put = async (key, value, opts) => {
      if (key === llmSecretKey("deepseek-main") && opts?.onlyIf?.etagMatches) {
        // Simulate a concurrent writer winning the race.
        mock.etags.set(key, '"someone-else"');
      }
      return originalPut(key, value, opts);
    };

    await expectLlmError(
      updateLlmKey(
        bucket,
        INSTANCE_SECRET,
        "deepseek-main",
        { apiKey: "sk-rotated-key-9999" },
        FIXED_TIME,
      ),
      "LLM_KEY_CONFLICT",
    );
  });

  it("fails closed when the metadata was replaced after the read", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    const originalPut = bucket.put.bind(bucket);
    mock.put = async (key, value, opts) => {
      if (key === llmMetaKey("deepseek-main") && opts?.onlyIf?.etagMatches) {
        mock.etags.set(key, '"someone-else"');
      }
      return originalPut(key, value, opts);
    };

    await expectLlmError(
      updateLlmKey(
        bucket,
        INSTANCE_SECRET,
        "deepseek-main",
        { name: "x" },
        FIXED_TIME,
      ),
      "LLM_KEY_CONFLICT",
    );
  });

  it("rejects updates to an unknown slug", async () => {
    await expectLlmError(
      updateLlmKey(bucket, INSTANCE_SECRET, "nope", { name: "x" }, FIXED_TIME),
      "LLM_KEY_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// Reveal (the only plaintext exit) and delete
// ---------------------------------------------------------------------------

describe("llm-key-store: reveal", () => {
  it("decrypts the stored key", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    const result = await revealLlmKey(bucket, INSTANCE_SECRET, "deepseek-main");
    expect(result.apiKey).toBe(API_KEY);
  });

  it("reads the ciphertext exactly once", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);

    const api = mock as unknown as {
      get(key: string): Promise<unknown>;
    };
    const originalGet = api.get.bind(api);
    let secretReads = 0;
    api.get = async (key: string) => {
      if (key === llmSecretKey("deepseek-main")) secretReads++;
      return originalGet(key);
    };

    const revealed = await revealLlmKey(
      bucket,
      INSTANCE_SECRET,
      "deepseek-main",
    );

    expect(revealed.apiKey).toBe(API_KEY);
    // The integrity hash and the decryption share one read.
    expect(secretReads).toBe(1);
  });

  it("fails closed on a tampered ciphertext", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    mock.store.set(llmSecretKey("deepseek-main"), '{"schemaVersion":1}');

    expect((await getLlmKey(bucket, "deepseek-main"))!.integrity).toBe(
      "corrupted",
    );
    await expectLlmError(
      revealLlmKey(bucket, INSTANCE_SECRET, "deepseek-main"),
      "LLM_KEY_CORRUPTED",
    );
  });

  it("fails closed when INSTANCE_SECRET changed", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    // Hash still matches, so only the decrypt step can catch this.
    expect((await getLlmKey(bucket, "deepseek-main"))!.integrity).toBe("ok");
    await expectLlmError(
      revealLlmKey(bucket, OTHER_SECRET, "deepseek-main"),
      "LLM_KEY_CORRUPTED",
    );
  });

  it("refuses to reveal without a usable INSTANCE_SECRET", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    await expectLlmError(
      revealLlmKey(bucket, undefined, "deepseek-main"),
      "LLM_STORE_UNAVAILABLE",
    );
  });

  it("reports an unknown slug as not found", async () => {
    await expectLlmError(
      revealLlmKey(bucket, INSTANCE_SECRET, "nope"),
      "LLM_KEY_NOT_FOUND",
    );
  });
});

describe("llm-key-store: delete", () => {
  it("removes both objects and is idempotent", async () => {
    await createLlmKey(bucket, INSTANCE_SECRET, makeInput(), FIXED_TIME);
    expect(await deleteLlmKey(bucket, "deepseek-main")).toBe(true);
    expect(mock.store.has(llmMetaKey("deepseek-main"))).toBe(false);
    expect(mock.store.has(llmSecretKey("deepseek-main"))).toBe(false);
    expect(await listLlmKeys(bucket)).toEqual([]);
    expect(await deleteLlmKey(bucket, "deepseek-main")).toBe(false);
  });
});
