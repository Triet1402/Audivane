import { packageJobs } from './jobs.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { auditGlibcFloor, normalizeLinuxTree } from './deb.mjs';
import { PRODUCT, readRootManifest, releaseDirectory, root, unpackedDirectory } from './config.mjs';
import { verifyMaterialsDirectory } from './materials-contract.mjs';

const exec = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const ARCH_DEPENDENCIES = Object.freeze([
  'glibc>=2.39', 'gcc-libs', 'gtk3', 'nss', 'alsa-lib', 'at-spi2-core',
  'libcups', 'mesa', 'libdrm', 'libxkbcommon', 'libxcomposite', 'libxdamage',
  'libxrandr', 'libx11', 'libxcb', 'libxfixes', 'libxext', 'pango', 'cairo',
  'dbus', 'expat', 'hicolor-icon-theme', 'xdg-utils',
]);

export function archVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('Unsupported Arch version');
  // Pacman pkgver disallows hyphens. Alphabetic beta sorts before final.
  return version.replace('-', '');
}
export function archFilename(version) {
  return `audivane-bin-${archVersion(version)}-1-x86_64.pkg.tar.zst`;
}

export function archPkgbuild({ version, payload, sha256 }) {
  if (payload !== path.basename(payload) || !/^[A-Za-z0-9._-]+$/.test(payload) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Unsafe Arch source input');
  return `# Generated local binary recipe; no release URL or AUR submission is implied.
# Source is the exact staged Electron/native/license payload, verified below.
pkgname=audivane-bin
pkgver=${archVersion(version)}
pkgrel=1
pkgdesc='Blind audio comparisons with native codecs'
arch=('x86_64')
license=('MIT' 'LicenseRef-Audivane-Bundled-Third-Party')
depends=(${ARCH_DEPENDENCIES.map(value => `'${value}'`).join(' ')})
optdepends=('libpulse: PulseAudio or PipeWire-Pulse output' 'xdg-desktop-portal: desktop portal integration')
provides=('audivane')
conflicts=('audivane')
# Stripping would invalidate the native executable provenance hashes.
options=('!strip' '!debug')
source=('${payload}')
sha256sums=('${sha256}')

package() {
  cp -a "\$srcdir/payload/." "\$pkgdir/"
}
`;
}

/** Stage a pacman-native layout directly from the Linux Electron package.
 * No .deb conversion, Debian dependency names, AppArmor policy or maintainer
 * scripts. Arch's desktop/icon cache hooks handle registration and removal.
 */
export async function prepareArch(options = {}) {
  const packaged = path.resolve(options.packagedDirectory ?? unpackedDirectory('linux'));
  const workspace = await readRootManifest();
  const distribution = JSON.parse(await fs.readFile(path.join(packaged, 'resources/distribution.json'), 'utf8'));
  if (distribution.platform !== 'linux' || distribution.version !== workspace.version || distribution.nativeBundle?.ldacHelperIncluded !== true) throw new Error('Arch requires the matching complete Linux native package');
  await verifyMaterialsDirectory(path.join(packaged, 'resources'), 'linux');
  const glibc = await auditGlibcFloor(packaged);
  const directory = path.resolve(options.directory ?? path.join(root, 'build/arch/recipe'));
  await fs.mkdir(directory, { recursive: true });
  const tree = path.join(directory, 'tree');
  await fs.rm(tree, { recursive: true, force: true });
  const payloadRoot = path.join(tree, 'payload');
  const app = path.join(payloadRoot, 'opt/audivane');
  await fs.mkdir(path.dirname(app), { recursive: true });
  await fs.cp(packaged, app, { recursive: true, dereference: false });
  await fs.rename(path.join(app, 'codec-abx'), path.join(app, 'audivane'));
  distribution.executable = 'audivane';
  distribution.executableRenamedFrom = 'codec-abx';
  distribution.packageFormat = 'arch-pacman';
  await fs.writeFile(path.join(app, 'resources/distribution.json'), JSON.stringify(distribution, null, 2) + '\n');
  const write = async (relative, bytes) => {
    const filename = path.join(payloadRoot, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
  };
  await fs.mkdir(path.join(payloadRoot, 'usr/bin'), { recursive: true });
  await fs.symlink('/opt/audivane/audivane', path.join(payloadRoot, 'usr/bin/audivane'));
  await write('usr/share/applications/audivane.desktop', `[Desktop Entry]
Type=Application
Name=${PRODUCT.name}
GenericName=Audio codec comparison
Comment=${PRODUCT.subtitle}
Exec=/opt/audivane/audivane
Icon=audivane
Terminal=false
Categories=AudioVideo;Audio;Utility;
Keywords=audio;codec;ABX;blind;listening;
StartupNotify=true
StartupWMClass=audivane
`);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    await write(`usr/share/icons/hicolor/${size}x${size}/apps/audivane.png`, await fs.readFile(path.join(root, `assets/brand/icons/audivane-${size}.png`)));
  }
  await write('usr/share/icons/hicolor/scalable/apps/audivane.svg', await fs.readFile(path.join(root, 'assets/brand/audivane-mark.svg')));
  const licenses = path.join(payloadRoot, 'usr/share/licenses/audivane-bin');
  await fs.mkdir(licenses, { recursive: true });
  for (const filename of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(root, filename), path.join(licenses, filename));
  for (const filename of ['LICENSE', 'LICENSES.chromium.html']) await fs.copyFile(path.join(packaged, filename), path.join(licenses, `Electron-${filename}`));
  await fs.copyFile(path.join(root, 'packages/measurements/NOTICE.md'), path.join(licenses, 'measurements-NOTICE.md'));
  await fs.cp(path.join(app, 'resources/notices/licenses'), path.join(licenses, 'components'), { recursive: true });
  await write('usr/share/doc/audivane/README.md', await fs.readFile(path.join(root, 'README.md')));
  await normalizeLinuxTree(tree);
  const payload = `audivane-${workspace.version}-linux-x64-payload.tar.zst`;
  const epoch = process.env.SOURCE_DATE_EPOCH ?? String(Math.floor(Date.now() / 1000));
  if (!/^\d+$/.test(epoch)) throw new Error('Invalid SOURCE_DATE_EPOCH');
  await exec('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-I', `zstd -T${packageJobs(options.jobs)} -6`, '-cf', path.join(directory, payload), '-C', tree, 'payload'], { maxBuffer: 1024 * 1024 });
  const sha256 = digest(await fs.readFile(path.join(directory, payload)));
  await fs.writeFile(path.join(directory, 'PKGBUILD'), archPkgbuild({ version: workspace.version, payload, sha256 }));
  await exec('bash', ['-n', path.join(directory, 'PKGBUILD')]);
  return { directory, payload, sha256, filename: archFilename(workspace.version), version: workspace.version, glibc, nativeBundle: distribution.nativeBundle };
}

export function parsePkginfo(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*) = (.*)$/.exec(line);
    if (!match) throw new Error('Malformed Arch package metadata');
    result.set(match[1], [...(result.get(match[1]) ?? []), match[2]]);
  }
  return result;
}

export async function buildArch(prepared, options = {}) {
  const directory = path.resolve(options.outputDirectory ?? releaseDirectory());
  await fs.mkdir(directory, { recursive: true });
  // makepkg refuses root. Use a normal Arch user (or explicit MAKEPKG wrapper),
  // and never install build dependencies or invoke sudo implicitly.
  await exec(process.env.MAKEPKG || 'makepkg', ['--force', '--noconfirm'], {
    cwd: prepared.directory, env: { ...process.env, PKGDEST: directory, PACKAGER: 'Audivane local build' }, maxBuffer: 8 * 1024 * 1024,
  });
  const filename = path.join(directory, prepared.filename);
  await verifyArch(filename, { workspaceVersion: prepared.version });
  return filename;
}

// normalizeLinuxTree makes directory/file modes 0755/0644 while preserving
// executable bits. Compare names, types, link targets, bytes and executability
// rather than the builder's incidental group-write bits before normalization.
async function applicationFingerprint(directory) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const filename = path.join(directory, relative);
    const stat = await fs.lstat(filename);
    hash.update(relative + '\0');
    if (stat.isDirectory()) {
      hash.update('directory\0');
      for (const entry of (await fs.readdir(filename)).sort()) await visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      hash.update(`file:${stat.size}:${Boolean(stat.mode & 0o111)}\0`);
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      hash.update('\0');
    } else if (stat.isSymbolicLink()) hash.update(`link:${await fs.readlink(filename)}\0`);
    else throw new Error('Unexpected application entry type');
  }
  await visit('resources/app');
  return hash.digest('hex');
}

/** Validate archive paths/types before extracting, then verify actual resource
 * bindings. Only the fixed command symlink is permitted; no installer scripts.
 */
export async function verifyArch(filename, { workspaceVersion, expectedApplicationDirectory } = {}) {
  workspaceVersion ??= (await readRootManifest()).version;
  const { stdout: listing } = await exec('tar', ['-tf', filename], { maxBuffer: 8 * 1024 * 1024 });
  const names = listing.trim().split('\n');
  const seen = new Set();
  for (const name of names) {
    const clean = name.replace(/\/$/, '');
    if (!/^(?:\.(?:PKGINFO|BUILDINFO|MTREE)|(?:opt|usr)(?:\/[A-Za-z0-9_@.+/-]+)?)$/.test(clean) || clean.split('/').some(part => ['', '.', '..'].includes(part)) || clean.startsWith('usr/bin/audivane/') || seen.has(clean)) throw new Error(`Unsafe or duplicate Arch archive path: ${name}`);
    seen.add(clean);
  }
  for (const required of ['.PKGINFO', '.BUILDINFO', '.MTREE', 'opt/audivane/audivane', 'usr/bin/audivane']) if (!seen.has(required)) throw new Error(`Missing Arch package entry: ${required}`);
  const { stdout: verbose } = await exec('tar', ['--numeric-owner', '-tvf', filename], { maxBuffer: 8 * 1024 * 1024 });
  for (const line of verbose.trim().split('\n')) {
    if (!/^[-dl]/.test(line) || (line.startsWith('l') && !/ usr\/bin\/audivane -> \/opt\/audivane\/audivane$/.test(line))) throw new Error('Unexpected Arch link or special file');
    if (!/^.[rwx-]{9} 0\/0\s/.test(line) || /^...[sS]|^......[sS]/.test(line)) throw new Error('Unsafe Arch ownership or setid permissions');
  }
  const metadata = parsePkginfo((await exec('tar', ['-xOf', filename, '.PKGINFO'], { maxBuffer: 1024 * 1024 })).stdout);
  for (const [key, value] of [['pkgname', 'audivane-bin'], ['pkgver', `${archVersion(workspaceVersion)}-1`], ['arch', 'x86_64']]) {
    if (metadata.get(key)?.length !== 1 || metadata.get(key)[0] !== value) throw new Error(`Arch ${key} mismatch`);
  }
  for (const dependency of ARCH_DEPENDENCIES) if (!metadata.get('depend')?.includes(dependency)) throw new Error(`Missing Arch dependency: ${dependency}`);
  if (!metadata.get('provides')?.includes('audivane') || !metadata.get('conflict')?.includes('audivane')) throw new Error('Missing Arch provides/conflicts');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audivane-arch-verify-'));
  try {
    await exec('tar', ['--no-same-owner', '-xf', filename, '-C', directory], { maxBuffer: 1024 * 1024 });
    const app = path.join(directory, 'opt/audivane');
    if (((await fs.stat(app)).mode & 0o777) !== 0o755 || ((await fs.stat(path.join(app, 'audivane'))).mode & 0o777) !== 0o755) throw new Error('Arch executable/root permissions must be 0755');
    const distribution = JSON.parse(await fs.readFile(path.join(app, 'resources/distribution.json'), 'utf8'));
    if (distribution.version !== workspaceVersion || distribution.executable !== 'audivane' || distribution.packageFormat !== 'arch-pacman' || distribution.browserCodecAssets !== 'excluded-native-only') throw new Error('Wrong Arch desktop metadata');
    if (expectedApplicationDirectory &&
        await applicationFingerprint(app) !==
        await applicationFingerprint(expectedApplicationDirectory)) {
      throw new Error('Arch application bytes differ from the captured release package');
    }
    const materials = await verifyMaterialsDirectory(path.join(app, 'resources'), 'linux');
    for (const entry of await fs.readdir(path.join(app, 'resources'), { recursive: true })) if (/(?:codec-assets\/|ffmpeg-core\.(?:js|wasm)$|lc3_codec\.(?:js|wasm)$|ldac_codec\.(?:js|wasm)$|\.py$)/.test(entry)) throw new Error(`Forbidden Arch runtime file: ${entry}`);
    const desktop = await fs.readFile(path.join(directory, 'usr/share/applications/audivane.desktop'), 'utf8');
    if (!/^Exec=\/opt\/audivane\/audivane$/m.test(desktop) || !/^StartupWMClass=audivane$/m.test(desktop) || /--no-sandbox/.test(desktop)) throw new Error('Unsafe Arch desktop launcher');
    for (const relative of ['usr/share/licenses/audivane-bin/LICENSE', 'usr/share/licenses/audivane-bin/THIRD_PARTY_NOTICES.md', 'usr/share/licenses/audivane-bin/Electron-LICENSES.chromium.html', 'usr/share/icons/hicolor/256x256/apps/audivane.png', 'usr/share/icons/hicolor/scalable/apps/audivane.svg']) await fs.access(path.join(directory, relative));
    const glibc = await auditGlibcFloor(app);
    return { path: filename, format: 'arch-pacman', packageVersion: metadata.get('pkgver')[0], files: seen.size, materials, glibc, nativeBundle: distribution.nativeBundle };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
