import "dotenv/config";
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "ticket_malawi",
});

const chargeId = "TMWDb27a158217aa4fb19063f7f7888f";

const [rows] = await pool.query(
  `SELECT p.id, p.organizer_id, p.status, p.paychangu_charge_id, p.failure_reason,
          u.id AS user_exists, u.email
   FROM organizer_payouts p
   LEFT JOIN users u ON u.id = p.organizer_id
   WHERE p.paychangu_charge_id = ? OR p.status IN ('pending','processing')`,
  [chargeId],
);
console.log("Payout rows:", JSON.stringify(rows, null, 2));

if (rows[0]) {
  const id = rows[0].id;
  try {
    await pool.query(
      `UPDATE organizer_payouts
       SET status = 'failed', provider_status = 'failed', failure_reason = 'test'
       WHERE id = ?`,
      [id],
    );
    console.log("UPDATE succeeded for", id);
    await pool.query(
      `UPDATE organizer_payouts SET status = 'processing', failure_reason = NULL WHERE id = ?`,
      [id],
    );
  } catch (err) {
    console.error("UPDATE failed:", err.message);
  }
}

await pool.end();
