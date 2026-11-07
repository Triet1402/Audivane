// Provenance gate between website/content/** and the repository's
// engineering docs.
//
// Each public docs page records `source:` (repo-relative path of the
// document its claims come from) and `source_sha256:` (SHA-256 of that
// document at the time the public summary was last reviewed).
//
// Astro's content config calls checkSourceProvenance() whenever the site is
// built or checked, so a change to a source document — scientific claims,
// limits, platform status, license versions — fails the website build until
// the public summary is deliberately re-reviewed. Re-record the pins with
// `npm run sources:pin` afterwards.
//
// CLI: `node src/provenance.mjs check` (default) or `node src/provenance.mjs pin`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const websiteRoot = resolve(here, "..");
const repoRoot = resolve(websiteRoot, "..");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** @returns {{label: string, path: string, text: string, fm: string}[]} */
function readPages(collection) {
  const dir = join(websiteRoot, "content", collection);
  if (!existsSync(dir)) return [];
  const pages = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const match = FRONTMATTER.exec(text);
    pages.push({
      label: `${collection}/${file}`,
      path,
      text,
      fm: match ? match[1] : "",
      hasFrontmatter: Boolean(match),
    });
  }
  return pages;
}

/** @param {string} path @returns {string} */
function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verifies every docs page's `source:`/`source_sha256:` pins against the
 * current repository documents. Throws with an actionable report on drift.
 * @param {{throwOnError?: boolean}} [options]
 * @returns {string[]} problems (empty when everything is pinned and current)
 */
export function checkSourceProvenance(options = {}) {
  const throwOnError = options.throwOnError !== false;
  /** @type {string[]} */
  const problems = [];
  // Docs pages carry scientific/product claims and are pinned. Guides
  // summarize workflow copy and record `source:` for review context only.
  for (const page of readPages("docs")) {
    if (!page.hasFrontmatter) {
      problems.push(`${page.label}: missing frontmatter`);
      continue;
    }
    const source = /^source:[ \t]*(\S+)[ \t]*$/m.exec(page.fm)?.[1];
    if (!source) {
      problems.push(`${page.label}: frontmatter needs a source: reference`);
      continue;
    }
    const sourcePath = join(repoRoot, source);
    if (!existsSync(sourcePath)) {
      problems.push(`${page.label}: source ${source} not found in the repository`);
      continue;
    }
    const recorded = /^source_sha256:[ \t]*([0-9a-f]{64})[ \t]*$/m.exec(page.fm)?.[1];
    const actual = hashFile(sourcePath);
    if (!recorded) {
      problems.push(
        `${page.label}: no source_sha256 pin for ${source} — review the page, then npm run sources:pin`,
      );
    } else if (recorded !== actual) {
      problems.push(
        `${page.label}: source ${source} changed since the last review\n    recorded ${recorded}\n    actual   ${actual}\n    Re-read ${source}, update this page if claims moved, then npm run sources:pin`,
      );
    }
  }
  if (throwOnError && problems.length > 0) {
    throw new Error(
      `Website source provenance check failed:\n- ${problems.join("\n- ")}`,
    );
  }
  return problems;
}

/**
 * Rewrites (or inserts) `source_sha256:` for every pinned docs page from the
 * current source file. Only run after the summaries were reviewed.
 * @returns {string[]} pinned page labels
 */
export function pinSourceProvenance() {
  /** @type {string[]} */
  const pinned = [];
  for (const page of readPages("docs")) {
    const source = /^source:[ \t]*(\S+)[ \t]*$/m.exec(page.fm)?.[1];
    if (!source) continue;
    const sourcePath = join(repoRoot, source);
    if (!existsSync(sourcePath)) {
      throw new Error(`${page.label}: source ${source} not found; refusing to pin`);
    }
    const hash = hashFile(sourcePath);
    let text = page.text;
    if (/^source_sha256:[ \t]*[0-9a-f]{64}[ \t]*$/m.test(text)) {
      text = text.replace(/^(source_sha256:[ \t]*)[0-9a-f]{64}[ \t]*$/m, `$1${hash}`);
    } else {
      text = text.replace(
        /^(source:[ \t]*\S+[ \t]*)$/m,
        (_m, p1) => `${p1}\nsource_sha256: ${hash}`,
      );
    }
    writeFileSync(page.path, text);
    pinned.push(page.label);
  }
  return pinned;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const mode = process.argv[2] ?? "check";
  if (mode === "pin") {
    for (const label of pinSourceProvenance()) console.log(`pinned ${label}`);
  } else {
    checkSourceProvenance();
    console.log("Source provenance up to date.");
  }
}
