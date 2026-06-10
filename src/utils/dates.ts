/** Malawi (CAT) — used for event-day comparisons in SQL via pool timezone. */
export const APP_TIMEZONE = "+02:00";

/** Normalize MySQL DATE / ISO strings to YYYY-MM-DD without timezone shift. */
export function formatSqlDate(value: string | Date | null | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return undefined;
}

export function parseEventDateInput(value: unknown): string | null {
  const formatted = formatSqlDate(
    typeof value === "string" || value instanceof Date ? value : null,
  );
  return formatted ?? null;
}
