import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { pool, type QueryParams } from "../db/pool.js";
import * as emailService from "./email.service.js";
import * as refundService from "./refund.service.js";

export const REPORT_THRESHOLD = 200;
export const MASS_SUSPEND_DAYS = 7;

export const REPORT_REASONS = [
  { id: "fraudulent_listing", label: "Fraudulent or fake listing" },
  { id: "misleading_information", label: "Misleading event or travel information" },
  { id: "no_show_or_cancellation", label: "No-show or unfair cancellation" },
  { id: "harassment_or_abuse", label: "Harassment or abuse" },
  { id: "unsafe_or_illegal_content", label: "Unsafe or illegal content" },
  { id: "payment_or_refund_issue", label: "Payment or refund issue" },
  { id: "spam_or_scam", label: "Spam or scam activity" },
  { id: "poor_service", label: "Poor service or unprofessional conduct" },
  { id: "other", label: "Other (please describe)" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["id"];

const EXPLICIT_WORDS = [
  "porn",
  "xxx",
  "nude",
  "naked",
  "sex tape",
  "escort",
  "prostitut",
  "fuck",
  "shit",
  "bitch",
  "cunt",
  "cock",
  "penis",
  "vagina",
  "rape",
  "kill you",
  "bomb threat",
];

export function containsExplicitContent(...texts: Array<string | null | undefined>): boolean {
  const blob = texts.filter(Boolean).join(" ").toLowerCase();
  return EXPLICIT_WORDS.some((w) => blob.includes(w));
}

export async function getOrganizerModerationState(organizerId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT status, flagged_at, flag_reason, suspended_until, suspension_reason
     FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  const row = rows[0];
  if (!row) {
    return {
      organizerId,
      status: "unknown",
      flagged: false,
      flagReason: null as string | null,
      suspendedUntil: null as string | null,
      suspensionReason: null as string | null,
      isRestricted: true,
    };
  }
  const status = String(row.status);
  const suspendedUntil = row.suspended_until ? String(row.suspended_until) : null;
  const autoLifted =
    status === "suspended" &&
    suspendedUntil &&
    new Date(suspendedUntil).getTime() <= Date.now();
  return {
    organizerId,
    status,
    flagged: row.flagged_at != null,
    flagReason: (row.flag_reason as string | null) ?? null,
    suspendedUntil,
    suspensionReason: (row.suspension_reason as string | null) ?? null,
    isRestricted: status === "suspended" || status === "banned" || status === "inactive",
    autoLifted,
  };
}

export async function assertOrganizerCanMutate(organizerId: string): Promise<void> {
  const state = await getOrganizerModerationState(organizerId);
  if (state.status === "banned") {
    throw new Error("Your organizer account has been permanently banned.");
  }
  if (state.status === "suspended") {
    throw new Error(
      state.suspendedUntil
        ? `Your organizer account is suspended until ${new Date(state.suspendedUntil).toLocaleString()}.`
        : "Your organizer account is suspended.",
    );
  }
  if (state.status !== "approved") {
    throw new Error("Your organizer account is not approved for this action.");
  }
}

export async function suspendOrganizerForContent(
  organizerId: string,
  listingTitle: string,
): Promise<void> {
  await applySuspension(
    organizerId,
    "Listing contained explicit or prohibited language",
    null,
    "content_violation",
  );
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT op.email, op.company_name FROM organizer_profiles op WHERE op.user_id = :organizerId`,
    { organizerId },
  );
  const row = rows[0];
  if (row) {
    await emailService.sendOrganizerContentSuspensionEmail(
      row.email as string,
      row.company_name as string,
      listingTitle,
    );
    await emailService.sendOrganizerSuspendedBuyerNotice(organizerId, row.company_name as string);
  }
}

async function applySuspension(
  organizerId: string,
  reason: string,
  until: Date | null,
  flagType: "report_threshold" | "mass_report" | "content_violation" | "admin",
  reportCount = 0,
) {
  await pool.query(
    `UPDATE organizer_profiles
     SET status = 'suspended',
         suspension_reason = :reason,
         suspended_until = :until
     WHERE user_id = :organizerId`,
    { organizerId, reason, until: until ? until.toISOString().slice(0, 19).replace("T", " ") : null } satisfies QueryParams,
  );
  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :organizerId`, { organizerId });

  const [existing] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM organizer_flags
     WHERE organizer_id = :organizerId AND status = 'active' AND flag_type = :flagType
     LIMIT 1`,
    { organizerId, flagType },
  );
  if (!existing[0]) {
    await pool.query(
      `INSERT INTO organizer_flags (id, organizer_id, flag_type, report_count, primary_reason, status)
       VALUES (:id, :organizerId, :flagType, :reportCount, :reason, 'active')`,
      { id: uuid(), organizerId, flagType, reportCount, reason } satisfies QueryParams,
    );
  }

  const [org] = await pool.query<RowDataPacket[]>(
    `SELECT email, company_name FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  if (org[0]) {
    await emailService.sendOrganizerSuspensionEmail(
      org[0].email as string,
      org[0].company_name as string,
      reason,
      until,
    );
    await emailService.sendOrganizerSuspendedBuyerNotice(organizerId, org[0].company_name as string);
  }
}

export async function submitReport(input: {
  reporterUserId: string;
  organizerId: string;
  listingId?: string;
  reason: ReportReason;
  details?: string;
}) {
  if (input.reporterUserId === input.organizerId) {
    throw new Error("You cannot report your own organizer account.");
  }

  const [dup] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM organizer_reports
     WHERE reporter_user_id = :reporterUserId AND organizer_id = :organizerId
       AND reason = :reason AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
     LIMIT 1`,
    {
      reporterUserId: input.reporterUserId,
      organizerId: input.organizerId,
      reason: input.reason,
    },
  );
  if (dup[0]) {
    throw new Error("You already submitted a similar report in the last 24 hours.");
  }

  if (input.reason === "other" && (!input.details || input.details.trim().length < 20)) {
    throw new Error("Please provide at least 20 characters describing the issue.");
  }

  const [org] = await pool.query<RowDataPacket[]>(
    `SELECT company_name, email FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId: input.organizerId },
  );
  if (!org[0]) throw new Error("Organizer not found.");

  const reportId = uuid();
  await pool.query(
    `INSERT INTO organizer_reports (id, reporter_user_id, organizer_id, listing_id, reason, details)
     VALUES (:id, :reporterUserId, :organizerId, :listingId, :reason, :details)`,
    {
      id: reportId,
      reporterUserId: input.reporterUserId,
      organizerId: input.organizerId,
      listingId: input.listingId ?? null,
      reason: input.reason,
      details: input.details?.trim() ?? null,
    } satisfies QueryParams,
  );

  await evaluateReportThresholds(input.organizerId);

  return { reportId, received: true };
}

export async function evaluateReportThresholds(organizerId: string) {
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM organizer_reports WHERE organizer_id = :organizerId`,
    { organizerId },
  );
  const total = Number(totalRows[0]?.cnt ?? 0);

  const [byReason] = await pool.query<RowDataPacket[]>(
    `SELECT reason, COUNT(*) AS cnt FROM organizer_reports
     WHERE organizer_id = :organizerId GROUP BY reason ORDER BY cnt DESC`,
    { organizerId },
  );

  const topReason = byReason[0];
  const topCount = Number(topReason?.cnt ?? 0);
  const primaryReason = topReason ? String(topReason.reason) : null;

  const state = await getOrganizerModerationState(organizerId);
  if (state.status === "banned") return;

  const hitThreshold = total >= REPORT_THRESHOLD || topCount >= REPORT_THRESHOLD;

  if (hitThreshold && !state.flagged) {
    await pool.query(
      `UPDATE organizer_profiles
       SET flagged_at = NOW(),
           flag_reason = :reason
       WHERE user_id = :organizerId`,
      {
        organizerId,
        reason: `Under review: ${total} reports received (${primaryReason ?? "multiple reasons"})`,
      },
    );

    await pool.query(
      `INSERT INTO organizer_flags (id, organizer_id, flag_type, report_count, primary_reason, status)
       VALUES (:id, :organizerId, 'report_threshold', :reportCount, :primaryReason, 'active')`,
      {
        id: uuid(),
        organizerId,
        reportCount: total,
        primaryReason,
      } satisfies QueryParams,
    );

    const [org] = await pool.query<RowDataPacket[]>(
      `SELECT email, company_name FROM organizer_profiles WHERE user_id = :organizerId`,
      { organizerId },
    );
    if (org[0]) {
      await emailService.sendOrganizerFlaggedEmail(
        org[0].email as string,
        org[0].company_name as string,
        total,
      );
    }
  }

  if (total >= REPORT_THRESHOLD && state.status === "approved") {
    const until = new Date(Date.now() + MASS_SUSPEND_DAYS * 24 * 60 * 60 * 1000);
    await applySuspension(
      organizerId,
      `Automatic suspension: ${total} user reports received`,
      until,
      "mass_report",
      total,
    );
  }
}

export async function listReportsForAdmin() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.*, u.full_name AS reporter_name, u.email AS reporter_email,
            op.company_name AS organizer_name
     FROM organizer_reports r
     JOIN users u ON u.id = r.reporter_user_id
     JOIN organizer_profiles op ON op.user_id = r.organizer_id
     ORDER BY r.created_at DESC
     LIMIT 500`,
  );
  return rows.map((r) => ({
    id: r.id,
    organizerId: r.organizer_id,
    organizerName: r.organizer_name,
    reporterName: r.reporter_name,
    reporterEmail: r.reporter_email,
    listingId: r.listing_id,
    reason: r.reason,
    details: r.details,
    createdAt: r.created_at,
  }));
}

export async function listFlagsForAdmin() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT f.*, op.company_name, op.email, op.status AS organizer_status,
            (SELECT COUNT(*) FROM organizer_reports WHERE organizer_id = f.organizer_id) AS total_reports
     FROM organizer_flags f
     JOIN organizer_profiles op ON op.user_id = f.organizer_id
     ORDER BY f.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    organizerId: r.organizer_id,
    companyName: r.company_name,
    email: r.email,
    organizerStatus: r.organizer_status,
    flagType: r.flag_type,
    reportCount: Number(r.report_count),
    primaryReason: r.primary_reason,
    status: r.status,
    adminNotes: r.admin_notes,
    totalReports: Number(r.total_reports),
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    removedAt: r.removed_at,
  }));
}

export async function removeFlag(flagId: string, adminId: string, adminNotes?: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT organizer_id FROM organizer_flags WHERE id = :id AND status = 'active'`,
    { id: flagId },
  );
  const flag = rows[0];
  if (!flag) throw new Error("Active flag not found");

  await pool.query(
    `UPDATE organizer_flags
     SET status = 'removed', admin_notes = :notes, reviewed_at = NOW(), reviewed_by = :adminId, removed_at = NOW()
     WHERE id = :id`,
    { id: flagId, adminId, notes: adminNotes ?? null },
  );
  await pool.query(
    `UPDATE organizer_profiles SET flagged_at = NULL, flag_reason = NULL WHERE user_id = :organizerId`,
    { organizerId: flag.organizer_id },
  );

  const [activeFlags] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM organizer_flags WHERE organizer_id = :organizerId AND status = 'active' LIMIT 1`,
    { organizerId: flag.organizer_id },
  );
  if (!activeFlags[0]) {
    await pool.query(
      `UPDATE organizer_profiles SET flagged_at = NULL, flag_reason = NULL WHERE user_id = :organizerId`,
      { organizerId: flag.organizer_id },
    );
  }

  return { removed: true };
}

export async function submitAppeal(organizerId: string, reason: string, appealType: "suspension" | "ban" = "suspension") {
  if (!reason.trim() || reason.trim().length < 30) {
    throw new Error("Please provide at least 30 characters explaining your appeal.");
  }

  const [pending] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM organizer_appeals
     WHERE organizer_id = :organizerId AND status = 'pending' LIMIT 1`,
    { organizerId },
  );
  if (pending[0]) throw new Error("You already have a pending appeal.");

  const id = uuid();
  await pool.query(
    `INSERT INTO organizer_appeals (id, organizer_id, appeal_type, reason, status)
     VALUES (:id, :organizerId, :appealType, :reason, 'pending')`,
    { id, organizerId, appealType, reason: reason.trim() },
  );

  const [org] = await pool.query<RowDataPacket[]>(
    `SELECT company_name, email FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  if (org[0]) {
    await emailService.sendAppealReceivedEmail(
      org[0].email as string,
      org[0].company_name as string,
    );
  }

  return { appealId: id, submitted: true };
}

export async function listAppealsForAdmin(status?: string) {
  let sql = `SELECT a.*, op.company_name, op.email
             FROM organizer_appeals a
             JOIN organizer_profiles op ON op.user_id = a.organizer_id`;
  const params: QueryParams = {};
  if (status) {
    sql += ` WHERE a.status = :status`;
    params.status = status;
  }
  sql += ` ORDER BY a.created_at DESC`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows.map((r) => ({
    id: r.id,
    organizerId: r.organizer_id,
    companyName: r.company_name,
    email: r.email,
    appealType: r.appeal_type,
    reason: r.reason,
    status: r.status,
    adminNotes: r.admin_notes,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  }));
}

export async function reviewAppeal(
  appealId: string,
  adminId: string,
  decision: "approved" | "rejected",
  adminNotes?: string,
) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM organizer_appeals WHERE id = :id AND status = 'pending'`,
    { id: appealId },
  );
  const appeal = rows[0];
  if (!appeal) throw new Error("Pending appeal not found");

  await pool.query(
    `UPDATE organizer_appeals
     SET status = :decision, admin_notes = :notes, reviewed_at = NOW(), reviewed_by = :adminId
     WHERE id = :id`,
    { id: appealId, decision, notes: adminNotes ?? null, adminId },
  );

  const organizerId = appeal.organizer_id as string;
  const [org] = await pool.query<RowDataPacket[]>(
    `SELECT email, company_name FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );

  if (decision === "approved" && appeal.appeal_type === "suspension") {
    await liftSuspension(organizerId, adminId, "Appeal approved");
  }

  if (org[0]) {
    await emailService.sendAppealDecisionEmail(
      org[0].email as string,
      org[0].company_name as string,
      decision === "approved",
      adminNotes,
    );
  }

  return { appealId, decision };
}

export async function liftSuspension(organizerId: string, _adminId?: string, _notes?: string) {
  await pool.query(
    `UPDATE organizer_profiles
     SET status = 'approved', suspended_until = NULL, suspension_reason = NULL
     WHERE user_id = :organizerId AND status = 'suspended'`,
    { organizerId },
  );
  await pool.query(
    `UPDATE users SET status = 'active' WHERE id = :organizerId`,
    { organizerId },
  );
  return { lifted: true };
}

export async function permanentBanOrganizer(organizerId: string, adminId: string, adminNotes?: string) {
  const [org] = await pool.query<RowDataPacket[]>(
    `SELECT email, company_name FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  if (!org[0]) throw new Error("Organizer not found");

  await pool.query(
    `UPDATE organizer_profiles
     SET status = 'banned', flagged_at = NULL, flag_reason = NULL,
         suspension_reason = :notes, suspended_until = NULL
     WHERE user_id = :organizerId`,
    { organizerId, notes: adminNotes ?? "Permanent ban" },
  );
  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :organizerId`, { organizerId });

  await pool.query(
    `UPDATE listings SET status = 'cancelled' WHERE organizer_id = :organizerId AND status != 'draft'`,
    { organizerId },
  );

  await pool.query(
    `INSERT INTO organizer_flags (id, organizer_id, flag_type, report_count, primary_reason, status, admin_notes, reviewed_at, reviewed_by)
     VALUES (:id, :organizerId, 'admin', 0, 'Permanent ban', 'reviewed', :notes, NOW(), :adminId)`,
    { id: uuid(), organizerId, notes: adminNotes ?? null, adminId },
  );

  const refundResult = await refundService.processBanRefunds(organizerId);

  await emailService.sendOrganizerBanEmail(
    org[0].email as string,
    org[0].company_name as string,
    adminNotes,
  );
  await emailService.sendOrganizerSuspendedBuyerNotice(organizerId, org[0].company_name as string);

  return { banned: true, refunds: refundResult };
}

export async function processExpiredSuspensions() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT user_id FROM organizer_profiles
     WHERE status = 'suspended'
       AND suspended_until IS NOT NULL
       AND suspended_until <= NOW()`,
  );
  for (const row of rows) {
    const [pendingAppeal] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM organizer_appeals
       WHERE organizer_id = :organizerId AND status = 'pending' LIMIT 1`,
      { organizerId: row.user_id },
    );
    if (!pendingAppeal[0]) {
      await liftSuspension(row.user_id as string);
    }
  }
}
