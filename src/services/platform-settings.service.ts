import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool, type QueryParams } from "../db/pool.js";

export type ServiceFeeBearer = "buyer" | "organizer";
export type ServiceFeeSource = "default" | "custom" | "dynamic";

export type DynamicServiceFeeRange = {
  id: string;
  minMwk: number;
  maxMwk: number | null;
  feePercent: number;
  sortOrder: number;
};

export type OrganizerCustomServiceFee = {
  organizerUserId: string;
  email: string;
  fullName: string;
  companyName: string | null;
  feePercent: number;
  notes: string | null;
  updatedAt: string;
};

async function getSetting(key: string): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT setting_value FROM platform_settings WHERE setting_key = :key LIMIT 1`,
    { key },
  );
  return rows[0] ? String(rows[0].setting_value) : null;
}

async function setSetting(key: string, value: string, adminId?: string) {
  await pool.query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_by)
     VALUES (:key, :value, :adminId)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    { key, value, adminId: adminId ?? null },
  );
}

export async function getServiceFeeBearer(): Promise<ServiceFeeBearer> {
  const value = await getSetting("service_fee_bearer");
  return value === "organizer" ? "organizer" : "buyer";
}

export async function setServiceFeeBearer(bearer: ServiceFeeBearer, adminId: string) {
  await setSetting("service_fee_bearer", bearer, adminId);
}

export async function isDynamicServiceFeeEnabled(): Promise<boolean> {
  const value = await getSetting("dynamic_service_fee_enabled");
  return value === "true" || value === "1";
}

export async function setDynamicServiceFeeEnabled(enabled: boolean, adminId: string) {
  await setSetting("dynamic_service_fee_enabled", enabled ? "true" : "false", adminId);
}

export async function listDynamicServiceFeeRanges(): Promise<DynamicServiceFeeRange[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, min_mwk, max_mwk, fee_percent, sort_order
     FROM dynamic_service_fee_ranges
     ORDER BY sort_order ASC, min_mwk ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    minMwk: Number(r.min_mwk),
    maxMwk: r.max_mwk == null ? null : Number(r.max_mwk),
    feePercent: Number(r.fee_percent),
    sortOrder: Number(r.sort_order),
  }));
}

export async function replaceDynamicServiceFeeRanges(
  ranges: Array<{ minMwk: number; maxMwk: number | null; feePercent: number }>,
  adminId: string,
) {
  if (ranges.length === 0) {
    throw new Error("Add at least one fee range");
  }

  const normalized = ranges.map((r, index) => {
    const minMwk = Math.max(0, Math.floor(r.minMwk));
    const maxMwk = r.maxMwk == null ? null : Math.max(minMwk, Math.floor(r.maxMwk));
    const feePercent = Number(r.feePercent);
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
      throw new Error("Fee percent must be between 0 and 100");
    }
    return { minMwk, maxMwk, feePercent, sortOrder: index };
  });

  normalized.sort((a, b) => a.minMwk - b.minMwk);
  for (let i = 0; i < normalized.length; i++) {
    const current = normalized[i];
    const next = normalized[i + 1];
    if (current.maxMwk != null && current.maxMwk < current.minMwk) {
      throw new Error("Range max must be greater than or equal to min");
    }
    if (next && current.maxMwk != null && next.minMwk <= current.maxMwk) {
      throw new Error("Dynamic fee ranges must not overlap");
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM dynamic_service_fee_ranges`);
    for (const range of normalized) {
      await conn.query(
        `INSERT INTO dynamic_service_fee_ranges (id, min_mwk, max_mwk, fee_percent, sort_order)
         VALUES (:id, :minMwk, :maxMwk, :feePercent, :sortOrder)`,
        {
          id: uuid(),
          minMwk: range.minMwk,
          maxMwk: range.maxMwk,
          feePercent: range.feePercent,
          sortOrder: range.sortOrder,
        } satisfies QueryParams,
      );
    }
    await setSetting("dynamic_service_fee_enabled", "true", adminId);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function deleteDynamicServiceFeeRange(rangeId: string) {
  await pool.query(`DELETE FROM dynamic_service_fee_ranges WHERE id = :id`, { id: rangeId });
}

export async function getOrganizerCustomServiceFee(
  organizerUserId: string,
): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT fee_percent FROM organizer_custom_service_fees WHERE organizer_user_id = :organizerId`,
    { organizerId: organizerUserId },
  );
  return rows[0] ? Number(rows[0].fee_percent) : null;
}

export async function listOrganizerCustomServiceFees(): Promise<OrganizerCustomServiceFee[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT f.organizer_user_id, f.fee_percent, f.notes, f.updated_at,
            u.email, u.full_name, op.company_name
     FROM organizer_custom_service_fees f
     JOIN users u ON u.id = f.organizer_user_id
     LEFT JOIN organizer_profiles op ON op.user_id = f.organizer_user_id
     ORDER BY f.updated_at DESC`,
  );
  return rows.map((r) => ({
    organizerUserId: String(r.organizer_user_id),
    email: String(r.email),
    fullName: String(r.full_name),
    companyName: r.company_name ? String(r.company_name) : null,
    feePercent: Number(r.fee_percent),
    notes: r.notes ? String(r.notes) : null,
    updatedAt: String(r.updated_at),
  }));
}

export async function lookupOrganizerByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT u.id, u.email, u.full_name, op.company_name, op.status AS organizer_status,
            f.fee_percent AS custom_fee_percent
     FROM users u
     JOIN organizer_profiles op ON op.user_id = u.id
     LEFT JOIN organizer_custom_service_fees f ON f.organizer_user_id = u.id
     WHERE LOWER(u.email) = :email
     LIMIT 1`,
    { email: normalized },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    organizerUserId: String(row.id),
    email: String(row.email),
    fullName: String(row.full_name),
    companyName: row.company_name ? String(row.company_name) : null,
    organizerStatus: String(row.organizer_status),
    customFeePercent: row.custom_fee_percent != null ? Number(row.custom_fee_percent) : null,
  };
}

export async function setOrganizerCustomServiceFee(
  organizerUserId: string,
  feePercent: number,
  adminId: string,
  notes?: string,
) {
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
    throw new Error("Fee percent must be between 0 and 100");
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT user_id FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId: organizerUserId },
  );
  if (!rows[0]) throw new Error("Organizer not found");

  await pool.query(
    `INSERT INTO organizer_custom_service_fees (
       organizer_user_id, fee_percent, notes, updated_by
     ) VALUES (
       :organizerId, :feePercent, :notes, :adminId
     )
     ON DUPLICATE KEY UPDATE
       fee_percent = VALUES(fee_percent),
       notes = VALUES(notes),
       updated_by = VALUES(updated_by)`,
    {
      organizerId: organizerUserId,
      feePercent,
      notes: notes?.trim() || null,
      adminId,
    } satisfies QueryParams,
  );
}

export async function removeOrganizerCustomServiceFee(organizerUserId: string) {
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE FROM organizer_custom_service_fees WHERE organizer_user_id = :organizerId`,
    { organizerId: organizerUserId },
  );
  if (result.affectedRows === 0) {
    throw new Error("Custom fee not found for this organizer");
  }
}

export async function resolveServiceFeePercent(
  organizerUserId: string | null | undefined,
  catalogSubtotalMwk: number,
): Promise<{ percent: number; source: ServiceFeeSource }> {
  if (organizerUserId) {
    const custom = await getOrganizerCustomServiceFee(organizerUserId);
    if (custom != null) {
      return { percent: custom, source: "custom" };
    }
  }

  const dynamicEnabled = await isDynamicServiceFeeEnabled();
  if (dynamicEnabled) {
    const ranges = await listDynamicServiceFeeRanges();
    const subtotal = Math.max(0, Math.floor(catalogSubtotalMwk));
    for (const range of ranges) {
      const inMin = subtotal >= range.minMwk;
      const inMax = range.maxMwk == null || subtotal <= range.maxMwk;
      if (inMin && inMax) {
        return { percent: range.feePercent, source: "dynamic" };
      }
    }
  }

  return { percent: env.platformServiceFeePercent, source: "default" };
}

export async function getFinanceSettingsSnapshot() {
  const [bearer, dynamicEnabled, ranges, customFees] = await Promise.all([
    getServiceFeeBearer(),
    isDynamicServiceFeeEnabled(),
    listDynamicServiceFeeRanges(),
    listOrganizerCustomServiceFees(),
  ]);

  return {
    serviceFeeBearer: bearer,
    defaultServiceFeePercent: env.platformServiceFeePercent,
    dynamicServiceFeeEnabled: dynamicEnabled,
    dynamicRanges: ranges,
    customOrganizerFees: customFees,
  };
}
