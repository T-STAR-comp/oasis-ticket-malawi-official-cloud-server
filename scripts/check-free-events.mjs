import mysql from "mysql2/promise";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "ticket_malawi",
});

const [rows] = await pool.query(`
  SELECT l.id, l.title, l.price_mwk, t.name AS tier_name, t.price_mwk AS tier_price
  FROM listings l
  LEFT JOIN listing_ticket_tiers t ON t.listing_id = l.id
  WHERE l.kind = 'event'
  ORDER BY l.updated_at DESC
  LIMIT 12
`);
console.log(JSON.stringify(rows, null, 2));
await pool.end();
