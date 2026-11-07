// Print a reviewable, executable-specific profile. Never changes host policy.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executables = [path.join(root, 'node_modules/electron/dist/electron'), path.join(root, 'dist/desktop/Codec ABX-linux-x64/codec-abx')];
console.log('abi <abi/4.0>,\ninclude <tunables/global>\n');
for (const [index, executable] of executables.entries()) {
  if (/["\n\r\\]/.test(executable)) throw new Error('Profile path requires manual AppArmor escaping');
  console.log(`profile codec-abx-desktop-${index + 1} "${executable}" flags=(unconfined) {\n  userns,\n}\n`);
}
