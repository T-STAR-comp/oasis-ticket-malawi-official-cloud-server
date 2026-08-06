/** Shared payment timestamp used across settlement queries. */
export const PAYMENT_COMPLETED_AT = `COALESCE(pl.completed_at, o.updated_at, o.created_at)`;
/**
 * Settlement reset cutoff (hardcoded).
 * Sales and payouts before this date do not count toward withdrawable balances.
 * Revenue earned before 5 August 2026 is treated as zero for withdrawal purposes.
 */
export const SETTLEMENT_EPOCH_DATE = "2026-08-05";
/** SQL fragment: payment occurred on/after settlement epoch. */
export const WITHDRAWABLE_EPOCH_WHERE = `DATE(${PAYMENT_COMPLETED_AT}) >= '${SETTLEMENT_EPOCH_DATE}'`;
/** SQL fragment: payout requested on/after settlement epoch (pre-epoch payouts excluded from balance math). */
export const PAYOUT_EPOCH_WHERE = `DATE(p.requested_at) >= '${SETTLEMENT_EPOCH_DATE}'`;
/** SQL fragment: order/payment strictly before settlement epoch. */
export const PRE_EPOCH_PAYMENT_WHERE = `DATE(${PAYMENT_COMPLETED_AT}) < '${SETTLEMENT_EPOCH_DATE}'`;
