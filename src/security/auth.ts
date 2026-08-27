import type { Env } from "../types.ts";
import { verifyToken } from "./tokens.ts";

export function getBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export function verifyAdminAuth(request: Request, env: Env): boolean {
  const token = getBearerToken(request);
  if (!token) return false;
  return verifyToken(token, env.ADMIN_TOKEN);
}

export function verifyDownloadAuth(url: URL, env: Env): boolean {
  const token = url.pathname.split("/").pop();
  if (!token) return false;
  return verifyToken(token, env.DOWNLOAD_TOKEN);
}
