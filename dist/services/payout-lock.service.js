import { pool } from "../db/pool.js";
export async function withPayoutLock(lockKey, fn) {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(`SELECT GET_LOCK(:lockKey, 15) AS ok`, {
            lockKey,
        });
        if (Number(rows[0]?.ok) !== 1) {
            throw new Error("Another payout request is in progress. Please wait and try again.");
        }
        return await fn();
    }
    finally {
        await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
        conn.release();
    }
}
