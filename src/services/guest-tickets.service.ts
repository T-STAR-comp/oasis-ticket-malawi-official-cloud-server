import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { getListingById } from "./listings.service.js";
import {
  buildTicketPdfAttachments,
  buildTicketPdfContext,
  generateTicketPdfBuffer,
} from "./ticket-pdf.service.js";
import {
  sendDelayedTicketApologyEmail,
  sendTicketPurchaseEmail,
} from "./email.service.js";
import { env } from "../config/env.js";
import { log } from "../utils/logger.js";

function guestTicketsPublicUrl() {
  const origin = env.corsOrigins.find((o) => o.startsWith("https://")) ?? env.corsOrigins[0];
  return origin ? `${origin.replace(/\/$/, "")}/guest-tickets` : "/guest-tickets";
}

export async function emailTicketsForOrder(
  orderId: string,
  options?: { delayedApology?: boolean },
): Promise<{ sent: boolean; reason?: string }> {
  const built = await buildTicketPdfAttachments(orderId);
  if (!built.buyerEmail) {
    log.warn("email", "Skipping ticket email — no buyer email on order", { orderId });
    return { sent: false, reason: "missing_buyer_email" };
  }
  if (built.attachments.length === 0) {
    log.warn("email", "Skipping ticket email — no tickets on order", { orderId });
    return { sent: false, reason: "no_tickets" };
  }

  const payload = {
    email: built.buyerEmail,
    buyerName: built.buyerName,
    listingTitle: built.listingTitle,
    ticketCount: built.attachments.length,
    guestTicketsUrl: built.isGuest ? guestTicketsPublicUrl() : undefined,
    attachments: built.attachments,
  };

  const result = options?.delayedApology
    ? await sendDelayedTicketApologyEmail(payload)
    : await sendTicketPurchaseEmail(payload);

  if (result.sent) {
    log.info("email", "Ticket PDF email dispatched", {
      orderId,
      to: built.buyerEmail,
      ticketCount: built.attachments.length,
      isGuest: built.isGuest,
      delayedApology: Boolean(options?.delayedApology),
    });
    return { sent: true };
  }

  const reason = result.disabled ? "email_feature_disabled" : result.logged ? "smtp_unavailable" : "send_failed";
  log.warn("email", "Ticket PDF email not delivered", {
    orderId,
    to: built.buyerEmail,
    reason,
  });
  return { sent: false, reason };
}

export async function lookupGuestTicket(reference: string, email: string) {
  const ref = reference.trim();
  const normalizedEmail = email.trim().toLowerCase();
  if (!ref || !normalizedEmail) throw new Error("Ticket reference and email are required");

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.*, o.contact_email, o.contact_name, o.is_guest,
            l.title AS listing_title, l.kind AS listing_kind,
            l.date_label, l.time_label, l.location, l.event_format,
            l.virtual_meeting_url, l.image_url
     FROM user_tickets ut
     JOIN orders o ON o.id = ut.order_id
     JOIN listings l ON l.id = ut.listing_id
     WHERE ut.reference = :reference
       AND LOWER(o.contact_email) = :email
       AND o.is_guest = 1
     LIMIT 1`,
    { reference: ref, email: normalizedEmail },
  );
  const row = rows[0];
  if (!row) throw new Error("Ticket not found. Check your reference and email.");

  return {
    id: row.id as string,
    reference: row.reference as string,
    qrToken: row.qr_token as string,
    status: row.status as string,
    seatNumber: row.seat_number != null ? Number(row.seat_number) : null,
    tierName: (row.ticket_tier_name as string | null) ?? null,
    amountPaid: Number(row.amount_paid),
    purchasedAt: row.purchased_at as Date,
    buyerName: row.contact_name as string,
    buyerEmail: row.contact_email as string,
    listing: {
      id: row.listing_id as string,
      title: row.listing_title as string,
      kind: row.listing_kind as string,
      eventDate: (row.date_label as string | null) ?? null,
      eventTime: (row.time_label as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      eventFormat: (row.event_format as string | null) ?? "physical",
      virtualMeetingUrl: (row.virtual_meeting_url as string | null) ?? null,
      coverImageUrl: (row.image_url as string | null) ?? null,
    },
  };
}

export async function guestTicketPdf(reference: string, email: string) {
  const ticket = await lookupGuestTicket(reference, email);
  const listing = await getListingById(ticket.listing.id, true);
  if (!listing) throw new Error("Listing not found for this ticket.");

  const ctx = buildTicketPdfContext(
    {
      id: ticket.id,
      reference: ticket.reference,
      qr_token: ticket.qrToken,
      status: ticket.status,
      purchased_at: ticket.purchasedAt,
      seat_number: ticket.seatNumber,
      ticket_tier_name: ticket.tierName,
      amount_paid: ticket.amountPaid,
    },
    listing,
  );
  const buffer = await generateTicketPdfBuffer(ctx);
  return { buffer, filename: `ticket-${ticket.reference}.pdf` };
}
