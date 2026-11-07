import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const website = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(website, 'dist');
const storage = path.join(os.homedir(), '.local/share/audivane-website');
const current = path.join(storage, 'current');
const release = JSON.parse(await fs.readFile(path.join(dist, 'release.json'), 'utf8'));
for (const file of ['index.html', 'demo/index.html', 'sources/browser/audivane-source.tar.gz', 'sources/browser/browser-codec-materials.tar.gz']) await fs.access(path.join(dist, file));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshot = path.join(storage, 'releases', `${stamp}-${release.commit?.slice(0, 12) ?? 'unknown'}`);
await fs.mkdir(path.join(snapshot, 'scripts'), { recursive: true });
await fs.cp(dist, path.join(snapshot, 'dist'), { recursive: true, dereference: false });
await fs.copyFile(path.join(website, 'scripts/serve.mjs'), path.join(snapshot, 'scripts/serve.mjs'));
const sums = [];
async function hashTree(directory) {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await hashTree(file);
    else if (entry.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      sums.push(`${hash.digest('hex')}  ${path.relative(snapshot, file)}`);
    } else throw new Error(`Refusing non-regular deployment file: ${file}`);
  }
}
await hashTree(snapshot);
await fs.writeFile(path.join(snapshot, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
await fs.writeFile(path.join(snapshot, 'deployment.json'), JSON.stringify({ deployedAt: new Date().toISOString(), node: process.version, release }, null, 2) + '\n');
const previous = await fs.readlink(current).catch(() => null);
async function pointAt(target) {
  const next = path.join(storage, `.next-${randomUUID()}`);
  await fs.symlink(target, next);
  await fs.rename(next, current);
}
await pointAt(snapshot);
try {
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', 'audivane-website.service'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'restart', 'audivane-website.service'], { stdio: 'inherit' });
} catch (error) {
  if (previous) {
    await pointAt(previous);
    execFileSync('systemctl', ['--user', 'restart', 'audivane-website.service'], { stdio: 'inherit' });
  } else await fs.unlink(current);
  throw error;
}
console.log(`Local site deployed: ${snapshot}`);
console.log('Cloudflare Tunnel and DNS are managed separately; verify public HTTPS after cutover.');
