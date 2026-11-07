import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { compressZipEntries } from './zip-compression.mjs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(epochSeconds = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000))) {
  const date = new Date(epochSeconds * 1000);
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

async function walk(directory, relative = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(directory, child));
    else if (entry.isFile()) files.push(child);
    else if (entry.isSymbolicLink()) throw new Error(`ZIP packaging does not follow symlinks: ${child}`);
    else throw new Error(`Unsupported ZIP entry: ${child}`);
  }
  return files;
}

/**
 * Write a deterministic, UTF-8 ZIP without platform archive utilities. Windows
 * portable builds use this so the same bytes can be produced and inspected on
 * any supported build host.
 */
export async function writeZipFromDirectory(sourceDirectory, outputPath, { prefix = "", jobs, signal } = {}) {
  const normalizedPrefix = prefix === "" ? "" : `${prefix.replace(/[\\/]+$/, "")}/`;
  const files = (await walk(sourceDirectory)).sort();
  const compressed = await compressZipEntries(sourceDirectory, files, { jobs, signal });
  const { time, date } = dosTimestamp();
  const entries = compressed.map((entry, index) => ({
    ...entry, name: Buffer.from(`${normalizedPrefix}${files[index].split(path.sep).join("/")}`, "utf8"),
    method: 8, compressedSize: entry.data.length, time, date,
  }));
  const local = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.time, 10);
    header.writeUInt16LE(entry.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressedSize, 18);
    header.writeUInt32LE(entry.rawSize, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);
    entry.offset = offset;
    local.push(header, entry.name, entry.data);
    offset += header.length + entry.name.length + entry.data.length;
  }
  const central = [];
  const centralOffset = offset;
  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.rawSize, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    header.writeUInt32LE(entry.offset, 42);
    central.push(header, entry.name);
    offset += header.length + entry.name.length;
  }
  const centralSize = offset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const bytes = Buffer.concat([...local, ...central, end]);
  // Compression/read failures leave any previous complete archive untouched.
  signal?.throwIfAborted();
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { signal });
    signal?.throwIfAborted();
    await fs.rename(temporary, outputPath);
  } finally { await fs.rm(temporary, { force: true }); }
  return Object.freeze({
    path: outputPath,
    entries: entries.map(entry => ({ name: entry.name.toString("utf8"), bytes: entry.rawSize, sha256: entry.sha256 })),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function findEndOfCentralDirectory(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end of central directory was not found");
}

/** Read and CRC-check every entry from the actual archive bytes. */
export async function verifyZip(outputPath, { captureMetadata = false } = {}) {
  const bytes = await fs.readFile(outputPath);
  const endOffset = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory bounds disagree");
  const entries = [];
  const contents = {};
  const seenNames = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ZIP central directory entry is malformed");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const rawSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => ["", ".", ".."].includes(part)) || seenNames.has(name.toLowerCase())) throw new Error(`Unsafe or duplicate ZIP path: ${name}`);
    seenNames.add(name.toLowerCase());
    if ((flags & 0x0001) !== 0) throw new Error(`ZIP entry is encrypted: ${name}`);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header is missing: ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const raw = method === 0 ? data : method === 8 ? inflateRawSync(data) : (() => { throw new Error(`Unsupported ZIP compression method ${method}`); })();
    if (raw.length !== rawSize) throw new Error(`ZIP entry size disagrees: ${name}`);
    if (crc32(raw) !== crc) throw new Error(`ZIP entry CRC disagrees: ${name}`);
    if (captureMetadata && /^resources\/.+\.(json|txt|md)$/i.test(name) && raw.length <= 16 * 1024 * 1024) contents[name] = raw;
    entries.push(Object.freeze({ name, bytes: rawSize, sha256: createHash("sha256").update(raw).digest("hex") }));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== endOffset) throw new Error("ZIP central directory size disagrees");
  return Object.freeze({ path: outputPath, entries, contents, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
