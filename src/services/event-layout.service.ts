import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";

type EventSpotRow = { number: number; status: string };

export type ParsedEventLayout = {
  enabled: boolean;
  presetId: string;
  elements: Array<Record<string, unknown>>;
  spots: EventSpotRow[];
  totalSpots: number;
};

export function parseEventLayoutJson(raw: unknown): ParsedEventLayout | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  } else {
    return null;
  }

  if (!parsed.enabled) return null;

  const legacyFocal = parsed.focal as Record<string, unknown> | null | undefined;
  const elements = Array.isArray(parsed.elements)
    ? (parsed.elements as Array<Record<string, unknown>>)
    : legacyFocal
      ? [
          {
            id: legacyFocal.id ?? "focal-1",
            kind: legacyFocal.type === "screen" ? "screen" : "stage",
            label: legacyFocal.label ?? "STAGE",
            shape: legacyFocal.shape ?? "rectangle",
            x: legacyFocal.x ?? 20,
            y: legacyFocal.y ?? 6,
            width: legacyFocal.width ?? 60,
            height: legacyFocal.height ?? 10,
          },
        ]
      : [];

  const spots = Array.isArray(parsed.spots)
    ? (parsed.spots as Array<Record<string, unknown>>).map((s, i) => ({
        number: Number(s.number ?? i + 1),
        status: String(s.status ?? "available"),
      }))
    : [];

  if (spots.length === 0) return null;

  return {
    enabled: true,
    presetId: String(parsed.presetId ?? "blank"),
    elements,
    spots,
    totalSpots: Number(parsed.totalSpots ?? spots.length),
  };
}

function parseCheckoutMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

export async function getTakenEventSpotNumbers(listingId: string): Promise<Set<number>> {
  return getOccupiedEventSpotNumbers(listingId);
}

export async function getOccupiedEventSpotNumbers(
  listingId: string,
  options?: { excludeOrderId?: string; conn?: PoolConnection },
): Promise<Set<number>> {
  const q = options?.conn ?? pool;

  const [ticketRows] = await q.query<RowDataPacket[]>(
    `SELECT DISTINCT ut.seat_number AS seatNumber
     FROM user_tickets ut
     JOIN orders o ON o.id = ut.order_id
     WHERE ut.listing_id = :listingId
       AND ut.seat_number IS NOT NULL
       AND ut.status IN ('active', 'used')
       AND o.status = 'confirmed'`,
    { listingId },
  );

  const occupied = new Set(
    ticketRows.map((r) => Number(r.seatNumber)).filter((n) => Number.isFinite(n) && n > 0),
  );

  const [pendingRows] = await q.query<RowDataPacket[]>(
    `SELECT o.id AS orderId, pl.checkout_meta AS checkoutMeta
     FROM payment_ledger pl
     JOIN orders o ON o.id = pl.order_id
     WHERE o.listing_id = :listingId
       AND o.status = 'pending'
       AND pl.status IN ('pending', 'processing')
       AND pl.expires_at > NOW()`,
    { listingId },
  );

  for (const row of pendingRows) {
    if (options?.excludeOrderId && row.orderId === options.excludeOrderId) continue;
    const meta = parseCheckoutMeta(row.checkoutMeta);
    const seatNumbers = (meta?.seatNumbers as number[] | undefined) ?? [];
    for (const num of seatNumbers) {
      if (Number.isFinite(num) && num > 0) occupied.add(num);
    }
  }

  return occupied;
}

export function enrichEventLayoutAvailability(
  raw: unknown,
  takenNumbers: Set<number>,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const layout = { ...(raw as Record<string, unknown>) };
  if (!layout.enabled) return layout as Record<string, unknown>;

  const spots = Array.isArray(layout.spots)
    ? (layout.spots as Array<Record<string, unknown>>).map((s) => {
        const number = Number(s.number);
        const baseStatus = String(s.status ?? "available");
        const taken = takenNumbers.has(number);
        return {
          ...s,
          status: taken ? "taken" : baseStatus === "unavailable" ? "unavailable" : "available",
        };
      })
    : [];

  return { ...layout, spots };
}

export async function assertEventSpotsAvailable(
  listingId: string,
  spotNumbers: number[],
  options?: { conn?: PoolConnection; excludeOrderId?: string },
) {
  const q = options?.conn ?? pool;
  const [layoutRows] = await q.query<RowDataPacket[]>(
    `SELECT event_layout_json FROM listings WHERE id = :listingId LIMIT 1`,
    { listingId },
  );
  const layout = parseEventLayoutJson(layoutRows[0]?.event_layout_json);
  if (!layout) {
    throw new Error("This event does not use assigned seating.");
  }

  const allowed = new Map(layout.spots.map((s) => [s.number, s.status]));
  for (const num of spotNumbers) {
    const status = allowed.get(num);
    if (!status || status === "unavailable") {
      throw new Error(`Spot ${num} is not available`);
    }
  }

  const occupied = await getOccupiedEventSpotNumbers(listingId, {
    conn: options?.conn,
    excludeOrderId: options?.excludeOrderId,
  });
  for (const num of spotNumbers) {
    if (occupied.has(num)) {
      throw new Error(`Spot ${num} is not available`);
    }
  }
}

export function listingUsesEventSeating(layout: ParsedEventLayout | null) {
  return Boolean(layout?.enabled && layout.spots.length > 0);
}
