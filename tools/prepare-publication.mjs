// Prepare local release attachments. This command never creates a tag, pushes,
// uploads, invokes gh, signs artifacts or modifies repository hosting settings.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyMaterialPins } from './collect-third-party-materials.mjs';
import { verifyArch } from './distribution/arch.mjs';
import { verifyDeb, verifyWindowsZip } from './distribution/verify.mjs';
import { manifestFilenames } from './distribution/manifest.mjs';
import { root, verifyVersionConsistency } from './distribution/config.mjs';
import { withLock } from './verification/cache.mjs';

const exec = promisify(execFile);
export async function preparePublication(platform, materials) {
  if (!['linux', 'arch', 'win32'].includes(platform)) throw new Error('Expected linux, arch or win32');
  materials = path.resolve(materials);
  return withLock(path.join(root, 'build/verification.lock'), async () => {
    const status = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root });
    if (status.stdout.trim()) throw new Error('Commit the reviewed source tree before preparing matching publication attachments');
    const { version } = await verifyVersionConsistency();
    await verifyMaterialPins(materials, platform === 'arch' ? 'linux' : platform);
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const directory = path.join(root, 'dist/release');
    await fs.mkdir(directory, { recursive: true });
    const source = path.join(directory, `audivane-${version}-source.tar.gz`);
    const codecs = path.join(directory, `audivane-codec-materials-${version}-${platform}.tar.gz`);
    const excludedSourcePaths = ['AGENTS.md', '.impeccable'];
    await exec('git', ['archive', '--format=tar.gz', `--prefix=audivane-${version}/`, '-o', source, revision, '--', '.',
      ...excludedSourcePaths.map(name => `:(exclude)${name}`)], { cwd: root });
    // tar is a build prerequisite; it is never required by the installed app.
    await exec('tar', ['-czf', codecs, '-C', materials, '.'], { cwd: root });
    const draft = path.join(directory, `Audivane-${version}-release-draft.md`);
    await fs.copyFile(path.join(root, `docs/release-notes-${version}.md`), draft);
    const inventory = await fs.readFile(path.join(materials, 'MANIFEST.json'));
    const release = JSON.parse(await fs.readFile(path.join(directory, manifestFilenames(platform).manifest), 'utf8'));
    if (release.platform !== platform || release.version !== version) throw new Error('Release metadata platform/version mismatch');
    let bound = false;
    for (const artifact of release.artifacts) {
      if (path.basename(artifact.file) !== artifact.file || /[\\/]/.test(artifact.file)) throw new Error('Unsafe release artifact name');
      const filename = path.join(directory, artifact.file);
      const bytes = await fs.readFile(filename);
      if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Release artifact changed before source attachment');
      const report = artifact.file.endsWith('.pkg.tar.zst') ? await verifyArch(filename, { workspaceVersion: version })
        : artifact.file.endsWith('.deb') ? await verifyDeb(filename, { workspaceVersion: version })
        : artifact.file.endsWith('.zip') ? await verifyWindowsZip(filename) : null;
      if (report) {
        if (report.materials.materialManifestSha256 !== createHash('sha256').update(inventory).digest('hex')) throw new Error('Source materials do not match the actual binary artifact');
        bound = true;
      }
    }
    if (!bound) throw new Error('No verified binary artifact binds these source materials');
    const records = [];
    for (const filename of [source, codecs, draft]) {
      const bytes = await fs.readFile(filename);
      records.push({ file: path.basename(filename), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const report = {
      schema: 'audivane-publication-preparation-v1', version, platform, revision, excludedSourcePaths,
      publication: 'not published', artifacts: records,
      materialsManifestSha256: createHash('sha256').update(inventory).digest('hex'),
      remainingGates: ['See docs/distribution-acceptance.md and docs/releasing.md for target OS acceptance, identity, signing and history audit gates'],
    };
    await fs.writeFile(path.join(directory, `publication-${platform}.json`), JSON.stringify(report, null, 2) + '\n');
    await fs.writeFile(path.join(directory, `SHA256SUMS-publication-${platform}.txt`), records.map(record => `${record.sha256}  ${record.file}`).join('\n') + '\n');
    return report;
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, materials] = process.argv.slice(2);
  if (!platform || !materials || process.argv.length !== 4) throw new Error('Usage: node tools/prepare-publication.mjs <linux|arch|win32> <matching-materials-directory>');
  console.log(JSON.stringify(await preparePublication(platform, materials), null, 2));
}
