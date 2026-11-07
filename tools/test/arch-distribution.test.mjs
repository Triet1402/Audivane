import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARCH_DEPENDENCIES, archFilename, archPkgbuild, archVersion, parsePkginfo, prepareArch, verifyArch } from '../distribution/arch.mjs';
import { readRootManifest } from '../distribution/config.mjs';
import { parseReleaseArguments } from '../distribution/release.mjs';
import { fixtureMaterials } from './fixtures/distribution-materials.mjs';

test('Arch recipe pins local payload, preserves codec hashes and has a prerelease version', () => {
  assert.equal(archVersion('0.1.0-beta.1'), '0.1.0beta.1');
  assert.equal(archFilename('0.1.0-beta.1'), 'audivane-bin-0.1.0beta.1-1-x86_64.pkg.tar.zst');
  assert.throws(() => archVersion('1.0/../../bad'), /version/);
  const recipe = archPkgbuild({ version: '0.1.0-beta.1', payload: 'payload.tar.zst', sha256: 'a'.repeat(64) });
  assert.match(recipe, /options=\('!strip' '!debug'\)/);
  assert.match(recipe, /arch=\('x86_64'\)/);
  assert.match(recipe, /sha256sums=\('[a-f0-9]{64}'\)/);
  assert.doesNotMatch(recipe, /SKIP|sudo|--no-sandbox|apparmor|https?:\/\//);
  assert.throws(() => archPkgbuild({ version: '0.1.0', payload: '../escape', sha256: 'a'.repeat(64) }), /Unsafe/);
  assert.throws(() => archPkgbuild({ version: '0.1.0', payload: '$(bad)', sha256: 'a'.repeat(64) }), /Unsafe/);
  assert.equal(parseReleaseArguments(['arch', '--prepare-only']).prepareOnly, true);
  assert.equal(parseReleaseArguments(['verify', '--platform', 'arch']).platform, 'arch');
  assert.deepEqual(parsePkginfo('pkgname = audivane-bin\ndepend = gtk3\ndepend = nss\n').get('depend'), ['gtk3', 'nss']);
});

test('actual Arch archive verifies independent metadata, rejects scripts, links and altered native bytes', async t => {
  for (const command of ['tar', 'zstd', 'cc', 'readelf']) {
    try { execFileSync(command, ['--version'], { stdio: 'ignore' }); }
    catch { t.skip(`${command} required for Linux archive fixtures`); return; }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-arch-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packaged = path.join(directory, 'packaged');
  await fs.mkdir(path.join(packaged, 'resources'), { recursive: true });
  await fs.writeFile(path.join(directory, 'fixture.c'), 'int main(void){return 0;}\n');
  execFileSync('cc', ['-O2', '-o', path.join(directory, 'elf'), path.join(directory, 'fixture.c')]);
  const binary = await fs.readFile(path.join(directory, 'elf'));
  for (const relative of ['codec-abx', 'chrome-sandbox', 'resources/third_party/ffmpeg/bin/ffmpeg', 'resources/third_party/ffmpeg/bin/ffprobe', 'resources/third_party/ldac/bin/ldac_helper']) {
    const file = path.join(packaged, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, binary, { mode: 0o755 });
  }
  await fs.mkdir(path.join(packaged, 'resources/app'), { recursive: true });
  await fs.writeFile(path.join(packaged, 'resources/app/main.cjs'), 'current app');
  await fs.chmod(packaged, 0o700);
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) await fs.writeFile(path.join(packaged, name), 'TEST ONLY');
  const { version } = await readRootManifest();
  await fs.writeFile(path.join(packaged, 'resources/distribution.json'), JSON.stringify({ version, platform: 'linux', browserCodecAssets: 'excluded-native-only', nativeBundle: { ldacHelperIncluded: true } }));
  await fs.writeFile(path.join(packaged, 'resources/native-bundle-manifest.json'), '{}');
  await fixtureMaterials(packaged, 'linux');
  const prepared = await prepareArch({ packagedDirectory: packaged, directory: path.join(directory, 'recipe') });
  assert.equal(prepared.sha256, createHash('sha256').update(await fs.readFile(path.join(prepared.directory, prepared.payload))).digest('hex'));
  const payload = path.join(prepared.directory, 'tree/payload');
  assert.equal((await fs.stat(path.join(payload, 'opt/audivane'))).mode & 0o777, 0o755);
  // Independent pacman metadata fixture. The real makepkg output is separately
  // exercised in an Arch VM; no generated metadata is treated as authority.
  await fs.writeFile(path.join(payload, '.PKGINFO'), ['pkgname = audivane-bin', `pkgver = ${archVersion(version)}-1`, 'arch = x86_64', 'provides = audivane', 'conflict = audivane', ...ARCH_DEPENDENCIES.map(value => `depend = ${value}`)].join('\n')+'\n');
  await fs.writeFile(path.join(payload, '.BUILDINFO'), 'format = 2\n');
  await fs.writeFile(path.join(payload, '.MTREE'), 'TEST ONLY');
  const archive = path.join(directory, prepared.filename);
  const pack = () => execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '--zstd', '-cf', archive, '-C', payload, '.PKGINFO', '.BUILDINFO', '.MTREE', 'opt', 'usr']);
  pack();
  assert.equal((await verifyArch(archive, { expectedApplicationDirectory: packaged })).format, 'arch-pacman');
  await fs.writeFile(path.join(payload, 'opt/audivane/resources/app/main.cjs'), 'stale app'); pack();
  await assert.rejects(verifyArch(archive, { expectedApplicationDirectory: packaged }), /application bytes differ/);
  await fs.writeFile(path.join(payload, 'opt/audivane/resources/app/main.cjs'), 'current app'); pack();
  await fs.appendFile(path.join(payload, 'opt/audivane/resources/third_party/ffmpeg/bin/ffmpeg'), 'tampered'); pack();
  await assert.rejects(verifyArch(archive), /Native resource hash mismatch/);
  await fs.writeFile(path.join(payload, 'opt/audivane/resources/third_party/ffmpeg/bin/ffmpeg'), binary);
  await fs.symlink('/tmp/escape', path.join(payload, 'opt/audivane/escape')); pack();
  await assert.rejects(verifyArch(archive), /Unexpected Arch link/);
  await fs.unlink(path.join(payload, 'opt/audivane/escape'));
  await fs.writeFile(path.join(payload, '.INSTALL'), 'exit 0\n');
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '--zstd', '-cf', archive, '-C', payload, '.PKGINFO', '.BUILDINFO', '.MTREE', '.INSTALL', 'opt', 'usr']);
  await assert.rejects(verifyArch(archive), /Unsafe or duplicate Arch archive path/);
});
