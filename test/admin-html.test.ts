import { describe, expect, it } from "vitest";
import { getAdminHtml } from "../src/ui/admin-html.ts";

describe("admin unified import UI", () => {
  it("emits syntactically valid inline JavaScript", () => {
    const html = getAdminHtml();
    const start = html.indexOf("<script>") + "<script>".length;
    const end = html.indexOf("</script>", start);
    const script = html.slice(start, end);

    expect(start).toBeGreaterThan("<script>".length - 1);
    expect(end).toBeGreaterThan(start);
    expect(() => new Function(script)).not.toThrow();
  });

  it("renders one ZIP upload entry using the sealed import contract", () => {
    const html = getAdminHtml();

    expect(html).toContain('id="import-file"');
    expect(html).toContain('accept=".zip,application/zip"');
    expect(html).toContain("authenticatedFetch('/api/unified-import'");
    expect(html).toContain("'Content-Type': 'application/zip'");
    expect(html).toContain("body: file");
    expect(html).toContain("credentials: 'same-origin'");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toContain("multipart/form-data");
  });

  it("requires confirmation and renders success, errors, and partial commits", () => {
    const html = getAdminHtml();

    expect(html).toContain("confirm('确认导入“'");
    expect(html).toContain("result.data?.providers");
    expect(html).toContain("result.data?.committedProviders");
    expect(html).toContain("部分订阅已提交，随后发生并发冲突");
    expect(html).toContain("服务器响应格式无效");
  });

  it("keeps the token out of URLs and visible import output", () => {
    const html = getAdminHtml();
    const importBlock = html.slice(
      html.indexOf("async function doUnifiedImport"),
    );

    expect(importBlock).not.toContain("?token=");
    expect(importBlock).not.toContain("URLSearchParams");
    expect(importBlock).not.toContain("TOKEN + '/api");
    expect(importBlock).not.toContain("JSON.stringify(TOKEN)");
  });

  it("exposes unified export and WebDAV sync without the obsolete R2 export", () => {
    const html = getAdminHtml();

    expect(html).toContain("导出通用母包");
    expect(html).toContain("/api/unified-export");
    expect(html).toContain("WebDAV 同步");
    expect(html).toContain("/api/webdav/push");
    expect(html).not.toContain("/api/export");
  });

  it("does not expose obsolete manual main config management", () => {
    const html = getAdminHtml();

    expect(html).not.toContain('data-tab="main-config"');
    expect(html).not.toContain('id="main-config-yaml"');
    expect(html).not.toContain("无需维护主配置");
  });

  it("keeps history actions local and backup cards concise", () => {
    const html = getAdminHtml();
    const backup = html.slice(
      html.indexOf('id="tab-backup"'),
      html.indexOf("<!-- Add subscription"),
    );

    expect(html).toContain("下载完整配置");
    expect(html).toContain(
      "cachedHistoryEntries = cachedHistoryEntries.filter",
    );
    expect(html).toContain("loadHistory({ silent: true })");
    expect(backup.indexOf("WebDAV 同步")).toBeLessThan(
      backup.indexOf("导出通用母包"),
    );
    expect(backup.indexOf("导出通用母包")).toBeLessThan(
      backup.indexOf("导入统一母包"),
    );
    expect(backup).toContain("导出当前全部订阅的统一母包。");
    expect(backup).toContain("选择并导入统一母包 ZIP。");
  });

  it("updates provider views without replacing them with a loading screen", () => {
    const html = getAdminHtml();

    expect(html).toContain("queueMicrotask(() => checkSession())");
    expect(html).toContain("renderProviders(cachedProviders.filter");
    expect(html).toContain("loadProviders({ silent: true })");
    expect(html).toContain("name === 'list' && !providersLoaded");
    expect(html).toContain("name === 'history' && !historyLoaded");
    expect(html).toContain("name === 'backup' && !webdavLoaded");
  });

  it("uses username and password with a short server-side session", () => {
    const html = getAdminHtml();

    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain("/api/auth/login");
    expect(html).toContain("/api/auth/session");
    expect(html).toContain("/api/auth/logout");
    expect(html).toContain("显示密码");
    expect(html).toContain("登录状态最长保留 8 小时");
    expect(html).toContain("使用提醒");
    expect(html).toContain("如需共享，请仅提供给你信任的人");
    expect(html).not.toContain("ADMIN_TOKEN");
    expect(html).not.toContain("admin_token");
  });

  it("supports ordered subscriptions and the final copy wording", () => {
    const html = getAdminHtml();

    expect(html).toContain("拖动排序");
    expect(html).toContain("/api/providers/order");
    // The everyday action is the primary button; the long description moved to
    // the title attribute so it is still discoverable.
    expect(html).toContain(">复制完整配置</button>");
    expect(html).toContain("复制完整配置链接（Clash / Shadowrocket 通用配置）");
    expect(html).toContain("复制 Provider 链接（mihomo proxy-providers 用）");
    expect(html).toContain("顺序已保存");
    expect(html).toContain("touchstart");
    expect(html).toContain("document.ontouchmove");
    expect(html).toContain("target.parentElement.insertBefore");
    expect(html).toContain("window.matchMedia('(pointer: fine)').matches");
    expect(html).toContain("max-width: 1200px");
    expect(html).toContain("padding: 24px 32px");
    expect(html).toContain("width: 48px");
    expect(html).toContain(".order-number { display: none; }");
    expect(html).toContain(
      "#history-list .btn-group { justify-content: flex-end; }",
    );
    expect(html).toContain("elementFromPoint");
    expect(html).toContain("subscription-card");
    expect(html).not.toContain("width: fit-content");
  });

  it("keeps row actions inline with one primary action per row", () => {
    const html = getAdminHtml();

    // No overflow menu: every action stays one click away.
    expect(html).not.toContain("overflow-menu");
    // Destructive actions are no longer the loudest thing in the row.
    expect(html).not.toContain("btn btn-danger btn-sm");
    const providers = html.slice(
      html.indexOf("function renderProviders"),
      html.indexOf("function bindProviderSorting"),
    );
    expect(providers.match(/btn-primary/g)).toHaveLength(1);
    const keys = html.slice(
      html.indexOf("function renderLlmKeys"),
      html.indexOf("async function loadLlmKeys"),
    );
    expect(keys.match(/btn-primary/g)).toHaveLength(1);
  });

  it("stacks list rows on narrow screens instead of squeezing the table", () => {
    const html = getAdminHtml();

    expect(html).toContain('class="table table-stack"');
    expect(html).toContain(".table-stack thead { display: none; }");
    expect(html).toContain(".table-stack .cell-primary {");
    expect(html).toContain('content: attr(data-label) " "');
    expect(html).toContain(".table-stack .btn-group { flex-wrap: wrap;");
    // The name cell must never collapse to one character per line again.
    expect(html).toContain('class="cell-primary"');
    // Fields share a row instead of one full-width input per line.
    expect(html).toContain(".form-grid {");
    expect(html).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))",
    );
  });

  it("uses the shared User-Agent presets without exposing slug in edit", () => {
    const html = getAdminHtml();
    const edit = html.slice(
      html.indexOf('id="edit-modal"'),
      html.indexOf('id="meta-modal"'),
    );

    expect(html).toContain('value="clash-verge/v2.4.5"');
    expect(html).toContain('value="clash.meta/1.19.20"');
    expect(html).toContain('value="SlClash clash-verge Platform/android"');
    expect(html).toContain('value="__custom__"');
    expect(edit).not.toContain("edit-slug");
    expect(edit).toContain("订阅地址");
  });
});

describe("admin LLM credential UI", () => {
  it("adds a separate tab without disturbing the subscription table", () => {
    const html = getAdminHtml();

    expect(html).toContain('data-tab="llm"');
    expect(html).toContain('id="tab-llm"');
    expect(html).toContain("大模型密钥");
    expect(html).toContain('id="llm-keys-list"');
    expect(html).toContain('id="llm-modal"');
    expect(html).toContain('id="llm-store-note"');
    // The subscription list keeps its own markup and tab.
    expect(html).toContain("subscription-card");
    expect(html).toContain('data-tab="list"');
  });

  it("orders the credential tab directly after the subscription list", () => {
    const html = getAdminHtml();
    const tabs = html.slice(
      html.indexOf('<div class="tabs">'),
      html.indexOf("</div>", html.indexOf('<div class="tabs">')),
    );

    expect(tabs.indexOf('data-tab="list"')).toBeGreaterThan(-1);
    expect(tabs.indexOf('data-tab="llm"')).toBeGreaterThan(
      tabs.indexOf('data-tab="list"'),
    );
    expect(tabs.indexOf('data-tab="llm"')).toBeLessThan(
      tabs.indexOf('data-tab="history"'),
    );
    expect(tabs.indexOf('data-tab="llm"')).toBeLessThan(
      tabs.indexOf('data-tab="backup"'),
    );
    // 大模型密钥 tab content is placed right after the subscription list pane.
    expect(html.indexOf('id="tab-llm"')).toBeGreaterThan(
      html.indexOf('id="tab-list"'),
    );
    expect(html.indexOf('id="tab-llm"')).toBeLessThan(
      html.indexOf('id="tab-history"'),
    );
  });

  it("keeps the credential form down to name, slug and API key", () => {
    const html = getAdminHtml();
    const pane = html.slice(
      html.indexOf('id="tab-llm"'),
      html.indexOf('id="add-subscription-section"'),
    );

    // Mirrors the 添加订阅 card: same section/card/form-group markup.
    expect(pane).toContain('<div class="section-title">添加大模型密钥</div>');
    expect(pane).toContain('class="form-group"');
    expect(pane).toContain('id="llm-add-name"');
    expect(pane).toContain('id="llm-add-slug"');
    expect(pane).toContain('id="llm-add-key"');
    expect(pane).toContain(">保存并添加</button>");
    expect(pane).toContain('<div class="card-header">');
    expect(pane).toContain('id="llm-keys-list"');
    // The removed fields must not come back.
    expect(pane).not.toContain("平台标识");
    expect(pane).not.toContain("Base URL");
    expect(pane).not.toContain("llm-add-provider");
    expect(pane).not.toContain("llm-add-models");
    // Subscription add form stays out of this pane.
    expect(pane).not.toContain('id="add-subscription-section"');
  });

  it("mirrors the subscription table's mobile horizontal scroll", () => {
    const html = getAdminHtml();

    // The subscription list scrolls sideways inside its card; the credential
    // list must use the exact same three rules or the columns get squeezed.
    expect(html).toContain(
      "#providers-list, #history-list { overflow-x: auto; }",
    );
    expect(html).toContain("#llm-keys-list { overflow-x: auto; }");
    expect(html).toContain(
      "#providers-list .btn, #history-list .btn { white-space: nowrap; }",
    );
    expect(html).toContain("#llm-keys-list .btn { white-space: nowrap; }");
    expect(html).toContain("#llm-keys-list th:last-child,");
    expect(html).toContain(
      "#llm-keys-list td:last-child { text-align: right; }",
    );
    expect(html).toContain(
      "#llm-keys-list .btn-group { justify-content: flex-end; }",
    );
  });

  it("keeps the sealed credential rules in the inline script", () => {
    const html = getAdminHtml();

    expect(html).toContain("'/api/llm/keys'");
    expect(html).toContain("navigator.clipboard");
    expect(html).toContain("confirm('确认删除“'");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toContain("ADMIN_TOKEN");
    expect(html).not.toContain("admin_token");
  });

  it("reads plaintext through POST and never through a URL", () => {
    const html = getAdminHtml();
    const start = html.indexOf("async function fetchLlmSecret");
    const end = html.indexOf("async function removeLlmKey", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = html.slice(start, end);

    expect(block).toContain("method: 'POST'");
    expect(block).toContain("navigator.clipboard.writeText(llmViewSecret)");
    expect(block).not.toContain("?apiKey=");
    expect(block).not.toContain("localStorage");
  });

  it("keeps the viewer to the key plus copy/close only", () => {
    const html = getAdminHtml();
    const modal = html.slice(
      html.indexOf('id="llm-view-modal"'),
      html.indexOf('id="llm-modal"'),
    );

    expect(modal).toContain('id="llm-view-title"');
    expect(modal).toContain('class="modal-subtitle">API Key<');
    expect(modal).toContain('id="llm-view-secret"');
    expect(modal).toContain('onclick="copyLlmPlain()"');
    expect(modal).toContain('onclick="closeLlmView()"');
    // Compact popup, and exactly two actions.
    expect(modal).toContain('class="modal modal-sm"');
    expect(modal).not.toContain('id="llm-view-name"');
    expect(modal).not.toContain('id="llm-view-slug"');
    expect(modal).not.toContain("toggleLlmPlain");
    expect(modal.match(/<button/g)).toHaveLength(2);
    // The value is fetched at open time, never rendered server-side.
    expect(modal).not.toContain("apiKey");

    // Row action opens the viewer; naming matches what it does.
    expect(html).toContain("openLlmView(");
    expect(html).toContain(">查看/复制</button>");
    expect(html).not.toContain("查看并复制");
    expect(html).not.toContain("copyLlmKey");
  });

  it("verifies the session before revealing the shell, then prefetches", () => {
    const html = getAdminHtml();
    const check = html.slice(
      html.indexOf("async function checkSession"),
      html.indexOf("async function doLogout"),
    );

    // No flash of the admin layout on an unauthenticated visit: the session is
    // checked first, so the login form stays up until it is confirmed.
    expect(check.indexOf("await fetch('/api/auth/session'")).toBeLessThan(
      check.indexOf("showMainScreen()"),
    );
    expect(check).toContain("showLoadingPlaceholders()");
    expect(check).toContain("await loadAllViews()");

    // One up-front pass fills every tab so switching is instant.
    const all = html.slice(
      html.indexOf("async function loadAllViews"),
      html.indexOf("async function checkSession"),
    );
    expect(all).toContain("loadProviders()");
    expect(all).toContain("loadLlmKeys({ silent: true })");
    expect(all).toContain("loadHistory({ silent: true })");
    expect(all).toContain("loadWebDAVConfig()");
    expect(html).toContain("function showLoadingPlaceholders()");
    expect(html).toContain("加载中...");
  });

  it("reflects credential mutations locally instead of refetching", () => {
    const html = getAdminHtml();

    expect(html).toContain("function upsertLlmKeyLocal");
    expect(html).toContain("function removeLlmKeyLocal");

    const add = html.slice(
      html.indexOf("async function saveLlmKey"),
      html.indexOf("async function saveLlmEdit"),
    );
    expect(add).toContain("upsertLlmKeyLocal");
    expect(add).not.toContain("loadLlmKeys({ silent: true })");

    const edit = html.slice(
      html.indexOf("async function saveLlmEdit"),
      html.indexOf("// --- View a credential ---"),
    );
    expect(edit).toContain("upsertLlmKeyLocal");
    expect(edit).not.toContain("loadLlmKeys({ silent: true })");

    const remove = html.slice(html.indexOf("async function removeLlmKey"));
    expect(remove).toContain("removeLlmKeyLocal");
    expect(remove).not.toContain("loadLlmKeys({ silent: true })");
  });

  it("reflects subscription updates locally too", () => {
    const html = getAdminHtml();
    expect(html).toContain("function upsertProviderLocal");

    const quiet = html.slice(
      html.indexOf("async function quickUpdate"),
      html.indexOf("// --- Copy links ---"),
    );
    expect(quiet).toContain("upsertProviderLocal");

    const form = html.slice(
      html.indexOf("async function doUpdate"),
      html.indexOf("// --- History ---"),
    );
    expect(form).toContain("upsertProviderLocal");

    // The reconcile still runs, just without blocking the render.
    expect(quiet).toContain("loadProviders({ silent: true })");
    expect(form).toContain("loadProviders({ silent: true })");
  });

  it("inserts the new credential before the server confirms, and rolls back", () => {
    const html = getAdminHtml();
    const add = html.slice(
      html.indexOf("async function saveLlmKey"),
      html.indexOf("async function saveLlmEdit"),
    );

    // The row is rendered on the click's tick, before the POST is awaited.
    expect(add.indexOf("upsertLlmKeyLocal(optimistic)")).toBeLessThan(
      add.indexOf("await api('/api/llm/keys'"),
    );
    // A rejected create must restore the previous state, not drop an existing
    // credential that happened to share the slug.
    expect(add).toContain("if (previous) upsertLlmKeyLocal(previous)");
    expect(add).toContain("else removeLlmKeyLocal(slug)");
  });

  it("titles the viewer with the credential name", () => {
    const html = getAdminHtml();
    const start = html.indexOf("async function openLlmView");
    const end = html.indexOf("async function copyLlmPlain", start);
    const block = html.slice(start, end);

    expect(block).toContain(
      "document.getElementById('llm-view-title').textContent",
    );
    expect(block).toContain("cached && cached.name ? cached.name : slug");
    // Name comes from the list cache, so it renders before the key arrives.
    expect(block).toContain("llmKeys.filter");
  });

  it("reveals the full key as soon as the viewer opens", () => {
    const html = getAdminHtml();
    const start = html.indexOf("async function openLlmView");
    const end = html.indexOf("async function copyLlmPlain", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = html.slice(start, end);

    // No second confirmation step: opening the popup shows the plaintext.
    expect(block).toContain("box.textContent = llmViewSecret");
    expect(block).not.toContain("LLM_MASK");
    expect(block).not.toContain("显示");
  });

  it("points at the on-screen value when the clipboard is blocked", () => {
    const html = getAdminHtml();
    const start = html.indexOf("async function copyLlmPlain");
    const end = html.indexOf("function closeLlmView", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = html.slice(start, end);

    // The value is already visible, so the fallback must not inject plaintext
    // into the status line.
    expect(block).toContain("请长按上方密钥手动复制");
    expect(block).not.toContain("+ llmViewSecret");
  });

  it("drops the plaintext when the viewer closes", () => {
    const html = getAdminHtml();
    const closeStart = html.indexOf("function closeLlmView");
    expect(closeStart).toBeGreaterThan(-1);
    const closeBlock = html.slice(closeStart, closeStart + 400);

    expect(closeBlock).toContain("llmViewSecret = null");
    expect(closeBlock).toContain(
      "document.getElementById('llm-view-secret').textContent = ''",
    );
    expect(closeBlock).toContain("classList.remove('show')");
  });

  it("wraps long credential values so the modal survives narrow screens", () => {
    const html = getAdminHtml();

    expect(html).toContain(".secret-value {");
    expect(html).toContain("word-break: break-all;");
    expect(html).toContain("overflow-wrap: anywhere;");
    expect(html).toContain("user-select: all;");
    expect(html).toContain(".modal-sm {");
    // Modal action row must be able to wrap on small screens.
    expect(html).toContain(
      "justify-content:flex-end;margin-top:14px;flex-wrap:wrap",
    );
  });
});
