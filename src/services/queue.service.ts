import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { getCapacityInfo } from "./capacity.service.js";

const PENDING_CHECKOUT_THRESHOLD = 4;
const LOW_REMAINING_THRESHOLD = 15;
const LOW_REMAINING_PENDING_MIN = 2;
const MAX_READY_SLOTS = 3;
const READY_WINDOW_SEC = 120;

type QueueRow = RowDataPacket & {
  id: string;
  listing_id: string;
  user_id: string;
  qty: number;
  seat_numbers: string | null;
  status: string;
  created_at: Date;
  ready_at: Date | null;
  ready_expires_at: Date | null;
};

export async function isHighTraffic(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
): Promise<boolean> {
  const { pendingCount, remaining } = await getCapacityInfo(
    listingId,
    kind,
    ticketCapacity,
  );
  if (pendingCount >= PENDING_CHECKOUT_THRESHOLD) return true;
  if (
    remaining != null &&
    remaining > 0 &&
    remaining <= LOW_REMAINING_THRESHOLD &&
    pendingCount >= LOW_REMAINING_PENDING_MIN
  ) {
    return true;
  }
  return false;
}

async function expireStaleQueueEntries(listingId: string) {
  await pool.query(
    `UPDATE checkout_queue
     SET status = 'expired'
     WHERE listing_id = :listingId
       AND status = 'ready'
       AND ready_expires_at IS NOT NULL
       AND ready_expires_at < NOW()`,
    { listingId },
  );
}

async function promoteWaitingEntries(
  listingId: string,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
) {
  await expireStaleQueueEntries(listingId);

  const { remaining } = await getCapacityInfo(listingId, kind, ticketCapacity);
  const slots = Math.min(
    MAX_READY_SLOTS,
    remaining != null ? Math.max(1, remaining) : MAX_READY_SLOTS,
  );

  const [readyRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM checkout_queue
     WHERE listing_id = :listingId AND status = 'ready'`,
    { listingId },
  );
  const readyCount = Number(readyRows[0]?.cnt ?? 0);
  const toPromote = Math.max(0, slots - readyCount);
  if (toPromote <= 0) return;

  const [waiting] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM checkout_queue
     WHERE listing_id = :listingId AND status = 'waiting'
     ORDER BY created_at ASC
     LIMIT ${toPromote}`,
    { listingId },
  );

  for (const row of waiting) {
    await pool.query(
      `UPDATE checkout_queue
       SET status = 'ready', ready_at = NOW(),
           ready_expires_at = DATE_ADD(NOW(), INTERVAL ${READY_WINDOW_SEC} SECOND)
       WHERE id = :id AND status = 'waiting'`,
      { id: row.id },
    );
  }
}

async function getQueuePosition(queueId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT cq.id, cq.listing_id, cq.status, cq.created_at
     FROM checkout_queue cq WHERE cq.id = :queueId`,
    { queueId },
  );
  const entry = rows[0];
  if (!entry) return 0;
  if (entry.status === "ready") return 1;

  const [posRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS ahead FROM checkout_queue
     WHERE listing_id = :listingId AND status = 'waiting'
       AND created_at < :createdAt`,
    { listingId: entry.listing_id, createdAt: entry.created_at },
  );
  return Number(posRows[0]?.ahead ?? 0) + 1;
}

async function countWaiting(listingId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM checkout_queue
     WHERE listing_id = :listingId AND status = 'waiting'`,
    { listingId },
  );
  return Number(rows[0]?.cnt ?? 0);
}

export async function getCheckoutAccess(
  listingId: string,
  userId: string,
  qty: number,
  seatNumbers: number[] | undefined,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
) {
  const highTraffic = await isHighTraffic(listingId, kind, ticketCapacity);
  if (!highTraffic) {
    return {
      access: "direct" as const,
      highTraffic: false,
      queueId: null as string | null,
      position: 0,
      totalWaiting: 0,
      readyExpiresAt: null as string | null,
    };
  }

  await promoteWaitingEntries(listingId, kind, ticketCapacity);

  const [existing] = await pool.query<QueueRow[]>(
    `SELECT * FROM checkout_queue
     WHERE listing_id = :listingId AND user_id = :userId
       AND status IN ('waiting', 'ready')
     ORDER BY created_at DESC LIMIT 1`,
    { listingId, userId },
  );
  let entry = existing[0];

  if (!entry) {
    const queueId = uuid();
    await pool.query(
      `INSERT INTO checkout_queue (id, listing_id, user_id, qty, seat_numbers, status)
       VALUES (:id, :listingId, :userId, :qty, :seatNumbers, 'waiting')`,
      {
        id: queueId,
        listingId,
        userId,
        qty,
        seatNumbers: seatNumbers?.length ? JSON.stringify(seatNumbers) : null,
      },
    );
    await promoteWaitingEntries(listingId, kind, ticketCapacity);
    const [refreshed] = await pool.query<QueueRow[]>(
      `SELECT * FROM checkout_queue WHERE id = :id`,
      { id: queueId },
    );
    entry = refreshed[0];
  }

  if (!entry) {
    throw new Error("Could not join checkout queue");
  }

  if (entry.status === "ready") {
    const expires = entry.ready_expires_at
      ? new Date(entry.ready_expires_at).toISOString()
      : null;
    return {
      access: "ready" as const,
      highTraffic: true,
      queueId: entry.id,
      position: 1,
      totalWaiting: await countWaiting(listingId),
      readyExpiresAt: expires,
    };
  }

  const position = await getQueuePosition(entry.id);
  return {
    access: "queue" as const,
    highTraffic: true,
    queueId: entry.id,
    position,
    totalWaiting: await countWaiting(listingId),
    readyExpiresAt: null as string | null,
  };
}

export async function assertQueueCheckoutAllowed(
  listingId: string,
  userId: string,
  queueId: string | undefined,
  kind: "event" | "travel",
  ticketCapacity: number | null | undefined,
): Promise<void> {
  const highTraffic = await isHighTraffic(listingId, kind, ticketCapacity);
  if (!highTraffic) return;

  if (!queueId) {
    throw new Error(
      "High demand for this listing. Join the checkout queue before paying.",
    );
  }

  await promoteWaitingEntries(listingId, kind, ticketCapacity);

  const [rows] = await pool.query<QueueRow[]>(
    `SELECT * FROM checkout_queue
     WHERE id = :queueId AND listing_id = :listingId AND user_id = :userId`,
    { queueId, listingId, userId },
  );
  const entry = rows[0];
  if (!entry) {
    throw new Error("Checkout queue entry not found. Please rejoin the queue.");
  }
  if (entry.status !== "ready") {
    throw new Error(
      "Your checkout turn is not ready yet. Stay on the queue page until you are called.",
    );
  }
  if (
    entry.ready_expires_at &&
    new Date(entry.ready_expires_at).getTime() < Date.now()
  ) {
    await pool.query(
      `UPDATE checkout_queue SET status = 'expired' WHERE id = :id`,
      { id: queueId },
    );
    throw new Error("Your checkout window expired. Please rejoin the queue.");
  }
}

export async function completeQueueEntry(queueId: string | undefined) {
  if (!queueId) return;
  await pool.query(
    `UPDATE checkout_queue
     SET status = 'completed', completed_at = NOW()
     WHERE id = :queueId AND status = 'ready'`,
    { queueId },
  );
}

export async function pollQueueStatus(queueId: string, userId: string) {
  const [rows] = await pool.query<QueueRow[]>(
    `SELECT cq.*, l.kind, l.ticket_capacity
     FROM checkout_queue cq
     JOIN listings l ON l.id = cq.listing_id
     WHERE cq.id = :queueId AND cq.user_id = :userId`,
    { queueId, userId },
  );
  const entry = rows[0];
  if (!entry) throw new Error("Queue entry not found");

  await promoteWaitingEntries(
    entry.listing_id,
    entry.kind as "event" | "travel",
    entry.ticket_capacity != null ? Number(entry.ticket_capacity) : null,
  );

  const [refreshed] = await pool.query<QueueRow[]>(
    `SELECT * FROM checkout_queue WHERE id = :queueId`,
    { queueId },
  );
  const current = refreshed[0];
  if (!current) throw new Error("Queue entry not found");

  const position =
    current.status === "ready" ? 1 : await getQueuePosition(queueId);

  return {
    queueId,
    status: current.status,
    position,
    totalWaiting: await countWaiting(current.listing_id),
    readyExpiresAt: current.ready_expires_at
      ? new Date(current.ready_expires_at).toISOString()
      : null,
    access:
      current.status === "ready"
        ? ("ready" as const)
        : current.status === "waiting"
          ? ("queue" as const)
          : ("expired" as const),
  };
}
