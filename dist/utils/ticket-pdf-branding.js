import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
export const BRAND_RGB = [63, 169, 245];
export const PAGE_BG = "#f4f4f5";
export const CARD_BG = "#ffffff";
export const MARGIN_MM = 16;
const mm = (value) => (value * 72) / 25.4;
const PATTERN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "signature-pattern.png");
let patternCache = null;
async function loadPatternTiles() {
    const raw = await fs.readFile(PATTERN_PATH);
    const tileWidthPx = 120;
    const tileHeightPx = 220;
    const grey = await sharp(raw)
        .resize(tileWidthPx, tileHeightPx, { fit: "cover" })
        .grayscale()
        .modulate({ brightness: 1.12 })
        .png()
        .toBuffer();
    const blue = await sharp(raw)
        .resize(tileWidthPx, tileHeightPx, { fit: "cover" })
        .grayscale()
        .tint({ r: BRAND_RGB[0], g: BRAND_RGB[1], b: BRAND_RGB[2] })
        .modulate({ brightness: 1.05 })
        .png()
        .toBuffer();
    return {
        grey,
        blue,
        tileWidthPt: mm(32),
        tileHeightPt: mm(58),
    };
}
export async function getPatternTiles() {
    if (!patternCache)
        patternCache = loadPatternTiles();
    return patternCache;
}
export function tilePattern(doc, tile, x, y, width, height, tileW, tileH, opacity = 0.12) {
    doc.save();
    doc.opacity(opacity);
    for (let rowY = y; rowY < y + height; rowY += tileH) {
        for (let colX = x; colX < x + width; colX += tileW) {
            doc.image(tile, colX, rowY, { width: tileW, height: tileH });
        }
    }
    doc.opacity(1);
    doc.restore();
}
export function drawPatternPageBackground(doc, pageW, pageH, tiles) {
    doc.rect(0, 0, pageW, pageH).fill(PAGE_BG);
    tilePattern(doc, tiles.grey, 0, 0, pageW, pageH, tiles.tileWidthPt, tiles.tileHeightPt, 0.025);
    const sideW = mm(12);
    tilePattern(doc, tiles.grey, 0, 0, sideW, pageH, tiles.tileWidthPt, tiles.tileHeightPt, 0.06);
    tilePattern(doc, tiles.grey, pageW - sideW, 0, sideW, pageH, tiles.tileWidthPt, tiles.tileHeightPt, 0.06);
}
export function drawPatternHeader(doc, pageW, margin, tiles) {
    const headerH = mm(28);
    doc.rect(0, 0, pageW, headerH).fill(BRAND_RGB);
    tilePattern(doc, tiles.blue, pageW * 0.45, 0, pageW * 0.55, headerH, tiles.tileWidthPt, tiles.tileHeightPt, 0.1);
    tilePattern(doc, tiles.grey, margin, 0, pageW * 0.35, headerH, tiles.tileWidthPt, tiles.tileHeightPt, 0.04);
    doc.fillColor("#ffffff");
    doc.font("Helvetica-Bold").fontSize(18);
    doc.text("Ticket Malawi", margin, mm(10));
    doc.font("Helvetica").fontSize(10);
    doc.text("Official e-ticket", margin, mm(10), {
        width: pageW - margin * 2,
        align: "right",
    });
}
export function drawContentCard(doc, x, y, width, height, tiles) {
    doc.save();
    doc.roundedRect(x, y, width, height, mm(4)).fill(CARD_BG);
    doc.restore();
    doc.save();
    doc.roundedRect(x, y, width, height, mm(4)).lineWidth(0.75).strokeColor("#e4e4e7").stroke();
    doc.restore();
    tilePattern(doc, tiles.grey, x + mm(2), y + height - mm(28), width - mm(4), mm(26), tiles.tileWidthPt, tiles.tileHeightPt, 0.03);
}
export function drawPatternAccentBand(doc, x, y, width, height, tiles, variant = "blue") {
    const tile = variant === "blue" ? tiles.blue : tiles.grey;
    doc.save();
    doc.roundedRect(x, y, width, height, mm(2)).fill(variant === "blue" ? BRAND_RGB : "#ececee");
    tilePattern(doc, tile, x, y, width, height, tiles.tileWidthPt, tiles.tileHeightPt, variant === "blue" ? 0.12 : 0.07);
    doc.restore();
}
export function drawOperatorPanel(doc, x, y, width, height, tiles) {
    doc.roundedRect(x, y, width, height, mm(3)).fill("#1e1e1e");
    tilePattern(doc, tiles.blue, x, y, mm(10), height, tiles.tileWidthPt, tiles.tileHeightPt, 0.14);
    tilePattern(doc, tiles.grey, x + mm(10), y, width - mm(10), height, tiles.tileWidthPt, tiles.tileHeightPt, 0.04);
}
export { mm };
