import { describe, it, expect } from "vitest";
import {
  parseAndValidateProvider,
  isBase64Content,
  generateProfileYaml,
} from "../src/services/validator.ts";

describe("validator", () => {
  const b64 = (value: string) => Buffer.from(value).toString("base64");

  it("keeps a plain proxy subscription inline", () => {
    const profile = generateProfileYaml([
      { name: "node-1", type: "ss", server: "example.com", port: 443 },
    ]);
    expect(profile).toMatch(/^proxies:/m);
    expect(profile).toContain("node-1");
    expect(profile).not.toContain("proxy-providers:");
    expect(profile).not.toContain("https://vault.example/provider/main/token");
  });

  it("preserves mixed full-config node organization", () => {
    const profile = generateProfileYaml(
      [{ name: "inline-1", type: "ss", server: "example.com", port: 443 }],
      {
        proxies: [{ name: "old", type: "ss" }],
        "proxy-providers": {
          Flower: { type: "http", url: "https://airport.example/flower" },
        },
        "proxy-groups": [
          {
            name: "select",
            type: "select",
            proxies: ["inline-1"],
            use: ["Flower"],
          },
        ],
      },
    );
    expect(profile).toContain("Flower:");
    expect(profile).toContain("inline-1");
    expect(profile).not.toMatch(/^  main:/m);
    expect(profile).not.toContain("vault.example/provider/main");
  });

  describe("parseAndValidateProvider", () => {
    it("accepts valid provider YAML", () => {
      const input = `proxies:
  - name: HK-01
    type: ss
    server: example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
  - name: US-01
    type: vmess
    server: us.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    cipher: auto`;
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(true);
      expect(result.proxies).toHaveLength(2);
    });

    it("extracts proxies from full Clash config", () => {
      const input = `mixed-port: 7890
dns:
  enable: true
proxies:
  - name: HK-01
    type: ss
    server: example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
proxy-groups:
  - name: auto
    type: url-test
rules:
  - MATCH,DIRECT`;
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(true);
      expect(result.proxies).toHaveLength(1);
      expect(result.proxies![0]!.name).toBe("HK-01");
    });

    it("rejects empty content", () => {
      expect(parseAndValidateProvider("").valid).toBe(false);
      expect(parseAndValidateProvider("   ").valid).toBe(false);
    });

    it("rejects HTML pages", () => {
      const html = `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>Please login</body>
</html>`;
      const result = parseAndValidateProvider(html);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("HTML");
    });

    it("rejects YAML with no proxies", () => {
      const input = `mixed-port: 7890
dns:
  enable: true`;
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("proxies");
    });

    it("rejects invalid YAML", () => {
      const input = `proxies: [
  { name: test, type: ss, server: example.com,
  { name: test2, type: ss, server: example2.com }`;
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(false);
    });

    it("rejects proxies without name or type", () => {
      const input = `proxies:
  - server: example.com
    port: 443`;
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("name 或 type");
    });

    it.each([
      ["ss", "server, port, cipher, password"],
      ["ssr", "server, port, cipher, password, protocol, obfs"],
      ["vmess", "server, port, uuid, cipher"],
      ["vless", "server, port, uuid"],
      ["trojan", "server, port, password"],
      ["hysteria", "server, port, auth 或 auth-str"],
      ["hysteria2", "server, port 或 ports, password"],
      ["tuic", "server, port, token 或 uuid + password"],
      ["anytls", "server, port, password"],
      ["mieru", "server, port 或 port-range, username, password, transport"],
      ["snell", "server, port, psk"],
    ])("rejects an incomplete %s proxy before publish", (type, fields) => {
      const result = parseAndValidateProvider(`proxies:
  - name: Empty ${type}
    type: ${type}`);
      expect(result.valid).toBe(false);
      for (const field of fields.split(", ")) {
        expect(result.error).toContain(field);
      }
    });

    it("allows Mihomo built-in proxies without server and port", () => {
      const result = parseAndValidateProvider(`proxies:
  - name: DIRECT-OUT
    type: direct
  - name: REJECT-OUT
    type: reject`);
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies).toHaveLength(2);
    });

    it.each([
      [
        "Hysteria auth",
        {
          name: "HY",
          type: "hysteria",
          server: "hy.example.com",
          port: 443,
          "auth-str": "secret",
        },
      ],
      [
        "Hysteria2 port hopping",
        {
          name: "HY2",
          type: "hysteria2",
          server: "hy2.example.com",
          ports: "443/8443-8445",
          password: "secret",
        },
      ],
      [
        "TUIC V4",
        {
          name: "TUIC V4",
          type: "tuic",
          server: "tuic4.example.com",
          port: 443,
          token: "secret",
        },
      ],
      [
        "TUIC V5",
        {
          name: "TUIC V5",
          type: "tuic",
          server: "tuic5.example.com",
          port: 443,
          uuid: "11111111-1111-1111-1111-111111111111",
          password: "secret",
        },
      ],
      [
        "Mieru port range",
        {
          name: "Mieru",
          type: "mieru",
          server: "mieru.example.com",
          "port-range": "2090-2099",
          username: "user",
          password: "secret",
          transport: "TCP",
        },
      ],
    ])("accepts valid protocol-specific minimum fields: %s", (_name, node) => {
      const result = parseAndValidateProvider(JSON.stringify([node]));
      expect(result.valid, result.error).toBe(true);
    });

    it("rejects Mieru when port and port-range are both present", () => {
      const result = parseAndValidateProvider(
        JSON.stringify({
          proxies: [
            {
              name: "Mieru",
              type: "mieru",
              server: "mieru.example.com",
              port: 443,
              "port-range": "2090-2099",
              username: "user",
              password: "secret",
              transport: "TCP",
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("只能填写一个");
    });

    it("rejects an invalid Hysteria2 ports range", () => {
      const result = parseAndValidateProvider(
        JSON.stringify({
          proxies: [
            {
              name: "HY2",
              type: "hysteria2",
              server: "hy2.example.com",
              ports: "8443-443",
              password: "secret",
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("ports");
    });

    it("accepts JSON Clash config", () => {
      const result = parseAndValidateProvider(
        JSON.stringify({
          proxies: [
            {
              name: "json-node",
              type: "ss",
              server: "json.example.com",
              port: 443,
              cipher: "aes-128-gcm",
              password: "secret",
            },
          ],
          rules: ["MATCH,DIRECT"],
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.sourceType).toBe("full-config");
    });

    it("accepts a Base64-encoded URI subscription", () => {
      const links = [
        `ss://${b64("aes-128-gcm:secret")}@ss.example.com:443#SS`,
        "vless://11111111-1111-1111-1111-111111111111@vless.example.com:443?security=reality&type=grpc&pbk=public&sid=01#VLESS",
      ].join("\n");
      const result = parseAndValidateProvider(b64(links));
      expect(result.valid).toBe(true);
      expect(result.sourceType).toBe("uri-list");
      expect(result.proxies?.map((node) => node.type)).toEqual(["ss", "vless"]);
    });

    it("accepts BOM, CR-only lines, comments, and mixed-case URI schemes", () => {
      const input = `\uFEFF# airport\rSS://${b64("aes-128-gcm:secret")}@ss.example.com:443#SS\r\rTrojan://secret@trojan.example.com:443#Trojan`;
      const result = parseAndValidateProvider(input);
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.map((node) => node.type)).toEqual([
        "ss",
        "trojan",
      ]);
    });

    it("accepts a URL-encoded URI subscription", () => {
      const input = encodeURIComponent(
        "trojan://secret@trojan.example.com:443#Trojan",
      );
      const result = parseAndValidateProvider(input);
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]?.type).toBe("trojan");
    });

    it("accepts URL-safe Base64 without padding", () => {
      const input = Buffer.from("trojan://secret@trojan.example.com:443#Trojan")
        .toString("base64url")
        .replace(/=+$/, "");
      const result = parseAndValidateProvider(input);
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]?.name).toBe("Trojan");
    });

    it("accepts bounded multi-layer Base64 subscriptions", () => {
      const uri = "trojan://secret@trojan.example.com:443#Nested";
      const result = parseAndValidateProvider(b64(b64(uri)));
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]?.name).toBe("Nested");
    });

    it("accepts Base64-encoded Clash YAML", () => {
      const yaml = `proxies:
  - name: encoded-yaml
    type: ss
    server: yaml.example.com
    port: 443
    cipher: aes-128-gcm
    password: secret`;
      const result = parseAndValidateProvider(b64(yaml));
      expect(result.valid, result.error).toBe(true);
      expect(result.sourceType).toBe("provider");
      expect(result.proxies?.[0]?.name).toBe("encoded-yaml");
    });

    it("accepts a direct JSON array of Clash proxy objects", () => {
      const result = parseAndValidateProvider(
        JSON.stringify([
          {
            name: "array-node",
            type: "trojan",
            server: "array.example.com",
            port: 443,
            password: "secret",
          },
        ]),
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.sourceType).toBe("provider");
      expect(result.proxies?.[0]?.name).toBe("array-node");
    });

    it.each([
      ["ss", `ss://${b64("aes-128-gcm:secret")}@ss.example.com:443#SS`],
      [
        "ssr",
        `ssr://${b64(`ssr.example.com:443:origin:aes-128-gcm:plain:${b64("secret")}/?remarks=${b64("SSR")}`)}`,
      ],
      [
        "vmess",
        `vmess://${b64(JSON.stringify({ v: "2", ps: "VMess", add: "vmess.example.com", port: "443", id: "11111111-1111-1111-1111-111111111111", aid: "0", net: "ws", path: "/ws", tls: "tls" }))}`,
      ],
      [
        "vmess",
        "vmess://auto:11111111-1111-1111-1111-111111111111@legacy-vmess.example.com:443?remarks=Legacy-VMess&obfs=websocket&obfsParam=cdn.example.com&path=%2Fws&tls=1&peer=sni.example.com",
      ],
      [
        "vless",
        "vless://11111111-1111-1111-1111-111111111111@vless.example.com:443?security=tls&type=ws&path=%2Fws#VLESS",
      ],
      [
        "trojan",
        "trojan://secret@trojan.example.com:443?sni=trojan.example.com#Trojan",
      ],
      [
        "hysteria",
        "hysteria://secret@hy.example.com:443?up=20&down=100&insecure=1#Hysteria",
      ],
      [
        "hysteria2",
        "hy2://secret@hy2.example.com:443?obfs=salamander&obfs-password=mask#Hy2",
      ],
      [
        "tuic",
        "tuic://11111111-1111-1111-1111-111111111111:secret@tuic.example.com:443?congestion_control=bbr#TUIC",
      ],
      [
        "anytls",
        "anytls://secret@anytls.example.com:443?sni=anytls.example.com#AnyTLS",
      ],
      [
        "mieru",
        "mierus://user:secret@mieru.example.com:443?transport=TCP#Mieru",
      ],
      ["socks5", "socks5://user:secret@socks.example.com:1080#SOCKS"],
      ["http", "https://user:secret@http.example.com:443#HTTP"],
      [
        "snell",
        "snell://secret@snell.example.com:443?version=4&obfs=http&obfs-host=cdn.example.com#Snell",
      ],
    ])("converts a %s URI", (expectedType, link) => {
      const result = parseAndValidateProvider(link);
      expect(result.valid, result.error).toBe(true);
      expect(result.sourceType).toBe("uri-list");
      expect(result.proxies?.[0]?.type).toBe(expectedType);
    });

    it("maps Shadowrocket-style VMess URL aliases to Mihomo fields", () => {
      const result = parseAndValidateProvider(
        "vmess://auto:11111111-1111-1111-1111-111111111111@vmess.example.com:443?remarks=Legacy&obfs=websocket&obfsParam=cdn.example.com&path=%2Fws&tls=1&peer=sni.example.com",
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]).toMatchObject({
        name: "Legacy",
        type: "vmess",
        uuid: "11111111-1111-1111-1111-111111111111",
        cipher: "auto",
        tls: true,
        servername: "sni.example.com",
        network: "ws",
        "ws-opts": {
          path: "/ws",
          headers: { Host: "cdn.example.com" },
        },
      });
    });

    it("converts an SSD subscription with defaults and server overrides", () => {
      const result = parseAndValidateProvider(
        `ssd://${b64(
          JSON.stringify({
            airport: "Airport",
            port: 443,
            encryption: "aes-128-gcm",
            password: "default-secret",
            plugin: "v2ray",
            plugin_options: "obfs=websocket;obfs-host=cdn.example.com",
            servers: [
              { server: "one.example.com", remarks: "SSD-1" },
              {
                server: "two.example.com",
                port: 8443,
                password: "override-secret",
              },
            ],
          }),
        )}`,
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.sourceType).toBe("uri-list");
      expect(result.proxies).toHaveLength(2);
      expect(result.proxies?.[0]).toMatchObject({
        name: "SSD-1",
        type: "ss",
        server: "one.example.com",
        port: 443,
        cipher: "aes-128-gcm",
        password: "default-secret",
        plugin: "v2ray-plugin",
        "plugin-opts": {
          mode: "websocket",
          host: "cdn.example.com",
        },
      });
      expect(result.proxies?.[1]).toMatchObject({
        name: "Airport-2",
        port: 8443,
        password: "override-secret",
      });
    });

    it("normalizes simple-obfs SSD fields for Mihomo", () => {
      const result = parseAndValidateProvider(
        `ssd://${b64(
          JSON.stringify({
            port: 443,
            encryption: "aes-128-gcm",
            password: "secret",
            plugin: "simple-obfs",
            plugin_options: "obfs=tls;obfs-host=cdn.example.com",
            servers: [{ server: "obfs.example.com" }],
          }),
        )}`,
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]).toMatchObject({
        plugin: "obfs",
        "plugin-opts": {
          mode: "tls",
          host: "cdn.example.com",
        },
      });
    });

    it("maps a Snell URI to Mihomo psk and obfs fields", () => {
      const result = parseAndValidateProvider(
        "snell://secret@snell.example.com:443?version=4&obfs=tls&obfs-host=cdn.example.com#Snell",
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.proxies?.[0]).toMatchObject({
        name: "Snell",
        type: "snell",
        psk: "secret",
        version: 4,
        "obfs-opts": { mode: "tls", host: "cdn.example.com" },
      });
    });

    it("accepts SIP008 arrays and plugin options", () => {
      const result = parseAndValidateProvider(
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: "server-1",
              remarks: "SIP008",
              server: "sip008.example.com",
              server_port: 443,
              method: "aes-128-gcm",
              password: "secret",
              plugin: "v2ray-plugin",
              plugin_opts: "mode=websocket;host=cdn.example.com",
            },
          ],
        }),
      );
      expect(result.valid, result.error).toBe(true);
      expect(result.sourceType).toBe("sip008");
      expect(result.proxies?.[0]).toMatchObject({
        name: "SIP008",
        type: "ss",
        server: "sip008.example.com",
        port: 443,
        cipher: "aes-128-gcm",
        plugin: "v2ray-plugin",
      });
    });

    it("rejects a URI list if any node is malformed", () => {
      const result = parseAndValidateProvider(
        "trojan://secret@good.example.com:443#Good\nvless://missing-port@example.com#Bad",
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("第 2 个代理链接无效");
    });

    it("rejects unrelated Base64 content", () => {
      const result = parseAndValidateProvider(
        b64("this is not a subscription"),
      );
      expect(result.valid).toBe(false);
    });

    it.each([
      [
        "Surge",
        "[General]\nloglevel = notify\n[Proxy]\nHK = ss, example.com, 443",
      ],
      [
        "Quantumult X",
        "shadowsocks=example.com:443, method=aes-128-gcm, password=secret, tag=HK",
      ],
      [
        "Quantumult",
        "[server_local]\nshadowsocks=example.com:443, method=aes-128-gcm, password=secret, tag=HK",
      ],
      [
        "Stash",
        `proxies:
  - name: HK
    type: ss
    server: example.com
    port: 443
script-providers:
  rewrite:
    url: https://example.com/rewrite.js`,
      ],
      [
        "sing-box",
        JSON.stringify({
          inbounds: [],
          outbounds: [{ type: "direct", tag: "direct" }],
          route: {},
        }),
      ],
    ])("clearly rejects unsupported %s configuration", (kind, input) => {
      const result = parseAndValidateProvider(input);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(kind);
    });
  });

  describe("isBase64Content", () => {
    it("detects single-line Base64", () => {
      const long = "A".repeat(200);
      expect(isBase64Content(long)).toBe(true);
    });

    it("rejects multi-line content", () => {
      const multi = "line1\nline2\nline3";
      expect(isBase64Content(multi)).toBe(false);
    });

    it("rejects short content", () => {
      expect(isBase64Content("abc")).toBe(false);
    });
  });
});
