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
const sql = fs.readFileSync(sqlPath, "utf8");

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE,
  multipleStatements: true,
});

try {
  await conn.query(sql);
  console.log(`Executed ${sqlPath}`);
} finally {
  await conn.end();
}
