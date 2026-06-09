import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import {
  initiateMobileMoneyRefund,
  refundCardCharge,
  type MomoOperator,
} from "./paychangu.service.js";

export type RefundPaymentInput = {
  orderId: string;
  refundId: string;
  refundAmount: number;
};

function refundChargeId(refundId: string): string {
  return `TM-REF-${refundId.replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Send refund funds via the buyer's original payment method (Airtel, TNM, or card).
 */
export async function executeCustomerRefundPayment(input: RefundPaymentInput): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT o.payment_method, o.payment_phone, pl.paychangu_charge_id
     FROM orders o
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE o.id = :orderId
     LIMIT 1`,
    { orderId: input.orderId },
  );
  const row = rows[0];
  if (!row) throw new Error("Order not found for refund");

  const method = String(row.payment_method);
  const originalChargeId = row.paychangu_charge_id ? String(row.paychangu_charge_id) : null;

  if (env.paychangu.mock) {
    console.log(
      "[refund] mock payout",
      method,
      input.refundAmount,
      originalChargeId ?? row.payment_phone,
    );
    return;
  }

  if (!env.paychangu.apiKey) {
    throw new Error("PayChangu API key is not configured");
  }

  if (method === "card") {
    if (!originalChargeId) throw new Error("Original card charge not found for refund");
    await refundCardCharge(originalChargeId);
    return;
  }

  if (method === "airtel" || method === "tnm") {
    const phone = row.payment_phone ? String(row.payment_phone) : "";
    if (!phone.trim()) {
      throw new Error("Original mobile money number not found for refund");
    }
    await initiateMobileMoneyRefund({
      refundChargeId: refundChargeId(input.refundId),
      amount: input.refundAmount,
      mobile: phone,
      operator: method as MomoOperator,
    });
    return;
  }

  throw new Error(`Unsupported payment method for refund: ${method}`);
}

export function refundPaymentMethodLabel(method: string): string {
  if (method === "airtel") return "Airtel Money";
  if (method === "tnm") return "TNM Mpamba";
  if (method === "card") return "card";
  return method;
}
