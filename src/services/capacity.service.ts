import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool.js";

export type ListingCapacityInfo = {
  ticketCapacity: number | null;
  soldCount: number;
  pendingCount: number;
  remaining: number | null;
};

const PUBLIC_STATUSES = ["published", "sold_out", "cancelled", "postponed"] as const;

/**
 * Published listings are always publicly browsable (including after capacity increases).
 * Sold out, cancelled, and postponed stay visible through the event day.
 */
export const ORGANIZER_PUBLIC_SQL = `
  organizer_id IN (
    SELECT user_id FROM organizer_profiles WHERE status = 'approved'
  )
`;

export const PUBLIC_VISIBILITY_SQL = `
  (
    status = 'published'
    OR (
      status IN ('sold_out', 'cancelled', 'postponed')
      AND (event_starts_on IS NULL OR event_starts_on >= CURDATE())
    )
  )
  AND ${ORGANIZER_PUBLIC_SQL}
`;

export function isPurchasableStatus(status: string): boolean {
  return status === "published";
}

export function isPublicStatus(status: string): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(status);
}

export async function getSoldCount(listingId: string, kind: "event" | "travel"): Promise<number> {
  if (kind === "travel") {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM seats s
       JOIN seat_layouts sl ON sl.id = s.layout_id
       WHERE sl.listing_id = :listingId AND s.status = 'taken'`,
      { listingId },
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(oi.quantity), 0) AS cnt
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.listing_id = :listingId AND o.status = 'confirmed'`,
    { listingId },
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function getPendingCheckoutUnits(listingId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(
       CAST(JSON_UNQUOTE(JSON_EXTRACT(pl.checkout_meta, '$.lineCount')) AS UNSIGNED)
     ), 0) AS cnt
     FROM payment_ledger pl
     JOIN orders o ON o.id = pl.order_id
     WHERE o.listing_id = :listingId AND pl.status = 'pending' AND o.status = 'pending'`,
    { listingId },
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function resolveTicketCapacity(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
): Promise<number | null> {
  if (kind === "travel") {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT total_seats FROM seat_layouts WHERE listing_id = :listingId LIMIT 1`,
      { listingId },
    );
    const seatTotal = rows[0] ? Number(rows[0].total_seats) : null;
    if (ticketCapacity != null && ticketCapacity > 0) {
      return ticketCapacity;
    }
    return seatTotal;
  }
  return ticketCapacity != null && ticketCapacity > 0 ? ticketCapacity : null;
}

export async function getCapacityInfo(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
): Promise<ListingCapacityInfo> {
  const capacity = await resolveTicketCapacity(listingId, kind, ticketCapacity);
  const soldCount = await getSoldCount(listingId, kind);
  const pendingCount = await getPendingCheckoutUnits(listingId);
  const remaining =
    capacity != null ? Math.max(0, capacity - soldCount - pendingCount) : null;

  return {
    ticketCapacity: capacity,
    soldCount,
    pendingCount,
    remaining,
  };
}

export async function syncListingSoldOutStatus(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
): Promise<void> {
  const { ticketCapacity: capacity, soldCount } = await getCapacityInfo(
    listingId,
    kind,
    ticketCapacity,
  );
  if (capacity == null) return;

  if (soldCount >= capacity) {
    await pool.query(
      `UPDATE listings SET status = 'sold_out'
       WHERE id = :listingId AND status IN ('published', 'sold_out')`,
      { listingId },
    );
  }
}

export async function assertCheckoutCapacity(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
  requestedUnits: number,
): Promise<void> {
  const { ticketCapacity: capacity, soldCount, pendingCount } = await getCapacityInfo(
    listingId,
    kind,
    ticketCapacity,
  );
  if (capacity == null) return;

  const available = capacity - soldCount - pendingCount;
  if (requestedUnits > available) {
    if (available <= 0) {
      throw new Error("This event is sold out. No tickets remaining.");
    }
    throw new Error(
      `Only ${available} ticket${available === 1 ? "" : "s"} remaining. Reduce your quantity and try again.`,
    );
  }
}
