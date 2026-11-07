import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PRODUCT, readRootManifest, releaseDirectory, root } from "./config.mjs";

export async function sha256File(filename) {
  const bytes = await fs.readFile(filename);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write the release manifest and SHA256SUMS beside actual artifacts. Paths in
 * the manifest are artifact basenames only; no checkout or build-host path is
 * recorded. Publication remains explicitly "not published".
 */
export function manifestFilenames(platform) {
  const suffix = platform === "win32" ? "windows" : platform;
  return {
    manifest: `release-manifest-${suffix}.json`,
    sums: `SHA256SUMS-${suffix}.txt`,
  };
}

export async function writeReleaseManifest({ artifacts, platform, nativeBundle, notes = [], directory: requestedDirectory }) {
  const workspace = await readRootManifest();
  const directory = path.resolve(requestedDirectory ?? releaseDirectory());
  await fs.mkdir(directory, { recursive: true });
  const records = [];
  const seen = new Set();
  for (const artifact of artifacts.filter(Boolean).sort((a, b) => a.localeCompare(b))) {
    const absolute = path.resolve(artifact);
    if (path.dirname(absolute) !== path.resolve(directory)) {
      throw new Error(`Release artifact is outside the release directory: ${absolute}`);
    }
    const file = path.basename(absolute);
    if (seen.has(file)) throw new Error(`Release artifact is listed twice: ${file}`);
    seen.add(file);
    const bytes = await fs.readFile(absolute);
    records.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const names = manifestFilenames(platform);
  const sums = records.map(record => `${record.sha256}  ${record.file}`).join("\n");
  await fs.writeFile(path.join(directory, names.sums), `${sums}\n`);
  const manifest = {
    schema: "audivane-release-manifest-v1",
    product: PRODUCT.name,
    subtitle: PRODUCT.subtitle,
    version: workspace.version,
    license: workspace.license,
    platform,
    publication: "not published",
    generatedAt: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    artifacts: records,
    nativeBundle: nativeBundle ?? null,
    notices: ["LICENSE", "THIRD_PARTY_NOTICES.md", "packages/measurements/NOTICE.md", "Electron LICENSE", "LICENSES.chromium.html"],
    notes,
  };
  await fs.writeFile(path.join(directory, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({ manifest, sumsPath: path.join(directory, names.sums), manifestPath: path.join(directory, names.manifest), root });
}
