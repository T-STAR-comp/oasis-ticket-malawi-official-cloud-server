import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { verifyDirectChargeTransaction } from "./paychangu.service.js";
import { log } from "../utils/logger.js";

type PayoutRow = RowDataPacket & {
  id: string;
  paychangu_charge_id: string;
  status: string;
  requested_at: Date;
};

export type PayoutReconcileResult =
  | { status: "not_found" }
  | { status: "already_final"; payoutStatus: string }
  | { status: "still_processing"; providerStatus: string }
  | { status: "completed"; providerStatus: string }
  | { status: "failed"; providerStatus: string; reason: string };

async function getPayoutById(payoutId: string): Promise<PayoutRow | null> {
  const [rows] = await pool.query<PayoutRow[]>(
    `SELECT id, paychangu_charge_id, status, requested_at
     FROM organizer_payouts WHERE id = :payoutId LIMIT 1`,
    { payoutId },
  );
  return rows[0] ?? null;
}

export async function listProcessingOrganizerPayouts(limit = 50): Promise<PayoutRow[]> {
  const [rows] = await pool.query<PayoutRow[]>(
    `SELECT p.id, p.paychangu_charge_id, p.status, p.requested_at
     FROM organizer_payouts p
     INNER JOIN users u ON u.id = p.organizer_id
     WHERE p.status IN ('pending', 'processing')
     ORDER BY p.requested_at ASC
     LIMIT :limit`,
    { limit },
  );
  return rows;
}

/** Payout rows whose organizer account was removed — they cannot be updated (FK). */
export async function cleanupOrphanOrganizerPayouts(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE p FROM organizer_payouts p
     LEFT JOIN users u ON u.id = p.organizer_id
     WHERE u.id IS NULL`,
  );
  const removed = Number(result.affectedRows ?? 0);
  if (removed > 0) {
    log.warn("payout-reconciliation", "Removed orphan payout rows", { removed });
  }
  return removed;
}

export async function attemptPayoutReconciliation(payoutId: string): Promise<PayoutReconcileResult> {
  const payout = await getPayoutById(payoutId);
  if (!payout) return { status: "not_found" };

  if (payout.status === "completed" || payout.status === "failed") {
    return { status: "already_final", payoutStatus: payout.status };
  }

  const verify = await verifyDirectChargeTransaction(
    payout.paychangu_charge_id,
    new Date(payout.requested_at),
  );

  if (verify.success) {
    await pool.query(
      `UPDATE organizer_payouts
       SET status = 'completed', provider_status = :providerStatus, completed_at = NOW()
       WHERE id = :id`,
      { id: payoutId, providerStatus: verify.providerStatus },
    );
    log.info("payout-reconciliation", "Payout marked completed", {
      payoutId,
      chargeId: payout.paychangu_charge_id,
    });
    return { status: "completed", providerStatus: verify.providerStatus };
  }

  if (verify.failed) {
    const reason = verify.message || "Payout failed at PayChangu";
    await pool.query(
      `UPDATE organizer_payouts
       SET status = 'failed', provider_status = :providerStatus, failure_reason = :reason
       WHERE id = :id`,
      { id: payoutId, providerStatus: verify.providerStatus, reason },
    );
    log.warn("payout-reconciliation", "Payout marked failed", {
      payoutId,
      chargeId: payout.paychangu_charge_id,
      reason,
    });
    return { status: "failed", providerStatus: verify.providerStatus, reason };
  }

  await pool.query(
    `UPDATE organizer_payouts SET provider_status = :providerStatus WHERE id = :id`,
    { id: payoutId, providerStatus: verify.providerStatus },
  );

  return { status: "still_processing", providerStatus: verify.providerStatus };
}

export async function reconcileAllProcessingPayouts(limit = 50) {
  const payouts = await listProcessingOrganizerPayouts(limit);
  const results = {
    checked: payouts.length,
    completed: 0,
    failed: 0,
    stillProcessing: 0,
  };

  for (const payout of payouts) {
    try {
      const result = await attemptPayoutReconciliation(payout.id);
      if (result.status === "completed") results.completed += 1;
      else if (result.status === "failed") results.failed += 1;
      else if (result.status === "still_processing") results.stillProcessing += 1;
    } catch (err) {
      log.error("payout-reconciliation", "Payout reconcile failed", err, {
        payoutId: payout.id,
        chargeId: payout.paychangu_charge_id,
      });
    }
  }

  return results;
}

async function reconciliationTick() {
  try {
    await cleanupOrphanOrganizerPayouts();
    const result = await reconcileAllProcessingPayouts(30);
    if (result.checked === 0) return;
    log.info("payout-reconciliation", "Tick finished", result);
  } catch (err) {
    log.error("payout-reconciliation", "Tick failed", err);
  }
}

let reconciliationTimer: ReturnType<typeof setInterval> | null = null;

export function startPayoutReconciliationPoller() {
  if (reconciliationTimer) return;

  const intervalMs = env.paychangu.reconciliationIntervalMs;
  void reconciliationTick();
  reconciliationTimer = setInterval(() => void reconciliationTick(), intervalMs);
  log.info("payout-reconciliation", "Started", { intervalMs });
}

export function stopPayoutReconciliationPoller() {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }
}
