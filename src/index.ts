import type { Env } from "./types.ts";
import { handleApi } from "./routes/api.ts";
import { handleProvider } from "./routes/provider.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleConfig, handleMainConfig } from "./routes/config.ts";
import {
  handleAdminAuthRoute,
  hasValidAdminSession,
} from "./security/admin-session.ts";
import { handleSetupRoute } from "./routes/setup.ts";
import { resolveRuntimeEnv } from "./services/instance-config.ts";

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const setupResponse = await handleSetupRoute(request, env, path);
      if (setupResponse) return setupResponse;

      const runtime = await resolveRuntimeEnv(env, url.origin);
      if (!runtime.configured) {
        if (path === "/" || (path === "/admin" && request.method === "GET")) {
          return Response.redirect(`${url.origin}/setup`, 302);
        }
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: runtime.reason,
              message:
                runtime.reason === "INSTANCE_SECRET_REQUIRED"
                  ? "请先为 Worker 配置 INSTANCE_SECRET"
                  : "请先打开 /setup 完成实例初始化",
            },
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }
      env = runtime.env;

      // Admin page
      if (path === "/admin" && request.method === "GET") {
        return handleAdmin();
      }

      // Provider download: GET/HEAD /provider/:slug/:downloadToken
      const providerMatch = path.match(/^\/provider\/([^/]+)\/([^/]+)$/);
      if (
        providerMatch &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const slug = providerMatch[1]!;
        // We need to verify token via the full URL
        // The token is the last segment of the path
        return handleProvider(request, env, slug);
      }

      // Config download: /config/:slug/:token (path match before method check)
      const configMatch = path.match(/^\/config\/([^/]+)\/([^/]+)$/);
      if (configMatch) {
        return handleConfig(request, env, configMatch[1]!);
      }

      // Main config download: /main-config/:token (path match before method check)
      const mainConfigMatch = path.match(/^\/main-config\/([^/]+)$/);
      if (mainConfigMatch) {
        return handleMainConfig(request, env);
      }

      // API routes
      if (path.startsWith("/api/")) {
        const authResponse = await handleAdminAuthRoute(request, env, path);
        if (authResponse) return authResponse;

        // Browser sessions are translated into the existing internal Bearer
        // contract. Script/API clients can keep using ADMIN_TOKEN unchanged.
        if (
          !request.headers.has("Authorization") &&
          (await hasValidAdminSession(request, env))
        ) {
          const headers = new Headers(request.headers);
          headers.set("Authorization", `Bearer ${env.ADMIN_TOKEN}`);
          request = new Request(request, { headers });
        }
        const apiResponse = await handleApi(request, env, path);
        if (apiResponse) return apiResponse;
      }

      // Root redirect to admin
      if (path === "/") {
        return Response.redirect(`${url.origin}/admin`, 302);
      }

      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_FOUND", message: "路径不存在" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    } catch (e) {
      console.error("Unhandled Worker request error", e);
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "服务器内部错误" },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
