import type { Env } from "../types.ts";
import { verifyToken } from "./tokens.ts";
import { verifyPassword } from "./password.ts";

const SESSION_COOKIE = "__Host-msv_admin_session";
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4096;

interface SessionPayload {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
}

interface LoginBody {
  username: string;
  password: string;
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

async function signSessionPayload(
  encodedPayload: string,
  secret: string,
): Promise<string> {
  const blockSize = 64;
  let key = new TextEncoder().encode(secret);
  if (key.length > blockSize) {
    key = new Uint8Array(await crypto.subtle.digest("SHA-256", key));
  }
  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let index = 0; index < blockSize; index++) {
    const byte = key[index] ?? 0;
    innerPad[index] = byte ^ 0x36;
    outerPad[index] = byte ^ 0x5c;
  }
  const payload = new TextEncoder().encode(encodedPayload);
  const innerInput = new Uint8Array(innerPad.length + payload.length);
  innerInput.set(innerPad);
  innerInput.set(payload, innerPad.length);
  const innerHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", innerInput),
  );
  const outerInput = new Uint8Array(outerPad.length + innerHash.length);
  outerInput.set(outerPad);
  outerInput.set(innerHash, outerPad.length);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", outerInput)),
  );
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.v === 1 &&
    typeof payload.sub === "string" &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp)
  );
}

function isSessionConfigurationValid(env: Env): boolean {
  return (
    typeof env.ADMIN_USERNAME === "string" &&
    env.ADMIN_USERNAME.length > 0 &&
    typeof env.ADMIN_PASSWORD_HASH === "string" &&
    env.ADMIN_PASSWORD_HASH.length > 0 &&
    typeof env.SESSION_SECRET === "string" &&
    new TextEncoder().encode(env.SESSION_SECRET).length >= 32
  );
}

async function readLoginBody(request: Request): Promise<LoginBody | null> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_LOGIN_BODY_BYTES
  ) {
    return null;
  }

  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (typeof value !== "object" || value === null) return null;
    const body = value as Record<string, unknown>;
    if (
      typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      body.username.length === 0 ||
      body.username.length > 128 ||
      body.password.length === 0 ||
      body.password.length > 1024
    ) {
      return null;
    }
    return { username: body.username, password: body.password };
  } catch {
    return null;
  }
}

async function issueSessionCookie(
  env: Env,
  nowSeconds: number,
): Promise<string> {
  const payload: SessionPayload = {
    v: 1,
    sub: env.ADMIN_USERNAME!,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_LIFETIME_SECONDS,
  };
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signSessionPayload(
    encodedPayload,
    env.SESSION_SECRET!,
  );
  return `${SESSION_COOKIE}=${encodedPayload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

async function verifySessionToken(
  token: string,
  env: Env,
  nowSeconds: number,
): Promise<boolean> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return false;
  const encodedPayload = token.slice(0, separator);
  const signature = decodeBase64Url(token.slice(separator + 1));
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!signature || !payloadBytes) return false;
  const expectedSignature = decodeBase64Url(
    await signSessionPayload(encodedPayload, env.SESSION_SECRET!),
  );
  if (!expectedSignature || signature.length !== expectedSignature.length) {
    return false;
  }
  let signatureDifference = 0;
  for (let index = 0; index < signature.length; index++) {
    signatureDifference |= signature[index]! ^ expectedSignature[index]!;
  }
  const validSignature = signatureDifference === 0;
  if (!validSignature) return false;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    return (
      isSessionPayload(payload) &&
      payload.sub === env.ADMIN_USERNAME &&
      payload.iat <= nowSeconds + 60 &&
      payload.exp > nowSeconds &&
      payload.exp - payload.iat === SESSION_LIFETIME_SECONDS
    );
  } catch {
    return false;
  }
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

export async function hasValidAdminSession(
  request: Request,
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!isSessionConfigurationValid(env)) return false;
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !hasSameOrigin(request)
  ) {
    return false;
  }
  const token = parseCookies(request).get(SESSION_COOKIE);
  return token ? verifySessionToken(token, env, nowSeconds) : false;
}

export async function handleAdminAuthRoute(
  request: Request,
  env: Env,
  path: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Response | null> {
  if (path === "/api/auth/login") {
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
        405,
        {
          Allow: "POST",
        },
      );
    }
    if (!hasSameOrigin(request)) {
      return jsonResponse({ ok: false, error: { code: "FORBIDDEN" } }, 403);
    }
    if (!isSessionConfigurationValid(env)) {
      return jsonResponse(
        {
          ok: false,
          error: { code: "AUTH_NOT_CONFIGURED", message: "登录服务尚未配置" },
        },
        503,
      );
    }
    const body = await readLoginBody(request);
    if (!body) {
      return jsonResponse(
        {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "登录信息格式无效" },
        },
        400,
      );
    }
    if (env.LOGIN_RATE_LIMITER) {
      let success = false;
      try {
        // Per-client key: a fixed key would let any anonymous caller exhaust the
        // budget and lock the real admin out indefinitely.
        const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
        ({ success } = await env.LOGIN_RATE_LIMITER.limit({
          key: `admin-login:${clientIp}`,
        }));
      } catch (error) {
        console.error("Admin login rate limiter failed", error);
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "AUTH_TEMPORARILY_UNAVAILABLE",
              message: "登录服务暂时不可用，请稍后再试",
            },
          },
          503,
        );
      }
      if (!success) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "尝试次数过多，请稍后再试",
            },
          },
          429,
          { "Retry-After": "60" },
        );
      }
    }
    const usernameMatches = verifyToken(body.username, env.ADMIN_USERNAME!);
    let passwordMatches = false;
    try {
      passwordMatches = await verifyPassword(
        body.password,
        env.ADMIN_PASSWORD_HASH!,
      );
    } catch (error) {
      console.error("Admin password verification failed", error);
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "AUTH_TEMPORARILY_UNAVAILABLE",
            message: "登录服务暂时不可用，请稍后再试",
          },
        },
        503,
      );
    }
    if (!usernameMatches || !passwordMatches) {
      return jsonResponse(
        {
          ok: false,
          error: { code: "INVALID_CREDENTIALS", message: "用户名或密码不正确" },
        },
        401,
      );
    }
    try {
      return jsonResponse(
        { ok: true, data: { expiresIn: SESSION_LIFETIME_SECONDS } },
        200,
        { "Set-Cookie": await issueSessionCookie(env, nowSeconds) },
      );
    } catch (error) {
      console.error("Admin session signing failed", error);
      return jsonResponse(
        {
          ok: false,
          error: {
            code: "AUTH_TEMPORARILY_UNAVAILABLE",
            message: "登录服务暂时不可用，请稍后再试",
          },
        },
        503,
      );
    }
  }

  if (path === "/api/auth/session") {
    if (request.method !== "GET") {
      return jsonResponse(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
        405,
        {
          Allow: "GET",
        },
      );
    }
    return jsonResponse({
      ok: true,
      data: {
        authenticated: await hasValidAdminSession(request, env, nowSeconds),
      },
    });
  }

  if (path === "/api/auth/logout") {
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
        405,
        {
          Allow: "POST",
        },
      );
    }
    if (!hasSameOrigin(request)) {
      return jsonResponse({ ok: false, error: { code: "FORBIDDEN" } }, 403);
    }
    return jsonResponse({ ok: true }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  return null;
}
