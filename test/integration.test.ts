import { describe, it, expect, vi, beforeEach } from "vitest";
import * as storage from "../src/services/storage.ts";

const browserMock = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: browserMock.launch },
}));

// Helper type for API responses
interface ApiResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function readJson(resp: Response): Promise<ApiResponse> {
  return resp.json() as Promise<ApiResponse>;
}

// Mock R2Bucket for testing
class MockR2Bucket {
  private store = new Map<string, string>();
  private etags = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    const data = this.store.get(key);
    if (!data) return null;
    const etag = this.etags.get(key) || `"${data.length}"`;
    return {
      key,
      etag,
      httpEtag: etag,
      body: new TextEncoder().encode(data),
      async json() {
        return JSON.parse(data);
      },
      async text() {
        return data;
      },
      async arrayBuffer() {
        return new TextEncoder().encode(data).buffer;
      },
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

    // Handle conditional writes — match real R2 semantics
    if (opts?.onlyIf) {
      const currentEtag = this.etags.get(key);

      if (opts.onlyIf.etagDoesNotMatch === "*") {
        // Only write if object does NOT exist
        if (currentEtag !== undefined) {
          return null;
        }
      } else if (opts.onlyIf.etagMatches !== undefined) {
        // Only write if ETag matches
        if (!currentEtag || currentEtag !== opts.onlyIf.etagMatches) {
          return null;
        }
      }
    }

    const newEtag = `"${key}-${Date.now()}"`;
    this.store.set(key, text);
    this.etags.set(key, newEtag);
    return { key };
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

  async delete(key: string) {
    this.store.delete(key);
    this.etags.delete(key);
  }

  clear() {
    this.store.clear();
    this.etags.clear();
  }
}

const mockBucket = new MockR2Bucket();

const testEnv = {
  SUBSCRIPTION_BUCKET: mockBucket as unknown as R2Bucket,
  ADMIN_TOKEN: "test-admin-token-123",
  DOWNLOAD_TOKEN: "test-download-token-456",
  MAX_SOURCE_BYTES: "5242880",
  MAX_REDIRECTS: "3",
  FETCH_TIMEOUT_MS: "20000",
};

function makeRequest(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Request {
  const url = `https://example.com${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  return new Request(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

function mockFetch(
  yamlContent: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  const encoder = new TextEncoder();

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      const encoded = encoder.encode(yamlContent);
      let read = false;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Map(Object.entries(headers)),
        text: () => Promise.resolve(yamlContent),
        arrayBuffer: () => Promise.resolve(encoded.buffer),
        body: {
          getReader() {
            return {
              async read() {
                if (read) return { done: true, value: undefined };
                read = true;
                return { done: false, value: encoded };
              },
              cancel() {},
            };
          },
        },
      });
    }),
  );
}

import { handleApi } from "../src/routes/api.ts";
import { handleProvider } from "../src/routes/provider.ts";

describe("update flow", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    browserMock.launch.mockReset();
  });

  it("updates a valid provider YAML", async () => {
    const providerYaml = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(providerYaml);

    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });

    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);

    expect(data.ok).toBe(true);
    expect(data!.data!.nodeCount).toBe(1);
    expect(data!.data!.isNew).toBe(true);
    expect(data!.data!.sha256).toBeTruthy();
  });

  it("uses and persists the requested Slclash-compatible User-Agent", async () => {
    const providerYaml = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(providerYaml);
    const userAgent = "SlClash/v2.0.1 clash-verge Platform/android";
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: {
        name: "主订阅",
        sourceUrl: "https://upstream.example.com/sub",
        userAgent,
      },
    });

    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);

    expect(data.ok).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://upstream.example.com/sub",
      expect.objectContaining({ headers: { "User-Agent": userAgent } }),
    );
    expect(
      await storage.getSourceUserAgent(
        mockBucket as unknown as R2Bucket,
        "main",
      ),
    ).toBe(userAgent);
  });

  it("uses clash-verge/v2.4.5 as the default User-Agent", async () => {
    mockFetch(
      `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`,
    );
    await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
      }),
      testEnv,
      "/api/providers/main/update",
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://upstream.example.com/sub",
      expect.objectContaining({
        headers: { "User-Agent": "clash-verge/v2.4.5" },
      }),
    );
  });

  it("uses direct fetch first when the Browser binding is available", async () => {
    mockFetch(
      `proxies:\n  - name: Direct\n    type: ss\n    server: direct.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`,
    );
    browserMock.launch.mockRejectedValue(
      new Error("Browser must not be used for a successful direct fetch"),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "Direct 订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      { ...testEnv, BROWSER: {} as Fetcher },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);

    expect(body.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(browserMock.launch).not.toHaveBeenCalled();
  });

  it("times out a direct response body that never completes", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("proxies:\n"));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "慢响应订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      { ...testEnv, FETCH_TIMEOUT_MS: "20" },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);

    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain("响应体读取超时");
    expect(canceled).toBe(true);
  });

  it("falls back to Browser when direct fetch returns 403", async () => {
    const providerYaml = `proxies:\n  - name: Browser\n    type: ss\n    server: browser.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    const close = vi.fn().mockResolvedValue(undefined);
    const page = {
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        finalUrl: "https://upstream.example.com/sub",
        headers: { "content-type": "text/yaml" },
        content: providerYaml,
      }),
    };
    browserMock.launch.mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
      close,
    });
    const directFetch = vi
      .fn()
      .mockResolvedValue(new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", directFetch);

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "Browser 订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      { ...testEnv, BROWSER: {} as Fetcher },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);

    expect(body.ok).toBe(true);
    expect(browserMock.launch).toHaveBeenCalledOnce();
    expect(page.setUserAgent).toHaveBeenCalledWith("clash-verge/v2.4.5");
    expect(directFetch).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the direct 403 result when Browser fallback fails", async () => {
    browserMock.launch.mockRejectedValue(new Error("browser unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "回退订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      { ...testEnv, BROWSER: {} as Fetcher },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);

    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain("HTTP 403");
    expect(browserMock.launch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "provider-fetch:browser-failed",
      expect.objectContaining({ slug: "main", errorType: "Error" }),
    );
  });

  it("uses the private relay after direct and Browser requests return 403", async () => {
    const providerYaml = `proxies:\n  - name: Relay\n    type: ss\n    server: relay.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    const close = vi.fn().mockResolvedValue(undefined);
    browserMock.launch.mockResolvedValue({
      newPage: vi.fn().mockResolvedValue({
        setUserAgent: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({
          status: 403,
          finalUrl: "https://upstream.example.com/sub",
          headers: { "content-type": "text/html" },
          content: "Forbidden",
        }),
      }),
      close,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    );
    const relayFetch = vi.fn().mockResolvedValue(
      new Response(providerYaml, {
        status: 200,
        headers: {
          "Content-Type": "text/yaml",
          "Subscription-Userinfo": "upload=0; download=0; total=1",
          "X-Vault-Relay": "1",
          "X-Vault-Upstream-Host": "upstream.example.com",
        },
      }),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "Relay 订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      {
        ...testEnv,
        BROWSER: {} as Fetcher,
        UPSTREAM_RELAY: { fetch: relayFetch } as unknown as Fetcher,
      },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);
    const relayRequest = JSON.parse(
      (relayFetch.mock.calls[0]?.[1] as RequestInit).body as string,
    );

    expect(body.ok).toBe(true);
    expect(body.data?.nodeCount).toBe(1);
    expect(body.data?.sourceHost).toBe("upstream.example.com");
    expect(relayRequest).toMatchObject({
      url: "https://upstream.example.com/sub",
      userAgent: "clash-verge/v2.4.5",
      maxBytes: 5242880,
      maxRedirects: 3,
      timeoutMs: 20000,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the private relay when Browser Run is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    );
    const relayFetch = vi.fn().mockResolvedValue(
      new Response(
        "proxies:\n  - name: Relay\n    type: ss\n    server: relay.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret",
        {
          status: 200,
          headers: {
            "X-Vault-Relay": "1",
            "X-Vault-Upstream-Host": "upstream.example.com",
          },
        },
      ),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "Relay 订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      {
        ...testEnv,
        UPSTREAM_RELAY: { fetch: relayFetch } as unknown as Fetcher,
      },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);

    expect(body.ok).toBe(true);
    expect(relayFetch).toHaveBeenCalledOnce();
    expect(browserMock.launch).not.toHaveBeenCalled();
  });

  it("never exposes an upstream subscription token in 403 diagnostics", async () => {
    const secretToken = "private-subscription-token";
    const sourceUrl = `https://upstream.example.com/api/sub/${secretToken}?user=42`;
    browserMock.launch.mockRejectedValue(new Error("browser unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    );

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: { name: "脱敏诊断", sourceUrl },
      }),
      { ...testEnv, BROWSER: {} as Fetcher },
      "/api/providers/main/update",
    );
    const body = await readJson(response!);
    const diagnostics = JSON.stringify([
      body,
      warning.mock.calls,
      info.mock.calls,
    ]);

    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain("HTTP 403");
    expect(diagnostics).not.toContain(secretToken);
    expect(diagnostics).not.toContain(sourceUrl);
    expect(diagnostics).not.toContain("Forbidden");
  });

  it("rejects a User-Agent containing header injection", async () => {
    mockFetch("proxies: []");
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: {
        name: "主订阅",
        sourceUrl: "https://upstream.example.com/sub",
        userAgent: "clash-verge\r\nX-Injected: yes",
      },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);

    expect(data.ok).toBe(false);
    expect(data.error?.message).toContain("User-Agent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("extracts proxies from full Clash config", async () => {
    const clashConfig = `mixed-port: 7890\ndns:\n  enable: true\nproxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\n  - name: US-01\n    type: vmess\n    server: us.example.com\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    cipher: auto\nproxy-groups:\n  - name: auto\n    type: url-test`;
    mockFetch(clashConfig);

    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });

    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);

    expect(data.ok).toBe(true);
    expect(data!.data!.nodeCount).toBe(2);
  });

  it("converts a Base64 URI subscription into published Mihomo artifacts", async () => {
    const credentials = Buffer.from("aes-128-gcm:secret").toString("base64");
    const links = [
      `ss://${credentials}@ss.example.com:443#SS`,
      "trojan://secret@trojan.example.com:443#Trojan",
    ].join("\n");
    mockFetch(Buffer.from(links).toString("base64"));

    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "URI 订阅",
          sourceUrl: "https://upstream.example.com/sub",
        },
      }),
      testEnv,
      "/api/providers/main/update",
    );
    const body = await readJson(response!);
    expect(body.ok).toBe(true);
    expect(body.data?.nodeCount).toBe(2);

    const provider = await handleProvider(
      makeRequest(`/provider/main/${testEnv.DOWNLOAD_TOKEN}`),
      testEnv,
      "main",
    );
    const yaml = await provider.text();
    expect(yaml).toContain("name: SS");
    expect(yaml).toContain("name: Trojan");
  });

  it("converts a SIP008 subscription into a published SS provider", async () => {
    mockFetch(
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "sip008-1",
            remarks: "SIP008",
            server: "sip008.example.com",
            server_port: 443,
            method: "aes-128-gcm",
            password: "secret",
          },
        ],
      }),
    );
    const response = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: {
          name: "SIP008 订阅",
          sourceUrl: "https://upstream.example.com/sip008.json",
        },
      }),
      testEnv,
      "/api/providers/main/update",
    );
    const body = await readJson(response!);
    expect(body.ok).toBe(true);
    expect(body.data?.nodeCount).toBe(1);
  });

  it("downloads a historical full runtime config", async () => {
    const clashConfig = `mixed-port: 7890\nproxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret\nproxy-groups:\n  - name: auto\n    type: select\n    proxies: [HK-01]\nrules:\n  - MATCH,auto`;
    mockFetch(clashConfig);
    const update = await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
      }),
      testEnv,
      "/api/providers/main/update",
    );
    const updateBody = await readJson(update!);
    const versionId = updateBody.data!.versionId as string;
    const response = await handleApi(
      makeRequest(`/api/providers/main/versions/${versionId}/yaml`, {
        token: testEnv.ADMIN_TOKEN,
      }),
      testEnv,
      `/api/providers/main/versions/${versionId}/yaml`,
    );

    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Disposition")).toContain(
      "-config.yaml",
    );
    const yaml = await response!.text();
    expect(yaml).toContain("mixed-port: 7890");
    expect(yaml).toContain("proxy-groups:");
    expect(yaml).toContain("rules:");
  });

  it("rejects empty file", async () => {
    mockFetch("");
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.message).toContain("空");
  });

  it("rejects HTML page", async () => {
    mockFetch("<!DOCTYPE html><html><body>Login</body></html>");
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.message).toContain("HTML");
  });

  it("rejects YAML with no nodes", async () => {
    mockFetch("proxies: []");
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.message).toContain("没有发现有效节点");
  });

  it("rejects invalid YAML", async () => {
    mockFetch(
      "proxies: [\n  { name: test, type: ss, server: example.com,\n  { name: test2, type: ss, server: example2.com }",
    );
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
  });

  it("rejects private addresses", async () => {
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "http://10.0.0.1/secret" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.message).toContain("私有地址");
  });

  it("rejects unauthorized admin requests", async () => {
    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      body: { name: "主订阅", sourceUrl: "https://example.com/sub" },
    });
    const resp = await handleApi(req, testEnv, "/api/providers/main/update");
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.code).toBe("UNAUTHORIZED");
  });

  it("rejects wrong download token", async () => {
    const providerYaml = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(providerYaml);
    const updateReq = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    await handleApi(updateReq, testEnv, "/api/providers/main/update");

    const downloadReq = makeRequest("/provider/main/wrong-token");
    const resp = await handleProvider(downloadReq, testEnv, "main");
    const data = await readJson(resp);
    expect(data.ok).toBe(false);
    expect(data!.error!.message).toContain("Token");
  });

  it("creates same SHA-256 only once (dedup)", async () => {
    const providerYaml = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(providerYaml);
    const req1 = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp1 = await handleApi(req1, testEnv, "/api/providers/main/update");
    const data1 = await readJson(resp1!);

    const req2 = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp2 = await handleApi(req2, testEnv, "/api/providers/main/update");
    const data2 = await readJson(resp2!);

    expect(data1.ok).toBe(true);
    expect(data1!.data!.isNew).toBe(true);
    expect(data2.ok).toBe(true);
    expect(data2!.data!.isNew).toBe(false);
  });
});

describe("provider ordering", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists an exact order and returns the list in that order", async () => {
    mockFetch(
      `proxies:\n  - name: node\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`,
    );
    for (const slug of ["alpha", "beta"]) {
      await handleApi(
        makeRequest(`/api/providers/${slug}/update`, {
          method: "POST",
          token: testEnv.ADMIN_TOKEN,
          body: { name: slug, sourceUrl: `https://${slug}.example.com/sub` },
        }),
        testEnv,
        `/api/providers/${slug}/update`,
      );
    }

    const save = await handleApi(
      makeRequest("/api/providers/order", {
        method: "PUT",
        token: testEnv.ADMIN_TOKEN,
        body: { slugs: ["beta", "alpha"] },
      }),
      testEnv,
      "/api/providers/order",
    );
    expect((await readJson(save!)).ok).toBe(true);

    const list = await handleApi(
      makeRequest("/api/providers", { token: testEnv.ADMIN_TOKEN }),
      testEnv,
      "/api/providers",
    );
    const body = (await list!.json()) as { data: Array<{ slug: string }> };
    expect(body.data.map((provider) => provider.slug)).toEqual([
      "beta",
      "alpha",
    ]);
  });

  it("rejects stale or incomplete ordering requests", async () => {
    mockFetch(
      `proxies:\n  - name: node\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`,
    );
    await handleApi(
      makeRequest("/api/providers/alpha/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: { name: "alpha", sourceUrl: "https://alpha.example.com/sub" },
      }),
      testEnv,
      "/api/providers/alpha/update",
    );
    const response = await handleApi(
      makeRequest("/api/providers/order", {
        method: "PUT",
        token: testEnv.ADMIN_TOKEN,
        body: { slugs: [] },
      }),
      testEnv,
      "/api/providers/order",
    );
    expect(response!.status).toBe(409);
  });
});

describe("provider download", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns YAML with correct headers", async () => {
    const providerYaml = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(providerYaml, 200, {
      "subscription-userinfo": "upload=0; download=123; total=456; expire=789",
      "profile-update-interval": "24",
    });

    const req = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    await handleApi(req, testEnv, "/api/providers/main/update");

    const downloadReq = makeRequest("/provider/main/" + testEnv.DOWNLOAD_TOKEN);
    const resp = await handleProvider(downloadReq, testEnv, "main");

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/yaml");
    expect(resp.headers.get("ETag")).toBeTruthy();
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("subscription-userinfo")).toBeTruthy();
  });
});

describe("rollback", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rolls back to a previous version", async () => {
    const yaml1 = `proxies:\n  - name: HK-01\n    type: ss\n    server: hk1.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret`;
    mockFetch(yaml1);
    const req1 = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub" },
    });
    const resp1 = await handleApi(req1, testEnv, "/api/providers/main/update");
    const data1 = await readJson(resp1!);
    const v1Id = data1!.data!.versionId as string;

    const yaml2 = `proxies:\n  - name: US-01\n    type: vmess\n    server: us1.example.com\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    cipher: auto`;
    mockFetch(yaml2);
    const req2 = makeRequest("/api/providers/main/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "主订阅", sourceUrl: "https://upstream.example.com/sub2" },
    });
    await handleApi(req2, testEnv, "/api/providers/main/update");

    const rollbackReq = makeRequest("/api/providers/main/rollback", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { versionId: v1Id },
    });
    const rollbackResp = await handleApi(
      rollbackReq,
      testEnv,
      "/api/providers/main/rollback",
    );
    const rollbackData = await readJson(rollbackResp!);

    expect(rollbackData.ok).toBe(true);
    expect(rollbackData!.data!.versionId).toBe(v1Id);

    const downloadReq = makeRequest("/provider/main/" + testEnv.DOWNLOAD_TOKEN);
    const downloadResp = await handleProvider(downloadReq, testEnv, "main");
    const yaml = await downloadResp.text();

    expect(yaml).toContain("HK-01");
    expect(yaml).not.toContain("US-01");
  });
});

describe("provider removal", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("removes the provider from the active list while retaining history", async () => {
    mockFetch(
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret",
    );
    await handleApi(
      makeRequest("/api/providers/main/update", {
        method: "POST",
        token: testEnv.ADMIN_TOKEN,
        body: { name: "Main", sourceUrl: "https://example.com/sub" },
      }),
      testEnv,
      "/api/providers/main/update",
    );

    await handleApi(
      makeRequest("/api/providers/main", {
        method: "DELETE",
        token: testEnv.ADMIN_TOKEN,
      }),
      testEnv,
      "/api/providers/main",
    );

    const list = await handleApi(
      makeRequest("/api/providers", { token: testEnv.ADMIN_TOKEN }),
      testEnv,
      "/api/providers",
    );
    expect((await readJson(list!)).data).toEqual([]);
    expect(
      await storage.listVersions(mockBucket as unknown as R2Bucket, "main"),
    ).not.toHaveLength(0);
  });
});

describe("slug traversal", () => {
  beforeEach(() => {
    mockBucket.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects path traversal in slug", async () => {
    mockFetch(
      "proxies:\n  - name: test\n    type: ss\n    server: s.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret",
    );
    const req = makeRequest("/api/providers/%2e%2e%2fadmin/update", {
      method: "POST",
      token: testEnv.ADMIN_TOKEN,
      body: { name: "test", sourceUrl: "https://example.com/sub" },
    });
    const resp = await handleApi(
      req,
      testEnv,
      "/api/providers/..%2fadmin/update",
    );
    const data = await readJson(resp!);
    expect(data.ok).toBe(false);
    expect(data!.error!.code).toBe("INVALID_SLUG");
  });
});
