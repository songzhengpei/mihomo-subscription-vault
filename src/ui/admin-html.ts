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
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 32px;
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
    #llm-keys-list .btn-group { justify-content: flex-end; }
    /* Mirror the subscription table on narrow screens: keep the action buttons on
       one line so the table keeps its min-content width and scrolls sideways
       inside the card instead of squeezing/wrapping. */
    #llm-keys-list { overflow-x: auto; }
    #llm-keys-list .btn { white-space: nowrap; }
    #llm-keys-list th:last-child,
    #llm-keys-list td:last-child { text-align: right; }

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

    /* Compact variant for single-value popups. */
    .modal-sm {
      max-width: 420px;
      padding: 20px;
    }

    /* Viewer header: credential name as the title, with a quiet label below it
       using the same treatment as table headers. */
    .modal .modal-title {
      margin-bottom: 2px;
      word-break: break-word;
    }

    .modal .modal-subtitle {
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 14px;
    }

    /* Credential plaintext: long tokens have no spaces, so they must be forced
       to wrap or they blow out the modal on narrow screens. user-select: all
       makes a single tap select the whole value on mobile. */
    /* Column widths: the name column absorbs the slack so the table does not
       leave a dead zone between the data and the right-aligned actions. */
    #providers-list th:nth-child(1),
    #providers-list td:nth-child(1) { width: 72px; }
    #providers-list th:nth-child(3),
    #providers-list td:nth-child(3) { width: 96px; }
    #providers-list th:nth-child(4),
    #providers-list td:nth-child(4) { width: 168px; }
    #providers-list th:nth-child(5),
    #providers-list td:nth-child(5) { width: 64px; }
    #providers-list td:nth-child(3) { color: var(--text-dim); font-size: 13px; }
    #llm-keys-list th:nth-child(2),
    #llm-keys-list td:nth-child(2) { width: 120px; }
    #llm-keys-list th:nth-child(3),
    #llm-keys-list td:nth-child(3) { width: 150px; }
    #llm-keys-list th:nth-child(4),
    #llm-keys-list td:nth-child(4) { width: 168px; }
    #llm-keys-list td:nth-child(2) { color: var(--text-dim); font-size: 13px; }
    /* width:1% makes the action column shrink to its content, so the slack ends
       up in the name column instead of as a dead zone before the buttons. */
    #providers-list th:last-child,
    #llm-keys-list th:last-child,
    #history-list th:last-child { width: 1%; }

    /* Forms lay their fields out in a row instead of one 1200px-wide input per
       line; they collapse back to a single column on narrow screens. */
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0 16px;
    }

    .secret-value {
      display: block;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.6;
      word-break: break-all;
      overflow-wrap: anywhere;
      user-select: all;
      -webkit-user-select: all;
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

      /* The tab strip is wider than a phone, and an overflowing child widens the
         whole page — which used to clip the header, the cards and the last tab.
         It scrolls inside its own strip instead. */
      .tabs { overflow-x: auto; flex-wrap: nowrap; margin-bottom: 20px; }
      .tab { padding: 10px 14px; font-size: 14px; white-space: nowrap; }
      header { padding-bottom: 14px; margin-bottom: 20px; }
      .subtitle { font-size: 13px; }

      /* Narrow screens: a six-column table cannot survive 390px — the name
         column collapsed to one character per line and the actions needed
         sideways scrolling. Each row becomes a stacked card instead. */
      .table-stack,
      .table-stack tbody,
      .table-stack tr,
      .table-stack td { display: block; width: auto; }
      .table-stack thead { display: none; }
      .table-stack tr {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-2);
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      .table-stack td { border: 0; padding: 1px 0; }
      .table-stack .cell-primary {
        font-size: 15px;
        font-weight: 600;
        padding-bottom: 4px;
      }
      .table-stack td[data-label]::before {
        content: attr(data-label) " ";
        color: var(--text-dim);
        font-size: 12px;
      }
      .table-stack td[data-label] { font-size: 12px; color: var(--text-dim); }
      .table-stack td[data-label].mono { font-size: 12px; }
      .table-stack .order-cell { display: none; }
      .table-stack td:last-child { padding-top: 10px; }
      /* Buttons wrap into as many lines as they need instead of forcing a
         horizontal scroll on the whole table. */
      .table-stack .btn-group { flex-wrap: wrap; justify-content: flex-start; }
      .table-stack td:last-child { text-align: left; }
      #providers-list, #history-list, #llm-keys-list { overflow-x: visible; }
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
      <button class="tab" data-tab="llm">大模型密钥</button>
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

    <div id="tab-llm" class="tab-content">
      <div class="card">
        <div class="card-header">
          <span class="card-title">所有大模型密钥</span>
          <button class="btn btn-outline btn-sm" onclick="loadLlmKeys()">刷新</button>
        </div>
        <div id="llm-store-note" class="status-msg" role="alert"></div>
        <div id="llm-keys-list"></div>
      </div>

      <div class="update-section">
        <div class="card">
          <div class="section-title">添加大模型密钥</div>
          <div class="form-grid">
            <div class="form-group">
              <label>名称</label>
              <input id="llm-add-name" placeholder="DeepSeek 主账号">
            </div>
            <div class="form-group">
              <label>Slug</label>
              <input id="llm-add-slug" placeholder="deepseek">
            </div>
            <div class="form-group">
              <label>API Key</label>
              <input id="llm-add-key" type="password" autocomplete="off" placeholder="sk-...">
            </div>
          </div>
          <button class="btn btn-primary" onclick="saveLlmKey()">保存并添加</button>
          <div id="llm-status" class="status-msg" role="status" aria-live="polite"></div>
        </div>
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
        <div class="form-grid">
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
    <div id="add-subscription-section" class="update-section" style="margin-top:28px">
      <div class="card">
        <div class="section-title">添加订阅</div>
        <div class="form-grid">
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

  <!-- LLM credential viewer — plaintext is shown on open: the row action that
       opens it is already the explicit reveal step. -->
  <div id="llm-view-modal" class="modal-overlay">
    <div class="modal modal-sm">
      <h3 id="llm-view-title" class="modal-title"></h3>
      <div class="modal-subtitle">API Key</div>
      <span id="llm-view-secret" class="secret-value">正在读取...</span>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="copyLlmPlain()">复制</button>
        <button class="btn btn-outline btn-sm" onclick="closeLlmView()">关闭</button>
      </div>
      <div id="llm-view-status" class="status-msg" role="status" aria-live="polite"></div>
    </div>
  </div>

  <!-- LLM credential modal -->
  <div id="llm-modal" class="modal-overlay">
    <div class="modal">
      <h3>编辑大模型密钥</h3>
      <div class="form-group">
        <label>名称</label>
        <input id="llm-name">
      </div>
      <div class="form-group">
        <label>Slug</label>
        <input id="llm-slug" disabled>
      </div>
      <div class="form-group">
        <label>API Key</label>
        <input id="llm-api-key" type="password" autocomplete="off" placeholder="留空表示不修改">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn btn-outline btn-sm" onclick="closeLlmModal()">取消</button>
        <button class="btn btn-primary btn-sm" onclick="saveLlmEdit()">保存并更新</button>
      </div>
      <div id="llm-modal-status" class="status-msg"></div>
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
        await loadAllViews();
      } catch {
        error.textContent = '无法连接到服务，请检查网络后重试';
      } finally {
        button.disabled = false;
        button.textContent = '登录';
      }
    }

    // Placeholders so a panel never looks broken while its data is in flight.
    function showLoadingPlaceholders() {
      const panels = [
        ['providers-list', providersLoaded],
        ['llm-keys-list', llmLoaded],
        ['history-list', historyLoaded],
      ];
      for (let index = 0; index < panels.length; index++) {
        const el = document.getElementById(panels[index][0]);
        if (el && !panels[index][1] && el.innerHTML === '') {
          el.innerHTML = '<div class="empty">加载中...</div>';
        }
      }
    }

    // Everything the tabs need, fetched once up front. Providers and
    // credentials are independent so they run together; history needs the
    // provider list, so it fills in right after — usually before the user
    // clicks that tab. Switching tabs then renders from memory.
    async function loadAllViews() {
      await Promise.all([
        loadProviders().catch(() => {}),
        loadLlmKeys({ silent: true }).catch(() => {}),
      ]);
      loadHistory({ silent: true }).catch(() => {});
      webdavLoaded = true;
      loadWebDAVConfig();
    }

    async function checkSession() {
      // Verify the session before revealing the shell: rendering it first made
      // an unauthenticated visit flash the admin layout before bouncing to the
      // login form. Data still arrives from one parallel prefetch pass below.
      try {
        const response = await fetch('/api/auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const result = await response.json();
        if (response.ok && result?.data?.authenticated) {
          showMainScreen();
          showLoadingPlaceholders();
          await loadAllViews();
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
        llmLoaded = false;
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
        if (name === 'llm' && !llmLoaded) { llmLoaded = true; loadLlmKeys({ silent: true }); }

      });
    });

    // The "添加订阅" card sits outside the tab panes; hide it while the LLM
    // credential tab is active so the two resource types stay visually separate.
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const section = document.getElementById('add-subscription-section');
        if (section) section.style.display = tab.dataset.tab === 'llm' ? 'none' : '';
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
      let html = '<table class="table table-stack"><thead><tr>';
      html += '<th class="order-cell">顺序</th><th>名称</th><th>Slug</th><th>更新时间</th><th>节点</th><th>操作</th>';
      html += '</tr></thead><tbody>';
      for (let index = 0; index < providers.length; index++) {
        const p = providers[index];
        const ver = p.latestVersion;
        html += '<tr data-provider-slug="' + esc(p.slug) + '">';
        html += '<td class="order-cell"><span class="drag-handle" title="拖动排序" aria-label="拖动排序">⋮⋮</span><span class="order-number">' + (index + 1) + '</span></td>';
        html += '<td class="cell-primary">' + esc(p.name || p.slug) + '</td>';
        html += '<td class="mono">' + esc(p.slug) + '</td>';
        html += '<td data-label="更新">' + (ver ? new Date(ver.updatedAt).toLocaleString() : '-') + '</td>';
        html += '<td data-label="节点">' + p.nodeCount + '</td>';
        html += '<td><div class="btn-group">';
        // The full config link is the everyday action, so it is the only primary
        // button in the row; everything else stays visually quiet.
        html += '<button class="btn btn-primary btn-sm" title="复制完整配置链接（Clash / Shadowrocket 通用配置）" onclick="copyConfigLink(\\'' + esc(p.slug) + '\\')">复制完整配置</button>';
        html += '<button class="btn btn-outline btn-sm" title="复制 Provider 链接（mihomo proxy-providers 用）" onclick="copyProviderLink(\\'' + esc(p.slug) + '\\')">复制 Provider</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="openEditModal(\\'' + esc(p.slug) + '\\')">编辑</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="quickUpdate(\\'' + esc(p.slug) + '\\')">更新</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="deleteProvider(\\'' + esc(p.slug) + '\\')">删除</button>';
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

    // Apply an update/add result to the list immediately. The follow-up
    // loadProviders() only reconciles ordering in the background, so the row no
    // longer waits on a second round trip after the upstream fetch finishes.
    function upsertProviderLocal(entry) {
      let found = false;
      const next = cachedProviders.map((item) => {
        if (item.slug !== entry.slug) return item;
        found = true;
        return Object.assign({}, item, entry);
      });
      if (!found) next.push(entry);
      renderProviders(next);
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
        const d = res.data || {};
        upsertProviderLocal({
          slug: slug,
          name: name,
          latestVersion: {
            versionId: d.versionId,
            sha256: d.sha256,
            updatedAt: d.updatedAt,
          },
          nodeCount: d.nodeCount,
          sourceHost: d.sourceHost,
          sourceUrl: sourceUrl,
          userAgent: userAgent,
        });
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

      showStatus(statusEl, true, '正在拉取上游订阅并写入快照，请稍候...');
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
        upsertProviderLocal({
          slug: slug,
          name: name,
          latestVersion: {
            versionId: d.versionId,
            sha256: d.sha256,
            updatedAt: d.updatedAt,
          },
          nodeCount: d.nodeCount,
          sourceHost: d.sourceHost,
          sourceUrl: url,
          userAgent: userAgent,
        });
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
      let html = '<table class="table table-stack"><thead><tr>';
      if (showSlugCol) html += '<th>订阅</th>';
      html += '<th>时间</th><th>节点</th><th>SHA-256</th><th>大小</th><th>来源</th><th>状态</th><th>操作</th>';
      html += '</tr></thead><tbody>';
      for (const e of entries) {
        const v = e.version;
        html += '<tr data-history-slug="' + esc(e.slug) + '" data-history-version="' + esc(v.versionId) + '">';
        if (showSlugCol) html += '<td class="mono cell-primary">' + esc(e.slug) + '</td>';
        html += '<td' + (showSlugCol ? ' data-label="时间"' : ' class="cell-primary"') + '>' + new Date(v.createdAt).toLocaleString() + '</td>';
        html += '<td data-label="节点">' + v.nodeCount + '</td>';
        html += '<td class="mono" data-label="SHA-256">' + esc(v.sha256Prefix) + '</td>';
        html += '<td data-label="大小">' + (v.contentLength / 1024).toFixed(1) + ' KB</td>';
        html += '<td class="mono" data-label="来源">' + esc(v.sourceHost) + '</td>';
        html += '<td>' + (v.isCurrent ? '<span class="badge badge-current">当前</span>' : '') + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-outline btn-sm" onclick="showMeta(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">元数据</button>';
        if (!v.isCurrent) {
          html += '<button class="btn btn-outline btn-sm" onclick="doRollback(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">回滚</button>';
        }
        html += '<button class="btn btn-outline btn-sm" onclick="downloadVersion(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">下载完整配置</button>';
        if (!v.isCurrent) {
          html += '<button class="btn btn-outline btn-sm" onclick="deleteVersion(\\'' + esc(e.slug) + '\\', \\'' + esc(v.versionId) + '\\')">删除</button>';
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

    // --- LLM credential vault ---
    // Credentials are stored encrypted and are only ever read back through the
    // explicit reveal action. Plaintext is never persisted in the DOM, in web
    // storage, or in the URL.

    let llmKeys = [];
    let llmLoaded = false;
    let llmEditingSlug = null;

    function setLlmStatus(ok, msg) {
      showStatus(document.getElementById('llm-status'), ok, msg);
    }

    // Mutations are reflected locally instead of refetching the whole list, so
    // adding/editing/deleting shows up on the same tick as the response.
    function upsertLlmKeyLocal(entry) {
      const existing = llmKeys.filter((item) => item.slug === entry.slug)[0];
      const merged = {
        slug: entry.slug,
        name: entry.name,
        provider: '',
        baseUrl: '',
        models: [],
        tags: [],
        hint: { last4: '', length: 0 },
        secretPresent: true,
        createdAt: entry.updatedAt,
        ...(existing || {}),
        ...entry,
      };
      llmKeys = [merged].concat(
        llmKeys.filter((item) => item.slug !== entry.slug),
      );
      llmLoaded = true;
      renderLlmKeys(llmKeys);
    }

    function removeLlmKeyLocal(slug) {
      llmKeys = llmKeys.filter((item) => item.slug !== slug);
      renderLlmKeys(llmKeys);
    }

    function maskedLlmHint(item) {
      if (!item.secretPresent) return '密文缺失';
      const hint = item.hint || {};
      const tail = hint.last4 ? hint.last4 : '****';
      return '••••••••' + esc(tail);
    }

    function renderLlmKeys(keys) {
      const el = document.getElementById('llm-keys-list');
      if (!keys.length) {
        el.innerHTML = '<div class="empty">暂无大模型密钥，请在下方「添加大模型密钥」中添加一条。</div>';
        return;
      }
      let html = '<table class="table table-stack"><thead><tr>';
      html += '<th>名称</th><th>Slug</th><th>密钥</th><th>更新时间</th><th>操作</th>';
      html += '</tr></thead><tbody>';
      for (let index = 0; index < keys.length; index++) {
        const item = keys[index];
        html += '<tr data-llm-slug="' + esc(item.slug) + '">';
        html += '<td class="cell-primary">' + esc(item.name) + '</td>';
        html += '<td class="mono">' + esc(item.slug) + '</td>';
        html += '<td class="mono" data-label="密钥">' + maskedLlmHint(item) + '</td>';
        html += '<td data-label="更新">' + (item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '-') + '</td>';
        html += '<td><div class="btn-group">';
        html += '<button class="btn btn-primary btn-sm" onclick="openLlmView(\\'' + esc(item.slug) + '\\')">查看/复制</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="openLlmModal(\\'' + esc(item.slug) + '\\')">编辑</button>';
        html += '<button class="btn btn-outline btn-sm" onclick="removeLlmKey(\\'' + esc(item.slug) + '\\')">删除</button>';
        html += '</div></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    async function loadLlmKeys(opts) {
      const silent = !!(opts && opts.silent);
      if (!silent) setLlmStatus(true, '正在加载…');
      try {
        const result = await api('/api/llm/keys');
        if (!result.ok) {
          renderLlmKeys([]);
          setLlmStatus(false, result.error && result.error.message ? result.error.message : '加载失败');
          return;
        }
        llmKeys = (result.data && result.data.keys) || [];
        llmLoaded = true;
        renderLlmKeys(llmKeys);
        const storeNote = document.getElementById('llm-store-note');
        if (result.data && result.data.storeAvailable === false) {
          showStatus(storeNote, false, '当前实例没有配置有效的 INSTANCE_SECRET，无法新增或查看密钥。请在 Worker 中设置至少 32 字节的 INSTANCE_SECRET 后重试。');
        } else {
          storeNote.className = 'status-msg';
          storeNote.textContent = '';
        }
        if (!silent) setLlmStatus(true, '已加载 ' + llmKeys.length + ' 条凭据');
      } catch (error) {
        setLlmStatus(false, error && error.message ? error.message : '加载失败');
      }
    }

    function openLlmModal(slug) {
      llmEditingSlug = slug || null;
      let editing = null;
      for (let index = 0; index < llmKeys.length; index++) {
        if (llmKeys[index].slug === slug) editing = llmKeys[index];
      }
      document.getElementById('llm-name').value = editing ? editing.name : '';
      document.getElementById('llm-slug').value = editing ? editing.slug : '';
      document.getElementById('llm-api-key').value = '';
      const status = document.getElementById('llm-modal-status');
      status.className = 'status-msg';
      status.textContent = '';
      document.getElementById('llm-modal').classList.add('show');
    }

    function closeLlmModal() {
      document.getElementById('llm-api-key').value = '';
      document.getElementById('llm-modal').classList.remove('show');
      llmEditingSlug = null;
    }

    // Add form (下方「添加大模型密钥」), mirrors the subscription add flow.
    async function saveLlmKey() {
      const status = document.getElementById('llm-status');
      const name = document.getElementById('llm-add-name').value.trim();
      const slug = document.getElementById('llm-add-slug').value.trim();
      const apiKey = document.getElementById('llm-add-key').value.trim();
      if (!name || !slug || !apiKey) {
        showStatus(status, false, '请填写所有字段');
        return;
      }
      // Render the row on the same tick as the click, then reconcile with the
      // server. R2 round trips cost a few hundred ms each, so waiting for them
      // before showing anything is what made adding feel slow.
      const previous = llmKeys.filter((item) => item.slug === slug)[0] || null;
      const optimistic = {
        slug: slug,
        name: name,
        hint: { last4: apiKey.slice(-4), length: apiKey.length },
        secretPresent: true,
        updatedAt: new Date().toISOString(),
      };
      upsertLlmKeyLocal(optimistic);
      showStatus(status, true, '正在保存...');
      try {
        const result = await api('/api/llm/keys', {
          method: 'POST',
          body: JSON.stringify({ slug: slug, name: name, apiKey: apiKey }),
        });
        if (!result.ok) {
          // Roll the optimistic row back to whatever was there before.
          if (previous) upsertLlmKeyLocal(previous);
          else removeLlmKeyLocal(slug);
          showStatus(status, false, result.error && result.error.message ? result.error.message : '保存失败');
          return;
        }
        document.getElementById('llm-add-name').value = '';
        document.getElementById('llm-add-slug').value = '';
        document.getElementById('llm-add-key').value = '';
        showStatus(status, true, '已添加：' + name);
      } catch (error) {
        if (previous) upsertLlmKeyLocal(previous);
        else removeLlmKeyLocal(slug);
        showStatus(status, false, error && error.message ? error.message : '保存失败');
      }
    }

    // Edit modal: only 名称 and（可选）轮换 API Key。
    async function saveLlmEdit() {
      const status = document.getElementById('llm-modal-status');
      const name = document.getElementById('llm-name').value.trim();
      const apiKey = document.getElementById('llm-api-key').value.trim();
      if (!name) {
        showStatus(status, false, '名称不能为空');
        return;
      }
      showStatus(status, true, '正在保存...');
      const editingSlug = llmEditingSlug;
      try {
        const payload = { name: name };
        if (apiKey) payload.apiKey = apiKey;
        const result = await api('/api/llm/keys/' + encodeURIComponent(editingSlug), {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        if (!result.ok) {
          showStatus(status, false, result.error && result.error.message ? result.error.message : '保存失败');
          return;
        }
        closeLlmModal();
        const entry = {
          slug: editingSlug,
          name: name,
          updatedAt: new Date().toISOString(),
        };
        if (apiKey) {
          entry.hint = { last4: apiKey.slice(-4), length: apiKey.length };
          entry.secretPresent = true;
        }
        upsertLlmKeyLocal(entry);
        setLlmStatus(true, '已更新：' + name);
      } catch (error) {
        showStatus(status, false, error && error.message ? error.message : '保存失败');
      }
    }

    // --- View a credential ---
    // The row action is the explicit reveal step, so the popup shows the full
    // key immediately. The plaintext is dropped as soon as the popup closes and
    // never touches web storage or the URL.

    let llmViewSlug = null;
    let llmViewSecret = null;

    async function fetchLlmSecret(slug) {
      const result = await api('/api/llm/keys/' + encodeURIComponent(slug) + '/reveal', {
        method: 'POST',
      });
      if (!result.ok) {
        throw new Error(result.error && result.error.message ? result.error.message : '读取失败');
      }
      const secret = result.data && result.data.apiKey ? result.data.apiKey : '';
      if (!secret) throw new Error('服务器未返回密钥');
      return secret;
    }

    async function openLlmView(slug) {
      llmViewSlug = slug;
      llmViewSecret = null;
      const box = document.getElementById('llm-view-secret');
      const status = document.getElementById('llm-view-status');
      // The row this was opened from is always in the list cache, so the title
      // is correct before the key arrives; fall back to the slug just in case.
      const cached = llmKeys.filter((item) => item.slug === slug)[0];
      document.getElementById('llm-view-title').textContent =
        cached && cached.name ? cached.name : slug;
      box.textContent = '正在读取...';
      status.className = 'status-msg';
      status.textContent = '';
      document.getElementById('llm-view-modal').classList.add('show');
      try {
        llmViewSecret = await fetchLlmSecret(slug);
        box.textContent = llmViewSecret;
      } catch (error) {
        box.textContent = '';
        showStatus(status, false, error && error.message ? error.message : '读取失败');
      }
    }

    async function copyLlmPlain() {
      const status = document.getElementById('llm-view-status');
      try {
        if (!llmViewSecret) {
          llmViewSecret = await fetchLlmSecret(llmViewSlug);
          document.getElementById('llm-view-secret').textContent = llmViewSecret;
        }
        await navigator.clipboard.writeText(llmViewSecret);
        showStatus(status, true, '已复制到剪贴板');
      } catch (error) {
        // Clipboard blocked (non-secure context, permission, older browser):
        // the value is already on screen, so point the user at it.
        showStatus(
          status,
          false,
          llmViewSecret ? '无法写入剪贴板，请长按上方密钥手动复制' : error && error.message ? error.message : '复制失败'
        );
      }
    }

    function closeLlmView() {
      llmViewSecret = null;
      llmViewSlug = null;
      document.getElementById('llm-view-secret').textContent = '';
      document.getElementById('llm-view-modal').classList.remove('show');
    }

    async function removeLlmKey(slug) {
      if (!confirm('确认删除“' + slug + '”的凭据？该凭据的密文会被一并删除，且无法恢复。')) return;
      try {
        const result = await api('/api/llm/keys/' + encodeURIComponent(slug), { method: 'DELETE' });
        if (!result.ok) {
          setLlmStatus(false, result.error && result.error.message ? result.error.message : '删除失败');
          return;
        }
        removeLlmKeyLocal(slug);
        setLlmStatus(true, '已删除');
      } catch (error) {
        setLlmStatus(false, error && error.message ? error.message : '删除失败');
      }
    }

    queueMicrotask(() => checkSession());
  </script>
</body>
</html>`;
}
