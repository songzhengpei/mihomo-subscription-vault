import type { ProxyNode } from "../types.ts";

const URI_SCHEMES = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "hy2",
  "tuic",
  "anytls",
  "mierus",
  "socks",
  "socks5",
  "http",
  "https",
  "snell",
]);

export interface ConvertedSubscription {
  proxies: ProxyNode[];
  sourceType: "uri-list" | "sip008";
}

function decodeBase64(value: string): string | null {
  const compact = value
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (
    !compact ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    compact.length % 4 === 1
  ) {
    return null;
  }
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

export function decodeSubscriptionLayer(value: string): string | null {
  const trimmed = value.replace(/^\uFEFF/, "").trim();
  if (/%[0-9a-f]{2}/i.test(trimmed)) {
    try {
      const decoded = decodeURIComponent(trimmed);
      if (decoded !== trimmed) return decoded;
    } catch {
      // A URI parser will report malformed percent encoding when applicable.
    }
  }
  return decodeBase64(trimmed);
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("URI 包含无效的百分号编码");
  }
}

function portOf(url: URL): number {
  const port = Number(
    url.port ||
      (url.protocol === "https:"
        ? "443"
        : url.protocol === "http:"
          ? "80"
          : ""),
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("URI 缺少有效端口");
  }
  return port;
}

function nameOf(url: URL, type: string): string {
  const fragment = url.hash ? decodeComponent(url.hash.slice(1)).trim() : "";
  const queryName = stringParam(url.searchParams, "remarks", "remark", "tag");
  return fragment || queryName || `${type}-${url.hostname}:${portOf(url)}`;
}

function boolParam(
  params: URLSearchParams,
  ...names: string[]
): boolean | undefined {
  for (const name of names) {
    const value = params.get(name)?.toLowerCase();
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
  }
  return undefined;
}

function stringParam(
  params: URLSearchParams,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null && value !== "") return value;
  }
  return undefined;
}

function commonTransport(node: ProxyNode, params: URLSearchParams): void {
  const rawNetwork = stringParam(params, "type", "network");
  const obfs = stringParam(params, "obfs")?.toLowerCase();
  const network =
    rawNetwork?.toLowerCase() ||
    (obfs === "websocket" || obfs === "ws" ? "ws" : undefined);
  if (network && network !== "tcp") node.network = network;

  const security = stringParam(params, "security")?.toLowerCase();
  const tls =
    security === "tls" ||
    security === "reality" ||
    boolParam(params, "tls") === true;
  if (tls) node.tls = true;
  const servername = stringParam(params, "sni", "servername", "peer");
  if (servername) node.servername = servername;
  const skip = boolParam(
    params,
    "allowInsecure",
    "insecure",
    "skip-cert-verify",
  );
  if (skip !== undefined) node["skip-cert-verify"] = skip;
  const alpn = stringParam(params, "alpn");
  if (alpn) node.alpn = alpn.split(",").filter(Boolean);

  if (network === "ws") {
    const path = stringParam(params, "path") || "/";
    const host = stringParam(params, "host", "obfsParam", "obfs-param");
    node["ws-opts"] = { path, ...(host ? { headers: { Host: host } } : {}) };
  } else if (network === "grpc") {
    const serviceName = stringParam(params, "serviceName", "service-name");
    node["grpc-opts"] = { "grpc-service-name": serviceName || "" };
  } else if (network === "http" || network === "h2") {
    const path = stringParam(params, "path");
    const host = stringParam(params, "host");
    node["http-opts"] = {
      ...(path ? { path: [path] } : {}),
      ...(host ? { headers: { Host: [host] } } : {}),
    };
  }

  if (security === "reality") {
    const publicKey = stringParam(params, "pbk", "public-key");
    const shortId = stringParam(params, "sid", "short-id");
    node["reality-opts"] = {
      ...(publicKey ? { "public-key": publicKey } : {}),
      ...(shortId ? { "short-id": shortId } : {}),
    };
  }
  const fingerprint = stringParam(params, "fp", "client-fingerprint");
  if (fingerprint) node["client-fingerprint"] = fingerprint;
}

function parsePluginOptions(value: string): Record<string, unknown> {
  return Object.fromEntries(
    value
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key!, rest.length ? rest.join("=") : true];
      }),
  );
}

function normalizeSsdPlugin(
  plugin: string,
  pluginOptions: string,
): {
  plugin: string;
  options?: Record<string, unknown>;
} {
  const originalPlugin = plugin.trim();
  const pluginAlias = originalPlugin.toLowerCase();
  const normalizedPlugin =
    pluginAlias === "simple-obfs"
      ? "obfs"
      : pluginAlias === "v2ray"
        ? "v2ray-plugin"
        : originalPlugin;
  if (!pluginOptions) return { plugin: normalizedPlugin };

  const options = parsePluginOptions(pluginOptions);
  if (normalizedPlugin === "obfs" || normalizedPlugin === "v2ray-plugin") {
    if (options.mode === undefined && options.obfs !== undefined)
      options.mode = options.obfs;
    if (options.host === undefined && options["obfs-host"] !== undefined)
      options.host = options["obfs-host"];
    delete options.obfs;
    delete options["obfs-host"];
  }

  return {
    plugin: normalizedPlugin,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function parseSs(raw: string): ProxyNode {
  let normalized = raw;
  const body = raw.slice(5);
  const hashIndex = body.indexOf("#");
  const queryIndex = body.indexOf("?");
  const suffixAt = [hashIndex, queryIndex]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b)[0];
  const authority = suffixAt === undefined ? body : body.slice(0, suffixAt);
  if (!authority.includes("@")) {
    const decoded = decodeBase64(authority);
    if (!decoded || !decoded.includes("@")) throw new Error("SS URI 编码无效");
    normalized = `ss://${decoded}${suffixAt === undefined ? "" : body.slice(suffixAt)}`;
  }
  const url = new URL(normalized);
  let cipher = decodeComponent(url.username);
  let password = decodeComponent(url.password);
  if (!password) {
    const decoded = decodeBase64(cipher);
    if (!decoded?.includes(":")) throw new Error("SS URI 认证信息无效");
    [cipher, password] = [
      decoded.slice(0, decoded.indexOf(":")),
      decoded.slice(decoded.indexOf(":") + 1),
    ];
  }
  if (!cipher || !password) throw new Error("SS URI 缺少加密方式或密码");
  const node: ProxyNode = {
    name: nameOf(url, "ss"),
    type: "ss",
    server: url.hostname,
    port: portOf(url),
    cipher,
    password,
  };
  const plugin = url.searchParams.get("plugin");
  if (plugin) {
    const [pluginName, ...options] = plugin.split(";");
    node.plugin = pluginName;
    if (options.length)
      node["plugin-opts"] = parsePluginOptions(options.join(";"));
  }
  return node;
}

function parseSsr(raw: string): ProxyNode {
  const decoded = decodeBase64(raw.slice(6));
  if (!decoded) throw new Error("SSR URI 编码无效");
  const [main, query = ""] = decoded.split("/?", 2);
  const parts = main!.split(":");
  if (parts.length < 6) throw new Error("SSR URI 字段不完整");
  const [server, portText, protocol, cipher, obfs, password64] = parts;
  const password = decodeBase64(password64!);
  const port = Number(portText);
  if (
    !server ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("SSR URI 服务器或密码无效");
  const params = new URLSearchParams(query);
  const decodeOptional = (name: string) => {
    const value = params.get(name);
    return value ? decodeBase64(value) || undefined : undefined;
  };
  return {
    name: decodeOptional("remarks") || `ssr-${server}:${port}`,
    type: "ssr",
    server,
    port,
    cipher,
    password,
    protocol,
    obfs,
    ...(decodeOptional("protoparam")
      ? { "protocol-param": decodeOptional("protoparam") }
      : {}),
    ...(decodeOptional("obfsparam")
      ? { "obfs-param": decodeOptional("obfsparam") }
      : {}),
  };
}

function parseVmessJson(decoded: string): ProxyNode {
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new Error("VMess URI JSON 无效");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("VMess URI 内容无效");
  const doc = value as Record<string, unknown>;
  const server = typeof doc.add === "string" ? doc.add : "";
  const uuid = typeof doc.id === "string" ? doc.id : "";
  const port = Number(doc.port);
  if (!server || !uuid || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("VMess URI 字段不完整");
  const network = typeof doc.net === "string" ? doc.net : "tcp";
  const node: ProxyNode = {
    name:
      typeof doc.ps === "string" && doc.ps ? doc.ps : `vmess-${server}:${port}`,
    type: "vmess",
    server,
    port,
    uuid,
    alterId: Number(doc.aid) || 0,
    cipher: typeof doc.scy === "string" ? doc.scy : "auto",
    ...(network !== "tcp" ? { network } : {}),
  };
  if (doc.tls === "tls") node.tls = true;
  if (typeof doc.sni === "string" && doc.sni) node.servername = doc.sni;
  if (network === "ws")
    node["ws-opts"] = {
      path: typeof doc.path === "string" && doc.path ? doc.path : "/",
      ...(typeof doc.host === "string" && doc.host
        ? { headers: { Host: doc.host } }
        : {}),
    };
  if (network === "grpc")
    node["grpc-opts"] = {
      "grpc-service-name": typeof doc.path === "string" ? doc.path : "",
    };
  return node;
}

function parseVmessUrl(raw: string): ProxyNode {
  const url = new URL(raw);
  const username = decodeComponent(url.username);
  const password = decodeComponent(url.password);
  const uuid = password || username;
  if (!uuid) throw new Error("VMess URI 缺少 UUID");

  const alterIdText = stringParam(url.searchParams, "alterId", "aid");
  const alterId = alterIdText === undefined ? 0 : Number(alterIdText);
  if (!Number.isInteger(alterId) || alterId < 0)
    throw new Error("VMess URI alterId 无效");

  const node: ProxyNode = {
    name: nameOf(url, "vmess"),
    type: "vmess",
    server: url.hostname,
    port: portOf(url),
    uuid,
    alterId,
    cipher:
      stringParam(url.searchParams, "encryption", "cipher") ||
      (password ? username : "") ||
      "auto",
  };
  commonTransport(node, url.searchParams);
  return node;
}

function parseVmess(raw: string): ProxyNode {
  const decoded = decodeBase64(raw.slice(8));
  if (decoded) {
    try {
      return parseVmessJson(decoded);
    } catch (error) {
      if (!raw.slice(8).includes("@")) throw error;
    }
  }
  try {
    return parseVmessUrl(raw);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("VMess URI"))
      throw error;
    throw new Error("VMess URI 编码或 URL 格式无效");
  }
}

function parseUrlNode(raw: string): ProxyNode {
  const url = new URL(raw);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const aliases: Record<string, string> = {
    hy2: "hysteria2",
    socks: "socks5",
    https: "http",
    mierus: "mieru",
  };
  const type = aliases[scheme] || scheme;
  const node: ProxyNode = {
    name: nameOf(url, type),
    type,
    server: url.hostname,
    port: portOf(url),
  };
  const username = decodeComponent(url.username);
  const password = decodeComponent(url.password);

  if (type === "vless" || type === "vmess") {
    if (!username) throw new Error(`${type.toUpperCase()} URI 缺少 UUID`);
    node.uuid = username;
    if (url.searchParams.get("flow")) node.flow = url.searchParams.get("flow")!;
    commonTransport(node, url.searchParams);
  } else if (type === "trojan" || type === "hysteria2" || type === "anytls") {
    const secret = username || password;
    if (!secret) throw new Error(`${type} URI 缺少密码`);
    node.password = secret;
    commonTransport(node, url.searchParams);
    if (type === "hysteria2") {
      const obfs = stringParam(url.searchParams, "obfs");
      const obfsPassword = stringParam(
        url.searchParams,
        "obfs-password",
        "obfsPassword",
      );
      if (obfs) node.obfs = obfs;
      if (obfsPassword) node["obfs-password"] = obfsPassword;
    }
  } else if (type === "hysteria") {
    const auth =
      username || password || stringParam(url.searchParams, "auth", "auth-str");
    if (auth) node["auth-str"] = auth;
    for (const [source, target] of [
      ["up", "up"],
      ["down", "down"],
      ["protocol", "protocol"],
      ["obfs", "obfs"],
    ] as const) {
      const value = url.searchParams.get(source);
      if (value) node[target] = value;
    }
    commonTransport(node, url.searchParams);
  } else if (type === "tuic") {
    if (!username || !password) throw new Error("TUIC URI 缺少 UUID 或密码");
    node.uuid = username;
    node.password = password;
    const congestion = stringParam(
      url.searchParams,
      "congestion_control",
      "congestion-controller",
    );
    const relay = stringParam(
      url.searchParams,
      "udp_relay_mode",
      "udp-relay-mode",
    );
    if (congestion) node["congestion-controller"] = congestion;
    if (relay) node["udp-relay-mode"] = relay;
    commonTransport(node, url.searchParams);
  } else if (type === "mieru") {
    if (!username || !password) throw new Error("Mieru URI 缺少用户名或密码");
    node.username = username;
    node.password = password;
    const transport = stringParam(url.searchParams, "transport");
    if (transport) node.transport = transport;
  } else if (type === "snell") {
    const psk =
      username || password || stringParam(url.searchParams, "psk", "password");
    if (!psk) throw new Error("Snell URI 缺少 PSK");
    node.psk = psk;
    const versionText = stringParam(url.searchParams, "version");
    if (versionText !== undefined) {
      const version = Number(versionText);
      if (!Number.isInteger(version) || version < 1 || version > 5)
        throw new Error("Snell URI version 无效");
      node.version = version;
    }
    const obfs = stringParam(url.searchParams, "obfs", "obfs-mode");
    const obfsHost = stringParam(
      url.searchParams,
      "obfs-host",
      "obfsHost",
      "host",
    );
    if (obfs || obfsHost) {
      node["obfs-opts"] = {
        ...(obfs ? { mode: obfs } : {}),
        ...(obfsHost ? { host: obfsHost } : {}),
      };
    }
  } else if (type === "socks5" || type === "http") {
    if (username) node.username = username;
    if (password) node.password = password;
    const tls =
      scheme === "https" || boolParam(url.searchParams, "tls") === true;
    if (tls) node.tls = true;
    const skip = boolParam(url.searchParams, "skip-cert-verify", "insecure");
    if (skip !== undefined) node["skip-cert-verify"] = skip;
  } else {
    throw new Error(`不支持的 URI 协议: ${scheme}`);
  }
  return node;
}

function parseUri(raw: string): ProxyNode {
  const match = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match || !URI_SCHEMES.has(match[1]!.toLowerCase()))
    throw new Error("不是支持的代理 URI");
  const scheme = match[1]!.toLowerCase();
  if (scheme === "ss") return parseSs(raw);
  if (scheme === "ssr") return parseSsr(raw);
  if (scheme === "vmess") return parseVmess(raw);
  return parseUrlNode(raw);
}

function parseUriList(text: string): ProxyNode[] | null {
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (
    lines.length === 0 ||
    !lines.some((line) => /^[a-z][a-z0-9+.-]*:\/\//i.test(line))
  )
    return null;
  return lines.map((line, index) => {
    try {
      return parseUri(line);
    } catch (error) {
      throw new Error(
        `第 ${index + 1} 个代理链接无效: ${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  });
}

function parseSip008(value: unknown): ProxyNode[] | null {
  const entries = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Record<string, unknown>).servers)
      ? ((value as Record<string, unknown>).servers as unknown[])
      : null;
  if (!entries) return null;
  const proxies = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`SIP008 第 ${index + 1} 个服务器无效`);
    const item = entry as Record<string, unknown>;
    const server = typeof item.server === "string" ? item.server : "";
    const port = Number(item.server_port);
    const cipher = typeof item.method === "string" ? item.method : "";
    const password = typeof item.password === "string" ? item.password : "";
    if (
      !server ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !cipher ||
      !password
    )
      throw new Error(`SIP008 第 ${index + 1} 个服务器字段不完整`);
    const node: ProxyNode = {
      name:
        typeof item.remarks === "string" && item.remarks
          ? item.remarks
          : `ss-${server}:${port}`,
      type: "ss",
      server,
      port,
      cipher,
      password,
    };
    if (typeof item.plugin === "string" && item.plugin)
      node.plugin = item.plugin;
    if (typeof item.plugin_opts === "string" && item.plugin_opts)
      node["plugin-opts"] = parsePluginOptions(item.plugin_opts);
    return node;
  });
  if (proxies.length === 0) throw new Error("SIP008 订阅中没有服务器");
  return proxies;
}

function parseSsd(text: string): ProxyNode[] | null {
  const match = text.trim().match(/^ssd:\/\/([A-Za-z0-9+/_=-]+)$/i);
  if (!match) return null;
  const decoded = decodeBase64(match[1]!);
  if (!decoded) throw new Error("SSD 订阅 Base64 编码无效");

  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new Error("SSD 订阅 JSON 无效");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SSD 订阅内容无效");

  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.servers) || doc.servers.length === 0)
    throw new Error("SSD 订阅中没有服务器");

  const airport =
    typeof doc.airport === "string" && doc.airport ? doc.airport : "SSD";
  const proxies = doc.servers.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`SSD 第 ${index + 1} 个服务器无效`);
    const item = entry as Record<string, unknown>;
    const server = typeof item.server === "string" ? item.server : "";
    const port = Number(item.port ?? doc.port);
    const cipher =
      typeof item.encryption === "string"
        ? item.encryption
        : typeof doc.encryption === "string"
          ? doc.encryption
          : "";
    const password =
      typeof item.password === "string"
        ? item.password
        : typeof doc.password === "string"
          ? doc.password
          : "";
    if (
      !server ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !cipher ||
      !password
    )
      throw new Error(`SSD 第 ${index + 1} 个服务器字段不完整`);

    const node: ProxyNode = {
      name:
        typeof item.remarks === "string" && item.remarks
          ? item.remarks
          : `${airport}-${index + 1}`,
      type: "ss",
      server,
      port,
      cipher,
      password,
    };
    const plugin =
      typeof item.plugin === "string"
        ? item.plugin
        : typeof doc.plugin === "string"
          ? doc.plugin
          : "";
    const pluginOptions =
      typeof item.plugin_options === "string"
        ? item.plugin_options
        : typeof doc.plugin_options === "string"
          ? doc.plugin_options
          : "";
    if (plugin) {
      const normalized = normalizeSsdPlugin(plugin, pluginOptions);
      node.plugin = normalized.plugin;
      if (normalized.options) node["plugin-opts"] = normalized.options;
    }
    return node;
  });
  return proxies;
}

export function convertSubscriptionContent(
  text: string,
  parsedDocument?: unknown,
): ConvertedSubscription | null {
  const sip008 = parseSip008(parsedDocument);
  if (sip008) return { proxies: sip008, sourceType: "sip008" };

  const trimmed = text.trim();
  const ssd = parseSsd(trimmed);
  if (ssd) return { proxies: ssd, sourceType: "uri-list" };

  const direct = parseUriList(trimmed);
  if (direct) return { proxies: direct, sourceType: "uri-list" };

  const decoded = decodeBase64(text.trim());
  if (!decoded) return null;
  const encodedList = parseUriList(decoded.trim());
  if (!encodedList) return null;
  return { proxies: encodedList, sourceType: "uri-list" };
}
