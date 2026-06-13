/**
 * Build 1600px-wide display copies of marketing photos in app/public/photos.
 * Run: npm run photos:optimize
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photosDir = path.resolve(__dirname, "../../ticket-malawi-app/public/photos");

if (!fs.existsSync(photosDir)) {
  console.error(`[photos] Missing directory: ${photosDir}`);
  process.exit(1);
}

const sources = fs
  .readdirSync(photosDir)
  .filter((name) => /\.jpe?g$/i.test(name) && !/-display\.jpe?g$/i.test(name))
  .sort();

if (sources.length === 0) {
  console.error("[photos] No JPEG sources found in public/photos");
  process.exit(1);
}

for (const name of sources) {
  const input = path.join(photosDir, name);
  const output = path.join(photosDir, name.replace(/\.jpe?g$/i, "-display.jpg"));
  await sharp(input)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(output);
  console.log(`wrote ${path.basename(output)}`);
}

console.log(`[photos] Optimized ${sources.length} image(s)`);
