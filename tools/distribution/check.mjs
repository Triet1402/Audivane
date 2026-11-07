import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS, PRODUCT, root, verifyVersionConsistency } from "./config.mjs";

export async function checkDistribution() {
  const { version, license } = await verifyVersionConsistency();
  const missing = [];
  for (const [key, relative] of Object.entries(ICONS)) {
    try {
      const bytes = await fs.readFile(path.join(root, relative));
      if (key.endsWith("png") && bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") missing.push(`${relative}: not a PNG`);
      if (key === "ico" && !(bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1)) missing.push(`${relative}: not an ICO`);
    } catch {
      missing.push(`${relative}: missing`);
    }
  }
  if (missing.length > 0) throw new Error(`Brand icon exports are incomplete:\n- ${missing.join("\n- ")}`);
  const mark = await fs.readFile(path.join(root, "assets/brand/audivane-mark.svg"), "utf8");
  if (/<image\b|href="https?:|url\(https?:/i.test(mark)) throw new Error("Audivane symbol SVG has an external or raster dependency");
  return Object.freeze({ product: PRODUCT.name, version, license, icons: Object.keys(ICONS) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkDistribution(), null, 2));
}
