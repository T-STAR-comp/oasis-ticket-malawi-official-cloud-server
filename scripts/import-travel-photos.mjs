import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir =
  "C:/Users/SAMUEL CHILINDA/.cursor/projects/c-Users-SAMUEL-CHILINDA-Desktop-OasisComps-ticket-malawi/assets";
const outDir = path.resolve(__dirname, "../../ticket-malawi-app/public/photos");

const pairs = [
  [
    "c__Users_SAMUEL_CHILINDA_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_pexels-trynado-3608967-c8e939f0-4f4c-4c03-aec5-4b47b4eb72f9.png",
    "pexels-trynado-3608967.jpg",
  ],
  [
    "c__Users_SAMUEL_CHILINDA_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_pexels-proudlyswazi-37145523-d6e16798-bc95-41c5-a9a6-44596d38d7aa.png",
    "pexels-proudlyswazi-37145523.jpg",
  ],
];

for (const [srcName, destName] of pairs) {
  const input = path.join(assetsDir, srcName);
  const output = path.join(outDir, destName);
  const display = path.join(outDir, destName.replace(/\.jpe?g$/i, "-display.jpg"));
  const buffer = fs.readFileSync(input);
  await sharp(buffer)
    .rotate()
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(output);
  await sharp(buffer)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(display);
  console.log(`imported ${destName}`);
}
