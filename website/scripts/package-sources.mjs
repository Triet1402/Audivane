import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'website/dist/sources/browser');
const materials = path.join(root, 'build/browser-materials');
// Verify every collected source/license byte before offering the payload.
execFileSync(process.execPath, [path.join(root, 'tools/collect-browser-materials.mjs'), '--verify', '--output', materials], { cwd: root, stdio: 'inherit' });
await fs.mkdir(output, { recursive: true });
// Snapshot folders intentionally have no Git history. In that case ripgrep
// applies the same ignore files without creating a repository.
const hasGit = await fs.access(path.join(root, '.git')).then(() => true, () => false);
const files = (hasGit
  ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  : execFileSync('rg', ['--files', '--hidden', '--no-require-git', '--null', '-g', '!.git/**'], { cwd: root })
).toString().split('\0').filter(Boolean);
const selected = [];
for (const name of [...new Set(files)].sort()) {
  const info = await fs.lstat(path.join(root, name)).catch(() => null);
  if (!info) continue; // Deleted tracked entries are not in this source tree.
  if (!info.isFile()) throw new Error(`Refusing non-file source entry: ${name}`);
  selected.push(name);
}
const manifest = path.join(root, 'build/website-source-files');
await fs.writeFile(manifest, selected.join('\0') + '\0');
execFileSync('tar', ['-czf', path.join(output, 'audivane-source.tar.gz'), '--null', '-T', manifest], { cwd: root, stdio: 'inherit' });
execFileSync('tar', ['-czf', path.join(output, 'browser-codec-materials.tar.gz'), '-C', materials, '.'], { cwd: root, stdio: 'inherit' });
for (const name of ['NOTICES.md', 'SOURCE-OFFER.md', 'REPORT.json']) await fs.copyFile(path.join(materials, name), path.join(output, name));
const sums = [];
for (const name of ['audivane-source.tar.gz', 'browser-codec-materials.tar.gz']) {
  const hash = createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex');
  sums.push(`${hash}  ${name}`);
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
await fs.copyFile(path.join(root, 'website/dist/release.json'), path.join(output, 'release.json'));
console.log('Prepared exact working-tree application source and verified codec materials at /sources/browser/.');
