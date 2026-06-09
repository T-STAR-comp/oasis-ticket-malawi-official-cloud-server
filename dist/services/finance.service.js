import { pool } from "../db/pool.js";
import { listAllPayouts, listOrganizerPayouts, getOrganizerPayoutDestination } from "./payout.service.js";
import { getAdminSettlementByOrganizer, getOrganizerSettlementBalances, getOrganizerSettlementLines, getPlatformSettlementBalances, } from "./settlement.service.js";
function mapTransaction(row) {
    const seatsRaw = row.seats;
    return {
        orderId: row.orderId,
        reference: row.reference,
        createdAt: row.createdAt,
        orderStatus: row.orderStatus,
        ledgerStatus: row.ledgerStatus ?? null,
        paymentMethod: row.paymentMethod,
        listingId: row.listingId,
        listingTitle: row.listingTitle,
        organizerName: row.organizerName ?? undefined,
        subtotal: Number(row.subtotal ?? 0),
        serviceFee: Number(row.serviceFee ?? 0),
        total: Number(row.total ?? 0),
        seats: seatsRaw ? seatsRaw.split(",").filter(Boolean) : [],
        failureReason: row.failureReason ?? undefined,
    };
}
export async function getOrganizerFinance(organizerId) {
    const [summaryRows] = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS ticketRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.service_fee_mwk ELSE 0 END), 0) AS serviceFees,
       COUNT(CASE WHEN o.status = 'confirmed' THEN 1 END) AS completedOrders,
       COUNT(CASE WHEN o.status = 'pending' THEN 1 END) AS pendingOrders,
       COUNT(CASE WHEN o.status = 'failed' THEN 1 END) AS failedOrders,
       COALESCE(SUM(CASE WHEN o.status = 'pending' THEN o.total_mwk ELSE 0 END), 0) AS pendingAmount
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     WHERE l.organizer_id = :organizerId`, { organizerId });
    const summary = summaryRows[0];
    const [txnRows] = await pool.query(`SELECT
       o.id AS orderId, o.reference, o.created_at AS createdAt, o.status AS orderStatus,
       o.total_mwk AS total, o.subtotal_mwk AS subtotal, o.service_fee_mwk AS serviceFee,
       o.payment_method AS paymentMethod, l.id AS listingId, l.title AS listingTitle,
       pl.status AS ledgerStatus, pl.failure_reason AS failureReason,
       GROUP_CONCAT(DISTINCT oi.seat_number ORDER BY oi.seat_number) AS seats
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE l.organizer_id = :organizerId
     GROUP BY o.id, o.reference, o.created_at, o.status, o.total_mwk, o.subtotal_mwk,
              o.service_fee_mwk, o.payment_method, l.id, l.title, pl.status, pl.failure_reason
     ORDER BY o.created_at DESC
     LIMIT 200`, { organizerId });
    const [byListing] = await pool.query(`SELECT l.id AS listingId, l.title,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS revenue,
       COUNT(CASE WHEN o.status = 'confirmed' THEN 1 END) AS orders
     FROM listings l
     LEFT JOIN orders o ON o.listing_id = l.id
     WHERE l.organizer_id = :organizerId
     GROUP BY l.id, l.title
     ORDER BY revenue DESC`, { organizerId });
    const [settlement, settlementLines, payouts, payoutDestination] = await Promise.all([
        getOrganizerSettlementBalances(organizerId),
        getOrganizerSettlementLines(organizerId),
        listOrganizerPayouts(organizerId),
        getOrganizerPayoutDestination(organizerId),
    ]);
    return {
        summary: {
            grossRevenue: Number(summary?.grossRevenue ?? 0),
            ticketRevenue: Number(summary?.ticketRevenue ?? 0),
            serviceFees: Number(summary?.serviceFees ?? 0),
            netRevenue: Number(summary?.ticketRevenue ?? 0),
            completedOrders: Number(summary?.completedOrders ?? 0),
            pendingOrders: Number(summary?.pendingOrders ?? 0),
            failedOrders: Number(summary?.failedOrders ?? 0),
            pendingAmount: Number(summary?.pendingAmount ?? 0),
        },
        settlement,
        settlementLines,
        payouts,
        payoutDestination,
        revenueByListing: byListing.map((r) => ({
            listingId: r.listingId,
            title: r.title,
            revenue: Number(r.revenue ?? 0),
            orders: Number(r.orders ?? 0),
        })),
        transactions: txnRows.map(mapTransaction),
    };
}
export async function getAdminFinance() {
    const [summaryRows] = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS grossRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.subtotal_mwk ELSE 0 END), 0) AS ticketRevenue,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.service_fee_mwk ELSE 0 END), 0) AS platformFees,
       COUNT(CASE WHEN o.status = 'confirmed' THEN 1 END) AS completedOrders,
       COUNT(CASE WHEN o.status = 'pending' THEN 1 END) AS pendingOrders,
       COUNT(CASE WHEN o.status = 'failed' THEN 1 END) AS failedOrders,
       COALESCE(SUM(CASE WHEN o.status = 'pending' THEN o.total_mwk ELSE 0 END), 0) AS pendingAmount
     FROM orders o`);
    const summary = summaryRows[0];
    const [txnRows] = await pool.query(`SELECT
       o.id AS orderId, o.reference, o.created_at AS createdAt, o.status AS orderStatus,
       o.total_mwk AS total, o.subtotal_mwk AS subtotal, o.service_fee_mwk AS serviceFee,
       o.payment_method AS paymentMethod, l.id AS listingId, l.title AS listingTitle,
       op.company_name AS organizerName,
       pl.status AS ledgerStatus, pl.failure_reason AS failureReason,
       GROUP_CONCAT(DISTINCT oi.seat_number ORDER BY oi.seat_number) AS seats
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN organizer_profiles op ON op.user_id = l.organizer_id
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     GROUP BY o.id, o.reference, o.created_at, o.status, o.total_mwk, o.subtotal_mwk,
              o.service_fee_mwk, o.payment_method, l.id, l.title, op.company_name,
              pl.status, pl.failure_reason
     ORDER BY o.created_at DESC
     LIMIT 300`);
    const [byOrganizer] = await pool.query(`SELECT op.user_id AS organizerId, op.company_name AS companyName,
       COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN o.total_mwk ELSE 0 END), 0) AS revenue,
       COUNT(CASE WHEN o.status = 'confirmed' THEN 1 END) AS orders
     FROM organizer_profiles op
     LEFT JOIN listings l ON l.organizer_id = op.user_id
     LEFT JOIN orders o ON o.listing_id = l.id
     GROUP BY op.user_id, op.company_name
     HAVING revenue > 0 OR orders > 0
     ORDER BY revenue DESC`);
    const [settlement, settlementByOrganizer, payouts] = await Promise.all([
        getPlatformSettlementBalances(),
        getAdminSettlementByOrganizer(),
        listAllPayouts(),
    ]);
    return {
        summary: {
            grossRevenue: Number(summary?.grossRevenue ?? 0),
            ticketRevenue: Number(summary?.ticketRevenue ?? 0),
            platformFees: Number(summary?.platformFees ?? 0),
            completedOrders: Number(summary?.completedOrders ?? 0),
            pendingOrders: Number(summary?.pendingOrders ?? 0),
            failedOrders: Number(summary?.failedOrders ?? 0),
            pendingAmount: Number(summary?.pendingAmount ?? 0),
        },
        settlement,
        settlementByOrganizer,
        payouts,
        revenueByOrganizer: byOrganizer.map((r) => ({
            organizerId: r.organizerId,
            companyName: r.companyName,
            revenue: Number(r.revenue ?? 0),
            orders: Number(r.orders ?? 0),
        })),
        transactions: txnRows.map(mapTransaction),
    };
}
