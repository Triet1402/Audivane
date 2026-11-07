import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEC_IDS } from '@codec-abx/contracts';
import {
  NativeCodecExecutor,
  resolveNativeBinaries,
} from '@codec-abx/engine-native/typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = Object.freeze({
  ffmpegPath: path.join(root, 'third_party/ffmpeg/bin/ffmpeg'),
  ffprobePath: path.join(root, 'third_party/ffmpeg/bin/ffprobe'),
  ldacHelperPath: path.join(root, 'third_party/ldac/bin/ldac_helper'),
});
const resolved = resolveNativeBinaries({ repositoryRoot: root });
const reasons = Object.freeze({
  ffmpegPath: resolved.ffmpegReason,
  ffprobePath: resolved.ffprobeReason,
  ldacHelperPath: resolved.ldacHelperReason,
});
for (const [name, expectedPath] of Object.entries(expected)) {
  assert.ok(existsSync(expectedPath), `production prerequisite missing: ${expectedPath}`);
  assert.equal(
    resolved[name],
    expectedPath,
    `production lane requires the vendored ${name}; got ${String(resolved[name])} (${String(reasons[name])})`,
  );
}

const filters = execFileSync(resolved.ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' });
assert.match(filters, /\bebur128\b/, 'production FFmpeg build must provide the independent ebur128 filter');

const executor = new NativeCodecExecutor({ repositoryRoot: root });
try {
  const capabilities = await executor.capabilities();
  assert.match(capabilities.ffmpegVersion ?? '', /ffmpeg version/i);
  assert.match(capabilities.ffprobeVersion ?? '', /ffprobe version/i);
  assert.match(capabilities.ldacHelperVersion ?? '', /\S/);
  assert.equal(capabilities.codecs.length, CODEC_IDS.length,
    'native capability probe must report every catalog codec');
  const missing = capabilities.codecs
    .filter(codec => codec.availability !== 'available')
    .map(codec => `${codec.codecId}: ${codec.reason ?? 'unavailable'}`);
  assert.deepEqual(missing, [], `production native codec prerequisites are incomplete:\n${missing.join('\n')}`);
  console.log(`[production] native prerequisites: ${resolved.ffmpegPath}; ${resolved.ffprobePath}; ${resolved.ldacHelperPath}`);
  console.log(`[production] all ${String(CODEC_IDS.length)} catalog codecs available; independent FFmpeg ebur128 filter present`);
} finally {
  await executor.dispose();
}
