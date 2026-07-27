import { env } from "../config/env.js";

/** Shared payment timestamp used across settlement queries. */
export const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;

/**
 * Only sales on or after this calendar date count toward withdrawable balances.
 * Pre-epoch earnings remain visible for audit but cannot be withdrawn.
 */
export const SETTLEMENT_EPOCH_DATE = env.settlement.epochDate;

/** SQL fragment: payment occurred on/after settlement epoch. */
export const WITHDRAWABLE_EPOCH_WHERE = `DATE(${PAYMENT_COMPLETED_AT}) >= '${SETTLEMENT_EPOCH_DATE}'`;
