import { describe, expect, it } from "vitest";
import {
  handleAdminAuthRoute,
  hasValidAdminSession,
} from "../src/security/admin-session.ts";
import type { Env } from "../src/types.ts";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function passwordHash(password: string): Promise<string> {
  const salt = new TextEncoder().encode("0123456789abcdef");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    material,
    256,
  );
  return `pbkdf2-sha256$100000$${base64Url(salt)}$${base64Url(new Uint8Array(derived))}`;
}

async function makeEnv(
  password = "correct horse battery staple",
): Promise<Env> {
  return {
    ADMIN_USERNAME: "manu",
    ADMIN_PASSWORD_HASH: await passwordHash(password),
    SESSION_SECRET: "a-session-secret-with-at-least-32-bytes",
    ADMIN_TOKEN: "legacy-admin-token",
    DOWNLOAD_TOKEN: "unchanged-download-token",
  } as Env;
}

function loginRequest(
  username: string,
  password: string,
  origin?: string,
): Request {
  return new Request("https://vault.example/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ username, password }),
  });
}

describe("admin password session", () => {
  it("logs in and authenticates a signed browser-session cookie", async () => {
    const env = await makeEnv();
    const response = await handleAdminAuthRoute(
      loginRequest("manu", "correct horse battery staple"),
      env,
      "/api/auth/login",
      1_000,
    );

    expect(response?.status).toBe(200);
    const setCookie = response!.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("__Host-msv_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Max-Age");

    const cookie = setCookie.split(";", 1)[0]!;
    const request = new Request("https://vault.example/api/providers", {
      headers: { Cookie: cookie },
    });
    expect(await hasValidAdminSession(request, env, 1_001)).toBe(true);
    expect(await hasValidAdminSession(request, env, 1_000 + 8 * 60 * 60)).toBe(
      false,
    );
  });

  it("returns the same generic error for an invalid username or password", async () => {
    const env = await makeEnv();
    const wrongUsername = await handleAdminAuthRoute(
      loginRequest("someone", "correct horse battery staple"),
      env,
      "/api/auth/login",
    );
    const wrongPassword = await handleAdminAuthRoute(
      loginRequest("manu", "wrong password"),
      env,
      "/api/auth/login",
    );

    expect(wrongUsername?.status).toBe(401);
    expect(wrongPassword?.status).toBe(401);
    expect(await wrongUsername?.json()).toEqual(await wrongPassword?.json());
  });

  it("rejects cross-origin login and tampered cookies", async () => {
    const env = await makeEnv();
    const crossOrigin = await handleAdminAuthRoute(
      loginRequest(
        "manu",
        "correct horse battery staple",
        "https://evil.example",
      ),
      env,
      "/api/auth/login",
    );
    expect(crossOrigin?.status).toBe(403);

    const request = new Request("https://vault.example/api/providers", {
      headers: { Cookie: "__Host-msv_admin_session=payload.invalid" },
    });
    expect(await hasValidAdminSession(request, env)).toBe(false);
  });

  it("rate limits repeated login attempts", async () => {
    const env = await makeEnv();
    env.LOGIN_RATE_LIMITER = {
      limit: async () => ({ success: false }),
    } as RateLimit;
    const response = await handleAdminAuthRoute(
      loginRequest("manu", "correct horse battery staple"),
      env,
      "/api/auth/login",
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
  });

  it("reports session state and clears the cookie on logout", async () => {
    const env = await makeEnv();
    const session = await handleAdminAuthRoute(
      new Request("https://vault.example/api/auth/session"),
      env,
      "/api/auth/session",
    );
    expect(await session?.json()).toEqual({
      ok: true,
      data: { authenticated: false },
    });

    const logout = await handleAdminAuthRoute(
      new Request("https://vault.example/api/auth/logout", { method: "POST" }),
      env,
      "/api/auth/logout",
    );
    expect(logout?.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
