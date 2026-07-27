import type { RowDataPacket } from "mysql2";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { fulfillCheckout, fulfillFreeEventCheckout } from "./checkout.service.js";
import {
  getLedgerById,
  parseCheckoutMeta,
  type LedgerRow,
} from "./ledger.service.js";
import { verifyMobileMoneyCharge } from "./paychangu.service.js";
import { log } from "../utils/logger.js";

/** Only auto-reconcile payments created on or after this date. */
const RECONCILIATION_SINCE = "2026-07-25";

export type PaymentRecoveryResult =
  | { status: "already_fulfilled"; ticketCount: number }
  | { status: "payment_not_confirmed"; providerStatus: string; message?: string }
  | { status: "fulfilled"; ticketIds: string[] }
  | { status: "fulfill_failed"; error: string }
  | { status: "ledger_not_found" };

/** Whether tickets exist for this payment (primary order tickets or completed resell transfer). */
export async function countFulfillmentTickets(ledger: LedgerRow): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM user_tickets WHERE order_id = :orderId`,
    { orderId: ledger.order_id },
  );
  const orderTickets = Number(rows[0]?.cnt ?? 0);
  if (orderTickets > 0) return orderTickets;

  const meta = parseCheckoutMeta(ledger);
  const resellTicketId = meta.userTicketId as string | undefined;
  if (meta.resellListingId && resellTicketId) {
    const [resellRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM user_tickets
       WHERE id = :ticketId AND user_id = :userId AND order_id = :orderId`,
      { ticketId: resellTicketId, userId: ledger.user_id, orderId: ledger.order_id },
    );
    return Number(resellRows[0]?.cnt ?? 0);
  }

  return 0;
}

/** Ledgers that may have been charged at PayChangu but never received tickets. */
export async function listLedgersNeedingReconciliation(limit = 50): Promise<LedgerRow[]> {
  const sinceDate = RECONCILIATION_SINCE;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pl.*
     FROM payment_ledger pl
     LEFT JOIN user_tickets ut ON ut.order_id = pl.order_id
     WHERE (
       pl.status IN ('failed', 'completed')
       OR (pl.status = 'pending' AND pl.expires_at <= NOW())
     )
     AND pl.created_at >= :sinceDate
     GROUP BY pl.id
     HAVING COUNT(ut.id) = 0
     ORDER BY pl.created_at DESC
     LIMIT :limit`,
    { limit, sinceDate },
  );

  const candidates = rows as LedgerRow[];
  const needsRecovery: LedgerRow[] = [];
  for (const ledger of candidates) {
    const ticketCount = await countFulfillmentTickets(ledger);
    if (ticketCount === 0) needsRecovery.push(ledger);
  }
  return needsRecovery;
}

export async function attemptPaymentRecovery(
  ledgerId: string,
  options?: { skipPaychanguVerify?: boolean; source?: "poller" | "admin" },
): Promise<PaymentRecoveryResult> {
  const ledger = await getLedgerById(ledgerId);
  if (!ledger) return { status: "ledger_not_found" };

  const ticketCount = await countFulfillmentTickets(ledger);
  if (ticketCount > 0) {
    return { status: "already_fulfilled", ticketCount };
  }

  if (Number(ledger.amount_mwk) <= 0) {
    try {
      await fulfillFreeEventCheckout(ledger, {
        bypassTicketGenerationGate: options?.source === "admin",
      });
      const afterCount = await countFulfillmentTickets(ledger);
      if (afterCount === 0) {
        return { status: "fulfill_failed", error: "Fulfillment completed without creating tickets" };
      }
      log.info("payment-reconciliation", "Recovered free event tickets for ledger", {
        ledgerId,
        source: options?.source ?? "unknown",
      });
      return { status: "fulfilled", ticketIds: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not finalize free event tickets";
      log.error("payment-reconciliation", "Free event recovery failed for ledger", err, { ledgerId });
      return { status: "fulfill_failed", error: message };
    }
  }

  if (!options?.skipPaychanguVerify) {
    const verify = await verifyMobileMoneyCharge(
      ledger.paychangu_charge_id,
      new Date(ledger.created_at),
    );

    await pool.query(
      `UPDATE payment_ledger SET provider_status = :providerStatus, last_polled_at = NOW()
       WHERE id = :ledgerId`,
      { ledgerId, providerStatus: verify.providerStatus },
    );

    if (!verify.success) {
      return {
        status: "payment_not_confirmed",
        providerStatus: verify.providerStatus,
        message: verify.message,
      };
    }
  }

  try {
    const result = await fulfillCheckout(ledger, {
      recovery: true,
      bypassTicketGenerationGate: options?.source === "admin",
    });
    const ticketIds = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "ticketIds" in result
        ? (result.ticketIds as string[])
        : [];
    if (ticketIds.length === 0) {
      const afterCount = await countFulfillmentTickets(ledger);
      if (afterCount === 0) {
        return { status: "fulfill_failed", error: "Fulfillment completed without creating tickets" };
      }
    }
    log.info("payment-reconciliation", "Recovered tickets for ledger", {
      ledgerId,
      source: options?.source ?? "unknown",
    });
    return { status: "fulfilled", ticketIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not finalize tickets after payment";
    log.error("payment-reconciliation", "Recovery failed for ledger", err, { ledgerId });
    return { status: "fulfill_failed", error: message };
  }
}

async function reconciliationTick() {
  try {
    const ledgers = await listLedgersNeedingReconciliation(30);
    if (ledgers.length === 0) return;

    log.info("payment-reconciliation", "Checking payments without tickets", {
      count: ledgers.length,
    });
    for (const ledger of ledgers) {
      const result = await attemptPaymentRecovery(ledger.id, { source: "poller" });
      if (result.status === "fulfilled") {
        log.info("payment-reconciliation", "Auto-issued tickets", {
          orderId: ledger.order_id,
          ledgerId: ledger.id,
        });
      } else if (result.status === "fulfill_failed") {
        log.warn("payment-reconciliation", "Could not auto-fulfill ledger", {
          ledgerId: ledger.id,
          error: result.error,
        });
      }
    }
  } catch (err) {
    log.error("payment-reconciliation", "Tick failed", err);
  }
}

let reconciliationTimer: ReturnType<typeof setInterval> | null = null;

export function startPaymentReconciliationPoller() {
  if (reconciliationTimer) return;

  const intervalMs = env.paychangu.reconciliationIntervalMs;
  void reconciliationTick();
  reconciliationTimer = setInterval(() => void reconciliationTick(), intervalMs);
  log.info("payment-reconciliation", "Started", {
    intervalMs,
    since: RECONCILIATION_SINCE,
  });
}

export function stopPaymentReconciliationPoller() {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }
}
