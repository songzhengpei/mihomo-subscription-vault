# 大模型凭据保管（LLM Credential Vault）设计文档

> 本文档定义在 Mihomo Subscription Vault 中新增"大模型 API 凭据保管"能力的完整设计。
> **只提交设计文档，不修改功能代码。** 实施需在本文档评审通过后单独进行。
>
> 文档中的域名、密钥、账号均为占位示例，不是生产配置。

---

## 1. 结论

**方案可行，且可以作为纯增量模块接入，不需要改动任何现有主链路。**

判断依据：

1. 现有 Vault 已经具备本项目所需的全部底座：私有 R2 存储、`INSTANCE_SECRET` 派生的
   AES-GCM 加密范式、基于管理员会话/`ADMIN_TOKEN` 的管理 API 通道、单文件管理后台。
2. 节点订阅与大模型凭据在数据模型上**没有共享字段**，因此不需要也不应该复用
   `providers/*` 的版本发布机（`publishProviderVersion`）、订阅顺序文档
   （`vault/provider-order.json`）或统一母包格式。
3. 本方案**不新增任何公开（匿名可访问）路由**，因此不增加新的攻击面。
4. 备份场景下 `llm/` 数据**结构性不可见**，无需任何"排除"代码，详见第 8 节。

---

## 2. 需求与已确认边界

### 2.1 目标

在管理后台中安全地保管少量大模型平台凭据（首批：小米 tokenplan 静态 API Key、
DeepSeek API），并支持**人工复制**到其它客户端或脚本使用。

### 2.2 已确认的范围决策

| 决策项 | 结论 | 对设计的影响 |
| --- | --- | --- |
| 小米凭据形态 | **静态 API Key** | 不涉及 OAuth / 登录态刷新，无 Cron Trigger，无会话失效处理 |
| 消费方式 | **维护者人工复制** | **不需要**公开下载路由、不需要 per-key 读取令牌、不需要格式适配器、不需要下载限流 |
| 备份 | **不需要备份这部分数据** | 默认排除是结构性保证，零代码（第 8 节） |
| 本轮产出 | **只出设计文档** | 不写功能代码，不改 `wrangler.jsonc` |

### 2.3 明确的非目标（本轮不做）

- 不做 `/keys/{slug}/{token}` 之类的公开读取路由。
- 不做 OpenAI / MiMo 等平台的请求格式适配或可用性探测（不主动向平台发请求）。
- **不把凭据纳入统一母包 ZIP**（`mihomo-unified-backup`），不引入 `formatVersion: 3`。
  原因见 8.3。
- 不做 OAuth 登录态、会话续期、套餐额度查询。
- 不做多用户、共享、权限分级。
- 不改 `wrangler.jsonc`、`package.json` 依赖、`.dev.vars.example` 必填项。

---

## 3. 与现有系统的一致性分析

### 3.1 为什么不能复用节点订阅的数据模型

| 维度 | 节点订阅 | 大模型凭据 |
| --- | --- | --- |
| 数据来源 | 上游 URL 拉取，可重试、可回滚 | 人工录入，无上游 |
| 更新语义 | 每次拉取生成不可变 `versionId` | 原地更新 + 轮换，重点是失效与替换 |
| 关键统计 | `nodeCount`、`nodeStats` | 无 |
| 泄露后果 | 节点可用性受影响 | 直接造成账号与费用损失 |
| 需要的保护 | 访问令牌 | 访问令牌 **+ 静态加密** |

结论：独立命名空间 + 独立存储模块，不进入 `providers/*`。

### 3.2 为什么独立前缀就足够隔离

现有代码中所有节点订阅的枚举与批处理都以 `providers/` 字面前缀为界：

- `src/services/storage.ts:636` `listSlugs()` — `bucket.list({ prefix: "providers/", delimiter: "/" })`
- `src/services/storage.ts:650` `PROVIDER_ORDER_KEY = "vault/provider-order.json"`
- 统一母包导出/导入以 `providers/*` 与 manifest 为准

因此新数据写入 `llm/` 前缀后，**对现有枚举、排序、导出、清理逻辑天然不可见**，
无需在任何现有查询上追加排除条件（这正是"不影响主功能"的核心保证）。

### 3.3 为什么不需要改 `src/index.ts`

`src/index.ts:83-99` 已经把 `/api/*` 统一收敛为：

```text
/api/* → handleAdminAuthRoute（登录 / 会话类路由）
       → 无 Authorization 且会话有效时，内部翻译为 Bearer ADMIN_TOKEN
       → handleApi(request, env, path)
```

新管理 API 使用 `/api/llm/*`，**自动继承上述鉴权与 CSRF 保护**
（`src/security/admin-session.ts:246` 的 `hasValidAdminSession` 对非
`GET/HEAD/OPTIONS` 请求强制同源校验），无需改动入口路由。

---

## 4. 数据模型

### 4.1 R2 对象布局

```text
llm/{slug}/meta.v1.json          # 明文元数据（列表与详情使用）
llm/{slug}/secret.v1.enc.json    # AES-GCM 密文（仅在 reveal / 校验时读取）
```

设计理由（**两个对象，而不是一个合并对象**）：

1. 列表页与详情页**永不读取密文**，从代码路径上消除"密文被误序列化进响应或日志"的可能。
2. 轮换 API Key 时不必重写元数据对象，减少并发冲突面。
3. 与仓库既有的"指针记录 + `sha256` 校验点"风格一致
   （参考 `LatestVersionPointer.metaKey` / `metaSha256`）。

代价与取舍：对象数量翻倍，且 R2 无事务，需要明确的写入顺序与一致性校验（见 4.4）。
在凭据数量为个位数的场景下，该代价可以忽略。

### 4.2 `llm/{slug}/meta.v1.json`

```jsonc
{
  "schemaVersion": 1,
  "slug": "deepseek-main",
  "name": "DeepSeek 主账号",
  "provider": "deepseek",                       // 平台标识，自由字符串
  "baseUrl": "https://api.deepseek.com",        // 仅 https
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "notes": "",                                  // 提示：不要在此写真实密钥
  "tags": [],
  "hint": { "last4": "a1b2", "length": 35 },    // 仅用于列表辨识，见 7.4
  "secret": {
    "key": "llm/deepseek-main/secret.v1.enc.json",
    "sha256": "<密文对象字节的 SHA-256，64 位小写十六进制>",
    "updatedAt": "2026-08-27T00:00:00.000Z"
  },
  "createdAt": "2026-08-27T00:00:00.000Z",
  "updatedAt": "2026-08-27T00:00:00.000Z"
}
```

字段校验规则：

| 字段 | 规则 |
| --- | --- |
| `slug` | 复用现有 `validateSlug`（`src/security/ssrf.ts`），`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` |
| `name` | 1–64 字符，去除首尾空白后非空 |
| `provider` | **可选**（UI 不采集）。留空存 `""`；提供时须为 1–32 字符 `[a-z0-9._-]` |
| `baseUrl` | **可选**（UI 不采集）。留空存 `""`；提供时须为合法 `https:` URL，不得内嵌用户名密码 |
| `models` | 可选数组，≤ 100 项，每项 1–128 字符 |
| `notes` | 可选，≤ 2000 字符 |
| `tags` | 可选数组，≤ 20 项，每项 1–32 字符 |

**UI 只采集 `name` / `slug` / `apiKey` 三项**（见 7.3）。其余字段保留在数据模型与 API 中，
以便将来需要时无需迁移即可启用；`provider` / `baseUrl` 留空时存空字符串，属于合法状态。

**slug 空间与订阅 slug 相互独立**：`llm/deepseek` 与 `providers/deepseek` 不冲突，
因为前缀不同。文档与 UI 需要明示这一点，避免使用者误以为两者联动。

### 4.3 `llm/{slug}/secret.v1.enc.json`

```jsonc
{
  "schemaVersion": 1,
  "algorithm": "AES-GCM",
  "kdf": "HKDF-SHA256",
  "info": "msv/llm-credential/v1",
  "iv": "<base64url，12 字节>",
  "ciphertext": "<base64url>"
}
```

明文载荷：

```jsonc
{ "apiKey": "<平台密钥>", "extra": {} }   // extra 为将来预留，本轮恒为空对象
```

加密与密钥派生细则见第 5 节。

### 4.4 写入顺序与一致性

R2 不支持事务，因此以 **`meta.secret.sha256` 作为唯一提交点**：

**新建**

1. 计算密文与其 SHA-256。
2. `put(secret)`，带 `onlyIf: { etagDoesNotMatch: "*" }`。
   失败 → `LLM_KEY_CONFLICT`（slug 已存在）。
3. `put(meta)`，带 `onlyIf: { etagDoesNotMatch: "*" }`。
   失败 → 残留孤儿密文（无害，下次同 slug 创建会被覆盖），返回 `LLM_KEY_CONFLICT`。

**轮换 API Key**

1. 读 `meta` 取当前 ETag；读 `head(secret)` 取当前 ETag。
2. `put(secret)`，带 `onlyIf: { etagMatches: <当前 secret ETag> }`。
3. 更新 `meta.secret.sha256` / `meta.secret.updatedAt` / `meta.updatedAt`，
   带 `onlyIf: { etagMatches: <当前 meta ETag> }`。

**失败模式（必须 fail closed）**：若第 2 步成功、第 3 步失败，则 `meta.secret.sha256`
与磁盘密文不一致。读取端在 reveal 前必须校验 SHA-256，不一致时返回
`LLM_KEY_CORRUPTED` 并拒绝输出密钥，**绝不返回旧值或猜测值**。用户重新保存一次即可修复。

**删除**

1. 先删 `meta`（条目立即从列表消失）。
2. 再删 `secret`；若失败则残留密文，无害，可再次删除清理。

**枚举**

列表通过 `bucket.list({ prefix: "llm/", delimiter: "/" })` 的 `delimitedPrefixes`
取得 slug，正则 `^llm/([^/]+)/$`，写法照抄 `storage.ts:636` 的 `listSlugs()`。
**不引入 registry 索引文件**——索引会引入额外的并发写一致性负担，而 R2 前缀枚举
已经足够，且天然不会与数据不一致。

---

## 5. 加密与密钥派生

### 5.1 密钥派生（域分离）

现有 `src/services/instance-config.ts:78` 使用 `SHA-256(INSTANCE_SECRET)` 直接作为
AES-GCM 密钥，没有域分离。新模块**不复用同一密钥材料**，改为：

```text
PRK      = HKDF-Extract(salt = "msv/llm-credential/v1", IKM = INSTANCE_SECRET)
AES key  = HKDF-Expand(PRK, info = "msv/llm-credential/v1", L = 32)
```

目的：即使将来其中之一的使用方式出现问题，也不会连带影响另一处的密钥材料。

**降级路径**：若目标运行时的 `crypto.subtle` 不支持 HKDF，回退为
`SHA-256(INSTANCE_SECRET || "msv/llm-credential/v1")`。两条路径都与
`instance-config` 的 `SHA-256(INSTANCE_SECRET)` 不同，域分离性质保持成立。
实施时需在 `test/llm-crypto.test.ts` 中固化实际使用的派生向量，防止无意变更导致
已存密文无法解密。

### 5.2 加密参数

| 项 | 取值 |
| --- | --- |
| 算法 | AES-GCM，256 位密钥 |
| IV | 每次加密 `crypto.getRandomValues(12)`，**绝不复用** |
| 编码 | base64url 无填充（复用 `instance-config.ts` 的 `encodeBase64Url` 写法） |
| 密文校验 | 存储后按字节计算 SHA-256，写入 `meta.secret.sha256` |

### 5.3 缺少 `INSTANCE_SECRET` 时的行为

旧版 Secret 兼容实例（`hasLegacyConfiguration` 为真）可能没有配置
`INSTANCE_SECRET`。此时：

- **拒绝存储**，返回 `LLM_STORE_UNAVAILABLE`（HTTP 503）。
- 后台在该 tab 顶部显示明确提示：需要在 Worker 配置中设置至少 32 字节的
  `INSTANCE_SECRET` 后才能使用本功能。
- **绝不静默降级为明文存储。**

### 5.4 与 `INSTANCE_SECRET` 的生命周期关系

与 `config/instance.v1.enc.json` 一致：**更换 `INSTANCE_SECRET` 会导致已存凭据无法解密**
（表现为 `LLM_KEY_CORRUPTED`）。这一点必须写入 UI 提示与文档，属于已知且可接受的约束。

---

## 6. 管理 API 契约

全部挂在 `/api/llm/*`，由既有 `/api/*` 通道提供鉴权。模块内**每个分支**先执行
`verifyAdminAuth(request, env)`，失败返回
`errorResponse("UNAUTHORIZED", "管理员身份验证失败", 401)`，与
`src/routes/api.ts` 现有 20 余处写法完全一致。

### 6.1 端点一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/llm/keys` | 列表（**不含明文，不含密文**） |
| `POST` | `/api/llm/keys` | 新建 |
| `GET` | `/api/llm/keys/{slug}` | 详情（**不含明文，不含密文**，含完整性状态） |
| `PUT` | `/api/llm/keys/{slug}` | 更新元数据；可选同时轮换 API Key |
| `DELETE` | `/api/llm/keys/{slug}` | 删除 |
| `POST` | `/api/llm/keys/{slug}/reveal` | **唯一的明文出口** |

### 6.2 请求 / 响应示例

`GET /api/llm/keys` → `200`

```json
{
  "ok": true,
  "data": {
    "keys": [
      {
        "slug": "deepseek-main",
        "name": "DeepSeek 主账号",
        "provider": "deepseek",
        "baseUrl": "https://api.deepseek.com",
        "models": ["deepseek-chat"],
        "tags": [],
        "hint": { "last4": "a1b2", "length": 35 },
        "secretPresent": true,
        "secretUpdatedAt": "2026-08-27T00:00:00.000Z",
        "createdAt": "2026-08-27T00:00:00.000Z",
        "updatedAt": "2026-08-27T00:00:00.000Z"
      }
    ]
  }
}
```

列表只对 `secret` 做 `head()` 判断存在性（`secretPresent`），**不读体、不算哈希**，
以保证列表响应时间与凭据数量线性且廉价。完整哈希校验放在详情与 reveal。

`POST /api/llm/keys` 请求体（后台实际提交的最小形态）：

```json
{
  "slug": "deepseek",
  "name": "DeepSeek 主账号",
  "apiKey": "<平台密钥>"
}
```

其余元数据字段（`provider` / `baseUrl` / `models` / `notes` / `tags`）仍可传，均为可选。

→ `201 { "ok": true, "data": { "slug": "deepseek" } }`

`PUT /api/llm/keys/{slug}` 请求体：上述元数据字段均可选；
若携带非空 `apiKey`，则执行第 4.4 节的轮换流程。

`POST /api/llm/keys/{slug}/reveal` → `200`

```json
{
  "ok": true,
  "data": {
    "slug": "deepseek-main",
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "<平台密钥>"
  }
}
```

**为什么用 `POST` 而不是 `GET`**：避免浏览器预取、避免进入浏览历史与 Referer，
并让"取明文"成为一个明确且可审计的动作（后续若需要二次验证，只需改这一个分支）。

**为什么明文不放在 URL 或查询参数**：URL 会进入 Cloudflare 访问日志；密钥必须只出现在
响应体中。响应统一使用 `src/routes/api.ts:33` 的 `json()`，已带
`Cache-Control: private, no-store`、`Pragma: no-cache`、`X-Content-Type-Options: nosniff`。

### 6.3 错误码

| code | HTTP | 场景 |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | 管理员鉴权失败（沿用现有码） |
| `INVALID_SLUG` | 400 | slug 不合法 |
| `INVALID_LLM_PAYLOAD` | 400 | 字段校验失败（长度、URL 非 https、模型数量等） |
| `INVALID_LLM_QUERY` | 400 | 意外的查询参数 |
| `LLM_KEY_NOT_FOUND` | 404 | slug 不存在 |
| `LLM_KEY_CONFLICT` | 409 | slug 已存在 / ETag 并发冲突 |
| `LLM_KEY_CORRUPTED` | 500 | 密文哈希与 `meta` 记录不一致，或解密失败 |
| `LLM_STORE_UNAVAILABLE` | 503 | 缺少合法 `INSTANCE_SECRET` |
| `LLM_STORE_WRITE_FAILED` | 500 | R2 写入未按预期成功 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不支持（响应带 `Allow` 头） |
| `NOT_FOUND` | 404 | `/api/llm/` 下的未知路径 |

实施补充：`GET /api/llm/keys` 的响应额外包含 `storeAvailable`（当前实例是否配置了
合法的 `INSTANCE_SECRET`），用于让后台在用户输入密钥之前就给出常驻提示。

---

## 7. 后台 UI 设计

### 7.1 布局决策：独立 tab，不与订阅混排

**结论：新增独立 tab「大模型密钥」，与「订阅列表」完全分开。**

三个候选方案的对比：

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A. 独立 tab（推荐）** | 新增 `data-tab="llm"` 与 `#tab-llm` | 零侵入：tab 切换由 `admin-html.ts:789-795` 的通用监听器自动处理 |
| B. 同 tab 内上下分区 | 在 `#tab-list` 内追加第二个表格 | 不推荐：两个表格的"刷新/添加"按钮归属混乱；`loadProviders()` 会连带加载凭据 |
| C. 完全混排一张表 | 在现有表格里插入凭据行 | 不推荐：侵入最大，直接破坏隔离契约 |

推荐 A 的四条理由：

1. **字段与操作没有交集**：订阅行是"节点数 / 更新时间 / 编辑 / 更新 / Provider 链接"，
   凭据行是"密钥 / 更新时间 / 编辑 / 查看并复制 / 删除"。
2. **排序语义会被污染**：订阅列表有完整的拖拽排序（`/api/providers/order` +
   `vault/provider-order.json` + `target.parentElement.insertBefore` 逻辑），
   凭据混入后"第几个"这件事就没有意义了。
3. **现有测试是硬约束**：`test/admin-html.test.ts` 对 `subscription-card`、
   拖拽排序、表格结构有大量字符串级断言（第 122–139 行）。混排必须改
   `renderProviders`，会直接触碰这些断言——而这正是隔离契约要避免的。
4. **风险分层**：凭据页面是唯一会出现明文的"高危页面"，独立后可以单独加二次确认、
   单独设定自动清空策略，完全不影响日常订阅操作。

**tab 顺序**：「大模型密钥」紧跟「订阅列表」，即
`订阅列表 | 大模型密钥 | 历史版本 | 导入与导出`，`#tab-llm` 区块在源码中同样紧随
`#tab-list`。

### 7.2 tab 与懒加载

在 `.tabs` 中插入（第二位）：

```html
<button class="tab" data-tab="llm">大模型密钥</button>
```

并新增 `<div id="tab-llm" class="tab-content">…</div>`，与既有 `tab-list` /
`tab-history` / `tab-backup` 同级。tab 切换由既有通用监听器自动处理，无需改动。

数据懒加载在既有分支后追加一行，风格对齐既有写法：

```js
if (name === 'llm' && !llmLoaded) { llmLoaded = true; loadLlmKeys({ silent: true }); }
```

订阅的「添加订阅」卡片位于所有 tab 之外，因此在「大模型密钥」tab 激活时用一段
**追加的**监听器把它隐藏，避免同屏出现两个添加表单（不改动既有监听器）。

### 7.3 布局与表单：与订阅列表保持一致的样式

样式完全复用订阅一侧的既有类，不新增 CSS：

```text
#tab-llm
├── .card > .card-header（.card-title「所有大模型密钥」+ 刷新按钮）   ← 对齐「所有订阅」
│   └── #llm-keys-list（.table）
└── .update-section > .card                                        ← 对齐「添加订阅」
    ├── .section-title「添加大模型密钥」
    ├── .form-group 名称    → #llm-add-name
    ├── .form-group Slug    → #llm-add-slug
    ├── .form-group API Key → #llm-add-key（type=password）
    ├── 按钮「保存并添加」（.btn.btn-primary）
    └── #llm-status（.status-msg）
```

- **列表在上、表单在下**：与订阅 tab 的信息层级一致，添加成功后原地刷新列表
  （`loadLlmKeys({ silent: true })`），新条目立刻出现在上方。
- **表单只保留 名称 / Slug / API Key 三项**，其余字段从 UI 移除（不删数据模型）。
- 提交前校验文案与订阅侧对齐（"请填写所有字段"）。
- 添加成功后清空三个输入框，其中 API Key 必须清空（明文不进 DOM 常驻）。

列表列：**名称 / Slug / 密钥（打码）/ 更新时间 / 操作**。

操作按钮（`.btn-outline.btn-sm`，与订阅行一致）：

- **查看/复制** — 打开查看弹窗（见 7.4）：先在弹窗里看，需要时在弹窗内复制。
- **编辑** — 打开精简后的 modal（仅 名称 + API Key，Slug 只读展示）。
  编辑时 API Key 留空表示"不修改"；填了则走 4.4 的轮换流程。
- **删除** — 二次确认，文案风格对齐既有 `confirm('确认导入“'…)`。

### 7.4 明文呈现：点「查看/复制」即见全文

按钮必须名副其实。行内的「查看/复制」**本身就是那次显式揭示动作**，
所以弹窗打开即显示完整密钥，不设第二次确认：

- **标题栏两级结构**：主标题是大字号的凭据名称（`#llm-view-title`，`.modal-title`），
  下面一行安静的大写小标签 `API Key`（`.modal-subtitle`，复用表头那套
  `uppercase + letter-spacing` 排版语言）。名称来自列表缓存，因此在密钥返回之前就已渲染。
  名称过长时 `word-break: break-word` 换行，不会撑破窄屏。
- 弹窗取最小形态（`.modal-sm`）：标题 + 一个 `.secret-value` 值 + **「复制」「关闭」两个按钮**。
  名称只在标题出现一次，正文不重复名称 / Slug。
- 明文只存在于弹窗打开期间：**关闭时立即清空保存变量与 DOM 文本**，
  不写 `localStorage` / `sessionStorage` / URL / `title`。
- 「复制」写剪贴板；被拒时（非安全上下文、无权限、旧浏览器）提示长按屏幕上的明文手动复制，
  **绝不把明文拼进状态文字**。
- 打开后不再打码、不设「显示 / 隐藏」切换。
- `hint.last4` 明文存储于 `meta`。风险评估：密钥为高熵随机串，泄露末 4 位不构成
  有效攻击面（与 Stripe 等平台的通行做法一致），但**必须写入安全说明**，让使用者知情。
- **已知取舍**：不做 30 秒自动隐藏。若要恢复该行为，必须连同「显示 / 隐藏」一起加回，
  否则明文会在用户阅读过程中凭空消失。

### 7.5 必须遵守的 UI 约束（否则会挂现有测试）

`test/admin-html.test.ts` 对 HTML 做字符串级断言，其中以下为硬约束：

- `expect(html).not.toContain("Authorization")`（第 25 行）
- `expect(html).not.toContain("sessionStorage")`（第 26 行）
- `expect(html).not.toContain("ADMIN_TOKEN")`（第 115 行）
- `expect(html).not.toContain("admin_token")`（第 116 行）

因此新 tab 的脚本**必须只使用既有的 `api(path, opts)`（`admin-html.ts:803`）
或 `authenticatedFetch(path, opts)`（`admin-html.ts:819`）**，不得自行拼接鉴权头。

### 7.6 移动端约束（项目级要求）

**本项目的所有 UI 改动必须同时考虑桌面端与移动端**，不得只在宽屏下验收。已经踩到
并固化为测试的坑：

| 约束 | 原因 | 对应实现 |
| --- | --- | --- |
| 列表容器要能横向滚动 | 窄屏下表格列会被压扁，操作按钮折行 | `#llm-keys-list { overflow-x: auto; }` + `.btn { white-space: nowrap; }` + 末列右对齐，与订阅列表**三条规则同形** |
| 长密钥必须强制换行 | token 无空格，默认不折行会撑破弹窗 | `.secret-value { word-break: break-all; overflow-wrap: anywhere; }` |
| 弹窗按钮行要能换行 | 窄屏下三个按钮可能溢出 | 操作行加 `flex-wrap:wrap` |
| 一键选中长值 | 手机上拖动选择几十字符极难 | `.secret-value { user-select: all; }` |
| 值弹窗必须够小 | 只放一个值却占满屏在手机上很难看 | `.modal-sm { max-width: 420px; padding: 20px; }` |
| 明文不常驻 | 关闭即清空是唯一的清理时机 | 打开弹窗期间才持有明文，关闭时清空变量与 DOM |

新增 UI 时，除了 `npm test`，还应确认窄屏（≈360px 宽）下没有出现**整页横向滚动**——
列表溢出必须被容器接住，而不是把 `<body>` 撑宽。

---

## 7A. 性能约定（2026-09-11 性能轮）

### 7A.1 R2 往返预算

这些接口的成本几乎完全由 R2 往返次数决定，改动时必须维持下列上限：

| 接口 | 之前的往返 | 现在 | 做法 |
| --- | --- | --- | --- |
| `GET /api/providers/{slug}/history` | 2 次 list + 2 次指针 + **每版本一次串行 get** | 1 次指针 + 1 次 list + N 次**有界并发** get | `listVersions` 改为有界并发；去掉 GET 上的冗余 prune |
| `GET /api/providers` | 每订阅 4 次**同一个** meta + 1 次 source-url，分 3 段串行 | 每订阅 1 次 pointer + 1 次 meta + 1 次 source-url，分 2 段 | `readProviderListEntry` 单遍读取；order 文档与 slug 列表并行 |
| `GET /api/llm/keys` | 1 次 list + 每凭据 1 次 **HEAD** | 1 次 list + N 次并行 meta get | 一次列举同时得到 slug 与存在的密文键 |
| `POST /api/llm/keys/{slug}/reveal` | 2 次读同一份密文 + 1 次哈希 | 1 次读 + 1 次哈希 | 校验与解密共用同一份字节 |

**read 路径不得写。** history 曾在 GET 里调用 prune（发布路径 `publishProviderVersion`
已经 prune），既翻倍了开销又让 GET 产生副作用，已移除。

守卫测试（防止回退）：`test/storage-version-publish.test.ts` 断言版本元数据读取的
**并发度 > 1**；`test/llm-key-store.test.ts` 断言列表只发 1 次 list 且 **0 次 HEAD**、
reveal 只读 **1 次**密文。

### 7A.2 前端：所见即所得

| 约定 | 实现 |
| --- | --- |
| 刷新立刻出现骨架 | `checkSession()` 先 `showMainScreen()` + 占位，再校验会话；失败才回登录页（`/admin` 本身是无数据的公开 HTML，提前渲染不泄露任何信息） |
| 点击 tab 不等待 | 认证通过后 `loadAllViews()` 一次性并行预取 providers / credentials，紧随其后预取 history 与 WebDAV 配置 |
| 增删改同帧生效 | 凭据与订阅的写操作都用返回结果**本地更新列表**（`upsertLlmKeyLocal` / `removeLlmKeyLocal` / `upsertProviderLocal`），随后后台静默对账，不再让用户等第二次往返 |
| 面板不留白 | `showLoadingPlaceholders()` 保证每个面板在数据到达前都有「加载中...」 |

**注意**：写操作后的本地更新只是乐观呈现，最终仍以服务端为准；因此后台对账调用
（`loadProviders({ silent: true })` 等）**不得移除**。

### 7A.3 测量方法

从本机经公网测总量会被网络抖动淹没（同一时刻 `/admin` 纯静态页就可能 179–1262 ms）。
应使用 **TTFB 最小值**（`curl -w %{time_starttransfer}`，多次取最小）来近似服务端耗时，
并与 `/admin` 基线相减。不要再拿单次总耗时下结论。

---

## 8. 备份策略

### 8.1 结论

| 诉求 | 可行性 | 做法 |
| --- | --- | --- |
| **不备份凭据**（当前需求） | ✅ 已天然满足 | **零代码**，不需要任何"剔除"逻辑 |
| **要备份凭据** | ✅ 可行 | 但**不能塞进统一母包**，须用独立凭据包（8.4） |

关键认知：**这里不存在"剔除"这个动作。** `llm/` 数据从一开始就不在导出的数据集合里，
所以既不需要写排除代码，也不存在"将来忘记排除"的回归风险。这比"导出了再过滤掉"
要可靠得多。

### 8.2 证据：导出链路根本不枚举 `llm/`

全仓库只有 4 处 `bucket.list()` 调用，**全部使用字面前缀，不存在 bucket 级全量枚举**：

| 位置 | 前缀 | 用途 |
| --- | --- | --- |
| `src/services/storage.ts:636` | `providers/` | `listSlugs()`，订阅枚举 |
| `src/services/storage.ts:869` | `providers/{slug}/versions/` | 版本历史 |
| `src/services/storage.ts:1125` | `providers/{slug}/staging/` | 暂存区 |
| `src/services/main-config-storage.ts:893` | `main-config/versions/` | 主配置版本 |

统一母包导出的数据来源是 `src/services/unified-export.ts:276` 的
`await storage.listSlugs(bucket)`，即上表第一行的 `providers/` 前缀。

而 `buildUnifiedExport` 的全部三个消费者，都继承这一排除结果：

| 消费者 | 位置 | 影响 |
| --- | --- | --- |
| WebDAV 推送 | `src/routes/api.ts:254` | **凭据不会上传到第三方云盘** |
| 母包导出 API | `src/routes/api.ts:703` | 导出的 ZIP 不含凭据 |
| 客户端配置下载 | `src/routes/config.ts:224` | 分发给客户端的包里不含凭据 |

其中 WebDAV 这一条尤其重要：母包会被推送到坚果云之类的第三方云盘，
凭据默认不进入该路径，等于**默认不会上云**。

### 8.3 为什么不能把凭据塞进统一母包

统一母包的解析器是**严格白名单 + 全量一致性校验**，不是宽容的扩展格式：

- `src/services/unified-import.ts:722` — `formatVersion` 只接受 `1` 或 `2`，
  其它一律 `UNSUPPORTED_FORMAT`。
- `src/services/unified-import.ts:856` — ZIP 内的文件集合必须与
  `manifest.files` 的键集合**完全相等**，多一个文件即
  `INTEGRITY_MISMATCH: Manifest file set does not match ZIP`。
- `src/services/unified-import.ts:914-922` — 归档白名单只允许
  `manifest.json`、`config.yaml`、`verge.yaml`、`profiles.yaml`、
  `profiles/`、`providers/`（v2 另有 `dependencies/`）；出现任何其它文件或目录
  即 `INTEGRITY_MISMATCH: Archive contains a file outside the contract`。

后果：**一旦 ZIP 里出现 `llm/...`，旧版 Worker 和旧版 Slclash 会整包拒收**，
而不是"忽略未知部分"。也就是说，用户只要用新版导出一次带凭据的母包，
这个母包就**无法再导入任何旧客户端**。

而跨端互导（Slclash ↔ Clash Verge Rev ↔ Worker）正是统一母包格式的核心价值。
为了一个"当前并不需要备份"的数据去破坏它，明显不划算。

补充：`verifyManifestFiles` 与 `validateArchiveWhitelist` 是**导入侧**的校验；
即便只做"新版导出、新版导入"，也仍需 `formatVersion: 3` + 白名单扩展 + 导入分支，
改动面从"3 个新文件"扩大到"触碰母包契约"，与第 9 节的最小改动清单直接冲突。

### 8.4 若将来确实要备份：独立凭据包（P3，本轮不做）

正确做法是**平行于母包的第二套格式**，与订阅格式零交集：

```text
POST /api/llm/backup/export    → 下载 .msv-llm.json（不是 .zip，不与母包混淆）
POST /api/llm/backup/import    → 导入（带 dry-run 预检）
```

文件结构（自有 `bundleVersion`，与 `mihomo-unified-backup` 无任何关系）：

```jsonc
{
  "format": "msv-llm-credential-bundle",
  "bundleVersion": 1,
  "createdAt": "2026-08-27T00:00:00.000Z",
  "generator": "worker",
  "kdf": { "name": "HKDF-SHA256", "info": "msv/llm-credential/backup/v1" },
  "cipher": { "algorithm": "AES-GCM", "iv": "<base64url>" },
  "ciphertext": "<base64url>"
}
```

设计要点：

- **默认用 `INSTANCE_SECRET` 派生的独立密钥加密**（域分隔 `…/backup/v1`），
  便于"同实例恢复"，且无 CPU 成本风险。
- 若需要跨实例迁移，可另提供口令加密选项，但需注意 **Cloudflare Workers 免费计划
  的 CPU 时间预算很紧**，高迭代次数的 PBKDF2 可能超限——这一点必须在实施前实测，
  不能凭假设写进方案。
- 导入必须支持 `dry-run` 预检与冲突策略（跳过 / 覆盖 / 改名），
  因为它是"整批写入"，不像单条编辑那样可以人工逐个确认。
- 因为格式独立，母包格式、`formatVersion`、Slclash 兼容性**全部零改动**。

### 8.5 备份决策建议

**保持第 8.1 节的默认状态：不备份。** 理由：

1. 凭据只有个位数条目，且都来自平台官网，重新录入成本很低。
2. 凭据的真实风险不是"丢失"，而是"泄露"——不做备份本身就是最有效的减害。
3. 真正需要防的是"无法解密"（误换 `INSTANCE_SECRET`），而这靠备份也解决不了，
   应该靠 UI 提示（5.4）而不是靠多一份凭据副本。

因此本轮**不做任何备份相关代码**；8.4 仅作为将来需要时的既定路线留档。

---

## 9. 对现有文件的最小改动清单

| 文件 | 改动 | 规模 |
| --- | --- | --- |
| `src/services/llm-key-store.ts` | **新增**：R2 读写、ETag 并发控制、加密/解密、哈希校验、枚举、删除 | 新增 |
| `src/security/llm-crypto.ts` | **新增**：HKDF 派生、AES-GCM 加解密、base64url 编解码、常量时间比较 | 新增 |
| `src/routes/llm-api.ts` | **新增**：6 个端点的分发与请求校验 | 新增 |
| `src/types.ts` | **追加**：`LlmKeyMeta`、`LlmSecretEnvelope`、`LlmKeyListItem`、错误码联合类型 | 纯追加，不动现有声明 |
| `src/routes/api.ts` | **+6 行**：1 行 `import`，`handleApi` 顶部 4 行转发（含 2 行注释）+ 1 行空行 | 极小 |
| `src/ui/admin-html.ts` | **+tab 按钮 + tab-content 区块 + 懒加载分支 + 一组 JS 函数** | 追加式 |
| `test/llm-crypto.test.ts` | **新增** | 新增 |
| `test/llm-key-store.test.ts` | **新增** | 新增 |
| `test/llm-api.test.ts` | **新增** | 新增 |
| `test/admin-html.test.ts` | **追加断言** | 追加 |
| `test/unified-export.test.ts` | **追加 1 条守卫断言**：导出 ZIP 条目集合中不含 `llm/` 前缀路径 | 追加 |
| `docs/llm-credential-vault-plan.md` | 本文档 | 新增 |

`src/routes/api.ts` 的转发形态（示意）：

```ts
import { handleLlmApi } from "./llm-api.ts";

export async function handleApi(request, env, path) {
  const llmResponse = await handleLlmApi(request, env, path);
  if (llmResponse) return llmResponse;

  // …既有分支保持不变
}
```

**备份相关零改动**：第 8 节的默认排除不需要修改
`unified-export.ts`、`unified-import.ts`、`webdav-client.ts` 中的任何一行。

**不改动**：`src/index.ts`、`src/services/storage.ts`、`src/services/updater.ts`、
`src/services/unified-*.ts`、`src/services/instance-config.ts`、`src/routes/provider.ts`、
`src/routes/config.ts`、`src/routes/setup.ts`、`wrangler.jsonc`、`package.json`。

---

## 10. 安全分析

### 10.1 威胁模型与对策

| 威胁 | 对策 |
| --- | --- |
| R2 Bucket 被导出 / 快照泄露 | 密文 + `INSTANCE_SECRET` 派生密钥；无 `INSTANCE_SECRET` 无法解密 |
| 密文被替换或截断 | `meta.secret.sha256` 校验，不一致 fail closed |
| 非管理员访问管理 API | 继承 `/api/*` 鉴权；无会话时 401 |
| CSRF（浏览器会话被诱导发请求） | 继承 `hasValidAdminSession` 的非 GET 同源校验 |
| 明文进入 Cloudflare 访问日志 | 明文只走 POST 响应体，绝不放 URL / 查询参数 |
| 明文进入缓存或代理 | `json()` 已带 `no-store` / `no-cache` / `nosniff` |
| XSS 读取明文 | 明文仅在显式点击后进入 DOM，30 秒清空；不落 storage；沿用 `esc()` 转义 |
| 误把凭据打进日志 | 模块内不 `console.log` 任何载荷；错误只记 code |
| 误把凭据送上第三方云盘 | WebDAV 推送走母包导出（`api.ts:254`），结构上不含 `llm/` |
| 误把凭据写进母包分发给客户端 | 母包导出只读 `providers/`（`unified-export.ts:276`） |
| 凭据泄露给未授权设备 | 本轮无公开路由，凭据只存在于管理员浏览器与 R2 |

### 10.2 提交前安全检查清单（增量项）

在开发指南第 8 节清单之外，本功能追加：

- [ ] 代码与文档中不存在任何真实平台密钥、账号或生产域名。
- [ ] `llm/` 前缀数据不出现在统一导出 ZIP 中，导出/导入测试无回归。
- [ ] reveal 响应带 `no-store`，且明文不出现在任何 URL、日志、错误信息里。
- [ ] 缺少 `INSTANCE_SECRET` 时返回 `LLM_STORE_UNAVAILABLE`，且不存在明文落盘路径。
- [ ] 密文哈希不一致时返回 `LLM_KEY_CORRUPTED`，不输出任何密钥内容。
- [ ] 新 UI 脚本不含 `Authorization` / `sessionStorage` / `ADMIN_TOKEN` 字面量。

---

## 11. 测试计划

### 11.1 新增测试

**`test/llm-crypto.test.ts`**

- 派生向量固定（防止无意变更导致已存密文不可解密）。
- 加解密往返；不同 IV 产生不同密文；错误 `INSTANCE_SECRET` 解密失败。
- base64url 往返；常量时间比较正确性。

**`test/llm-key-store.test.ts`**

- 新建 → 读回元数据与密文 → 解密一致。
- 缺少 `INSTANCE_SECRET` → `LLM_STORE_UNAVAILABLE`。
- 重复 slug 新建 → `LLM_KEY_CONFLICT`。
- 并发写：模拟 ETag 不匹配 → `LLM_KEY_CONFLICT`，且旧数据未被破坏。
- 密文被篡改 → `LLM_KEY_CORRUPTED`（fail closed）。
- 元数据哈希与密文不一致 → `LLM_KEY_CORRUPTED`。
- 删除 → 列表不再出现；重复删除幂等。
- 枚举：`llm/` 前缀不会列出 `providers/` 数据，反之亦然。

**`test/llm-api.test.ts`**

- 6 个端点无鉴权 → 401。
- 非管理员 `ADMIN_TOKEN` → 401。
- 列表响应**不含** `apiKey` 字段，也不含 `ciphertext`。
- reveal 返回明文且响应头带 `no-store`。
- 字段校验：非法 slug、非 https baseUrl、超长 name、超过 100 个模型 → 400。
- 不存在的 slug → 404；错误方法 → 405。
- 跨域 `Origin` 的写请求 → 被拒（继承同源校验）。

**`test/admin-html.test.ts` 追加**

- 含 `data-tab="llm"` 与 `id="tab-llm"`。
- 不含 `Authorization` / `sessionStorage` / `ADMIN_TOKEN` / `admin_token` 字面量。
- reveal 使用 POST；复制使用 `navigator.clipboard`。

**`test/unified-export.test.ts` 追加（备份守卫）**

- 导出 ZIP 的条目集合与 `manifest.files` 中，**不含任何以 `llm/` 开头的路径**。
  这条断言在当前没有凭据数据时也成立，作用是防止将来有人无意间把凭据接进导出链路。

### 11.2 回归要求

现有 19 个测试文件应**零改动、全绿**通过。以当前基线（617 项通过 / 21 项按设计跳过）
为参照，最终数字以本轮实际结果为准。任何现有测试需要修改，都意味着隔离契约被破坏，
必须停下来重新评估设计。

---

## 12. 验收标准与回滚

### 12.1 验收命令

```powershell
Set-Location -LiteralPath 'D:\workplace\mihomo-subscription-vault'

npm run typecheck
npm run format:check
npm test
npx wrangler deploy --dry-run --outdir=.wrangler/public-dist   # 输出仍应含 env.BROWSER Browser Run
git diff --check
git status --short --branch
```

### 12.2 手工验收

1. 未登录访问 `/api/llm/keys` → 401。
2. 登录后台 → 出现"大模型密钥"tab，订阅列表布局与拖拽排序无任何变化。
3. 新建一条 DeepSeek 凭据 → 列表显示打码密钥，点"查看并复制"得到完整密钥。
4. 直接读 R2 对象 → `secret.v1.enc.json` 中无明文密钥。
5. 编辑元数据但 API Key 留空 → 原密钥仍可正常 reveal。
6. 删除 → 列表消失，R2 两个对象均被清理。
7. **备份验收**：导出统一母包并解压，确认 ZIP 内**没有** `llm/` 任何条目；
   执行一次 WebDAV 推送，确认推送内容同样不含凭据。
8. **回归**：订阅列表、历史版本、Provider 下载链接、统一母包导出/导入、WebDAV
   同步全部行为不变。

### 12.3 回滚

移除 tab 按钮/区块、还原 `src/routes/api.ts` 的 3 行转发、删除 3 个新文件即可。
R2 中的 `llm/` 数据不被任何主链路引用，**无需清理也不会产生副作用**。

---

## 13. 未来扩展点（本轮不做，仅预留）

设计上已为以下演进留好位置，届时**不需要改动现有数据模型**：

1. **自动拉取**（若将来需要客户端自动获取）：新增 `llm/{slug}/access.v1.json`
   存放读取令牌的 SHA-256，并新增公开路由 `GET/HEAD /keys/{slug}/{token}`
   （`index.ts` 加一个分支），复用现有 `provider.ts` 的 ETag / 304 / `no-store` 语义。
   公开路由一旦启用，必须补下载限流与统一 404（不区分 slug 与令牌错误，防枚举）。
2. **独立凭据备份包**：见 8.4，格式与母包完全平行，不触碰订阅格式。
3. **OAuth / 登录态型凭据**：需要 Cloudflare Cron Trigger + 刷新失败告警，
   属于独立项目，建议单独立项评估。
4. **用量与额度**：需要主动向平台发请求，属于出站网络行为，需先评估 SSRF
   （`src/security/ssrf.ts`）与平台条款。

**已排除的路线**：把凭据并入统一母包（`formatVersion: 3`）。原因是它会破坏跨端
母包兼容性，详见 8.3。

---

## 14. 风险与待确认项

| 项 | 说明 | 处理 |
| --- | --- | --- |
| 小米 tokenplan 的 `baseUrl` / 模型清单 | 设计文档不预设具体值，由使用者录入 | 实施后由使用者自行填写 |
| HKDF 在目标运行时的可用性 | 若不可用走 5.1 的回退派生 | 实施时用测试固化实际向量 |
| `INSTANCE_SECRET` 更换导致凭据不可解密 | 与实例配置行为一致 | UI 与文档明示，不做额外保护 |
| `hint.last4` 明文存储 | 信息量极小的取舍 | 已写入 7.4 与安全清单 |
| 凭据不做备份 | 丢失需重新录入 | 已确认为可接受（8.5） |
| 实施顺序 | 存储与加密 → API → UI → 测试 → 文档 | 每步跑全量回归 |

---

## 附：版本变更

- **v7（2026-09-11）** 性能轮。服务端消除 R2 N+1 与串行读（history 约 6–8 倍、订阅列表
  约 1.7 倍、密钥列表约 3 倍、reveal 少一次读）；移除 GET 上的 prune 写入。前端改为
  刷新即渲染骨架、认证后并行预取全部 tab、增删改本地同帧生效。新增 7A 性能约定与
  并发度/读次数守卫测试。
- **v6（2026-09-11）** 查看弹窗标题栏加入凭据名称（主标题 + `API Key` 小标签两级结构），
  行内按钮改回「查看/复制」以匹配其真实能力（查看 + 弹窗内复制）。
- **v5（2026-09-11）** 查看弹窗改为最小形态：只显示明文密钥 + 「复制」「关闭」两个按钮，
  打开即全文（去掉「显示 / 隐藏」与 30 秒自动隐藏），新增 `.modal-sm` 紧凑尺寸。
- **v4（2026-09-11）** 补齐移动端：新增 7.6 项目级移动端约束；修复密钥列表在窄屏
  无法横向滚动（缺 `overflow-x` 与按钮 `white-space: nowrap`）。实现真正的「查看」：
  按钮改名「查看」，新增查看弹窗（默认打码、显示/隐藏、复制、剪贴板被拒时展开明文、
  30 秒自动隐藏）。新增 `.secret-value` 强制长密钥换行。
- **v3（2026-09-11）** 按实际使用反馈精简：UI 表单只保留 名称 / Slug / API Key，
  `provider` / `baseUrl` 改为可选（留空存 `""`，数据模型保留字段不迁移）；
  添加表单改为 tab 内联、样式对齐「添加订阅」，列表在上、表单在下；
  「大模型密钥」tab 提到第二位；新增一条最小请求体测试与 tab 顺序断言。
  部署后 `INSTANCE_SECRET` 已配置，生产端到端往返验证通过。
- **v2（2026-08-27）** 新增第 8 节"备份策略"；第 7.1 节新增布局决策对比；
  测试计划新增母包守卫断言；扩展点中明确排除"并入母包"路线。
- **v1（2026-08-27）** 初稿。

最后更新：2026-08-27

