import { promises as fs } from 'node:fs';
import path from 'node:path';
// Session names are launcher constants; folding any stray separators keeps the
// prefix valid on Windows (reserved characters) without changing Linux names.
export async function createSession(root, name) {
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  return fs.mkdtemp(path.join(root, 'test-results', `${name.replace(/[^A-Za-z0-9._-]/g, '-')}-`));
}
export function loopbackURL(server) {
  const value = server.address();
  if (!value || typeof value === 'string' || value.address !== '127.0.0.1') throw new Error('Expected an owned loopback TCP server');
  return `http://127.0.0.1:${value.port}`;
}
