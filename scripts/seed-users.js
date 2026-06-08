import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import "dotenv/config";

const password = "Password123!";
const hash = await bcrypt.hash(password, 10);

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "ticket_malawi",
});

const organizerId = "11111111-1111-1111-1111-111111111111";
const customerId = "22222222-2222-2222-2222-222222222222";

await conn.query(
  `INSERT INTO users (id, email, password_hash, full_name, phone, national_id, role) VALUES
   (?, 'ops@sososo.mw', ?, 'James Phiri', '+265999456789', NULL, 'organizer'),
   (?, 'chimwemwe@example.mw', ?, 'Chimwemwe Banda', '+265999123456', 'MW-238104-K', 'customer')
   ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
  [organizerId, hash, customerId, hash],
);

await conn.query(
  `INSERT INTO payment_methods (id, user_id, type, label, details_masked, is_default) VALUES
   ('pm001', ?, 'airtel', 'Airtel Money', '+265 999 •• 456', 1),
   ('pm002', ?, 'tnm', 'TNM Mpamba', '+265 888 •• 102', 0)
   ON DUPLICATE KEY UPDATE label = VALUES(label)`,
  [customerId, customerId],
);

console.log("Seeded users with password:", password);
await conn.end();
