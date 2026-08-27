export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ZipLocalEntry {
  nameBytes: Uint8Array;
  header: Uint8Array;
  data: Uint8Array;
  crc: number;
  size: number;
}

interface ZipCentralEntry {
  header: Uint8Array;
}

export interface PrecomputedZip {
  locals: ZipLocalEntry[];
  centrals: ZipCentralEntry[];
  endRecord: Uint8Array;
  totalSize: number;
  fileSizes: Map<string, number>;
  fileSha256s: Map<string, string>;
}

export async function precomputeZip(
  files: { path: string; data: Uint8Array }[],
): Promise<PrecomputedZip> {
  const encoder = new TextEncoder();
  const locals: ZipLocalEntry[] = [];
  const centrals: ZipCentralEntry[] = [];
  const fileSizes = new Map<string, number>();
  const fileSha256s = new Map<string, string>();
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const crc = crc32(file.data);
    const size = file.data.length;
    const sha = await sha256HexBytes(file.data);

    fileSizes.set(file.path, size);
    fileSha256s.set(file.path, sha);

    // Local file header (30 + name)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression method (stored)
    lv.setUint16(10, 0, true); // last mod time
    lv.setUint16(12, 0, true); // last mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    locals.push({ nameBytes, header: localHeader, data: file.data, crc, size });

    // Central directory header (46 + name)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression method
    cv.setUint16(12, 0, true); // last mod time
    cv.setUint16(14, 0, true); // last mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); // compressed size
    cv.setUint32(24, size, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // local header offset
    centralHeader.set(nameBytes, 46);

    centrals.push({ header: centralHeader });
    offset += localHeader.length + size;
  }

  // Central directory size
  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const c of centrals) {
    centralDirSize += c.header.length;
  }

  // End of central directory record (22 bytes)
  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir disk
  ev.setUint16(8, files.length, true); // entries on disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralDirSize + 22;

  return { locals, centrals, endRecord, totalSize, fileSizes, fileSha256s };
}

export function streamZip(
  precomputed: PrecomputedZip,
): ReadableStream<Uint8Array> {
  const { locals, centrals, endRecord } = precomputed;
  let phase = 0; // 0=locals, 1=centrals, 2=end, 3=done
  let localIdx = 0;
  let subPhase = 0; // 0=header, 1=data (for locals)
  let centralIdx = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        if (localIdx < locals.length) {
          const entry = locals[localIdx]!;
          if (subPhase === 0) {
            controller.enqueue(entry.header);
            subPhase = 1;
            return;
          }
          controller.enqueue(entry.data);
          subPhase = 0;
          localIdx++;
          return;
        }
        phase = 1;
      }
      if (phase === 1) {
        if (centralIdx < centrals.length) {
          controller.enqueue(centrals[centralIdx]!.header);
          centralIdx++;
          return;
        }
        phase = 2;
      }
      if (phase === 2) {
        controller.enqueue(endRecord);
        phase = 3;
        controller.close();
      }
    },
  });
}
