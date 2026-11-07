#!/usr/bin/env node
/**
 * Reproducible project-local PulseAudio installer for the virtual-capture lane.
 *
 * It only downloads Debian packages into build/virtual-audio and extracts them
 * there. It never runs sudo/apt-get install, loads kernel modules, writes host
 * configuration or starts a system service. The private daemon is launched by
 * tools/virtual-audio/runtime.mjs with its own sockets and runtime directory.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const installRoot = path.join(root, 'build/virtual-audio');
const packageDir = path.join(installRoot, 'packages');
const extractRoot = path.join(installRoot, 'root');
const manifestPath = path.join(installRoot, 'install.json');

// Minimal PulseAudio runtime plus the libraries linked by its executables and
// the null-sink/native-protocol modules used here. ALSA plugins, GStreamer and
// systemd integration are intentionally omitted: this lane only talks to the
// private native-protocol socket and null sinks.
const PACKAGES = [
  'pulseaudio',
  'pulseaudio-utils',
  'libpulse0',
  'libpulsedsp',
  'libsndfile1',
  'libsoxr0',
  'libspeexdsp1',
  'libwebrtc-audio-processing-1-3',
  'libtdb1',
  'liborc-0.4-0t64',
  'libltdl7',
  'libcap2',
  'libdbus-1-3',
  'libsystemd0',
  'libapparmor1',
  'libfftw3-single3',
  'libasyncns0',
  'libopus0',
  'libogg0',
  'libflac14',
  'libmpg123-0t64',
  'libvorbis0a',
  'libvorbisenc2',
  'libmp3lame0',
  'libx11-6',
  'libx11-xcb1',
  'libxcb1',
  'libxtst6',
  'libice6',
  'libsm6',
  'libsnapd-glib-2-1',
  'libabsl20260526',
];

const REQUIRED_EXECUTABLES = ['pulseaudio', 'pactl', 'parec', 'paplay'];

function executable(name) {
  return path.join(extractRoot, 'usr/bin', name);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${(stderr || stdout).trim().slice(-1200)}`));
    });
  });
}

async function moduleDirectory() {
  const libRoot = path.join(extractRoot, 'usr/lib');
  const entries = await fs.readdir(libRoot, { withFileTypes: true }).catch(() => []);
  const modules = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('pulse-'))
    .map((entry) => path.join(libRoot, entry.name, 'modules'))
    .sort()
    .reverse();
  for (const candidate of modules) {
    const stat = await fs.stat(path.join(candidate, 'module-null-sink.so')).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  throw new Error('Private PulseAudio module directory was not found after extraction');
}

async function archLibraryDirectory() {
  const candidates = ['usr/lib/x86_64-linux-gnu', 'usr/lib/aarch64-linux-gnu'];
  for (const candidate of candidates) {
    const stat = await fs.stat(path.join(extractRoot, candidate)).catch(() => null);
    if (stat?.isDirectory()) return path.join(extractRoot, candidate);
  }
  throw new Error('Unsupported host architecture for the private PulseAudio extraction');
}

function libraryPath(moduleDir, archDir) {
  return [path.join(archDir, 'pulseaudio'), archDir, moduleDir].join(':');
}

async function missingLibraries(binary, env) {
  const { stdout } = await run('ldd', [binary], { env }).catch((error) => {
    throw new Error(`Could not inspect ${binary} with ldd: ${error.message}`);
  });
  return stdout
    .split('\n')
    .filter((line) => line.includes('not found'))
    .map((line) => line.trim());
}

async function verifyInstallation() {
  for (const name of REQUIRED_EXECUTABLES) {
    const stat = await fs.stat(executable(name)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Missing private executable ${name}; run npm run setup:virtual-audio`);
  }
  const moduleDir = await moduleDirectory();
  const archDir = await archLibraryDirectory();
  const env = { ...process.env, LD_LIBRARY_PATH: libraryPath(moduleDir, archDir) };
  const failures = [];
  for (const name of REQUIRED_EXECUTABLES) {
    const missing = await missingLibraries(executable(name), env);
    if (missing.length > 0) failures.push(`${name}: ${missing.join(', ')}`);
  }
  for (const moduleName of ['module-null-sink.so', 'module-native-protocol-unix.so']) {
    const missing = await missingLibraries(path.join(moduleDir, moduleName), env);
    if (missing.length > 0) failures.push(`${moduleName}: ${missing.join(', ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`Private PulseAudio extraction has unresolved libraries:\n${failures.join('\n')}`);
  }
  return { moduleDir, archDir };
}

async function downloadPackages() {
  const toolCheck = await run('sh', ['-c', 'command -v apt-get && command -v dpkg-deb']).catch(() => null);
  if (!toolCheck) {
    throw new Error('apt-get and dpkg-deb are required to extract private PulseAudio packages (no sudo is used).');
  }
  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(packageDir, { recursive: true });
  console.log(`[virtual-audio] downloading ${PACKAGES.length} packages with apt-get download`);
  await run('apt-get', ['download', ...PACKAGES], { cwd: packageDir });
}

async function extractPackages() {
  const archives = (await fs.readdir(packageDir))
    .filter((name) => name.endsWith('.deb'))
    .sort();
  if (archives.length === 0) throw new Error('No downloaded .deb archives were found');
  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });
  for (const archive of archives) {
    await run('dpkg-deb', ['--extract', path.join(packageDir, archive), extractRoot]);
  }
  return archives;
}

async function packageManifest(archives) {
  const packages = [];
  for (const archive of archives) {
    const file = path.join(packageDir, archive);
    const { stdout } = await run('dpkg-deb', ['-f', file]);
    const fields = Object.fromEntries(stdout.split('\n')
      .filter((line) => /^[A-Za-z0-9-]+: /.test(line))
      .map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }));
    const name = fields.Package;
    const version = fields.Version;
    const architecture = fields.Architecture;
    const bytes = await fs.readFile(file);
    const sha = createHash('sha256').update(bytes).digest('hex');
    packages.push({ file: archive, name, version, architecture, sha256: sha });
  }
  return packages;
}

async function main() {
  const force = process.argv.includes('--force');
  await fs.mkdir(installRoot, { recursive: true });

  if (!force) {
    try {
      const existing = await verifyInstallation();
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      console.log(`[virtual-audio] verified existing installation at ${extractRoot}`);
      console.log(`[virtual-audio] PulseAudio ${manifest.pulseaudioVersion ?? 'unknown'}; modules ${existing.moduleDir}`);
      return;
    } catch (error) {
      console.log(`[virtual-audio] existing installation is incomplete: ${error.message.split('\n')[0]}`);
    }
  }

  const archives = await fs.readdir(packageDir).then((names) => names.filter((name) => name.endsWith('.deb'))).catch(() => []);
  let downloaded;
  if (force || archives.length < PACKAGES.length) {
    await downloadPackages();
    downloaded = await extractPackages();
  } else {
    console.log('[virtual-audio] reusing downloaded packages; re-extracting to verify');
    await fs.rm(extractRoot, { recursive: true, force: true });
    await fs.mkdir(extractRoot, { recursive: true });
    for (const archive of archives.sort()) {
      await run('dpkg-deb', ['--extract', path.join(packageDir, archive), extractRoot]);
    }
    downloaded = archives.sort();
  }

  let verified;
  try {
    verified = await verifyInstallation();
  } catch (error) {
    await fs.rm(manifestPath, { force: true });
    throw error;
  }
  const packages = await packageManifest(downloaded);
  const pulse = packages.find((entry) => entry.name === 'pulseaudio');
  const manifest = {
    schema: 'codec-abx-private-pulseaudio-v1',
    createdAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    installation: { root: path.relative(root, extractRoot), packages: path.relative(root, packageDir) },
    moduleDirectory: path.relative(root, verified.moduleDir),
    architectureDirectory: path.relative(root, verified.archDir),
    pulseaudioVersion: pulse?.version ?? null,
    packages,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[virtual-audio] installed PulseAudio ${pulse?.version ?? 'unknown'} under ${extractRoot}`);
  console.log(`[virtual-audio] ${packages.length} packages; manifest ${manifestPath}`);
}

await main();
