import { describe, it, expect } from "vitest";
import {
  validateUrl,
  validateSlug,
  isReservedAddress,
  isIPv4Private,
  isIPv6Private,
  normalizeIPv6,
} from "../src/security/ssrf.ts";

describe("ssrf protection", () => {
  describe("validateUrl", () => {
    it("accepts valid HTTPS URL", () => {
      expect(validateUrl("https://example.com/sub").valid).toBe(true);
    });

    it("accepts valid HTTP URL", () => {
      expect(validateUrl("http://example.com/sub").valid).toBe(true);
    });

    it("rejects non-http protocols", () => {
      expect(validateUrl("ftp://example.com").valid).toBe(false);
      expect(validateUrl("file:///etc/passwd").valid).toBe(false);
    });

    it("rejects localhost", () => {
      expect(validateUrl("http://localhost/secret").valid).toBe(false);
      expect(validateUrl("http://127.0.0.1/secret").valid).toBe(false);
      expect(validateUrl("http://[::1]/secret").valid).toBe(false);
    });

    it("rejects private IPs", () => {
      expect(validateUrl("http://10.0.0.1/secret").valid).toBe(false);
      expect(validateUrl("http://172.16.0.1/secret").valid).toBe(false);
      expect(validateUrl("http://192.168.1.1/secret").valid).toBe(false);
    });

    it("rejects link-local addresses", () => {
      expect(validateUrl("http://169.254.169.254/secret").valid).toBe(false);
    });

    it("rejects CGNAT range", () => {
      expect(validateUrl("http://100.64.0.1/secret").valid).toBe(false);
      expect(validateUrl("http://100.127.255.255/secret").valid).toBe(false);
    });

    it("rejects benchmarking range", () => {
      expect(validateUrl("http://198.18.0.1/secret").valid).toBe(false);
    });

    it("rejects multicast", () => {
      expect(validateUrl("http://224.0.0.1/secret").valid).toBe(false);
    });

    it("rejects reserved ranges", () => {
      expect(validateUrl("http://192.0.0.1/secret").valid).toBe(false);
      expect(validateUrl("http://192.0.2.1/secret").valid).toBe(false);
      expect(validateUrl("http://198.51.100.1/secret").valid).toBe(false);
      expect(validateUrl("http://203.0.113.1/secret").valid).toBe(false);
    });

    it("rejects IPv6 loopback", () => {
      expect(validateUrl("http://[::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[0:0:0:0:0:0:0:1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 unique local", () => {
      expect(validateUrl("http://[fc00::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[fd00::1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 link-local", () => {
      expect(validateUrl("http://[fe80::1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 link-local boundary addresses", () => {
      expect(validateUrl("http://[fe90::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[fea0::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[febf::1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 multicast", () => {
      expect(validateUrl("http://[ff02::1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 unspecified", () => {
      expect(validateUrl("http://[::]/secret").valid).toBe(false);
    });

    it("rejects IPv4-mapped IPv6", () => {
      expect(validateUrl("http://[::ffff:127.0.0.1]/secret").valid).toBe(false);
      expect(validateUrl("http://[::ffff:10.0.0.1]/secret").valid).toBe(false);
      expect(validateUrl("http://[::ffff:192.168.1.1]/secret").valid).toBe(
        false,
      );
    });

    it("rejects IPv6 deprecated site-local", () => {
      expect(validateUrl("http://[fec0::1]/secret").valid).toBe(false);
    });

    it("rejects IPv6 deprecated site-local boundary addresses", () => {
      expect(validateUrl("http://[fed0::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[fee0::1]/secret").valid).toBe(false);
      expect(validateUrl("http://[fef0::1]/secret").valid).toBe(false);
    });

    it("rejects invalid URLs", () => {
      expect(validateUrl("not-a-url").valid).toBe(false);
    });
  });

  describe("validateSlug", () => {
    it("accepts valid slugs", () => {
      expect(validateSlug("main")).toBe(true);
      expect(validateSlug("test-1")).toBe(true);
      expect(validateSlug("a")).toBe(true);
      expect(validateSlug("my-provider-2")).toBe(true);
    });

    it("rejects invalid slugs", () => {
      expect(validateSlug("")).toBe(false);
      expect(validateSlug("Main")).toBe(false);
      expect(validateSlug("has space")).toBe(false);
      expect(validateSlug("-start")).toBe(false);
      expect(validateSlug("end-")).toBe(false);
      expect(validateSlug("has_underscore")).toBe(false);
      expect(validateSlug("a".repeat(64))).toBe(false);
    });
  });

  describe("isReservedAddress", () => {
    it("blocks known hosts", () => {
      expect(isReservedAddress("localhost")).toBe(true);
      expect(isReservedAddress("metadata.google.internal")).toBe(true);
    });

    it("blocks private IP patterns", () => {
      expect(isReservedAddress("10.0.0.1")).toBe(true);
      expect(isReservedAddress("172.16.0.1")).toBe(true);
      expect(isReservedAddress("192.168.1.1")).toBe(true);
    });

    it("blocks IPv6 addresses", () => {
      expect(isReservedAddress("::1")).toBe(true);
      expect(isReservedAddress("[::1]")).toBe(true);
      expect(isReservedAddress("fc00::1")).toBe(true);
      expect(isReservedAddress("[fc00::1]")).toBe(true);
      expect(isReservedAddress("fe80::1")).toBe(true);
      expect(isReservedAddress("[fe80::1]")).toBe(true);
    });

    it("blocks IPv4-mapped IPv6", () => {
      expect(isReservedAddress("[::ffff:127.0.0.1]")).toBe(true);
      expect(isReservedAddress("[::ffff:10.0.0.1]")).toBe(true);
    });

    it("allows public addresses", () => {
      expect(isReservedAddress("example.com")).toBe(false);
      expect(isReservedAddress("8.8.8.8")).toBe(false);
    });
  });

  describe("isIPv4Private", () => {
    it("blocks all private ranges", () => {
      expect(isIPv4Private("0.0.0.0")).toBe(true);
      expect(isIPv4Private("10.0.0.1")).toBe(true);
      expect(isIPv4Private("100.64.0.1")).toBe(true);
      expect(isIPv4Private("127.0.0.1")).toBe(true);
      expect(isIPv4Private("169.254.0.1")).toBe(true);
      expect(isIPv4Private("172.16.0.1")).toBe(true);
      expect(isIPv4Private("192.0.0.1")).toBe(true);
      expect(isIPv4Private("192.168.1.1")).toBe(true);
      expect(isIPv4Private("198.18.0.1")).toBe(true);
      expect(isIPv4Private("224.0.0.1")).toBe(true);
      expect(isIPv4Private("240.0.0.1")).toBe(true);
    });

    it("allows public addresses", () => {
      expect(isIPv4Private("8.8.8.8")).toBe(false);
      expect(isIPv4Private("1.1.1.1")).toBe(false);
      expect(isIPv4Private("52.0.0.1")).toBe(false);
    });
  });

  describe("isIPv6Private", () => {
    it("blocks all private ranges", () => {
      expect(isIPv6Private("::1")).toBe(true);
      expect(isIPv6Private("::")).toBe(true);
      expect(isIPv6Private("fc00::1")).toBe(true);
      expect(isIPv6Private("fd00::1")).toBe(true);
      expect(isIPv6Private("fe80::1")).toBe(true);
      expect(isIPv6Private("ff00::1")).toBe(true);
      expect(isIPv6Private("fec0::1")).toBe(true);
    });

    it("blocks fe80::/10 boundary addresses", () => {
      expect(isIPv6Private("fe80::1")).toBe(true);
      expect(isIPv6Private("fe90::1")).toBe(true);
      expect(isIPv6Private("fea0::1")).toBe(true);
      expect(isIPv6Private("febf::1")).toBe(true);
    });

    it("blocks fec0::/10 boundary addresses", () => {
      expect(isIPv6Private("fec0::1")).toBe(true);
      expect(isIPv6Private("fed0::1")).toBe(true);
      expect(isIPv6Private("fee0::1")).toBe(true);
      expect(isIPv6Private("fef0::1")).toBe(true);
    });

    it("allows public addresses", () => {
      expect(isIPv6Private("2001:db8::1")).toBe(false);
      expect(isIPv6Private("2606:4700::1")).toBe(false);
    });
  });

  describe("normalizeIPv6", () => {
    it("removes brackets", () => {
      expect(normalizeIPv6("[::1]")).toBe("::1");
    });

    it("normalizes to lowercase", () => {
      expect(normalizeIPv6("FC00::1")).toBe("fc00::1");
    });

    it("converts IPv4-mapped IPv6 to IPv4", () => {
      expect(normalizeIPv6("[::ffff:127.0.0.1]")).toBe("127.0.0.1");
      expect(normalizeIPv6("[::ffff:192.168.1.1]")).toBe("192.168.1.1");
    });
  });
});
