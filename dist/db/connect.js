import { pool } from "./pool.js";
export async function ensureDatabaseConnection() {
    const connection = await pool.getConnection();
    try {
        await connection.ping();
    }
    finally {
        connection.release();
    }
}
