import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { root } from './config.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function safe(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('Unsafe manifest resource path');
  return relative;
}

/** read(relative) returns actual bytes; hashes maps all resource files to their
 * actual digests (an extracted .deb or CRC-verified ZIP). No source is inferred
 * from a self-consistent but unbound license inventory.
 */
export async function verifyResourceMaterials({ platform, read, hashes }) {
  const distribution = JSON.parse(await read('distribution.json'));
  const nativeBytes = await read('native-bundle-manifest.json');
  const native = JSON.parse(nativeBytes);
  if (native.schema !== 'codec-abx-native-bundle-manifest-v1' || native.mode !== 'portable-native-bundle-v1' || distribution.platform !== platform || native.platform !== platform || native.ldacHelperIncluded !== true || !native.files?.length) throw new Error('Incomplete or wrong-platform native distribution manifest');
  for (const name of ['ffmpeg/bin/ffmpeg', 'ffmpeg/bin/ffprobe', 'ldac/bin/ldac_helper']) {
    const expected = `third_party/${name}${platform === 'win32' ? '.exe' : ''}`;
    if (!native.files.some(file => file.path === expected)) throw new Error(`Native manifest omits codec executable ${expected}`);
  }
  if (distribution.nativeBundle?.manifestSha256 !== digest(nativeBytes)) throw new Error('Native manifest hash is not bound to distribution metadata');
  const binding = JSON.parse(await read('distribution-materials.json'));
  const materialBytes = await read('notices/MANIFEST.json');
  const materials = JSON.parse(materialBytes);
  if (!binding.nativeFiles?.length || materials.schema !== 'audivane-third-party-materials-v1') throw new Error('Incomplete materials binding');
  if (binding.platform !== platform || materials.platform !== platform) throw new Error('Materials platform does not match artifact');
  if (binding.materialsManifestSha256 !== digest(materialBytes)) throw new Error('Materials manifest hash is not bound to distribution metadata');
  for (const required of ['notices/SOURCE-OFFER.md', 'notices/NOTICES.md', 'notices/MATERIALS-SCOPE.txt']) {
    if (!(await read(required)).length) throw new Error(`Missing distribution materials: ${required}`);
  }
  for (const file of native.files) {
    if (hashes.get(safe(file.path)) !== file.sha256) throw new Error(`Native resource hash mismatch: ${file.path}`);
  }
  for (const file of binding.nativeFiles ?? []) {
    if (hashes.get(safe(file.path)) !== file.sha256) throw new Error(`Materials describe a different native artifact: ${file.path}`);
  }
  const inventory = JSON.parse(await fs.readFile(path.join(root, 'third_party/release-materials.json'), 'utf8'));
  for (const component of inventory.components.filter(item => !item.platforms || item.platforms.includes(platform))) {
    const pin = materials.sourcePins?.find(item => item.id === component.id);
    if (!pin || pin.filename !== component.archive.filename || pin.sha256 !== component.archive.sha256 || pin.contentSha256 !== component.archive.contentSha256) throw new Error(`Materials source pin mismatch: ${component.id}`);
    for (const license of component.licenseFiles) {
      const relative = `licenses/${component.id}/${license}`;
      const record = materials.files.find(file => file.path === relative);
      if (!record || hashes.get(`notices/${relative}`) !== record.sha256) throw new Error(`Missing or altered component license: ${relative}`);
    }
  }
  return { materialManifestSha256: digest(materialBytes), nativeManifestSha256: digest(nativeBytes) };
}

export async function verifyMaterialsDirectory(resources, platform) {
  const hashes = new Map();
  for (const relative of await fs.readdir(resources, { recursive: true })) {
    const filename = path.join(resources, relative);
    const stat = await fs.lstat(filename);
    if (stat.isFile()) hashes.set(relative.split(path.sep).join('/'), digest(await fs.readFile(filename)));
    else if (!stat.isDirectory()) throw new Error(`Unsafe packaged resource entry: ${relative}`);
  }
  return verifyResourceMaterials({ platform, hashes, read: relative => fs.readFile(path.join(resources, safe(relative))) });
}
