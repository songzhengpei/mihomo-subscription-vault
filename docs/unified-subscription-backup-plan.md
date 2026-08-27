# 统一订阅与备份体系实施计划

> 本文档定义了 Mihomo Subscription Vault、Slclash、Clash Verge Rev 三端统一订阅与备份体系的完整规划。只提交规划文档，不修改功能代码。

---

## 终极目标

```text
机场一次性地址
    ↓ 只进入 Worker 一次
Cloudflare Worker（不可变版本存储 + 固定订阅地址）
    ↓
Worker 固定订阅地址（Provider URL / 完整配置 URL）
    ↓
统一母包 ZIP（v1 格式）
    ↕
Slclash 备份导入 / 导出
    ↓
Clash Verge Rev 直接导入
```

最终需要实现：

1. Worker 保存机场原始内容和不可变历史版本，提供固定订阅地址。
2. 同一份完整 Mihomo 配置同时生成：完整配置固定 URL、Provider 固定 URL。
3. Worker 导出的 ZIP 是"统一母包"，不只是 R2 数据备份。
4. Slclash 默认导入和导出该统一母包。
5. Slclash 导出的母包可以重新导入 Worker，并形成新的可回滚版本。
6. 新版本 Slclash 必须兼容导入旧版本 Slclash 备份，并自动转换成新格式。
7. 同一个统一母包 ZIP 可以直接导入 Clash Verge Rev。
8. 不要求 Clash Verge Rev 导出的备份能反向导入 Worker。
9. OpenClash 暂不参与母包兼容，只继续使用 Worker 固定 URL。
10. 母包里的所有长期订阅来源必须指向 Worker 固定地址，不得保存为已经失效的机场一次性地址。

---

## 一、当前状态审计

### 1.1 Worker（mihomo-subscription-vault）

**R2 数据结构：**

```text
providers/
└── {slug}/
    ├── latest.json                    # 指向当前版本（CAS 保护）
    ├── versions/
    │   ├── {versionId}.yaml           # 不可变 Provider YAML
    │   └── {versionId}.json           # 版本元数据（ProviderMeta）
    └── staging/
        ├── {requestId}.json           # 抓取状态记录
        └── {requestId}.raw            # 原始订阅快照
```

**当前 ZIP 导出结构（`/api/export`）：**

```text
mihomo-subscription-vault-backup-{timestamp}.zip
├── manifest.json                      # { format, formatVersion, files, airports, ... }
├── providers/{slug}/latest.json
└── providers/{slug}/versions/{versionId}.yaml + .json
```

**已有能力：**
- Provider YAML 不可变版本存储 + CAS 并发保护
- 流式抓取上游（分块读取，超限中断）
- 原始快照 staging 暂存
- SHA-256 去重
- 一键回滚（含完整性验证）
- 管理页面（浅色模式）
- Provider 固定 URL 下载（`/provider/:slug/:token`）
- HEAD 优化、304 Not Modified
- 安全头、CORS 控制

**缺失能力：**
- 不存储完整 Mihomo 配置（config.yaml、proxy-groups、rules）
- 不存储机场完整配置（profile.yaml）
- 不存储手搓主配置
- 当前导出只是 R2 数据备份，不是可用的 Mihomo 配置
- 无法生成完整配置固定 URL
- 无法导入 Slclash 母包
- 无法生成 Clash Verge Rev 兼容的备份

### 1.2 Slclash（Android Mihomo 客户端）

**备份格式：** ZIP 打包整个 app 数据目录，通过 WebDAV 同步。

**ZIP 内容：**

```text
backup.zip
├── database.sqlite                    # Drift SQLite 数据库（schema v4）
├── config.yaml                        # Mihomo 内核配置
├── shared.json                        # 共享状态
├── shared_preferences.json            # Flutter SharedPreferences
├── profiles/
│   └── {id}.yaml                      # 各 Profile 的 Mihomo YAML 配置
├── profiles/providers/{profileId}/{type}/{urlMd5}  # Provider 缓存
└── scripts/
    └── {id}.js                        # 用户脚本
```

**Profile 模型：**

```dart
Profile({
  int id,                    // Snowflake ID
  String label,              // 显示名称
  String url,                // 订阅 URL（空 = 本地文件）
  bool autoUpdate,
  Duration autoUpdateDuration,
  SubscriptionInfo? subscriptionInfo,
  Map<String, String> selectedMap,       // 组 -> 选中代理
  OverwriteType overwriteType,
  int? scriptId,
  int? order,
})
```

**导入机制：**
- 从 WebDAV 下载 backup.zip 到 `restore/` 目录
- 数据库支持 `restore()`（全量覆盖）和 `restoreProfilesOnly()`（仅 profiles）
- `RestoreStrategy.compatible` 合并策略

**已有能力：**
- Profile 管理（URL 订阅 + 本地文件）
- 自动更新订阅
- WebDAV 跨设备同步
- 数据库 restore / merge 策略

**缺失能力：**
- 不支持导出统一母包格式
- 不支持导入统一母包格式
- 旧备份格式与新格式不兼容
- 订阅 URL 可能是机场一次性地址，未指向 Worker

### 1.3 Clash Verge Rev（桌面 Mihomo 客户端）

**备份格式：** ZIP，`CompressionMethod::Stored`（无压缩）。

**ZIP 结构：**

```text
{OS}-backup-{timestamp}.zip
├── profiles/
│   ├── R{uid}.yaml                    # 远程订阅
│   ├── L{uid}.yaml                    # 本地文件
│   ├── m{uid}.yaml                    # 合并配置
│   ├── s{uid}.js                      # 脚本
│   ├── r{uid}.yaml                    # 规则覆盖
│   ├── p{uid}.yaml                    # 代理覆盖
│   └── g{uid}.yaml                    # 组覆盖
├── config.yaml                        # Mihomo 内核配置
├── verge.yaml                         # 应用设置（WebDAV 凭证已剥离）
├── profiles.yaml                      # Profile 索引（含当前选中）
└── dns_config.yaml                    # DNS 配置（可选）
```

**Profile 索引（profiles.yaml）：**

```yaml
current: "R12345678"
items:
  - uid: "R12345678"
    type: "remote"
    name: "My Subscription"
    file: "R12345678.yaml"
    url: "https://..."
    selected:
      - name: "Proxy Group"
        now: "Node Name"
    extra:
      upload: 0
      download: 0
      total: 1073741824
      expire: 1700000000
    option:
      update_interval: 86400
```

**导入机制：**
- 直接将 ZIP 内容解压到 `{app_home}/`（全量覆盖）
- 恢复后重新注入 WebDAV 凭证
- 重新加载所有配置到内存

**已有能力：**
- 完整的 Profile 系统（7 种类型）
- 备份导出/导入
- WebDAV 同步
- Profile 选择状态保存

**缺失能力：**
- 不支持导入非标准格式的 ZIP
- 导入是全量覆盖，无 merge 能力

---

## 二、差距分析

| 能力 | Worker 当前 | Slclash 当前 | Clash Verge 当前 | 需要 |
|------|------------|-------------|-----------------|------|
| 完整 Mihomo 配置存储 | ❌ 只存 Provider YAML | ✅ config.yaml | ✅ config.yaml | Worker 需要 |
| 机场完整配置存储 | ❌ | ✅ profiles/{id}.yaml | ✅ profiles/R*.yaml | Worker 需要 |
| 手搓主配置存储 | ❌ | ❌ | ✅ config.yaml | Worker 需要 |
| Profile 索引 | ❌ | ✅ SQLite | ✅ profiles.yaml | Worker 需要 |
| 固定订阅 URL | ✅ Provider URL | ❌ 可能是一次性 URL | ❌ 可能是一次性 URL | Slclash 需要改 |
| 统一母包导出 | ❌ 当前是 R2 备份 | ❌ 当前是 app 数据 | ✅ 但格式不兼容 | 三方都需要 |
| 统一母包导入 | ❌ | ❌ | ❌（只接受自己的格式） | 三方都需要 |
| 不可变版本 | ✅ | ❌ | ❌ | Worker 已有 |
| 回滚 | ✅ | ❌ | ❌ | Worker 已有 |
| 旧格式兼容 | N/A | ✅ 旧备份可导入 | N/A | Slclash 需要 |

### 核心差距

1. **Worker 缺少完整配置能力**：只存储 Provider YAML，不存储机场完整配置（profile.yaml）、手搓主配置（config.yaml）、proxy-groups、rules 等。
2. **三方格式不统一**：Worker 导出的是 R2 数据备份，Slclash 导出的是 app 数据 ZIP，Clash Verge 导出的是 profiles ZIP。三者互不兼容。
3. **Slclash 订阅 URL 问题**：当前订阅 URL 可能是机场一次性地址，需要替换为 Worker 固定地址。
4. **无双向同步**：Slclash 无法将配置导出为 Worker 可导入的格式，Worker 也无法导入 Slclash 的配置。

---

## 三、统一逻辑数据模型（权威数据源）

统一母包的核心设计原则：**逻辑数据模型是唯一的跨平台权威数据源**。Clash Verge Rev 的 `config.yaml`、`profiles.yaml` 和 `profiles/*` 只是从逻辑模型生成的兼容视图，不作为跨平台权威模型。

### 3.1 逻辑模型定义

**唯一事实源规则：**

```text
统一逻辑数据模型（唯一事实源）
    ├── 生成 → provider.yaml
    ├── 生成 → profile.yaml
    └── 生成 → Clash Verge Rev 兼容视图（config.yaml、profiles.yaml、profiles/*）
```

**不可变契约：**

1. `provider.yaml`、`profile.yaml` 和 Clash Verge 兼容文件**不能互相成为事实源**。它们都必须从逻辑模型生成。
2. 两个制品（`provider.yaml` + `profile.yaml`）必须来自**同一次原始订阅抓取结果**。
3. 任何一个制品生成或校验失败，都不能更新 `latest.json`。
4. `meta.json` 必须记录两个制品的哈希、大小和生成器版本。

```typescript
// 统一母包的逻辑数据模型
interface UnifiedBackup {
  format: "mihomo-unified-backup";
  version: 1;
  exportedAt: string;
  exportedBy: "worker" | "slclash";

  // 权威数据源
  mainConfig: MainConfig;            // 手搓主配置
  airportProfiles: AirportProfile[];  // 各机场的完整配置
  providers: ProviderData[];          // Provider 数据（含版本历史）
  metadata: BackupMetadata;           // 元数据
}

// 手搓主配置：用户引用多个 Provider 的主配置
// 这不是 Clash Verge 的 config.yaml，而是独立的逻辑模型
interface MainConfig {
  name: string;                       // 配置名称
  clashConfig: Record<string, unknown>; // 完整 Clash/Mihomo 内核配置
  // clashConfig 中的 proxy-providers URL 必须指向 Worker 固定地址
}

// 每个机场的完整配置
interface AirportProfile {
  subscriptionId: string;             // 永久不变的内部标识（首次创建后固定）
  slug: string;                       // 机场标识（可重命名）
  name: string;                       // 显示名称
  providerUrl: string;                // Worker 固定 Provider URL
  configUrl: string;                  // Worker 固定完整配置 URL
  proxyCount: number;                 // 节点数量
  sha256: string;                     // 内容哈希
  subscriptionInfo?: {                // 流量信息
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
}

// Provider 数据
interface ProviderData {
  slug: string;
  latestVersionId: string;
  versions: ProviderVersion[];
}

interface ProviderVersion {
  versionId: string;
  providerYaml: string;               // Provider YAML 内容
  profileYaml: string;                // 该机场的完整配置 YAML
  meta: VersionMeta;                  // 必须记录两个制品的哈希和大小
}

// 版本元数据：记录双制品的完整信息
interface VersionMeta {
  versionId: string;
  providerSlug: string;
  providerName: string;
  createdAt: string;
  // provider.yaml 信息
  providerSha256: string;
  providerContentLength: number;
  // profile.yaml 信息
  profileSha256: string;
  profileContentLength: number;
  // 生成器信息
  generatorVersion: string;           // 生成该版本的 Worker 版本
  // 其他元数据
  nodeCount: number;
  sourceHost: string;
  sha256: string;                     // provider.yaml 的 SHA-256（兼容旧版）
  subscriptionUserinfo?: string;
  profileUpdateInterval?: string;
  profileWebPageUrl?: string;
}
```

### 3.2 逻辑模型与兼容视图的关系

```text
逻辑数据模型（权威）
    │
    ├── 导出为 → Clash Verge Rev 兼容视图
    │   ├── config.yaml        ← 从 MainConfig.clashConfig 生成
    │   ├── profiles.yaml      ← 从 AirportProfile[] 生成
    │   ├── verge.yaml         ← 最小化应用设置
    │   └── profiles/
    │       └── R{uid}.yaml    ← 从 AirportProfile 生成（指向 Worker 固定 URL）
    │
    ├── 导出为 → Slclash 兼容视图
    │   ├── database.sqlite    ← 从逻辑模型填充
    │   ├── config.yaml        ← 从 MainConfig.clashConfig 生成
    │   └── profiles/
    │       └── {id}.yaml      ← 各机场完整配置
    │
    └── 导入自 ← Slclash 母包
        └── 解析 profiles/ + config.yaml → 填充逻辑模型
```

### 3.3 机场完整配置 vs 手搓主配置

系统中有两种不同层级的配置，必须明确区分：

**机场完整配置（AirportProfile.profile.yaml）：**
- 来源：机场一次性地址抓取后标准化
- 内容：该机场的所有节点 + 基础 proxy-groups + 基础 rules
- 粒度：每个机场一份
- 存储位置：R2 不可变版本目录中
- 更新频率：跟随机场订阅更新
- 示例：机场 A 的完整配置包含 HK-01、US-01、JP-01 等所有节点

**手搓主配置（MainConfig）：**
- 来源：用户手动编写或从已有配置导入
- 内容：引用多个 Provider 的完整 Mihomo 配置
- 粒度：整个订阅体系一份
- 存储位置：R2 不可变版本目录中
- 更新频率：用户手动更新
- 示例：引用机场 A 的 Provider + 机场 B 的 Provider，配置分流规则、DNS、特殊代理组

```yaml
# 手搓主配置示例（逻辑模型，不是直接给 Clash Verge 的）
proxy-providers:
  airport-a:
    type: http
    url: "https://worker.example.com/provider/airport-a/{token}"
    path: ./proxy_providers/airport-a.yaml
  airport-b:
    type: http
    url: "https://worker.example.com/provider/airport-b/{token}"
    path: ./proxy_providers/airport-b.yaml
proxy-groups:
  - name: "自动选择"
    type: url-test
    use: [airport-a, airport-b]
rules:
  - DOMAIN-SUFFIX,google.com,Proxy
  - MATCH,DIRECT
```

### 3.4 Profile UID 生成策略

Profile UID 用于 Clash Verge Rev 兼容视图中的文件命名（`R{uid}.yaml`）。

**不可变契约：**

> UID 基于不可变 `subscriptionId` 生成并持久化，不包含 `versionId`，重命名和版本更新均不改变 UID。

**策略：** 使用 `sha256(subscriptionId).slice(0, 8)` 作为 UID。

```typescript
function generateProfileUid(subscriptionId: string): string {
  // subscriptionId 是首次创建后永久固定的内部 ID
  // slug 可能因重命名而变化，subscriptionId 永远不变
  const hash = sha256(subscriptionId);
  return `R${hash.slice(0, 8)}`;
}
```

**要求：**

1. `subscriptionId` 是首次创建订阅时生成的 UUID，一旦创建就永久固定。
2. UID 生成后持久化到 `AirportProfile.subscriptionId`，不每次临时重新计算。
3. 创建订阅时进行 UID 冲突检查。
4. 冲突时使用确定性的扩展机制（例如追加递增后缀重新哈希）。

**理由：**
- `subscriptionId` 是内部标识，不会因重命名、版本更新或迁移而变化
- slug 可能因用户编辑而变化，不适合作为 UID 基础
- 8 位十六进制哈希（32 位空间）对普通用户规模足够，但仍需冲突检查

---

## 四、统一母包 v1 格式

### 4.1 格式标识

```json
{
  "format": "mihomo-unified-backup",
  "version": 1
}
```

ZIP 文件命名：`mihomo-unified-backup-v1-{timestamp}.zip`

### 4.2 ZIP 目录结构

**ZIP 根目录不得包含包裹目录。** `config.yaml`、`verge.yaml`、`profiles.yaml` 和 `profiles/` 必须位于 ZIP 根目录，以便 Clash Verge Rev 直接恢复。

```text
mihomo-unified-backup-v1-{timestamp}.zip（根目录，无包裹层）
├── manifest.json                        # 统一清单（逻辑模型的序列化）
├── config.yaml                          # Mihomo 内核配置（从逻辑模型生成的兼容视图）
├── profiles.yaml                        # Profile 索引（从逻辑模型生成的兼容视图）
├── verge.yaml                           # 应用设置（必需，最小化）
├── profiles/                            # Profile 文件目录
│   └── R{uid}.yaml                      # 各机场完整配置（指向 Worker 固定 URL）
├── providers/                           # Provider 数据（逻辑模型的一部分）
│   └── {slug}/
│       ├── provider.yaml                # 当前版本 Provider YAML
│       ├── profile.yaml                 # 当前版本机场完整配置
│       └── meta.json                    # 版本元数据
├── slclash/                             # Slclash 扩展（可选）
│   ├── database.sqlite                  # 数据库快照
│   ├── shared.json                      # 共享状态
│   └── scripts/
│       └── {id}.js                      # 用户脚本
└── vault/                               # Worker 版本管理元数据（可选）
    ├── versionHistory.json              # 版本历史
    └── importLog.json                   # 导入/导出审计日志
```

### 4.3 文件角色定义

| 文件 | 角色 | 数据源 | Clash Verge 兼容 | 可缺失 |
|------|------|--------|-----------------|--------|
| `manifest.json` | 格式标识 + 完整性 | 逻辑模型 | ❌ | ❌ |
| `config.yaml` | Mihomo 内核配置 | 逻辑模型生成 | ✅ | ❌ |
| `profiles.yaml` | Profile 索引 | 逻辑模型生成 | ✅ | ❌ |
| `verge.yaml` | 应用设置 | 最小化生成 | ✅ | ❌ |
| `profiles/R{uid}.yaml` | 机场完整配置 | 逻辑模型 | ✅ | ❌ |
| `providers/{slug}/provider.yaml` | Provider YAML | 逻辑模型 | ❌ | ✅ |
| `providers/{slug}/profile.yaml` | 机场完整配置 | 逻辑模型 | ❌ | ✅ |
| `providers/{slug}/meta.json` | 版本元数据 | 逻辑模型 | ❌ | ✅ |
| `slclash/*` | Slclash 专有数据 | Slclash | ❌ | ✅ |
| `vault/*` | Worker 版本管理 | Worker | ❌ | ✅ |

### 4.4 manifest.json 结构

**三个版本概念必须区分：**

| 概念 | 字段 | 含义 |
|------|------|------|
| 母包结构版本 | `formatVersion` | 母包目录结构的版本，用于格式升级兼容 |
| 订阅内容版本 | `versionId` | 某次订阅抓取的内容版本 |
| 生成器版本 | `generatorVersion` | 生成母包的 Worker 或 Slclash 版本 |

```jsonc
{
  "format": "mihomo-unified-backup",
  "formatVersion": 1,
  "archiveType": "unified-subscription-archive",
  "createdAt": "2026-07-14T12:00:00.000Z",
  "generator": "worker",
  "generatorVersion": "1.0.0",
  "workerUrl": "https://your-worker.workers.dev",
  "mainConfig": {
    "name": "我的订阅",
    "sha256": "sha256:abc123..."
  },
  "airports": [
    {
      "slug": "airport-a",
      "subscriptionId": "uuid-...",
      "name": "机场 A",
      "profileUid": "R1a2b3c4d",
      "versionId": "20260714T083000Z-a12bc34d",
      "providerUrl": "https://worker.example.com/provider/airport-a/{token}",
      "configUrl": "https://worker.example.com/config/airport-a/{token}",
      "sha256": "sha256:def456..."
    }
  ],
  "files": {
    "config.yaml": { "sha256": "sha256:...", "required": true },
    "profiles.yaml": { "sha256": "sha256:...", "required": true },
    "verge.yaml": { "sha256": "sha256:...", "required": true },
    "profiles/R1a2b3c4d.yaml": { "sha256": "sha256:...", "required": true }
  },
}
```

### 4.5 安全机制

- **路径穿越防护**：导入时验证所有 ZIP 条目的路径不包含 `..` 或绝对路径。
- **文件覆盖防护**：manifest 中声明的文件列表是白名单，不在列表中的文件不导入。
- **完整性验证**：导入前验证 `files` 中每个文件的 SHA-256。
- **格式版本检查**：`format` 必须为 `mihomo-unified-backup`，`version` 必须为 `1`。
- **URL 安全**：所有订阅 URL 必须以 `http://` 或 `https://` 开头，禁止 `file://`、`ftp://` 等。

### 4.6 与现有 `/api/export` 的关系

当前 `/api/export` 导出的是 R2 数据备份（providers 目录的原始数据）。统一母包是完全不同层级的东西：

| 维度 | `/api/export`（保留） | 统一母包（新增） |
|------|---------------------|----------------|
| 用途 | R2 数据灾备 | 配置同步 + 客户端导入 |
| 格式 | R2 原始结构 | Clash Verge Rev 兼容格式 |
| 消费者 | Worker 管理员 | Slclash、Clash Verge Rev |
| 内容 | Provider 版本文件 | 完整配置 + Profiles + Providers |
| API | `GET /api/export` | `GET /api/unified-export` |

两者共存，互不影响。

---

## 五、Worker R2 数据结构（目标状态）

### 5.1 不可变版本目录（每个机场）

```text
providers/{slug}/
├── latest.json                            # 指向当前版本（CAS 保护）
├── versions/
│   └── {versionId}/                       # 不可变版本目录（原子写入）
│       ├── provider.yaml                  # Provider YAML（给 Mihomo proxy-providers）
│       ├── profile.yaml                   # 该机场的完整配置（给 Slclash / Clash Verge）
│       └── meta.json                      # 版本元数据
└── staging/
    ├── {requestId}.json                   # 抓取状态记录
    └── {requestId}.raw                    # 原始订阅快照
```

**关键约束：**
- `provider.yaml` 和 `profile.yaml` 必须在同一个版本目录中，由同一个 `latest.json` 指针控制。
- 禁止在 Provider 根目录单独保存可变的 `config.yaml`。
- 版本目录是不可变的：写入后不修改，只通过 `latest.json` CAS 更新指针。

### 5.2 手搓主配置（全局）—— 阶段 3 已实现

```text
vault/main-config/
├── identity.json                       # 身份对象（configId 创建后不可变）
├── latest.json                         # 发布指针（CAS 保护）
└── versions/
    └── {versionId}/
        ├── main-config.yaml            # 不可变 YAML 内容
        └── meta.json                   # 不可变版本元数据
```

**说明：**
- 手搓主配置是全局的，不属于任何单个机场。
- 存储在 `vault/main-config/` 目录下，使用不可变版本目录管理。
- `configId` 首次创建后永久稳定。
- `latest.json` 是唯一正式发布指针，通过 CAS 保护并发安全。
- 禁用只修改指针的 `status` 字段，不删除任何历史内容。
- `main-config.yaml` 原样返回，不动态重写 `proxy-providers` URL（阶段 5 母包生成时再处理）。

### 5.3 latest.json 结构

```jsonc
{
  "versionId": "20260714T083000Z-a12bc34d",
  "sha256": "abc123...",
  "updatedAt": "2026-07-14T08:30:00.000Z"
}
```

### 5.4 版本元数据（meta.json）结构

```jsonc
{
  "versionId": "20260714T083000Z-a12bc34d",
  "providerSlug": "airport-a",
  "providerName": "机场 A",
  "createdAt": "2026-07-14T08:30:00.000Z",
  "sha256": "abc123...",
  "nodeCount": 15,
  "sourceHost": "airport-a.example.com",
  "contentLength": 12345,
  "providerSha256": "sha256 of provider.yaml",
  "profileSha256": "sha256 of profile.yaml",
  "subscriptionUserinfo": "upload=0;download=123;total=456;expire=789",
  "profileUpdateInterval": "24",
  "profileWebPageUrl": "https://..."
}
```

---

## 六、Worker 更新流程（不可变版本写入 + latest 指针原子发布）

**术语定义：** 本流程称为"不可变版本写入 + latest 指针原子发布"，不是真正的跨对象事务。对象存储无法对多个文件进行跨对象事务。

**发布语义：**

1. 客户端只能通过 `latest.json` 发现正式版本。
2. 未被 `latest.json` 引用的版本视为未发布版本。
3. CAS 冲突时重新读取最新指针并决定重试或放弃。
4. 写入中断产生的孤立目录由定期清理机制删除。
5. 读取到版本后应根据 `meta.json` 校验完整性。

**更新流程：**

```text
用户粘贴一次性地址
    ↓
Worker 验证 URL
    ↓
流式抓取上游（分块读取，超限中断）
    ↓
立即保存原始快照到 staging/{requestId}.raw
    ↓
检测格式（Provider YAML / Clash 配置）
    ↓
从同一次抓取结果生成两个制品：
  1. provider.yaml（Provider YAML，只有 proxies 列表）
  2. profile.yaml（机场完整配置，含 proxy-groups + rules）
    ↓
校验两个制品：任何一个生成或校验失败 → 中止，不更新 latest.json
    ↓
计算 SHA-256 → 与当前版本对比（相同则跳过）
    ↓
写入不可变版本目录（顺序写入，非事务）：
  1. put provider.yaml  (onlyIf: etagDoesNotMatch: "*")
  2. put profile.yaml   (onlyIf: etagDoesNotMatch: "*")
  3. put meta.json      (onlyIf: etagDoesNotMatch: "*")
  ↓
校验：确认三个文件全部写入成功
  任何一个失败 → 中止，不更新 latest.json（孤立目录由清理机制删除）
    ↓
CAS 发布 latest.json（etagMatches: oldLatest.etag）
  失败 → 重读 latest.json，决定重试或放弃
    ↓
标记 staging 完成
    ↓
返回结果
```

### 6.1 provider.yaml vs profile.yaml

**provider.yaml**（Provider YAML）：
- 格式：标准 Mihomo `proxy-providers` 格式
- 内容：只有 `proxies` 列表
- 用途：给 Mihomo 内核的 `proxy-providers` 使用
- 示例：
  ```yaml
  proxies:
    - name: HK-01
      type: ss
      server: hk.example.com
      port: 443
  ```

**profile.yaml**（机场完整配置）：
- 格式：完整的 Mihomo 配置文件
- 内容：`proxies` + `proxy-groups` + `rules` + 其他配置
- 用途：给 Slclash / Clash Verge Rev 作为完整的 Profile 文件
- 示例：
  ```yaml
  mixed-port: 7890
  proxies:
    - name: HK-01
      type: ss
      server: hk.example.com
      port: 443
  proxy-groups:
    - name: auto
      type: url-test
      proxies: [HK-01]
  rules:
    - MATCH,DIRECT
  ```

---

## 七、Worker 完整配置固定 URL

Worker 提供两种固定 URL：

### 7.1 Provider URL（已有）

```text
GET /provider/{slug}/{downloadToken}
HEAD /provider/{slug}/{downloadToken}
```

返回 `provider.yaml`（Provider YAML），给 Mihomo `proxy-providers` 使用。

### 7.2 完整配置 URL（新增）

```text
GET /config/{slug}/{downloadToken}
HEAD /config/{slug}/{downloadToken}
```

返回 `profile.yaml`（该机场的完整配置），给 Slclash / Clash Verge Rev 使用。

### 7.3 手搓主配置 URL（新增）

```text
GET /main-config/{downloadToken}
HEAD /main-config/{downloadToken}
```

返回 `main-config.yaml`（手搓主配置），给需要完整配置的客户端使用。

### 7.4 固定 URL 安全和缓存语义

机场订阅属于敏感数据（尤其是阅后即焚订阅），固定 URL 必须满足以下安全要求：

**访问控制：**
- 固定 URL 使用不可预测的访问令牌（现有 `downloadToken` 机制）。
- Worker 不向客户端暴露原始机场订阅 URL。
- 支持令牌轮换和撤销（通过 `wrangler secret put` 重新设置）。
- 日志不得记录完整访问令牌或原始订阅地址。

**缓存策略：**
- 返回正确的 `ETag` 响应头。
- 更新后不能长期命中旧缓存：`latest.json` 更新后，新的 `ETag` 必须立即生效。
- `latest.json` 和配置内容采用不同缓存策略：
  - `latest.json`：`Cache-Control: no-store`（每次请求都检查最新版本）
  - `provider.yaml` / `profile.yaml`：`Cache-Control: no-store` + `ETag`（支持 304 缓存）
- 导出母包时不得意外把后台管理凭据（`ADMIN_TOKEN`）写入 ZIP。

**泄露恢复：**
- 如果固定 URL 泄露，应当能够只更换访问令牌，而不必重新添加订阅。

---

## 八、导入冲突策略

阶段 7（Slclash 导入）、8（旧版兼容）、9（Worker 反向导入）都会遇到同一个问题：导入的订阅和本地订阅重复时怎么办。

### 8.1 三种冲突模式

```text
replace  — 以 subscriptionId 为准替换已有订阅
merge    — 保留已有订阅，补充不存在的订阅
duplicate — 作为新订阅导入并重新分配 UID
```

### 8.2 默认行为规则

| 条件 | 默认行为 |
|------|---------|
| `subscriptionId` 相同 | 更新订阅内容，不重复创建 |
| `subscriptionId` 不同但源 URL 相同 | 按 `merge` 模式合并 |
| `subscriptionId` 和源 URL 都不同 | 新增订阅 |
| 导入 Clash Verge 兼容母包 | 只恢复订阅相关内容，不覆盖客户端的其他设置 |

### 8.3 重要约束

> **"导入 Clash Verge 兼容母包"不等于"恢复 Clash Verge 的全部应用配置"。**

统一母包只包含订阅和配置数据，不包含客户端的 UI 设置、窗口状态、代理选择状态等。这些是客户端本地状态，不应被母包覆盖。

---

## 九、两个仓库的改动范围

### 9.1 Worker 仓库改动

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/types.ts` | 修改 | 新增 UnifiedBackup、MainConfig、AirportProfile 等类型 |
| `src/services/storage.ts` | 修改 | 版本目录重构（provider.yaml + profile.yaml + meta.json 原子写入） |
| `src/services/unified-export.ts` | 新增 | 统一母包导出（逻辑模型 → 兼容视图） |
| `src/services/unified-import.ts` | 新增 | 统一母包导入（兼容视图 → 逻辑模型） |
| `src/routes/api.ts` | 修改 | 新增 `/api/unified-export`、`/api/unified-import` |
| `src/routes/config.ts` | 新增 | `GET /config/:slug/:token`、`GET /main-config/:token` |
| `src/index.ts` | 修改 | 注册新路由 |
| `test/unified-export.test.ts` | 新增 | 统一母包导出测试 |
| `test/unified-import.test.ts` | 新增 | 统一母包导入测试 |

### 9.2 Slclash 仓库改动

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `lib/common/dav_client.dart` | 修改 | 新增统一母包导出/导入方法 |
| `lib/models/unified_backup.dart` | 新增 | 统一母包数据模型 |
| `lib/services/backup_service.dart` | 修改 | 集成统一母包导出/导入 |
| `lib/services/config_service.dart` | 修改 | 将订阅 URL 替换为 Worker 固定地址 |
| `lib/database/database.dart` | 修改 | 新增 `restoreFromUnified()` 方法 |
| `lib/pages/backup_page.dart` | 修改 | UI 支持选择导出格式 |

### 9.3 不改动 Clash Verge Rev

统一母包必须以 Clash Verge Rev 能直接导入的格式生成。Clash Verge Rev 不需要任何修改。

---

## 十、分阶段实施计划

### 阶段 1：数据模型和母包格式定稿

**目标：** 定义统一逻辑数据模型和母包 v1 格式的完整结构。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/types.ts` | 新增 UnifiedBackup、MainConfig、AirportProfile 等类型 |
| Worker | `docs/unified-backup-spec.md` | 格式规范文档 |

**新增接口：** 无（纯类型定义）

**数据迁移：** 无

**测试要求：**
- 类型定义编译通过
- manifest.json Schema 验证测试

**验收门（必须全部通过）：**
- JSON Schema 冻结
- ZIP 文件表和字段映射表完成
- 黄金样例（golden sample）冻结
- `subscriptionId`、slug 和 UID 的关系明确
- `versionId` 的生成及幂等规则明确
- `latest.json` 的 CAS 并发和失败处理明确
- 母包的 `formatVersion`、完整性清单和导入冲突策略明确

**潜在风险：**
- 格式设计可能在后续阶段发现不满足需求，需要迭代

---

### 阶段 2：Worker 版本目录重构（双制品原子写入）

**目标：** 将版本目录从单文件改为目录结构，原子写入 provider.yaml + profile.yaml + meta.json。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/services/storage.ts` | 重构 `writeVersion()`，原子写入版本目录 |
| Worker | `src/services/updater.ts` | 生成 provider.yaml 和 profile.yaml |
| Worker | `src/types.ts` | 新增 VersionMeta 类型（替代 ProviderMeta） |

**R2 数据结构变更：**

```text
# 旧结构
versions/{versionId}.yaml     # 单文件
versions/{versionId}.json     # 单文件

# 新结构
versions/{versionId}/         # 目录
├── provider.yaml             # Provider YAML
├── profile.yaml              # 机场完整配置
└── meta.json                 # 版本元数据
```

**数据迁移：**
- 新版本使用新结构
- 旧版本数据保持不变，读取时兼容两种结构
- 不需要一次性迁移所有数据

**测试要求：**
- 原子写入测试（三个文件全部成功或全部失败）
- 旧版本数据兼容读取测试
- CAS 更新 latest.json 测试
- 并发写入测试

**验收门（必须全部通过）：**
- 并发更新测试通过（两个请求同时更新同一 slug）
- 生成失败测试通过（profile.yaml 生成失败时不更新 latest.json）
- CAS 冲突测试通过（后到者正确重试或放弃）
- 中途断写测试通过（写入中断后不产生脏数据，latest.json 不被污染）
- 旧版本兼容读取测试通过
- 所有现有测试继续通过

**潜在风险：**
- R2 存储量增加（每个版本多存 profile.yaml）
- 需要设计 profile.yaml 的生成逻辑

---

### 阶段 3：Worker 手搓主配置存储 ✅ 已完成

**目标：** Worker 能够存储和管理手搓主配置的不可变版本。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/services/main-config-storage.ts` | 新增：独立的主配置存储服务 |
| Worker | `src/routes/api.ts` | 新增主配置管理 API（7 个端点） |
| Worker | `src/types.ts` | 新增 MainConfigIdentity、MainConfigVersionMeta、MainConfigLatestPointer 等类型 |
| Worker | `test/main-config-storage.test.ts` | 新增：71 个存储层测试 |
| Worker | `test/main-config-api.test.ts` | 新增：42 个 API 测试 |

**新增接口：**

```text
GET   /api/main-config                  # 获取当前主配置及 YAML
PUT   /api/main-config                  # 创建或更新主配置（CAS 保护）
GET   /api/main-config/history          # 版本历史列表
GET   /api/main-config/versions/:id     # 指定版本读取（含完整性验证）
POST  /api/main-config/rollback         # 回滚到指定版本
POST  /api/main-config/disable          # 逻辑禁用
POST  /api/main-config/enable           # 重新启用
```

**R2 数据结构（最终版本目录）：**

```text
vault/main-config/
├── identity.json                       # 身份对象（schemaVersion, configId, createdAt）—— 创建后不可变
├── latest.json                         # 发布指针（CAS 保护，含 status/disabledAt）
└── versions/
    └── {versionId}/
        ├── main-config.yaml            # 不可变 YAML 内容
        └── meta.json                   # 不可变版本元数据（含 artifact.sha256, artifact.contentLength）
```

**说明：**
- 主配置是全局的，不属于任何单个机场。
- `configId` 首次创建后永久稳定，所有操作不得改变。
- 所有内容版本不可变：写入后不修改，通过 `latest.json` CAS 更新指针。
- 禁用只修改指针的 `status` 和 `disabledAt`，不删除任何内容。
- 重复禁用/启用是幂等操作，但仍要求正确的 ETag。
- 当前正式版本损坏不会被普通更新掩盖（抛出 `MAIN_CONFIG_CORRUPTED`）。
- 阶段 4 公共固定 URL 已实现（`/main-config/:token` + `/config/:slug/:token`）。

**CAS 和幂等语义：**
- 初次创建：`If-None-Match: *`
- 更新已有：`If-Match: "<etag>"`
- 相同内容 + active 状态 → 直接复用，不创建新版本
- 相同内容 + disabled 状态 → CAS 将指针重新设为 active
- name 或 YAML 字节变化 → 创建新版本
- CAS 失败 → latest.json 不变，允许留下孤立版本

**数据迁移：** 无（新增路径，与现有 Provider 存储完全独立）

**测试覆盖：**
- 创建和身份（9 项）
- 输入和 YAML 验证（12 项）
- 幂等和版本（7 项）
- CAS 并发保护（7 项）
- 完整性和信任边界（13 项）
- 回滚、禁用和启用（11 项）
- API 认证和响应（12 项）
- 阶段 4 公共下载路由（75 项）

**验收门（已全部通过）：**
- ✅ 主配置与 Provider 完全独立存储
- ✅ configId 首次创建后永久稳定
- ✅ 所有内容版本不可变
- ✅ 所有修改操作都有 CAS
- ✅ 当前正式版本损坏不会被普通更新掩盖
- ✅ 支持读取、历史、回滚、禁用和启用
- ✅ 禁用不删除历史
- ✅ 已新增阶段 4 公共下载 URL（`/config/:slug/:token` + `/main-config/:token`）
- ✅ 没有修改现有 Provider 行为
- ✅ `npm test`（271 项）、`npm run typecheck`、`npm run format:check` 全部通过

---

### 阶段 4：Worker 完整配置固定 URL

**目标：** Worker 提供完整配置的固定 URL，Mihomo 客户端可以直接订阅。

**状态：** ✅ 已完成（提交 `636dde0`）

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/routes/config.ts` | 新增：完整配置下载 |
| Worker | `src/index.ts` | 注册新路由 |
| Worker | `src/services/storage.ts` | 新增：Profile 严格 resolver |
| Worker | `src/services/main-config-storage.ts` | 抽取：Core resolver + metadata-only |
| Worker | `src/types.ts` | 新增：公共下载类型 |
| Worker | `test/config-route.test.ts` | 新增：75 项测试 |

**新增接口：**

```text
GET   /config/:slug/:token              # 下载机场完整配置（profile.yaml）
HEAD  /config/:slug/:token              # 检查配置（仅返回头）
GET   /main-config/:token               # 下载手搓主配置（main-config.yaml）
HEAD  /main-config/:token               # 检查配置（仅返回头）
```

**核心契约：**

- `/config` 返回 V1 `profile.yaml`（不是 `provider.yaml`）
- `/main-config` 返回 active 状态的 `main-config.yaml`
- ETag 基于内容 SHA-256（不是版本指针）
- GET 在完整 SHA-256 + 字节数验证后才判断 304
- HEAD 使用 R2 `head()` 做 metadata-only 验证
- disabled 主配置对公共接口表现为 404（与不存在不可区分）
- legacy Pointer 返回 409 `CONFIG_NOT_AVAILABLE`
- 损坏的当前版本返回 500，不回退旧版本
- `main-config.yaml` 原样返回，不动态重写 `proxy-providers` URL
- 错误响应不包含 Token、R2 key 或哈希
- 不设置 `Content-Disposition`

**错误码映射：**

| 场景 | HTTP | 错误码 |
|------|-----:|--------|
| 非 GET/HEAD | 405 | `METHOD_NOT_ALLOWED` |
| Token 无效 | 403 | `FORBIDDEN` |
| Slug 非法 | 400 | `INVALID_SLUG` |
| Provider 不存在 | 404 | `CONFIG_NOT_FOUND` |
| legacy Pointer | 409 | `CONFIG_NOT_AVAILABLE` |
| Provider 损坏 | 500 | `CONFIG_CORRUPTED` |
| 主配置不存在 | 404 | `MAIN_CONFIG_NOT_FOUND` |
| 主配置损坏 | 500 | `MAIN_CONFIG_CORRUPTED` |

**数据迁移：** 无

**测试覆盖（75 项）：**
- 路由和鉴权（8 项）
- /config 成功行为（9 项）
- /config 损坏和状态（17 项）
- /main-config 损坏和状态（19 项）
- 条件请求（14 项）
- ETag 生命周期（3 项）
- 副作用（4 项）
- 入口路由回归（4 项：更新自原 Phase 4 未实现回归）

**验收门（已全部通过）：**
- ✅ `/config` 返回 `profile.yaml`，不是 `provider.yaml`
- ✅ `/main-config` 返回 `main-config.yaml`
- ✅ GET 完整校验后才判断 304
- ✅ HEAD 使用 `head()` 不读取 YAML 正文
- ✅ ETag 基于内容 SHA-256
- ✅ disabled 返回 404
- ✅ legacy 返回 409
- ✅ 损坏不回退旧版本
- ✅ 不自动重写 proxy-providers URL
- ✅ 不修改现有 `/provider` 行为
- ✅ 不修改现有管理 API
- ✅ 不进入阶段 5
- ✅ `npm test`（374 项）、`npx tsc --noEmit`、`npx prettier --check` 全部通过
- ✅ `npx wrangler deploy --dry-run` 通过

---

### 阶段 5：Worker 生成统一母包

**目标：** Worker 能够从 R2 数据生成符合 v1 格式的统一母包 ZIP。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/services/unified-export.ts` | 新增：统一母包导出 |
| Worker | `src/routes/api.ts` | 新增导出 API |
| Worker | `test/unified-export.test.ts` | 新增测试 |

**新增接口：**

```text
GET   /api/unified-export                  # 导出统一母包 ZIP
GET   /api/unified-export?slug={slug}      # 导出指定机场的母包
```

**数据迁移：** 无

**测试要求：**
- ZIP 根目录无包裹层
- manifest.json 完整性和哈希正确
- verge.yaml 存在且非空
- ZIP 可以被 Clash Verge Rev 直接导入（实际验证）
- 导出大小在 20MB 限制内
- 超过 20 MiB 时返回 413（不截断）

**验收门（必须全部通过）：**
- 生成的 ZIP 无包裹目录
- ZIP 根目录包含 config.yaml、verge.yaml、profiles.yaml、profiles/
- manifest.json 中的 `files` SHA-256 与实际文件一致
- verge.yaml 存在且内容为 `{}`
- 目录项不列入 manifest `files`
- Provider 扩展文件 `required: false`
- 该 ZIP 能被目标 Clash Verge Rev 版本识别并成功恢复
- 所有订阅 URL 指向 Worker 固定地址
- 导出大小在 20MB 限制内

**潜在风险：**
- Clash Verge Rev 对 profiles.yaml 的格式要求可能比预期更严格

**Phase 5 完成情况（2026-07-15，含审查修复）：**

实施文件：
- `src/types.ts` — 新增 `UnifiedExportErrorCode`、`ProviderBundle`、manifest 类型、`Env.PUBLIC_BASE_URL`
- `src/services/zip.ts` — 新增：流式 Stored ZIP writer（`precomputeZip` + `streamZip`）
- `src/services/validator.ts` — 新增 `generateProfileYaml()`
- `src/services/updater.ts` — 重写：接入 `publishProviderVersion()` V1 发布内核
- `src/services/storage.ts` — 新增 `resolveAndVerifyCurrentProviderBundle()`、`resolveProviderBundleMetadata()`、`computeProfileUid()`
- `src/services/unified-export.ts` — 新增：编排服务（两阶段大小预检、manifest `files` 规范）
- `src/routes/api.ts` — 新增 `/api/unified-export` 路由
- `wrangler.jsonc` — 新增 `PUBLIC_BASE_URL` 变量
- `test/unified-export.test.ts` — 101 项测试

审查修复：
- ✅ P0-1: `updateProvider()` 接入 `publishProviderVersion()`，正常更新生成 V1 数据
- ✅ P1-1: 元数据规划阶段预估大小，超限在加载制品字节前返回 413
- ✅ P1-2: manifest `files` 排除目录项，Provider 扩展文件 `required: false`
- ✅ P2-1: `profileUpdateInterval` 严格十进制验证（拒绝 "24abc"、"1.5"、"12h"）
- ✅ P2-2: `DOWNLOAD_TOKEN` 拒绝 `.` 和 `..`
- ✅ P2-3: 新增 UID 碰撞（不同 subscriptionId）、interval 边界、Token 边界测试
- ✅ P2-4: 文档清理旧 Schema 引用（`integrity.fileHashes` → `files`，移除 `truncatedFiles`）

验收结果：
- ✅ `npx tsc --noEmit` 通过
- ✅ `npx vitest run` 475 项全部通过（374 基线 + 101 新增）
- ✅ `npx wrangler deploy --dry-run` 通过
- ✅ 现有 `/api/export` 不受影响
- ✅ 16 个错误码完整覆盖
- ✅ manifest Schema 统一为 `files`（无 `integrity.fileHashes`，无目录项）
- ✅ config.yaml URL 改写正确
- ✅ profiles.yaml Clash Verge 格式正确（含 `update_interval` 分钟单位）
- ✅ Profile UID 基于 `subscriptionId`（非 slug/versionId）
- ✅ ZIP Stored 压缩，20 MiB 限制（元数据预检 + 最终精确检查），Content-Length 精确
- ✅ 响应错误不包含 Token、URL、SHA-256
- ✅ 正常 Provider 更新生成 V1 格式（raw.yaml + provider.yaml + profile.yaml + meta.json + CAS latest.json）

待手动验证：
- Clash Rev 真实恢复、重启和远程更新验证（需实际客户端环境）

---

### 阶段 6：Slclash 支持新母包导出

**目标：** Slclash 能够导出统一母包 v1 格式的 ZIP。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Slclash | `lib/services/backup_service.dart` | 修改：新增统一导出 |
| Slclash | `lib/models/unified_backup.dart` | 新增：数据模型 |
| Slclash | `lib/pages/backup_page.dart` | 修改：UI 选择导出格式 |

**新增接口：** 无（客户端功能）

**数据迁移：** 无

**测试要求：**
- 导出的 ZIP 符合 v1 格式
- ZIP 根目录无包裹层
- manifest.json 正确
- verge.yaml 存在
- 所有订阅 URL 已替换为 Worker 固定地址
- 旧格式导出仍然可用

**验收门（必须全部通过）：**
- Slclash 导出后重新导入，订阅数量、UID 和内容保持一致
- 统一母包可以被 Clash Verge Rev 导入
- 旧格式导出仍然可用

**潜在风险：**
- Slclash 的数据库快照可能包含敏感信息
- Profile URL 替换逻辑可能遗漏某些边界情况

---

### 阶段 7：Slclash 支持新母包导入

**目标：** Slclash 能够导入统一母包 v1 格式的 ZIP。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Slclash | `lib/common/dav_client.dart` | 修改：新增统一导入 |
| Slclash | `lib/database/database.dart` | 修改：新增 `restoreFromUnified()` |
| Slclash | `lib/services/backup_service.dart` | 修改：集成导入逻辑 |

**新增接口：** 无（客户端功能）

**数据迁移：** 无

**测试要求：**
- 导入统一母包后配置正确
- 导入旧格式备份仍然可用（兼容性）
- 数据库 restore 策略正确

**验收门（必须全部通过）：**
- Slclash 可以导入 Worker 导出的统一母包
- 导入后所有订阅 URL 指向 Worker
- 旧格式备份可以正常导入
- Slclash 导出后重新导入，订阅数量、UID 和内容保持一致

**潜在风险：**
- 数据库 schema 升级可能影响现有用户
- 导入统一母包时需要处理 Provider 缓存重建

---

### 阶段 8：Slclash 兼容旧备份

**目标：** 新版本 Slclash 可以导入旧版本 Slclash 备份，并自动转换。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Slclash | `lib/common/dav_client.dart` | 修改：检测格式版本 |
| Slclash | `lib/database/database.dart` | 修改：格式转换逻辑 |

**新增接口：** 无

**数据迁移：** 无（运行时转换）

**测试要求：**
- 旧格式备份可以正常导入
- 导入后自动升级为新格式
- 升级后的数据完整性验证

**验收门（必须全部通过）：**
- 使用真实旧备份样本做回归测试
- v2.0.1 备份可以被新版本导入
- 导入后配置完整且可用
- 升级过程不丢失用户数据

**潜在风险：**
- 格式转换逻辑可能遗漏某些字段
- 升级后无法回退到旧版本

---

### 阶段 9：Worker 支持导入 Slclash 母包

**目标：** Worker 能够导入 Slclash 导出的统一母包，形成新的可回滚版本。

**修改的仓库和文件：**

| 仓库 | 文件 | 说明 |
|------|------|------|
| Worker | `src/services/unified-import.ts` | 新增：统一母包导入 |
| Worker | `src/routes/api.ts` | 新增导入 API |
| Worker | `test/unified-import.test.ts` | 新增测试 |

**新增接口：**

```text
POST  /api/unified-import                  # 导入统一母包 ZIP

### 阶段 9 实际导入原子性边界

- 请求契约唯一固定为 `POST /api/unified-import`、Bearer 管理认证、
  `Content-Type: application/zip` 和原始 ZIP 字节请求体。
- 在第一次 R2 写入前完成 ZIP、manifest、哈希、YAML、身份、固定 URL，
  以及所有被引用 `raw.yaml` 不可变对象的完整预检。
- 每个 Provider 继续通过 `publishProviderVersion()` 独立发布，`latest.json`
  使用其现有 CAS；主配置继续通过 `publishMainConfig()` 及其 CAS 发布。
- R2 不提供跨对象事务。多 Provider 导入若在后续 Provider 或主配置处发生
  CAS 冲突，已经完成的 Provider 版本不会被虚假回滚；接口返回 409，并列出
  已提交的 Provider。未成功 CAS 的对象不会成为 current。
- v1 母包不包含 `raw.yaml` 正文，只包含其不可变 R2 key、SHA-256 和字节数。
  因此阶段 9 仅在该历史对象仍存在且通过完整性验证时导入；缺失或损坏会
  fail closed，不使用 `provider.yaml` 反向伪造事实源。该限制意味着 v1 支持
  同一 Vault 的 Worker → Slclash → Worker 往返，但不是全新空 Vault 的完整迁移包。
```

**数据迁移：** 无

**测试要求：**
- 导入的母包被正确解析
- Provider 数据写入 R2 不可变版本目录（provider.yaml + profile.yaml + meta.json）
- 手搓主配置保存
- 导入后可以回滚
- 完整性验证通过

**验收门（必须全部通过）：**
- Slclash 导出的统一母包可以被 Worker 导入
- 导入形成新的可回滚版本
- Worker 导入后重新导出，关键数据不丢失、不重复
- 旧版本仍可回滚

**潜在风险：**
- 导入的 profile.yaml 可能包含 Worker 无法处理的配置项
- 并发导入需要 CAS 保护

---

## 十一、测试矩阵

| 场景 | 测试类型 | 阶段 | 验证内容 |
|------|---------|------|---------|
| 版本目录原子写入 | 单元测试 | 2 | provider.yaml + profile.yaml + meta.json 全部成功或全部失败 |
| 旧版本兼容读取 | 单元测试 | 2 | 旧结构数据仍可正常读取 |
| 手搓主配置 CRUD | 单元测试 | 3 | 保存、读取、更新 |
| Provider URL 返回 profile.yaml | 单元测试 | 4 | YAML 格式、URL 指向、304 支持 |
| 完整配置固定 URL | 单元测试 | 4 | YAML 格式、proxy-providers URL |
| Worker 导出统一母包 | 单元测试 | 5 | ZIP 根目录无包裹、manifest 完整性、verge.yaml 存在 |
| 母包导入 Clash Verge Rev | 集成测试 | 5 | 实际导入验证（手动） |
| Slclash 导出统一母包 | 单元测试 | 6 | ZIP 结构、URL 替换、verge.yaml |
| Slclash 导入统一母包 | 单元测试 | 7 | 数据恢复、配置正确 |
| Slclash 旧格式兼容 | 回归测试 | 8 | v2.0.1 备份导入 |
| Worker 导入 Slclash 母包 | 单元测试 | 9 | 版本创建、回滚能力 |
| 端到端流程 | E2E 测试 | 9 | Worker→Slclash→Worker 全流程 |
| 路径穿越防护 | 安全测试 | 5,9 | ZIP 条目路径验证 |
| 并发导入 | 并发测试 | 9 | CAS 保护验证 |
| 大文件处理 | 性能测试 | 5 | 20MB 限制、截断处理 |

---

## 十二、风险和待决策事项

### 12.1 阻塞性决策（必须在开发前确定）

#### 决策 1：profile.yaml 的内容范围

**问题：** profile.yaml 作为机场完整配置，应该包含哪些内容？是只包含该机场的节点和基础配置，还是包含完整的分流规则和 DNS 配置？

**推荐选项：** profile.yaml 只包含该机场的节点和基础 proxy-groups，不包含分流规则和 DNS。分流规则和 DNS 由手搓主配置统一管理。

**推荐理由：**
- 每个机场的 profile.yaml 应该是自包含的节点配置，不依赖外部规则
- 分流规则和 DNS 是全局的，应该在手搓主配置中统一管理
- 避免每个机场重复存储相同的规则配置

**其他选项的代价：**
- 包含完整规则：每个机场的 profile.yaml 都包含相同的规则，冗余且容易不一致
- 不包含任何规则：profile.yaml 只有节点列表，无法独立使用

#### 决策 2：手搓主配置是否必须存在

**问题：** Worker 是否要求用户必须创建手搓主配置？还是允许只有 Provider 没有手搓主配置？

**推荐选项：** 允许只有 Provider 没有手搓主配置。手搓主配置是可选的高级功能。

**推荐理由：**
- 简单用户只需要 Provider URL 就能使用
- 手搓主配置是为需要多 Provider 聚合的高级用户准备的
- 降低初始使用门槛

**其他选项的代价：**
- 强制要求：简单用户被迫编写手搓主配置，增加使用门槛

#### 决策 3：Profile UID 生成策略

**问题：** 统一母包中的 Profile 文件使用 Clash Verge Rev 的 `{type}{uid}.yaml` 命名。UID 如何生成？

**推荐选项：** 使用 `sha256(slug).slice(0, 8)` 作为 UID。

**推荐理由：**
- slug 是机场的唯一标识，不会随版本变化
- 订阅更新后 slug 不变，UID 稳定
- 8 位十六进制哈希足够避免冲突

**其他选项的代价：**
- 使用 slug 本身：可能与用户自定义 Profile 冲突
- 使用包含 versionId 的哈希：每次更新 UID 变化，Clash Verge Rev 的 selected 状态丢失

#### 决策 4：Slclash 如何处理 Provider 缓存

**问题：** 导入统一母包后，Slclash 的 Provider 缓存（`profiles/providers/{profileId}/{type}/{urlMd5}`）如何处理？

**推荐选项：** 导入时清空旧缓存，让 Mihomo 内核重新从 Worker 固定地址拉取。

**推荐理由：**
- 缓存可能已过期
- Worker 固定地址是权威数据源
- 简化导入逻辑

**其他选项的代价：**
- 保留旧缓存：可能包含过期数据，导致配置不一致
- 合并缓存：增加复杂度，且缓存格式可能不兼容

### 12.2 非阻塞性风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| config.yaml 格式随 Mihomo 版本变化 | 导出的配置可能不兼容旧版 Mihomo | 在 manifest 中记录 Mihomo 版本，导入时检查 |
| Slclash 数据库 schema 升级 | 旧版本用户升级后数据丢失 | 提供自动迁移脚本，备份提醒 |
| ZIP 文件过大 | 超过 20MB 限制 | 分批导出，截断处理 |
| 并发导入冲突 | 两个 Slclash 同时导入 | Worker CAS 保护，后到者失败重试 |
| 机场一次性地址泄露 | 安全风险 | 所有 URL 必须经过 Worker 中转 |

---

## 十三、实施顺序总结

```text
阶段 1: 数据模型和母包格式定稿              ← 已完成
阶段 2: Worker 版本目录重构（双制品原子写入）  ← 已完成
阶段 3: Worker 手搓主配置存储               ← 已完成
阶段 4: Worker 完整配置固定 URL              ← 已完成
阶段 5: Worker 生成统一母包                    ← 已完成
阶段 6: Slclash 支持新母包导出
阶段 7: Slclash 支持新母包导入
阶段 8: Slclash 兼容旧备份
阶段 9: Worker 支持导入 Slclash 母包
```

每个阶段可独立验收。阶段 1-5 只涉及 Worker 仓库，阶段 6-8 只涉及 Slclash 仓库，阶段 9 回到 Worker 仓库。
