const BLOCKED_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
]);

function parseIPv4(ip: string): number | null {
  // Handle decimal, hex, octal formats
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    let num: number;
    if (part.startsWith("0x") || part.startsWith("0X")) {
      num = parseInt(part, 16);
    } else if (part.startsWith("0") && part.length > 1) {
      num = parseInt(part, 8);
    } else {
      num = parseInt(part, 10);
    }
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0;
}

function isIPv4Private(ip: string): boolean {
  const num = parseIPv4(ip);
  if (num === null) return false;
  const a = (num >>> 24) & 0xff;
  const b = (num >>> 16) & 0xff;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IANA protocol assignments)
  if (a === 192 && b === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && ((num >>> 8) & 0xff) === 2) return true;
  // 192.88.99.0/24 (6to4 relay)
  if (a === 192 && b === 88) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && ((num >>> 8) & 0xff) === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && ((num >>> 8) & 0xff) === 113) return true;
  // 224.0.0.0/4 (multicast)
  if ((a & 0xf0) === 224) return true;
  // 240.0.0.0/4 (reserved)
  if ((a & 0xf0) === 240) return true;
  // 255.255.255.255 (broadcast)
  if (num === 0xffffffff) return true;

  return false;
}

function normalizeIPv6(addr: string): string {
  // Remove brackets
  let ip = addr.replace(/[[\]]/g, "");

  // Handle IPv4-mapped IPv6: ::ffff:192.168.1.1 or ::ffff:c0a8:0101
  const v4MappedMatch = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch?.[1]) {
    return v4MappedMatch[1];
  }

  // Handle ::ffff: hex form
  const v4HexMatch = ip.match(/::ffff:([0-9a-f:]+)$/i);
  if (v4HexMatch?.[1]) {
    const hexParts = v4HexMatch[1].split(":");
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0]!, 16);
      const low = parseInt(hexParts[1]!, 16);
      if (!isNaN(high) && !isNaN(low)) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        return `${a}.${b}.${c}.${d}`;
      }
    }
  }

  return ip.toLowerCase();
}

// Expand IPv6 :: shorthand to full 8-group form for prefix matching
function expandIPv6(ip: string): string | null {
  // Already full form (8 groups)
  const parts = ip.split(":");
  if (parts.length === 8) return ip;

  // Find the :: position
  const doubleColonIndex = ip.indexOf("::");
  if (doubleColonIndex === -1) return null;

  const before = ip.substring(0, doubleColonIndex).split(":").filter(Boolean);
  const after = ip
    .substring(doubleColonIndex + 2)
    .split(":")
    .filter(Boolean);
  const missing = 8 - before.length - after.length;
  const middle = Array(missing).fill("0000");
  const full = [...before, ...middle, ...after];
  return full.map((g) => g.padStart(4, "0")).join(":");
}

function isIPv6Private(addr: string): boolean {
  const ip = normalizeIPv6(addr);

  // If it resolved to IPv4, check IPv4 rules
  if (ip.includes(".")) {
    return isIPv4Private(ip);
  }

  // ::1 (loopback)
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;

  // :: (unspecified)
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;

  // fc00::/7 (unique local address): first byte fc or fd
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;

  // fe80::/10 (link-local): first byte fe, second byte 80-bf (10xxxxxx)
  const expanded = expandIPv6(ip);
  if (expanded) {
    const firstTwo = expanded.substring(0, 4); // e.g. "fe80"
    const firstByte = parseInt(firstTwo.substring(0, 2), 16);
    const secondByte = parseInt(firstTwo.substring(2, 4), 16);
    if (firstByte === 0xfe) {
      // fe80::/10 = fe[80-bf]
      if (secondByte >= 0x80 && secondByte <= 0xbf) return true;
      // fec0::/10 = fe[c0-ff]
      if (secondByte >= 0xc0 && secondByte <= 0xff) return true;
    }
  }

  // ff00::/8 (multicast)
  if (ip.startsWith("ff")) return true;

  return false;
}

function isReservedAddress(hostname: string): boolean {
  const clean = hostname.replace(/[[\]]/g, "").toLowerCase();

  if (BLOCKED_HOSTS.has(clean)) return true;
  if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;
  if (clean === "::" || clean === "0:0:0:0:0:0:0:0") return true;

  // Try parsing as IPv4
  if (clean.includes(".") && !clean.includes(":")) {
    return isIPv4Private(clean);
  }

  // Try parsing as IPv6
  if (clean.includes(":")) {
    return isIPv6Private(clean);
  }

  // Cloud metadata endpoints
  if (clean === "169.254.169.254") return true;

  return false;
}

export function validateUrl(urlString: string): {
  valid: boolean;
  error?: string;
} {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "URL 格式无效" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { valid: false, error: "仅支持 http 和 https 协议" };
  }

  if (isReservedAddress(url.hostname)) {
    return { valid: false, error: "禁止访问私有地址、localhost 和保留地址" };
  }

  return { valid: true };
}

export { isReservedAddress, isIPv4Private, isIPv6Private, normalizeIPv6 };

export function validateSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9\-]*[a-z0-9])?$/.test(slug) && slug.length <= 63;
}
