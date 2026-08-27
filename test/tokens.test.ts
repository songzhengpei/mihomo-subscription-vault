import { describe, it, expect } from "vitest";
import { timingSafeEqual, verifyToken } from "../src/security/tokens.ts";

describe("tokens", () => {
  describe("timingSafeEqual", () => {
    it("returns true for equal strings", () => {
      expect(timingSafeEqual("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(timingSafeEqual("abc", "abd")).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(timingSafeEqual("abc", "abcd")).toBe(false);
    });

    it("returns true for empty strings", () => {
      expect(timingSafeEqual("", "")).toBe(true);
    });
  });

  describe("verifyToken", () => {
    it("verifies matching tokens", () => {
      expect(verifyToken("my-secret-token", "my-secret-token")).toBe(true);
    });

    it("rejects mismatched tokens", () => {
      expect(verifyToken("wrong-token", "my-secret-token")).toBe(false);
    });
  });
});
