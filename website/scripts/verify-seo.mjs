import assert from 'node:assert/strict';
import {readFile, readdir, realpath, stat, lstat} from 'node:fs/promises';
import {basename, extname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const rootPrefix = root.endsWith(sep) ? root : root + sep;
const servePath = fileURLToPath(new URL('./serve.mjs', import.meta.url));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function files(directory) {
  const result = [];
  const entries = await readdir(directory, {withFileTypes: true});
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

const rel = file => relative(root, file).split(sep).join('/');
const topLevel = file => rel(file).split('/')[0];
const isDemoFile = file => topLevel(file) === 'demo';
const routeFor = file => {
  const path = rel(file);
  return path === 'index.html' ? '/' : `/${path.replace(/index\.html$/, '')}`;
};
const urlPathForFile = file => '/' + rel(file).split('/').map(encodeURIComponent).join('/');
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\"']/g, '\\$&');

const namedEntities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const hexadecimal = code[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return namedEntities[code.toLowerCase()] ?? match;
  });
}

function attribute(source, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(source);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

const stripComments = source => source.replace(/<!--[\s\S]*?-->/g, '');
function tagAttributes(source) {
  return [...stripComments(source).matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)]
    .map(match => ({name: match[1].toLowerCase(), attributes: match[2]}));
}

function references(source) {
  const result = [];
  for (const tag of tagAttributes(source)) {
    for (const name of ['href', 'src', 'poster']) {
      const value = attribute(tag.attributes, name);
      if (value !== null) result.push({...tag, attribute: name, value: decodeEntities(value)});
    }
  }
  return result;
}

function metaTags(source) {
  return tagAttributes(source).filter(tag => tag.name === 'meta');
}
function metaContent(source, name) {
  const wanted = name.toLowerCase();
  for (const tag of metaTags(source)) {
    const key = (attribute(tag.attributes, 'name') ?? attribute(tag.attributes, 'property') ?? '').toLowerCase();
    if (key === wanted) return decodeEntities(attribute(tag.attributes, 'content') ?? '');
  }
  return null;
}

const htmlCache = new Map();
async function html(file) {
  if (!htmlCache.has(file)) htmlCache.set(file, await readFile(file, 'utf8'));
  return htmlCache.get(file);
}

let allFiles;
try {
  allFiles = await files(root);
} catch (error) {
  if (error?.code === 'ENOENT') {
    assert.fail(`Missing website build at ${root}. Build the Astro site and copy the client into dist/demo first.`);
  }
  throw error;
}

const robotsFile = resolve(root, 'robots.txt');
assert.ok(await exists(robotsFile), 'Missing website/dist/robots.txt');
const robots = await readFile(robotsFile, 'utf8');
const robotsSitemapLines = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map(match => match[1]);
assert.ok(robotsSitemapLines.length > 0, 'robots.txt must declare a Sitemap URL');
assert.match(robots, /^\s*User-agent:\s*\*\s*$/im, 'robots.txt must contain a User-agent: * group');
assert.doesNotMatch(
  robots,
  /^\s*Disallow:\s*\/demo(?:\/|\/\*|\*)?\s*$/im,
  'robots.txt must not block /demo/: the noindex directive needs crawler access',
);
assert.doesNotMatch(robots, /^\s*Disallow:\s*\/\s*$/im, 'robots.txt must not disallow the whole site');

let rootSitemap = null;
for (const line of robotsSitemapLines) {
  let url;
  try {
    url = new URL(line);
  } catch {
    continue;
  }
  if (url.protocol !== 'https:') continue;
  const candidate = resolve(root, '.' + decodeURIComponent(url.pathname));
  if (await exists(candidate)) {
    rootSitemap = candidate;
    break;
  }
}
if (rootSitemap === null) {
  for (const candidate of [resolve(root, 'sitemap.xml'), resolve(root, 'sitemap-index.xml')]) {
    if (await exists(candidate)) {
      rootSitemap = candidate;
      break;
    }
  }
}
assert.ok(rootSitemap, 'Missing sitemap.xml or sitemap-index.xml, or robots.txt points to a missing sitemap');

let origin = null;
const sitemapFiles = new Set();
const sitemapLocs = [];
const visitedSitemaps = new Set();
async function readSitemap(file) {
  assert.ok(file.startsWith(rootPrefix), `Sitemap path escapes the build: ${file}`);
  assert.ok(!visitedSitemaps.has(file), `Sitemap index repeats ${rel(file)}`);
  visitedSitemaps.add(file);
  sitemapFiles.add(file);
  const xml = await readFile(file, 'utf8');
  assert.match(xml, /<(?:urlset|sitemapindex)\b/i, `${rel(file)} is not a sitemap`);
  const locs = [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gi)]
    .map(match => decodeEntities(match[1].trim()));
  assert.ok(locs.length > 0, `${rel(file)} contains no <loc> entries`);
  const isIndex = /<sitemapindex\b/i.test(xml);
  for (const loc of locs) {
    let url;
    try {
      url = new URL(loc);
    } catch {
      assert.fail(`${rel(file)} contains an invalid loc: ${loc}`);
    }
    assert.equal(url.protocol, 'https:', `Sitemap loc must use https: ${loc}`);
    assert.equal(url.search, '', `Sitemap loc must not contain a query: ${loc}`);
    assert.equal(url.hash, '', `Sitemap loc must not contain a fragment: ${loc}`);
    if (origin === null) origin = url.origin;
    assert.equal(url.origin, origin, `Sitemap loc uses another origin: ${loc}`);
    assert.ok(!url.hostname.startsWith('www.'), `Sitemap must use the canonical non-www host: ${loc}`);
    assert.ok(!['localhost', '127.0.0.1', '::1'].includes(url.hostname), `Sitemap must not use a loopback host: ${loc}`);
    assert.equal(url.port, '', `Sitemap must not use a non-default port: ${loc}`);
    if (isIndex) {
      const shard = resolve(root, '.' + decodeURIComponent(url.pathname));
      assert.ok(await exists(shard), `Sitemap index points to a missing shard: ${loc}`);
      await readSitemap(shard);
    } else {
      assert.ok(url.pathname.endsWith('/'), `Sitemap page URL must end with a slash: ${loc}`);
      sitemapLocs.push(loc);
    }
  }
}
await readSitemap(rootSitemap);

assert.ok(origin, 'Sitemap did not define an origin');
const expectedOrigin = process.env.SITE_ORIGIN?.trim() || 'https://audivane.app';
assert.equal(
  new URL(expectedOrigin).origin,
  origin,
  `Sitemap origin ${origin} does not match the canonical site origin ${new URL(expectedOrigin).origin}`,
);
assert.equal(new URL(origin).protocol, 'https:');
assert.equal(new URL(origin).port, '');
assert.ok(!['localhost', '127.0.0.1', '::1'].includes(new URL(origin).hostname));
assert.ok(!new URL(origin).hostname.startsWith('www.'));

const declaredSitemap = `${origin}${urlPathForFile(rootSitemap)}`;
assert.ok(
  robotsSitemapLines.includes(declaredSitemap),
  `robots.txt must declare ${declaredSitemap}`,
);

assert.equal(new Set(sitemapLocs).size, sitemapLocs.length, 'Sitemap contains duplicate page URLs');
assert.ok(!sitemapLocs.some(loc => {
  const pathname = new URL(loc).pathname;
  return pathname === '/demo' || pathname.startsWith('/demo/');
}), 'Sitemap must exclude /demo/');
assert.ok(!sitemapLocs.some(loc => new URL(loc).pathname === '/404.html'), 'Sitemap must exclude /404.html');

const allHtml = allFiles.filter(file => file.endsWith('.html'));
const contentPages = allHtml.filter(file => !isDemoFile(file) && basename(file) !== '404.html');
assert.ok(contentPages.length > 0, 'The generated site contains no indexable HTML pages');
for (const required of ['index.html', 'docs/index.html', 'guides/index.html', 'downloads/index.html']) {
  assert.ok(allFiles.includes(resolve(root, required)), `Missing required page: ${required}`);
}

const routeMap = new Map();
for (const file of contentPages) {
  const route = routeFor(file);
  assert.ok(!routeMap.has(route), `Two build files map to ${route}`);
  routeMap.set(route, file);
}
const expectedLocs = new Map([...routeMap].map(([route, file]) => [origin + route, file]));
for (const [loc, file] of expectedLocs) {
  assert.ok(sitemapLocs.includes(loc), `Missing sitemap URL for ${rel(file)}: ${loc}`);
}
for (const loc of sitemapLocs) {
  assert.ok(expectedLocs.has(loc), `Sitemap URL has no built page: ${loc}`);
}

const demoIndex = resolve(root, 'demo', 'index.html');
assert.ok(allFiles.includes(demoIndex), 'Missing website/dist/demo/index.html');
for (const asset of ['demo/codec-assets/ffmpeg-core.js', 'demo/codec-assets/ffmpeg-core.wasm']) {
  assert.ok(allFiles.includes(resolve(root, asset)), `Missing demo runtime asset: ${asset}`);
}

// LC3 and LDAC are optional supplemental builds. When a pair or its SHA-256
// manifest is published, require a complete, matching pair. Absence stays valid.
const demoCodecDirectory = resolve(root, 'demo', 'codec-assets');
const supplementalWasm = [];
for (const [codec, names] of [
  ['lc3', ['lc3_codec.js', 'lc3_codec.wasm']],
  ['ldac', ['ldac_codec.js', 'ldac_codec.wasm']],
]) {
  const paths = names.map(name => resolve(demoCodecDirectory, name));
  const present = paths.map(path => allFiles.includes(path));
  const manifestPath = resolve(demoCodecDirectory, `${codec}_codec.sha256`);
  const manifestPresent = allFiles.includes(manifestPath);
  if (!present.some(Boolean) && !manifestPresent) continue;
  assert.ok(
    present.every(Boolean),
    `Optional ${codec} runtime pair is incomplete: ${names.filter((_, index) => !present[index]).join(', ')} missing`,
  );
  if (manifestPresent) {
    const manifest = await readFile(manifestPath, 'utf8');
    const bindings = new Map(
      [...manifest.matchAll(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/gim)]
        .map(match => [basename(match[2]), match[1].toLowerCase()]),
    );
    for (const [index, name] of names.entries()) {
      const digest = createHash('sha256').update(await readFile(paths[index])).digest('hex');
      assert.equal(bindings.get(name), digest, `${codec} manifest does not bind ${name}`);
    }
  }
  supplementalWasm.push(paths[1]);
}
const demoHtml = await html(demoIndex);
assert.match(demoHtml, /<html\b/i, 'demo/index.html is not HTML');
const demoReferences = references(demoHtml);
let demoScript = null;
for (const reference of demoReferences) {
  const value = reference.value.trim();
  if (!value || value.startsWith('#')) continue;
  let url;
  try {
    url = new URL(value, `${origin}/demo/`);
  } catch {
    assert.fail(`demo/index.html contains an invalid reference: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
  if (url.origin !== origin) continue;
  assert.ok(
    url.pathname === '/demo/' || url.pathname.startsWith('/demo/'),
    `demo/index.html references outside /demo/: ${value}`,
  );
  if (reference.name === 'script' && reference.attribute === 'src' && demoScript === null) {
    demoScript = reference.value;
  }
  await checkReference(value, `${origin}/demo/`, 'demo/index.html', demoIndex, demoHtml);
}
assert.ok(demoScript, 'demo/index.html does not load a client script');
assert.match(
  demoHtml,
  /<meta\b[^>]*(?:name|property)=["']robots["'][^>]*content=["'][^"']*noindex/i,
  'demo/index.html must contain meta robots noindex in addition to the response header',
);

const themeScript = await readFile(resolve(root, 'theme.js'), 'utf8');
const themeCsp = `script-src 'sha256-${createHash('sha256').update(themeScript).digest('base64')}'`;
function assertNoContentScripts(source, label) {
  // Only the exact theme initializer is executable on content pages.
  source = source.replace(`<script>${themeScript}</script>`, '');
  for (const tag of tagAttributes(source)) {
    if (tag.name !== 'script') continue;
    const type = (attribute(tag.attributes, 'type') ?? '').trim().toLowerCase();
    const src = attribute(tag.attributes, 'src');
    if (src !== null || type === '' || ['module', 'text/javascript', 'application/javascript'].includes(type)) {
      assert.fail(`${label}: strict content CSP does not permit ${src === null ? 'inline scripts' : `scripts (${src})`}`);
    }
  }
}

const titleOwners = new Map();
const descriptionOwners = new Map();
for (const file of contentPages) {
  const source = await html(file);
  const route = routeFor(file);
  const canonical = origin + route;
  const clean = stripComments(source);
  const label = route;

  const htmlTag = tagAttributes(clean).find(tag => tag.name === 'html');
  assert.ok(htmlTag, `${label}: missing <html>`);
  const language = attribute(htmlTag.attributes, 'lang');
  assert.ok(language && language.trim(), `${label}: missing html lang`);
  const viewport = metaContent(source, 'viewport');
  assert.ok(viewport && /width=device-width/i.test(viewport), `${label}: missing responsive viewport meta`);

  assert.equal((clean.match(/<title\b/gi) ?? []).length, 1, `${label}: expected one <title>`);
  const rawTitle = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = decodeEntities(rawTitle?.replace(/<[^>]+>/g, '').trim() ?? '');
  assert.ok(title, `${label}: missing title`);
  assert.ok(title.length >= 10 && title.length <= 100, `${label}: title length ${title.length} is outside 10-100`);
  assert.ok(!titleOwners.has(title), `${label}: duplicate title with ${titleOwners.get(title)}: ${title}`);
  titleOwners.set(title, label);

  const descriptionTags = metaTags(source).filter(tag => (attribute(tag.attributes, 'name') ?? '').toLowerCase() === 'description');
  assert.equal(descriptionTags.length, 1, `${label}: expected one meta description`);
  const description = metaContent(source, 'description') ?? '';
  assert.ok(description, `${label}: empty meta description`);
  assert.ok(description.length >= 30 && description.length <= 220, `${label}: description length ${description.length} is outside 30-220`);
  assert.ok(!descriptionOwners.has(description), `${label}: duplicate description with ${descriptionOwners.get(description)}`);
  descriptionOwners.set(description, label);

  const canonicalTags = tagAttributes(clean).filter(tag => tag.name === 'link'
    && (attribute(tag.attributes, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  assert.equal(canonicalTags.length, 1, `${label}: expected one canonical link`);
  const canonicalHref = decodeEntities(attribute(canonicalTags[0].attributes, 'href') ?? '');
  assert.equal(canonicalHref, canonical, `${label}: canonical must be ${canonical}`);
  assert.ok(canonicalHref.startsWith('https://'), `${label}: canonical must be absolute https`);

  assert.equal((clean.match(/<h1\b/gi) ?? []).length, 1, `${label}: expected one h1`);
  assert.doesNotMatch(clean, /<base\b/i, `${label}: <base> would change link resolution`);

  const robotsMeta = metaTags(source)
    .filter(tag => ['robots', 'googlebot'].includes((attribute(tag.attributes, 'name') ?? '').toLowerCase()));
  for (const tag of robotsMeta) {
    assert.doesNotMatch(attribute(tag.attributes, 'content') ?? '', /\bnoindex\b/i, `${label}: indexable page is marked noindex`);
  }

  for (const property of ['og:title', 'og:description', 'og:url', 'og:type']) {
    assert.ok(metaContent(source, property), `${label}: missing ${property}`);
  }
  assert.equal(metaContent(source, 'og:url'), canonical, `${label}: og:url must match canonical`);
  assert.match(metaContent(source, 'og:type') ?? '', /^(?:website|article)$/, `${label}: unexpected og:type`);

  const ids = new Set();
  for (const tag of tagAttributes(clean)) {
    const id = attribute(tag.attributes, 'id');
    if (id === null) continue;
    assert.ok(!ids.has(id), `${label}: duplicate id ${id}`);
    ids.add(id);
  }

  assertNoContentScripts(clean, label);

  for (const reference of references(source)) {
    await checkReference(reference.value, `${origin}${route}`, label, file, source);
  }
}

async function checkReference(value, base, label, pageFile, pageSource) {
  const reference = value.trim();
  if (!reference) return;
  if (/^javascript:/i.test(reference)) {
    assert.fail(`${label}: javascript: URL is not allowed: ${reference}`);
  }
  let url;
  try {
    url = new URL(reference, base);
  } catch {
    assert.fail(`${label}: invalid URL: ${reference}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== origin) return;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    assert.fail(`${label}: invalid URL encoding: ${reference}`);
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    assert.fail(`${label}: unsafe local reference: ${reference}`);
  }
  if (pathname.startsWith('//')) {
    assert.fail(`${label}: ambiguous local reference: ${reference}`);
  }
  if (pathname === '/index.html' || pathname.endsWith('/index.html')) {
    assert.fail(`${label}: use the canonical directory URL instead of ${reference}`);
  }

  let target = resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(rootPrefix)) {
    assert.fail(`${label}: reference escapes the site: ${reference}`);
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    assert.fail(`${label}: broken local reference: ${reference}`);
  }
  if (info.isDirectory()) {
    if (!pathname.endsWith('/')) {
      assert.fail(`${label}: directory reference must use a trailing slash: ${reference}`);
    }
    target = resolve(target, 'index.html');
    try {
      info = await stat(target);
    } catch {
      assert.fail(`${label}: directory has no index.html: ${reference}`);
    }
  } else if (pathname.endsWith('/')) {
    assert.fail(`${label}: trailing slash points to a file: ${reference}`);
  }
  if (!info.isFile()) {
    assert.fail(`${label}: local reference is not a file: ${reference}`);
  }

  const hash = url.hash.slice(1);
  if (!hash || !target.endsWith('.html')) return;
  let fragment;
  try {
    fragment = decodeURIComponent(hash);
  } catch {
    assert.fail(`${label}: invalid fragment encoding: ${reference}`);
  }
  if (!fragment || fragment === 'top' || fragment.startsWith('/')) return;
  const targetSource = target === pageFile ? pageSource : await html(target);
  const escaped = escapeRegExp(fragment);
  const anchor = new RegExp(`(?:^|\\s)(?:id|name)\\s*=\\s*(?:"${escaped}"|'${escaped}')`);
  assert.match(targetSource, anchor, `${label}: broken fragment: ${reference}`);
}

// Source maps, source files and deployment configuration may remain in a
// build tree, but the server must never expose them. Collect them for HTTP
// checks below and warn so they can be stripped for non-server hosting.
const forbiddenFiles = [];
for (const file of allFiles) {
  const path = rel(file);
  const parts = path.split('/');
  const name = parts.at(-1);
  const extension = extname(name).toLowerCase();
  const reason = parts.some(part => part === 'node_modules' || part === 'src')
    ? 'source or dependency directory'
    : ['apps', 'packages', 'tools', 'website'].includes(parts[0])
      ? 'repository path'
      : parts.some(part => part.startsWith('.') && part !== '.well-known')
        ? 'hidden file'
        : ['.map', '.ts', '.tsx', '.mts', '.cts', '.env', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.csr'].includes(extension)
          ? 'source, map or credential'
          : [
            'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json',
            'wrangler.jsonc', 'wrangler.toml', '_headers', '_redirects', '_routes.json',
          ].includes(name)
            ? 'deployment configuration'
            : null;
  if (reason) forbiddenFiles.push({file, reason});
}
if (forbiddenFiles.length > 0) {
  console.warn(
    `[website] note: ${forbiddenFiles.length} non-public build file(s) are present; serve.mjs returns 404 for them. `
    + 'Strip them before hosting without this server.',
  );
}
for (const file of allFiles) {
  if (!(await lstat(file)).isSymbolicLink()) continue;
  const resolved = await realpath(file);
  assert.ok(resolved.startsWith(rootPrefix), `Symlink escapes the generated site: ${rel(file)}`);
}

const serverProcess = spawn(process.execPath, [servePath], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    CANONICAL_HOST: new URL(origin).hostname,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(serverProcess, 'exit');
let serverError = '';
serverProcess.stderr.on('data', chunk => {
  serverError += chunk;
  process.stderr.write(chunk);
});

async function waitForOrigin() {
  return new Promise((resolveOrigin, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for the website server. ${serverError}`));
    }, 15000);
    const onData = chunk => {
      output += chunk;
      const match = output.match(/Audivane website: (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        serverProcess.stdout.off('data', onData);
        resolveOrigin(match[1].replace(/\/$/, ''));
      }
    };
    serverProcess.stdout.on('data', onData);
    serverProcess.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    serverProcess.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Website server exited before listening (${code ?? signal}). ${serverError}`));
    });
  });
}

function rawRequest(originBase, path, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const target = new URL(originBase);
    const request = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path,
      method: 'GET',
      headers: {Host: target.host, ...headers},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(10000, () => request.destroy(new Error(`Timed out requesting ${path}`)));
    request.on('error', reject);
    request.end();
  });
}

async function expectRedirect(originBase, path, expected) {
  const response = await fetch(new URL(path, originBase), {redirect: 'manual'});
  assert.equal(response.status, 308, `${path}: expected 308, got ${response.status}`);
  const location = response.headers.get('location');
  assert.ok(location, `${path}: missing Location`);
  const target = new URL(location, originBase);
  assert.equal(target.pathname + target.search, expected, `${path}: wrong Location ${location}`);
  await response.arrayBuffer();
}

async function expectType(originBase, path, expected, file) {
  const response = await fetch(new URL(path, originBase), {method: 'HEAD'});
  assert.equal(response.status, 200, `${path}: expected 200, got ${response.status}`);
  assert.equal(response.headers.get('content-type'), expected, `${path}: wrong content type`);
  assert.match(response.headers.get('cache-control') ?? '', /no-transform/, `${path}: missing no-transform`);
  if (file) {
    const info = await stat(file);
    assert.equal(Number(response.headers.get('content-length')), info.size, `${path}: wrong Content-Length`);
  }
  assert.equal(await response.text(), '', `${path}: HEAD returned a body`);
  return response;
}

async function runHttpChecks() {
  const originBase = (await waitForOrigin()).replace(/\/$/, '');

  for (const route of routeMap.keys()) {
    const response = await fetch(new URL(route, originBase));
    assert.equal(response.status, 200, `${route}: expected 200, got ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', `${route}: wrong content type`);
    assert.doesNotMatch(response.headers.get('x-robots-tag') ?? '', /\bnoindex\b/i, `${route}: content page is noindex`);
    const body = await response.text();
    assert.match(body, /<h1\b/i, `${route}: served page has no h1`);
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body), `${route}: wrong Content-Length`);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, `${route}: missing default-src none`);
    assert.match(response.headers.get('content-security-policy') ?? '', new RegExp(themeCsp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${route}: content CSP permits scripts`);
    assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /wasm-unsafe-eval/, `${route}: content CSP permits WebAssembly`);
    assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /'unsafe-eval'/, `${route}: content CSP permits eval`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${route}: missing nosniff`);
    assert.match(response.headers.get('referrer-policy') ?? '', /strict-origin-when-cross-origin/, `${route}: missing referrer policy`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', `${route}: missing frame denial`);
    assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/, `${route}: missing permissions policy`);
    assert.match(response.headers.get('cache-control') ?? '', /no-transform/, `${route}: missing no-transform`);
  }

  for (const route of routeMap.keys()) {
    if (route !== '/' && route.endsWith('/')) {
      await expectRedirect(originBase, route.slice(0, -1), route);
    }
  }
  await expectRedirect(originBase, '/docs?ref=check', '/docs/?ref=check');
  await expectRedirect(originBase, '/docs/index.html?ref=check', '/docs/?ref=check');
  await expectRedirect(originBase, '/index.html?ref=check', '/?ref=check');
  await expectRedirect(originBase, '/%69ndex.html?ref=check', '/?ref=check');
  await expectRedirect(originBase, '/docs/%69ndex.html?ref=check', '/docs/?ref=check');
  await expectRedirect(originBase, '/demo', '/demo/');
  await expectRedirect(originBase, '/demo/index.html', '/demo/');

  const notFoundFile = resolve(root, '404.html');
  const notFoundPage = await exists(notFoundFile) ? await readFile(notFoundFile, 'utf8') : null;
  if (notFoundPage) {
    assertNoContentScripts(notFoundPage, '404.html');
    const response = await fetch(new URL('/404.html', originBase));
    assert.equal(response.status, 200, '/404.html: expected 200');
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', '/404.html: wrong content type');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/i, '/404.html: direct 404 page must be noindex');
    assert.match(response.headers.get('content-security-policy') ?? '', new RegExp(themeCsp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '/404.html: CSP permits scripts');
    await response.arrayBuffer();
  }
  for (const path of ['/missing-page', '/docs/missing-page/', '/guides/missing-guide/']) {
    const response = await fetch(new URL(path, originBase));
    assert.equal(response.status, 404, `${path}: expected 404, got ${response.status}`);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${path}: 404 must not be cached`);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, `${path}: 404 must be noindex`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${path}: 404 missing nosniff`);
    if (notFoundPage === null) {
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', `${path}: 404 is not plain text`);
      assert.equal((await response.text()).trim(), 'Not found', `${path}: SPA fallback leaked into a 404`);
    } else {
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', `${path}: 404 page has wrong content type`);
      assert.match(response.headers.get('content-security-policy') ?? '', new RegExp(themeCsp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${path}: 404 page CSP permits scripts`);
      assert.equal(await response.text(), notFoundPage, `${path}: 404 page did not use 404.html`);
    }
  }
  for (const path of ['/demo/missing/', '/assets/missing.js', '/favicon-missing.svg']) {
    const response = await fetch(new URL(path, originBase));
    assert.equal(response.status, 404, `${path}: expected 404, got ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', `${path}: asset 404 must be plain text`);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${path}: 404 must not be cached`);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, `${path}: 404 must be noindex`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${path}: 404 missing nosniff`);
    assert.equal((await response.text()).trim(), 'Not found', `${path}: asset request received an HTML fallback`);
  }

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await fetch(new URL('/', originBase), {method});
    assert.equal(response.status, 405, `${method}: expected 405, got ${response.status}`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD', `${method}: wrong Allow header`);
    await response.text();
  }

  const unsafePaths = [
    '//etc/passwd',
    '/%2e%2e%2fpackage.json',
    '/..%2f..%2fetc%2fpasswd',
    '/docs/%2e%2e%2f%2e%2e%2fpackage.json',
    '/%2e%2e%5cpackage.json',
    '/%00',
    '/%ZZ',
    '/%2f%2fetc%2fpasswd',
  ];
  for (const path of unsafePaths) {
    const response = await rawRequest(originBase, path);
    assert.ok([400, 403, 404].includes(response.status), `${path}: unsafe request returned ${response.status}`);
    assert.doesNotMatch(response.body, /codec-abx-workspace|root:x:|BEGIN [A-Z ]*PRIVATE KEY/);
  }
  for (const path of ['/.env', '/package.json', '/src/main.ts', '/_headers', '/node_modules/pkg/index.js', '/demo/assets/index.js.map']) {
    const response = await fetch(new URL(path, originBase));
    assert.equal(response.status, 404, `${path}: source/config route must be 404`);
    await response.arrayBuffer();
  }
  for (const {file} of forbiddenFiles) {
    const path = urlPathForFile(file);
    const response = await fetch(new URL(path, originBase));
    assert.equal(response.status, 404, `${path}: non-public build file must not be served`);
    await response.arrayBuffer();
  }

  const www = await rawRequest(originBase, '/docs/?ref=check', {Host: `www.${new URL(origin).hostname}`});
  assert.equal(www.status, 308, 'www host must redirect permanently');
  assert.equal(www.headers.location, `${origin}/docs/?ref=check`, 'www redirect lost path or query');
  const forwardedHttps = await rawRequest(originBase, '/', {'X-Forwarded-Proto': 'https'});
  assert.equal(forwardedHttps.status, 200, 'forwarded HTTPS request failed');
  assert.match(
    forwardedHttps.headers['strict-transport-security'] ?? '',
    /max-age=31536000/,
    'forwarded HTTPS requests must carry HSTS',
  );

  const demoResponse = await fetch(new URL('/demo/', originBase));
  assert.equal(demoResponse.status, 200, 'demo: expected 200');
  assert.equal(demoResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(demoResponse.headers.get('x-robots-tag') ?? '', /noindex/i, 'demo: missing X-Robots-Tag noindex');
  const demoCsp = demoResponse.headers.get('content-security-policy') ?? '';
  assert.match(demoCsp, /script-src[^;]*'self'[^;]*'unsafe-eval'/, 'demo CSP must allow the Emscripten loader');
  assert.match(demoCsp, /script-src[^;]*'wasm-unsafe-eval'/, 'demo CSP must allow same-origin WASM');
  assert.match(demoCsp, /worker-src[^;]*'self'[^;]*blob:/, 'demo CSP must allow same-origin and blob workers');
  assert.match(demoCsp, /connect-src[^;]*'self'[^;]*blob:/, 'demo CSP must allow same-origin and blob fetches');
  assert.match(demoCsp, /media-src[^;]*blob:/, 'demo CSP must allow blob audio');
  assert.match(demoCsp, /frame-ancestors 'none'/, 'demo CSP must prevent framing');
  assert.equal(demoResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(demoResponse.headers.get('cache-control') ?? '', /no-transform/);
  await demoResponse.arrayBuffer();

  const demoScriptPath = new URL(demoScript, `${originBase}/demo/`).pathname;
  const demoScriptResponse = await expectType(
    originBase,
    demoScriptPath,
    'text/javascript; charset=utf-8',
    resolve(root, '.' + decodeURIComponent(demoScriptPath)),
  );
  assert.match(demoScriptResponse.headers.get('x-robots-tag') ?? '', /noindex/, 'demo script must be noindex');

  const wasmPath = '/demo/codec-assets/ffmpeg-core.wasm';
  const wasmResponse = await expectType(
    originBase,
    wasmPath,
    'application/wasm',
    resolve(root, 'demo/codec-assets/ffmpeg-core.wasm'),
  );
  assert.match(wasmResponse.headers.get('content-security-policy') ?? '', /wasm-unsafe-eval/, 'WASM response CSP lacks wasm-unsafe-eval');
  assert.match(wasmResponse.headers.get('x-robots-tag') ?? '', /noindex/, 'WASM response must be noindex');
  for (const file of supplementalWasm) {
    const response = await expectType(originBase, urlPathForFile(file), 'application/wasm', file);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, `${rel(file)} must be noindex`);
  }

  await expectType(originBase, '/', 'text/html; charset=utf-8', resolve(root, 'index.html'));
  const css = allFiles.find(file => file.endsWith('.css'));
  assert.ok(css, 'The generated site has no stylesheet to verify');
  await expectType(originBase, urlPathForFile(css), 'text/css; charset=utf-8', css);
  const svg = allFiles.find(file => file.endsWith('.svg'));
  if (svg) await expectType(originBase, urlPathForFile(svg), 'image/svg+xml', svg);
  const font = allFiles.find(file => file.endsWith('.woff2'));
  if (font) await expectType(originBase, urlPathForFile(font), 'font/woff2', font);

  async function checkSitemapResponse(file) {
    const response = await fetch(new URL(urlPathForFile(file), originBase));
    assert.equal(response.status, 200, `${rel(file)}: expected 200`);
    assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8', `${rel(file)}: wrong content type`);
    assert.match(response.headers.get('cache-control') ?? '', /no-transform/, `${rel(file)}: missing no-transform`);
    const body = await response.text();
    if (!/<sitemapindex\b/i.test(body)) {
      const servedLocs = [...body.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gi)].map(match => decodeEntities(match[1].trim()));
      for (const loc of servedLocs) assert.ok(sitemapLocs.includes(loc), `${rel(file)} is missing or changed ${loc}`);
    }
  }
  await checkSitemapResponse(rootSitemap);
  for (const file of sitemapFiles) {
    if (file === rootSitemap) continue;
    await checkSitemapResponse(file);
  }

  const robotsResponse = await fetch(new URL('/robots.txt', originBase));
  assert.equal(robotsResponse.status, 200, 'robots.txt: expected 200');
  assert.equal(robotsResponse.headers.get('content-type'), 'text/plain; charset=utf-8', 'robots.txt: wrong content type');
  assert.match(robotsResponse.headers.get('cache-control') ?? '', /no-transform/, 'robots.txt: missing no-transform');
  assert.equal((await robotsResponse.text()).trim(), robots.trim());

  for (const path of ['/_astro/', '/demo/codec-assets/']) {
    const response = await fetch(new URL(path, originBase));
    assert.equal(response.status, 404, `${path}: directory listing must not be served`);
    await response.arrayBuffer();
  }

  console.log(
    `Verified ${contentPages.length} indexable pages at ${origin}, ${sitemapLocs.length} sitemap URLs, `
    + `metadata, canonical URLs, internal links and fragments, robots demo crawlability and noindex, `
    + `canonical redirects, 404/traversal behavior, MIME types and security headers.`,
  );
}

try {
  await runHttpChecks();
} finally {
  if (serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    const finished = await Promise.race([exited.then(() => true), wait(5000).then(() => false)]);
    if (!finished) serverProcess.kill('SIGKILL');
  }
}
