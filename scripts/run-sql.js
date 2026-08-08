import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import "dotenv/config";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/run-sql.js <path-to-sql-file>");
  process.exit(1);
}

const sqlPath = path.resolve(file);
const rawSql = fs.readFileSync(sqlPath, "utf8");

const database = process.env.MYSQL_DATABASE?.trim();
if (!database) {
  console.error("MYSQL_DATABASE is not set in .env");
  process.exit(1);
}

// Migrations often include `USE ticket_malawi` for local dev. On cPanel the
// real database name is in MYSQL_DATABASE (e.g. umpcjtsisk_ticket_malawi).
const sql = rawSql.replace(/^\s*USE\s+[\w`]+;\s*[\r\n]*/gim, "");

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database,
  multipleStatements: true,
});

try {
  await conn.query(sql);
  console.log(`Executed ${sqlPath} against database "${database}"`);
} finally {
  await conn.end();
}
