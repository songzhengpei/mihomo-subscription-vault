# 订阅格式支持矩阵

本文记录 Mihomo Subscription Vault 对机场订阅内容的识别和转换范围。判断依据是
响应内容，不依赖 URL 后缀或 `Content-Type`。

## 当前覆盖范围

当前支持 8 类常见订阅内容形态、13 种规范化 URI 节点协议，以及 4 个常见 URI
协议别名。

### 订阅容器

| 内容形态                       | 当前状态 | 处理方式                                        |
| ------------------------------ | -------- | ----------------------------------------------- |
| Clash/Mihomo Provider YAML     | 支持     | 读取顶层 `proxies`                              |
| 完整 Clash/Mihomo YAML         | 支持     | 保留完整配置并提取 `proxies`、`proxy-providers` |
| 上述两类的 JSON 等价结构       | 支持     | 与 YAML 使用同一结构识别                        |
| Clash 代理对象的直接 JSON 数组 | 支持     | 转成 Provider 节点列表                          |
| 未编码的逐行通用 URI           | 支持     | 忽略空行和 `#` 注释后逐条转换                   |
| Base64 通用订阅                | 支持     | 解码后重新进入完整识别流程                      |
| SIP008 Shadowsocks JSON        | 支持     | 转成 Mihomo `ss` 节点                           |
| SSD (`ssd://`)                 | 支持     | 展开默认值和服务器覆盖值，转成 Mihomo `ss` 节点 |

表中的 YAML/JSON、URI、SIP008 和 SSD 还支持以下输入变化：

- UTF-8 BOM；
- LF、CRLF、CR 三种换行；
- URI scheme 大小写混用；
- 整体 URL 百分号编码；
- 标准 Base64 与 URL-safe Base64；
- 缺失 Base64 padding；
- Base64 编码的 YAML、JSON 或 URI 列表；
- 最多三层、每层结果都能继续被明确识别的编码。

### 通用 URI 协议

| 规范化节点类型 | 接受的 scheme            | 备注                                           |
| -------------- | ------------------------ | ---------------------------------------------- |
| Shadowsocks    | `ss://`                  | SIP002、带 SIP003 plugin 参数                  |
| ShadowsocksR   | `ssr://`                 | Base64 SSR 分享链接                            |
| VMess          | `vmess://`               | V2RayN Base64 JSON、Xray/Shadowrocket URL 风格 |
| VLESS          | `vless://`               | TLS、Reality、WS、gRPC、HTTP/H2 常用参数       |
| Trojan         | `trojan://`              | TLS、WS、gRPC、HTTP/H2 常用参数                |
| Hysteria       | `hysteria://`            | auth、up/down、obfs、TLS 常用参数              |
| Hysteria 2     | `hysteria2://`、`hy2://` | password、obfs、TLS 常用参数                   |
| TUIC           | `tuic://`                | UUID/password、拥塞和 UDP relay 参数           |
| AnyTLS         | `anytls://`              | password 和 TLS 常用参数                       |
| Mieru          | `mierus://`              | 转为 Mihomo `mieru`                            |
| SOCKS5         | `socks5://`、`socks://`  | 可选用户名和密码                               |
| HTTP(S) proxy  | `http://`、`https://`    | HTTPS 转为带 TLS 的 Mihomo `http`              |
| Snell          | `snell://`               | PSK、v1-v5、HTTP/TLS obfs 常用参数             |

Shadowrocket 常见的 VMess URL 参数 `remarks`、`obfs=websocket`、
`obfsParam`、`peer`、`tls=1` 会分别映射到 Mihomo 的节点名称、WS
传输、WS Host、SNI 和 TLS 字段。

如果上游已经提供 Clash/Mihomo YAML 或 JSON 代理对象，Vault 会保留其中的
官方节点字段，不把它重新降级为 URI。因此 WireGuard、SSH 等没有通用机场分享
URI 的 Mihomo 节点仍可通过原生 Clash/Mihomo 对象保存；最终可用性取决于客户端
所使用的 Mihomo 内核版本。

## 本次补齐内容

与开始本次工作前的 `main` 分支相比：

| 能力                            | 修复前           | 当前                                      |
| ------------------------------- | ---------------- | ----------------------------------------- |
| Base64 URI 列表                 | 支持标准单层输入 | 增加 URL-safe、缺 padding 和有界多层解码  |
| Base64 YAML/JSON                | 不支持           | 支持                                      |
| 整体 URL 编码订阅               | 不支持           | 支持                                      |
| BOM、CR-only、混合大小写 scheme | 不完整           | 支持                                      |
| 直接 JSON 代理数组              | 不支持           | 支持                                      |
| SSD                             | 不支持           | 支持默认值、节点覆盖和 plugin options     |
| VMess URL 风格                  | 仅 Base64 JSON   | 增加 Xray/Shadowrocket URL 风格和常用别名 |
| Snell URI                       | 不支持           | 支持并转为 Mihomo Snell 节点              |
| 范围外配置错误                  | 多数返回泛化错误 | 对各客户端专属格式返回明确错误            |

## 明确不支持

以下内容不做转换：

- Surge 专属分节配置；
- Shadowrocket 完整配置文件（其中独立的通用 URI 仍支持）；
- Stash 的脚本、MitM、重写、定时任务等专属配置；
- Quantumult/Quantumult X 专属分节配置和节点行；
- sing-box 的 `inbounds`/`outbounds`/`route` 配置；
- 其他客户端专属规则、脚本和配置语法。

如果一份配置同时包含 Clash/Mihomo 公共字段和上述客户端专属特征，Vault 会拒绝
整份输入，避免悄悄丢失专属语义。纯 Clash/Mihomo 公共子集不因文件来源客户端
而被拒绝。

## 识别顺序和失败原则

1. 拒绝空内容和 HTML/XML 错误页。
2. 解析 YAML/JSON，并先识别范围外的客户端专属特征。
3. 识别完整 Clash/Mihomo 配置、Provider 对象和直接代理数组。
4. 识别 SIP008、SSD 和逐行 URI。
5. 对 URL 编码或 Base64 内容解码一层，再从第 1 步重新识别；最多三层。
6. 任意 URI 列表中有一条格式错误时，整次更新失败并指出节点序号。
7. 无法明确识别时失败，不生成看似成功但不可用的配置。

## 参考

- [Mihomo outbound proxy documentation](https://wiki.metacubex.one/en/config/)
- [Mihomo Snell fields](https://wiki.metacubex.one/en/config/proxies/snell/)
- [SSD subscription specification](https://gist.github.com/Un1Gfn/5d25a31f8c567b3149de21d052fd83e8)
