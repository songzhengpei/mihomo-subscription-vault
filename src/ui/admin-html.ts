export function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>订阅管理中心</title>
  <style>
    :root {
      --bg: #f5f5f5;
      --surface: #ffffff;
      --surface-2: #f0f0f0;
      --border: #e0e0e0;
      --text: #1a1a1a;
      --text-dim: #666;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --success: #16a34a;
      --warning: #d97706;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 16px;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 32px 80px;
    }

    header {
      text-align: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
      margin-bottom: 28px;
    }

    h1 {
      font-size: 26px;
      font-weight: 700;
    }

    .subtitle {
      color: var(--text-dim);
      font-size: 15px;
      margin-top: 6px;
    }

    /* Auth */
    #auth-screen {
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
    }

    .auth-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 32px;
      width: 100%;
      max-width: 460px;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
    }

    .auth-box h2 {
      font-size: 24px;
      margin-bottom: 8px;
      text-align: center;
    }

    .auth-box .auth-sub {
      color: var(--text-dim);
      font-size: 14px;
      margin-bottom: 24px;
      text-align: center;
    }

    .auth-notice {
      background: #fffbeb;
      border: 1px solid #fcd34d;
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 24px;
      color: #78350f;
      font-size: 14px;
      line-height: 1.65;
    }

    .auth-notice strong {
      display: block;
      color: #92400e;
      margin-bottom: 3px;
    }

    .auth-field {
      margin-bottom: 16px;
    }

    .auth-field label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 7px;
    }

    .auth-box input {
      width: 100%;
      min-height: 46px;
      padding: 11px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 16px;
    }

    .auth-box input:focus {
      outline: 3px solid rgba(37, 99, 235, 0.16);
      border-color: var(--primary);
    }

    .password-wrap { position: relative; }
    .password-wrap input { padding-right: 68px; }
    .password-toggle {
      position: absolute;
      top: 50%;
      right: 5px;
      transform: translateY(-50%);
      min-width: 54px;
      min-height: 36px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--primary);
      font-size: 14px;
      cursor: pointer;
    }
    .password-toggle:hover { background: rgba(37, 99, 235, 0.08); }
    .password-toggle:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 1px;
    }

    .auth-error {
      min-height: 22px;
      margin: -4px 0 12px;
      color: var(--danger);
      font-size: 14px;
      line-height: 1.5;
    }

    .auth-session-note {
      color: var(--text-dim);
      font-size: 13px;
      text-align: center;
      margin-top: 12px;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }

    .tab {
      padding: 10px 20px;
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 15px;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }

    .tab:hover { color: var(--text); }
    .tab.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
    }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 20px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
    }

    .card-title {
      font-size: 17px;
      font-weight: 600;
    }

    /* Table */
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 15px;
    }

    .table th, .table td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    .table th {
      color: var(--text-dim);
      font-weight: 500;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .table tr:hover td {
      background: var(--surface-2);
    }

    .mono {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 14px;
    }

    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
    }

    .badge-current {
      background: rgba(34, 197, 94, 0.15);
      color: var(--success);
    }

    /* Form */
    .form-group {
      margin-bottom: 16px;
    }

    .form-group label {
      display: block;
      font-size: 14px;
      color: var(--text-dim);
      margin-bottom: 6px;
    }

    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 10px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 15px;
    }

    .form-group textarea {
      min-height: 360px;
      resize: vertical;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      line-height: 1.5;
    }

    .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
      outline: none;
      border-color: var(--primary);
    }

    .btn {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
    }

    .btn-primary:hover { background: var(--primary-hover); }

    .btn-danger {
      background: var(--danger);
      color: white;
    }

    .btn-danger:hover { background: var(--danger-hover); }

    .btn-sm {
      padding: 6px 12px;
      font-size: 13px;
    }

    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
    }

    .btn-outline:hover {
      border-color: var(--text-dim);
      color: var(--text);
    }

    .btn-group {
      display: flex;
      gap: 6px;
      flex-wrap: nowrap;
    }

    #providers-list, #history-list { overflow-x: auto; }
    #providers-list .btn, #history-list .btn { white-space: nowrap; }
    #providers-list th:last-child,
    #providers-list td:last-child,
    #history-list th:last-child,
    #history-list td:last-child { text-align: right; }
    #providers-list .btn-group,
    #history-list .btn-group { justify-content: flex-end; }

    .order-cell { white-space: nowrap; }

    .drag-handle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      box-sizing: border-box;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      touch-action: none;
      color: var(--text-dim);
      font-weight: 700;
      letter-spacing: -2px;
      padding: 0;
    }

    .order-number {
      display: inline-block;
      margin-left: 8px;
    }

    .drag-handle:active { cursor: grabbing; }
    .table tr.dragging { opacity: 0.45; }
    .table tr.drag-over td { background: rgba(37, 99, 235, 0.08); }

    /* Status */
    .status-msg {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-top: 14px;
      display: none;
    }

    .status-msg.show { display: block; }
    .status-msg.success {
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.2);
      color: var(--success);
    }
    .status-msg.error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }

    .status-msg.warning {
      background: rgba(217, 119, 6, 0.1);
      border: 1px solid rgba(217, 119, 6, 0.2);
      color: var(--warning);
    }

    .file-picker {
      display: block;
      width: 100%;
      padding: 12px;
      background: var(--surface-2);
      border: 1px dashed var(--border);
      border-radius: 8px;
      margin-bottom: 14px;
    }

    .import-result {
      margin-top: 10px;
      padding-left: 20px;
    }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.show {
      display: flex;
    }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 28px;
      max-width: 520px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }

    .modal h3 {
      font-size: 17px;
      margin-bottom: 18px;
    }

    .modal pre {
      background: var(--surface-2);
      padding: 14px;
      border-radius: 8px;
      font-size: 13px;
      overflow-x: auto;
      white-space: pre-wrap;
    }

    .modal .close-btn {
      margin-top: 18px;
      text-align: right;
    }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 48px;
      color: var(--text-dim);
      font-size: 15px;
    }

    /* Update section below table */
    .update-section {
      margin-top: 28px;
    }

    .update-section .section-title {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }

    @media (max-width: 640px) {
      .container { padding: 24px 20px; }
      .table { font-size: 13px; }
      .table th, .table td { padding: 8px 8px; }
      .btn-group { flex-direction: row; }
      #providers-list .order-cell {
        padding-left: 0;
        text-align: left;
      }
      .drag-handle {
        width: 48px;
        height: 48px;
      }
      .order-number { display: none; }
      h1 { font-size: 22px; }
    }
  </style>
</head>
<body>
  <div id="auth-screen">
    <div class="auth-box">
      <h2>订阅管理中心</h2>
      <div class="auth-sub">私有订阅与配置管理控制台</div>
      <div class="auth-notice" role="note">
        <strong>使用提醒</strong>
        这里包含订阅链接和备份等私密信息。如需共享，请仅提供给你信任的人，并避免转发到群聊、论坛或其他公开平台。
      </div>
      <form id="auth-form" onsubmit="doAuth(event)">
        <div class="auth-field">
          <label for="username-input">用户名</label>
          <input type="text" id="username-input" name="username" placeholder="请输入用户名" autocomplete="username" autofocus required>
        </div>
        <div class="auth-field">
          <label for="password-input">密码</label>
          <div class="password-wrap">
            <input type="password" id="password-input" name="password" placeholder="请输入密码" autocomplete="current-password" required>
            <button type="button" class="password-toggle" id="password-toggle" onclick="togglePassword()" aria-label="显示密码">显示</button>
          </div>
        </div>
        <div id="auth-error" class="auth-error" role="alert" aria-live="polite"></div>
        <button id="login-button" type="submit" class="btn btn-primary" style="width:100%;min-height:46px">登录</button>
        <div class="auth-session-note">登录状态最长保留 8 小时，关闭浏览器或退出登录后失效</div>
      </form>
    </div>
  </div>

  <div id="main-screen" class="container" style="display:none">
    <header>
      <h1>订阅管理中心</h1>
      <div class="subtitle">Mihomo Subscription Vault — 私有订阅快照与配置管理</div>
      <button class="btn btn-outline btn-sm" style="margin-top:12px" onclick="doLogout()">退出登录</button>
    </header>

    <div class="tabs">
      <button class="tab active" data-tab="list">订阅列表</button>
      <button class="tab" data-tab="history">历史版本</button>
      <!-- staging tab hidden — backend APIs preserved, re-add button to restore -->
      <button class="tab" data-tab="backup">导入与导出</button>
    </div>

    <div id="tab-list" class="tab-content active">
      <div class="card subscription-card">
        <div class="card-header">
          <span class="card-title">所有订阅</span>
          <button class="btn btn-outline btn-sm" onclick="loadProviders()">刷新</button>
        </div>
        <div id="providers-list"></div>
      </div>
    </div>

    <div id="tab-history" class="tab-content">
      <div class="card">
        <div class="card-header">
          <span class="card-title">历史版本</span>
          <div style="display:flex;gap:8px;align-items:center">
            <select id="history-slug" onchange="loadHistory()" style="padding:8px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;min-width:140px">
              <option value="">全部订阅</option>
            </select>
          </div>
        </div>
        <div id="history-list"></div>
      </div>
    </div>



    <div id="tab-backup" class="tab-content">
      <div class="card">
        <div class="card-title" style="margin-bottom:18px">WebDAV 同步</div>
        <p style="color:var(--text-dim);font-size:14px;margin-bottom:14px">
          推送或恢复 WebDAV 中的统一母包。
        </p>
        <div class="form-group">
          <label>WebDAV 地址</label>
          <input id="webdav-url" placeholder="https://dav.jianguoyun.com/dav/">
        </div>
        <div class="form-group">
          <label>用户名</label>
          <input id="webdav-username" placeholder="your@email.com">
        </div>
        <div class="form-group">
          <label>密码</label>
          <input id="webdav-password" type="password" placeholder="应用专用密码">
        </div>
        <div class="form-group">
          <label>远程路径</label>
          <input id="webdav-remote-path" placeholder="/clash-verge-rev-backup/worker-backup.zip" value="/clash-verge-rev-backup/worker-backup.zip">
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="saveWebDAVConfig()">保存配置</button>
          <button class="btn btn-outline" onclick="testWebDAV()">测试连接</button>
          <button class="btn btn-primary" onclick="pushWebDAV()">推送到 WebDAV</button>
          <button class="btn btn-outline" onclick="pullWebDAV()">从 WebDAV 拉取</button>
        </div>
        <div id="webdav-status" class="status-msg"></div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:18px">导出通用母包</div>
        <p style="color:var(--text-dim);font-size:14px;margin-bottom:18px">
          导出当前全部订阅的统一母包。
        </p>
        <button class="btn btn-primary" onclick="doUnifiedExport()">导出通用母包</button>
        <div id="unified-export-status" class="status-msg"></div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:18px">导入统一母包</div>
        <p style="color:var(--text-dim);font-size:14px;margin-bottom:18px">
          选择并导入统一母包 ZIP。
        </p>
        <input id="import-file" class="file-picker" type="file" accept=".zip,application/zip">
        <button id="import-button" class="btn btn-primary" onclick="doUnifiedImport()">验证并导入</button>
        <div id="import-status" class="status-msg" role="status" aria-live="polite"></div>
      </div>
    </div>

    <!-- Add subscription card — always visible below all tabs -->
    <div class="update-section" style="margin-top:28px">
      <div class="card">
        <div class="section-title">添加订阅</div>
        <div class="form-group">
          <label>订阅名称</label>
          <input id="update-name" placeholder="主订阅">
        </div>
        <div class="form-group">
          <label>订阅 Slug</label>
          <input id="update-slug" placeholder="main">
        </div>
        <div class="form-group">
          <label>订阅地址</label>
          <input id="update-url" placeholder="https://example.com/one-time-url">
        </div>
        <div class="form-group">
          <label>User-Agent</label>
          <select id="update-user-agent-select" onchange="changeUserAgentMode('update')">
            <option value="clash-verge/v2.4.5">clash-verge/v2.4.5</option>
            <option value="clash.meta/1.19.20">clash.meta/1.19.20</option>
            <option value="SlClash clash-verge Platform/android">SlClash clash-verge Platform/android</option>
            <option value="__custom__">自定义</option>
          </select>
          <input id="update-user-agent-custom" maxlength="256" placeholder="输入自定义 User-Agent" style="display:none;margin-top:8px">
        </div>
        <button class="btn btn-primary" onclick="doUpdate()">测试并添加</button>
        <div id="update-status" class="status-msg"></div>
      </div>
    </div>
  </div>

  <!-- Edit subscription modal -->
  <div id="edit-modal" class="modal-overlay">
    <div class="modal">
      <h3>编辑订阅</h3>
      <div class="form-group">
        <label>订阅名称</label>
        <input id="edit-name">
      </div>
      <div class="form-group">
        <label>订阅地址</label>
        <input id="edit-url" placeholder="https://example.com/subscription-url">
      </div>
      <div class="form-group">
        <label>User-Agent</label>
        <select id="edit-user-agent-select" onchange="changeUserAgentMode('edit')">
          <option value="clash-verge/v2.4.5">clash-verge/v2.4.5</option>
          <option value="clash.meta/1.19.20">clash.meta/1.19.20</option>
          <option value="SlClash clash-verge Platform/android">SlClash clash-verge Platform/android</option>
          <option value="__custom__">自定义</option>
        </select>
        <input id="edit-user-agent-custom" maxlength="256" placeholder="输入自定义 User-Agent" style="display:none;margin-top:8px">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn btn-outline btn-sm" onclick="closeEditModal()">取消</button>
        <button class="btn btn-primary btn-sm" onclick="saveEdit()">保存并更新</button>
      </div>
      <div id="edit-status" class="status-msg"></div>
    </div>
  </div>

  <!-- Metadata modal -->
  <div id="meta-modal" class="modal-overlay">
    <div class="modal">
      <h3>版本元数据</h3>
      <pre id="meta-content"></pre>
      <div class="close-btn">
        <button class="btn btn-outline btn-sm" onclick="closeModal()">关闭</button>
      </div>
    </div>
  </div>

  <script>
    function showMainScreen() {
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('main-screen').style.display = 'block';
    }

    function showAuthScreen() {
      document.getElementById('main-screen').style.display = 'none';
      document.getElementById('auth-screen').style.display = 'grid';
      document.getElementById('password-input').value = '';
      document.getElementById('username-input').focus();
    }

    function togglePassword() {
      const input = document.getElementById('password-input');
      const button = document.getElementById('password-toggle');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? '显示' : '隐藏';
      button.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
      input.focus();
    }

    async function doAuth(event) {
      event.preventDefault();
      const username = document.getElementById('username-input').value.trim();
      const passwordInput = document.getElementById('password-input');
      const password = passwordInput.value;
      const error = document.getElementById('auth-error');
      const button = document.getElementById('login-button');
      if (!username || !password) {
        error.textContent = '请输入用户名和密码';
        return;
      }
      error.textContent = '';
      button.disabled = true;
      button.textContent = '正在登录…';
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.ok) {
          error.textContent = result?.error?.message || '登录失败，请稍后重试';
          passwordInput.select();
          return;
        }
        passwordInput.value = '';
        showMainScreen();
        await loadProviders();
      } catch {
        error.textContent = '无法连接到服务，请检查网络后重试';
      } finally {
        button.disabled = false;
        button.textContent = '登录';
      }
    }

    async function checkSession() {
      try {
        const response = await fetch('/api/auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const result = await response.json();
        if (response.ok && result?.data?.authenticated) {
          showMainScreen();
          await loadProviders();
          return;
        }
      } catch { /* Show the login form below. */ }
      showAuthScreen();
    }

    async function doLogout() {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
        });
      } finally {
        providersLoaded = false;
        historyLoaded = false;
        webdavLoaded = false;
        showAuthScreen();
      }
    }

    // Tabs — auto-load data on switch
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        const name = tab.dataset.tab;
        if (name === 'list' && !providersLoaded) loadProviders();
        if (name === 'history' && !historyLoaded) loadHistory();
        if (name === 'backup' && !webdavLoaded) { webdavLoaded = true; loadWebDAVConfig(); }

      });
    });

    async function api(path, opts = {}) {
      const resp = await fetch(path, {
        ...opts,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...opts.headers,
        },
      });
      if (resp.status === 401) {
        showAuthScreen();
        throw new Error('登录状态已失效，请重新登录');
      }
      return resp.json();
    }

    async function authenticatedFetch(path, opts = {}) {
      const response = await fetch(path, {
        ...opts,
        credentials: 'same-origin',
      });
      if (response.status === 401) {
        showAuthScreen();
        throw new Error('登录状态已失效，请重新登录');
      }
      return response;
    }

    function showStatus(el, ok, msg) {
      el.textContent = msg;
      el.className = 'status-msg show ' + (ok ? 'success' : 'error');
    }

    // --- Provider list ---

    let cachedProviders = [];
    let providersLoaded = false;
    let historyLoaded = false;
    let webdavLoaded = false;

    function invalidateSecondaryViews() {
      historyLoaded = false;
    }

    function renderProviders(providers) {
      const el = document.getElementById('providers-list');
      populateSlugDropdowns(providers);
      if (!providers.length) {
        el.innerHTML = '<div class="empty">暂无订阅，请先通过下方「添加订阅」添加一条。</div>';
        return;
      }
      let html = '<table class="table"><thead><tr>';
      html += '<th style="width:72px">顺序</th><th>名称</th><th>Slug</th><th>更新时间</th><th>节点</th><th>操作</th>';
      html += '</tr></thead><tbody>';
      for (let index = 0; index < providers.length; index++) {
        const p = providers[index];
        const ver = p.latestVersion;
        html += '<tr data-provider-slug="' + esc(p.slug) + '">';
        html += '<td class="order-cell"><span class="drag-handle" title="拖动排序" aria-label="拖动排序">⋮⋮</span><span class="order-number">' + (index + 1) + '</span></td>';
        html += '<td>' + esc(p.name || p.slug) + '</td>';
        html += '<td class="mono">' + esc(p.slug) + '</td>';
        html += '<td>' + (ver ? new Date(ver.updatedAt).toLocaleString() : '-') + '</td>';
        html += '<td>' + p.nodeCount + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-outline btn-sm" onclick="openEditModal(\\'' + esc(p.slug) + '\\')">编辑</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="quickUpdate(\\'' + esc(p.slug) + '\\')">更新</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="copyProviderLink(\\'' + esc(p.slug) + '\\')">复制 Provider 链接</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="copyConfigLink(\\'' + esc(p.slug) + '\\')">复制 Clash/Shadowrocket 通用配置</button>';
        html += '<button class="btn btn-danger btn-sm" onclick="deleteProvider(\\'' + esc(p.slug) + '\\')">删除</button>';
        html += '</div></td></tr>';
      }
      el.innerHTML = html + '</tbody></table>';
      bindProviderSorting();
    }

    let draggedProviderSlug = '';
    let touchProviderSlug = '';
    let touchIdentifier = null;

    function clearTouchSorting() {
      touchProviderSlug = '';
      touchIdentifier = null;
      document.querySelectorAll('#providers-list tr').forEach(item => {
        item.classList.remove('dragging', 'drag-over');
      });
    }

    function bindProviderSorting() {
      document.querySelectorAll('#providers-list tr[data-provider-slug]').forEach(row => {
        const handle = row.querySelector('.drag-handle');
        row.draggable = window.matchMedia('(pointer: fine)').matches;
        handle.addEventListener('touchstart', event => {
          if (event.touches.length !== 1) return;
          event.preventDefault();
          touchProviderSlug = row.dataset.providerSlug || '';
          touchIdentifier = event.touches[0].identifier;
          row.classList.add('dragging');
        }, { passive: false });
        row.addEventListener('dragstart', event => {
          draggedProviderSlug = row.dataset.providerSlug || '';
          row.classList.add('dragging');
          event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', event => {
          event.preventDefault();
          row.classList.add('drag-over');
          event.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', event => {
          event.preventDefault();
          row.classList.remove('drag-over');
          const targetSlug = row.dataset.providerSlug || '';
          if (draggedProviderSlug && targetSlug && draggedProviderSlug !== targetSlug) {
            reorderProviders(draggedProviderSlug, targetSlug);
          }
        });
        row.addEventListener('dragend', () => {
          draggedProviderSlug = '';
          document.querySelectorAll('#providers-list tr').forEach(item => {
            item.classList.remove('dragging', 'drag-over');
          });
        });
      });

      document.ontouchmove = event => {
        if (!touchProviderSlug) return;
        const touch = Array.from(event.touches).find(item => item.identifier === touchIdentifier);
        if (!touch) return;
        event.preventDefault();
        const source = document.querySelector('#providers-list tr[data-provider-slug="' + CSS.escape(touchProviderSlug) + '"]');
        const target = document.elementFromPoint(touch.clientX, touch.clientY)
          ?.closest('#providers-list tr[data-provider-slug]');
        if (!source || !target || source === target) return;
        const targetRect = target.getBoundingClientRect();
        const insertBefore = touch.clientY < targetRect.top + targetRect.height / 2;
        target.parentElement.insertBefore(source, insertBefore ? target : target.nextSibling);
        target.classList.add('drag-over');
        requestAnimationFrame(() => target.classList.remove('drag-over'));
      };
      document.ontouchend = event => {
        if (!touchProviderSlug || !Array.from(event.changedTouches).some(item => item.identifier === touchIdentifier)) return;
        event.preventDefault();
        const slugs = Array.from(document.querySelectorAll('#providers-list tr[data-provider-slug]'))
          .map(item => item.dataset.providerSlug)
          .filter(Boolean);
        clearTouchSorting();
        saveProviderOrder(slugs);
      };
      document.ontouchcancel = () => {
        clearTouchSorting();
        renderProviders(cachedProviders);
      };
    }

    async function reorderProviders(sourceSlug, targetSlug) {
      const previous = cachedProviders.slice();
      const next = cachedProviders.slice();
      const from = next.findIndex(provider => provider.slug === sourceSlug);
      const to = next.findIndex(provider => provider.slug === targetSlug);
      if (from < 0 || to < 0) return;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      await saveProviderOrder(next.map(provider => provider.slug));
    }

    async function saveProviderOrder(slugs) {
      const previous = cachedProviders.slice();
      const bySlug = new Map(cachedProviders.map(provider => [provider.slug, provider]));
      const next = slugs.map(slug => bySlug.get(slug)).filter(Boolean);
      if (next.length !== previous.length || next.every((provider, index) => provider.slug === previous[index].slug)) {
        renderProviders(previous);
        return;
      }
      renderProviders(next);
      const res = await api('/api/providers/order', {
        method: 'PUT',
        body: JSON.stringify({ slugs }),
      });
      if (!res.ok) {
        renderProviders(previous);
        showToast(res.error?.message || '保存顺序失败');
        return;
      }
      invalidateSecondaryViews();
      showToast('顺序已保存');
    }

    function populateSlugDropdowns(providers) {
      cachedProviders = providers;
      for (const selectId of ['history-slug']) {
        const sel = document.getElementById(selectId);
        const current = sel.value;
        sel.innerHTML = '<option value="">全部订阅</option>';
        for (const p of providers) {
          const opt = document.createElement('option');
          opt.value = p.slug;
          opt.textContent = p.name || p.slug;
          sel.appendChild(opt);
        }
        // Restore previous selection if still valid
        if (current && providers.some(p => p.slug === current)) {
          sel.value = current;
        }
      }
    }

    async function loadProviders(options = {}) {
      const el = document.getElementById('providers-list');
      if (!options.silent && cachedProviders.length === 0) {
        el.innerHTML = '<div class="empty">加载中...</div>';
      }
      const res = await api('/api/providers');
      if (!res.ok) {
        el.innerHTML = '<div class="empty">' + esc(res.error.message) + '</div>';
        return;
      }
      providersLoaded = true;
      renderProviders(res.data || []);
    }

    // --- Edit subscription ---

    let editingSlug = '';
    const USER_AGENT_OPTIONS = [
      'clash-verge/v2.4.5',
      'clash.meta/1.19.20',
      'SlClash clash-verge Platform/android',
    ];

    function setUserAgentValue(prefix, value) {
      const resolved = value || USER_AGENT_OPTIONS[0];
      const select = document.getElementById(prefix + '-user-agent-select');
      const custom = document.getElementById(prefix + '-user-agent-custom');
      if (USER_AGENT_OPTIONS.includes(resolved)) {
        select.value = resolved;
        custom.value = '';
      } else {
        select.value = '__custom__';
        custom.value = resolved;
      }
      changeUserAgentMode(prefix);
    }

    function changeUserAgentMode(prefix) {
      const select = document.getElementById(prefix + '-user-agent-select');
      const custom = document.getElementById(prefix + '-user-agent-custom');
      custom.style.display = select.value === '__custom__' ? 'block' : 'none';
    }

    function getUserAgentValue(prefix) {
      const select = document.getElementById(prefix + '-user-agent-select');
      if (select.value !== '__custom__') return select.value;
      return document.getElementById(prefix + '-user-agent-custom').value.trim();
    }

    function openEditModal(slug) {
      const provider = cachedProviders.find(p => p.slug === slug) || {};
      editingSlug = slug;
      document.getElementById('edit-name').value = provider.name || slug;
      document.getElementById('edit-url').value = provider.sourceUrl || '';
      setUserAgentValue('edit', provider.userAgent);
      document.getElementById('edit-status').className = 'status-msg';
      document.getElementById('edit-modal').classList.add('show');
    }

    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('show');
    }

    async function saveEdit() {
      const name = document.getElementById('edit-name').value.trim();
      const url = document.getElementById('edit-url').value.trim();
      const userAgent = getUserAgentValue('edit');
      const statusEl = document.getElementById('edit-status');

      if (!name) {
        showStatus(statusEl, false, '请填写订阅名称');
        return;
      }
      if (!url) {
        showStatus(statusEl, false, '请填写订阅地址');
        return;
      }

      showStatus(statusEl, true, '正在更新...');
      const res = await api('/api/providers/' + encodeURIComponent(editingSlug) + '/update', {
        method: 'POST',
        body: JSON.stringify({ name, sourceUrl: url, userAgent }),
      });

      if (res.ok) {
        showStatus(statusEl, true, '更新成功！节点: ' + res.data.nodeCount);
        setTimeout(() => {
          closeEditModal();
          invalidateSecondaryViews();
          loadProviders({ silent: true });
        }, 800);
      } else {
        showStatus(statusEl, false, res.error.message);
      }
    }

    // --- Quick update (from table button) ---

    async function quickUpdate(slug) {
      const provider = cachedProviders.find(p => p.slug === slug) || {};
      const name = provider.name || slug;
      const sourceUrl = provider.sourceUrl || '';
      const userAgent = provider.userAgent || USER_AGENT_OPTIONS[0];
      if (!sourceUrl) {
        showToast('未找到订阅地址，请通过「添加订阅」重新添加');
        return;
      }
      if (!confirm('确认使用已有地址更新 "' + (name || slug) + '"？')) return;
      showToast('正在更新...');
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/update', {
        method: 'POST',
        body: JSON.stringify({ name, sourceUrl, userAgent }),
      });
      if (res.ok) {
        showToast('更新成功' + (res.data.isNew ? '（新版本）' : '（内容未变化）'));
        invalidateSecondaryViews();
        loadProviders({ silent: true });
      } else {
        alert('更新失败: ' + res.error.message);
      }
    }

    // --- Copy links ---

    async function copyProviderLink(slug) {
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/links');
      if (res.ok && res.data?.providerUrl) {
        await navigator.clipboard.writeText(res.data.providerUrl);
        showToast('Provider 链接已复制');
      } else {
        showToast('获取链接失败');
      }
    }

    async function copyConfigLink(slug) {
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/links');
      if (res.ok && res.data?.configUrl) {
        await navigator.clipboard.writeText(res.data.configUrl);
        showToast('Clash/Shadowrocket 通用配置已复制');
      } else {
        showToast('获取链接失败');
      }
    }

    async function deleteProvider(slug) {
      if (!confirm('确认从订阅列表移除 "' + slug + '"？历史版本不会被删除。')) return;
      const previous = cachedProviders.slice();
      renderProviders(cachedProviders.filter(p => p.slug !== slug));
      const res = await api('/api/providers/' + encodeURIComponent(slug), { method: 'DELETE' });
      if (res.ok) {
        showToast('已从订阅列表移除 ' + slug);
        invalidateSecondaryViews();
      } else {
        renderProviders(previous);
        alert('删除失败: ' + res.error.message);
      }
    }

    async function deleteVersion(slug, versionId) {
      if (!confirm('确认删除版本 ' + versionId.slice(0, 12) + '...？此操作不可恢复。')) return;
      const previous = cachedHistoryEntries.slice();
      cachedHistoryEntries = cachedHistoryEntries.filter(entry =>
        entry.slug !== slug || entry.version.versionId !== versionId
      );
      renderHistory(cachedHistoryEntries, historyFilterSlug);
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/versions/' + encodeURIComponent(versionId), { method: 'DELETE' });
      if (res.ok) {
        showToast('已删除版本');
      } else {
        cachedHistoryEntries = previous;
        renderHistory(previous, historyFilterSlug);
        alert('删除失败: ' + res.error.message);
      }
    }

    function showToast(msg) {
      const toast = document.createElement('div');
      toast.textContent = msg;
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:200;opacity:0;transition:opacity 0.3s';
      document.body.appendChild(toast);
      requestAnimationFrame(() => { toast.style.opacity = '1'; });
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    }

    // --- Update subscription (form) ---

    async function doUpdate() {
      const name = document.getElementById('update-name').value.trim();
      const slug = document.getElementById('update-slug').value.trim();
      const url = document.getElementById('update-url').value.trim();
      const userAgent = getUserAgentValue('update');
      const statusEl = document.getElementById('update-status');

      if (!name || !slug || !url) {
        showStatus(statusEl, false, '请填写所有字段');
        return;
      }

      showStatus(statusEl, true, '正在更新...');
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/update', {
        method: 'POST',
        body: JSON.stringify({ name, sourceUrl: url, userAgent }),
      });

      if (res.ok) {
        const d = res.data;
        showStatus(statusEl, true,
          '更新成功！节点: ' + d.nodeCount +
          (d.isNew ? ' (新版本)' : ' (内容未变化)')
        );
        invalidateSecondaryViews();
        loadProviders({ silent: true });
      } else {
        showStatus(statusEl, false, res.error.message);
      }
    }

    // --- History ---

    let cachedHistoryEntries = [];
    let historyFilterSlug = '';

    async function loadHistory(options = {}) {
      historyLoaded = true;
      const slug = document.getElementById('history-slug').value;
      historyFilterSlug = slug;
      const el = document.getElementById('history-list');
      if (!options.silent && cachedHistoryEntries.length === 0) {
        el.innerHTML = '<div class="empty">加载中...</div>';
      }

      // Collect history entries — single slug or all providers
      let entries = []; // { slug, version, name }
      const slugs = slug ? [slug] : cachedProviders.map(p => p.slug);

      if (slugs.length === 0) {
        el.innerHTML = '<div class="empty">暂无订阅</div>';
        return;
      }

      const results = await Promise.all(slugs.map(async s => ({
        slug: s,
        response: await api('/api/providers/' + encodeURIComponent(s) + '/history'),
      })));
      for (const result of results) {
        if (!result.response.ok || !result.response.data) continue;
        const name = cachedProviders.find(p => p.slug === result.slug)?.name || result.slug;
        for (const version of result.response.data) {
          entries.push({ slug: result.slug, version, name });
        }
      }

      cachedHistoryEntries = entries;
      renderHistory(entries, slug);
    }

    function renderHistory(entries, slug) {
      const el = document.getElementById('history-list');
      if (entries.length === 0) {
        el.innerHTML = '<div class="empty">暂无历史版本</div>';
        return;
      }

      // Sort by time descending
      entries.sort((a, b) => new Date(b.version.createdAt) - new Date(a.version.createdAt));

      const showSlugCol = !slug;
      let html = '<table class="table"><thead><tr>';
      if (showSlugCol) html += '<th>订阅</th>';
      html += '<th>时间</th><th>节点</th><th>SHA-256</th><th>大小</th><th>来源</th><th>状态</th><th>操作</th>';
      html += '</tr></thead><tbody>';
      for (const e of entries) {
        const v = e.version;
        html += '<tr data-history-slug="' + esc(e.slug) + '" data-history-version="' + esc(v.versionId) + '">';
        if (showSlugCol) html += '<td class="mono">' + esc(e.slug) + '</td>';
        html += '<td>' + new Date(v.createdAt).toLocaleString() + '</td>';
        html += '<td>' + v.nodeCount + '</td>';
        html += '<td class="mono">' + esc(v.sha256Prefix) + '</td>';
        html += '<td>' + (v.contentLength / 1024).toFixed(1) + ' KB</td>';
        html += '<td class="mono">' + esc(v.sourceHost) + '</td>';
        html += '<td>' + (v.isCurrent ? '<span class="badge badge-current">当前</span>' : '') + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-outline btn-sm" onclick="showMeta(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">元数据</button>';
        if (!v.isCurrent) {
          html += '<button class="btn btn-outline btn-sm" onclick="doRollback(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">回滚</button>';
        }
        html += '<button class="btn btn-outline btn-sm" onclick="downloadVersion(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">下载完整配置</button>';
        if (!v.isCurrent) {
          html += '<button class="btn btn-danger btn-sm" onclick="deleteVersion(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">删除</button>';
        }
        html += '</div></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    async function showMeta(slug, versionId) {
      const entry = cachedHistoryEntries.find(item =>
        item.slug === slug && item.version.versionId === versionId
      );
      if (!entry) return;
      const v = entry.version;
      document.getElementById('meta-content').textContent = JSON.stringify(v, null, 2);
      document.getElementById('meta-modal').classList.add('show');
    }

    function closeModal() {
      document.getElementById('meta-modal').classList.remove('show');
    }

    async function doRollback(slug, versionId) {
      if (!confirm('确认回滚到版本 ' + versionId + '？')) return;
      const res = await api('/api/providers/' + encodeURIComponent(slug) + '/rollback', {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      if (res.ok) {
        alert('回滚成功');
        loadHistory({ silent: true });
      } else {
        alert('回滚失败: ' + res.error.message);
      }
    }

    async function downloadVersion(slug, versionId) {
      try {
        const resp = await authenticatedFetch('/api/providers/' + encodeURIComponent(slug) + '/versions/' + encodeURIComponent(versionId) + '/yaml');
        if (!resp.ok) {
          const err = await resp.json();
          alert('下载失败: ' + (err.error?.message || '未知错误'));
          return;
        }
        const blob = await resp.blob();
        const cd = resp.headers.get('Content-Disposition');
        const filename = cd ? cd.split('filename=')[1]?.replace(/"/g, '') : slug + '-' + versionId + '.yaml';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        alert('下载失败: ' + e.message);
      }
    }

    // --- Export ---

    async function downloadExport(endpoint, statusId, fallbackName) {
      const statusEl = document.getElementById(statusId);
      showStatus(statusEl, true, '正在导出...');
      try {
        const resp = await authenticatedFetch(endpoint);
        if (!resp.ok) {
          let message = '导出失败';
          try {
            const err = await resp.json();
            message = err.error?.message || message;
          } catch {}
          showStatus(statusEl, false, message);
          return;
        }
        const blob = await resp.blob();
        const cd = resp.headers.get('Content-Disposition');
        const filename = cd ? cd.split('filename=')[1]?.replace(/"/g, '') : fallbackName;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        showStatus(statusEl, true, '导出完成: ' + filename);
      } catch (e) {
        showStatus(statusEl, false, '导出失败: ' + e.message);
      }
    }

    async function doUnifiedExport() {
      await downloadExport('/api/unified-export', 'unified-export-status', '通用-backup-v1.zip');
    }

    // --- WebDAV sync ---

    async function loadWebDAVConfig() {
      try {
        const res = await api('/api/webdav/config');
        if (res.ok && res.data) {
          document.getElementById('webdav-url').value = res.data.url || '';
          document.getElementById('webdav-username').value = res.data.username || '';
          document.getElementById('webdav-password').value = res.data.password || '';
          document.getElementById('webdav-remote-path').value = res.data.remotePath || '/mihomo-vault/通用-backup-v1.zip';
        }
      } catch {}
    }

    async function saveWebDAVConfig() {
      const el = document.getElementById('webdav-status');
      const config = {
        url: document.getElementById('webdav-url').value.trim(),
        username: document.getElementById('webdav-username').value.trim(),
        password: document.getElementById('webdav-password').value,
        remotePath: document.getElementById('webdav-remote-path').value.trim() || '/mihomo-vault/通用-backup-v1.zip',
      };
      if (!config.url || !config.username) {
        showStatus(el, false, '地址和用户名为必填');
        return;
      }
      try {
        const res = await api('/api/webdav/config', { method: 'POST', body: JSON.stringify(config) });
        if (res.ok) showStatus(el, true, '配置已保存');
        else showStatus(el, false, '保存失败: ' + (res.error || '未知错误'));
      } catch (e) {
        showStatus(el, false, '保存失败: ' + e.message);
      }
    }

    async function testWebDAV() {
      const el = document.getElementById('webdav-status');
      showStatus(el, true, '正在测试连接...');
      try {
        const res = await api('/api/webdav/test');
        if (res.ok) showStatus(el, true, '连接成功');
        else showStatus(el, false, '连接失败: ' + (res.error || '未知错误'));
      } catch (e) {
        showStatus(el, false, '测试失败: ' + e.message);
      }
    }

    async function pushWebDAV() {
      const el = document.getElementById('webdav-status');
      showStatus(el, true, '正在导出并推送到 WebDAV...');
      try {
        const res = await api('/api/webdav/push', { method: 'POST' });
        if (res.ok) showStatus(el, true, '推送成功');
        else showStatus(el, false, '推送失败: ' + (res.error?.message || res.error || '未知错误'));
      } catch (e) {
        showStatus(el, false, '推送失败: ' + e.message);
      }
    }

    async function pullWebDAV() {
      const el = document.getElementById('webdav-status');
      showStatus(el, true, '正在列出备份文件...');
      try {
        const listRes = await api('/api/webdav/list');
        if (!listRes.ok || !listRes.files || listRes.files.length === 0) {
          showStatus(el, false, listRes.error || 'WebDAV 上没有备份文件');
          return;
        }
        const files = listRes.files;
        // Build file picker dialog
        let html = '<div style="padding:16px"><h3 style="margin:0 0 12px">选择要导入的备份</h3>';
        for (const f of files) {
          const label = f.name.includes('android') ? '📱 Slclash' : f.name.includes('windows') ? '💻 Clash Verge' : '☁️ Worker';
          const sizeKB = (f.size / 1024).toFixed(0);
          html += '<div style="padding:10px 12px;margin:4px 0;background:var(--surface-2);border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="doPullWebDAV(\\'' + esc(f.name) + '\\')">';
          html += '<div><strong>' + esc(f.name) + '</strong><br><span style="color:var(--text-dim);font-size:12px">' + label + ' · ' + sizeKB + 'KB · ' + esc(f.lastModified) + '</span></div>';
          html += '<button class="btn btn-primary btn-sm">导入</button>';
          html += '</div>';
        }
        html += '</div>';
        // Show as overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:100;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:var(--surface);border-radius:12px;max-width:500px;width:90%;max-height:80vh;overflow:auto">' + html + '<div style="padding:0 16px 16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\\'div[style*=fixed]\\').remove()">取消</button></div></div>';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
      } catch (e) {
        showStatus(el, false, '列出文件失败: ' + e.message);
      }
    }

    async function doPullWebDAV(fileName) {
      const el = document.getElementById('webdav-status');
      // Close overlay
      document.querySelectorAll('div[style*="position:fixed"]').forEach(el => el.remove());
      if (!confirm('确认导入 ' + fileName + '？将验证后覆盖当前订阅。')) return;
      showStatus(el, true, '正在从 WebDAV 拉取并导入...');
      try {
        const res = await api('/api/webdav/pull', { method: 'POST', body: JSON.stringify({ fileName }) });
        if (res.ok) {
          const count = res.data?.committedProviders?.length || 0;
          showStatus(el, true, '导入成功，已提交 ' + count + ' 个订阅');
          loadProviders();
          invalidateSecondaryViews();
        } else {
          showStatus(el, false, '导入失败: ' + (res.error?.message || res.error || '未知错误'));
        }
      } catch (e) {
        showStatus(el, false, '导入失败: ' + e.message);
      }
    }

    // --- Unified import ---

    const MAX_UNIFIED_IMPORT_BYTES = 20 * 1024 * 1024;

    function formatImportProviders(providers) {
      if (!Array.isArray(providers) || providers.length === 0) return '';
      let html = '<ul class="import-result">';
      for (const provider of providers) {
        html += '<li><span class="mono">' + esc(provider.slug || '') + '</span> — <span class="mono">' + esc(provider.versionId || '') + '</span></li>';
      }
      return html + '</ul>';
    }

    function showImportResult(kind, message, providers) {
      const el = document.getElementById('import-status');
      let html = '<div>' + esc(message) + '</div>';
      html += formatImportProviders(providers);
      el.innerHTML = html;
      el.className = 'status-msg show ' + kind;
    }

    async function doUnifiedImport() {
      const input = document.getElementById('import-file');
      const button = document.getElementById('import-button');
      const file = input.files && input.files[0];
      if (!file) {
        showImportResult('error', '请先选择统一母包 ZIP', [], '');
        return;
      }
      if (file.size === 0) {
        showImportResult('error', '所选 ZIP 为空', [], '');
        return;
      }
      if (file.size > MAX_UNIFIED_IMPORT_BYTES) {
        showImportResult('error', '所选 ZIP 超过 20 MiB 限制', [], '');
        return;
      }
      const sizeMiB = (file.size / 1024 / 1024).toFixed(2);
      if (!confirm('确认导入“' + file.name + '”（' + sizeMiB + ' MiB）？导入会创建可回滚的新版本。')) return;

      button.disabled = true;
      showImportResult('success', '正在验证并导入，请勿关闭页面…', [], '');
      try {
        const resp = await authenticatedFetch('/api/unified-import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/zip',
          },
          body: file,
        });
        let result;
        try {
          result = await resp.json();
        } catch {
          showImportResult('error', '导入失败：服务器响应格式无效', [], '');
          return;
        }
        if (resp.ok && result.ok) {
          const providers = result.data?.providers || [];
          showImportResult('success', '统一母包导入成功', providers);
          input.value = '';
          invalidateSecondaryViews();
          await loadProviders({ silent: true });
          return;
        }
        const code = result.error?.code || 'IMPORT_FAILED';
        const message = result.error?.message || '导入失败';
        const committed = result.data?.committedProviders || [];
        if (resp.status === 409 && committed.length > 0) {
          showImportResult('warning', '部分订阅已提交，随后发生并发冲突（' + code + '）：' + message, committed, '');
          invalidateSecondaryViews();
          await loadProviders({ silent: true });
        } else {
          showImportResult('error', '导入失败（' + code + '）：' + message, [], '');
        }
      } catch (error) {
        showImportResult('error', '导入失败：网络请求未完成', [], '');
      } finally {
        button.disabled = false;
      }
    }

    // Escapes for HTML text, attribute values, and single/double quoted inline
    // JS string literals alike — values reach all three contexts.
    const ESC_MAP = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '\`': '&#96;',
      '=': '&#61;'
    };
    function esc(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/[&<>"'\`=]/g, (c) => ESC_MAP[c]);
    }

    queueMicrotask(() => checkSession());
  </script>
</body>
</html>`;
}
