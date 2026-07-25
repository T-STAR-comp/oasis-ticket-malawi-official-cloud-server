import { pool } from "../db/pool.js";
export async function getUserPendingLedger(userId) {
    const [rows] = await pool.query(`SELECT * FROM payment_ledger
     WHERE user_id = :userId AND status = 'pending' AND expires_at > NOW()
     LIMIT 1`, { userId });
    return rows[0] ?? null;
}
export async function listExpiredPendingLedgers() {
    const [rows] = await pool.query(`SELECT * FROM payment_ledger
     WHERE status = 'pending'
       AND TIMESTAMPDIFF(SECOND, NOW(), expires_at) <= 0
       AND TIMESTAMPDIFF(SECOND, created_at, NOW()) > 90`);
    return rows;
}
export async function getLedgerByOrderId(orderId, userId) {
    let sql = `SELECT * FROM payment_ledger WHERE order_id = :orderId`;
    const params = { orderId };
    if (userId) {
        sql += ` AND user_id = :userId`;
        params.userId = userId;
    }
    sql += ` LIMIT 1`;
    const [rows] = await pool.query(sql, params);
    return rows[0] ?? null;
}
/** Pending guest checkout for the same browser session key. */
export async function getGuestPendingLedger(guestKey) {
    const normalized = guestKey.trim().slice(0, 64);
    if (!normalized)
        return null;
    const [rows] = await pool.query(`SELECT pl.* FROM payment_ledger pl
     WHERE pl.user_id IS NULL
       AND pl.status = 'pending'
       AND pl.expires_at > NOW()
       AND JSON_UNQUOTE(JSON_EXTRACT(pl.checkout_meta, '$.guestKey')) = :guestKey
     ORDER BY pl.created_at DESC
     LIMIT 1`, { guestKey: normalized });
    return rows[0] ?? null;
}
export async function getLedgerById(ledgerId) {
    const [rows] = await pool.query(`SELECT * FROM payment_ledger WHERE id = :ledgerId LIMIT 1`, { ledgerId });
    return rows[0] ?? null;
}
export async function listPendingLedgerEntries() {
    const [rows] = await pool.query(`SELECT * FROM payment_ledger
     WHERE status = 'pending' AND expires_at > NOW()
     ORDER BY created_at ASC`);
    return rows;
}
export function parseCheckoutMeta(row) {
    const raw = row.checkout_meta;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    return (raw ?? {});
}
