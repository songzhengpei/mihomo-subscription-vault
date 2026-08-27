import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 4096;
const RESPONSE_HEADERS = [
  "content-type",
  "subscription-userinfo",
  "profile-update-interval",
  "profile-web-page-url",
];

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIPv6(address) {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return { mapped: mapped[1] };

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const before = halves[0] ? halves[0].split(":") : [];
  const after = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && before.length !== 8) return null;
  const missing = 8 - before.length - after.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...before, ...Array(missing).fill("0"), ...after].map(
    (group) => Number.parseInt(group || "0", 16),
  );
  if (
    groups.length !== 8 ||
    groups.some(
      (group) => !Number.isInteger(group) || group < 0 || group > 0xffff,
    )
  ) {
    return null;
  }
  return { groups };
}

function isPrivateIPv6(address) {
  const parsed = expandIPv6(address);
  if (!parsed) return true;
  if ("mapped" in parsed) return isPrivateIPv4(parsed.mapped);
  const groups = parsed.groups;
  const first = groups[0];
  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  return (
    isUnspecified ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
}

export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

function isFakeIpAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

async function resolveWithDoh(hostname, fetchImpl = fetch) {
  const addresses = [];
  for (const type of ["A", "AAAA"]) {
    const endpoint = new URL("https://dns.google/resolve");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetchImpl(endpoint, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("DNS_LOOKUP");
    const result = await response.json();
    if (result.Status !== 0 && result.Status !== 3)
      throw new Error("DNS_LOOKUP");
    for (const answer of result.Answer || []) {
      if (
        (answer.type === 1 || answer.type === 28) &&
        typeof answer.data === "string"
      ) {
        addresses.push({
          address: answer.data,
          family: answer.type === 1 ? 4 : 6,
        });
      }
    }
  }
  return addresses;
}

export async function resolvePublicAddresses(
  hostname,
  { lookupImpl = lookup, fetchImpl = fetch } = {},
) {
  const localAddresses = await lookupImpl(hostname, {
    all: true,
    verbatim: true,
  });
  if (
    localAddresses.length > 0 &&
    localAddresses.every(({ address }) => isFakeIpAddress(address))
  ) {
    return resolveWithDoh(hostname, fetchImpl);
  }
  return localAddresses;
}

export async function validateRemoteUrl(
  urlString,
  resolver = resolvePublicAddresses,
) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("URL_FORMAT");
  }
  if (url.protocol !== "https:") throw new Error("URL_PROTOCOL");
  if (url.username || url.password) throw new Error("URL_CREDENTIALS");
  if (url.port && url.port !== "443") throw new Error("URL_PORT");

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("URL_PRIVATE");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("URL_PRIVATE");
  }
  return url;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function normalizeUserAgent(value) {
  const userAgent =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "clash-verge/v2.4.5";
  if (userAgent.length > 256 || /[\r\n\0]/.test(userAgent)) {
    throw new Error("USER_AGENT");
  }
  return userAgent;
}

async function readResponseBody(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new Error("RESPONSE_BODY");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchRemoteSubscription(
  input,
  { fetchImpl = fetch, resolver = resolvePublicAddresses } = {},
) {
  const maxBytes = boundedInteger(
    input.maxBytes,
    DEFAULT_MAX_BYTES,
    1024,
    20 * 1024 * 1024,
  );
  const maxRedirects = boundedInteger(
    input.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    0,
    10,
  );
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1000,
    60_000,
  );
  const userAgent = normalizeUserAgent(input.userAgent);
  let currentUrl = await validateRemoteUrl(input.url, resolver);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/yaml, application/yaml, application/json, text/plain, */*",
        "Accept-Encoding": "gzip, br",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirectCount >= maxRedirects) throw new Error("REDIRECT_LIMIT");
      currentUrl = await validateRemoteUrl(
        new URL(location, currentUrl).toString(),
        resolver,
      );
      continue;
    }

    return {
      status: response.status,
      finalHost: currentUrl.hostname,
      headers: response.headers,
      body: await readResponseBody(response, maxBytes),
    };
  }
}

async function readJsonRequest(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || typeof parsed.url !== "string") {
    throw new Error("REQUEST_BODY");
  }
  return parsed;
}

export function createRelayServer(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/fetch") {
      response.writeHead(404);
      response.end();
      return;
    }

    try {
      const input = await readJsonRequest(request);
      const result = await fetchRemoteSubscription(input, options);
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(result.body.byteLength),
        "X-Vault-Relay": "1",
        "X-Vault-Upstream-Host": result.finalHost,
      };
      for (const name of RESPONSE_HEADERS) {
        const value = result.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(result.status, headers);
      response.end(result.body);
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : error instanceof DOMException && error.name === "TimeoutError"
            ? "TIMEOUT"
            : "FETCH_FAILED";
      response.writeHead(502, {
        "Content-Type": "application/json",
        "X-Vault-Relay-Error": code,
      });
      response.end(JSON.stringify({ ok: false, error: code }));
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const host = process.env.RELAY_HOST || DEFAULT_HOST;
  const port = boundedInteger(process.env.RELAY_PORT, DEFAULT_PORT, 1, 65_535);
  const server = createRelayServer();
  server.listen(port, host, () => {
    console.log(`upstream-relay:listening host=${host} port=${port}`);
  });
}
