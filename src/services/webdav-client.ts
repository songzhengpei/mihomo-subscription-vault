/**
 * Minimal WebDAV client for Cloudflare Workers.
 * Uses native fetch with custom HTTP methods (MKCOL, PROPFIND).
 * Basic Auth only — no extra dependencies.
 */
import type { WebDAVConfig } from "../types.ts";

function authHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface WebDAVFailure {
  ok: false;
  error?: string;
}

export type WebDAVResult = { ok: true } | WebDAVFailure;

async function davRequest(
  config: WebDAVConfig,
  method: string,
  path: string,
  body?: string | Uint8Array | Blob,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = `${config.url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {
    Authorization: authHeader(config.username, config.password),
    ...extraHeaders,
  };
  if (body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] =
      typeof body === "string" ? "text/xml" : "application/octet-stream";
  }
  const resp = await fetch(url, {
    method,
    headers,
    body: body as BodyInit | undefined,
    redirect: "manual",
  });
  // Following a redirect would replay the Basic Auth header — and, on PUT, the
  // whole backup archive — against whatever host the server names.
  if (resp.status >= 300 && resp.status < 400) {
    throw new Error(
      `服务器返回重定向 (${resp.status})，为避免凭据泄露已拒绝跟随，请在配置中直接填写最终地址`,
    );
  }
  return resp;
}

async function mkdir(
  config: WebDAVConfig,
  dirPath: string,
): Promise<WebDAVResult> {
  try {
    const resp = await davRequest(config, "MKCOL", dirPath);
    // 2xx = created, 405 = already exists, 403 = Cloudflare blocks outbound HTTP (proceed to PUT)
    if (resp.ok || resp.status === 405 || resp.status === 403)
      return { ok: true } as const;
    if (resp.status === 409)
      return { ok: false, error: `父目录不存在: ${dirPath}` };
    return {
      ok: false,
      error: `MKCOL 失败 (${resp.status}): ${await resp.text()}`,
    };
  } catch (err) {
    return { ok: false, error: `MKCOL 网络错误: ${normalizeError(err)}` };
  }
}

async function upload(
  config: WebDAVConfig,
  filePath: string,
  data: Uint8Array,
): Promise<WebDAVResult> {
  try {
    const resp = await davRequest(config, "PUT", filePath, new Blob([data]), {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.length),
    });
    if (resp.ok) return { ok: true } as const;
    return {
      ok: false,
      error: `PUT 失败 (${resp.status}): ${await resp.text()}`,
    };
  } catch (err) {
    return { ok: false, error: `PUT 网络错误: ${normalizeError(err)}` };
  }
}

async function download(
  config: WebDAVConfig,
  filePath: string,
): Promise<{ ok: true; data: Uint8Array } | WebDAVFailure> {
  try {
    const resp = await davRequest(config, "GET", filePath);
    if (!resp.ok) {
      if (resp.status === 404)
        return { ok: false, error: `文件不存在: ${filePath}` };
      return {
        ok: false,
        error: `GET 失败 (${resp.status}): ${await resp.text()}`,
      };
    }
    return { ok: true, data: new Uint8Array(await resp.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: `GET 网络错误: ${normalizeError(err)}` };
  }
}

export async function testConnection(
  config: WebDAVConfig,
): Promise<WebDAVResult> {
  const dirPath = config.remotePath.split("/").slice(0, -1).join("/") || "";
  if (!dirPath) return { ok: false, error: "无法从 remotePath 解析目录" };

  try {
    const resp = await davRequest(
      config,
      "PROPFIND",
      dirPath,
      '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      {
        Depth: "0",
      },
    );
    if (resp.ok || resp.status === 207) return { ok: true } as const;
    if (resp.status === 401) return { ok: false, error: "认证失败 (401)" };
    if (resp.status === 404)
      return { ok: false, error: `目录不存在: ${dirPath}` };
    // 403 = Cloudflare blocks PROPFIND, but connection is reachable
    if (resp.status === 403) return { ok: true };
    return { ok: false, error: `PROPFIND 失败 (${resp.status})` };
  } catch (err) {
    return { ok: false, error: `连接失败: ${normalizeError(err)}` };
  }
}

export function timestampFileName(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d{3}Z$/, "");
  return `O-worker-backup-${ts}.zip`;
}

export async function pushBackup(
  config: WebDAVConfig,
  zipData: Uint8Array,
): Promise<WebDAVResult> {
  const dirPath = config.remotePath.split("/").slice(0, -1).join("/");
  if (!dirPath) return { ok: false, error: "无法从 remotePath 解析目录" };

  // MKCOL to ensure directory exists — best effort, ignore failures (403/405 are expected)
  await mkdir(config, dirPath);

  // Use timestamped filename instead of fixed name
  const fileName = timestampFileName();
  const remotePath = `${dirPath}/${fileName}`;
  return upload(config, remotePath, zipData);
}

export async function pullBackup(
  config: WebDAVConfig,
  fileName?: string,
): Promise<{ ok: true; data: Uint8Array } | WebDAVFailure> {
  const filePath = fileName
    ? `${config.remotePath.split("/").slice(0, -1).join("/")}/${fileName}`
    : config.remotePath;
  return download(config, filePath);
}

export interface WebDAVFileEntry {
  name: string;
  href: string;
  size: number;
  lastModified: string;
}

export async function listFiles(
  config: WebDAVConfig,
): Promise<{ ok: true; files: WebDAVFileEntry[] } | WebDAVFailure> {
  const dirPath = config.remotePath.split("/").slice(0, -1).join("/") || "";
  if (!dirPath) return { ok: false, error: "无法从 remotePath 解析目录" };

  try {
    const resp = await davRequest(
      config,
      "PROPFIND",
      dirPath,
      '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/></prop></propfind>',
      { Depth: "1" },
    );
    if (!resp.ok && resp.status !== 207) {
      return { ok: false, error: `PROPFIND 失败 (${resp.status})` };
    }
    const xml = await resp.text();
    const files: WebDAVFileEntry[] = [];
    const responseBlocks = xml.split(/<D:response>/).slice(1);
    for (const block of responseBlocks) {
      const hrefMatch = block.match(/<D:href>(.*?)<\/D:href>/);
      if (!hrefMatch) continue;
      const href = hrefMatch[1]!;
      if (href.endsWith("/")) continue; // skip directories
      const name = decodeURIComponent(href.split("/").pop() || "");
      if (!name.endsWith(".zip")) continue;
      const sizeMatch = block.match(
        /<D:getcontentlength>(.*?)<\/D:getcontentlength>/,
      );
      const dateMatch = block.match(
        /<D:getlastmodified>(.*?)<\/D:getlastmodified>/,
      );
      files.push({
        name,
        href,
        size: sizeMatch ? parseInt(sizeMatch[1]!, 10) : 0,
        lastModified: dateMatch ? dateMatch[1]! : "",
      });
    }
    files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: `列表失败: ${normalizeError(err)}` };
  }
}
