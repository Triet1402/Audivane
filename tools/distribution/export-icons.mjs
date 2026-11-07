// Export the Audivane SVG symbol into the raster formats platform packagers
// consume. The SVGs in assets/brand are the only sources; this script never
// downloads artwork or depends on a host SVG toolchain. Chromium is part of the
// existing Playwright development dependency and is used only as a rasterizer.
import { chromium } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "assets/brand/audivane-mark.svg");
const output = path.join(root, "assets/brand/icons");
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  for (const [index, image] of images.entries()) {
    const entry = index * 16;
    entries.writeUInt8(image.size === 256 ? 0 : image.size, entry);
    entries.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
    entries.writeUInt8(0, entry + 2);
    entries.writeUInt8(0, entry + 3);
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(image.bytes.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += image.bytes.length;
  }
  return Buffer.concat([header, entries, ...images.map(image => image.bytes)]);
}

const svg = await fs.readFile(source);
const encoded = svg.toString("base64");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:100%;height:100%}</style><img alt="" src="data:image/svg+xml;base64,${encoded}">`);
  await fs.mkdir(output, { recursive: true });
  const pngs = [];
  for (const size of PNG_SIZES) {
    await page.setViewportSize({ width: size, height: size });
    const bytes = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    const filename = path.join(output, `audivane-${size}.png`);
    await fs.writeFile(filename, bytes);
    if (ICO_SIZES.includes(size)) pngs.push({ size, bytes });
    console.log(`${path.relative(root, filename)} ${size}x${size} ${bytes.length} bytes`);
  }
  const icoPath = path.join(output, "audivane.ico");
  await fs.writeFile(icoPath, ico(pngs));
  console.log(`${path.relative(root, icoPath)} ${pngs.length} sizes ${(await fs.stat(icoPath)).size} bytes`);
} finally {
  await browser.close();
}
