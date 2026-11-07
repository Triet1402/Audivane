import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inspectPeExecutable, WINDOWS_SYSTEM_DLLS } from './native-bundle.mjs';

/** Inspect the actual shipped Electron AND codec PE files without execution.
 * Static/delay imports must resolve beside the image, at the executable root,
 * or to a declared Windows system DLL/API set. Dynamic LoadLibrary calls and
 * Windows loader execution remain outside this structural evidence.
 */
export async function auditWindowsPackage(directory) {
  const names = (await fs.readdir(directory, { recursive: true })).filter(name => /\.(exe|dll)$/i.test(name)).sort();
  const byName = new Map(names.map(name => [name.toLowerCase(), name]));
  if (byName.size !== names.length) throw new Error('Windows package contains case-colliding PE paths');
  if (!byName.has('audivane.exe')) throw new Error('Windows package is missing Audivane.exe');
  const normalized = names.map(name => name.split(path.sep).join('/').toLowerCase());
  if (!normalized.includes('resources/process-host/audivane-process-host.exe')) {
    throw new Error('Windows package is missing the whole-desktop process lifetime host');
  }
  const files = [];
  const failures = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    const pe = await inspectPeExecutable(filename);
    if (!pe.ok || !pe.isX64 || pe.dll !== /\.dll$/i.test(name)) {
      failures.push(`${name}: not a valid Windows x64 PE image`);
      continue;
    }
    const imports = pe.imports.map(dll => {
      const local = path.join(path.dirname(name), dll).toLowerCase();
      const providedBy = byName.get(local) ?? byName.get(dll.toLowerCase()) ?? null;
      const system = WINDOWS_SYSTEM_DLLS.has(dll.toLowerCase()) || /^(api-ms-win-|ext-ms-)/i.test(dll);
      if (!providedBy && !system) failures.push(`${name}: missing runtime DLL ${dll}`);
      return { name: dll, source: providedBy ? 'package' : system ? 'system' : 'missing',
        providedBy: providedBy?.split(path.sep).join('/') ?? null };
    });
    files.push({ path: name.split(path.sep).join('/'),
      sha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex'), imports });
  }
  if (failures.length) throw new Error(`Windows package dependency audit failed:\n${failures.join('\n')}`);
  return { schema: 'audivane-windows-package-audit-v1', platform: 'win32', arch: 'x64', files,
    execution: 'not executed; static and delay-load import closure only' };
}
