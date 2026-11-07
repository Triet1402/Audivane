import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function fixtureMaterials(packaged, platform) {
  const { createHash } = await import('node:crypto');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const resources = path.join(packaged, 'resources');
  const inventory = JSON.parse(await fs.readFile(new URL('../../../third_party/release-materials.json', import.meta.url), 'utf8'));
  const components = inventory.components.filter(item => !item.platforms || item.platforms.includes(platform));
  const records = [];
  for (const component of components) for (const license of component.licenseFiles) {
    const relative = `licenses/${component.id}/${license}`;
    const bytes = Buffer.from('TEST ONLY license metadata fixture');
    await fs.mkdir(path.dirname(path.join(resources, 'notices', relative)), { recursive: true });
    await fs.writeFile(path.join(resources, 'notices', relative), bytes);
    records.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  }
  const materialBytes = Buffer.from(JSON.stringify({ schema: 'audivane-third-party-materials-v1', platform,
    files: records, sourcePins: components.map(item => ({ id: item.id, ...item.archive })) }));
  await fs.writeFile(path.join(resources, 'notices/MANIFEST.json'), materialBytes);
  for (const file of ['SOURCE-OFFER.md', 'NOTICES.md', 'MATERIALS-SCOPE.txt']) await fs.writeFile(path.join(resources, 'notices', file), 'TEST ONLY');
  const nativeFiles = [];
  for (const relative of ['third_party/ffmpeg/bin/ffmpeg', 'third_party/ffmpeg/bin/ffprobe', 'third_party/ldac/bin/ldac_helper']) {
    const actual = platform === 'win32' ? relative + '.exe' : relative;
    const bytes = await fs.readFile(path.join(resources, actual));
    nativeFiles.push({ path: actual, sha256: digest(bytes), bytes: bytes.length });
  }
  const native = JSON.parse(await fs.readFile(path.join(resources, 'native-bundle-manifest.json'), 'utf8'));
  native.files = nativeFiles;
  native.platform = platform;
  native.mode = 'portable-native-bundle-v1';
  native.schema = 'codec-abx-native-bundle-manifest-v1';
  native.ldacHelperIncluded = true;
  const nativeBytes = Buffer.from(JSON.stringify(native));
  await fs.writeFile(path.join(resources, 'native-bundle-manifest.json'), nativeBytes);
  const distribution = JSON.parse(await fs.readFile(path.join(resources, 'distribution.json'), 'utf8'));
  distribution.nativeBundle ??= {};
  distribution.nativeBundle.manifestSha256 = digest(nativeBytes);
  await fs.writeFile(path.join(resources, 'distribution.json'), JSON.stringify(distribution));
  await fs.writeFile(path.join(resources, 'distribution-materials.json'), JSON.stringify({ platform, nativeFiles,
    materialsManifestSha256: digest(materialBytes) }));
}
