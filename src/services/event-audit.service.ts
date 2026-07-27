import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { getOrganizerSettlementBalances } from "./settlement.service.js";

export type AuditTimelineEntry = {
  id: string;
  kind:
    | "sale"
    | "refund"
    | "payout"
    | "payout_completed"
    | "payout_failed"
    | "settlement";
  at: string;
  amount: number;
  label: string;
  reference?: string;
  listingId?: string;
  listingTitle?: string;
  meta?: Record<string, string | number | null>;
};

export type OrganizerAuditSnapshot = {
  generatedAt: string;
  settlement: Awaited<ReturnType<typeof getOrganizerSettlementBalances>>;
  summary: {
    grossRevenue: number;
    ticketRevenue: number;
    ticketsSold: number;
    refundsTotal: number;
    payoutsTotal: number;
    listingsCount: number;
  };
  charts: {
    revenueByMonth: Array<{ month: string; revenue: number; orders: number }>;
    revenueByListing: Array<{ listingId: string; title: string; revenue: number; tickets: number }>;
    payoutsByMonth: Array<{ month: string; amount: number }>;
    paymentMethods: Array<{ method: string; count: number; amount: number }>;
  };
  timeline: AuditTimelineEntry[];
};

export type EventAuditSnapshot = {
  listingId: string;
  title: string;
  organizerId: string;
  companyName: string;
  organizerEmail: string;
  eventStartsOn: string | null;
  timeLabel: string;
  dateLabel: string;
  location: string;
  eventFormat: string;
  generatedAt: string;
  summary: {
    ticketsSold: number;
    activeTickets: number;
    refundedTickets: number;
    grossRevenue: number;
    organizerShare: number;
    serviceFees: number;
    refundsTotal: number;
    avgTicketPrice: number;
  };
  charts: {
    salesByDay: Array<{ day: string; tickets: number; revenue: number }>;
    salesByTier: Array<{ tier: string; tickets: number; revenue: number }>;
    paymentMethods: Array<{ method: string; count: number; amount: number }>;
    ticketStatus: Array<{ status: string; count: number }>;
  };
  orders: Array<{
    reference: string;
    status: string;
    paidAt: string | null;
    total: number;
    organizerShare: number;
    paymentMethod: string;
    ticketCount: number;
  }>;
  refunds: Array<{
    reference: string;
    amount: number;
    status: string;
    createdAt: string;
  }>;
};

function dayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = String(
    ("sqlMessage" in err && err.sqlMessage) ||
      ("message" in err && err.message) ||
      "",
  );
  return (
    message.includes("doesn't exist") ||
    message.includes("Unknown table") ||
    message.includes("Unknown column")
  );
}

async function safeAuditQuery<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

async function fetchMonthlyPayouts(organizerId: string) {
  return safeAuditQuery(async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(requested_at, '%Y-%m') AS month,
         COALESCE(SUM(amount_mwk), 0) AS amount
       FROM organizer_payouts
       WHERE organizer_id = :organizerId AND status = 'completed'
       GROUP BY DATE_FORMAT(requested_at, '%Y-%m')
       ORDER BY month ASC`,
      { organizerId },
    );
    return rows;
  }, []);
}

async function resolveOrganizerContact(
  organizerId: string,
): Promise<{ companyName: string; email: string }> {
  const contact = await tryResolveOrganizerContact(organizerId);
  if (!contact) throw new Error("Organizer email not found");
  return contact;
}

export async function tryResolveOrganizerContact(
  organizerId: string,
): Promise<{ companyName: string; email: string } | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.email AS user_email,
       u.full_name,
       op.company_name,
       (
         SELECT pa.contact_email
         FROM partner_applications pa
         WHERE LOWER(pa.contact_email) = LOWER(u.email)
         ORDER BY pa.created_at DESC
         LIMIT 1
       ) AS partner_email
     FROM users u
     LEFT JOIN organizer_profiles op ON op.user_id = u.id
     WHERE u.id = :organizerId`,
    { organizerId },
  );
  const row = rows[0];
  if (!row) return null;

  const email = String(row.user_email ?? row.partner_email ?? "").trim();
  if (!email) return null;

  return {
    companyName: String(row.company_name ?? row.full_name ?? "Organizer"),
    email,
  };
}

export async function recordAuditDeliverySkip(input: {
  listingId: string;
  organizerId: string;
  reason: string;
}) {
  const { v4: uuid } = await import("uuid");
  try {
    await pool.query(
      `INSERT INTO event_audit_reports
         (id, listing_id, organizer_id, trigger_kind, recipient_email, pdf_filename, report_summary_json)
       VALUES (:id, :listingId, :organizerId, 'auto', :recipientEmail, :pdfFilename, :summary)`,
      {
        id: uuid(),
        listingId: input.listingId,
        organizerId: input.organizerId,
        recipientEmail: `skipped:${input.reason.slice(0, 200)}`,
        pdfFilename: "skipped",
        summary: JSON.stringify({ skipped: true, reason: input.reason }),
      },
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return;
    throw err;
  }
}

async function fetchSalesByTier(listingId: string) {
  const mapRows = (rows: RowDataPacket[]) =>
    rows.map((r) => ({
      tier: String(r.tier),
      tickets: Number(r.tickets ?? 0),
      revenue: Number(r.revenue ?? 0),
    }));

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(ltt.name, ut.ticket_tier_name, 'Standard') AS tier,
         COUNT(ut.id) AS tickets,
         COALESCE(SUM(ut.amount_paid), 0) AS revenue
       FROM user_tickets ut
       LEFT JOIN listing_ticket_tiers ltt ON ltt.id = ut.ticket_tier_id
       WHERE ut.listing_id = :listingId
       GROUP BY COALESCE(ltt.name, ut.ticket_tier_name, 'Standard')
       ORDER BY revenue DESC`,
      { listingId },
    );
    return mapRows(rows);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COALESCE(ut.ticket_tier_name, 'Standard') AS tier,
         COUNT(ut.id) AS tickets,
         COALESCE(SUM(ut.amount_paid), 0) AS revenue
       FROM user_tickets ut
       WHERE ut.listing_id = :listingId
       GROUP BY COALESCE(ut.ticket_tier_name, 'Standard')
       ORDER BY revenue DESC`,
      { listingId },
    );
    return mapRows(rows);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 'Standard' AS tier,
       COUNT(*) AS tickets,
       COALESCE(SUM(amount_paid), 0) AS revenue
     FROM user_tickets
     WHERE listing_id = :listingId`,
    { listingId },
  );
  return mapRows(rows);
}

export async function getOrganizerAudit(organizerId: string): Promise<OrganizerAuditSnapshot> {
  const settlement = await getOrganizerSettlementBalances(organizerId);

  const [summaryRows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS ticketRevenue,
       COUNT(DISTINCT CASE WHEN o.status = 'confirmed' THEN ut.id END) AS ticketsSold,
       (SELECT COUNT(*) FROM listings WHERE organizer_id = :organizerId) AS listingsCount
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE l.organizer_id = :organizerId`,
    { organizerId },
  );

  const [refundRows, payoutRows, monthlyPayouts, refundTimeline, payoutTimeline] =
    await Promise.all([
      safeAuditQuery(async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COALESCE(SUM(refund_amount), 0) AS total
           FROM ticket_refunds WHERE organizer_id = :organizerId AND status = 'completed'`,
          { organizerId },
        );
        return rows;
      }, [{ total: 0 }] as RowDataPacket[]),
      safeAuditQuery(async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COALESCE(SUM(amount_mwk), 0) AS total
           FROM organizer_payouts
           WHERE organizer_id = :organizerId AND status = 'completed'`,
          { organizerId },
        );
        return rows;
      }, [{ total: 0 }] as RowDataPacket[]),
      fetchMonthlyPayouts(organizerId),
      safeAuditQuery(async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT tr.id, tr.refund_amount AS amount, tr.created_at AS at, tr.status, l.title AS listingTitle
           FROM ticket_refunds tr
           JOIN orders o ON o.id = tr.order_id
           LEFT JOIN listings l ON l.id = o.listing_id
           WHERE tr.organizer_id = :organizerId
           ORDER BY tr.created_at DESC LIMIT 50`,
          { organizerId },
        );
        return rows;
      }, []),
      safeAuditQuery(async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT id, amount_mwk AS amount, requested_at AS at, status, paychangu_charge_id AS reference
           FROM organizer_payouts
           WHERE organizer_id = :organizerId
           ORDER BY requested_at DESC LIMIT 50`,
          { organizerId },
        );
        return rows;
      }, []),
    ]);

  const [monthlyRevenue] = await pool.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month,
       COALESCE(SUM(o.subtotal_mwk), 0) AS revenue,
       COUNT(*) AS orders
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     GROUP BY DATE_FORMAT(o.created_at, '%Y-%m')
     ORDER BY month ASC`,
    { organizerId },
  );

  const [byListing] = await pool.query<RowDataPacket[]>(
    `SELECT l.id AS listingId, l.title,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS revenue,
       COUNT(CASE WHEN o.status = 'confirmed' THEN ut.id END) AS tickets
     FROM listings l
     LEFT JOIN orders o ON o.listing_id = l.id
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE l.organizer_id = :organizerId
     GROUP BY l.id, l.title
     HAVING revenue > 0 OR tickets > 0
     ORDER BY revenue DESC`,
    { organizerId },
  );

  const [paymentMethods] = await pool.query<RowDataPacket[]>(
    `SELECT o.payment_method AS method,
       COUNT(*) AS cnt,
       COALESCE(SUM(o.total_mwk), 0) AS amount
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     GROUP BY o.payment_method
     ORDER BY amount DESC`,
    { organizerId },
  );

  const timeline: AuditTimelineEntry[] = [];

  const [saleRows] = await pool.query<RowDataPacket[]>(
    `SELECT o.id, o.reference, o.subtotal_mwk AS amount, o.created_at AS at, l.title AS listingTitle, l.id AS listingId
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     ORDER BY o.created_at DESC LIMIT 100`,
    { organizerId },
  );
  for (const r of saleRows) {
    timeline.push({
      id: `sale-${r.id}`,
      kind: "sale",
      at: String(r.at),
      amount: Number(r.amount ?? 0),
      label: "Ticket sale confirmed",
      reference: r.reference as string,
      listingId: r.listingId as string,
      listingTitle: r.listingTitle as string,
    });
  }

  for (const r of refundTimeline) {
    timeline.push({
      id: `refund-${r.id}`,
      kind: "refund",
      at: String(r.at),
      amount: -Number(r.amount ?? 0),
      label: `Customer refund (${r.status})`,
      listingTitle: (r.listingTitle as string | null) ?? undefined,
    });
  }

  for (const r of payoutTimeline) {
    const status = String(r.status);
    timeline.push({
      id: `payout-${r.id}`,
      kind:
        status === "completed"
          ? "payout_completed"
          : status === "failed"
            ? "payout_failed"
            : "payout",
      at: String(r.at),
      amount: -Number(r.amount ?? 0),
      label: `Payout ${status}`,
      reference: (r.reference as string | null) ?? undefined,
    });
  }

  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return {
    generatedAt: new Date().toISOString(),
    settlement,
    summary: {
      grossRevenue: Number(summaryRows[0]?.grossRevenue ?? 0),
      ticketRevenue: Number(summaryRows[0]?.ticketRevenue ?? 0),
      ticketsSold: Number(summaryRows[0]?.ticketsSold ?? 0),
      refundsTotal: Number(refundRows[0]?.total ?? 0),
      payoutsTotal: Number(payoutRows[0]?.total ?? 0),
      listingsCount: Number(summaryRows[0]?.listingsCount ?? 0),
    },
    charts: {
      revenueByMonth: monthlyRevenue.map((r) => ({
        month: String(r.month),
        revenue: Number(r.revenue ?? 0),
        orders: Number(r.orders ?? 0),
      })),
      revenueByListing: byListing.map((r) => ({
        listingId: r.listingId as string,
        title: r.title as string,
        revenue: Number(r.revenue ?? 0),
        tickets: Number(r.tickets ?? 0),
      })),
      payoutsByMonth: monthlyPayouts.map((r) => ({
        month: String(r.month),
        amount: Number(r.amount ?? 0),
      })),
      paymentMethods: paymentMethods.map((r) => ({
        method: String(r.method ?? "unknown"),
        count: Number(r.cnt ?? 0),
        amount: Number(r.amount ?? 0),
      })),
    },
    timeline: timeline.slice(0, 120),
  };
}

export async function buildEventAuditSnapshot(listingId: string): Promise<EventAuditSnapshot> {
  const [listingRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, organizer_id, title, date_label, event_starts_on, time_label, location, event_format
     FROM listings WHERE id = :listingId`,
    { listingId },
  );
  const listingRow = listingRows[0];
  if (!listingRow) throw new Error("Event not found");

  const organizerId = String(listingRow.organizer_id);
  const profile = await resolveOrganizerContact(organizerId);

  const [summaryRows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COUNT(ut.id) AS ticketsSold,
       COUNT(CASE WHEN ut.status = 'active' THEN 1 END) AS activeTickets,
       COUNT(CASE WHEN ut.status IN ('refunded','cancelled') THEN 1 END) AS refundedTickets,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS organizerShare,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.service_fee_mwk ELSE 0 END), 0) AS serviceFees
     FROM orders o
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE o.listing_id = :listingId`,
    { listingId },
  );

  const [refundTotal] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(tr.refund_amount), 0) AS total
     FROM ticket_refunds tr
     JOIN orders o ON o.id = tr.order_id
     WHERE o.listing_id = :listingId AND tr.status = 'completed'`,
    { listingId },
  );

  const ticketsSold = Number(summaryRows[0]?.ticketsSold ?? 0);
  const organizerShare = Number(summaryRows[0]?.organizerShare ?? 0);

  const [salesByDay] = await pool.query<RowDataPacket[]>(
    `SELECT DATE(o.created_at) AS day,
       COUNT(ut.id) AS tickets,
       COALESCE(SUM(o.subtotal_mwk), 0) AS revenue
     FROM orders o
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE o.listing_id = :listingId AND o.status = 'confirmed'
     GROUP BY DATE(o.created_at)
     ORDER BY day ASC`,
    { listingId },
  );

  const salesByTier = await fetchSalesByTier(listingId);

  const [paymentMethods] = await pool.query<RowDataPacket[]>(
    `SELECT payment_method AS method, COUNT(*) AS cnt, COALESCE(SUM(total_mwk), 0) AS amount
     FROM orders WHERE listing_id = :listingId AND status = 'confirmed'
     GROUP BY payment_method`,
    { listingId },
  );

  const [ticketStatus] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS cnt FROM user_tickets WHERE listing_id = :listingId GROUP BY status`,
    { listingId },
  );

  const [orderRows] = await pool.query<RowDataPacket[]>(
    `SELECT o.reference, o.status, pl.completed_at AS paidAt,
       o.total_mwk AS total, o.subtotal_mwk AS organizerShare, o.payment_method AS paymentMethod,
       (SELECT COUNT(*) FROM user_tickets ut WHERE ut.order_id = o.id) AS ticketCount
     FROM orders o
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE o.listing_id = :listingId
     ORDER BY o.created_at DESC LIMIT 200`,
    { listingId },
  );

  const [refundRows] = await pool.query<RowDataPacket[]>(
    `SELECT ut.reference, tr.refund_amount AS amount, tr.status, tr.created_at AS createdAt
     FROM ticket_refunds tr
     JOIN orders o ON o.id = tr.order_id
     JOIN user_tickets ut ON ut.id = tr.user_ticket_id
     WHERE o.listing_id = :listingId
     ORDER BY tr.created_at DESC`,
    { listingId },
  );

  return {
    listingId,
    title: String(listingRow.title),
    organizerId,
    companyName: profile.companyName,
    organizerEmail: profile.email,
    eventStartsOn: listingRow.event_starts_on
      ? String(listingRow.event_starts_on).slice(0, 10)
      : null,
    timeLabel: String(listingRow.time_label ?? ""),
    dateLabel: String(listingRow.date_label ?? ""),
    location: String(listingRow.location ?? ""),
    eventFormat: String(listingRow.event_format ?? "physical"),
    generatedAt: new Date().toISOString(),
    summary: {
      ticketsSold,
      activeTickets: Number(summaryRows[0]?.activeTickets ?? 0),
      refundedTickets: Number(summaryRows[0]?.refundedTickets ?? 0),
      grossRevenue: Number(summaryRows[0]?.grossRevenue ?? 0),
      organizerShare,
      serviceFees: Number(summaryRows[0]?.serviceFees ?? 0),
      refundsTotal: Number(refundTotal[0]?.total ?? 0),
      avgTicketPrice: ticketsSold > 0 ? Math.round(organizerShare / ticketsSold) : 0,
    },
    charts: {
      salesByDay: salesByDay.map((r) => ({
        day: dayKey(String(r.day)),
        tickets: Number(r.tickets ?? 0),
        revenue: Number(r.revenue ?? 0),
      })),
      salesByTier,
      paymentMethods: paymentMethods.map((r) => ({
        method: String(r.method ?? "unknown"),
        count: Number(r.cnt ?? 0),
        amount: Number(r.amount ?? 0),
      })),
      ticketStatus: ticketStatus.map((r) => ({
        status: String(r.status),
        count: Number(r.cnt ?? 0),
      })),
    },
    orders: orderRows.map((r) => ({
      reference: r.reference as string,
      status: r.status as string,
      paidAt: r.paidAt ? String(r.paidAt) : null,
      total: Number(r.total ?? 0),
      organizerShare: Number(r.organizerShare ?? 0),
      paymentMethod: String(r.paymentMethod ?? ""),
      ticketCount: Number(r.ticketCount ?? 0),
    })),
    refunds: refundRows.map((r) => ({
      reference: (r.reference as string | null) ?? "—",
      amount: Number(r.amount ?? 0),
      status: r.status as string,
      createdAt: String(r.createdAt),
    })),
  };
}

export async function listEventsForAdminAudit(search?: string) {
  const q = search?.trim();
  const params = q ? { q: `%${q}%` } : {};
  const searchClause = q
    ? "AND (l.title LIKE :q OR op.company_name LIKE :q OR u.full_name LIKE :q OR l.id LIKE :q)"
    : "";

  const sqlWithAudit = `
    SELECT l.id AS listingId, l.title, l.date_label AS dateLabel, l.event_starts_on AS eventStartsOn,
       l.time_label AS timeLabel, l.status, l.event_format AS eventFormat,
       COALESCE(op.company_name, u.full_name, 'Unknown organizer') AS companyName,
       (SELECT MAX(sent_at) FROM event_audit_reports ear WHERE ear.listing_id = l.id) AS lastAuditSentAt,
       (SELECT COUNT(*) FROM event_audit_reports ear WHERE ear.listing_id = l.id AND ear.trigger_kind = 'auto') AS autoAuditSent
     FROM listings l
     JOIN users u ON u.id = l.organizer_id
     LEFT JOIN organizer_profiles op ON op.user_id = l.organizer_id
     WHERE l.kind = 'event'
       ${searchClause}
     ORDER BY l.event_starts_on DESC, l.created_at DESC
     LIMIT 200`;

  const sqlWithoutAudit = `
    SELECT l.id AS listingId, l.title, l.date_label AS dateLabel, l.event_starts_on AS eventStartsOn,
       l.time_label AS timeLabel, l.status, l.event_format AS eventFormat,
       COALESCE(op.company_name, u.full_name, 'Unknown organizer') AS companyName
     FROM listings l
     JOIN users u ON u.id = l.organizer_id
     LEFT JOIN organizer_profiles op ON op.user_id = l.organizer_id
     WHERE l.kind = 'event'
       ${searchClause}
     ORDER BY l.event_starts_on DESC, l.created_at DESC
     LIMIT 200`;

  try {
    const [rows] = await pool.query<RowDataPacket[]>(sqlWithAudit, params);
    return mapAdminAuditRows(rows);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    const [rows] = await pool.query<RowDataPacket[]>(sqlWithoutAudit, params);
    return mapAdminAuditRows(rows).map((r) => ({
      ...r,
      lastAuditSentAt: null,
      autoAuditSent: false,
    }));
  }
}

function mapAdminAuditRows(rows: RowDataPacket[]) {
  return rows.map((r) => ({
    listingId: r.listingId as string,
    title: r.title as string,
    dateLabel: r.dateLabel as string,
    eventStartsOn: r.eventStartsOn ? String(r.eventStartsOn).slice(0, 10) : null,
    timeLabel: r.timeLabel as string,
    status: r.status as string,
    eventFormat: r.eventFormat as string,
    companyName: r.companyName as string,
    lastAuditSentAt: r.lastAuditSentAt ? String(r.lastAuditSentAt) : null,
    autoAuditSent: Number(r.autoAuditSent ?? 0) > 0,
  }));
}

export async function hasAutoAuditReport(listingId: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM event_audit_reports WHERE listing_id = :listingId AND trigger_kind = 'auto' LIMIT 1`,
    { listingId },
  );
  return rows.length > 0;
}

export async function recordAuditReport(input: {
  listingId: string;
  organizerId: string;
  triggerKind: "auto" | "manual";
  triggeredBy?: string;
  recipientEmail: string;
  pdfFilename: string;
  summary: Record<string, unknown>;
}) {
  const { v4: uuid } = await import("uuid");
  await pool.query(
    `INSERT INTO event_audit_reports
       (id, listing_id, organizer_id, trigger_kind, triggered_by, recipient_email, pdf_filename, report_summary_json)
     VALUES (:id, :listingId, :organizerId, :triggerKind, :triggeredBy, :recipientEmail, :pdfFilename, :summary)`,
    {
      id: uuid(),
      listingId: input.listingId,
      organizerId: input.organizerId,
      triggerKind: input.triggerKind,
      triggeredBy: input.triggeredBy ?? null,
      recipientEmail: input.recipientEmail,
      pdfFilename: input.pdfFilename,
      summary: JSON.stringify(input.summary),
    },
  );
}
