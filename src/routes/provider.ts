import type { Env } from "../types.ts";
import { verifyDownloadAuth } from "../security/auth.ts";
import * as storage from "../services/storage.ts";

function errorJson(message: string, status = 403): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function handleProvider(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  if (!verifyDownloadAuth(new URL(request.url), env)) {
    return errorJson("下载 Token 无效");
  }

  const latest = await storage.getLatest(env.SUBSCRIPTION_BUCKET, slug);
  if (!latest) {
    return errorJson("订阅不存在", 404);
  }

  // HEAD request: return headers only, no body
  if (request.method === "HEAD") {
    const headers: Record<string, string> = {
      "Content-Type": "text/yaml; charset=utf-8",
      ETag: `"${latest.sha256}"`,
      "Cache-Control": "no-store",
    };

    const meta = await storage.getProviderMeta(
      env.SUBSCRIPTION_BUCKET,
      slug,
      latest.versionId,
    );
    if (meta?.subscriptionUserinfo) {
      headers["subscription-userinfo"] = meta.subscriptionUserinfo;
    }
    if (meta?.profileUpdateInterval) {
      headers["profile-update-interval"] = meta.profileUpdateInterval;
    }
    if (meta?.profileWebPageUrl) {
      headers["profile-web-page-url"] = meta.profileWebPageUrl;
    }

    return new Response(null, { status: 200, headers });
  }

  // If-None-Match: return 304 if ETag matches
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === `"${latest.sha256}"`) {
    return new Response(null, { status: 304 });
  }

  const yaml = await storage.getVersionYaml(
    env.SUBSCRIPTION_BUCKET,
    slug,
    latest.versionId,
  );
  if (!yaml) {
    return errorJson("订阅内容不存在", 404);
  }

  const meta = await storage.getProviderMeta(
    env.SUBSCRIPTION_BUCKET,
    slug,
    latest.versionId,
  );

  const headers: Record<string, string> = {
    "Content-Type": "text/yaml; charset=utf-8",
    ETag: `"${latest.sha256}"`,
    "Cache-Control": "no-store",
  };

  if (meta?.subscriptionUserinfo) {
    headers["subscription-userinfo"] = meta.subscriptionUserinfo;
  }
  if (meta?.profileUpdateInterval) {
    headers["profile-update-interval"] = meta.profileUpdateInterval;
  }
  if (meta?.profileWebPageUrl) {
    headers["profile-web-page-url"] = meta.profileWebPageUrl;
  }

  return new Response(yaml, { headers });
}
