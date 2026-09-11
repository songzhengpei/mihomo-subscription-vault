import { describe, expect, it, beforeEach } from "vitest";
import { handleApi } from "../src/routes/api.ts";
import { llmMetaKey, llmSecretKey } from "../src/services/llm-key-store.ts";
import type { Env } from "../src/types.ts";

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
    opts?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
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

const ADMIN_TOKEN = "test-admin-token";
const DOWNLOAD_TOKEN = "test-download-token";
const INSTANCE_SECRET = "test-instance-secret-0123456789abcdef";
const API_KEY = "sk-example-deepseek-0001";

let bucket: MockR2Bucket;

beforeEach(() => {
  bucket = new MockR2Bucket();
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN,
    DOWNLOAD_TOKEN,
    INSTANCE_SECRET,
    ...overrides,
  };
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== null) {
    headers["Authorization"] = `Bearer ${opts.token ?? ADMIN_TOKEN}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://example.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function callApi(
  path: string,
  opts?: Parameters<typeof makeRequest>[1],
  env: Env = makeEnv(),
): Promise<Response> {
  const result = await handleApi(makeRequest(path, opts), env, path);
  return result ?? new Response("null", { status: 599 });
}

function makePayload(overrides: Record<string, unknown> = {}) {
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

interface ApiBody {
  ok: boolean;
  data?: {
    keys?: Array<Record<string, unknown>>;
    key?: Record<string, unknown>;
    slug?: string;
    deleted?: boolean;
    apiKey?: string;
    storeAvailable?: boolean;
  };
  error?: { code: string; message: string };
}

async function jsonOf(response: Response): Promise<ApiBody> {
  return (await response.json()) as ApiBody;
}

async function createOne(env: Env = makeEnv()): Promise<Response> {
  return callApi("/api/llm/keys", { method: "POST", body: makePayload() }, env);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("llm-api: authentication", () => {
  it("rejects requests without credentials", async () => {
    const response = await callApi("/api/llm/keys", { token: null });
    expect(response.status).toBe(401);
    expect((await jsonOf(response)).error?.code).toBe("UNAUTHORIZED");
  });

  it("rejects a non-admin token", async () => {
    const response = await callApi("/api/llm/keys", { token: DOWNLOAD_TOKEN });
    expect(response.status).toBe(401);
  });

  it("rejects writes with a non-admin token", async () => {
    const response = await callApi("/api/llm/keys", {
      method: "POST",
      body: makePayload(),
      token: "nope",
    });
    expect(response.status).toBe(401);
    expect(bucket.store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe("llm-api: lifecycle", () => {
  it("creates, lists, reads, updates, reveals and deletes", async () => {
    const created = await createOne();
    expect(created.status).toBe(201);
    expect((await jsonOf(created)).data?.slug).toBe("deepseek-main");

    const listResponse = await callApi("/api/llm/keys");
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.text();
    expect(listBody).not.toContain(API_KEY);
    expect(listBody).not.toContain("ciphertext");
    expect(listBody).not.toContain("secret.v1.enc.json");
    const items = JSON.parse(listBody).data.keys;
    expect(JSON.parse(listBody).data.storeAvailable).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0].hint).toEqual({ last4: "0001", length: API_KEY.length });
    expect(items[0].secretPresent).toBe(true);

    const detailResponse = await callApi("/api/llm/keys/deepseek-main");
    expect(detailResponse.status).toBe(200);
    const detailText = await detailResponse.text();
    expect(detailText).not.toContain(API_KEY);
    expect(detailText).not.toContain("ciphertext");
    const detail = JSON.parse(detailText).data.key;
    expect(detail.integrity).toBe("ok");
    expect(detail.notes).toBe("");

    const updated = await callApi("/api/llm/keys/deepseek-main", {
      method: "PUT",
      body: { name: "改名后" },
    });
    expect(updated.status).toBe(200);
    expect(
      (await jsonOf(await callApi("/api/llm/keys/deepseek-main"))).data?.key
        ?.name,
    ).toBe("改名后");

    const reveal = await callApi("/api/llm/keys/deepseek-main/reveal", {
      method: "POST",
    });
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("Cache-Control")).toContain("no-store");
    expect((await jsonOf(reveal)).data?.apiKey).toBe(API_KEY);

    const removed = await callApi("/api/llm/keys/deepseek-main", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(bucket.store.has(llmMetaKey("deepseek-main"))).toBe(false);
    expect(bucket.store.has(llmSecretKey("deepseek-main"))).toBe(false);

    expect((await callApi("/api/llm/keys/deepseek-main")).status).toBe(404);
    expect((await jsonOf(await callApi("/api/llm/keys"))).data?.keys).toEqual(
      [],
    );
  });

  it("never exposes the key outside the reveal endpoint", async () => {
    await createOne();
    const list = await callApi("/api/llm/keys");
    expect(await list.text()).not.toContain(API_KEY);
    const detail = await callApi("/api/llm/keys/deepseek-main");
    expect(await detail.text()).not.toContain(API_KEY);
    const updated = await callApi("/api/llm/keys/deepseek-main", {
      method: "PUT",
      body: { name: "x" },
    });
    expect(await updated.text()).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("llm-api: errors", () => {
  it("rejects unexpected query parameters", async () => {
    const response = await callApi("/api/llm/keys?reveal=1");
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error?.code).toBe("INVALID_LLM_QUERY");
  });

  it("rejects unsupported methods with an Allow header", async () => {
    const response = await callApi("/api/llm/keys", { method: "PATCH" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");

    const reveal = await callApi("/api/llm/keys/deepseek-main/reveal");
    expect(reveal.status).toBe(405);
    expect(reveal.headers.get("Allow")).toBe("POST");
  });

  it("reports unknown paths under the namespace", async () => {
    const response = await callApi("/api/llm/unknown");
    expect(response.status).toBe(404);
  });

  it("rejects invalid payloads and duplicate slugs", async () => {
    const bad = await callApi("/api/llm/keys", {
      method: "POST",
      body: makePayload({ baseUrl: "http://api.deepseek.com" }),
    });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error?.code).toBe("INVALID_LLM_PAYLOAD");

    const badSlug = await callApi("/api/llm/keys", {
      method: "POST",
      body: makePayload({ slug: "Not A Slug" }),
    });
    expect(badSlug.status).toBe(400);
    expect((await jsonOf(badSlug)).error?.code).toBe("INVALID_SLUG");

    expect((await createOne()).status).toBe(201);
    const conflict = await createOne();
    expect(conflict.status).toBe(409);
    expect((await jsonOf(conflict)).error?.code).toBe("LLM_KEY_CONFLICT");
  });

  it("rejects an empty body", async () => {
    const response = await callApi("/api/llm/keys", { method: "POST" });
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error?.code).toBe("INVALID_LLM_PAYLOAD");
  });

  it("returns 503 when the instance has no usable INSTANCE_SECRET", async () => {
    const env = makeEnv({ INSTANCE_SECRET: undefined });
    const create = await callApi(
      "/api/llm/keys",
      { method: "POST", body: makePayload() },
      env,
    );
    expect(create.status).toBe(503);
    expect((await jsonOf(create)).error?.code).toBe("LLM_STORE_UNAVAILABLE");

    // The listing still works and reports that storage is unavailable, so the
    // UI can warn before anything is typed.
    const list = await callApi("/api/llm/keys", {}, env);
    expect(list.status).toBe(200);
    expect((await jsonOf(list)).data?.storeAvailable).toBe(false);

    const reveal = await callApi(
      "/api/llm/keys/deepseek-main/reveal",
      { method: "POST" },
      env,
    );
    expect(reveal.status).toBe(503);
  });

  it("returns 500 when the stored ciphertext no longer verifies", async () => {
    await createOne();
    bucket.store.set(llmSecretKey("deepseek-main"), '{"schemaVersion":1}');

    const response = await callApi("/api/llm/keys/deepseek-main/reveal", {
      method: "POST",
    });
    expect(response.status).toBe(500);
    const body = await jsonOf(response);
    expect(body.error?.code).toBe("LLM_KEY_CORRUPTED");
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("returns 404 for reveal and delete on an unknown slug", async () => {
    expect(
      (await callApi("/api/llm/keys/nope/reveal", { method: "POST" })).status,
    ).toBe(404);
    expect(
      (await callApi("/api/llm/keys/nope", { method: "DELETE" })).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Isolation from the subscription API
// ---------------------------------------------------------------------------

describe("llm-api: isolation", () => {
  it("leaves the provider namespace routed as before", async () => {
    bucket.store.set("llm/deepseek-main/meta.v1.json", "{}");
    const response = await callApi("/api/providers");
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("does not claim unrelated /api paths", async () => {
    const other = await handleApi(
      makeRequest("/api/llmish"),
      makeEnv(),
      "/api/llmish",
    );
    expect(other).toBeNull();
    const providers = await handleApi(
      makeRequest("/api/providers"),
      makeEnv(),
      "/api/providers",
    );
    expect(providers).not.toBeNull();
  });
});
