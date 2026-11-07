import path from 'node:path';

// Windows system tools must be found even when PATH is deliberately empty or
// poisoned (for example the packaged acceptance environment).
export function taskkillExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.windir;
  return systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
}
