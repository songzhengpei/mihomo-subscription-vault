# 订阅兼容性最终验收记录

验收日期：2026-07-26（Asia/Shanghai）

本记录只保留脱敏后的主机名和结果，不保存订阅路径、访问令牌、响应正文或后台凭据。

## 403 兼容链路

- 本地普通网络：浏览器 User-Agent 返回 Base64 通用订阅；Clash/SlClash
  User-Agent 返回 Clash YAML。
- Worker 直连：HTTP 403。
- Browser Rendering：HTTP 403。
- 账户私有 VPC 中继：HTTP 200。
- Worker 的实际回退顺序：直连 -> Browser Rendering -> 私有中继。
- 普通成功请求仍在直连阶段结束，不增加中继依赖。
- 日志只记录 slug、随机 request ID、请求方法、状态码和耗时。

## 真实订阅添加与更新

使用隔离的临时 R2 bucket 和最终 Worker 代码，对 `dash.pqjc.site` 的真实订阅执行：

| 操作       | API 结果 | 节点数 | 版本结果     | 抓取方式         |
| ---------- | -------- | -----: | ------------ | ---------------- |
| 首次添加   | 成功     |     72 | 新版本       | relay / HTTP 200 |
| 第二次更新 | 成功     |     72 | 复用同一版本 | relay / HTTP 200 |

验证后删除了 10 个隔离对象和临时 bucket；临时 Worker 配置、日志和本地监听进程
也已清理。正式 R2 bucket 未写入探针数据。

## 自动化和部署验证

- `npm test`：17 个测试文件通过，588 个测试通过，21 个既有测试跳过。
- `npm run typecheck`：通过。
- 本次变更涉及的代码、测试和文档：Prettier 检查通过。
- `wrangler deploy --dry-run`：通过，R2、Browser Rendering、VPC service 和
  Rate Limiter 绑定正确。
- 后台页面回归：11 个 `admin-html` 测试通过。
- 生产后台烟雾测试：生产实例的 `/admin` 返回 HTTP 200，并包含
  登录表单。
- 真实链路复测对应的生产代码版本：
  `ba68e35e-7b5c-4c24-88d1-0f35dcc72343`。
- 提交本验收记录后的最终生产部署：
  `c9b9e750-6fc3-4ebf-9d37-129191fbad41`。

仓库原先已有两个与本次改动无关的 Prettier 告警：

- `src/services/storage.ts`
- `test/storage-version-publish.test.ts`

这两个文件不在本次差异中，没有为了格式化而扩大修改范围。

## 运行状态

- `MihomoSubscriptionVault-Relay`：Running。
- `MihomoSubscriptionVault-Tunnel`：Running。
- 本地中继健康检查：HTTP 200，`{"ok":true}`。
- 私有中继仅监听 `127.0.0.1`，由账户私有 VPC service 访问。
- 隔离测试端口和临时 bucket 均无残留。

## 格式范围

最终支持矩阵见 [订阅格式支持矩阵](subscription-format-support.md)。当前覆盖 8
类常见订阅内容形态、13 种规范化 URI 节点协议和 4 个常见 URI scheme
别名，并明确拒绝 Surge、Stash、Quantumult/Quantumult X 和 sing-box
专属配置。
