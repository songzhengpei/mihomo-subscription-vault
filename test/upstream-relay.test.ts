import { describe, expect, it, vi } from "vitest";
import {
  fetchRemoteSubscription,
  isPrivateAddress,
  resolvePublicAddresses,
  validateRemoteUrl,
} from "../scripts/upstream-relay.mjs";

const publicResolver = vi
  .fn()
  .mockResolvedValue([{ address: "203.0.114.10", family: 4 }]);

describe("private upstream relay", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("requires HTTPS and rejects embedded credentials", async () => {
    await expect(
      validateRemoteUrl("http://public.example/sub", publicResolver),
    ).rejects.toThrow("URL_PROTOCOL");
    await expect(
      validateRemoteUrl(
        "https://user:secret@public.example/sub",
        publicResolver,
      ),
    ).rejects.toThrow("URL_CREDENTIALS");
  });

  it("rejects hostnames resolving to any private address", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "203.0.114.10", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      validateRemoteUrl("https://mixed.example/sub", resolver),
    ).rejects.toThrow("URL_PRIVATE");
  });

  it("validates Fake-IP DNS environments through public DNS answers", async () => {
    const lookupImpl = vi
      .fn()
      .mockResolvedValue([{ address: "198.18.1.165", family: 4 }]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "104.21.26.21" }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ Status: 0, Answer: [] }));

    const addresses = await resolvePublicAddresses("airport.example", {
      lookupImpl,
      fetchImpl,
    });

    expect(addresses).toEqual([{ address: "104.21.26.21", family: 4 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the client UA and follows only validated redirects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example/profile" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("proxies:\n  - name: relay", {
          status: 200,
          headers: {
            "Content-Type": "text/yaml",
            "Subscription-Userinfo": "upload=0; download=0; total=1",
          },
        }),
      );

    const result = await fetchRemoteSubscription(
      {
        url: "https://airport.example/sub",
        userAgent: "SlClash/v9.9.9 clash-verge Platform/android",
        maxBytes: 4096,
        maxRedirects: 2,
        timeoutMs: 5000,
      },
      { fetchImpl, resolver: publicResolver },
    );

    expect(result.status).toBe(200);
    expect(result.finalHost).toBe("cdn.example");
    expect(new TextDecoder().decode(result.body)).toContain("proxies:");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL("https://airport.example/sub"),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          "User-Agent": "SlClash/v9.9.9 clash-verge Platform/android",
        }),
      }),
    );
  });

  it("enforces the response size limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("x".repeat(2048), {
        headers: { "Content-Length": "2048" },
      }),
    );
    await expect(
      fetchRemoteSubscription(
        {
          url: "https://airport.example/sub",
          maxBytes: 1024,
        },
        { fetchImpl, resolver: publicResolver },
      ),
    ).rejects.toThrow("RESPONSE_TOO_LARGE");
  });
});
