import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public one-click deployment config", () => {
  const config = readFileSync(resolve("wrangler.jsonc"), "utf8");

  it("enables Browser Rendering fallback", () => {
    expect(config).toMatch(/"browser"\s*:\s*\{\s*"binding"\s*:\s*"BROWSER"/);
  });

  it("does not include a private relay or custom production route", () => {
    expect(config).not.toContain('"vpc_services"');
    expect(config).not.toContain('"UPSTREAM_RELAY"');
    expect(config).not.toContain('"routes"');
  });
});
