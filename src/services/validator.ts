import * as yaml from "js-yaml";
import type { ClashConfig, ProxyNode, ProxyProviderEntry } from "../types.ts";
import {
  convertSubscriptionContent,
  decodeSubscriptionLayer,
} from "./subscription-converter.ts";

export function isBase64Content(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.length < 20) return false;
  const base64Regex = /^[A-Za-z0-9+/_=\s-]+$/;
  const lines = trimmed
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return (
      base64Regex.test(trimmed) && trimmed.replace(/\s+/g, "").length > 100
    );
  }
  return false;
}

export interface ParsedProviderResult {
  valid: boolean;
  proxies?: ProxyNode[];
  fullConfig?: Record<string, unknown>;
  proxyProviders?: Record<string, ProxyProviderEntry>;
  sourceType?: "full-config" | "provider" | "uri-list" | "sip008";
  error?: string;
}

export function parseAndValidateProvider(
  content: string,
): ParsedProviderResult {
  return parseProviderCandidate(content, 0);
}

function parseProviderCandidate(
  content: string,
  decodeDepth: number,
): ParsedProviderResult {
  if (!content || content.trim().length === 0) {
    return { valid: false, error: "内容为空" };
  }

  const trimmed = content.replace(/^\uFEFF/, "").trim();

  // Check for HTML
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<HTML") ||
    trimmed.startsWith("<?xml") ||
    trimmed.match(/<html[\s>]/i)
  ) {
    return {
      valid: false,
      error: "内容是 HTML/XML 页面，不是有效的订阅",
    };
  }

  let parsed: unknown;
  let yamlError: string | undefined;
  try {
    parsed = yaml.load(trimmed);
  } catch (e) {
    yamlError = `YAML 解析失败: ${e instanceof Error ? e.message : "未知错误"}`;
  }

  const doc =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  const unsupportedError = detectUnsupportedClientConfig(trimmed, doc);
  if (unsupportedError) {
    return { valid: false, error: unsupportedError };
  }

  // Full Clash/Mihomo config detection — must check BEFORE generic proxies.
  // A full config has proxies AND at least one of: proxy-groups, rules, dns, etc.
  const hasProxies = Array.isArray(doc?.proxies);
  const hasFullConfigKeys =
    doc?.["proxy-groups"] !== undefined ||
    doc?.rules !== undefined ||
    doc?.dns !== undefined ||
    doc?.hosts !== undefined ||
    doc?.sniffer !== undefined ||
    doc?.tun !== undefined ||
    doc?.listeners !== undefined;

  if (hasProxies && hasFullConfigKeys) {
    const result = validateProxies(doc!.proxies as unknown[]);
    if (result.valid) {
      const proxyProviders = parseProxyProviders(doc!["proxy-providers"]);
      return {
        ...result,
        fullConfig: doc!,
        proxyProviders,
        sourceType: "full-config",
      };
    }
    return result;
  }

  // Direct provider format (just a list of proxies, no other config keys)
  if (hasProxies) {
    const result = validateProxies(doc!.proxies as unknown[]);
    if (result.valid) {
      return { ...result, sourceType: "provider" };
    }
    return result;
  }

  // proxies field present but not an array
  if (doc?.proxies !== undefined) {
    return { valid: false, error: "配置文件中 proxies 字段不是数组" };
  }

  if (Array.isArray(parsed)) {
    const result = validateProxies(parsed);
    if (result.valid) {
      return { ...result, sourceType: "provider" };
    }
  }

  try {
    const converted = convertSubscriptionContent(trimmed, parsed);
    if (converted) {
      const result = validateProxies(converted.proxies);
      return result.valid
        ? { ...result, sourceType: converted.sourceType }
        : result;
    }
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : "订阅转换失败",
    };
  }

  if (decodeDepth < 3) {
    const decoded = decodeSubscriptionLayer(trimmed);
    if (decoded && decoded.trim() !== trimmed) {
      return parseProviderCandidate(decoded, decodeDepth + 1);
    }
  }

  return {
    valid: false,
    error:
      yamlError || "未找到 proxies，也未识别到 URI 订阅或 SIP008 服务器列表",
  };
}

function detectUnsupportedClientConfig(
  text: string,
  doc: Record<string, unknown> | undefined,
): string | undefined {
  if (
    /^\s*\[(?:General|Proxy|Proxy Group|Rule|Host|URL Rewrite)\]\s*$/im.test(
      text,
    )
  ) {
    return "检测到 Surge/Shadowrocket 配置文件；仅支持其中的通用代理 URI 订阅";
  }
  if (
    /^\s*\[(?:server_local|server_remote|filter_local|filter_remote|rewrite_local|rewrite_remote|mitm|task_local|task_remote)\]\s*$/im.test(
      text,
    )
  ) {
    return "检测到 Quantumult/Quantumult X 专属配置，不在支持范围内";
  }
  if (
    /^\s*(?:shadowsocks|vmess|trojan|http|socks5)\s*=/im.test(text) &&
    /(?:tag|method|password)\s*=/i.test(text)
  ) {
    return "检测到 Quantumult X 专属节点格式，不在支持范围内";
  }
  const stashHttp =
    doc?.http && typeof doc.http === "object" && !Array.isArray(doc.http)
      ? (doc.http as Record<string, unknown>)
      : undefined;
  if (
    doc &&
    (doc["script-providers"] !== undefined ||
      doc.cron !== undefined ||
      doc.tiles !== undefined ||
      stashHttp?.mitm !== undefined ||
      stashHttp?.["url-rewrite"] !== undefined ||
      stashHttp?.script !== undefined ||
      stashHttp?.["force-http-engine"] !== undefined)
  ) {
    return "检测到 Stash 专属配置，不在支持范围内";
  }
  if (
    doc &&
    Array.isArray(doc.outbounds) &&
    (doc.inbounds !== undefined ||
      doc.route !== undefined ||
      doc.experimental !== undefined)
  ) {
    return "检测到 sing-box 专属配置，不在支持范围内";
  }
  return undefined;
}

function validateProxies(proxies: unknown[]): {
  valid: boolean;
  proxies?: ProxyNode[];
  error?: string;
} {
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return { valid: false, error: "订阅中没有发现有效节点" };
  }

  const validProxies: ProxyNode[] = [];

  for (const [index, p] of proxies.entries()) {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      return {
        valid: false,
        error: `第 ${index + 1} 个节点不是有效对象`,
      };
    }
    const node = p as Record<string, unknown>;
    if (
      typeof node.name !== "string" ||
      !node.name.trim() ||
      typeof node.type !== "string" ||
      !node.type.trim()
    ) {
      return {
        valid: false,
        error: `第 ${index + 1} 个节点缺少有效的 name 或 type`,
      };
    }

    const missing = missingRequiredProxyFields(node);
    if (missing.length > 0) {
      return {
        valid: false,
        error: `节点 "${node.name}" (${node.type}) 缺少或包含无效的必要字段: ${missing.join(", ")}`,
      };
    }
    validProxies.push(node as ProxyNode);
  }

  return { valid: true, proxies: validProxies };
}

const NETWORK_PROXY_TYPES = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "tuic",
  "anytls",
  "mieru",
  "socks5",
  "http",
  "snell",
]);

const REQUIRED_STRING_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ss: ["cipher", "password"],
  ssr: ["cipher", "password", "protocol", "obfs"],
  vmess: ["uuid", "cipher"],
  vless: ["uuid"],
  trojan: ["password"],
  hysteria2: ["password"],
  anytls: ["password"],
  mieru: ["username", "password", "transport"],
  snell: ["psk"],
};

function hasRequiredValue(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function hasValidPort(value: unknown): boolean {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value.trim()))
  ) {
    return false;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hasValidPortRangeList(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.split(/[,/]/).every((part) => {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    return hasValidPort(start) && hasValidPort(end) && start <= end;
  });
}

function hasValidMieruPortRange(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.trim().match(/^(\d+)-(\d+)$/);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return hasValidPort(start) && hasValidPort(end) && start <= end;
}

function missingRequiredProxyFields(node: Record<string, unknown>): string[] {
  const type = String(node.type).toLowerCase();
  const missing: string[] = [];

  if (NETWORK_PROXY_TYPES.has(type)) {
    if (typeof node.server !== "string" || !node.server.trim())
      missing.push("server");

    if (type === "hysteria2") {
      if (typeof node.ports === "string" && node.ports.trim()) {
        if (!hasValidPortRangeList(node.ports)) missing.push("ports");
      } else if (!hasValidPort(node.port)) {
        missing.push("port 或 ports");
      }
    } else if (type === "mieru") {
      const hasPort =
        node.port !== undefined &&
        node.port !== null &&
        String(node.port).trim() !== "" &&
        Number(node.port) !== 0;
      const hasPortRange =
        typeof node["port-range"] === "string" &&
        node["port-range"].trim().length > 0;
      if (hasPort && hasPortRange) {
        missing.push("port/port-range (只能填写一个)");
      } else if (hasPort) {
        if (!hasValidPort(node.port)) missing.push("port");
      } else if (hasPortRange) {
        if (!hasValidMieruPortRange(node["port-range"]))
          missing.push("port-range");
      } else {
        missing.push("port 或 port-range");
      }
    } else if (!hasValidPort(node.port)) {
      missing.push("port");
    }
  }

  for (const field of REQUIRED_STRING_FIELDS[type] || []) {
    if (
      field === "password" || field === "psk"
        ? !hasRequiredValue(node[field])
        : typeof node[field] !== "string" || !node[field].trim()
    ) {
      missing.push(field);
    }
  }

  if (
    type === "hysteria" &&
    !hasRequiredValue(node.auth) &&
    !hasRequiredValue(node["auth-str"])
  ) {
    missing.push("auth 或 auth-str");
  }

  if (type === "tuic") {
    const hasV4Credentials = hasRequiredValue(node.token);
    const hasV5Credentials =
      typeof node.uuid === "string" &&
      node.uuid.trim().length > 0 &&
      hasRequiredValue(node.password);
    if (!hasV4Credentials && !hasV5Credentials) {
      missing.push("token 或 uuid + password");
    }
  }

  return missing;
}

function parseProxyProviders(
  raw: unknown,
): Record<string, ProxyProviderEntry> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, ProxyProviderEntry> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.type !== "string") continue;

    // Normalize exclude-filter: Mihomo accepts string | string[]
    const rawFilter = entry["exclude-filter"];
    let excludeFilter: string[] | undefined;
    if (typeof rawFilter === "string") {
      excludeFilter = [rawFilter];
    } else if (
      Array.isArray(rawFilter) &&
      rawFilter.every((v) => typeof v === "string")
    ) {
      excludeFilter = rawFilter as string[];
    }

    // ...entry first, then normalized fields override
    result[name] = {
      ...entry,
      name,
      type: entry.type,
      url: typeof entry.url === "string" ? entry.url : undefined,
      "exclude-filter": excludeFilter,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function generateProviderYaml(proxies: ProxyNode[]): string {
  const doc = { proxies };
  return yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
}

/**
 * Generate profile.yaml — the full Mihomo configuration for this provider.
 * Preserve the upstream node organization in the runnable profile:
 * - full configs keep their inline proxies and native proxy-providers;
 * - plain proxy lists remain inline proxies in a minimal runnable config.
 * provider.yaml is the separate normalized projection used for distribution.
 */
export function generateProfileYaml(
  proxies: ProxyNode[],
  fullConfig?: Record<string, unknown>,
): string {
  if (fullConfig) {
    const doc = JSON.parse(JSON.stringify(fullConfig)) as Record<
      string,
      unknown
    >;
    doc.proxies = proxies;
    return yaml.dump(doc, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    });
  }

  // A plain proxy list stays inline. Do not invent a synthetic Provider.
  const proxyNames = proxies.map((proxy) => String(proxy.name));
  const doc = {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    proxies,
    "proxy-groups": [
      {
        name: "auto",
        type: "url-test",
        proxies: proxyNames,
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
      },
    ],
    rules: ["MATCH,auto"],
  };
  return yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
}
