import { describe, it, expect, beforeEach } from "vitest";
import { handleApi } from "../src/routes/api.ts";
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
    const etag = this.etags.get(key) || `${data.length}`;
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
    const newEtag = `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = "test-admin-token";
const DOWNLOAD_TOKEN = "test-download-token";

function makeEnv(bucket: MockR2Bucket): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN,
    DOWNLOAD_TOKEN,
  };
}

function authHeader(token = ADMIN_TOKEN): string {
  return `Bearer ${token}`;
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    token?: string;
  } = {},
): Request {
  const url = `https://example.com${path}`;
  const headers: Record<string, string> = {
    Authorization: opts.token !== undefined ? opts.token : authHeader(),
    ...opts.headers,
  };
  if (opts.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function callApi(
  bucket: MockR2Bucket,
  path: string,
  opts?: Parameters<typeof makeRequest>[1],
): Promise<Response> {
  const req = makeRequest(path, opts);
  const env = makeEnv(bucket);
  const result = await handleApi(req, env, path);
  return result!;
}

async function callApiRaw(
  bucket: MockR2Bucket,
  path: string,
  opts: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    token?: string;
  },
): Promise<Response> {
  const url = `https://example.com${path}`;
  const headers: Record<string, string> = {
    Authorization: opts.token !== undefined ? opts.token : authHeader(),
    ...opts.headers,
  };
  if (opts.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const req = new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  });
  const env = makeEnv(bucket);
  const result = await handleApi(req, env, path);
  return result!;
}

async function parseJson(res: Response): Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}> {
  return res.json() as Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }>;
}

const VALID_YAML = "mixed-port: 7890\nallow-lan: true\n";
const VALID_NAME = "我的主配置";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Main Config API", () => {
  let bucket: MockR2Bucket;

  beforeEach(() => {
    bucket = new MockR2Bucket();
  });

  // ===== 16.7 API and Auth =====

  describe("Authentication", () => {
    it("GET /api/main-config without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        token: "",
      });
      expect(res.status).toBe(401);
    });

    it("GET /api/main-config with wrong token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        token: "Bearer wrong-token",
      });
      expect(res.status).toBe(401);
    });

    it("GET /api/main-config with correct token returns 200 or 404", async () => {
      const res = await callApi(bucket, "/api/main-config");
      // No config yet → 404
      expect(res.status).toBe(404);
      const body = await parseJson(res);
      expect(body.ok).toBe(false);
      expect(body.error!.code).toBe("MAIN_CONFIG_NOT_FOUND");
    });

    it("PUT /api/main-config without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        token: "",
      });
      expect(res.status).toBe(401);
    });

    it("GET /api/main-config/history without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config/history", {
        token: "",
      });
      expect(res.status).toBe(401);
    });

    it("POST /api/main-config/rollback without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config/rollback", {
        method: "POST",
        body: { versionId: "v0001" },
        token: "",
      });
      expect(res.status).toBe(401);
    });

    it("POST /api/main-config/disable without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config/disable", {
        method: "POST",
        token: "",
      });
      expect(res.status).toBe(401);
    });

    it("POST /api/main-config/enable without token returns 401", async () => {
      const res = await callApi(bucket, "/api/main-config/enable", {
        method: "POST",
        token: "",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Response headers", () => {
    it("GET returns ETag and Cache-Control: no-store", async () => {
      // First create a config
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config");
      expect(res.headers.get("ETag")).toBeTruthy();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    it("PUT returns ETag and Cache-Control: no-store", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("ETag")).toBeTruthy();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  describe("PUT /api/main-config", () => {
    it("creates config with If-None-Match: *", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(201);
      const body = await parseJson(res);
      expect(body.ok).toBe(true);
      expect((body.data as { versionId: string }).versionId).toBeTruthy();
    });

    it("updates config with If-Match", async () => {
      // Create
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const etag = createRes.headers.get("ETag")!;

      // Update
      const updateRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: "port: 1080\n" },
        headers: { "If-Match": etag },
      });
      expect(updateRes.status).toBe(200);
      const body = await parseJson(updateRes);
      expect(body.ok).toBe(true);
    });

    it("idempotent PUT returns same versionId", async () => {
      const res1 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const etag = res1.headers.get("ETag")!;
      const body1 = await parseJson(res1);

      const res2 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-Match": etag },
      });
      const body2 = await parseJson(res2);
      expect((body2.data as { versionId: string }).versionId).toBe(
        (body1.data as { versionId: string }).versionId,
      );
    });

    it("returns 428 when existing config but no If-Match", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: VALID_YAML },
      });
      expect(res.status).toBe(428);
      const body = await parseJson(res);
      expect(body.error!.code).toBe("MAIN_CONFIG_PRECONDITION_REQUIRED");
    });

    it("returns 412 when If-Match is stale", async () => {
      const res1 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res2 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: VALID_YAML },
        headers: { "If-Match": '"stale-etag"' },
      });
      expect(res2.status).toBe(412);
    });

    it("returns 412 when conflicting headers used on existing config", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: VALID_YAML },
        headers: { "If-None-Match": "*", "If-Match": '"some-etag"' },
      });
      expect(res.status).toBe(412);
    });

    it("returns 412 when If-Match used on non-existent config", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-Match": '"some-etag"' },
      });
      expect(res.status).toBe(412);
    });

    it("rejects weak ETag", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: VALID_YAML },
        headers: { "If-Match": 'W/"weak-etag"' },
      });
      expect(res.status).toBe(412);
    });

    it("rejects multiple ETags", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新名称", yaml: VALID_YAML },
        headers: { "If-Match": '"etag1", "etag2"' },
      });
      expect(res.status).toBe(412);
    });

    it("returns 400 for invalid YAML", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: "mixed-port: [\n  invalid" },
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(400);
      const body = await parseJson(res);
      expect(body.error!.code).toBe("INVALID_MAIN_CONFIG");
    });

    it("returns 400 for empty name", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "   ", yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/main-config", () => {
    it("returns 404 when no config exists", async () => {
      const res = await callApi(bucket, "/api/main-config");
      expect(res.status).toBe(404);
    });

    it("returns config with YAML", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config");
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect(body.ok).toBe(true);
      const data = body.data as {
        configId: string;
        status: string;
        versionId: string;
        name: string;
        yaml: string;
        sha256: string;
        contentLength: number;
        createdAt: string;
        publishedAt: string;
        disabledAt: string | null;
      };
      expect(data.status).toBe("active");
      expect(data.name).toBe(VALID_NAME);
      expect(data.yaml).toBe(VALID_YAML);
      expect(data.disabledAt).toBeNull();
    });

    it("returns config when disabled", async () => {
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const etag = createRes.headers.get("ETag")!;

      await callApi(bucket, "/api/main-config/disable", {
        method: "POST",
        headers: { "If-Match": etag },
      });

      const res = await callApi(bucket, "/api/main-config");
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const data = body.data as {
        status: string;
        yaml: string;
        disabledAt: string | null;
      };
      expect(data.status).toBe("disabled");
      expect(data.yaml).toBe(VALID_YAML);
      expect(data.disabledAt).toBeTruthy();
    });
  });

  describe("GET /api/main-config/history", () => {
    it("returns empty list when no config", async () => {
      const res = await callApi(bucket, "/api/main-config/history");
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.data as unknown[]).length).toBe(0);
    });

    it("returns versions sorted by createdAt descending", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "第一版", yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const getRes = await callApi(bucket, "/api/main-config");
      const etag = getRes.headers.get("ETag")!;

      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "第二版", yaml: "port: 1080\n" },
        headers: { "If-Match": etag },
      });

      const historyRes = await callApi(bucket, "/api/main-config/history");
      const body = await parseJson(historyRes);
      const data = body.data as {
        versionId: string;
        name: string;
        isCurrent: boolean;
      }[];
      expect(data.length).toBe(2);
      expect(data[0]!.isCurrent).toBe(true);
    });
  });

  describe("GET /api/main-config/versions/:versionId", () => {
    it("returns specific version", async () => {
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const { versionId } = (await parseJson(createRes)).data as {
        versionId: string;
      };

      const res = await callApi(
        bucket,
        `/api/main-config/versions/${versionId}`,
      );
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const data = body.data as {
        name: string;
        yaml: string;
        isCurrent: boolean;
      };
      expect(data.name).toBe(VALID_NAME);
      expect(data.yaml).toBe(VALID_YAML);
    });

    it("returns 404 for non-existent version", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(
        bucket,
        "/api/main-config/versions/nonexistent",
      );
      expect(res.status).toBe(404);
    });

    it("rejects path traversal in versionId", async () => {
      const res = await callApi(
        bucket,
        "/api/main-config/versions/..%2F..%2Fetc",
      );
      // The regex captures the decoded path, but URL parsing may differ
      // Just verify it doesn't return 200
      expect(res.status).not.toBe(200);
    });
  });

  describe("POST /api/main-config/rollback", () => {
    it("rolls back to specified version", async () => {
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "第一版", yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const { versionId: firstVersionId } = (await parseJson(createRes))
        .data as { versionId: string };

      const getRes = await callApi(bucket, "/api/main-config");
      const etag = getRes.headers.get("ETag")!;

      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "第二版", yaml: "port: 1080\n" },
        headers: { "If-Match": etag },
      });

      const getRes2 = await callApi(bucket, "/api/main-config");
      const etag2 = getRes2.headers.get("ETag")!;

      const rollbackRes = await callApi(bucket, "/api/main-config/rollback", {
        method: "POST",
        body: { versionId: firstVersionId },
        headers: { "If-Match": etag2 },
      });
      expect(rollbackRes.status).toBe(200);
      const body = await parseJson(rollbackRes);
      expect((body.data as { versionId: string }).versionId).toBe(
        firstVersionId,
      );
    });

    it("requires If-Match", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config/rollback", {
        method: "POST",
        body: { versionId: "v0001" },
      });
      expect(res.status).toBe(428);
    });

    it("requires versionId in body", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const getRes = await callApi(bucket, "/api/main-config");
      const etag = getRes.headers.get("ETag")!;

      const res = await callApi(bucket, "/api/main-config/rollback", {
        method: "POST",
        body: {},
        headers: { "If-Match": etag },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/main-config/disable", () => {
    it("disables config", async () => {
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const etag = createRes.headers.get("ETag")!;

      const res = await callApi(bucket, "/api/main-config/disable", {
        method: "POST",
        headers: { "If-Match": etag },
      });
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.data as { status: string }).status).toBe("disabled");
    });

    it("requires If-Match", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config/disable", {
        method: "POST",
      });
      expect(res.status).toBe(428);
    });
  });

  describe("POST /api/main-config/enable", () => {
    it("enables config", async () => {
      const createRes = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const etag = createRes.headers.get("ETag")!;

      await callApi(bucket, "/api/main-config/disable", {
        method: "POST",
        headers: { "If-Match": etag },
      });

      const disableRes = await callApi(bucket, "/api/main-config");
      const disableEtag = disableRes.headers.get("ETag")!;

      const res = await callApi(bucket, "/api/main-config/enable", {
        method: "POST",
        headers: { "If-Match": disableEtag },
      });
      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.data as { status: string }).status).toBe("active");
    });

    it("requires If-Match", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });

      const res = await callApi(bucket, "/api/main-config/enable", {
        method: "POST",
      });
      expect(res.status).toBe(428);
    });
  });

  describe("Error responses", () => {
    it("error responses do not contain YAML fragments or tokens", async () => {
      const yamlWithComment = "# secret: password123\nmixed-port: [\n  bad";
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: yamlWithComment },
        headers: { "If-None-Match": "*" },
      });
      const text = await res.text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain("password123");
      expect(text).not.toContain(ADMIN_TOKEN);
      expect(text).not.toContain(DOWNLOAD_TOKEN);
      expect(text).not.toContain("vault/main-config");
      expect(text).not.toContain("SHA-256");
    });

    it("error messages are safe generic strings", async () => {
      const res = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: "null" },
        headers: { "If-None-Match": "*" },
      });
      const body = await parseJson(res);
      // Should be a safe message, not the raw js-yaml error
      expect(body.error!.message).not.toContain("js-yaml");
      expect(body.error!.message).not.toContain("unexpected");
    });

    it("error code and HTTP status mapping is correct", async () => {
      // INVALID_MAIN_CONFIG → 400
      const res1 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: "null" },
        headers: { "If-None-Match": "*" },
      });
      expect(res1.status).toBe(400);
      const body1 = await parseJson(res1);
      expect(body1.error!.code).toBe("INVALID_MAIN_CONFIG");

      // MAIN_CONFIG_NOT_FOUND → 404
      const res2 = await callApi(bucket, "/api/main-config");
      expect(res2.status).toBe(404);

      // MAIN_CONFIG_PRECONDITION_REQUIRED → 428
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const res3 = await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: "新", yaml: VALID_YAML },
      });
      expect(res3.status).toBe(428);
    });

    it("JSON root null returns 400", async () => {
      const res = await callApiRaw(bucket, "/api/main-config", {
        method: "PUT",
        body: "null",
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(400);
      const body = await parseJson(res);
      expect(body.error!.code).toBe("INVALID_MAIN_CONFIG");
    });

    it("JSON root array returns 400", async () => {
      const res = await callApiRaw(bucket, "/api/main-config", {
        method: "PUT",
        body: "[]",
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(400);
    });

    it("JSON root number returns 400", async () => {
      const res = await callApiRaw(bucket, "/api/main-config", {
        method: "PUT",
        body: "42",
        headers: { "If-None-Match": "*" },
      });
      expect(res.status).toBe(400);
    });

    it("rollback JSON root null returns 400", async () => {
      await callApi(bucket, "/api/main-config", {
        method: "PUT",
        body: { name: VALID_NAME, yaml: VALID_YAML },
        headers: { "If-None-Match": "*" },
      });
      const getRes = await callApi(bucket, "/api/main-config");
      const etag = getRes.headers.get("ETag")!;

      const res = await callApiRaw(bucket, "/api/main-config/rollback", {
        method: "POST",
        body: "null",
        headers: { "If-Match": etag },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Phase 4 routes now implemented", () => {
    it("GET /main-config/:token returns 403 for invalid token", async () => {
      const req = new Request("https://example.com/main-config/sometoken", {
        method: "GET",
      });
      const env = makeEnv(bucket);
      const indexModule = await import("../src/index.ts");
      const res = await indexModule.default.fetch(req, env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(res.status).toBe(403);
    });

    it("HEAD /main-config/:token returns 403 for invalid token", async () => {
      const req = new Request("https://example.com/main-config/sometoken", {
        method: "HEAD",
      });
      const env = makeEnv(bucket);
      const indexModule = await import("../src/index.ts");
      const res = await indexModule.default.fetch(req, env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(res.status).toBe(403);
    });

    it("GET /config/:slug/:token returns 403 for invalid token", async () => {
      const req = new Request(
        "https://example.com/config/my-provider/sometoken",
        {
          method: "GET",
        },
      );
      const env = makeEnv(bucket);
      const indexModule = await import("../src/index.ts");
      const res = await indexModule.default.fetch(req, env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(res.status).toBe(403);
    });

    it("HEAD /config/:slug/:token returns 403 for invalid token", async () => {
      const req = new Request(
        "https://example.com/config/my-provider/sometoken",
        {
          method: "HEAD",
        },
      );
      const env = makeEnv(bucket);
      const indexModule = await import("../src/index.ts");
      const res = await indexModule.default.fetch(req, env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      expect(res.status).toBe(403);
    });
  });
});
