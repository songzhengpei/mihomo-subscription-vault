import type { Env } from "../types.ts";
import {
  createInstanceConfiguration,
  hasLegacyConfiguration,
  isInstanceConfigured,
  secretsMatch,
} from "../services/instance-config.ts";

const MAX_SETUP_BODY_BYTES = 4096;

interface SetupBody {
  instanceSecret: string;
  username: string;
  password: string;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function setupPageResponse(secretAvailable: boolean): Response {
  const disabled = secretAvailable ? "" : " disabled";
  const notice = secretAvailable
    ? "请输入部署时设置的 INSTANCE_SECRET，然后创建管理员账号。"
    : "部署缺少 INSTANCE_SECRET。请先在 Worker 的 Variables and Secrets 中添加至少 32 字节的 Secret。";
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>初始化 · Mihomo Subscription Vault</title>
  <style>
    :root{color-scheme:light;--bg:#f4f7fb;--card:#fff;--text:#172033;--muted:#64748b;--line:#dbe3ef;--primary:#2563eb;--danger:#b91c1c}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#eef4ff,#f8fafc 55%,#ecfeff);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
    main{width:min(520px,calc(100% - 32px));background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px;box-shadow:0 20px 60px rgba(15,23,42,.10)}
    h1{font-size:25px;margin:0 0 8px}p{color:var(--muted);margin:0 0 24px}.field{margin:16px 0}label{display:block;font-weight:650;margin-bottom:7px}input{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit}input:focus{outline:3px solid #dbeafe;border-color:var(--primary)}button{width:100%;border:0;border-radius:10px;padding:12px 16px;background:var(--primary);color:#fff;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.message{min-height:24px;margin-top:14px;color:var(--danger);white-space:pre-wrap}.result{display:none;margin-top:20px;padding:16px;background:#f8fafc;border:1px solid var(--line);border-radius:12px}.result code{display:block;overflow-wrap:anywhere;margin:6px 0 14px;color:#0f172a}.result a{color:var(--primary);font-weight:700}
  </style>
</head>
<body>
  <main>
    <h1>初始化 Vault</h1>
    <p>${notice}</p>
    <form id="setup-form">
      <div class="field"><label for="instance-secret">INSTANCE_SECRET</label><input id="instance-secret" type="password" autocomplete="off" required${disabled}></div>
      <div class="field"><label for="username">管理员用户名</label><input id="username" value="admin" minlength="3" maxlength="64" autocomplete="username" required${disabled}></div>
      <div class="field"><label for="password">管理员密码</label><input id="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required${disabled}></div>
      <div class="field"><label for="password-confirm">确认密码</label><input id="password-confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required${disabled}></div>
      <button id="submit" type="submit"${disabled}>完成初始化</button>
    </form>
    <div id="message" class="message" role="alert"></div>
    <section id="result" class="result">
      <strong>初始化完成</strong>
      <p>以下 API Token 只显示一次；普通网页使用不需要它。</p>
      <code id="admin-token"></code>
      <p>Provider 下载 Token：</p>
      <code id="download-token"></code>
      <a href="/admin">进入管理后台 →</a>
    </section>
  </main>
  <script>
    const form=document.getElementById('setup-form');
    form.addEventListener('submit',async(event)=>{
      event.preventDefault();
      const message=document.getElementById('message');
      const button=document.getElementById('submit');
      const password=document.getElementById('password').value;
      if(password!==document.getElementById('password-confirm').value){message.textContent='两次输入的密码不一致';return}
      message.textContent='';button.disabled=true;
      try{
        const response=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instanceSecret:document.getElementById('instance-secret').value,username:document.getElementById('username').value,password})});
        const body=await response.json();
        if(!response.ok||!body.ok)throw new Error(body.error?.message||'初始化失败');
        document.getElementById('admin-token').textContent=body.data.adminToken;
        document.getElementById('download-token').textContent=body.data.downloadToken;
        document.getElementById('result').style.display='block';
        form.style.display='none';
      }catch(error){message.textContent=error instanceof Error?error.message:'初始化失败';button.disabled=false}
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    },
  });
}

async function readSetupBody(request: Request): Promise<SetupBody | null> {
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
    declaredLength > MAX_SETUP_BODY_BYTES
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
      if (length > MAX_SETUP_BODY_BYTES) {
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
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null) return null;
    const body = value as Record<string, unknown>;
    if (
      typeof body.instanceSecret !== "string" ||
      body.instanceSecret.length === 0 ||
      body.instanceSecret.length > 1024 ||
      typeof body.username !== "string" ||
      typeof body.password !== "string"
    ) {
      return null;
    }
    const username = body.username.trim();
    if (
      username.length < 3 ||
      username.length > 64 ||
      body.password.length < 12 ||
      body.password.length > 128
    ) {
      return null;
    }
    return {
      instanceSecret: body.instanceSecret,
      username,
      password: body.password,
    };
  } catch {
    return null;
  }
}

export async function handleSetupRoute(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/setup") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }
    const configured = await isInstanceConfigured(env);
    if (configured) {
      return Response.redirect(new URL("/admin", request.url).toString(), 302);
    }
    const secretAvailable =
      typeof env.INSTANCE_SECRET === "string" &&
      new TextEncoder().encode(env.INSTANCE_SECRET).length >= 32;
    return setupPageResponse(secretAvailable);
  }

  if (path !== "/api/setup") return null;
  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
      405,
    );
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return jsonResponse(
      { ok: false, error: { code: "FORBIDDEN", message: "来源无效" } },
      403,
    );
  }
  if (hasLegacyConfiguration(env) || (await isInstanceConfigured(env))) {
    return jsonResponse(
      {
        ok: false,
        error: { code: "ALREADY_CONFIGURED", message: "实例已完成初始化" },
      },
      409,
    );
  }
  if (
    typeof env.INSTANCE_SECRET !== "string" ||
    new TextEncoder().encode(env.INSTANCE_SECRET).length < 32
  ) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "INSTANCE_SECRET_REQUIRED",
          message: "请先配置至少 32 字节的 INSTANCE_SECRET",
        },
      },
      503,
    );
  }
  const body = await readSetupBody(request);
  if (!body) {
    return jsonResponse(
      {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "初始化信息格式无效" },
      },
      400,
    );
  }
  if (!(await secretsMatch(body.instanceSecret, env.INSTANCE_SECRET))) {
    return jsonResponse(
      {
        ok: false,
        error: { code: "INVALID_SECRET", message: "INSTANCE_SECRET 不正确" },
      },
      401,
    );
  }
  try {
    const credentials = await createInstanceConfiguration(
      env,
      body.username,
      body.password,
    );
    return jsonResponse({ ok: true, data: credentials }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "初始化失败";
    const conflict = message === "实例已完成初始化";
    return jsonResponse(
      {
        ok: false,
        error: {
          code: conflict ? "ALREADY_CONFIGURED" : "SETUP_FAILED",
          message: conflict ? message : "初始化失败，请稍后重试",
        },
      },
      conflict ? 409 : 500,
    );
  }
}
