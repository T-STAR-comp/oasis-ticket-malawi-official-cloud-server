import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";

const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;

export type ReferrerFinance = {
  totalEarnings: number;
  unsettledAmount: number;
  settledAmount: number;
  reservedInPayouts: number;
  paidOut: number;
  withdrawable: number;
  settlementPolicy: "T+1";
  isReferrer: boolean;
};

export async function getReferrerFinance(userId: string): Promise<ReferrerFinance> {
  const [earnRows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(re.commission_mwk), 0) AS totalEarnings,
       COALESCE(SUM(
         CASE WHEN o.status = 'confirmed' AND CURDATE() <= DATE(${PAYMENT_COMPLETED_AT})
         THEN re.commission_mwk ELSE 0 END
       ), 0) AS unsettledAmount,
       COALESCE(SUM(
         CASE WHEN o.status = 'confirmed' AND CURDATE() > DATE(${PAYMENT_COMPLETED_AT})
         THEN re.commission_mwk ELSE 0 END
       ), 0) AS settledAmount
     FROM referral_earnings re
     JOIN orders o ON o.id = re.order_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE re.referrer_user_id = :userId`,
    { userId },
  );
  const earn = earnRows[0];

  const [payoutRows] = await pool.query<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount_mwk ELSE 0 END), 0) AS reserved,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_mwk ELSE 0 END), 0) AS paidOut
     FROM referrer_payouts WHERE referrer_user_id = :userId`,
    { userId },
  );
  const payouts = payoutRows[0];

  const settledAmount = Number(earn?.settledAmount ?? 0);
  const reserved = Number(payouts?.reserved ?? 0);
  const paidOut = Number(payouts?.paidOut ?? 0);
  const withdrawable = Math.max(0, settledAmount - reserved - paidOut);

  const [refCheck] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM referrer_profiles WHERE user_id = :userId
     UNION SELECT 1 FROM referral_earnings WHERE referrer_user_id = :userId LIMIT 1`,
    { userId },
  );

  return {
    totalEarnings: Number(earn?.totalEarnings ?? 0),
    unsettledAmount: Number(earn?.unsettledAmount ?? 0),
    settledAmount,
    reservedInPayouts: reserved,
    paidOut,
    withdrawable,
    settlementPolicy: "T+1",
    isReferrer: refCheck.length > 0,
  };
}

export async function getReferrerEarningsLines(userId: string, limit = 50) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       re.id, re.commission_mwk AS commission, re.buyer_discount_mwk AS buyerDiscount,
       re.catalog_subtotal_mwk AS catalogSubtotal, re.created_at AS createdAt,
       o.reference, l.title AS listingTitle, lr.name AS referralName, lr.code AS referralCode,
       CASE
         WHEN o.status != 'confirmed' THEN 'pending'
         WHEN CURDATE() > DATE(${PAYMENT_COMPLETED_AT}) THEN 'settled'
         ELSE 'pending_settlement'
       END AS settlementStatus
     FROM referral_earnings re
     JOIN orders o ON o.id = re.order_id
     JOIN listings l ON l.id = re.listing_id
     JOIN listing_referrals lr ON lr.id = re.referral_id
     JOIN payment_ledger pl ON pl.order_id = o.id AND pl.status = 'completed'
     WHERE re.referrer_user_id = :userId
     ORDER BY re.created_at DESC
     LIMIT ${Number(limit)}`,
    { userId },
  );
  return rows.map((r) => ({
    id: r.id as string,
    commission: Number(r.commission),
    buyerDiscount: Number(r.buyerDiscount),
    catalogSubtotal: Number(r.catalogSubtotal),
    reference: r.reference as string,
    listingTitle: r.listingTitle as string,
    referralName: r.referralName as string,
    referralCode: r.referralCode as string,
    settlementStatus: r.settlementStatus as string,
    createdAt: String(r.createdAt),
  }));
}
