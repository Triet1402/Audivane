import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMaterialPins } from '../collect-third-party-materials.mjs';
import { inspectNativeBundle } from '../verification/native-bundle.mjs';
import { root, normalizePlatform } from './config.mjs';

// Prepare the explicit resources input before packaging. Only verified native
// bytes and accompanying notices are copied; source archives remain a separate
// release asset. No executable is discovered via PATH or downloaded here.
export async function prepareMaterials({ bundle, materials, platform }) {
  platform = normalizePlatform(platform);
  bundle = path.resolve(bundle);
  materials = path.resolve(materials);
  await verifyMaterialPins(materials, platform);
  const inspection = await inspectNativeBundle(bundle, { platform });
  if (!inspection.ldacHelperIncluded) throw new Error('Distribution materials require all eleven codecs including LDAC');
  for (const [component, name] of [['ffmpeg', 'ffmpeg-VERSION.txt'], ['ldac', 'ldac-VERSION.txt']]) {
    const supplied = await fs.readFile(path.join(bundle, 'third_party', component, 'VERSION.txt'));
    const recorded = await fs.readFile(path.join(materials, 'provenance', name));
    if (!supplied.equals(recorded)) throw new Error(`Materials provenance does not match the exact ${component} bundle`);
  }
  const destination = path.join(root, 'build/distribution-resources', platform);
  const relative = path.relative(destination, bundle);
  if (relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Native input must be outside the generated resources directory');
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  // Copy only the inspected codec trees. The validator will hash all copied
  // files again at packaging, including these notices and provenance bytes.
  for (const component of ['ffmpeg', 'ldac']) {
    await fs.cp(path.join(bundle, 'third_party', component), path.join(destination, 'third_party', component), { recursive: true });
  }
  const notices = path.join(destination, 'notices');
  await fs.mkdir(notices);
  for (const directory of ['licenses', 'application', 'provenance']) {
    await fs.cp(path.join(materials, directory), path.join(notices, directory), { recursive: true });
  }
  for (const file of ['NOTICES.md', 'SOURCE-OFFER.md', 'MANIFEST.json']) {
    await fs.copyFile(path.join(materials, file), path.join(notices, file));
  }
  await fs.writeFile(path.join(notices, 'MATERIALS-SCOPE.txt'),
    'The accompanying source/build archive contains the complete material inventory.\n' +
    'MANIFEST.json describes that full archive; source/build files are shipped beside the installer, not duplicated here.\n');
  const manifest = await fs.readFile(path.join(materials, 'MANIFEST.json'));
  await fs.writeFile(path.join(destination, 'distribution-materials.json'), JSON.stringify({
    schema: 'audivane-distribution-materials-v1', platform,
    materialsManifestSha256: createHash('sha256').update(manifest).digest('hex'),
    nativeFiles: inspection.files,
    correspondingSource: 'Accompanying audivane-codec-materials archive; see notices/SOURCE-OFFER.md',
  }, null, 2) + '\n');
  await inspectNativeBundle(destination, { platform });
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, bundle, materials] = process.argv.slice(2);
  if (!platform || !bundle || !materials || process.argv.length !== 5) {
    throw new Error('Usage: node tools/distribution/prepare-materials.mjs <linux|win32> <native-bundle> <materials>');
  }
  console.log(await prepareMaterials({ platform, bundle, materials }));
}
