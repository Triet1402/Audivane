import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { taskkillExecutable } from './verification/windows.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const localLibraries = path.join(root, 'build/desktop-host-libs/root/usr/lib/x86_64-linux-gnu');
if (!windows && existsSync(localLibraries)) process.env.LD_LIBRARY_PATH = localLibraries + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, 'apps/desktop'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
// Windows has no process-group signal: terminate the Electron tree so renderer
// and utility descendants do not outlive the launcher.
function terminate(signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (!windows) { child.kill(signal); return; }
  const killer = spawn(taskkillExecutable(), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.once('error', () => { try { child.kill(); } catch { /* already gone */ } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => terminate(signal));
