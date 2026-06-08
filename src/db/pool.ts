import mysql from "mysql2/promise";
import { env } from "../config/env.js";

export const pool = mysql.createPool({
  host: env.mysql.host,
  port: env.mysql.port,
  user: env.mysql.user,
  password: env.mysql.password,
  database: env.mysql.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

export type Row = mysql.RowDataPacket;
export type Result = mysql.ResultSetHeader;
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
