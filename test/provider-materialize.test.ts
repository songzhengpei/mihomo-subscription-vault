import { beforeEach, describe, expect, it, vi } from "vitest";
import jsYaml from "js-yaml";
import type { Env, ProxyNode } from "../src/types.ts";
import { expectedProviderNodeCount } from "../src/types.ts";
import {
  materializeProviderProxies,
  updateProvider,
} from "../src/services/updater.ts";
import * as storage from "../src/services/storage.ts";
import { buildUnifiedExport } from "../src/services/unified-export.ts";
import {
  executeUnifiedImport,
  parseUnifiedImport,
} from "../src/services/unified-import.ts";

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn() },
}));

const BASE_URL = "https://vault.example";
const DOWNLOAD_TOKEN = "fixed-token";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Memory bucket (mirrors the harness used by the roundtrip tests) ---

class MemoryBucket {
  private readonly values = new Map<string, Uint8Array>();
  private readonly etags = new Map<string, string>();
  private sequence = 0;

  async get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    const copy = value.slice();
    return {
      key,
      etag: this.etags.get(key)!,
      size: copy.length,
      async text() {
        return decoder.decode(copy);
      },
      async json() {
        return JSON.parse(decoder.decode(copy));
      },
      async arrayBuffer() {
        return copy.buffer.slice(
          copy.byteOffset,
          copy.byteOffset + copy.byteLength,
        );
      },
    };
  }

  async head(key: string) {
    const value = this.values.get(key);
    return value
      ? { key, etag: this.etags.get(key)!, size: value.length }
      : null;
  }

  async put(
    key: string,
    body: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ) {
    const current = this.etags.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && current !== undefined)
      return null;
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      options.onlyIf.etagMatches !== current
    )
      return null;
    const bytes =
      typeof body === "string"
        ? encoder.encode(body)
        : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    const etag = `etag-${++this.sequence}`;
    this.values.set(key, bytes);
    this.etags.set(key, etag);
    return { key, etag };
  }

  async list(options?: { prefix?: string; delimiter?: string }) {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter ?? "";
    const keys = [...this.values.keys()].filter((key) =>
      key.startsWith(prefix),
    );
    if (!delimiter)
      return {
        objects: keys.map((key) => ({ key })),
        delimitedPrefixes: [],
        truncated: false,
      };
    const prefixes = new Set<string>();
    const objects: Array<{ key: string }> = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index < 0) objects.push({ key });
      else prefixes.add(prefix + rest.slice(0, index + 1));
    }
    return {
      objects,
      delimitedPrefixes: [...prefixes],
      truncated: false,
    };
  }

  async delete(key: string) {
    this.values.delete(key);
    this.etags.delete(key);
  }
}

function makeEnv(bucket: MemoryBucket, overrides: Partial<Env> = {}): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    ADMIN_TOKEN: "test-admin",
    DOWNLOAD_TOKEN,
    PUBLIC_BASE_URL: BASE_URL,
    MAX_SOURCE_BYTES: "5242880",
    MAX_REDIRECTS: "3",
    FETCH_TIMEOUT_MS: "20000",
    ...overrides,
  } as unknown as Env;
}

function mockFetchByUrl(map: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : ((input as { url: string }).url as string);
      const content = map[url];
      if (content === undefined) throw new Error(`unexpected fetch: ${url}`);
      const encoded = encoder.encode(content);
      let read = false;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => content,
        arrayBuffer: async () => encoded.buffer,
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
      };
    }),
  );
}

function ssNode(name: string, server: string) {
  return [
    `  - name: ${JSON.stringify(name)}`,
    `    type: ss`,
    `    server: ${server}`,
    `    port: 443`,
    `    cipher: aes-128-gcm`,
    `    password: pw`,
  ].join("\n");
}

const FLOWER_URL = `${BASE_URL}/provider/flower/${DOWNLOAD_TOKEN}`;
const IMM_URL = `${BASE_URL}/provider/imm/${DOWNLOAD_TOKEN}`;

// Flower: 2 real nodes + 1 billing banner that the exclude-filter must drop.
const FLOWER_YAML = `proxies:\n${ssNode("HK-01", "hk01.flower.example")}\n${ssNode(
  "HK-02",
  "hk02.flower.example",
)}\n${ssNode("Traffic: 1 GB | 100 GB", "banner.flower.example")}`;

// ImmTelecom: 1 real node.
const IMM_YAML = `proxies:\n${ssNode("JP-01", "jp01.imm.example")}`;

// Full config: 3 inline proxies (2 of them DIRECT placeholders) plus two native
// `proxy-providers` that point back at this instance.
const FULL_CONFIG_YAML = `proxies:
  - name: '🇨🇳 直连 | IPv4优先'
    type: direct
    ip-version: ipv4-prefer
  - name: '🇨🇳 直连 | IPv6优先'
    type: direct
    ip-version: ipv6-prefer
${ssNode("本地-SS", "local.example")}
proxy-providers:
  Flower:
    type: http
    url: '${FLOWER_URL}'
    path: ./proxy_providers/flower.yaml
    exclude-filter: 'Traffic|流量|到期'
  ImmTelecom:
    type: http
    url: '${IMM_URL}'
    path: ./proxy_providers/imm.yaml
    exclude-filter: 'Traffic|流量|到期'
proxy-groups:
  - name: auto
    type: select
    proxies: ['本地-SS']
    use: [Flower, ImmTelecom]
rules:
  - MATCH,auto`;

const FULL_CONFIG_URL = "https://upstream.example/full.yaml";

async function publishFixtureProviders(
  bucket: MemoryBucket,
  env: Env,
): Promise<void> {
  mockFetchByUrl({
    "https://upstream.example/flower": FLOWER_YAML,
    "https://upstream.example/imm": IMM_YAML,
  });
  await updateProvider(
    bucket as unknown as R2Bucket,
    "flower",
    "https://upstream.example/flower",
    "Flower",
    env,
  );
  await updateProvider(
    bucket as unknown as R2Bucket,
    "imm",
    "https://upstream.example/imm",
    "ImmTelecom",
    env,
  );
}

async function loadProviderSnapshot(bucket: MemoryBucket, slug: string) {
  const bundle = await storage.resolveProviderBundleMetadata(
    bucket as unknown as R2Bucket,
    slug,
  );
  if (!bundle) throw new Error(`no bundle for ${slug}`);
  const providerYaml = await storage.getVersionYaml(
    bucket as unknown as R2Bucket,
    slug,
    bundle.pointer.versionId,
  );
  const names = (
    (jsYaml.load(providerYaml!) as { proxies: ProxyNode[] }).proxies ?? []
  ).map((node) => node.name);
  return { meta: bundle.meta, names, providerYaml: providerYaml! };
}

describe("materializeProviderProxies", () => {
  const node = (name: string, type = "ss"): ProxyNode =>
    ({ name, type, server: "s.example", port: 443 }) as unknown as ProxyNode;

  it("drops direct entries and keeps the remaining order", () => {
    const result = materializeProviderProxies(
      [node("d1", "direct"), node("inline"), node("d2", "direct")],
      [node("dep-1"), node("dep-2")],
    );
    expect(result.proxies.map((p) => p.name)).toEqual([
      "inline",
      "dep-1",
      "dep-2",
    ]);
    expect(result.droppedDirect).toBe(2);
    expect(result.droppedDuplicate).toBe(0);
  });

  it("drops duplicate names, keeping the first occurrence", () => {
    const first = node("dup");
    const result = materializeProviderProxies(
      [first],
      [node("dup"), node("other")],
    );
    expect(result.proxies.map((p) => p.name)).toEqual(["dup", "other"]);
    expect(result.proxies[0]).toBe(first);
    expect(result.droppedDuplicate).toBe(1);
  });

  it("returns an empty list when everything is direct", () => {
    const result = materializeProviderProxies(
      [node("d", "direct")],
      [node("d2", "direct")],
    );
    expect(result.proxies).toEqual([]);
    expect(result.droppedDirect).toBe(2);
  });
});

describe("expectedProviderNodeCount", () => {
  const meta = (schemaVersion: 1 | 2, nodeCount: number, nodeStats?: unknown) =>
    ({
      schemaVersion,
      nodeCount,
      nodeStats,
    }) as never;

  it("prefers nodeStats.materialized when present", () => {
    expect(
      expectedProviderNodeCount(
        meta(2, 4, {
          inline: 3,
          dependencyRaw: 4,
          excluded: 1,
          effective: 6,
          materialized: 4,
        }),
      ),
    ).toBe(4);
  });

  it("falls back to nodeStats.inline for pre-materialization versions", () => {
    expect(
      expectedProviderNodeCount(
        meta(2, 3, {
          inline: 3,
          dependencyRaw: 4,
          excluded: 1,
          effective: 6,
        }),
      ),
    ).toBe(3);
  });

  it("falls back to nodeCount for schemaVersion 1", () => {
    expect(expectedProviderNodeCount(meta(1, 2))).toBe(2);
  });
});

describe("full-config Provider materialization", () => {
  let bucket: MemoryBucket;
  let env: Env;

  beforeEach(() => {
    bucket = new MemoryBucket();
    env = makeEnv(bucket);
    vi.unstubAllGlobals();
  });

  it("serves the resolved airport nodes instead of inline DIRECT placeholders", async () => {
    await publishFixtureProviders(bucket, env);

    mockFetchByUrl({ [FULL_CONFIG_URL]: FULL_CONFIG_YAML });
    await updateProvider(
      bucket as unknown as R2Bucket,
      "main",
      FULL_CONFIG_URL,
      "主配置",
      env,
    );

    const snapshot = await loadProviderSnapshot(bucket, "main");

    // 2 DIRECT placeholders dropped, 1 inline node kept, 3 dependency nodes
    // kept, 1 billing banner dropped by exclude-filter.
    expect(snapshot.names).toEqual(["本地-SS", "HK-01", "HK-02", "JP-01"]);
    expect(snapshot.meta.nodeCount).toBe(4);
    expect(snapshot.meta.schemaVersion).toBe(2);
    expect(snapshot.meta.nodeStats).toEqual({
      inline: 3,
      dependencyRaw: 4,
      excluded: 1,
      effective: 6,
      materialized: 4,
    });
    expect(
      snapshot.meta.internalDependencies?.map((dep) => dep.slug).sort(),
    ).toEqual(["flower", "imm"]);
    expect(expectedProviderNodeCount(snapshot.meta)).toBe(4);

    // profile.yaml keeps the full config, native proxy-providers included.
    const bundle = await storage.resolveProviderBundleMetadata(
      bucket as unknown as R2Bucket,
      "main",
    );
    const profileBytes = await storage.getVersionProfileForDownload(
      bucket as unknown as R2Bucket,
      "main",
      bundle!.pointer.versionId,
    );
    const profile = jsYaml.load(decoder.decode(profileBytes!)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(profile["proxy-providers"] as object)).toEqual([
      "Flower",
      "ImmTelecom",
    ]);
    expect((profile.proxies as ProxyNode[]).map((node) => node.name)).toEqual([
      "🇨🇳 直连 | IPv4优先",
      "🇨🇳 直连 | IPv6优先",
      "本地-SS",
    ]);
  });

  it("falls back to inline proxies when no internal provider is identified", async () => {
    await publishFixtureProviders(bucket, env);

    // A different public base URL means the config's Provider URLs no longer
    // look like this instance's, so nothing is identified as a dependency.
    const foreignEnv = makeEnv(bucket, {
      PUBLIC_BASE_URL: "https://elsewhere.example",
    });

    mockFetchByUrl({ [FULL_CONFIG_URL]: FULL_CONFIG_YAML });
    await updateProvider(
      bucket as unknown as R2Bucket,
      "main",
      FULL_CONFIG_URL,
      "主配置",
      foreignEnv,
    );

    const snapshot = await loadProviderSnapshot(bucket, "main");

    expect(snapshot.names).toEqual([
      "🇨🇳 直连 | IPv4优先",
      "🇨🇳 直连 | IPv6优先",
      "本地-SS",
    ]);
    expect(snapshot.meta.nodeCount).toBe(3);
    expect(snapshot.meta.schemaVersion).toBe(1);
    expect(snapshot.meta.nodeStats).toBeUndefined();
  });

  it("round-trips a materialized Provider through export and import", async () => {
    await publishFixtureProviders(bucket, env);
    mockFetchByUrl({ [FULL_CONFIG_URL]: FULL_CONFIG_YAML });
    await updateProvider(
      bucket as unknown as R2Bucket,
      "main",
      FULL_CONFIG_URL,
      "主配置",
      env,
    );

    const exported = await buildUnifiedExport(
      bucket as unknown as R2Bucket,
      env,
    );
    const bytes = new Uint8Array(
      await new Response(exported.stream).arrayBuffer(),
    );

    const plan = await parseUnifiedImport(bytes, BASE_URL);

    // The materialized archive must survive identity validation: provider.yaml
    // holds 4 nodes while nodeStats.inline is only 3.
    const mainPlan = plan.providers.find(
      (provider) => provider.publishInput.providerSlug === "main",
    );
    expect(mainPlan).toBeDefined();
    expect(
      (
        jsYaml.load(mainPlan!.publishInput.providerYaml) as {
          proxies: ProxyNode[];
        }
      ).proxies.map((node) => node.name),
    ).toEqual(["本地-SS", "HK-01", "HK-02", "JP-01"]);

    // Worker archives reference raw artifacts by key instead of embedding them,
    // so a restore targets an instance that already holds them.
    await executeUnifiedImport(bucket as unknown as R2Bucket, plan);

    const snapshot = await loadProviderSnapshot(bucket, "main");
    expect(snapshot.names).toEqual(["本地-SS", "HK-01", "HK-02", "JP-01"]);
    expect(snapshot.meta.nodeCount).toBe(4);
    expect(snapshot.meta.nodeStats?.materialized).toBe(4);
  });
});
