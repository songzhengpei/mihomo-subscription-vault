import type {
  Env,
  ApiResponse,
  UpdateRequest,
  RollbackRequest,
} from "../types.ts";
import { verifyAdminAuth } from "../security/auth.ts";
import { validateUrl, validateSlug } from "../security/ssrf.ts";
import * as storage from "../services/storage.ts";
import { updateProvider } from "../services/updater.ts";
import * as mcStorage from "../services/main-config-storage.ts";
import {
  buildUnifiedExport,
  UnifiedExportError,
  UNIFIED_ERROR_HTTP,
} from "../services/unified-export.ts";
import {
  executeUnifiedImport,
  MAX_UNIFIED_IMPORT_BYTES,
  parseUnifiedImport,
  readUnifiedImportBody,
  UnifiedImportCommitError,
  UnifiedImportError,
} from "../services/unified-import.ts";
import {
  testConnection,
  pushBackup,
  pullBackup,
  listFiles,
  ensureBackupDirectory,
} from "../services/webdav-client.ts";
import type { WebDAVConfig } from "../types.ts";
import { handleLlmApi } from "./llm-api.ts";

function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Admin payloads carry source URLs and download tokens — keep them out of
      // any cache and prevent MIME sniffing.
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Basic Auth credentials and the full backup archive travel over this URL, so it
 * must be HTTPS and must not point at a private address. Returns an error
 * message, or null when the URL is acceptable.
 */
function validateWebDAVUrl(rawUrl: string): string | null {
  const result = validateUrl(rawUrl);
  if (!result.valid) return `WebDAV 地址无效：${result.error}`;
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    return "WebDAV 地址必须使用 https，否则备份内容与密码会明文传输";
  }
  if (url.username || url.password) {
    return "WebDAV 地址不能内嵌用户名或密码，请填写到对应输入框";
  }
  return null;
}

function errorResponse(code: string, message: string, status = 400): Response {
  const body: ApiResponse = {
    ok: false,
    error: { code, message },
  };
  return json(body, status);
}

export async function handleApi(
  request: Request,
  env: Env,
  path: string,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  // LLM credential vault: owns the whole /api/llm/* namespace. Independent of
  // the provider subscription routes below.
  const llmResponse = await handleLlmApi(request, env, path);
  if (llmResponse) return llmResponse;

  // POST /api/unified-import — raw Worker v1 ZIP body.
  if (path === "/api/unified-import") {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    const fail = (code: string, message: string, status: number) =>
      new Response(JSON.stringify({ ok: false, error: { code, message } }), {
        status,
        headers,
      });
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 POST" },
        }),
        { status: 405, headers: { ...headers, Allow: "POST" } },
      );
    }
    // Authentication deliberately precedes all request-body reads.
    if (!verifyAdminAuth(request, env)) {
      return fail("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const contentType = request.headers.get("Content-Type")?.toLowerCase();
    if (contentType !== "application/zip") {
      return fail("INVALID_CONTENT_TYPE", "请求体必须是 ZIP 文件", 415);
    }
    const declaredLength = request.headers.get("Content-Length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length < 0) {
        return fail("INVALID_ZIP", "请求体长度无效", 400);
      }
      if (length > MAX_UNIFIED_IMPORT_BYTES) {
        return fail("IMPORT_TOO_LARGE", "导入文件超过大小限制", 413);
      }
    }
    try {
      const bytes = await readUnifiedImportBody(request);
      const plan = await parseUnifiedImport(
        bytes,
        env.PUBLIC_BASE_URL ?? "",
        env.TRUSTED_PUBLIC_ORIGINS?.split(",").map((origin) => origin.trim()),
      );
      const result = await executeUnifiedImport(env.SUBSCRIPTION_BUCKET, plan);
      await tryPersistImportedProviderOrder(
        env.SUBSCRIPTION_BUCKET,
        plan.providers,
      );
      return new Response(JSON.stringify({ ok: true, data: result }), {
        status: 200,
        headers,
      });
    } catch (error) {
      if (error instanceof UnifiedImportCommitError) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "IMPORT_CONFLICT",
              message: "导入遇到并发更新，未覆盖当前版本",
            },
            data: {
              committedProviders: error.committedProviders,
              committedDependencies: error.committedDependencies,
            },
          }),
          { status: 409, headers },
        );
      }
      if (error instanceof UnifiedImportError) {
        const publicCode =
          error.code === "ZIP_LIMIT_EXCEEDED"
            ? "IMPORT_TOO_LARGE"
            : error.code === "DUPLICATE_ZIP_PATH"
              ? "DUPLICATE_ZIP_ENTRY"
              : error.code === "INVALID_FIXED_URL"
                ? "UNSAFE_SUBSCRIPTION_URL"
                : error.code === "UNSUPPORTED_ZIP_ENTRY"
                  ? "INVALID_ZIP"
                  : error.code;
        const status = publicCode === "IMPORT_TOO_LARGE" ? 413 : 400;
        return fail(publicCode, error.message, status);
      }
      return fail("STORED_VERSION_CORRUPTED", "导入依赖的数据不可用", 500);
    }
  }

  // ── WebDAV sync endpoints ──

  // GET /api/webdav/config
  if (path === "/api/webdav/config" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const config = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
    if (!config) return json({ ok: true, data: null });
    // Mask password in response
    return json({
      ok: true,
      data: {
        url: config.url,
        username: config.username,
        password: "***",
        remotePath: config.remotePath,
      },
    });
  }

  // POST /api/webdav/config
  if (path === "/api/webdav/config" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const body = (await request.json()) as Partial<WebDAVConfig> & {
      password?: string;
    };
    if (!body.url || !body.username || !body.remotePath) {
      return json(
        { ok: false, error: "url、username、remotePath 为必填" },
        400,
      );
    }
    const webdavUrlError = validateWebDAVUrl(body.url);
    if (webdavUrlError) {
      return json({ ok: false, error: webdavUrlError }, 400);
    }
    // If password is "***" (masked), keep the existing password
    let password = body.password || "";
    if (password === "***") {
      const existing = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
      password = existing?.password || "";
    }
    const config: WebDAVConfig = {
      url: body.url,
      username: body.username,
      password,
      remotePath: body.remotePath,
    };
    await storage.saveWebDAVConfig(env.SUBSCRIPTION_BUCKET, config);
    return json({ ok: true });
  }

  // GET /api/webdav/list
  if (path === "/api/webdav/list" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const config = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
    if (!config) return json({ ok: false, error: "WebDAV 未配置" }, 400);
    const result = await listFiles(config);
    return json(result, result.ok ? 200 : 400);
  }

  // GET /api/webdav/test
  if (path === "/api/webdav/test" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const config = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
    if (!config) return json({ ok: false, error: "WebDAV 未配置" }, 400);
    const result = await testConnection(config);
    return json(result, result.ok ? 200 : 400);
  }

  // POST /api/webdav/push
  if (path === "/api/webdav/push" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const config = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
    if (!config) return json({ ok: false, error: "WebDAV 未配置" }, 400);
    try {
      // The directory check and the archive build are independent, so the MKCOL
      // round trip overlaps ZIP assembly instead of following it.
      const [{ stream }, directory] = await Promise.all([
        buildUnifiedExport(env.SUBSCRIPTION_BUCKET, env),
        ensureBackupDirectory(config),
      ]);
      if (!directory.ok) return json(directory, 400);
      const zip = new Uint8Array(await new Response(stream).arrayBuffer());
      const result = await pushBackup(config, zip, true);
      return json(result, result.ok ? 200 : 400);
    } catch (e) {
      return unifiedExportErrorResponse(e);
    }
  }

  // POST /api/webdav/pull
  if (path === "/api/webdav/pull" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const config = await storage.getWebDAVConfig(env.SUBSCRIPTION_BUCKET);
    if (!config) return json({ ok: false, error: "WebDAV 未配置" }, 400);
    const body = (await request.json().catch(() => ({}))) as {
      fileName?: string;
    };
    const result = await pullBackup(config, body.fileName);
    if (!result.ok) {
      return json(result, 400);
    }
    try {
      const plan = await parseUnifiedImport(
        result.data,
        env.PUBLIC_BASE_URL ?? "",
        env.TRUSTED_PUBLIC_ORIGINS?.split(",").map((origin) => origin.trim()),
      );
      const importResult = await executeUnifiedImport(
        env.SUBSCRIPTION_BUCKET,
        plan,
      );
      await tryPersistImportedProviderOrder(
        env.SUBSCRIPTION_BUCKET,
        plan.providers,
      );
      return json({ ok: true, data: importResult }, 200);
    } catch (error) {
      if (error instanceof UnifiedImportError) {
        return json(
          { ok: false, error: { code: error.code, message: error.message } },
          400,
        );
      }
      if (error instanceof UnifiedImportCommitError) {
        return json(
          {
            ok: false,
            error: { code: "IMPORT_CONFLICT", message: "导入遇到并发更新" },
            data: {
              committedProviders: error.committedProviders,
              committedDependencies: error.committedDependencies,
            },
          },
          409,
        );
      }
      return json(
        { ok: false, error: { code: "IMPORT_FAILED", message: "导入失败" } },
        500,
      );
    }
  }

  // POST /api/providers/:slug/update
  const updateMatch = path.match(/^\/api\/providers\/([^/]+)\/update$/);
  if (updateMatch && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = updateMatch[1]!;
    if (!validateSlug(slug)) {
      return errorResponse(
        "INVALID_SLUG",
        "Slug 格式无效，只允许小写字母、数字和连字符",
      );
    }

    let body: UpdateRequest;
    try {
      body = (await request.json()) as UpdateRequest;
    } catch {
      return errorResponse("INVALID_BODY", "请求体格式无效");
    }

    if (!body.sourceUrl || typeof body.sourceUrl !== "string") {
      return errorResponse("INVALID_URL", "请提供有效的订阅地址");
    }

    if (!body.name || typeof body.name !== "string") {
      return errorResponse("INVALID_NAME", "请提供订阅名称");
    }

    if (body.userAgent !== undefined && typeof body.userAgent !== "string") {
      return errorResponse("INVALID_USER_AGENT", "User-Agent 必须是字符串");
    }

    const urlValidation = validateUrl(body.sourceUrl);
    if (!urlValidation.valid) {
      return errorResponse("INVALID_URL", urlValidation.error!);
    }

    try {
      const result = await updateProvider(
        env.SUBSCRIPTION_BUCKET,
        slug,
        body.sourceUrl,
        body.name,
        env,
        body.userAgent,
        // Version pruning runs after the response instead of delaying it.
        ctx ? (promise) => ctx.waitUntil(promise) : undefined,
      );
      return json({
        ok: true,
        data: {
          versionId: result.meta.versionId,
          isNew: result.isNew,
          nodeCount: result.meta.nodeCount,
          sha256: result.meta.sha256,
          sourceHost: result.meta.sourceHost,
          updatedAt: result.meta.createdAt,
        },
      });
    } catch (e) {
      return errorResponse(
        "UPDATE_FAILED",
        e instanceof Error ? e.message : "更新失败",
      );
    }
  }

  // GET /api/providers/:slug/versions/:versionId/yaml (admin download)
  const yamlMatch = path.match(
    /^\/api\/providers\/([^/]+)\/versions\/([^/]+)\/yaml$/,
  );
  if (yamlMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = yamlMatch[1]!;
    const versionId = yamlMatch[2]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效");
    }

    try {
      const profile = await storage.getVersionProfileForDownload(
        env.SUBSCRIPTION_BUCKET,
        slug,
        versionId,
      );
      if (!profile) {
        return errorResponse(
          "CONFIG_NOT_AVAILABLE",
          "该历史版本没有完整运行配置",
          409,
        );
      }

      return new Response(profile, {
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug}-${versionId}-config.yaml"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      return errorResponse(
        "VERSION_CORRUPTED",
        error instanceof Error ? error.message : "历史完整配置不可用",
        500,
      );
    }
  }

  // GET /api/providers/:slug/history
  const historyMatch = path.match(/^\/api\/providers\/([^/]+)\/history$/);
  if (historyMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = historyMatch[1]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效");
    }

    // Read-only endpoint: pruning happens on publish
    // (tryPruneProviderVersions), so it must not run here — it doubled the
    // list work and turned a GET into a write.
    const versions = await storage.listVersions(env.SUBSCRIPTION_BUCKET, slug);
    return json({ ok: true, data: versions });
  }

  // POST /api/providers/:slug/rollback
  const rollbackMatch = path.match(/^\/api\/providers\/([^/]+)\/rollback$/);
  if (rollbackMatch && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = rollbackMatch[1]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效");
    }

    let body: RollbackRequest;
    try {
      body = (await request.json()) as RollbackRequest;
    } catch {
      return errorResponse("INVALID_BODY", "请求体格式无效");
    }

    if (!body.versionId) {
      return errorResponse("INVALID_VERSION", "请提供要回滚的版本 ID");
    }

    try {
      const result = await storage.rollbackLatest(
        env.SUBSCRIPTION_BUCKET,
        slug,
        body.versionId,
      );

      const isV1 = "schemaVersion" in result;
      return json({
        ok: true,
        data: {
          versionId: body.versionId,
          format: isV1 ? "v1" : "legacy",
        },
      });
    } catch (e) {
      return errorResponse(
        "ROLLBACK_FAILED",
        e instanceof Error ? e.message : "回滚失败",
      );
    }
  }

  // GET /api/providers (list all)
  if (path === "/api/providers/order" && request.method === "PUT") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    let body: { slugs?: unknown };
    try {
      body = (await request.json()) as { slugs?: unknown };
    } catch {
      return errorResponse("INVALID_BODY", "请求体格式无效");
    }
    if (
      !Array.isArray(body.slugs) ||
      body.slugs.some(
        (slug) => typeof slug !== "string" || !validateSlug(slug),
      ) ||
      new Set(body.slugs).size !== body.slugs.length
    ) {
      return errorResponse("INVALID_ORDER", "订阅顺序格式无效");
    }
    const providers = await storage.getAllProviderMeta(env.SUBSCRIPTION_BUCKET);
    const active = providers.map((provider) => provider.slug);
    if (
      active.length !== body.slugs.length ||
      active.some((slug) => !(body.slugs as string[]).includes(slug))
    ) {
      return errorResponse(
        "ORDER_CONFLICT",
        "订阅列表已变化，请刷新后重试",
        409,
      );
    }
    await storage.saveProviderOrder(
      env.SUBSCRIPTION_BUCKET,
      body.slugs as string[],
    );
    return json({ ok: true, data: { slugs: body.slugs } });
  }

  if (path === "/api/providers" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const providers = await storage.getAllProviderMeta(env.SUBSCRIPTION_BUCKET);
    return json({ ok: true, data: providers });
  }

  // GET /api/providers/:slug/links — get download URLs for a provider
  const linksMatch = path.match(/^\/api\/providers\/([^/]+)\/links$/);
  if (linksMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const slug = linksMatch[1]!;
    const origin = env.PUBLIC_BASE_URL || new URL(request.url).origin;
    const token = env.DOWNLOAD_TOKEN;
    return json({
      ok: true,
      data: {
        providerUrl: `${origin}/provider/${slug}/${token}`,
        configUrl: `${origin}/config/${slug}/${token}`,
      },
    });
  }

  // DELETE /api/providers/:slug — remove from subscription list (keep history/staging)
  const deleteProviderMatch = path.match(/^\/api\/providers\/([^/]+)$/);
  if (deleteProviderMatch && request.method === "DELETE") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const slug = deleteProviderMatch[1]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效", 400);
    }
    try {
      await storage.deleteProviderPointer(env.SUBSCRIPTION_BUCKET, slug);
      return json({ ok: true, data: { slug } });
    } catch (e) {
      return errorResponse(
        "DELETE_FAILED",
        e instanceof Error ? e.message : "删除失败",
        500,
      );
    }
  }

  // DELETE /api/providers/:slug/versions/:versionId — delete a single version
  const deleteVersionMatch = path.match(
    /^\/api\/providers\/([^/]+)\/versions\/([^/]+)$/,
  );
  if (deleteVersionMatch && request.method === "DELETE") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const slug = deleteVersionMatch[1]!;
    const versionId = deleteVersionMatch[2]!;
    try {
      const result = await storage.deleteProviderVersion(
        env.SUBSCRIPTION_BUCKET,
        slug,
        versionId,
      );
      return json({
        ok: true,
        data: { slug, versionId, deleted: result.deleted },
      });
    } catch (e) {
      return errorResponse(
        "DELETE_FAILED",
        e instanceof Error ? e.message : "删除失败",
        500,
      );
    }
  }

  // DELETE /api/providers/:slug/staging/:requestId — delete a single staging entry
  const deleteStagingMatch = path.match(
    /^\/api\/providers\/([^/]+)\/staging\/([^/]+)$/,
  );
  if (deleteStagingMatch && request.method === "DELETE") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }
    const slug = deleteStagingMatch[1]!;
    const requestId = deleteStagingMatch[2]!;
    try {
      const result = await storage.deleteStagingEntry(
        env.SUBSCRIPTION_BUCKET,
        slug,
        requestId,
      );
      return json({
        ok: true,
        data: { slug, requestId, deleted: result.deleted },
      });
    } catch (e) {
      return errorResponse(
        "DELETE_FAILED",
        e instanceof Error ? e.message : "删除失败",
        500,
      );
    }
  }

  // GET /api/unified-export
  if (path === "/api/unified-export") {
    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 GET" },
        }),
        {
          status: 405,
          headers: { Allow: "GET", "Content-Type": "application/json" },
        },
      );
    }
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const url = new URL(request.url);
    // Validate query parameters
    const allowedParams = new Set(["slug"]);
    for (const key of url.searchParams.keys()) {
      if (!allowedParams.has(key)) {
        return errorResponse("INVALID_QUERY", "存在未知查询参数", 400);
      }
    }
    if (url.searchParams.getAll("slug").length > 1) {
      return errorResponse("INVALID_QUERY", "slug 参数重复", 400);
    }

    const slugParam = url.searchParams.get("slug");
    if (slugParam !== null) {
      if (slugParam === "") {
        return errorResponse("INVALID_QUERY", "slug 参数为空", 400);
      }
      if (!validateSlug(slugParam)) {
        return errorResponse("INVALID_SLUG", "Slug 格式无效", 400);
      }
    }

    try {
      const { stream, size } = await buildUnifiedExport(
        env.SUBSCRIPTION_BUCKET,
        env,
        slugParam ?? undefined,
      );

      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="mihomo-unified-backup-v1-${ts}.zip"`,
          "Content-Length": String(size),
          "Cache-Control": "no-store",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      return unifiedExportErrorResponse(e);
    }
  }

  // GET /api/providers/:slug/staging
  const stagingListMatch = path.match(/^\/api\/providers\/([^/]+)\/staging$/);
  if (stagingListMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = stagingListMatch[1]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效");
    }

    const stagingItems = await storage.listStaging(
      env.SUBSCRIPTION_BUCKET,
      slug,
    );
    return json({ ok: true, data: stagingItems });
  }

  // GET /api/providers/:slug/staging/:requestId/raw
  const stagingRawMatch = path.match(
    /^\/api\/providers\/([^/]+)\/staging\/([^/]+)\/raw$/,
  );
  if (stagingRawMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const slug = stagingRawMatch[1]!;
    const requestId = stagingRawMatch[2]!;
    if (!validateSlug(slug)) {
      return errorResponse("INVALID_SLUG", "Slug 格式无效");
    }

    const raw = await storage.getStagingRaw(
      env.SUBSCRIPTION_BUCKET,
      slug,
      requestId,
    );
    if (!raw) {
      return errorResponse("STAGING_NOT_FOUND", "原始快照不存在", 404);
    }

    return new Response(raw, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}-${requestId}-raw.txt"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // --- Main Config API (Phase 3) ---

  // GET /api/main-config
  if (path === "/api/main-config" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    try {
      const result = await mcStorage.getMainConfig(env.SUBSCRIPTION_BUCKET);
      if (!result) {
        return mainConfigErrorResponse(
          "MAIN_CONFIG_NOT_FOUND",
          "主配置不存在",
          404,
        );
      }

      const { view, etag } = result;
      return new Response(JSON.stringify({ ok: true, data: view }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: httpEtag(etag),
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // PUT /api/main-config
  if (path === "/api/main-config" && request.method === "PUT") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    // Parse ETag precondition headers
    const ifNoneMatch = request.headers.get("If-None-Match");
    const ifMatch = request.headers.get("If-Match");

    // Reject conflicting headers
    if (ifMatch && ifNoneMatch) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_CONFLICT",
        "不能同时使用 If-Match 和 If-None-Match",
        412,
      );
    }

    // Parse expectedLatest from headers — passed to storage for atomic check
    let expectedLatest: string | null | undefined;
    let isCreate = false;
    if (ifNoneMatch) {
      if (ifNoneMatch.trim() !== "*") {
        return mainConfigErrorResponse(
          "MAIN_CONFIG_CONFLICT",
          "If-None-Match 只接受 *",
          412,
        );
      }
      if (ifMatch) {
        return mainConfigErrorResponse(
          "MAIN_CONFIG_CONFLICT",
          "不存在主配置时不能使用 If-Match",
          412,
        );
      }
      expectedLatest = null; // must be absent
      isCreate = true;
    } else if (ifMatch) {
      const parsedEtag = parseSingleStrongEtag(ifMatch);
      if (!parsedEtag) {
        return mainConfigErrorResponse(
          "MAIN_CONFIG_CONFLICT",
          "If-Match 格式无效，只接受单个强 ETag",
          412,
        );
      }
      expectedLatest = parsedEtag; // must match this etag
    } else {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_PRECONDITION_REQUIRED",
        "必须提供 If-Match 或 If-None-Match: *",
        428,
      );
    }

    // Read body with size limit
    const maxSize =
      parseInt(env.MAX_MAIN_CONFIG_BYTES ?? "") || 2 * 1024 * 1024;
    let bodyText: string;
    try {
      const reader = request.body?.getReader();
      if (!reader) {
        return mainConfigErrorResponse(
          "INVALID_MAIN_CONFIG",
          "请求体为空",
          400,
        );
      }
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > maxSize) {
          reader.cancel();
          return mainConfigErrorResponse(
            "MAIN_CONFIG_TOO_LARGE",
            "请求体超过大小上限",
            413,
          );
        }
        chunks.push(value);
      }
      const all = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      bodyText = new TextDecoder().decode(all);
    } catch {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请求体读取失败",
        400,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请求体 JSON 格式无效",
        400,
      );
    }

    // Validate JSON root is a non-null object
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请求体必须是 JSON 对象",
        400,
      );
    }

    const bodyObj = body as Record<string, unknown>;

    try {
      const input: mcStorage.PublishMainConfigInput = {
        name: bodyObj.name as string,
        yaml: bodyObj.yaml as string,
        expectedLatest,
      };
      const result = await mcStorage.publishMainConfig(
        env.SUBSCRIPTION_BUCKET,
        input,
        undefined,
        maxSize,
      );

      return new Response(
        JSON.stringify({ ok: true, data: { versionId: result.versionId } }),
        {
          status: isCreate ? 201 : 200,
          headers: {
            "Content-Type": "application/json",
            ETag: httpEtag(result.etag),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // GET /api/main-config/history
  if (path === "/api/main-config/history" && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    try {
      const versions = await mcStorage.listMainConfigVersions(
        env.SUBSCRIPTION_BUCKET,
      );
      return new Response(JSON.stringify({ ok: true, data: versions }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // GET /api/main-config/versions/:versionId
  const mcVersionMatch = path.match(/^\/api\/main-config\/versions\/([^/]+)$/);
  if (mcVersionMatch && request.method === "GET") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const versionId = mcVersionMatch[1]!;
    if (!mcStorage.validateVersionId(versionId)) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_VERSION_NOT_FOUND",
        "versionId 格式无效",
        404,
      );
    }

    try {
      const result = await mcStorage.getMainConfigVersion(
        env.SUBSCRIPTION_BUCKET,
        versionId,
      );
      if (!result) {
        return mainConfigErrorResponse(
          "MAIN_CONFIG_VERSION_NOT_FOUND",
          "版本不存在",
          404,
        );
      }

      const { view, etag } = result;
      return new Response(JSON.stringify({ ok: true, data: view }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: httpEtag(etag),
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // POST /api/main-config/rollback
  if (path === "/api/main-config/rollback" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const ifMatch = request.headers.get("If-Match");
    if (!ifMatch) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_PRECONDITION_REQUIRED",
        "回滚必须提供 If-Match 头",
        428,
      );
    }
    const parsedEtag = parseSingleStrongEtag(ifMatch);
    if (!parsedEtag) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_CONFLICT",
        "If-Match 格式无效",
        412,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请求体 JSON 格式无效",
        400,
      );
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请求体必须是 JSON 对象",
        400,
      );
    }

    const bodyObj = body as Record<string, unknown>;
    if (!bodyObj.versionId || typeof bodyObj.versionId !== "string") {
      return mainConfigErrorResponse(
        "INVALID_MAIN_CONFIG",
        "请提供要回滚的 versionId",
        400,
      );
    }

    try {
      const result = await mcStorage.rollbackMainConfig(
        env.SUBSCRIPTION_BUCKET,
        bodyObj.versionId as string,
        parsedEtag,
      );

      return new Response(
        JSON.stringify({ ok: true, data: { versionId: result.versionId } }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: httpEtag(result.etag),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // POST /api/main-config/disable
  if (path === "/api/main-config/disable" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const ifMatch = request.headers.get("If-Match");
    if (!ifMatch) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_PRECONDITION_REQUIRED",
        "禁用必须提供 If-Match 头",
        428,
      );
    }
    const parsedEtag = parseSingleStrongEtag(ifMatch);
    if (!parsedEtag) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_CONFLICT",
        "If-Match 格式无效",
        412,
      );
    }

    try {
      const result = await mcStorage.disableMainConfig(
        env.SUBSCRIPTION_BUCKET,
        parsedEtag,
      );

      return new Response(
        JSON.stringify({ ok: true, data: { status: "disabled" } }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: httpEtag(result.etag),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  // POST /api/main-config/enable
  if (path === "/api/main-config/enable" && request.method === "POST") {
    if (!verifyAdminAuth(request, env)) {
      return errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401);
    }

    const ifMatch = request.headers.get("If-Match");
    if (!ifMatch) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_PRECONDITION_REQUIRED",
        "启用必须提供 If-Match 头",
        428,
      );
    }
    const parsedEtag = parseSingleStrongEtag(ifMatch);
    if (!parsedEtag) {
      return mainConfigErrorResponse(
        "MAIN_CONFIG_CONFLICT",
        "If-Match 格式无效",
        412,
      );
    }

    try {
      const result = await mcStorage.enableMainConfig(
        env.SUBSCRIPTION_BUCKET,
        parsedEtag,
      );

      return new Response(
        JSON.stringify({ ok: true, data: { status: "active" } }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: httpEtag(result.etag),
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (e) {
      return mainConfigErrorFromException(e);
    }
  }

  return null;
}

async function tryPersistImportedProviderOrder(
  bucket: R2Bucket,
  imported: Array<{ slug: string }>,
): Promise<void> {
  try {
    const importedSlugs = imported.map((provider) => provider.slug);
    const importedSet = new Set(importedSlugs);
    const existingOrder = await storage.getProviderOrder(bucket);
    await storage.saveProviderOrder(bucket, [
      ...importedSlugs,
      ...existingOrder.filter((slug) => !importedSet.has(slug)),
    ]);
  } catch (error) {
    console.error("provider-order:import-sync-failed", error);
  }
}

// --- Main Config helpers ---

/** Wrap raw etag value in quotes for HTTP ETag header. */
function httpEtag(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw;
  return `"${raw}"`;
}

const MC_HTTP_MAP: Record<string, number> = {
  INVALID_MAIN_CONFIG: 400,
  MAIN_CONFIG_TOO_LARGE: 413,
  MAIN_CONFIG_NOT_FOUND: 404,
  MAIN_CONFIG_VERSION_NOT_FOUND: 404,
  MAIN_CONFIG_PRECONDITION_REQUIRED: 428,
  MAIN_CONFIG_CONFLICT: 412,
  MAIN_CONFIG_OBJECT_CONFLICT: 409,
};

function mainConfigErrorResponse(
  code: string,
  message: string,
  status?: number,
): Response {
  const s = status ?? MC_HTTP_MAP[code] ?? 500;
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function mainConfigErrorFromException(e: unknown): Response {
  if (e instanceof mcStorage.MainConfigError) {
    const s = MC_HTTP_MAP[e.code] ?? 500;
    const safeMsg = mcStorage.getSafeErrorMessage(e.code);
    return new Response(
      JSON.stringify({ ok: false, error: { code: e.code, message: safeMsg } }),
      {
        status: s,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务器内部错误" },
    }),
    {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Parse a single strong ETag. Returns the value or null if invalid. */
function parseSingleStrongEtag(value: string): string | null {
  const trimmed = value.trim();
  // Strong ETag: "value" (no W/ prefix)
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  if (trimmed.startsWith("W/")) return null;
  // Reject multiple ETags
  if (trimmed.includes('", "')) return null;
  // Return inner value
  return trimmed.slice(1, -1);
}

function unifiedExportErrorResponse(e: unknown): Response {
  if (e instanceof UnifiedExportError) {
    const status = UNIFIED_ERROR_HTTP[e.code] ?? 500;
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: e.code, message: e.message },
      }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "UNIFIED_EXPORT_GENERATION_FAILED",
        message: "导出生成失败",
      },
    }),
    {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
