import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import type { LedgerRow } from "./ledger.service.js";
import {
  initiateMobileMoneyRefund,
  type MomoOperator,
} from "./paychangu.service.js";
import { releaseResellListingHoldForOrder } from "./resell.service.js";

function failureRefundChargeId(ledgerId: string): string {
  return `TM-FAIL-${ledgerId.replace(/-/g, "").slice(0, 24)}`;
}

/** Buyer was charged at PayChangu but fulfillment failed — return funds via mobile money. */
export async function refundBuyerAfterFulfillFailure(
  ledger: LedgerRow,
  reason: string,
): Promise<void> {
  const amount = Number(ledger.amount_mwk);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const method = String(ledger.payment_method ?? "");
  const phone = String(ledger.payment_phone ?? "").trim();

  if (env.paychangu.mock) {
    console.log("[payment-failure-refund] mock refund", amount, method, phone, reason);
    return;
  }

  if (!env.paychangu.apiKey) {
    console.error("[payment-failure-refund] PayChangu not configured; manual refund required", ledger.id);
    return;
  }

  if (method !== "airtel" && method !== "tnm") {
    console.error(
      "[payment-failure-refund] Auto-refund not supported for method",
      method,
      ledger.id,
    );
    return;
  }

  if (!phone) {
    console.error("[payment-failure-refund] Missing payment phone for refund", ledger.id);
    return;
  }

  try {
    await initiateMobileMoneyRefund({
      refundChargeId: failureRefundChargeId(ledger.id),
      amount,
      mobile: phone,
      operator: method as MomoOperator,
    });
    console.log("[payment-failure-refund] Refund initiated for ledger", ledger.id, amount);
  } catch (err) {
    console.error("[payment-failure-refund] Refund failed for ledger", ledger.id, err);
  }
}

export async function failCheckoutWithRecovery(
  ledger: LedgerRow,
  reason: string,
  options?: { paymentSucceeded?: boolean },
) {
  if (options?.paymentSucceeded) {
    await refundBuyerAfterFulfillFailure(ledger, reason);
  }

  await pool.query(
    `UPDATE payment_ledger SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
     WHERE id = :ledgerId AND status = 'pending'`,
    { ledgerId: ledger.id, reason },
  );
  await pool.query(
    `UPDATE orders SET status = 'failed' WHERE id = :orderId AND status = 'pending'`,
    { orderId: ledger.order_id },
  );

  await releaseResellListingHoldForOrder(ledger.order_id);
}
