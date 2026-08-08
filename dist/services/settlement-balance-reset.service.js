import { pool } from "../db/pool.js";
import { SETTLEMENT_EPOCH_DATE } from "../utils/settlement-epoch.js";
import { log } from "../utils/logger.js";
/**
 * One-time-style cleanup on server start: pre-epoch payout requests must not
 * reserve balances or block post-epoch withdrawals.
 */
export async function applySettlementEpochResetOnStartup() {
    const cancelledStalePayouts = await cancelStaleOrganizerPayouts();
    const { expired: expiredStaleVerifications, deletedOrphans: deletedOrphanVerifications } = await expireStalePayoutVerifications();
    const preEpochDebtWriteoffs = await writeOffPreEpochRefundDebt();
    log.info("settlement-epoch", "Withdrawable balances reset to post-epoch only", {
        epochDate: SETTLEMENT_EPOCH_DATE,
        cancelledStalePayouts,
        expiredStaleVerifications,
        deletedOrphanVerifications,
        preEpochRefundDebtWriteoffs: preEpochDebtWriteoffs,
    });
}
async function cancelStaleOrganizerPayouts() {
    const params = { epochDate: SETTLEMENT_EPOCH_DATE };
    const [orphanResult] = await pool.query(`DELETE p FROM organizer_payouts p
     LEFT JOIN users u ON u.id = p.organizer_id
     WHERE u.id IS NULL
       AND p.status IN ('pending', 'processing')
       AND DATE(p.requested_at) < :epochDate`, params);
    const [updateResult] = await pool.query(`UPDATE organizer_payouts p
     JOIN users u ON u.id = p.organizer_id
     SET p.status = 'failed',
         p.failure_reason = 'Cancelled — earnings before settlement epoch (5 Aug 2026) do not apply.',
         p.completed_at = NOW()
     WHERE p.status IN ('pending', 'processing')
       AND DATE(p.requested_at) < :epochDate`, params);
    if (orphanResult.affectedRows > 0) {
        log.warn("settlement-epoch", "Removed orphaned stale organizer payouts", {
            count: orphanResult.affectedRows,
        });
    }
    return updateResult.affectedRows;
}
async function expireStalePayoutVerifications() {
    const params = { epochDate: SETTLEMENT_EPOCH_DATE };
    const [orphanResult] = await pool.query(`DELETE pv FROM payout_verifications pv
     LEFT JOIN users u ON u.id = pv.organizer_id
     WHERE u.id IS NULL
       AND pv.status = 'pending'
       AND DATE(pv.created_at) < :epochDate`, params);
    const [updateResult] = await pool.query(`UPDATE payout_verifications pv
     JOIN users u ON u.id = pv.organizer_id
     SET pv.status = 'expired'
     WHERE pv.status = 'pending'
       AND DATE(pv.created_at) < :epochDate`, params);
    if (orphanResult.affectedRows > 0) {
        log.warn("settlement-epoch", "Removed orphaned stale payout verifications", {
            count: orphanResult.affectedRows,
        });
    }
    return {
        expired: updateResult.affectedRows,
        deletedOrphans: orphanResult.affectedRows,
    };
}
async function writeOffPreEpochRefundDebt() {
    const [debtRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM organizer_profiles op
     WHERE op.refund_debt_mwk > op.refund_recovered_mwk
       AND NOT EXISTS (
         SELECT 1 FROM ticket_refunds tr
         JOIN orders o ON o.id = tr.order_id
         JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
         WHERE tr.organizer_id = op.user_id
           AND tr.status IN ('pending', 'completed')
           AND DATE(COALESCE(pl.completed_at, o.updated_at, o.created_at)) >= :epochDate
       )`, { epochDate: SETTLEMENT_EPOCH_DATE });
    const preEpochDebtWriteoffs = Number(debtRows[0]?.cnt ?? 0);
    if (preEpochDebtWriteoffs <= 0)
        return 0;
    const [updateResult] = await pool.query(`UPDATE organizer_profiles op
     SET refund_recovered_mwk = refund_debt_mwk
     WHERE op.refund_debt_mwk > op.refund_recovered_mwk
       AND NOT EXISTS (
         SELECT 1 FROM ticket_refunds tr
         JOIN orders o ON o.id = tr.order_id
         JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
         WHERE tr.organizer_id = op.user_id
           AND tr.status IN ('pending', 'completed')
           AND DATE(COALESCE(pl.completed_at, o.updated_at, o.created_at)) >= :epochDate
       )`, { epochDate: SETTLEMENT_EPOCH_DATE });
    return updateResult.affectedRows;
}
