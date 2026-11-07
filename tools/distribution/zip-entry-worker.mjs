import { parentPort } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';

parentPort.on('message', async ({ index, filename }) => {
  try {
    const stat = await fs.stat(filename);
    const raw = await fs.readFile(filename);
    const compressed = deflateRawSync(raw, { level: 9 });
    // Own the transferable buffer; zlib can return a slice of a larger slab.
    const data = Uint8Array.from(compressed);
    parentPort.postMessage({ index, rawSize: raw.length, crc: crc32(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
      mode: (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644, data }, [data.buffer]);
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});
