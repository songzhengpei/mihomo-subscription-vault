import type {
  Env,
  ProviderMeta,
  ProxyNode,
  NodeStats,
  InternalDependencyInfo,
  ProxyProviderEntry,
  ClientUpdatePolicy,
} from "../types.ts";
import { isLatestVersionPointerV1 } from "../types.ts";
import { validateUrl, validateSlug } from "../security/ssrf.ts";
import {
  parseAndValidateProvider,
  generateProviderYaml,
  generateProfileYaml,
} from "./validator.ts";
import * as storage from "./storage.ts";
import puppeteer from "@cloudflare/puppeteer";

export const DEFAULT_UPSTREAM_USER_AGENT = "clash-verge/v2.4.5";

export function normalizeUpstreamUserAgent(value?: string): string {
  const userAgent = value?.trim() || DEFAULT_UPSTREAM_USER_AGENT;
  if (userAgent.length > 256 || /[\r\n\0]/.test(userAgent)) {
    throw new Error("User-Agent 格式无效");
  }
  return userAgent;
}

function getConfig(env: Env) {
  return {
    maxSourceBytes: parseInt(env.MAX_SOURCE_BYTES || "5242880", 10),
    maxRedirects: parseInt(env.MAX_REDIRECTS || "3", 10),
    fetchTimeoutMs: parseInt(env.FETCH_TIMEOUT_MS || "20000", 10),
  };
}

function extractHost(urlString: string): string {
  try {
    return new URL(urlString).hostname;
  } catch {
    return "";
  }
}

async function fetchWithRedirects(
  url: string,
  config: ReturnType<typeof getConfig>,
  userAgent: string,
): Promise<{
  response: Response;
  finalUrl: string;
}> {
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      config.fetchTimeoutMs,
    );

    try {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
        },
        redirect: "manual",
      });
      clearTimeout(timeoutId);

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("Location")
      ) {
        redirectCount++;
        if (redirectCount > config.maxRedirects) {
          throw new Error("重定向次数超过限制");
        }
        const location = response.headers.get("Location")!;
        const redirectUrl = new URL(location, currentUrl).toString();
        const validation = validateUrl(redirectUrl);
        if (!validation.valid) {
          throw new Error(`重定向目标不安全: ${validation.error}`);
        }
        currentUrl = redirectUrl;
        continue;
      }

      return { response, finalUrl: currentUrl };
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error("请求超时");
      }
      throw e;
    }
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ content: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("无法读取响应体");
  }

  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const bodyTimeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("响应体读取超时")),
      timeoutMs,
    );
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), bodyTimeout]);
      if (done) break;

      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { content: "", truncated: true };
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel(e).catch(() => undefined);
    throw e;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return { content: decoder.decode(result), truncated: false };
}

async function fetchWithBrowserFallback(
  env: Env,
  url: string,
  config: ReturnType<typeof getConfig>,
  userAgent: string,
): Promise<{ response: Response; finalUrl: string }> {
  if (!env.BROWSER) {
    throw new Error("浏览器抓取服务未配置");
  }
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    // A subscription response may carry Content-Disposition: attachment.
    // Chromium aborts top-level navigation to downloads with ERR_ABORTED, so
    // establish a same-origin page and read the resource through browser fetch.
    const origin = new URL(url).origin;
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: config.fetchTimeoutMs,
    });
    const browserResponse = await page.evaluate(
      async ({ targetUrl, timeoutMs }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(targetUrl, {
            signal: controller.signal,
            redirect: "follow",
          });
          return {
            status: response.status,
            finalUrl: response.url,
            headers: Object.fromEntries(response.headers.entries()),
            content: await response.text(),
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      { targetUrl: url, timeoutMs: config.fetchTimeoutMs },
    );

    const finalUrl = browserResponse.finalUrl;
    const validation = validateUrl(finalUrl);
    if (!validation.valid) {
      throw new Error(`浏览器重定向目标不安全: ${validation.error}`);
    }

    const body = new TextEncoder().encode(browserResponse.content);
    if (body.byteLength > config.maxSourceBytes) {
      throw new Error(
        `上游内容超过大小限制 (${(config.maxSourceBytes / 1024 / 1024).toFixed(1)}MB)`,
      );
    }
    const headers = new Headers();
    for (const name of [
      "content-type",
      "subscription-userinfo",
      "profile-update-interval",
      "profile-web-page-url",
    ]) {
      const value = browserResponse.headers[name];
      if (value) headers.set(name, value);
    }
    return {
      response: new Response(body, {
        status: browserResponse.status,
        headers,
      }),
      finalUrl,
    };
  } finally {
    await browser.close();
  }
}

async function fetchWithPrivateRelay(
  env: Env,
  url: string,
  config: ReturnType<typeof getConfig>,
  userAgent: string,
): Promise<{ response: Response; finalUrl: string }> {
  if (!env.UPSTREAM_RELAY) {
    throw new Error("私有兼容中继未配置");
  }
  const response = await env.UPSTREAM_RELAY.fetch(
    "http://upstream-relay.internal/fetch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        userAgent,
        maxBytes: config.maxSourceBytes,
        maxRedirects: config.maxRedirects,
        timeoutMs: config.fetchTimeoutMs,
      }),
    },
  );
  const relayError = response.headers.get("x-vault-relay-error");
  if (relayError) {
    await response.body?.cancel();
    throw new Error(`私有兼容中继请求失败 (${relayError})`);
  }
  if (response.headers.get("x-vault-relay") !== "1") {
    await response.body?.cancel();
    throw new Error("私有兼容中继响应无效");
  }

  const finalHost = response.headers.get("x-vault-upstream-host");
  if (!finalHost || finalHost.includes("/") || finalHost.includes("\\")) {
    await response.body?.cancel();
    throw new Error("私有兼容中继未返回有效的上游主机");
  }
  return {
    response,
    finalUrl: `https://${finalHost}/`,
  };
}

function generateRequestId(): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface InternalProviderRef {
  slug: string;
  excludeFilter?: string[];
}

function identifyInternalProviders(
  proxyProviders: Record<string, ProxyProviderEntry> | undefined,
  publicBaseUrl: string,
  downloadToken: string,
): Map<string, InternalProviderRef> {
  const result = new Map<string, InternalProviderRef>();
  if (!proxyProviders) return result;

  let baseOrigin: string;
  try {
    baseOrigin = new URL(publicBaseUrl).origin;
  } catch {
    return result;
  }

  for (const [name, entry] of Object.entries(proxyProviders)) {
    if (!entry.url || entry.type !== "http") continue;

    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }

    // Must be HTTPS
    if (url.protocol !== "https:") continue;

    // Origin must match PUBLIC_BASE_URL exactly
    if (`${url.protocol}//${url.host}` !== baseOrigin) continue;

    // Path must match /provider/:slug/:token
    const match = url.pathname.match(/^\/provider\/([^/]+)\/([^/]+)$/);
    if (!match) continue;

    const depSlug = match[1]!;
    const depToken = match[2]!;

    // Token must match DOWNLOAD_TOKEN
    if (depToken !== downloadToken) continue;

    // No query, no fragment
    if (url.search || url.hash) continue;

    // Slug must be valid
    if (!validateSlug(depSlug)) continue;

    result.set(name, {
      slug: depSlug,
      excludeFilter: entry["exclude-filter"],
    });
  }

  return result;
}

function applyExcludeFilter(
  proxies: ProxyNode[],
  excludeFilter: string[] | undefined,
): { total: number; excluded: number; effective: ProxyNode[] } {
  if (!excludeFilter || excludeFilter.length === 0) {
    return { total: proxies.length, excluded: 0, effective: proxies };
  }

  const patterns = excludeFilter
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RegExp[];

  if (patterns.length === 0) {
    return { total: proxies.length, excluded: 0, effective: proxies };
  }

  const effective = proxies.filter(
    (p) => !patterns.some((re) => re.test(p.name)),
  );
  return {
    total: proxies.length,
    excluded: proxies.length - effective.length,
    effective,
  };
}

async function resolveInternalDependency(
  bucket: R2Bucket,
  slug: string,
): Promise<{
  subscriptionId: string;
  uid: string;
  versionId: string;
  proxies: ProxyNode[];
  providerSha256: string;
  profileSha256: string;
} | null> {
  const stored = await storage.readStoredLatestPointer(bucket, slug);
  if (!stored || !isLatestVersionPointerV1(stored.pointer)) return null;

  const pointer = stored.pointer;

  // Resolve and verify the version
  let resolved: Awaited<
    ReturnType<typeof storage.resolveProviderBundleAtVersion>
  >;
  try {
    resolved = await storage.resolveProviderBundleAtVersion(
      bucket,
      slug,
      pointer,
    );
  } catch {
    return null;
  }

  // Parse provider.yaml to get proxies
  const providerText = new TextDecoder().decode(resolved.providerBytes);
  const parsed = parseAndValidateProvider(providerText);
  if (!parsed.valid || !parsed.proxies) return null;

  return {
    subscriptionId: pointer.subscriptionId,
    uid: pointer.uid,
    versionId: pointer.versionId,
    proxies: parsed.proxies,
    providerSha256: resolved.meta.artifacts.provider.sha256,
    profileSha256: resolved.meta.artifacts.profile.sha256,
  };
}

async function computeNodeStats(
  bucket: R2Bucket,
  inlineProxies: ProxyNode[],
  proxyProviders: Record<string, ProxyProviderEntry> | undefined,
  publicBaseUrl: string,
  downloadToken: string,
): Promise<{
  nodeStats: NodeStats;
  internalDependencies: InternalDependencyInfo[];
}> {
  const inline = inlineProxies.length;
  const internalRefs = identifyInternalProviders(
    proxyProviders,
    publicBaseUrl,
    downloadToken,
  );

  if (internalRefs.size === 0) {
    return {
      nodeStats: { inline, dependencyRaw: 0, excluded: 0, effective: inline },
      internalDependencies: [],
    };
  }

  let dependencyRaw = 0;
  let excluded = 0;
  const dependencies: InternalDependencyInfo[] = [];
  const resolvedSlugs = new Map<
    string,
    {
      subscriptionId: string;
      uid: string;
      versionId: string;
      nodeCount: number;
      providerSha256: string;
      profileSha256: string;
    }
  >();

  for (const [, ref] of internalRefs) {
    // Deduplicate: same slug only resolved once
    if (resolvedSlugs.has(ref.slug)) continue;

    const resolved = await resolveInternalDependency(bucket, ref.slug);
    if (!resolved) {
      throw new Error(`内部依赖 Provider ${ref.slug} 缺失或损坏，无法完成更新`);
    }

    const {
      total,
      excluded: excl,
      effective,
    } = applyExcludeFilter(resolved.proxies, ref.excludeFilter);

    dependencyRaw += total;
    excluded += excl;

    resolvedSlugs.set(ref.slug, {
      subscriptionId: resolved.subscriptionId,
      uid: resolved.uid,
      versionId: resolved.versionId,
      nodeCount: total,
      providerSha256: resolved.providerSha256,
      profileSha256: resolved.profileSha256,
    });

    dependencies.push({
      slug: ref.slug,
      subscriptionId: resolved.subscriptionId,
      uid: resolved.uid,
      versionId: resolved.versionId,
      nodeCount: total,
      excludedCount: excl,
      effectiveCount: effective.length,
      providerSha256: resolved.providerSha256,
      profileSha256: resolved.profileSha256,
    });
  }

  const effective = inline + dependencyRaw - excluded;

  return {
    nodeStats: { inline, dependencyRaw, excluded, effective },
    internalDependencies: dependencies,
  };
}

export async function updateProvider(
  bucket: R2Bucket,
  slug: string,
  sourceUrl: string,
  providerName: string,
  env: Env,
  requestedUserAgent?: string,
): Promise<{ meta: ProviderMeta; isNew: boolean }> {
  const config = getConfig(env);
  const userAgent = normalizeUpstreamUserAgent(requestedUserAgent);
  const requestId = generateRequestId();

  // 1. Read raw stored pointer (no compatibility projection)
  const stored = await storage.readStoredLatestPointer(bucket, slug);
  let subscriptionId: string;
  let existingClientUpdatePolicy: ClientUpdatePolicy | undefined;

  if (stored && isLatestVersionPointerV1(stored.pointer)) {
    // V1: reuse identity
    subscriptionId = stored.pointer.subscriptionId;
    try {
      existingClientUpdatePolicy = (
        await storage.resolveProviderBundleMetadata(bucket, slug)
      )?.meta.distribution.clientUpdatePolicy;
    } catch {
      // Existing corruption remains handled by the publication kernel.
    }
  } else {
    // Legacy or first publish: generate new identity
    subscriptionId = crypto.randomUUID();
  }

  // 2. Fetch upstream directly first. Browser Rendering is substantially more
  // expensive and has a different network fingerprint, so keep it as a bounded
  // fallback only for explicit access denial from the direct request.
  const fetchStartedAt = Date.now();
  let fetched = await fetchWithRedirects(sourceUrl, config, userAgent);
  let fetchMethod: "browser" | "direct" | "relay" = "direct";

  if (fetched.response.status === 403 && env.BROWSER) {
    try {
      const browserResult = await fetchWithBrowserFallback(
        env,
        sourceUrl,
        config,
        userAgent,
      );
      if (browserResult.response.ok) {
        fetched = browserResult;
        fetchMethod = "browser";
      } else {
        console.warn("provider-fetch:browser-non-ok", {
          slug,
          requestId,
          status: browserResult.response.status,
        });
      }
    } catch (error) {
      console.warn("provider-fetch:browser-failed", {
        slug,
        requestId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (fetched.response.status === 403 && env.UPSTREAM_RELAY) {
    try {
      const relayResult = await fetchWithPrivateRelay(
        env,
        sourceUrl,
        config,
        userAgent,
      );
      fetched = relayResult;
      fetchMethod = "relay";
    } catch (error) {
      console.warn("provider-fetch:relay-failed", {
        slug,
        requestId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const { response, finalUrl } = fetched;
  if (env.BROWSER) {
    console.info("provider-fetch:completed", {
      slug,
      requestId,
      method: fetchMethod,
      status: response.status,
      elapsedMs: Date.now() - fetchStartedAt,
    });
  }

  if (!response.ok) {
    throw new Error(`上游返回 HTTP ${response.status}`);
  }

  const { content: rawText, truncated } = await readBodyWithLimit(
    response,
    config.maxSourceBytes,
    config.fetchTimeoutMs,
  );

  if (truncated) {
    throw new Error(
      `上游内容超过大小限制 (${(config.maxSourceBytes / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  // Save raw staging snapshot
  await storage.writeStaging(bucket, slug, requestId, rawText, {
    sourceUrl: extractHost(finalUrl),
    fetchedAt: new Date().toISOString(),
    contentLength: new TextEncoder().encode(rawText).length,
  });

  // 3. Parse and validate
  const validation = parseAndValidateProvider(rawText);
  if (!validation.valid || !validation.proxies) {
    await storage.markStagingFailed(
      bucket,
      slug,
      requestId,
      validation.error || "验证失败",
    );
    throw new Error(validation.error || "验证失败");
  }

  const publicBaseUrl = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const downloadToken = env.DOWNLOAD_TOKEN || "";

  // 4. Generate all three artifacts
  const providerYaml = generateProviderYaml(validation.proxies);
  const profileYaml = generateProfileYaml(
    validation.proxies,
    validation.fullConfig,
  );

  // 5. Compute uid
  const uid = await storage.computeProfileUid(subscriptionId);

  // 6. Compute nodeStats by resolving internal dependencies
  const { nodeStats, internalDependencies } = await computeNodeStats(
    bucket,
    validation.proxies,
    validation.proxyProviders,
    publicBaseUrl,
    downloadToken,
  );

  // 7. Build distribution metadata
  const subUserinfo =
    response.headers.get("subscription-userinfo") ?? undefined;
  const profileInterval =
    response.headers.get("profile-update-interval") ?? undefined;
  const profileWebUrl =
    response.headers.get("profile-web-page-url") ?? undefined;

  // 8. Publish V1 version — V1 kernel handles ALL dedup/idempotency
  // Pass expectedLatestEtag for CAS: reject if pointer changed during fetch
  const published = await storage.publishProviderVersion(bucket, {
    providerSlug: slug,
    subscriptionId,
    uid,
    rawContent: rawText,
    providerYaml,
    profileYaml,
    nodeCount: nodeStats.effective,
    generatorVersion: "1.0.0",
    distribution: {
      providerName,
      sourceHost: extractHost(finalUrl),
      subscriptionUserinfo: subUserinfo,
      profileUpdateInterval: profileInterval,
      profileWebPageUrl: profileWebUrl,
      clientUpdatePolicy: existingClientUpdatePolicy,
    },
    expectedLatestEtag: stored?.etag,
    nodeStats: internalDependencies.length > 0 ? nodeStats : undefined,
    internalDependencies:
      internalDependencies.length > 0 ? internalDependencies : undefined,
  });

  // 9. Mark staging as completed and persist source URL
  await storage.markStagingCompleted(bucket, slug, requestId);
  await storage.saveSourceUrl(bucket, slug, sourceUrl, userAgent);

  // 10. Determine isNew by comparing versionId
  const isNew =
    !stored ||
    !isLatestVersionPointerV1(stored.pointer) ||
    stored.pointer.versionId !== published.versionId;

  // Project to legacy ProviderMeta for API compatibility
  const legacyMeta: ProviderMeta = {
    versionId: published.meta.versionId,
    providerSlug: published.meta.providerSlug,
    providerName: published.meta.distribution.providerName,
    createdAt: published.meta.createdAt,
    sha256: published.meta.artifacts.provider.sha256,
    nodeCount: published.meta.nodeCount,
    sourceHost: published.meta.distribution.sourceHost,
    contentLength: published.meta.artifacts.provider.contentLength,
    subscriptionUserinfo: published.meta.distribution.subscriptionUserinfo,
    profileUpdateInterval: published.meta.distribution.profileUpdateInterval,
    profileWebPageUrl: published.meta.distribution.profileWebPageUrl,
  };

  return { meta: legacyMeta, isNew };
}
