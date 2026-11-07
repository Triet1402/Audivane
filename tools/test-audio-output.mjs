#!/usr/bin/env node
/**
 * Dedicated serial lane for real OS-level browser/Electron output capture.
 *
 * It holds the shared output lock for build/package reuse and server ownership,
 * launches a project-local user-mode PulseAudio server, serves the built client
 * on an owned loopback port and runs only tests/audio-output. Missing capture
 * dependencies fail this explicit lane; it is never part of the normal suites.
 */
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { preview } from 'vite';
import { createSession, loopbackURL } from './verification/session.mjs';
import { ensureArtifacts, root, lockPath } from './verification/build.mjs';
import { withLock } from './verification/cache.mjs';
import { run, cancellation } from './verification/process.mjs';
import { assertVirtualAudioInstalled, startPrivatePulse } from './virtual-audio/runtime.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run test:audio-output -- [Playwright files/filters]');
  console.log('Requires: npm run setup:virtual-audio (project-local, no sudo).');
  process.exit(0);
}

// Fail before touching the shared build lock if the private backend is absent.
await assertVirtualAudioInstalled();

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function killOwnedSourceOutputs(pulse) {
  const text = await pulse.pactl(['list', 'short', 'source-outputs']).catch(() => '');
  const ids = text.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((value) => value && /^\d+$/.test(value));
  for (const id of ids) await pulse.pactl(['kill-source-output', id]).catch(() => undefined);
  const after = await pulse.pactl(['list', 'short', 'source-outputs']).catch(() => '');
  return { before: text.trim(), killed: ids, after: after.trim() };
}

await withLock(lockPath, async () => {
  const report = await createSession(root, 'audio-output');
  let server = null;
  let pulse = null;
  let primaryError = null;
  let cleanup = null;
  try {
    await ensureArtifacts('desktop');
    pulse = await startPrivatePulse({ reportDirectory: report });
    server = await preview({
      configFile: path.join(root, 'apps/client/vite.config.ts'),
      preview: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    const environment = {
      ...process.env,
      ...pulse.browserEnvironment(),
      CODEC_ABX_AUDIO_REPORT: report,
      CODEC_ABX_PULSE_SERVER: pulse.clientEnvironment.PULSE_SERVER,
      CODEC_ABX_PULSE_BIN: pulse.bin,
      CODEC_ABX_PULSE_SINK_A: pulse.sinkA,
      CODEC_ABX_PULSE_SINK_B: pulse.sinkB,
      CODEC_ABX_PREVIEW_URL: loopbackURL(server.httpServer),
    };
    const desktopLibraries = path.join(root, 'build/desktop-host-libs/root/usr/lib/x86_64-linux-gnu');
    if (existsSync(desktopLibraries)) {
      environment.LD_LIBRARY_PATH = [desktopLibraries, environment.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    const playwrightArgs = [
      path.join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--config', path.join(root, 'tests/audio-output/playwright.config.ts'),
      ...args,
    ];
    const command = process.env.DISPLAY ? process.execPath : 'xvfb-run';
    const commandArgs = process.env.DISPLAY ? playwrightArgs : ['-a', process.execPath, ...playwrightArgs];
    console.log(`[audio-output] private PulseAudio ${pulse.pulseaudioVersion} on ${pulse.socket}`);
    console.log(`[audio-output] owned preview ${environment.CODEC_ABX_PREVIEW_URL}; reports: ${report}`);
    console.log(`[audio-output] serial scope: ${args.length ? args.join(' ') : 'browser + Electron capture'}`);
    await run(command, commandArgs, { cwd: root, env: environment });
  } catch (error) {
    primaryError = error;
  } finally {
    const recorderCleanup = pulse ? await killOwnedSourceOutputs(pulse).catch(() => ({ error: 'source-output cleanup failed' })) : null;
    const pulseStop = pulse ? await pulse.stop().catch((error) => ({ error: error.message })) : null;
    const serverClose = server ? await server.close().catch((error) => ({ error: error.message })) : null;
    const daemonGone = pulse ? !processExists(pulse.pid) : true;
    cleanup = { report, recorderCleanup, pulseStop, serverClose, daemonGone };
    await fs.writeFile(path.join(report, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
    console.log(`[audio-output] cleanup: ${JSON.stringify(cleanup)}`);
    if (primaryError) throw primaryError;
    if (recorderCleanup?.after) throw new Error(`Capture lane left monitor source outputs: ${recorderCleanup.after}`);
    if (serverClose?.error) throw new Error(`Preview cleanup failed: ${serverClose.error}`);
    if (pulseStop?.error) throw new Error(`Private PulseAudio cleanup failed: ${pulseStop.error}`);
    if (!daemonGone) throw new Error(`Private PulseAudio process ${pulse?.pid ?? 'unknown'} is still alive`);
  }
}, { signal: cancellation.signal });
