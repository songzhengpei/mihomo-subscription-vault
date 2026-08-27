import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildUnifiedExport } from "../src/services/unified-export.ts";
import {
  executeUnifiedImport,
  parseUnifiedImport,
} from "../src/services/unified-import.ts";
import type { Env } from "../src/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const baseUrl = "https://vault.example";

class MemoryBucket {
  private readonly values = new Map<string, Uint8Array>();
  private readonly etags = new Map<string, string>();
  private sequence = 0;

  async get(key: string) {
    const value = this.values.get(key);
    if (!value) return null;
    const copy = value.slice();
    return {
      key,
      etag: this.etags.get(key)!,
      size: copy.length,
      async text() {
        return decoder.decode(copy);
      },
      async json() {
        return JSON.parse(decoder.decode(copy));
      },
      async arrayBuffer() {
        return copy.buffer.slice(
          copy.byteOffset,
          copy.byteOffset + copy.byteLength,
        );
      },
    };
  }

  async head(key: string) {
    const value = this.values.get(key);
    return value
      ? { key, etag: this.etags.get(key)!, size: value.length }
      : null;
  }

  async put(
    key: string,
    body: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ) {
    const current = this.etags.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && current !== undefined)
      return null;
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      options.onlyIf.etagMatches !== current
    )
      return null;
    const bytes =
      typeof body === "string"
        ? encoder.encode(body)
        : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    const etag = `etag-${++this.sequence}`;
    this.values.set(key, bytes);
    this.etags.set(key, etag);
    return { key, etag };
  }

  async list(options?: { prefix?: string; delimiter?: string }) {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter ?? "";
    const keys = [...this.values.keys()].filter((key) =>
      key.startsWith(prefix),
    );
    if (!delimiter)
      return {
        objects: keys.map((key) => ({ key })),
        delimitedPrefixes: [],
        truncated: false,
      };
    const prefixes = new Set<string>();
    const objects: Array<{ key: string }> = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index < 0) objects.push({ key });
      else prefixes.add(prefix + rest.slice(0, index + 1));
    }
    return {
      objects,
      delimitedPrefixes: [...prefixes],
      truncated: false,
    };
  }
}

function parseStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (
    offset + 30 <= bytes.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const name = decoder.decode(
      bytes.slice(offset + 30, offset + 30 + nameLength),
    );
    files.set(name, bytes.slice(dataOffset, dataOffset + compressedSize));
    offset = dataOffset + compressedSize;
  }
  return files;
}

describe("real Slclash -> Worker client policy roundtrip", () => {
  it("imports, publishes and exports exact boolean/minute policies", async () => {
    const fixture = new Uint8Array(
      readFileSync(resolve("test/fixtures/slclash-client-policy-v1.zip")),
    );
    const bucket = new MemoryBucket();
    const plan = await parseUnifiedImport(fixture, baseUrl);
    expect(
      plan.providers.map(
        (provider) => provider.publishInput.distribution.clientUpdatePolicy,
      ),
    ).toEqual([
      { allowAutoUpdate: false, updateIntervalMinutes: 60 },
      { allowAutoUpdate: true, updateIntervalMinutes: 1440 },
      { allowAutoUpdate: false, updateIntervalMinutes: 1440 },
    ]);
    await executeUnifiedImport(bucket as unknown as R2Bucket, plan);

    const env = {
      SUBSCRIPTION_BUCKET: bucket as unknown as R2Bucket,
      ADMIN_TOKEN: "test-admin",
      DOWNLOAD_TOKEN: "fixed-token",
      PUBLIC_BASE_URL: baseUrl,
    } as Env;
    const exported = await buildUnifiedExport(
      bucket as unknown as R2Bucket,
      env,
    );
    const bytes = new Uint8Array(
      await new Response(exported.stream).arrayBuffer(),
    );
    const files = parseStoredZip(bytes);
    const profiles = jsYaml.load(
      decoder.decode(files.get("profiles.yaml")!),
    ) as {
      items: Array<{
        name: string;
        option: { allow_auto_update: boolean; update_interval: number };
      }>;
    };
    expect(
      Object.fromEntries(
        profiles.items.map((item) => [item.name, item.option]),
      ),
    ).toEqual({
      "Worker Profile": { allow_auto_update: false, update_interval: 60 },
      "Slclash Remote": { allow_auto_update: true, update_interval: 1440 },
      备用: { allow_auto_update: false, update_interval: 1440 },
    });
    const output = process.env.WORKER_CROSS_FIXTURE_OUT;
    if (output) writeFileSync(output, bytes);
  });
});
