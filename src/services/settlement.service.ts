import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";
import {
  computeWithdrawableWithDebt,
  getSalesRecoveredFromSettledSales,
  syncOrganizerRefundRecovery,
  type RefundDebtSummary,
} from "./refund-recovery.service.js";
import { EXCLUDE_RESALE_ORDERS_SQL } from "../utils/settlement-filters.js";
import {
  getOrganizerVirtualPayoutHold,
  UNVERIFIED_VIRTUAL_PAYOUT_WHERE,
} from "./virtual-payout.service.js";

/**
 * PayChangu T+1 settlement: a payment completed on calendar day D becomes
 * withdrawable on day D+1 (first moment of the next calendar day).
 *
 * SQL rule: settled when CURDATE() > DATE(payment_completed_at)
 */
const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;

export type SettlementBalances = {
  totalEarnings: number;
  unsettledAmount: number;
  settledAmount: number;
  reservedInPayouts: number;
  paidOut: number;
  withdrawable: number;
  virtualPayoutHold: number;
  refundDebt: number;
  refundRecovered: number;
  outstandingRefundDebt: number;
  pendingCustomerRefunds: number;
  settlementPolicy: "T+1";
};

function mapBalances(
  row: RowDataPacket | undefined,
  debt: RefundDebtSummary,
  salesRecovered: number,
  virtualPayoutHold: number,
): SettlementBalances {
  const totalEarnings = Number(row?.totalEarnings ?? 0);
  const unsettledAmount = Number(row?.unsettledAmount ?? 0);
  const settledAmount = Number(row?.settledAmount ?? 0);
  const reservedInPayouts = Number(row?.reservedInPayouts ?? 0);
  const paidOut = Number(row?.paidOut ?? 0);
  const withdrawable = computeWithdrawableWithDebt({
    settledAmount,
    paidOut,
    reservedInPayouts,
    outstandingRefundDebt: debt.outstandingRefundDebt,
    salesRecovered,
    virtualPayoutHold,
  });

  return {
    totalEarnings,
    unsettledAmount,
    settledAmount,
    reservedInPayouts,
    paidOut,
    withdrawable,
    virtualPayoutHold,
    refundDebt: debt.refundDebt,
    refundRecovered: debt.refundRecovered,
    outstandingRefundDebt: debt.outstandingRefundDebt,
    pendingCustomerRefunds: debt.pendingCustomerRefunds,
    settlementPolicy: "T+1",
  };
}

export async function getOrganizerSettlementBalances(
  organizerId: string,
): Promise<SettlementBalances> {
  const debt = await syncOrganizerRefundRecovery(organizerId);
  const salesRecovered = await getSalesRecoveredFromSettledSales(organizerId);
  const virtualPayoutHold = await getOrganizerVirtualPayoutHold(organizerId);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(o.subtotal_mwk), 0) AS totalEarnings,
       COALESCE(SUM(
         CASE WHEN CURDATE() <= DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS unsettledAmount,
       COALESCE(SUM(
         CASE WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS settledAmount,
       (
         SELECT COALESCE(SUM(p.amount_mwk), 0)
         FROM organizer_payouts p
         WHERE p.organizer_id = :organizerId
           AND p.status IN ('pending', 'processing')
       ) AS reservedInPayouts,
       (
         SELECT COALESCE(SUM(p.amount_mwk), 0)
         FROM organizer_payouts p
         WHERE p.organizer_id = :organizerId
           AND p.status = 'completed'
       ) AS paidOut
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.organizer_id = :organizerId
       AND o.status = 'confirmed'
       AND l.status != 'cancelled'
       ${EXCLUDE_RESALE_ORDERS_SQL}`,
    { organizerId },
  );
  return mapBalances(rows[0], debt, salesRecovered, virtualPayoutHold);
}

export async function getPlatformSettlementBalances(): Promise<SettlementBalances> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(o.subtotal_mwk), 0) AS totalEarnings,
       COALESCE(SUM(
         CASE WHEN CURDATE() <= DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS unsettledAmount,
       COALESCE(SUM(
         CASE WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS settledAmount,
       (
         SELECT COALESCE(SUM(p.amount_mwk), 0)
         FROM organizer_payouts p
         WHERE p.status IN ('pending', 'processing')
       ) AS reservedInPayouts,
       (
         SELECT COALESCE(SUM(p.amount_mwk), 0)
         FROM organizer_payouts p
         WHERE p.status = 'completed'
       ) AS paidOut
     FROM orders o
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE o.status = 'confirmed'
       ${EXCLUDE_RESALE_ORDERS_SQL}`,
  );

  const emptyDebt: RefundDebtSummary = {
    refundDebt: 0,
    refundRecovered: 0,
    outstandingRefundDebt: 0,
    pendingCustomerRefunds: 0,
  };
  return mapBalances(rows[0], emptyDebt, 0, 0);
}

export type SettlementLine = {
  orderId: string;
  reference: string;
  listingTitle: string;
  organizerAmount: number;
  paidAt: string;
  withdrawableAt: string;
  settlementStatus: "pending_settlement" | "settled" | "cancelled_hold" | "virtual_payout_hold";
};

export async function getOrganizerSettlementLines(organizerId: string, limit = 100) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       o.id AS orderId,
       o.reference,
       l.title AS listingTitle,
       o.subtotal_mwk AS organizerAmount,
       ${PAYMENT_COMPLETED_AT} AS paidAt,
       DATE_ADD(DATE(${PAYMENT_COMPLETED_AT}), INTERVAL 1 DAY) AS withdrawableAt,
       CASE
         WHEN l.status = 'cancelled' THEN 'cancelled_hold'
         WHEN ${UNVERIFIED_VIRTUAL_PAYOUT_WHERE}
              AND CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN 'virtual_payout_hold'
         WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN 'settled'
         ELSE 'pending_settlement'
       END AS settlementStatus
     FROM orders o
     JOIN listings l ON l.id = o.listing_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE l.organizer_id = :organizerId AND o.status IN ('confirmed', 'refunded')
       ${EXCLUDE_RESALE_ORDERS_SQL}
     ORDER BY ${PAYMENT_COMPLETED_AT} DESC
     LIMIT ${Number(limit)}`,
    { organizerId },
  );

  return rows.map((r) => ({
    orderId: r.orderId as string,
    reference: r.reference as string,
    listingTitle: r.listingTitle as string,
    organizerAmount: Number(r.organizerAmount ?? 0),
    paidAt: String(r.paidAt),
    withdrawableAt: String(r.withdrawableAt),
    settlementStatus: r.settlementStatus as SettlementLine["settlementStatus"],
  }));
}

export async function getAdminSettlementByOrganizer() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       op.user_id AS organizerId,
       op.company_name AS companyName,
       COALESCE(SUM(o.subtotal_mwk), 0) AS totalEarnings,
       COALESCE(SUM(
         CASE WHEN CURDATE() <= DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS unsettledAmount,
       COALESCE(SUM(
         CASE WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN o.subtotal_mwk ELSE 0 END
       ), 0) AS settledAmount,
       op.refund_debt_mwk AS refundDebt,
       op.refund_recovered_mwk AS refundRecovered
     FROM organizer_profiles op
     LEFT JOIN listings l ON l.organizer_id = op.user_id
     LEFT JOIN orders o ON o.listing_id = l.id AND o.status = 'confirmed'
       ${EXCLUDE_RESALE_ORDERS_SQL}
     LEFT JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     GROUP BY op.user_id, op.company_name, op.refund_debt_mwk, op.refund_recovered_mwk
     HAVING totalEarnings > 0
     ORDER BY totalEarnings DESC`,
  );

  const payoutRows = await pool.query<RowDataPacket[]>(
    `SELECT organizer_id,
       COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount_mwk ELSE 0 END), 0) AS reserved,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_mwk ELSE 0 END), 0) AS paidOut
     FROM organizer_payouts
     GROUP BY organizer_id`,
  );
  const payoutMap = new Map(
    payoutRows[0].map((r) => [
      r.organizer_id as string,
      { reserved: Number(r.reserved), paidOut: Number(r.paidOut) },
    ]),
  );

  return Promise.all(
    rows.map(async (r) => {
      const settled = Number(r.settledAmount ?? 0);
      const organizerId = r.organizerId as string;
      const payouts = payoutMap.get(organizerId) ?? { reserved: 0, paidOut: 0 };
      const refundDebt = Number(r.refundDebt ?? 0);
      const refundRecovered = Number(r.refundRecovered ?? 0);
      const outstandingRefundDebt = Math.max(0, refundDebt - refundRecovered);
      const salesRecovered = await getSalesRecoveredFromSettledSales(organizerId);
      const virtualPayoutHold = await getOrganizerVirtualPayoutHold(organizerId);
      return {
        organizerId,
        companyName: r.companyName as string,
        totalEarnings: Number(r.totalEarnings ?? 0),
        unsettledAmount: Number(r.unsettledAmount ?? 0),
        settledAmount: settled,
        reservedInPayouts: payouts.reserved,
        paidOut: payouts.paidOut,
        outstandingRefundDebt,
        virtualPayoutHold,
        withdrawable: computeWithdrawableWithDebt({
          settledAmount: settled,
          paidOut: payouts.paidOut,
          reservedInPayouts: payouts.reserved,
          outstandingRefundDebt,
          salesRecovered,
          virtualPayoutHold,
        }),
      };
    }),
  );
}
