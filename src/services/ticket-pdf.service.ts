import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import sharp from "sharp";
import type { RowDataPacket } from "mysql2";
import {
  buildPublicImageUrl,
  imagePathToAbsoluteFile,
  IMAGE_BUCKET_URL_PREFIX,
} from "../config/images.js";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { getListingById } from "./listings.service.js";
import {
  BRAND_RGB,
  drawContentCard,
  drawOperatorPanel,
  drawPatternAccentBand,
  drawPatternHeader,
  drawPatternPageBackground,
  getPatternTiles,
  mm,
} from "../utils/ticket-pdf-branding.js";

const BANNER_HEIGHT_MM = 45;

const LEGACY_IMAGE_MAP: Record<string, string> = {
  "/assets/event-lakeofstars.jpg": "/photos/pexels-kelly-17290956.jpg",
  "/assets/event-afrobeats.jpg": "/photos/pexels-jibarofoto-3727148.jpg",
  "/assets/event-artsummit.jpg": "/photos/pexels-jibarofoto-14017606.jpg",
  "/assets/travel-bus.jpg": "/photos/pexels-trynado-3608967.jpg",
  "/assets/travel-bus-interior.jpg": "/photos/pexels-proudlyswazi-37145523.jpg",
  "/assets/travel-lakeshore.jpg": "/photos/pexels-proudlyswazi-37145523.jpg",
};

function apiOrigin(): string {
  const configured = env.images.publicOrigin.trim();
  if (configured) return configured.replace(/\/$/, "");
  const origin = env.corsOrigins.find((o) => o.startsWith("http"));
  return (origin ?? "http://localhost:8000").replace(/\/$/, "");
}

function formatMWK(amount: number): string {
  return `MWK ${amount.toLocaleString("en-MW")}`;
}

function formatPurchasedOn(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function resolveListingImageUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl?.trim()) return null;
  const url = imageUrl.trim();
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/photos/")) return `${apiOrigin()}${url}`;
  if (url.includes(IMAGE_BUCKET_URL_PREFIX) || url.startsWith("/image-bucket-folder")) {
    if (env.images.publicOrigin) return buildPublicImageUrl(url);
    const pathPart = url.startsWith("/") ? url : `${IMAGE_BUCKET_URL_PREFIX}/${url}`;
    return `${apiOrigin()}${pathPart}`;
  }
  if (LEGACY_IMAGE_MAP[url]) return `${apiOrigin()}${LEGACY_IMAGE_MAP[url]}`;
  return url.startsWith("/") ? `${apiOrigin()}${url}` : url;
}

async function readImageBytes(imageUrl: string): Promise<Buffer | null> {
  const localPath = imagePathToAbsoluteFile(imageUrl);
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      /* fall through */
    }
  }

  const resolved = resolveListingImageUrl(imageUrl);
  if (!resolved) return null;

  if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
    try {
      const res = await fetch(resolved);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  if (resolved.startsWith("/")) {
    const publicRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "public",
      "client",
    );
    try {
      return await fs.readFile(path.join(publicRoot, resolved.replace(/^\//, "")));
    } catch {
      return null;
    }
  }

  return null;
}

async function loadCoverBannerBuffer(
  imageUrl: string | null | undefined,
  bannerWidthPt: number,
  bannerHeightPt: number,
): Promise<Buffer | null> {
  if (!imageUrl?.trim()) return null;
  const raw = await readImageBytes(imageUrl);
  if (!raw) return null;

  const pixelWidth = 1260;
  const pixelHeight = Math.max(1, Math.round(pixelWidth * (bannerHeightPt / bannerWidthPt)));

  try {
    const image = sharp(raw);
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return null;

    const scale = Math.max(pixelWidth / meta.width, pixelHeight / meta.height);
    const resizedWidth = Math.ceil(meta.width * scale);
    const resizedHeight = Math.ceil(meta.height * scale);
    const left = Math.max(0, Math.floor((resizedWidth - pixelWidth) / 2));
    const top = Math.max(0, Math.floor((resizedHeight - pixelHeight) / 2));

    return image
      .resize(resizedWidth, resizedHeight, { fit: "fill" })
      .extract({ left, top, width: pixelWidth, height: pixelHeight })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return null;
  }
}

export type TicketPdfContext = {
  ticketId: string;
  reference: string;
  qrToken: string;
  status: string;
  purchasedOn: string;
  seat?: string;
  ticketTierName?: string;
  amountPaid: number;
  listing: {
    kind: string;
    category: string;
    title: string;
    subtitle?: string;
    date: string;
    time: string;
    location: string;
    description?: string;
    image?: string;
    operator: {
      name: string;
      tagline?: string;
      detail?: string;
    };
  };
};

function ticketQrPayload(ctx: TicketPdfContext): string {
  return JSON.stringify({
    ref: ctx.reference,
    token: ctx.qrToken,
    id: ctx.ticketId,
  });
}

export async function generateTicketPdfBuffer(ctx: TicketPdfContext): Promise<Buffer> {
  const pageW = mm(210);
  const pageH = mm(297);
  const margin = mm(16);
  const contentW = pageW - margin * 2;
  const cardY = mm(34);
  const cardH = pageH - cardY - mm(10);
  const innerX = margin + mm(4);
  const innerW = contentW - mm(8);
  const bannerW = innerW;
  const bannerH = mm(BANNER_HEIGHT_MM);
  const tiles = await getPatternTiles();

  const bannerBuffer = await loadCoverBannerBuffer(ctx.listing.image, bannerW, bannerH);

  let qrBuffer: Buffer | null = null;
  if (ctx.status === "active" && ctx.qrToken) {
    const qrDataUrl = await QRCode.toDataURL(ticketQrPayload(ctx), { width: 220, margin: 1 });
    const qrBase64 = qrDataUrl.split(",")[1] ?? "";
    qrBuffer = Buffer.from(qrBase64, "base64");
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawPatternPageBackground(doc, pageW, pageH, tiles);
    drawPatternHeader(doc, pageW, margin, tiles);
    drawContentCard(doc, margin, cardY, contentW, cardH, tiles);

    let y = cardY + mm(8);

    doc.font("Helvetica").fontSize(9).fillColor(BRAND_RGB);
    doc.text(ctx.listing.category.toUpperCase(), innerX, y);
    y += mm(8);

    doc.fillColor("#141414");
    doc.font("Helvetica-Bold").fontSize(16);
    const titleHeight = doc.heightOfString(ctx.listing.title, { width: innerW });
    doc.text(ctx.listing.title, innerX, y, { width: innerW });
    y += titleHeight + mm(2);

    if (ctx.listing.subtitle?.trim()) {
      doc.font("Helvetica").fontSize(11).fillColor("#646464");
      doc.text(ctx.listing.subtitle, innerX, y);
      y += mm(8);
    }

    if (bannerBuffer) {
      drawPatternAccentBand(doc, innerX, y - mm(1), bannerW, bannerH + mm(2), tiles, "grey");
      doc.image(bannerBuffer, innerX, y, { width: bannerW, height: bannerH });
      y += bannerH + mm(8);
    }

    const venueLabel = ctx.listing.kind === "travel" ? "Route" : "Venue";
    const fields: Array<[string, string]> = [
      ["Reference", ctx.reference],
      ["Status", ctx.status],
      ["Purchased", ctx.purchasedOn],
      ["Date", ctx.listing.date],
      ["Time", ctx.listing.time],
      [venueLabel, ctx.listing.location],
      ...(ctx.seat ? ([["Seat", ctx.seat]] as Array<[string, string]>) : []),
      ...(ctx.ticketTierName ? ([["Ticket type", ctx.ticketTierName]] as Array<[string, string]>) : []),
      ["Ticket price", formatMWK(ctx.amountPaid)],
    ];

    doc.roundedRect(innerX, y, innerW, mm(fields.length * 7 + 6), mm(2)).fill("#f8f8fa");
    doc.fontSize(10);
    for (const [label, value] of fields) {
      doc.font("Helvetica-Bold").fillColor("#787878");
      doc.text(label, innerX + mm(4), y);
      doc.font("Helvetica").fillColor("#1e1e1e");
      doc.text(value, innerX + mm(42), y);
      y += mm(7);
    }

    y += mm(6);
    if (ctx.listing.description?.trim()) {
      doc.fontSize(9).fillColor("#505050");
      const descHeight = doc.heightOfString(ctx.listing.description, { width: innerW });
      doc.text(ctx.listing.description, innerX, y, { width: innerW });
      y += descHeight + mm(6);
    }

    if (qrBuffer) {
      const qrSize = mm(42);
      const bandY = y;
      drawPatternAccentBand(doc, innerX, bandY, innerW, qrSize + mm(12), tiles, "blue");
      doc.roundedRect((pageW - qrSize - mm(4)) / 2, bandY + mm(4), qrSize + mm(4), qrSize + mm(4), mm(2)).fill("#ffffff");
      doc.image(qrBuffer, (pageW - qrSize) / 2, bandY + mm(6), { width: qrSize, height: qrSize });
      y = bandY + qrSize + mm(14);
      doc.fontSize(9).fillColor("#ffffff");
      doc.text("Scan at entry", 0, y, { width: pageW, align: "center" });
      y += mm(10);
    }

    const operatorLabel = ctx.listing.kind === "travel" ? "OPERATOR" : "ORGANIZER";
    const boxH = mm(24);
    drawOperatorPanel(doc, innerX, y, innerW, boxH, tiles);
    doc.fontSize(8).fillColor(BRAND_RGB);
    doc.text(operatorLabel, innerX + mm(8), y + mm(5));
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#ffffff");
    doc.text(ctx.listing.operator.name, innerX + mm(8), y + mm(12));
    doc.font("Helvetica").fontSize(9).fillColor("#c8c8c8");
    const detail = ctx.listing.operator.detail?.trim() ?? "";
    if (detail) {
      const detailLine = detail.split("\n")[0] ?? detail;
      doc.text(detailLine, innerX + mm(8), y + mm(18), {
        width: innerW - mm(12),
        height: mm(5),
        ellipsis: true,
      });
    }

    doc.fontSize(8).fillColor("#787878");
    doc.text(
      "This is your official Ticket Malawi e-ticket. Keep it safe and present the QR code at entry.",
      margin,
      pageH - mm(8),
      { width: contentW, align: "center" },
    );

    doc.end();
  });
}

type ListingForPdf = NonNullable<Awaited<ReturnType<typeof getListingById>>>;

export function buildTicketPdfContext(
  ticketRow: {
    id: string;
    reference: string;
    qr_token: string;
    status: string;
    purchased_at: Date | string;
    seat_number?: number | null;
    ticket_tier_name?: string | null;
    amount_paid: number;
  },
  listing: ListingForPdf,
): TicketPdfContext {
  return {
    ticketId: String(ticketRow.id),
    reference: String(ticketRow.reference),
    qrToken: String(ticketRow.qr_token),
    status: String(ticketRow.status),
    purchasedOn: formatPurchasedOn(ticketRow.purchased_at),
    seat: ticketRow.seat_number != null ? String(ticketRow.seat_number) : undefined,
    ticketTierName: ticketRow.ticket_tier_name ? String(ticketRow.ticket_tier_name) : undefined,
    amountPaid: Number(ticketRow.amount_paid),
    listing: {
      kind: String(listing.kind),
      category: String(listing.category),
      title: String(listing.title),
      subtitle: listing.subtitle ? String(listing.subtitle) : undefined,
      date: String(listing.date ?? ""),
      time: String(listing.time ?? ""),
      location: String(listing.location ?? ""),
      description: listing.description ? String(listing.description) : undefined,
      image: listing.image ? String(listing.image) : undefined,
      operator: {
        name: String(listing.operator?.name ?? ""),
        tagline: listing.operator?.tagline ? String(listing.operator.tagline) : undefined,
        detail: listing.operator?.detail ? String(listing.operator.detail) : undefined,
      },
    },
  };
}

export async function loadTicketsForOrderEmail(orderId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.id, ut.reference, ut.qr_token, ut.seat_number, ut.amount_paid, ut.ticket_tier_name,
            ut.status, ut.purchased_at, ut.listing_id,
            o.contact_name, o.contact_email, o.is_guest,
            l.title AS listing_title, l.kind AS listing_kind,
            l.date_label, l.time_label, l.location
     FROM user_tickets ut
     JOIN orders o ON o.id = ut.order_id
     JOIN listings l ON l.id = ut.listing_id
     WHERE ut.order_id = :orderId
     ORDER BY ut.purchased_at ASC`,
    { orderId },
  );
  return rows;
}

export async function buildTicketPdfAttachments(orderId: string) {
  const rows = await loadTicketsForOrderEmail(orderId);
  const attachments: Array<{ filename: string; content: Buffer }> = [];
  for (const row of rows) {
    const listing = await getListingById(String(row.listing_id), true);
    if (!listing) continue;
    const ctx = buildTicketPdfContext(
      {
        id: String(row.id),
        reference: String(row.reference),
        qr_token: String(row.qr_token),
        status: String(row.status),
        purchased_at: row.purchased_at as Date | string,
        seat_number: row.seat_number != null ? Number(row.seat_number) : null,
        ticket_tier_name: row.ticket_tier_name ? String(row.ticket_tier_name) : null,
        amount_paid: Number(row.amount_paid),
      },
      listing,
    );
    const buffer = await generateTicketPdfBuffer(ctx);
    attachments.push({ filename: `ticket-${ctx.reference}.pdf`, content: buffer });
  }
  return {
    attachments,
    buyerName: rows[0] ? String(rows[0].contact_name) : "",
    buyerEmail: rows[0] ? String(rows[0].contact_email) : "",
    listingTitle: rows[0] ? String(rows[0].listing_title) : "your event",
    isGuest: Boolean(rows[0]?.is_guest),
  };
}

export function makeGuestAccessToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function normalizeGuestKey(key: string): string {
  return key.trim().slice(0, 64);
}
