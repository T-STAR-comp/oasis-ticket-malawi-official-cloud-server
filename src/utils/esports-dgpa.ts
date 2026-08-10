/** Share of each buy-in (after the half-full threshold) added to the live grand prize. */
export const DGPA_CONTRIBUTION_RATE = 0.7;

/** Completed registrations must exceed this count before DGPA contributions apply. */
export function dgpaHalfFullThreshold(maxSlots: number): number {
  return Math.floor(Math.max(1, maxSlots) / 2);
}

export function dgpaApplies(completedCount: number, maxSlots: number): boolean {
  return completedCount > dgpaHalfFullThreshold(maxSlots);
}

export function dgpaContributionFromBuyIn(entryPriceMwk: number): number {
  if (entryPriceMwk <= 0) return 0;
  return Math.round(entryPriceMwk * DGPA_CONTRIBUTION_RATE);
}
