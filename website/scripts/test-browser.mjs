// Owned website browser launcher.
//
// It serves the generated site with website/scripts/serve.mjs on an ephemeral
// loopback port, runs the root @playwright/test Chromium suite against that
// exact server, and tears the server down. This is deliberately not Vite
// preview: the demo must be exercised with the production static host's CSP.
//
// The launcher only reads a complete website/dist. It never builds the Astro
// site, the demo, or shared client artifacts; those have separate owners.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSession } from '../../tools/verification/session.mjs';
import { currentLockDescriptor, withLock } from '../../tools/verification/cache.mjs';
import { cancellation, run } from '../../tools/verification/process.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
const dist = path.join(root, 'website/dist');
const serveScript = path.join(root, 'website/scripts/serve.mjs');
const configPath = path.join(root, 'website/test/playwright.config.ts');
const playwrightCLI = path.join(root, 'node_modules/@playwright/test/cli.js');
const lockPath = path.join(root, 'build/verification.lock');

// The content routes are part of the contract this suite validates. Missing
// pages mean the Astro owner has not produced a complete site yet; refuse to
// run against a demo-only tree instead of silently skipping coverage.
const requiredPages = [
  'index.html',
  'docs/index.html',
  'guides/index.html',
  'downloads/index.html',
  'demo/index.html',
];

async function assertCompleteSite() {
  const missing = [];
  for (const relative of requiredPages) {
    try {
      const info = await fs.stat(path.join(dist, relative));
      if (!info.isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  try {
    await fs.access(playwrightCLI);
  } catch {
    missing.push('node_modules/@playwright/test/cli.js (install the root dependency)');
  }
  if (missing.length > 0) {
    throw new Error(
      `Website browser tests need a complete website build. Missing: ${missing.join(', ')}. ` +
      'Run the owned website/Astro and demo builds first; this launcher does not build them.',
    );
  }
}

// Include the supporting descriptor so a build/browser lock remains held for as
// long as this launcher or any owned child is alive.
function spawnWithLock(command, args, options) {
  const descriptor = currentLockDescriptor();
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (descriptor !== undefined && process.platform !== 'win32') stdio.push(descriptor);
  return spawn(command, args, { ...options, stdio });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawnWithLock(process.execPath, [serveScript], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        CANONICAL_HOST: process.env.CANONICAL_HOST ?? 'audivane.app',
      },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    function terminate(signal) {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { terminate('SIGTERM'); } catch { /* best-effort failure cleanup */ }
        setTimeout(() => {
          try { terminate('SIGKILL'); } catch { /* already gone */ }
        }, 1000).unref();
        reject(error);
      } else {
        resolve(value);
      }
    }

    timer = setTimeout(() => {
      finish(new Error(`Website server did not announce a loopback URL within 10 s. ${stderr.trim()}`));
    }, 10_000);
    timer.unref?.();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /Audivane website: (http:\/\/\S+)/.exec(stdout);
      if (!match) return;
      finish(null, { child, url: match[1], stderr: () => stderr });
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      finish(new Error(
        `Website server exited before announcing a URL (code ${code ?? signal}). ${stderr.trim()}`,
      ));
    });
  });
}

async function stopServer(server) {
  if (!server) return;
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  const signalTree = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  try {
    signalTree('SIGTERM');
  } catch {
    // Cleanup continues with the bounded fallback below.
  }
  const kill = setTimeout(() => {
    try { signalTree('SIGKILL'); } catch { /* already gone */ }
  }, 3000);
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
  clearTimeout(kill);
}

function scopeLabel(args) {
  return args.length > 0 ? args.join(' ') : 'ALL website content + demo tests';
}

async function main() {
  await assertCompleteSite();
  const publicOrigin = process.env.CODEC_ABX_WEBSITE_PUBLIC_URL;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
      throw new Error('Public website acceptance requires a bare HTTPS origin');
  }
  await withLock(lockPath, async () => {
    const report = await createSession(root, 'website');
    let server;
    try {
      if (!publicOrigin) server = await startServer();
      const targetURL = publicOrigin ?? server.url;
      console.log(`[website] testing ${publicOrigin ? 'public origin' : path.relative(root, dist)} at ${targetURL}`);
      console.log(`[website] scope: ${scopeLabel(process.argv.slice(2))}; reports: ${report}`);
      await run(process.execPath, [
        playwrightCLI,
        'test',
        '--config', configPath,
        ...process.argv.slice(2),
      ], {
        cwd: root,
        env: {
          ...process.env,
          CODEC_ABX_WEBSITE_URL: targetURL,
          CODEC_ABX_REPORT_DIR: report,
        },
      });
    } finally {
      await stopServer(server);
    }
  }, { signal: cancellation.signal });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[website] ${message}`);
  process.exitCode = 1;
}
