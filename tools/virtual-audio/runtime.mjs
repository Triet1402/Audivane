/**
 * Private, user-mode PulseAudio server for digital output capture.
 *
 * The server binds only a private Unix socket, owns two null sinks, and is
 * selected exclusively through child environment variables. It never changes
 * the host default, opens a TCP listener or loads a kernel module.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const installRoot = path.join(workspaceRoot, 'build/virtual-audio');
const extractRoot = path.join(installRoot, 'root');
const manifestPath = path.join(installRoot, 'install.json');

export const SINK_A = 'codec_capture_a';
export const SINK_B = 'codec_capture_b';
export const SOURCE_A = `${SINK_A}.monitor`;
export const SOURCE_B = `${SINK_B}.monitor`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited ${code}: ${(stderr || stdout).trim().slice(-800)}`));
    });
  });
}

async function findLayout() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => 'null'));
  if (!manifest) throw new Error('Private PulseAudio is not installed. Run: npm run setup:virtual-audio');
  const moduleDir = path.resolve(workspaceRoot, manifest.moduleDirectory);
  const archDir = path.resolve(workspaceRoot, manifest.architectureDirectory);
  const bin = path.join(extractRoot, 'usr/bin');
  for (const name of ['pulseaudio', 'pactl', 'parec', 'paplay']) {
    const stat = await fs.stat(path.join(bin, name)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Private ${name} is missing. Run: npm run setup:virtual-audio -- --force`);
  }
  for (const module of ['module-null-sink.so', 'module-native-protocol-unix.so']) {
    const stat = await fs.stat(path.join(moduleDir, module)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Private ${module} is missing. Run: npm run setup:virtual-audio -- --force`);
  }
  return { manifest, moduleDir, archDir, bin };
}

function childLibraryPath(layout) {
  return [path.join(layout.archDir, 'pulseaudio'), layout.archDir, layout.moduleDir].join(':');
}

export async function assertVirtualAudioInstalled() {
  return await findLayout();
}

/**
 * Start the private daemon. `reportDirectory` must be an owned, unique test
 * session; runtime sockets live below it and are removed on stop.
 */
export async function startPrivatePulse({ reportDirectory }) {
  const layout = await findLayout();
  const runtimeRoot = path.join(reportDirectory, 'pulse-runtime');
  const privateConfigRoot = path.join(runtimeRoot, 'config');
  const runtime = path.join(runtimeRoot, 'runtime');
  const socket = path.join(runtime, 'native.sock');
  const configPath = path.join(runtimeRoot, 'daemon.pa');
  const logPath = path.join(reportDirectory, 'pulse.log');
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(privateConfigRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeRoot, 0o700);
  await fs.chmod(privateConfigRoot, 0o700);
  await fs.chmod(runtime, 0o700);
  const config = [
    '.fail',
    `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1`,
    `load-module module-null-sink sink_name=${SINK_A} sink_properties=device.description=codec_abx_virtual_capture_a rate=48000 channels=2`,
    `load-module module-null-sink sink_name=${SINK_B} sink_properties=device.description=codec_abx_virtual_capture_b rate=48000 channels=2`,
    `set-default-sink ${SINK_A}`,
    '',
  ].join('\n');
  await fs.writeFile(configPath, config, { mode: 0o600 });

  const daemonEnv = {
    PATH: `${layout.bin}:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: privateConfigRoot,
    PULSE_CONFIG_PATH: privateConfigRoot,
    PULSE_STATE_PATH: path.join(runtimeRoot, 'state'),
    XDG_RUNTIME_DIR: runtime,
    PULSE_RUNTIME_PATH: runtime,
    LD_LIBRARY_PATH: childLibraryPath(layout),
    LANG: 'C.UTF-8',
  };
  const logHandle = await fs.open(logPath, 'w', 0o600);
  const daemon = spawn(
    path.join(layout.bin, 'pulseaudio'),
    [
      '-n',
      '--daemonize=no',
      `--file=${configPath}`,
      '--exit-idle-time=-1',
      '--log-target=stderr',
      '--log-level=info',
      `--dl-search-path=${layout.moduleDir}`,
    ],
    { env: daemonEnv, stdio: ['ignore', logHandle.fd, logHandle.fd] },
  );
  await logHandle.close();
  let exit = null;
  daemon.once('exit', (code, signal) => { exit = { code, signal }; });

  const clientEnv = {
    ...process.env,
    PULSE_SERVER: `unix:${socket}`,
    PULSE_RUNTIME_PATH: runtime,
    LD_LIBRARY_PATH: childLibraryPath(layout),
  };
  const pactl = async (args) => {
    const result = await run(path.join(layout.bin, 'pactl'), args, {
      env: clientEnv,
      timeout: 10_000,
    });
    return result.stdout;
  };

  const deadline = Date.now() + 10_000;
  let ready = false;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exit) break;
    try {
      const info = await pactl(['info']);
      if (info.includes(`Server Name: pulseaudio`)) {
        ready = true;
        break;
      }
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  if (!ready) {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '');
    daemon.kill('SIGKILL');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), delay(2000)]);
    await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `Private PulseAudio did not start${exit ? ` (exit ${exit.code ?? exit.signal})` : ''}. ` +
      `Last error: ${lastError?.message ?? 'none'}. Log:\n${log.split('\n').slice(-25).join('\n')}`,
    );
  }

  let stopped = false;
  return {
    pid: daemon.pid,
    sinkA: SINK_A,
    sinkB: SINK_B,
    sourceA: SOURCE_A,
    sourceB: SOURCE_B,
    bin: layout.bin,
    socket,
    runtimeRoot,
    logPath,
    pactl,
    pulseaudioVersion: layout.manifest.pulseaudioVersion ?? 'unknown',
    clientEnvironment: clientEnv,
    /** Environment to add for browser/Electron child processes only. */
    browserEnvironment() {
      return {
        PULSE_SERVER: clientEnv.PULSE_SERVER,
        PULSE_RUNTIME_PATH: runtime,
        LD_LIBRARY_PATH: childLibraryPath(layout) + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''),
      };
    },
    async stop() {
      if (stopped) return { alreadyStopped: true };
      stopped = true;
      if (!exit) daemon.kill('SIGTERM');
      const graceful = exit
        ? true
        : await Promise.race([
            new Promise((resolve) => daemon.once('exit', () => resolve(true))),
            delay(5000).then(() => false),
          ]);
      if (!graceful && !exit) {
        daemon.kill('SIGKILL');
        await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), delay(2000)]);
      }
      await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
      const socketPresent = await fs.stat(socket).then(() => true).catch(() => false);
      const runtimePresent = await fs.stat(runtimeRoot).then(() => true).catch(() => false);
      if (socketPresent || runtimePresent) {
        throw new Error(`Private PulseAudio cleanup left ${socketPresent ? 'socket ' : ''}${runtimePresent ? 'runtime directory' : ''}`);
      }
      return {
        pid: daemon.pid,
        exit: exit ?? { code: null, signal: null },
        graceful,
        socketRemoved: !socketPresent,
        runtimeRemoved: !runtimePresent,
      };
    },
  };
}
