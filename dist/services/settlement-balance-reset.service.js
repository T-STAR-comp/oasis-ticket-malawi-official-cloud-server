import { pool } from "../db/pool.js";
import { SETTLEMENT_EPOCH_DATE } from "../utils/settlement-epoch.js";
import { log } from "../utils/logger.js";
/**
 * One-time-style cleanup on server start: pre-epoch payout requests must not
 * reserve balances or block post-epoch withdrawals.
 */
export async function applySettlementEpochResetOnStartup() {
    const [pendingRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM organizer_payouts
     WHERE status IN ('pending', 'processing')
       AND DATE(requested_at) < :epochDate`, { epochDate: SETTLEMENT_EPOCH_DATE });
    const stalePending = Number(pendingRows[0]?.cnt ?? 0);
    if (stalePending > 0) {
        await pool.query(`UPDATE organizer_payouts
       SET status = 'failed',
           failure_reason = 'Cancelled — earnings before settlement epoch (5 Aug 2026) do not apply.',
           completed_at = NOW()
       WHERE status IN ('pending', 'processing')
         AND DATE(requested_at) < :epochDate`, { epochDate: SETTLEMENT_EPOCH_DATE });
    }
    const [verificationRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM payout_verifications
     WHERE status = 'pending'
       AND DATE(created_at) < :epochDate`, { epochDate: SETTLEMENT_EPOCH_DATE });
    const staleVerifications = Number(verificationRows[0]?.cnt ?? 0);
    if (staleVerifications > 0) {
        await pool.query(`UPDATE payout_verifications
       SET status = 'expired'
       WHERE status = 'pending'
         AND DATE(created_at) < :epochDate`, { epochDate: SETTLEMENT_EPOCH_DATE });
    }
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
    if (preEpochDebtWriteoffs > 0) {
        await pool.query(`UPDATE organizer_profiles op
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
    }
    log.info("settlement-epoch", "Withdrawable balances reset to post-epoch only", {
        epochDate: SETTLEMENT_EPOCH_DATE,
        cancelledStalePayouts: stalePending,
        expiredStaleVerifications: staleVerifications,
        preEpochRefundDebtWriteoffs: preEpochDebtWriteoffs,
    });
}
