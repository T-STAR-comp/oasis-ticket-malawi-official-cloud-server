import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { executeCustomerRefundPayment, refundPaymentMethodLabel, } from "./refund-payment.service.js";
const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;
export async function getOrganizerRefundDebtSummary(organizerId) {
    const [rows] = await pool.query(`SELECT refund_debt_mwk, refund_recovered_mwk FROM organizer_profiles WHERE user_id = :organizerId`, { organizerId });
    const row = rows[0];
    const refundDebt = Number(row?.refund_debt_mwk ?? 0);
    const refundRecovered = Number(row?.refund_recovered_mwk ?? 0);
    const [pendingRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM ticket_refunds
     WHERE organizer_id = :organizerId AND status = 'pending'`, { organizerId });
    return {
        refundDebt,
        refundRecovered,
        outstandingRefundDebt: Math.max(0, refundDebt - refundRecovered),
        pendingCustomerRefunds: Number(pendingRows[0]?.cnt ?? 0),
    };
}
export async function getSalesRecoveredFromSettledSales(organizerId) {
    const [rows] = await pool.query(`SELECT COALESCE(SUM(amount_mwk), 0) AS total
     FROM refund_recovery_allocations
     WHERE organizer_id = :organizerId AND source = 'settled_sale'`, { organizerId });
    return Number(rows[0]?.total ?? 0);
}
export async function addOrganizerRefundDebt(organizerId, amount) {
    if (amount <= 0)
        return;
    await pool.query(`UPDATE organizer_profiles
     SET refund_debt_mwk = refund_debt_mwk + :amount
     WHERE user_id = :organizerId`, { organizerId, amount });
    try {
        const [profileRows] = await pool.query(`SELECT op.company_name, op.refund_debt_mwk, op.refund_recovered_mwk, u.email
       FROM organizer_profiles op
       JOIN users u ON u.id = op.user_id
       WHERE op.user_id = :organizerId`, { organizerId });
        const profile = profileRows[0];
        if (!profile)
            return;
        const refundDebt = Number(profile.refund_debt_mwk ?? 0);
        const refundRecovered = Number(profile.refund_recovered_mwk ?? 0);
        await emailService.sendOrganizerRefundDebtEmail({
            email: String(profile.email),
            companyName: String(profile.company_name),
            amountAdded: amount,
            totalDebt: refundDebt,
            outstanding: Math.max(0, refundDebt - refundRecovered),
        });
    }
    catch (err) {
        console.error("[refund-recovery] Organizer debt notification failed:", err);
    }
}
async function getSettledActiveEarnings(organizerId) {
    const [rows] = await pool.query(`SELECT COALESCE(SUM(
       CASE WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
     ), 0) AS settledActive
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.organizer_id = :organizerId
       AND o.status = 'confirmed'
       AND l.status != 'cancelled'`, { organizerId });
    return Number(rows[0]?.settledActive ?? 0);
}
async function getPayoutTotals(organizerId) {
    const [rows] = await pool.query(`SELECT
       COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount_mwk ELSE 0 END), 0) AS reserved,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_mwk ELSE 0 END), 0) AS paidOut
     FROM organizer_payouts WHERE organizer_id = :organizerId`, { organizerId });
    return {
        reserved: Number(rows[0]?.reserved ?? 0),
        paidOut: Number(rows[0]?.paidOut ?? 0),
    };
}
async function fulfillPendingRefunds(organizerId, budget) {
    if (budget <= 0)
        return 0;
    const [pending] = await pool.query(`SELECT tr.id, tr.refund_amount, tr.user_id, tr.order_id, tr.original_amount,
            u.email, u.full_name, ut.reference, o.payment_method
     FROM ticket_refunds tr
     JOIN users u ON u.id = tr.user_id
     JOIN user_tickets ut ON ut.id = tr.user_ticket_id
     JOIN orders o ON o.id = tr.order_id
     WHERE tr.organizer_id = :organizerId AND tr.status = 'pending'
     ORDER BY tr.created_at ASC`, { organizerId });
    let remaining = budget;
    let fulfilled = 0;
    for (const row of pending) {
        const owed = Number(row.refund_amount);
        if (owed <= 0 || remaining < owed)
            continue;
        try {
            await executeCustomerRefundPayment({
                orderId: String(row.order_id),
                refundId: String(row.id),
                refundAmount: owed,
            });
        }
        catch (err) {
            console.error("[refund-recovery] Refund payment failed:", row.id, err instanceof Error ? err.message : err);
            continue;
        }
        await pool.query(`UPDATE ticket_refunds SET status = 'completed', completed_at = NOW(), skip_reason = NULL WHERE id = :id`, { id: row.id });
        await pool.query(`UPDATE orders SET status = 'refunded' WHERE id = :orderId AND status = 'confirmed'`, { orderId: row.order_id });
        try {
            await emailService.sendTicketRefundEmail(row.email, row.full_name, String(row.reference), owed, Number(row.original_amount), "listing_cancellation", refundPaymentMethodLabel(String(row.payment_method ?? "")));
        }
        catch (err) {
            console.error("[refund-recovery] Customer refund email failed:", err);
        }
        remaining -= owed;
        fulfilled += owed;
    }
    return fulfilled;
}
/**
 * Apply settled earnings from active listings toward outstanding refund debt.
 * While debt remains, withdrawable balance stays zero.
 */
export async function applyRefundRecovery(organizerId) {
    const summary = await getOrganizerRefundDebtSummary(organizerId);
    if (summary.outstandingRefundDebt <= 0) {
        return { applied: 0, outstanding: 0 };
    }
    const settledActive = await getSettledActiveEarnings(organizerId);
    const { paidOut, reserved } = await getPayoutTotals(organizerId);
    const salesRecovered = await getSalesRecoveredFromSettledSales(organizerId);
    const freePool = Math.max(0, settledActive - paidOut - reserved - salesRecovered);
    const toApply = Math.min(summary.outstandingRefundDebt, freePool);
    if (toApply <= 0) {
        return { applied: 0, outstanding: summary.outstandingRefundDebt };
    }
    await pool.query(`UPDATE organizer_profiles
     SET refund_recovered_mwk = refund_recovered_mwk + :amount
     WHERE user_id = :organizerId`, { organizerId, amount: toApply });
    await pool.query(`INSERT INTO refund_recovery_allocations (id, organizer_id, amount_mwk, source)
     VALUES (:id, :organizerId, :amount, 'settled_sale')`, { id: uuid(), organizerId, amount: toApply });
    await fulfillPendingRefunds(organizerId, toApply);
    const updated = await getOrganizerRefundDebtSummary(organizerId);
    return { applied: toApply, outstanding: updated.outstandingRefundDebt };
}
export function computeWithdrawableWithDebt(input) {
    if (input.outstandingRefundDebt > 0)
        return 0;
    return Math.max(0, input.settledAmount -
        input.paidOut -
        input.reservedInPayouts -
        input.salesRecovered);
}
export async function syncOrganizerRefundRecovery(organizerId) {
    await applyRefundRecovery(organizerId);
    return getOrganizerRefundDebtSummary(organizerId);
}
export async function syncRefundRecoveryForOrganizersWithDebt() {
    const [rows] = await pool.query(`SELECT user_id FROM organizer_profiles WHERE refund_debt_mwk > refund_recovered_mwk`);
    for (const row of rows) {
        await applyRefundRecovery(String(row.user_id));
    }
}
