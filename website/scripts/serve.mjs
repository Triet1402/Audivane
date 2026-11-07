import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile, realpath, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, sep, extname} from 'node:path';

// Serve the generated site only. Source, scripts, dependency trees and
// deployment configuration live outside this directory and are never exposed.
const distURL = new URL('../dist/', import.meta.url);
let root;
try {
  root = await realpath(fileURLToPath(distURL));
} catch {
  console.error(`Website build not found at ${fileURLToPath(distURL)}. Run the website build first.`);
  process.exit(1);
}
const rootPrefix = root.endsWith(sep) ? root : root + sep;

const canonicalHost = (process.env.CANONICAL_HOST ?? 'audivane.app').trim().toLowerCase();
const host = process.env.HOST?.trim() || '127.0.0.1';
const defaultPort = 8088;
const explicitPort = process.env.PORT !== undefined && process.env.PORT.trim() !== '';
let port = explicitPort ? Number(process.env.PORT) : defaultPort;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const themeHash = createHash('sha256').update(await readFile(resolve(root, 'theme.js'))).digest('base64');
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${themeHash}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// The demo is the real client build. It needs same-origin module workers,
// WebAssembly compilation and blob URLs for local audio exports. The existing
// supplemental LC3/LDAC loader evaluates fetched Emscripten factory glue with
// Function(), so only this route permits JavaScript evaluation. Content pages
// permit only the exact theme script; this does not change the desktop sandbox or policy.
const DEMO_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "connect-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.appimage': 'application/octet-stream',
  '.asc': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
};

const blockedNames = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'wrangler.jsonc',
  'wrangler.toml',
  '_headers',
  '_redirects',
  '_routes.json',
]);
const blockedDirectories = new Set(['node_modules', 'src']);
const blockedRootDirectories = new Set(['apps', 'packages', 'tools', 'website']);
const blockedExtensions = new Set([
  '.map',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.env',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.csr',
]);

const server = createServer((request, response) => {
  void handle(request, response).catch(error => {
    console.error(`Website request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) sendError(response, request, 500, 'Internal server error');
    else response.destroy();
  });
});

function isDemo(pathname) {
  return pathname === '/demo' || pathname.startsWith('/demo/');
}

function hasHttpsForward(request) {
  const proto = request.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

function baseHeaders(request, pathname) {
  const headers = {
    'Content-Security-Policy': isDemo(pathname) ? DEMO_SECURITY_POLICY : CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isDemo(pathname) || pathname === '/404.html') headers['X-Robots-Tag'] = 'noindex';
  if (hasHttpsForward(request)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

function cacheControlFor(type) {
  if (type.startsWith('text/html') || type.startsWith('application/xml')
      || type.startsWith('text/plain') || type.startsWith('application/json')) {
    return 'public, max-age=0, must-revalidate, no-transform';
  }
  return 'public, max-age=3600, no-transform';
}

function sendError(response, request, status, message, headers = {}) {
  const pathname = decodedPath(request.url) ?? '/';
  const body = Buffer.from(`${message}\n`);
  response.writeHead(status, {
    ...baseHeaders(request, pathname),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function sendNotFound(request, response, pathname) {
  // A missing document can use the built 404 page, but always with status
  // 404. Missing assets and /demo/ requests stay plain so a script or media
  // request never receives HTML.
  if (!isDemo(pathname) && extname(pathname) === '') {
    try {
      const target = resolve(root, '404.html');
      const info = await stat(target);
      if (info.isFile()) {
        const real = await realpath(target);
        if (real.startsWith(rootPrefix)) {
          const body = await readFile(real);
          response.writeHead(404, {
            ...baseHeaders(request, pathname),
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': String(body.length),
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
          });
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }
      }
    } catch {
      // The plain-text 404 below is the fallback when the page is absent.
    }
  }
  sendError(response, request, 404, 'Not found');
}

function sendRedirect(response, request, pathname, location, demo = false) {
  response.writeHead(308, {
    ...baseHeaders(request, demo ? '/demo/' : pathname),
    'Location': location,
    'Cache-Control': 'public, max-age=3600, no-transform',
    'Content-Length': '0',
  });
  response.end();
}

function decodedPath(target) {
  try {
    return decodeURIComponent(new URL(target ?? '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
}

function encodePath(pathname) {
  return pathname.split('/')
    .map((segment, index) => index === 0 ? '' : encodeURIComponent(segment))
    .join('/');
}

function blockedPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.includes('..')) return 403;
  if (segments.some(segment => segment === '.' || segment.startsWith('.'))) return 404;
  const lower = segments.map(segment => segment.toLowerCase());
  if (lower.some(segment => blockedDirectories.has(segment))) return 404;
  if (lower.length > 0 && blockedRootDirectories.has(lower[0])) return 404;
  const base = lower.at(-1) ?? '';
  if (blockedNames.has(base)) return 404;
  if (blockedExtensions.has(extname(base))) return 404;
  return 0;
}

async function handle(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, request, 405, 'Method not allowed', {Allow: 'GET, HEAD'});
    return;
  }

  let url;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    sendError(response, request, 400, 'Bad request');
    return;
  }
  const pathname = decodedPath(request.url);
  if (pathname === null || pathname.includes('\0') || pathname.includes('\\')) {
    sendError(response, request, 400, 'Bad request');
    return;
  }
  if (pathname.startsWith('//')) {
    sendError(response, request, 404, 'Not found');
    return;
  }

  const blocked = blockedPath(pathname);
  if (blocked === 403) {
    sendError(response, request, 403, 'Forbidden');
    return;
  }
  if (blocked === 404) {
    sendError(response, request, 404, 'Not found');
    return;
  }

  const requestHost = request.headers.host?.replace(/:\d+$/, '').toLowerCase() ?? '';
  if (canonicalHost && requestHost === `www.${canonicalHost}`) {
    sendRedirect(response, request, pathname, `https://${canonicalHost}${url.pathname}${url.search}`, isDemo(pathname));
    return;
  }

  // One canonical URL per document. Keep the query string while removing the
  // directory index and adding the trailing slash for directories.
  if (pathname === '/index.html' || pathname.endsWith('/index.html')) {
    const canonical = encodePath(pathname.slice(0, -'index.html'.length) || '/');
    sendRedirect(response, request, pathname, canonical + url.search, isDemo(pathname));
    return;
  }

  let target = resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(rootPrefix)) {
    sendError(response, request, 403, 'Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      await sendNotFound(request, response, pathname);
      return;
    }
    throw error;
  }

  if (info.isDirectory()) {
    if (!pathname.endsWith('/')) {
      sendRedirect(response, request, pathname, `${url.pathname}/${url.search}`, isDemo(pathname));
      return;
    }
    target = resolve(target, 'index.html');
    try {
      info = await stat(target);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        await sendNotFound(request, response, pathname);
        return;
      }
      throw error;
    }
  } else if (pathname.endsWith('/')) {
    sendError(response, request, 404, 'Not found');
    return;
  }

  if (!info.isFile()) {
    await sendNotFound(request, response, pathname);
    return;
  }

  const real = await realpath(target);
  if (real !== root && !real.startsWith(rootPrefix)) {
    sendError(response, request, 403, 'Forbidden');
    return;
  }
  const realInfo = await stat(real);
  if (!realInfo.isFile()) {
    await sendNotFound(request, response, pathname);
    return;
  }

  const type = types[extname(real).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    ...baseHeaders(request, pathname),
    'Content-Type': type,
    'Cache-Control': cacheControlFor(type),
    'Content-Length': String(realInfo.size),
  };
  if (request.method === 'HEAD') {
    response.writeHead(200, headers);
    response.end();
    return;
  }
  const body = await readFile(real);
  headers['Content-Length'] = String(body.length);
  response.writeHead(200, headers);
  response.end(body);
}

let attempts = 0;
let started = false;
server.on('listening', () => {
  started = true;
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`Audivane website: http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${actualPort}`);
});
server.on('error', error => {
  if (error?.code === 'EADDRINUSE' && !explicitPort && !started && attempts < 20) {
    attempts += 1;
    port += 1;
    if (port > 65535) {
      console.error('No free port found for the website server.');
      process.exitCode = 1;
      return;
    }
    console.error(`Port ${port - 1} is in use; trying ${port}.`);
    server.listen(port, host);
    return;
  }
  console.error(`Website server failed on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
server.listen(port, host);

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
