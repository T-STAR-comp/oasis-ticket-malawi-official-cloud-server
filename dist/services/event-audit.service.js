import { pool } from "../db/pool.js";
import { SETTLEMENT_EPOCH_DATE } from "../utils/settlement-epoch.js";
import { getOrganizerSettlementBalances } from "./settlement.service.js";
function dayKey(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime()))
        return "unknown";
    return d.toISOString().slice(0, 10);
}
export async function getOrganizerAudit(organizerId) {
    const settlement = await getOrganizerSettlementBalances(organizerId);
    const [summaryRows] = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS ticketRevenue,
       COUNT(DISTINCT CASE WHEN o.status = 'confirmed' THEN ut.id END) AS ticketsSold,
       (SELECT COUNT(*) FROM listings WHERE organizer_id = :organizerId) AS listingsCount
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE l.organizer_id = :organizerId`, { organizerId });
    const [refundRows] = await pool.query(`SELECT COALESCE(SUM(refund_amount), 0) AS total
     FROM ticket_refunds WHERE organizer_id = :organizerId AND status = 'completed'`, { organizerId });
    const [payoutRows] = await pool.query(`SELECT COALESCE(SUM(amount_mwk), 0) AS total
     FROM organizer_payouts
     WHERE organizer_id = :organizerId AND status = 'completed'`, { organizerId });
    const [monthlyRevenue] = await pool.query(`SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month,
       COALESCE(SUM(o.subtotal_mwk), 0) AS revenue,
       COUNT(*) AS orders
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     GROUP BY DATE_FORMAT(o.created_at, '%Y-%m')
     ORDER BY month ASC`, { organizerId });
    const [byListing] = await pool.query(`SELECT l.id AS listingId, l.title,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS revenue,
       COUNT(CASE WHEN o.status = 'confirmed' THEN ut.id END) AS tickets
     FROM listings l
     LEFT JOIN orders o ON o.listing_id = l.id
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE l.organizer_id = :organizerId
     GROUP BY l.id, l.title
     HAVING revenue > 0 OR tickets > 0
     ORDER BY revenue DESC`, { organizerId });
    const [monthlyPayouts] = await pool.query(`SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       COALESCE(SUM(amount_mwk), 0) AS amount
     FROM organizer_payouts
     WHERE organizer_id = :organizerId AND status = 'completed'
     GROUP BY DATE_FORMAT(created_at, '%Y-%m')
     ORDER BY month ASC`, { organizerId });
    const [paymentMethods] = await pool.query(`SELECT o.payment_method AS method,
       COUNT(*) AS cnt,
       COALESCE(SUM(o.total_mwk), 0) AS amount
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     GROUP BY o.payment_method
     ORDER BY amount DESC`, { organizerId });
    const timeline = [];
    const [saleRows] = await pool.query(`SELECT o.id, o.reference, o.subtotal_mwk AS amount, o.created_at AS at, l.title AS listingTitle, l.id AS listingId
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId AND o.status = 'confirmed'
     ORDER BY o.created_at DESC LIMIT 100`, { organizerId });
    for (const r of saleRows) {
        timeline.push({
            id: `sale-${r.id}`,
            kind: "sale",
            at: String(r.at),
            amount: Number(r.amount ?? 0),
            label: "Ticket sale confirmed",
            reference: r.reference,
            listingId: r.listingId,
            listingTitle: r.listingTitle,
        });
    }
    const [refundTimeline] = await pool.query(`SELECT tr.id, tr.refund_amount AS amount, tr.created_at AS at, tr.status, l.title AS listingTitle
     FROM ticket_refunds tr
     JOIN orders o ON o.id = tr.order_id
     LEFT JOIN listings l ON l.id = o.listing_id
     WHERE tr.organizer_id = :organizerId
     ORDER BY tr.created_at DESC LIMIT 50`, { organizerId });
    for (const r of refundTimeline) {
        timeline.push({
            id: `refund-${r.id}`,
            kind: "refund",
            at: String(r.at),
            amount: -Number(r.amount ?? 0),
            label: `Customer refund (${r.status})`,
            listingTitle: r.listingTitle ?? undefined,
        });
    }
    const [payoutTimeline] = await pool.query(`SELECT id, amount_mwk AS amount, created_at AS at, status, reference
     FROM organizer_payouts
     WHERE organizer_id = :organizerId
     ORDER BY created_at DESC LIMIT 50`, { organizerId });
    for (const r of payoutTimeline) {
        const status = String(r.status);
        timeline.push({
            id: `payout-${r.id}`,
            kind: status === "completed"
                ? "payout_completed"
                : status === "failed"
                    ? "payout_failed"
                    : "payout",
            at: String(r.at),
            amount: -Number(r.amount ?? 0),
            label: `Payout ${status}`,
            reference: r.reference ?? undefined,
        });
    }
    timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return {
        generatedAt: new Date().toISOString(),
        settlementEpochDate: SETTLEMENT_EPOCH_DATE,
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
                listingId: r.listingId,
                title: r.title,
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
export async function buildEventAuditSnapshot(listingId) {
    const [listingRows] = await pool.query(`SELECT id, organizer_id, title, date_label, event_starts_on, time_label, location, event_format
     FROM listings WHERE id = :listingId`, { listingId });
    const listingRow = listingRows[0];
    if (!listingRow)
        throw new Error("Event not found");
    const organizerId = String(listingRow.organizer_id);
    const [profileRows] = await pool.query(`SELECT op.company_name, u.email
     FROM organizer_profiles op
     JOIN users u ON u.id = op.user_id
     WHERE op.user_id = :organizerId`, { organizerId });
    const profile = profileRows[0];
    if (!profile)
        throw new Error("Organizer not found");
    const [summaryRows] = await pool.query(`SELECT
       COUNT(ut.id) AS ticketsSold,
       COUNT(CASE WHEN ut.status = 'active' THEN 1 END) AS activeTickets,
       COUNT(CASE WHEN ut.status IN ('refunded','cancelled') THEN 1 END) AS refundedTickets,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS organizerShare,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.service_fee_mwk ELSE 0 END), 0) AS serviceFees
     FROM orders o
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE o.listing_id = :listingId`, { listingId });
    const [refundTotal] = await pool.query(`SELECT COALESCE(SUM(tr.refund_amount), 0) AS total
     FROM ticket_refunds tr
     JOIN orders o ON o.id = tr.order_id
     WHERE o.listing_id = :listingId AND tr.status = 'completed'`, { listingId });
    const ticketsSold = Number(summaryRows[0]?.ticketsSold ?? 0);
    const organizerShare = Number(summaryRows[0]?.organizerShare ?? 0);
    const [salesByDay] = await pool.query(`SELECT DATE(o.created_at) AS day,
       COUNT(ut.id) AS tickets,
       COALESCE(SUM(o.subtotal_mwk), 0) AS revenue
     FROM orders o
     LEFT JOIN user_tickets ut ON ut.order_id = o.id
     WHERE o.listing_id = :listingId AND o.status = 'confirmed'
     GROUP BY DATE(o.created_at)
     ORDER BY day ASC`, { listingId });
    const [salesByTier] = await pool.query(`SELECT COALESCE(tt.name, ut.ticket_tier_name, 'Standard') AS tier,
       COUNT(ut.id) AS tickets,
       COALESCE(SUM(ut.amount_paid), 0) AS revenue
     FROM user_tickets ut
     LEFT JOIN ticket_tiers tt ON tt.id = ut.ticket_tier_id
     WHERE ut.listing_id = :listingId
     GROUP BY COALESCE(tt.name, ut.ticket_tier_name, 'Standard')
     ORDER BY revenue DESC`, { listingId });
    const [paymentMethods] = await pool.query(`SELECT payment_method AS method, COUNT(*) AS cnt, COALESCE(SUM(total_mwk), 0) AS amount
     FROM orders WHERE listing_id = :listingId AND status = 'confirmed'
     GROUP BY payment_method`, { listingId });
    const [ticketStatus] = await pool.query(`SELECT status, COUNT(*) AS cnt FROM user_tickets WHERE listing_id = :listingId GROUP BY status`, { listingId });
    const [orderRows] = await pool.query(`SELECT o.reference, o.status, pl.completed_at AS paidAt,
       o.total_mwk AS total, o.subtotal_mwk AS organizerShare, o.payment_method AS paymentMethod,
       (SELECT COUNT(*) FROM user_tickets ut WHERE ut.order_id = o.id) AS ticketCount
     FROM orders o
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE o.listing_id = :listingId
     ORDER BY o.created_at DESC LIMIT 200`, { listingId });
    const [refundRows] = await pool.query(`SELECT ut.reference, tr.refund_amount AS amount, tr.status, tr.created_at AS createdAt
     FROM ticket_refunds tr
     JOIN orders o ON o.id = tr.order_id
     JOIN user_tickets ut ON ut.id = tr.user_ticket_id
     WHERE o.listing_id = :listingId
     ORDER BY tr.created_at DESC`, { listingId });
    return {
        listingId,
        title: String(listingRow.title),
        organizerId,
        companyName: String(profile.company_name),
        organizerEmail: String(profile.email),
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
            salesByTier: salesByTier.map((r) => ({
                tier: String(r.tier),
                tickets: Number(r.tickets ?? 0),
                revenue: Number(r.revenue ?? 0),
            })),
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
            reference: r.reference,
            status: r.status,
            paidAt: r.paidAt ? String(r.paidAt) : null,
            total: Number(r.total ?? 0),
            organizerShare: Number(r.organizerShare ?? 0),
            paymentMethod: String(r.paymentMethod ?? ""),
            ticketCount: Number(r.ticketCount ?? 0),
        })),
        refunds: refundRows.map((r) => ({
            reference: r.reference ?? "—",
            amount: Number(r.amount ?? 0),
            status: r.status,
            createdAt: String(r.createdAt),
        })),
    };
}
export async function listEventsForAdminAudit(search) {
    const q = search?.trim();
    const [rows] = await pool.query(`SELECT l.id AS listingId, l.title, l.date_label AS dateLabel, l.event_starts_on AS eventStartsOn,
       l.time_label AS timeLabel, l.status, l.event_format AS eventFormat,
       op.company_name AS companyName,
       (SELECT MAX(sent_at) FROM event_audit_reports ear WHERE ear.listing_id = l.id) AS lastAuditSentAt,
       (SELECT COUNT(*) FROM event_audit_reports ear WHERE ear.listing_id = l.id AND ear.trigger_kind = 'auto') AS autoAuditSent
     FROM listings l
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     WHERE l.kind = 'event'
       ${q ? "AND (l.title LIKE :q OR op.company_name LIKE :q OR l.id LIKE :q)" : ""}
     ORDER BY l.event_starts_on DESC, l.created_at DESC
     LIMIT 200`, q ? { q: `%${q}%` } : {});
    return rows.map((r) => ({
        listingId: r.listingId,
        title: r.title,
        dateLabel: r.dateLabel,
        eventStartsOn: r.eventStartsOn ? String(r.eventStartsOn).slice(0, 10) : null,
        timeLabel: r.timeLabel,
        status: r.status,
        eventFormat: r.eventFormat,
        companyName: r.companyName,
        lastAuditSentAt: r.lastAuditSentAt ? String(r.lastAuditSentAt) : null,
        autoAuditSent: Number(r.autoAuditSent ?? 0) > 0,
    }));
}
export async function hasAutoAuditReport(listingId) {
    const [rows] = await pool.query(`SELECT 1 FROM event_audit_reports WHERE listing_id = :listingId AND trigger_kind = 'auto' LIMIT 1`, { listingId });
    return rows.length > 0;
}
export async function recordAuditReport(input) {
    const { v4: uuid } = await import("uuid");
    await pool.query(`INSERT INTO event_audit_reports
       (id, listing_id, organizer_id, trigger_kind, triggered_by, recipient_email, pdf_filename, report_summary_json)
     VALUES (:id, :listingId, :organizerId, :triggerKind, :triggeredBy, :recipientEmail, :pdfFilename, :summary)`, {
        id: uuid(),
        listingId: input.listingId,
        organizerId: input.organizerId,
        triggerKind: input.triggerKind,
        triggeredBy: input.triggeredBy ?? null,
        recipientEmail: input.recipientEmail,
        pdfFilename: input.pdfFilename,
        summary: JSON.stringify(input.summary),
    });
}
