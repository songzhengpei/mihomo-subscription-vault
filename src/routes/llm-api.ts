import type { Env, LlmKeyDetail, LlmKeyErrorCode } from "../types.ts";
import { verifyAdminAuth } from "../security/auth.ts";
import { isValidInstanceSecret } from "../security/llm-crypto.ts";
import {
  createLlmKey,
  deleteLlmKey,
  getLlmKey,
  isLlmKeyError,
  listLlmKeys,
  LlmKeyError,
  revealLlmKey,
  updateLlmKey,
} from "../services/llm-key-store.ts";

/**
 * Admin-only management API for the LLM credential vault.
 *
 * Mounted under `/api/llm/*`, so `src/index.ts` already authenticates it: the
 * browser session is translated into the internal Bearer contract before
 * `handleApi` runs, and `hasValidAdminSession` enforces same-origin on writes.
 * Every branch below still re-checks `verifyAdminAuth`, matching the rest of
 * `src/routes/api.ts`.
 *
 * Nothing in this file ever emits the API key except the single `reveal`
 * endpoint, and never into a URL, log line, or cache.
 */
const LLM_API_BASE = "/api/llm";
const MAX_BODY_CHARS = 65536;

const ERROR_STATUS: Record<LlmKeyErrorCode, number> = {
  INVALID_SLUG: 400,
  INVALID_LLM_PAYLOAD: 400,
  LLM_KEY_NOT_FOUND: 404,
  LLM_KEY_CONFLICT: 409,
  LLM_KEY_CORRUPTED: 500,
  LLM_STORE_UNAVAILABLE: 503,
  LLM_STORE_WRITE_FAILED: 500,
};

// Mirrors the header set of `json()` in src/routes/api.ts so admin payloads
// stay out of caches and are never MIME-sniffed.
function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return json({ ok: false, error: { code, message } }, status);
}

function methodNotAllowed(allow: string[]): Response {
  const response = errorResponse("METHOD_NOT_ALLOWED", "请求方法不支持", 405);
  response.headers.set("Allow", allow.join(", "));
  return response;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) {
    throw new LlmKeyError("INVALID_LLM_PAYLOAD", "请求体不能为空");
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new LlmKeyError("INVALID_LLM_PAYLOAD", "请求体过大");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmKeyError("INVALID_LLM_PAYLOAD", "请求体不是合法 JSON");
  }
}

function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new LlmKeyError("INVALID_SLUG", "Slug 不合法");
  }
}

function projectDetail(detail: LlmKeyDetail) {
  const { meta, integrity } = detail;
  return {
    slug: meta.slug,
    name: meta.name,
    provider: meta.provider,
    baseUrl: meta.baseUrl,
    models: meta.models,
    notes: meta.notes,
    tags: meta.tags,
    hint: meta.hint,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    integrity,
  };
}

async function route(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    return errorResponse("INVALID_LLM_QUERY", "该接口不接受查询参数", 400);
  }

  const bucket = env.SUBSCRIPTION_BUCKET;
  const method = request.method;

  if (path === `${LLM_API_BASE}/keys`) {
    if (method === "GET") {
      const keys = await listLlmKeys(bucket);
      // Surfaced so the UI can warn before the user types a key that this
      // instance cannot encrypt.
      return json({
        ok: true,
        data: {
          keys,
          storeAvailable: isValidInstanceSecret(env.INSTANCE_SECRET),
        },
      });
    }
    if (method === "POST") {
      const meta = await createLlmKey(
        bucket,
        env.INSTANCE_SECRET,
        await readJsonBody(request),
      );
      return json({ ok: true, data: { slug: meta.slug } }, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const revealMatch = path.match(/^\/api\/llm\/keys\/([^/]+)\/reveal$/);
  if (revealMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const result = await revealLlmKey(
      bucket,
      env.INSTANCE_SECRET,
      decodeSlug(revealMatch[1]!),
    );
    // The only plaintext exit in the module. `json()` already sets no-store.
    return json({
      ok: true,
      data: {
        slug: result.meta.slug,
        provider: result.meta.provider,
        baseUrl: result.meta.baseUrl,
        apiKey: result.apiKey,
      },
    });
  }

  const keyMatch = path.match(/^\/api\/llm\/keys\/([^/]+)$/);
  if (keyMatch) {
    const slug = decodeSlug(keyMatch[1]!);
    if (method === "GET") {
      const detail = await getLlmKey(bucket, slug);
      if (!detail) {
        throw new LlmKeyError("LLM_KEY_NOT_FOUND", "凭据不存在");
      }
      return json({ ok: true, data: { key: projectDetail(detail) } });
    }
    if (method === "PUT") {
      const meta = await updateLlmKey(
        bucket,
        env.INSTANCE_SECRET,
        slug,
        await readJsonBody(request),
      );
      return json({ ok: true, data: { slug: meta.slug } });
    }
    if (method === "DELETE") {
      const deleted = await deleteLlmKey(bucket, slug);
      if (!deleted) {
        throw new LlmKeyError("LLM_KEY_NOT_FOUND", "凭据不存在");
      }
      return json({ ok: true, data: { slug, deleted: true } });
    }
    return methodNotAllowed(["GET", "PUT", "DELETE"]);
  }

  return errorResponse("NOT_FOUND", "路径不存在", 404);
}

export async function handleLlmApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== LLM_API_BASE && !path.startsWith(`${LLM_API_BASE}/`)) {
    return null;
  }
  if (!verifyAdminAuth(request, env)) {
    return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
  }
  try {
    return await route(request, env, path);
  } catch (error) {
    if (isLlmKeyError(error)) {
      return errorResponse(
        error.code,
        error.message,
        ERROR_STATUS[error.code] ?? 500,
      );
    }
    // Log the error class only — request bodies and payloads must never reach
    // the log stream.
    console.error(
      "LLM credential API failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return errorResponse("LLM_STORE_WRITE_FAILED", "服务器内部错误", 500);
  }
}
