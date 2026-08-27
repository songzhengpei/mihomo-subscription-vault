import { describe, expect, it } from "vitest";
import type { Env } from "../src/types.ts";
import { handleSetupRoute } from "../src/routes/setup.ts";
import { resolveRuntimeEnv } from "../src/services/instance-config.ts";
import worker from "../src/index.ts";

class MockR2Bucket {
  private readonly store = new Map<string, string>();

  async head(key: string): Promise<{ key: string } | null> {
    return this.store.has(key) ? { key } : null;
  }

  async get(key: string): Promise<unknown> {
    const text = this.store.get(key);
    if (text === undefined) return null;
    return {
      key,
      async json() {
        return JSON.parse(text);
      },
      async text() {
        return text;
      },
    };
  }

  async put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<{ key: string } | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return { key };
  }

  rawValues(): string {
    return [...this.store.values()].join("\n");
  }
}

function makeEnv(bucket: MockR2Bucket, secret?: string): Env {
  return {
    SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
    INSTANCE_SECRET: secret,
    ADMIN_TOKEN: "",
    DOWNLOAD_TOKEN: "",
  };
}

function setupRequest(body: Record<string, unknown>): Request {
  return new Request("https://vault.example/api/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://vault.example",
    },
    body: JSON.stringify(body),
  });
}

describe("first-run setup", () => {
  const executionContext = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  it("explains when INSTANCE_SECRET is missing", async () => {
    const env = makeEnv(new MockR2Bucket());
    const response = await handleSetupRoute(
      new Request("https://vault.example/setup"),
      env,
      "/setup",
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("部署缺少 INSTANCE_SECRET");
    expect(await resolveRuntimeEnv(env, "https://vault.example")).toEqual({
      configured: false,
      reason: "INSTANCE_SECRET_REQUIRED",
    });
  });

  it("rejects an incorrect instance secret", async () => {
    const env = makeEnv(new MockR2Bucket(), "a".repeat(48));
    const response = await handleSetupRoute(
      setupRequest({
        instanceSecret: "b".repeat(48),
        username: "admin",
        password: "a-strong-password",
      }),
      env,
      "/api/setup",
    );

    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({
      error: { code: "INVALID_SECRET" },
    });
  });

  it("creates encrypted credentials once and resolves a usable runtime env", async () => {
    const bucket = new MockR2Bucket();
    const instanceSecret = "correct-instance-secret-with-more-than-32-bytes";
    const env = makeEnv(bucket, instanceSecret);
    const requestBody = {
      instanceSecret,
      username: "vault-admin",
      password: "a-strong-password",
    };
    const response = await handleSetupRoute(
      setupRequest(requestBody),
      env,
      "/api/setup",
    );
    const body = (await response?.json()) as {
      ok: boolean;
      data: { adminToken: string; downloadToken: string };
    };

    expect(response?.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.data.adminToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.data.downloadToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(bucket.rawValues()).not.toContain(requestBody.username);
    expect(bucket.rawValues()).not.toContain(requestBody.password);
    expect(bucket.rawValues()).not.toContain(body.data.adminToken);
    expect(bucket.rawValues()).not.toContain(body.data.downloadToken);

    const runtime = await resolveRuntimeEnv(env, "https://vault.example");
    expect(runtime.configured).toBe(true);
    if (runtime.configured) {
      expect(runtime.env.ADMIN_USERNAME).toBe("vault-admin");
      expect(runtime.env.ADMIN_TOKEN).toBe(body.data.adminToken);
      expect(runtime.env.DOWNLOAD_TOKEN).toBe(body.data.downloadToken);
      expect(runtime.env.PUBLIC_BASE_URL).toBe("https://vault.example");
      expect(runtime.env.ADMIN_PASSWORD_HASH).toMatch(/^pbkdf2-sha256\$/);
    }

    const second = await handleSetupRoute(
      setupRequest(requestBody),
      env,
      "/api/setup",
    );
    expect(second?.status).toBe(409);

    const setupPage = await handleSetupRoute(
      new Request("https://vault.example/setup"),
      env,
      "/setup",
    );
    expect(setupPage?.status).toBe(302);
    expect(setupPage?.headers.get("Location")).toBe(
      "https://vault.example/admin",
    );
  });

  it("keeps the legacy secret configuration fully compatible", async () => {
    const env: Env = {
      SUBSCRIPTION_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
      ADMIN_TOKEN: "admin-token",
      DOWNLOAD_TOKEN: "download-token",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH:
        "pbkdf2-sha256$100000$MTIzNDU2Nzg5MDEyMzQ1Ng$RIq8kG7ZqvJOcPFM7E9pCi58uOPmH2B2j9yJ4rEGV1w",
      SESSION_SECRET: "session-secret-with-at-least-32-bytes",
    };

    const runtime = await resolveRuntimeEnv(env, "https://vault.example");
    expect(runtime).toMatchObject({
      configured: true,
      env: {
        ADMIN_TOKEN: "admin-token",
        DOWNLOAD_TOKEN: "download-token",
        PUBLIC_BASE_URL: "https://vault.example",
      },
    });
  });

  it("completes the redirect, setup, and browser login flow", async () => {
    const bucket = new MockR2Bucket();
    const instanceSecret = "browser-flow-instance-secret-at-least-32-bytes";
    const env = makeEnv(bucket, instanceSecret);

    const beforeSetup = await worker.fetch(
      new Request("https://vault.example/admin"),
      env,
      executionContext,
    );
    expect(beforeSetup.status).toBe(302);
    expect(beforeSetup.headers.get("Location")).toBe(
      "https://vault.example/setup",
    );

    const setup = await worker.fetch(
      setupRequest({
        instanceSecret,
        username: "admin",
        password: "a-strong-password",
      }),
      env,
      executionContext,
    );
    expect(setup.status).toBe(201);

    const login = await worker.fetch(
      new Request("https://vault.example/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://vault.example",
        },
        body: JSON.stringify({
          username: "admin",
          password: "a-strong-password",
        }),
      }),
      env,
      executionContext,
    );
    expect(login.status).toBe(200);
    expect(login.headers.get("Set-Cookie")).toContain(
      "__Host-msv_admin_session=",
    );
  });
});
