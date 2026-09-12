# Mihomo Subscription Vault

把会变化、会失效、格式不统一的代理订阅，保存为由你自己控制的固定 Mihomo
`proxy-providers` 地址。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/songzhengpei/mihomo-subscription-vault)

数据、Worker、R2 Bucket 和访问凭据全部位于**你自己的 Cloudflare 账号**。项目维护者
不提供共享订阅服务，也无法访问你的订阅内容。

> 推荐方式只需要 Cloudflare，不需要购买 VPS，也不需要安装 Docker。一键部署默认包含
> Browser Rendering 回退；Docker Relay 留作少数上游仍然返回 HTTP 403 时的可选能力。

## 功能

- 管理多个上游订阅并生成固定下载地址
- 保存不可变历史快照，支持查看版本和一键回滚
- 保留每次抓取的上游原文快照，可下载后与生成的配置逐行对比
- 统一转换 Clash/Mihomo YAML、JSON、Base64、通用 URI、SIP008 和 SSD
- 导入、导出统一备份，并支持 WebDAV 备份
- 生成 Mihomo、Slclash、Clash Verge Rev 和 OpenClash 可用的配置
- 管理页面使用用户名和密码登录，下载链接使用独立随机 Token
- 内置 SSRF 防护、响应大小限制、超时限制和安全重定向检查

## 一键部署（推荐）

准备一个 Cloudflare 账号和一个 GitHub 或 GitLab 账号，然后：

1. 点击上方 **Deploy to Cloudflare**；
2. 选择自己的 Cloudflare 账号，接受默认的 Worker、R2 和 Browser Rendering 配置；
3. 为 `INSTANCE_SECRET` 填写至少 32 个字符的随机值并妥善保存；
4. 等待 Cloudflare 完成构建和部署；
5. 打开部署结果中的 `workers.dev` 地址，页面会自动进入 `/setup`；
6. 再次输入 `INSTANCE_SECRET`，设置管理员用户名和密码；
7. 保存页面只显示一次的 API Token，然后进入管理后台。

Cloudflare 会从仓库配置自动创建并绑定私有 R2 Bucket，同时为 Worker 声明 Browser
Rendering Binding。部署流程会在你的 GitHub/GitLab 账号创建一份仓库副本，并配置后续
自动构建。官方流程说明见
[Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

### 生成 INSTANCE_SECRET

可直接使用密码管理器生成 32 个以上随机字符，也可以在本机执行：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`INSTANCE_SECRET` 是实例主密钥。首次初始化生成的管理员 Token、下载 Token、密码派生值
和会话密钥会先使用它进行 AES-GCM 加密，再写入私有 R2。不要把它提交到 Git、发给
他人或随意轮换；丢失后将无法解密实例配置。

## 开始使用

### 添加订阅

1. 打开 `https://<你的 Worker 地址>/admin`；
2. 使用初始化时设置的用户名和密码登录；
3. 添加订阅名称、Slug 和上游订阅地址；
4. 点击“测试并更新”；
5. 从管理页面复制固定 Provider 地址。

### Mihomo 配置示例

```yaml
proxy-providers:
  main:
    type: http
    url: "https://<你的 Worker 地址>/provider/main/<DOWNLOAD_TOKEN>"
    path: ./proxy_providers/main.yaml
    interval: 86400
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
```

同一段配置可以用于 Slclash、Clash Verge Rev 和 OpenClash。

### 历史版本与备份

- 每次成功更新都会创建不可变历史版本；
- 回滚只切换最新版本指针，不会修改旧快照；
- 「原始快照」页保存每次抓取到的上游原文（未转换、保留注释与锚点），可下载后与
  下载到的完整配置逐行对比；
- 可从管理页面导出完整 ZIP 备份；
- 可配置 WebDAV 保存异地备份。

建议在升级 Worker 前导出一次完整备份。删除 Worker 不会自动删除 R2 Bucket；不要在
确认备份前手动删除 Bucket。

## 自定义域名（可选）

`workers.dev` 地址可以直接使用，自定义域名不是部署必需项。如果域名已经托管在同一
Cloudflare 账号，可以在 Dashboard 中进入：

`Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add`

添加域名后无需重新初始化。应用默认根据当前请求地址生成 Provider 和导出链接。

## 手动部署

一键部署失败或需要参与开发时，才建议使用命令行：

```bash
git clone https://github.com/songzhengpei/mihomo-subscription-vault.git
cd mihomo-subscription-vault
npm ci
npx wrangler login
npx wrangler r2 bucket create mihomo-subscription-vault
```

复制本地 Secret 模板并修改 `INSTANCE_SECRET`：

```bash
cp .dev.vars.example .dev.vars
```

部署前验证：

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir=.wrangler/dist
npm run deploy
```

部署完成后访问 `/setup`。生产 Secret 应使用 Cloudflare Dashboard 或
`npx wrangler secret put INSTANCE_SECRET` 设置，不能把 `.dev.vars` 提交到仓库。

## 部署结构

```text
Mihomo / Slclash / Browser
              │
              ▼
      Cloudflare Worker
       ├─ Admin UI / API
       ├─ Provider / Config API
       ├─ Converter / Validator
       ├─ 上游拉取：直连 → Browser Rendering 回退
       └─ R2 Bucket
          ├─ 加密实例设置
          ├─ 订阅元数据
          ├─ 当前版本指针
          └─ 不可变历史快照
```

默认部署使用 Worker、R2 和 Browser Rendering；浏览器只在直连返回 HTTP 403 时启动。
以下其余能力均为可选：

| 能力                     | 默认启用 | 什么时候需要                     |
| ------------------------ | -------: | -------------------------------- |
| 自定义域名               |       否 | 希望使用自己的短域名             |
| Login Rate Limit Binding |       否 | 希望使用 Cloudflare 原生登录限流 |
| Browser Rendering        |       是 | 直连 403 时自动尝试浏览器拉取    |
| VPS Docker Relay + VPC   |       否 | 直接请求和 Browser 回退仍然 403  |

## 上游返回 HTTP 403

应用会先直接拉取订阅；仅当上游返回 HTTP 403 时，自动使用 Browser Rendering
重试。一键部署已经包含 `BROWSER` Binding，不需要额外配置。Browser Rendering
只在回退时启动，以减少配额消耗。当前额度请查看
[Cloudflare Browser Run 定价](https://developers.cloudflare.com/browser-run/pricing/)。

如果两种方式都失败，先确认订阅链接在普通浏览器中仍然有效，并尝试更换
User-Agent。只有 Worker 日志仍明确显示来源网络限制时，才考虑私有 VPS Relay。

VPS Relay 必须部署在你自己的服务器，并使用你自己的 Cloudflare Tunnel 与 VPC
Service。完整步骤见[可选私有上游中继](docs/private-upstream-relay.md)。

`deploy/vps-relay/` 不是完整 Docker 版应用，它只负责受限上游请求的最后一级回退。
普通用户不应部署它。

## 旧版 Secret 配置兼容

已有实例可以继续使用以下 Worker Secrets，无需执行 `/setup`：

- `ADMIN_TOKEN`
- `DOWNLOAD_TOKEN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `SESSION_SECRET`

当这五项配置完整有效时，应用优先使用旧版配置；`INSTANCE_SECRET` 初始化模式不会
覆盖已有数据。维护现有生产实例时可以复制 `wrangler.production.example.jsonc` 为
被 Git 忽略的 `wrangler.production.jsonc`，然后运行 `npm run deploy:production`。

## 支持范围

支持 Clash/Mihomo YAML 与 JSON、Base64 或未编码的通用代理 URI、SIP008、SSD，
以及 Clash Meta 和 Shadowrocket 常用节点 URI。完整协议、编码边界和明确排除项见
[订阅格式支持矩阵](docs/subscription-format-support.md)。

不转换 Surge、Stash、Quantumult/Quantumult X、sing-box 等客户端的完整专属配置。
Shadowrocket 完整配置文件也不转换，但其中常见的独立代理 URI 属于支持范围。

## 安全提示

- 只从本仓库或你信任的 Fork 部署；
- 不要提交 `.dev.vars`、Token、密码、订阅地址或 WebDAV 凭据；
- R2 Bucket 保持私有，不需要配置公开访问；
- Provider URL 中含下载 Token，不要发布到公开 Issue 或日志；
- 定期导出备份，并在升级后验证登录和 Provider 下载；
- 发现安全问题请阅读 [Security Policy](SECURITY.md)，不要公开披露凭据。

## 开发

```bash
npm ci
npm run dev
npm run typecheck
npm run format:check
npm test
```

当前项目使用 Cloudflare Workers、R2、TypeScript 和 Vitest。提交功能改动前请保证类型
检查、格式检查、完整测试和 Wrangler dry-run 全部通过。

## License

[MIT](LICENSE)
