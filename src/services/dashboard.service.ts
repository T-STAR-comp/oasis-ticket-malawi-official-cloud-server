import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool, type QueryParams } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { getListingById } from "./listings.service.js";
import {
  assertVirtualTicketTransferAllowed,
  getVirtualAccessState,
  getVirtualSessionAccessState,
} from "../utils/virtual-events.js";
import { syncVirtualTicketStatus } from "./ticket-expiry.service.js";
import {
  listEnrolledVirtualSessions,
  listListingVirtualSessions,
  type VirtualSessionRow,
} from "./virtual-session-checkout.service.js";

function isMissingTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("doesn't exist") || err.message.includes("Unknown table"))
  );
}

const BASE_TICKETS_SQL = `
    SELECT ut.*, l.title, l.category, l.date_label, l.time_label, l.kind, l.image_url,
           l.operator_name, l.location, l.organizer_id, l.status AS listing_status,
           l.event_starts_on, l.event_format, l.virtual_meeting_url, l.virtual_duration_minutes,
           l.virtual_event_type, l.virtual_buy_mode, l.virtual_pricing_mode,
           ut.ticket_tier_name,
           op.status AS organizer_status, op.flagged_at, op.flag_reason,
           op.suspension_reason
    FROM user_tickets ut
    JOIN listings l ON l.id = ut.listing_id
    JOIN organizer_profiles op ON op.user_id = l.organizer_id`;

const EXTENDED_TICKETS_SQL = `
    SELECT ut.*, l.title, l.category, l.date_label, l.time_label, l.kind, l.image_url,
           l.operator_name, l.location, l.organizer_id, l.status AS listing_status,
           l.event_starts_on, l.event_format, l.virtual_meeting_url, l.virtual_duration_minutes,
           l.virtual_event_type, l.virtual_buy_mode, l.virtual_pricing_mode,
           ut.ticket_tier_name,
           op.status AS organizer_status, op.flagged_at, op.flag_reason,
           op.suspension_reason,
           rl_active.id AS resell_listing_id,
           rl_active.price_mwk AS resell_price_mwk,
           EXISTS (
             SELECT 1 FROM ticket_refunds tr
             WHERE tr.user_ticket_id = ut.id AND tr.status = 'pending'
           ) AS refund_pending
    FROM user_tickets ut
    JOIN listings l ON l.id = ut.listing_id
    JOIN organizer_profiles op ON op.user_id = l.organizer_id
    LEFT JOIN resell_listings rl_active
      ON rl_active.user_ticket_id = ut.id AND rl_active.status = 'active'`;

async function queryUserTicketRows(
  userId: string,
  filters?: { status?: "active" | "used" | "expired"; ticketId?: string },
): Promise<RowDataPacket[]> {
  const params: QueryParams = { userId };
  let sql = EXTENDED_TICKETS_SQL;
  sql += ` WHERE ut.user_id = :userId`;
  if (filters?.status) {
    sql += ` AND ut.status = :status`;
    params.status = filters.status;
  }
  if (filters?.ticketId) {
    sql += ` AND ut.id = :ticketId`;
    params.ticketId = filters.ticketId;
  }
  sql += ` ORDER BY ut.purchased_at DESC`;

  try {
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return rows;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    let fallbackSql = BASE_TICKETS_SQL + ` WHERE ut.user_id = :userId`;
    if (filters?.status) fallbackSql += ` AND ut.status = :status`;
    if (filters?.ticketId) fallbackSql += ` AND ut.id = :ticketId`;
    fallbackSql += ` ORDER BY ut.purchased_at DESC`;
    const [rows] = await pool.query<RowDataPacket[]>(fallbackSql, params);
    return rows.map((row) => ({
      ...row,
      refund_pending: 0,
      resell_listing_id: null,
      resell_price_mwk: null,
    })) as RowDataPacket[];
  }
}

function mapVirtualSessionAccess(session: VirtualSessionRow, ticketStatus: string) {
  const access = getVirtualSessionAccessState({
    startsAt: session.starts_at,
    endsAt: session.ends_at,
    meetingUrl: session.meeting_url,
    ticketStatus,
    sessionStatus: session.status,
  });
  return {
    id: session.id,
    title: session.title,
    startsAt: access.startsAt,
    endsAt: access.accessClosesAt,
    meetingUrl:
      access.canAccessLink && session.meeting_url ? String(session.meeting_url) : undefined,
    canAccessLink: access.canAccessLink,
    sessionEnded: access.sessionEnded,
    message: access.message,
    status: session.status,
    priceMwk: Number(session.price_mwk ?? 0),
  };
}

async function resolvePurchasedVirtualSessions(
  row: RowDataPacket,
  ticketStatus: string,
) {
  const eventFormat = String(row.event_format ?? "physical");
  const virtualEventType = String(row.virtual_event_type ?? "one_time");
  if (eventFormat !== "virtual" || virtualEventType !== "ongoing") return undefined;

  let enrolled = await listEnrolledVirtualSessions(String(row.id));
  const buyMode = String(row.virtual_buy_mode ?? "bundle_only");
  if (enrolled.length === 0 && buyMode === "bundle_only") {
    enrolled = await listListingVirtualSessions(String(row.listing_id));
  }

  if (enrolled.length === 0) return [];

  return enrolled
    .filter((session) => session.status !== "cancelled")
    .map((session) => mapVirtualSessionAccess(session, ticketStatus));
}

function mapUserTicketRow(r: RowDataPacket, enrolledVirtualSessions?: Awaited<ReturnType<typeof resolvePurchasedVirtualSessions>>) {
    const organizerRestricted = ["suspended", "banned", "inactive"].includes(
      String(r.organizer_status),
    );
    const listingPostponed = String(r.listing_status) === "postponed";
    const listingCancelled = String(r.listing_status) === "cancelled";
    const postponedMessage =
      listingPostponed && r.status === "active"
        ? `This ${r.kind === "travel" ? "trip" : "event"} has been postponed to ${r.date_label}${r.time_label ? ` · ${r.time_label}` : ""}. Your ticket is valid for the new date.`
        : undefined;
    const refundPending = Boolean(r.refund_pending);
    const cancelledMessage = listingCancelled
      ? `This ${r.kind === "travel" ? "trip" : "event"} was cancelled by the organizer. Your ticket is no longer valid. Eligible purchases receive a 90% refund by email; 10% covers processing and convenience fees.`
      : undefined;
    const refundPendingMessage = refundPending
      ? "A refund is being processed for this ticket. Sharing is disabled until the refund completes."
      : undefined;

    const eventFormat = String(r.event_format ?? "physical");
    const isVirtual =
      eventFormat === "virtual" ||
      Boolean(String(r.virtual_meeting_url ?? "").trim());
    const virtualAccess = getVirtualAccessState({
      eventFormat: isVirtual ? "virtual" : eventFormat,
      eventStartsOn: r.event_starts_on as string | null,
      timeLabel: String(r.time_label ?? ""),
      virtualDurationMinutes: r.virtual_duration_minutes != null ? Number(r.virtual_duration_minutes) : null,
      ticketStatus: String(r.status),
    });

    const virtualMeetingUrl =
      isVirtual &&
      virtualAccess.canAccessLink &&
      r.virtual_meeting_url &&
      (!enrolledVirtualSessions || enrolledVirtualSessions.length === 0)
        ? String(r.virtual_meeting_url)
        : undefined;

    return {
    id: r.id,
    ticketId: r.listing_id,
    reference: r.reference,
    qrToken: r.qr_token,
    status: r.status,
    purchasedOn: r.purchased_at,
    seat: r.seat_number ? String(r.seat_number) : undefined,
    ticketTierName: r.ticket_tier_name ? String(r.ticket_tier_name) : undefined,
    amountPaid: r.amount_paid,
    organizerRestricted,
    organizerFlagged: r.flagged_at != null,
    organizerStatus: r.organizer_status,
    listingStatus: r.listing_status,
    listingPostponed,
    listingCancelled,
    refundPending,
    holdMessage: refundPendingMessage
      ?? (organizerRestricted
        ? "There are issues with this organizer. Your ticket will be available once the issues are cleared."
        : cancelledMessage ?? postponedMessage),
    resellListing: r.resell_listing_id
      ? {
          id: String(r.resell_listing_id),
          priceMwk: Number(r.resell_price_mwk),
        }
      : undefined,
    ticket: {
      title: r.title,
      category: r.category,
      date: r.date_label,
      kind: r.kind,
      image: r.image_url,
      operator: { name: r.operator_name },
      location: r.location,
      eventFormat,
      time: r.time_label ? String(r.time_label) : undefined,
      eventStartsOn: r.event_starts_on ? String(r.event_starts_on).slice(0, 10) : undefined,
      virtualDurationMinutes:
        r.virtual_duration_minutes != null ? Number(r.virtual_duration_minutes) : undefined,
    },
    virtualMeetingUrl,
    virtualAccess,
    enrolledVirtualSessions,
  };
}

export async function getUserTickets(userId: string, status?: "active" | "used" | "expired") {
  const rows = await queryUserTicketRows(userId, status ? { status } : undefined);
  const results = [];
  for (const r of rows) {
    const syncedStatus = await syncVirtualTicketStatus({
      id: String(r.id),
      listing_id: String(r.listing_id),
      status: String(r.status),
      event_format: r.event_format as string | null,
      virtual_event_type: r.virtual_event_type as string | null,
      virtual_buy_mode: r.virtual_buy_mode as string | null,
      virtual_meeting_url: r.virtual_meeting_url as string | null,
      event_starts_on: r.event_starts_on as string | null,
      time_label: r.time_label as string | null,
      virtual_duration_minutes: r.virtual_duration_minutes as number | null,
    });
    results.push(
      mapUserTicketRow(
        { ...r, status: syncedStatus },
        await resolvePurchasedVirtualSessions({ ...r, status: syncedStatus }, syncedStatus),
      ),
    );
  }
  return results;
}

export async function getUserTicketDetail(userId: string, ticketId: string) {
  const rows = await queryUserTicketRows(userId, { ticketId });
  const raw = rows[0];
  if (!raw) return null;

  const syncedStatus = await syncVirtualTicketStatus({
    id: String(raw.id),
    listing_id: String(raw.listing_id),
    status: String(raw.status),
    event_format: raw.event_format as string | null,
    virtual_event_type: raw.virtual_event_type as string | null,
    virtual_buy_mode: raw.virtual_buy_mode as string | null,
    virtual_meeting_url: raw.virtual_meeting_url as string | null,
    event_starts_on: raw.event_starts_on as string | null,
    time_label: raw.time_label as string | null,
    virtual_duration_minutes: raw.virtual_duration_minutes as number | null,
  });
  const purchase = mapUserTicketRow(
    { ...raw, status: syncedStatus },
    await resolvePurchasedVirtualSessions({ ...raw, status: syncedStatus }, syncedStatus),
  );

  const listing = await getListingById(purchase.ticketId, true);
  if (!listing) return null;
  return { purchase, listing };
}

export async function getSpendingSummary(userId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_paid), 0) AS total FROM user_tickets WHERE user_id = :userId`,
    { userId },
  );
  return { totalSpent: Number(rows[0]?.total ?? 0), purchaseCount: Number(rows[0]?.count ?? 0) };
}

async function findCustomerRecipientByEmail(email: string, excludeUserId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, email, full_name, phone, role, status
     FROM users
     WHERE LOWER(email) = LOWER(:email)
       AND id != :excludeUserId
       AND role = 'customer'
       AND status = 'active'
     LIMIT 1`,
    { email, excludeUserId },
  );
  return rows[0] ?? null;
}

export async function lookupShareRecipient(sharerUserId: string, recipientEmail: string) {
  const normalized = recipientEmail.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("Enter a valid email address");
  }

  const [sharerRows] = await pool.query<RowDataPacket[]>(
    `SELECT email FROM users WHERE id = :sharerUserId`,
    { sharerUserId },
  );
  if (sharerRows[0]?.email?.toLowerCase() === normalized) {
    throw new Error("You cannot share a ticket with yourself");
  }

  const recipient = await findCustomerRecipientByEmail(normalized, sharerUserId);
  if (!recipient) {
    throw new Error(
      "No customer account found with this email. They must sign up as a customer (not organizer) before you can share.",
    );
  }

  return {
    userId: recipient.id as string,
    email: recipient.email as string,
    fullName: recipient.full_name as string,
    phone: (recipient.phone as string | null) ?? undefined,
  };
}

export async function shareTicket(
  sharerUserId: string,
  userTicketId: string,
  recipientEmail: string,
) {
  const recipient = await lookupShareRecipient(sharerUserId, recipientEmail);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [ticketRows] = await conn.query<RowDataPacket[]>(
      `SELECT ut.*, u.full_name AS owner_name, u.email AS owner_email,
              l.title AS listing_title, l.date_label,
              l.event_format, l.event_starts_on, l.time_label
       FROM user_tickets ut
       JOIN users u ON u.id = ut.user_id
       JOIN listings l ON l.id = ut.listing_id
       WHERE ut.id = :userTicketId AND ut.user_id = :sharerUserId AND ut.status = 'active'
       FOR UPDATE`,
      { userTicketId, sharerUserId },
    );
    const ticket = ticketRows[0];
    if (!ticket) {
      throw new Error("Ticket not found or is no longer active");
    }

    const [pendingRefund] = await conn.query<RowDataPacket[]>(
      `SELECT 1 FROM ticket_refunds
       WHERE user_ticket_id = :userTicketId AND status = 'pending'
       LIMIT 1`,
      { userTicketId },
    );
    if (pendingRefund.length > 0) {
      throw new Error(
        "This ticket has a refund in progress. Sharing is disabled until the refund completes.",
      );
    }

    const [activeResell] = await conn.query<RowDataPacket[]>(
      `SELECT 1 FROM resell_listings
       WHERE user_ticket_id = :userTicketId AND status = 'active'
       LIMIT 1`,
      { userTicketId },
    );
    if (activeResell.length > 0) {
      throw new Error(
        "This ticket is listed for resale. Cancel the listing before sharing.",
      );
    }

    assertVirtualTicketTransferAllowed({
      eventFormat: ticket.event_format,
      eventStartsOn: ticket.event_starts_on,
      timeLabel: ticket.time_label,
    });

    await conn.query(
      `UPDATE user_tickets SET user_id = :recipientId WHERE id = :userTicketId`,
      { recipientId: recipient.userId, userTicketId },
    );

    if (ticket.seat_number != null && ticket.listing_id) {
      await conn.query(
        `UPDATE seats s
         JOIN seat_layouts sl ON sl.id = s.layout_id
         SET s.customer_name = :recipientName
         WHERE sl.listing_id = :listingId AND s.seat_number = :seatNumber`,
        {
          recipientName: recipient.fullName,
          listingId: ticket.listing_id,
          seatNumber: ticket.seat_number,
        },
      );
    }

    const shareId = uuid();
    await conn.query(
      `INSERT INTO ticket_shares (
        id, user_ticket_id, shared_by_user_id, recipient_email, status
      ) VALUES (
        :shareId, :userTicketId, :sharerUserId, :recipientEmail, 'accepted'
      )`,
      {
        shareId,
        userTicketId,
        sharerUserId,
        recipientEmail: recipient.email,
      } satisfies QueryParams,
    );

    await conn.commit();

    const ticketTitle = String(ticket.listing_title ?? "Ticket");
    const reference = String(ticket.reference);
    const sharerName = String(ticket.owner_name);
    const sharerEmail = String(ticket.owner_email);

    try {
      await Promise.all([
        emailService.sendTicketSharedToRecipientEmail({
          recipientEmail: recipient.email,
          recipientName: recipient.fullName,
          sharerName,
          ticketTitle,
          reference,
          eventDate: ticket.date_label ? String(ticket.date_label) : undefined,
          seat: ticket.seat_number != null ? String(ticket.seat_number) : undefined,
        }),
        emailService.sendTicketSharedBySenderEmail({
          sharerEmail,
          sharerName,
          recipientName: recipient.fullName,
          recipientEmail: recipient.email,
          ticketTitle,
          reference,
        }),
      ]);
    } catch (err) {
      console.error("[email] ticket share notifications failed:", err);
    }

    return {
      shareId,
      transferred: true,
      recipient: {
        userId: recipient.userId,
        email: recipient.email,
        fullName: recipient.fullName,
      },
      message: `Ticket shared successfully with ${recipient.fullName}.`,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getPaymentMethods(userId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM payment_methods WHERE user_id = :userId ORDER BY is_default DESC`,
    { userId },
  );
  return rows;
}
