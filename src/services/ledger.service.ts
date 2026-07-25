import type { RowDataPacket } from "mysql2";
import { pool, type QueryParams } from "../db/pool.js";

export type LedgerStatus = "pending" | "completed" | "failed";

export type LedgerRow = {
  id: string;
  user_id: string | null;
  order_id: string;
  status: LedgerStatus;
  paychangu_charge_id: string;
  paychangu_trans_id: string | null;
  paychangu_ref_id: string | null;
  amount_mwk: number;
  payment_method: "airtel" | "tnm" | "card";
  payment_phone: string | null;
  account_name: string;
  account_email: string;
  account_phone: string;
  checkout_meta: Record<string, unknown>;
  provider_status: string | null;
  failure_reason: string | null;
  expires_at: Date;
  completed_at: Date | null;
  last_polled_at: Date | null;
  poll_count: number;
  created_at: Date;
};

export async function getUserPendingLedger(userId: string): Promise<LedgerRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM payment_ledger
     WHERE user_id = :userId AND status = 'pending' AND expires_at > NOW()
     LIMIT 1`,
    { userId },
  );
  return (rows[0] as LedgerRow | undefined) ?? null;
}

export async function listExpiredPendingLedgers(): Promise<LedgerRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM payment_ledger
     WHERE status = 'pending'
       AND TIMESTAMPDIFF(SECOND, NOW(), expires_at) <= 0
       AND TIMESTAMPDIFF(SECOND, created_at, NOW()) > 90`,
  );
  return rows as LedgerRow[];
}

export async function getLedgerByOrderId(orderId: string, userId?: string): Promise<LedgerRow | null> {
  let sql = `SELECT * FROM payment_ledger WHERE order_id = :orderId`;
  const params: QueryParams = { orderId };
  if (userId) {
    sql += ` AND user_id = :userId`;
    params.userId = userId;
  }
  sql += ` LIMIT 1`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return (rows[0] as LedgerRow | undefined) ?? null;
}

/** Pending guest checkout for the same browser session key. */
export async function getGuestPendingLedger(guestKey: string): Promise<LedgerRow | null> {
  const normalized = guestKey.trim().slice(0, 64);
  if (!normalized) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT pl.* FROM payment_ledger pl
     WHERE pl.user_id IS NULL
       AND pl.status = 'pending'
       AND pl.expires_at > NOW()
       AND JSON_UNQUOTE(JSON_EXTRACT(pl.checkout_meta, '$.guestKey')) = :guestKey
     ORDER BY pl.created_at DESC
     LIMIT 1`,
    { guestKey: normalized },
  );
  return (rows[0] as LedgerRow | undefined) ?? null;
}

export async function getLedgerById(ledgerId: string): Promise<LedgerRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM payment_ledger WHERE id = :ledgerId LIMIT 1`,
    { ledgerId },
  );
  return (rows[0] as LedgerRow | undefined) ?? null;
}

export async function listPendingLedgerEntries(): Promise<LedgerRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM payment_ledger
     WHERE status = 'pending' AND expires_at > NOW()
     ORDER BY created_at ASC`,
  );
  return rows as LedgerRow[];
}

export function parseCheckoutMeta(row: LedgerRow) {
  const raw = row.checkout_meta;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}
