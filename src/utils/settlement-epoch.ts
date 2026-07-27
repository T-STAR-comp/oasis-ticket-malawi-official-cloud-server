import { env } from "../config/env.js";

/** Shared payment timestamp used across settlement queries. */
export const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;

/**
 * Only sales on or after this calendar date count toward withdrawable balances.
 * Only sales and payouts on/after this date count toward withdrawable balances.
 */
export const SETTLEMENT_EPOCH_DATE = env.settlement.epochDate;

/** SQL fragment: payment occurred on/after settlement epoch. */
export const WITHDRAWABLE_EPOCH_WHERE = `DATE(${PAYMENT_COMPLETED_AT}) >= '${SETTLEMENT_EPOCH_DATE}'`;

/** SQL fragment: payout requested on/after settlement epoch (pre-epoch payouts excluded from balance math). */
export const PAYOUT_EPOCH_WHERE = `DATE(p.requested_at) >= '${SETTLEMENT_EPOCH_DATE}'`;
