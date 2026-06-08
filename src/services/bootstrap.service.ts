import bcrypt from "bcryptjs";
import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";

export async function ensureDefaultAdmin() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM users WHERE username = :username OR (role = 'admin' AND email = :email) LIMIT 1`,
    { username: env.admin.username, email: env.admin.email },
  );

  if (rows[0]) {
    console.log(`[bootstrap] Admin account "${env.admin.username}" already exists`);
    return;
  }

  const id = uuid();
  const passwordHash = await bcrypt.hash(env.admin.password, 10);

  await pool.query(
    `INSERT INTO users (id, email, username, password_hash, full_name, role, status, email_verified, email_verified_at)
     VALUES (:id, :email, :username, :passwordHash, :fullName, 'admin', 'active', 1, NOW())`,
    {
      id,
      email: env.admin.email,
      username: env.admin.username,
      passwordHash,
      fullName: env.admin.fullName,
    },
  );

  console.log(`[bootstrap] Default admin created — username: ${env.admin.username}`);
}
