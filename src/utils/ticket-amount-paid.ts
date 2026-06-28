/** Split order total (MWK) across ticket lines; distributes remainder over first tickets. */
export function distributeTicketAmountPaid(orderTotalMwk: number, lineCount: number): number[] {
  if (lineCount <= 0) return [];
  const total = Math.max(0, Math.floor(orderTotalMwk));
  const base = Math.floor(total / lineCount);
  const remainder = total - base * lineCount;
  return Array.from({ length: lineCount }, (_, i) => base + (i < remainder ? 1 : 0));
}
