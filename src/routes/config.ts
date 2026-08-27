import type { Env, ProviderDistributionMetadata } from "../types.ts";
import { validateSlug } from "../security/ssrf.ts";
import { verifyDownloadAuth } from "../security/auth.ts";
import {
  resolveAndVerifyProfileBytes,
  resolveProfileMetadata,
  PublicProviderError,
  VersionPublishError,
} from "../services/storage.ts";
import {
  readAndVerifyCurrentMainConfigBytes,
  resolveCurrentMainConfigMetadata,
  MainConfigError,
} from "../services/main-config-storage.ts";
import {
  buildUnifiedExport,
  UnifiedExportError,
  UNIFIED_ERROR_HTTP,
} from "../services/unified-export.ts";

const CAPSULE_CONTENT_TYPE =
  "application/vnd.mihomo-unified-backup+zip; version=1";

function acceptsWorkerV1Capsule(accept: string | null): boolean {
  if (!accept) return false;
  return accept.split(",").some((range) => {
    const parts = range.split(";").map((part) => part.trim().toLowerCase());
    if (parts[0] !== "application/vnd.mihomo-unified-backup+zip") {
      return false;
    }
    return parts.slice(1).some((part) => /^version\s*=\s*1$/.test(part));
  });
}

// --- Error mapping ---

interface ErrorMapping {
  status: number;
  code: string;
  message: string;
}

const PROVIDER_ERROR_MAP: Record<string, ErrorMapping> = {
  CONFIG_NOT_FOUND: {
    status: 404,
    code: "CONFIG_NOT_FOUND",
    message: "完整配置不存在",
  },
  CONFIG_NOT_AVAILABLE: {
    status: 409,
    code: "CONFIG_NOT_AVAILABLE",
    message: "当前完整配置不可用",
  },
  CONFIG_CORRUPTED: {
    status: 500,
    code: "CONFIG_CORRUPTED",
    message: "完整配置存储完整性验证失败",
  },
};

const MAIN_CONFIG_ERROR_MAP: Record<string, ErrorMapping> = {
  MAIN_CONFIG_NOT_FOUND: {
    status: 404,
    code: "MAIN_CONFIG_NOT_FOUND",
    message: "主配置不存在",
  },
  MAIN_CONFIG_CORRUPTED: {
    status: 500,
    code: "MAIN_CONFIG_CORRUPTED",
    message: "主配置存储完整性验证失败",
  },
};

const MAIN_NOT_FOUND = MAIN_CONFIG_ERROR_MAP["MAIN_CONFIG_NOT_FOUND"]!;

// --- Response helpers ---

function errorResponse(mapping: ErrorMapping, isHead: boolean): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const body = isHead
    ? null
    : JSON.stringify({
        ok: false,
        error: { code: mapping.code, message: mapping.message },
      });
  return new Response(body, { status: mapping.status, headers });
}

function methodNotAllowedResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "请求方法不受支持" },
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Allow: "GET, HEAD",
      },
    },
  );
}

function invalidSlugResponse(isHead: boolean): Response {
  return errorResponse(
    { status: 400, code: "INVALID_SLUG", message: "Slug 格式无效" },
    isHead,
  );
}

function forbiddenResponse(isHead: boolean): Response {
  return errorResponse(
    { status: 403, code: "FORBIDDEN", message: "访问被拒绝" },
    isHead,
  );
}

function internalErrorResponse(isHead: boolean): Response {
  return errorResponse(
    { status: 500, code: "INTERNAL_ERROR", message: "服务器内部错误" },
    isHead,
  );
}

// --- ETag comparison ---

function matchesStrongETag(
  ifNoneMatch: string | null,
  strongETag: string,
): boolean {
  if (!ifNoneMatch) return false;
  // Only exact single strong ETag match produces 304
  return ifNoneMatch === strongETag;
}

// --- Distribution header helpers ---

function addDistributionHeaders(
  headers: Record<string, string>,
  distribution: ProviderDistributionMetadata,
): void {
  if (
    distribution.subscriptionUserinfo &&
    distribution.subscriptionUserinfo.length > 0 &&
    !hasCrLf(distribution.subscriptionUserinfo)
  ) {
    headers["subscription-userinfo"] = distribution.subscriptionUserinfo;
  }
  if (
    distribution.profileUpdateInterval &&
    distribution.profileUpdateInterval.length > 0 &&
    !hasCrLf(distribution.profileUpdateInterval)
  ) {
    headers["profile-update-interval"] = distribution.profileUpdateInterval;
  }
  if (
    distribution.profileWebPageUrl &&
    distribution.profileWebPageUrl.length > 0 &&
    !hasCrLf(distribution.profileWebPageUrl)
  ) {
    headers["profile-web-page-url"] = distribution.profileWebPageUrl;
  }
}

function hasCrLf(value: string): boolean {
  return value.includes("\r") || value.includes("\n");
}

// --- GET/HEAD 304 response builder ---

function build304Response(
  etag: string,
  contentLength: number,
  distribution?: ProviderDistributionMetadata,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/yaml; charset=utf-8",
    ETag: etag,
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
  };
  if (distribution) {
    addDistributionHeaders(headers, distribution);
  }
  return new Response(null, { status: 304, headers });
}

// --- /config/:slug/:token handler ---

export async function handleConfig(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const isHead = request.method === "HEAD";
  const isGet = request.method === "GET";

  // 1. Method check
  if (!isGet && !isHead) {
    return methodNotAllowedResponse();
  }

  // 2. Token validation
  if (!verifyDownloadAuth(new URL(request.url), env)) {
    return forbiddenResponse(isHead);
  }

  // 3. Slug validation
  if (!validateSlug(slug)) {
    return invalidSlugResponse(isHead);
  }

  try {
    if (isGet) {
      if (acceptsWorkerV1Capsule(request.headers.get("Accept"))) {
        const requestUrl = new URL(request.url);
        requestUrl.search = "";
        requestUrl.hash = "";
        const { stream, size } = await buildUnifiedExport(
          env.SUBSCRIPTION_BUCKET,
          env,
          slug,
          { configUrl: requestUrl.toString() },
        );
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": CAPSULE_CONTENT_TYPE,
            "Content-Length": String(size),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      // 4a. GET: full integrity verification
      const resolved = await resolveAndVerifyProfileBytes(
        env.SUBSCRIPTION_BUCKET,
        slug,
      );

      const etag = `"${resolved.sha256}"`;

      // 5. Conditional request — AFTER full verification
      if (matchesStrongETag(request.headers.get("If-None-Match"), etag)) {
        return build304Response(
          etag,
          resolved.contentLength,
          resolved.meta.distribution,
        );
      }

      // 6. Build response
      const headers: Record<string, string> = {
        "Content-Type": "text/yaml; charset=utf-8",
        ETag: etag,
        "Cache-Control": "no-store",
        "Content-Length": String(resolved.contentLength),
      };
      addDistributionHeaders(headers, resolved.meta.distribution);

      return new Response(resolved.bytes, { status: 200, headers });
    } else {
      // 4b. HEAD: metadata-only verification
      const resolved = await resolveProfileMetadata(
        env.SUBSCRIPTION_BUCKET,
        slug,
      );

      const etag = `"${resolved.sha256}"`;

      // 5. Conditional request
      if (matchesStrongETag(request.headers.get("If-None-Match"), etag)) {
        return build304Response(
          etag,
          resolved.contentLength,
          resolved.meta.distribution,
        );
      }

      // 6. Build response (no body)
      const headers: Record<string, string> = {
        "Content-Type": "text/yaml; charset=utf-8",
        ETag: etag,
        "Cache-Control": "no-store",
        "Content-Length": String(resolved.contentLength),
      };
      addDistributionHeaders(headers, resolved.meta.distribution);

      return new Response(null, { status: 200, headers });
    }
  } catch (e) {
    if (e instanceof UnifiedExportError) {
      const status = UNIFIED_ERROR_HTTP[e.code] ?? 500;
      return errorResponse(
        {
          status,
          code: e.code,
          message: status >= 500 ? "Capsule 生成失败" : e.message,
        },
        isHead,
      );
    }
    if (e instanceof PublicProviderError) {
      const mapping = PROVIDER_ERROR_MAP[e.code];
      if (mapping) {
        return errorResponse(mapping, isHead);
      }
    }
    // Any storage-layer error indicates corruption
    if (e instanceof VersionPublishError) {
      return errorResponse(PROVIDER_ERROR_MAP["CONFIG_CORRUPTED"]!, isHead);
    }
    return internalErrorResponse(isHead);
  }
}

// --- /main-config/:token handler ---

export async function handleMainConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  const isHead = request.method === "HEAD";
  const isGet = request.method === "GET";

  // 1. Method check
  if (!isGet && !isHead) {
    return methodNotAllowedResponse();
  }

  // 2. Token validation
  if (!verifyDownloadAuth(new URL(request.url), env)) {
    return forbiddenResponse(isHead);
  }

  try {
    if (isGet) {
      // 3a. GET: full integrity verification
      const resolved = await readAndVerifyCurrentMainConfigBytes(
        env.SUBSCRIPTION_BUCKET,
      );

      // 4. Not found (never created)
      if (!resolved) {
        return errorResponse(MAIN_NOT_FOUND, false);
      }

      // 5. Disabled check
      if (resolved.pointer.status === "disabled") {
        return errorResponse(MAIN_NOT_FOUND, false);
      }

      const etag = `"${resolved.sha256}"`;

      // 6. Conditional request — AFTER full verification
      if (matchesStrongETag(request.headers.get("If-None-Match"), etag)) {
        const headers: Record<string, string> = {
          "Content-Type": "text/yaml; charset=utf-8",
          ETag: etag,
          "Cache-Control": "no-store",
          "Content-Length": String(resolved.contentLength),
        };
        return new Response(null, { status: 304, headers });
      }

      // 7. Build response
      const headers: Record<string, string> = {
        "Content-Type": "text/yaml; charset=utf-8",
        ETag: etag,
        "Cache-Control": "no-store",
        "Content-Length": String(resolved.contentLength),
      };
      return new Response(resolved.bytes, { status: 200, headers });
    } else {
      // 3b. HEAD: metadata-only verification
      const resolved = await resolveCurrentMainConfigMetadata(
        env.SUBSCRIPTION_BUCKET,
      );

      // 4. Not found
      if (!resolved) {
        return errorResponse(MAIN_NOT_FOUND, true);
      }

      // 5. Disabled check
      if (resolved.pointer.status === "disabled") {
        return errorResponse(MAIN_NOT_FOUND, true);
      }

      const etag = `"${resolved.sha256}"`;

      // 6. Conditional request
      if (matchesStrongETag(request.headers.get("If-None-Match"), etag)) {
        const headers: Record<string, string> = {
          "Content-Type": "text/yaml; charset=utf-8",
          ETag: etag,
          "Cache-Control": "no-store",
          "Content-Length": String(resolved.contentLength),
        };
        return new Response(null, { status: 304, headers });
      }

      // 7. Build response (no body)
      const headers: Record<string, string> = {
        "Content-Type": "text/yaml; charset=utf-8",
        ETag: etag,
        "Cache-Control": "no-store",
        "Content-Length": String(resolved.contentLength),
      };
      return new Response(null, { status: 200, headers });
    }
  } catch (e) {
    if (e instanceof MainConfigError) {
      const mapping = MAIN_CONFIG_ERROR_MAP[e.code];
      if (mapping) {
        return errorResponse(mapping, isHead);
      }
      // Any other MainConfigError from the resolver indicates corruption
      return errorResponse(
        MAIN_CONFIG_ERROR_MAP["MAIN_CONFIG_CORRUPTED"]!,
        isHead,
      );
    }
    return internalErrorResponse(isHead);
  }
}
