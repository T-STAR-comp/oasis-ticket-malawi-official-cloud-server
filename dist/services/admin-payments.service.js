import { pool } from "../db/pool.js";
import { countFulfillmentTickets, attemptPaymentRecovery } from "./payment-reconciliation.service.js";
import { getLedgerById, parseCheckoutMeta } from "./ledger.service.js";
import { emailTicketsForOrder } from "./guest-tickets.service.js";
function mapPaymentSummary(row) {
    const meta = parseCheckoutMeta(row);
    return {
        id: row.id,
        orderId: row.order_id,
        orderReference: row.order_reference,
        orderStatus: row.order_status,
        ledgerStatus: row.status,
        paychanguChargeId: row.paychangu_charge_id,
        paychanguTransId: row.paychangu_trans_id,
        amountMwk: Number(row.amount_mwk),
        paymentMethod: row.payment_method,
        paymentPhone: row.payment_phone,
        accountName: row.account_name,
        accountEmail: row.account_email,
        providerStatus: row.provider_status,
        failureReason: row.failure_reason,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        listingId: row.listing_id,
        listingTitle: row.listing_title,
        buyerName: row.buyer_name,
        buyerEmail: row.buyer_email,
        ticketCount: Number(row.ticket_count),
        qty: Number(meta.lineCount ?? meta.qty ?? 1),
        isResell: Boolean(meta.resellListingId),
        needsTickets: Number(row.ticket_count) === 0 && row.status !== "pending",
    };
}
export async function listAdminPayments(options) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const offset = Math.max(options?.offset ?? 0, 0);
    const params = { limit, offset };
    const conditions = ["1=1"];
    if (options?.status) {
        conditions.push("pl.status = :status");
        params.status = options.status;
    }
    if (options?.search?.trim()) {
        conditions.push(`(pl.paychangu_charge_id LIKE :search
        OR o.reference LIKE :search
        OR pl.account_email LIKE :search
        OR pl.account_name LIKE :search
        OR o.contact_email LIKE :search
        OR o.contact_name LIKE :search
        OR u.email LIKE :search
        OR l.title LIKE :search)`);
        params.search = `%${options.search.trim()}%`;
    }
    const where = conditions.join(" AND ");
    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt
     FROM payment_ledger pl
     JOIN orders o ON o.id = pl.order_id
     LEFT JOIN users u ON u.id = pl.user_id
     JOIN listings l ON l.id = o.listing_id
     WHERE ${where}`, params);
    const [rows] = await pool.query(`SELECT
       pl.*,
       o.reference AS order_reference,
       o.status AS order_status,
       o.listing_id,
       o.is_guest,
       l.title AS listing_title,
       COALESCE(u.full_name, o.contact_name) AS buyer_name,
       COALESCE(u.email, o.contact_email) AS buyer_email,
       (SELECT COUNT(*) FROM user_tickets ut WHERE ut.order_id = pl.order_id) AS ticket_count
     FROM payment_ledger pl
     JOIN orders o ON o.id = pl.order_id
     LEFT JOIN users u ON u.id = pl.user_id
     JOIN listings l ON l.id = o.listing_id
     WHERE ${where}
     ORDER BY pl.created_at DESC
     LIMIT :limit OFFSET :offset`, params);
    return {
        total: Number(countRows[0]?.cnt ?? 0),
        limit,
        offset,
        payments: rows.map((row) => {
            const base = mapPaymentSummary(row);
            return {
                ...base,
                needsTickets: base.ticketCount === 0 && base.ledgerStatus !== "pending",
            };
        }),
    };
}
export async function getAdminPaymentDetail(ledgerId) {
    const ledger = await getLedgerById(ledgerId);
    if (!ledger)
        return null;
    const [orderRows] = await pool.query(`SELECT o.*, l.title AS listing_title, l.kind AS listing_kind,
            COALESCE(u.full_name, o.contact_name) AS buyer_name,
            COALESCE(u.email, o.contact_email) AS buyer_email,
            COALESCE(u.phone, o.contact_phone) AS buyer_phone
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     LEFT JOIN users u ON u.id = o.user_id
     WHERE o.id = :orderId`, { orderId: ledger.order_id });
    const order = orderRows[0];
    if (!order)
        return null;
    const meta = parseCheckoutMeta(ledger);
    const ticketCount = await countFulfillmentTickets(ledger);
    const [ticketRows] = await pool.query(`SELECT id, reference, qr_token, seat_number, status, amount_paid, purchased_at,
            ticket_tier_id, ticket_tier_name
     FROM user_tickets
     WHERE order_id = :orderId
     ORDER BY purchased_at ASC`, { orderId: ledger.order_id });
    let tickets = ticketRows.map((t) => ({
        id: t.id,
        reference: t.reference,
        qrToken: t.qr_token,
        seatNumber: t.seat_number != null ? Number(t.seat_number) : null,
        status: t.status,
        amountPaid: Number(t.amount_paid),
        purchasedAt: t.purchased_at,
        tierId: t.ticket_tier_id ?? null,
        tierName: t.ticket_tier_name ?? null,
    }));
    if (tickets.length === 0 && meta.resellListingId && meta.userTicketId) {
        const resellTicketId = String(meta.userTicketId);
        const [resellTicketRows] = await pool.query(`SELECT id, reference, qr_token, seat_number, status, amount_paid, purchased_at,
              ticket_tier_id, ticket_tier_name
       FROM user_tickets
       WHERE id = :ticketId AND user_id = :userId`, { ticketId: resellTicketId, userId: ledger.user_id });
        tickets = resellTicketRows.map((t) => ({
            id: t.id,
            reference: t.reference,
            qrToken: t.qr_token,
            seatNumber: t.seat_number != null ? Number(t.seat_number) : null,
            status: t.status,
            amountPaid: Number(t.amount_paid),
            purchasedAt: t.purchased_at,
            tierId: t.ticket_tier_id ?? null,
            tierName: t.ticket_tier_name ?? null,
        }));
    }
    const isActivePending = ledger.status === "pending" && new Date(ledger.expires_at).getTime() > Date.now();
    const refundMayHaveBeenAttempted = ledger.status === "failed" &&
        Boolean(ledger.failure_reason &&
            /finalize|fulfill|ticket|capacity|seat|available|no longer/i.test(ledger.failure_reason));
    return {
        id: ledger.id,
        orderId: ledger.order_id,
        orderReference: order.reference,
        orderStatus: order.status,
        ledgerStatus: ledger.status,
        paychanguChargeId: ledger.paychangu_charge_id,
        paychanguTransId: ledger.paychangu_trans_id,
        paychanguRefId: ledger.paychangu_ref_id,
        amountMwk: Number(ledger.amount_mwk),
        paymentMethod: ledger.payment_method,
        paymentPhone: ledger.payment_phone,
        accountName: ledger.account_name,
        accountEmail: ledger.account_email,
        accountPhone: ledger.account_phone,
        providerStatus: ledger.provider_status,
        failureReason: ledger.failure_reason,
        createdAt: ledger.created_at,
        completedAt: ledger.completed_at,
        expiresAt: ledger.expires_at,
        lastPolledAt: ledger.last_polled_at,
        pollCount: ledger.poll_count,
        listingId: order.listing_id,
        listingTitle: order.listing_title,
        listingKind: order.listing_kind,
        buyerName: order.buyer_name,
        buyerEmail: order.buyer_email,
        buyerPhone: order.buyer_phone ?? null,
        contactName: order.contact_name,
        contactEmail: order.contact_email,
        contactPhone: order.contact_phone ?? null,
        subtotalMwk: Number(order.subtotal_mwk),
        serviceFeeMwk: Number(order.service_fee_mwk),
        totalMwk: Number(order.total_mwk),
        checkoutMeta: meta,
        qty: Number(meta.lineCount ?? meta.qty ?? 1),
        isResell: Boolean(meta.resellListingId),
        ticketCount,
        tickets,
        canManualFulfill: ticketCount === 0 && !isActivePending,
        needsTickets: ticketCount === 0 && !isActivePending,
        canResendEmail: ticketCount > 0 && Boolean(order.buyer_email || order.contact_email),
        refundMayHaveBeenAttempted,
    };
}
export async function adminManualFulfillPayment(ledgerId) {
    const detail = await getAdminPaymentDetail(ledgerId);
    if (!detail)
        throw new Error("Payment not found");
    if (detail.ticketCount > 0) {
        return { ...detail, recovery: { status: "already_fulfilled", ticketCount: detail.ticketCount } };
    }
    const recovery = await attemptPaymentRecovery(ledgerId, { source: "admin" });
    const refreshed = await getAdminPaymentDetail(ledgerId);
    if (!refreshed)
        throw new Error("Payment not found after recovery");
    return { ...refreshed, recovery };
}
export async function adminResendTicketEmail(ledgerId) {
    const detail = await getAdminPaymentDetail(ledgerId);
    if (!detail)
        throw new Error("Payment not found");
    if (detail.ticketCount === 0) {
        throw new Error("No tickets on this order — issue tickets before sending email");
    }
    const recipient = detail.buyerEmail || detail.contactEmail;
    if (!recipient) {
        throw new Error("No email address on this order");
    }
    const emailResult = await emailTicketsForOrder(detail.orderId);
    if (!emailResult.sent) {
        const reason = emailResult.reason === "email_feature_disabled"
            ? "Email delivery is disabled (FEATURE_EMAIL_ENABLED or SMTP not configured)"
            : emailResult.reason === "smtp_unavailable"
                ? "SMTP is not available — check server mail settings"
                : "Could not send ticket email";
        throw new Error(reason);
    }
    return {
        ...detail,
        emailSentTo: recipient,
        ticketCount: detail.ticketCount,
    };
}
