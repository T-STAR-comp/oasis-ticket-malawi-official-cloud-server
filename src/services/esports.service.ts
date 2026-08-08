import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool, type QueryParams } from "../db/pool.js";
import { features } from "../config/features.js";
import { getProfile } from "./auth.service.js";
import {
  initiateMobileMoneyCharge,
  TERMINAL_PAYMENT_STATUSES,
  verifyMobileMoneyCharge,
  type MomoOperator,
} from "./paychangu.service.js";
import * as emailService from "./email.service.js";
import { buildPublicImageUrl } from "../config/images.js";

export type EsportsEventStatus = "draft" | "published" | "completed" | "archived";

export type EsportsEventInput = {
  name: string;
  description: string;
  eventDate: string;
  eventTime: string;
  entryPriceMwk: number;
  imageUrl?: string | null;
  gameName: string;
  matchDurationMinutes: number;
  grandPrizeMwk: number;
  maxSlots?: number;
  status?: EsportsEventStatus;
};

function esportsSlotsMessage(
  participantCount: number,
  maxSlots: number,
  isCompleted: boolean,
): { isSoldOut: boolean; slotsMessage: string } {
  if (isCompleted) {
    return { isSoldOut: true, slotsMessage: "Tournament ended" };
  }
  if (participantCount >= maxSlots) {
    return { isSoldOut: true, slotsMessage: "Sold out" };
  }
  const remaining = maxSlots - participantCount;
  const fewRemainingThreshold = Math.max(1, Math.ceil(maxSlots * 0.2));
  if (remaining <= fewRemainingThreshold) {
    return { isSoldOut: false, slotsMessage: "Few slots remaining" };
  }
  return { isSoldOut: false, slotsMessage: "Limited slots available" };
}

function toPublicEsportsEvent(event: ReturnType<typeof mapEvent>) {
  const maxSlots = event.maxSlots;
  const { isSoldOut, slotsMessage } = esportsSlotsMessage(
    event.participantCount,
    maxSlots,
    event.isCompleted,
  );
  return {
    id: event.id,
    name: event.name,
    description: event.description,
    eventDate: event.eventDate,
    eventTime: event.eventTime,
    entryPriceMwk: event.entryPriceMwk,
    imageUrl: event.imageUrl,
    gameName: event.gameName,
    matchDurationMinutes: event.matchDurationMinutes,
    grandPrizeMwk: event.grandPrizeMwk,
    status: event.status,
    isCompleted: event.isCompleted,
    isSoldOut,
    slotsMessage,
  };
}

function mapEvent(row: RowDataPacket, participantCount?: number) {
  const status = String(row.status) as EsportsEventStatus;
  const settledAt = row.settled_at ? String(row.settled_at) : null;
  const isPubliclyVisible =
    status === "published" ||
    (status === "completed" &&
      settledAt &&
      Date.now() - new Date(settledAt).getTime() < 24 * 60 * 60 * 1000);

  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    eventDate: String(row.event_date).slice(0, 10),
    eventTime: String(row.event_time),
    entryPriceMwk: Number(row.entry_price_mwk ?? 0),
    imageUrl: row.image_url ? String(row.image_url) : null,
    gameName: String(row.game_name),
    matchDurationMinutes: Number(row.match_duration_minutes ?? 0),
    grandPrizeMwk: Number(row.grand_prize_mwk ?? 0),
    maxSlots: Math.max(1, Number(row.max_slots ?? 32)),
    status,
    matchLink: row.match_link ? String(row.match_link) : null,
    matchPassword: row.match_password ? String(row.match_password) : null,
    winnerUserId: row.winner_user_id ? String(row.winner_user_id) : null,
    winnerRegistrationId: row.winner_registration_id ? String(row.winner_registration_id) : null,
    winnerGameUsername: row.winner_game_username ? String(row.winner_game_username) : null,
    winnerProofImageUrl: row.winner_proof_image_url ? String(row.winner_proof_image_url) : null,
    settledAt,
    participantCount: participantCount ?? Number(row.participant_count ?? 0),
    isPubliclyVisible,
    isCompleted: status === "completed" || status === "archived",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function publicEventFilterSql(alias = "e") {
  return `(
    ${alias}.status = 'published'
    OR (
      ${alias}.status = 'completed'
      AND ${alias}.settled_at IS NOT NULL
      AND ${alias}.settled_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    )
  )`;
}

export async function getEsportsPublicVisibility() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM esports_events e WHERE ${publicEventFilterSql("e")}`,
  );
  const count = Number(rows[0]?.cnt ?? 0);
  return { visible: count > 0, count };
}

export async function listPublicEsportsEvents() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM esports_registrations r
        WHERE r.event_id = e.id AND r.payment_status = 'completed') AS participant_count
     FROM esports_events e
     WHERE ${publicEventFilterSql("e")}
     ORDER BY e.event_date ASC, e.event_time ASC`,
  );
  return rows.map((r) => toPublicEsportsEvent(mapEvent(r)));
}

export async function getPublicEsportsEvent(eventId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM esports_registrations r
        WHERE r.event_id = e.id AND r.payment_status = 'completed') AS participant_count
     FROM esports_events e
     WHERE e.id = :eventId AND ${publicEventFilterSql("e")}`,
    { eventId },
  );
  const row = rows[0];
  if (!row) return null;
  return toPublicEsportsEvent(mapEvent(row));
}

export async function listAdminEsportsEvents(includeArchived = true) {
  const archivedFilter = includeArchived ? "" : "WHERE e.status != 'archived'";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM esports_registrations r
        WHERE r.event_id = e.id AND r.payment_status = 'completed') AS participant_count
     FROM esports_events e
     ${archivedFilter}
     ORDER BY e.created_at DESC`,
  );
  return rows.map((r) => mapEvent(r));
}

export async function getAdminEsportsEvent(eventId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM esports_registrations r
        WHERE r.event_id = e.id AND r.payment_status = 'completed') AS participant_count
     FROM esports_events e WHERE e.id = :eventId`,
    { eventId },
  );
  const row = rows[0];
  if (!row) return null;

  const [participants] = await pool.query<RowDataPacket[]>(
    `SELECT r.id, r.user_id, r.game_username, r.amount_paid_mwk, r.payment_status,
            r.registered_at, u.full_name, u.email
     FROM esports_registrations r
     JOIN users u ON u.id = r.user_id
     WHERE r.event_id = :eventId AND r.payment_status = 'completed'
     ORDER BY r.registered_at ASC`,
    { eventId },
  );

  return {
    ...mapEvent(row),
    participants: participants.map((p) => ({
      registrationId: String(p.id),
      userId: String(p.user_id),
      gameUsername: String(p.game_username),
      amountPaidMwk: Number(p.amount_paid_mwk ?? 0),
      registeredAt: p.registered_at ? String(p.registered_at) : null,
      fullName: String(p.full_name ?? ""),
      email: String(p.email ?? ""),
    })),
  };
}

export async function createEsportsEvent(adminUserId: string, input: EsportsEventInput) {
  const id = uuid();
  await pool.query(
    `INSERT INTO esports_events (
      id, name, description, event_date, event_time, entry_price_mwk, image_url,
      game_name, match_duration_minutes, grand_prize_mwk, max_slots, status, created_by_admin_id
    ) VALUES (
      :id, :name, :description, :eventDate, :eventTime, :entryPriceMwk, :imageUrl,
      :gameName, :matchDurationMinutes, :grandPrizeMwk, :maxSlots, :status, :adminUserId
    )`,
    {
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      eventDate: input.eventDate,
      eventTime: input.eventTime.trim(),
      entryPriceMwk: Math.max(0, Math.round(input.entryPriceMwk)),
      imageUrl: input.imageUrl?.trim() || null,
      gameName: input.gameName.trim(),
      matchDurationMinutes: Math.max(1, Math.round(input.matchDurationMinutes)),
      grandPrizeMwk: Math.max(0, Math.round(input.grandPrizeMwk)),
      maxSlots: Math.max(1, Math.round(input.maxSlots ?? 32)),
      status: input.status ?? "draft",
      adminUserId,
    } satisfies QueryParams,
  );
  return getAdminEsportsEvent(id);
}

export async function updateEsportsEvent(eventId: string, input: Partial<EsportsEventInput>) {
  const existing = await getAdminEsportsEvent(eventId);
  if (!existing) throw new Error("E-Sports event not found");
  if (existing.status === "completed" || existing.status === "archived") {
    throw new Error("Completed events cannot be edited");
  }

  await pool.query(
    `UPDATE esports_events SET
       name = COALESCE(:name, name),
       description = COALESCE(:description, description),
       event_date = COALESCE(:eventDate, event_date),
       event_time = COALESCE(:eventTime, event_time),
       entry_price_mwk = COALESCE(:entryPriceMwk, entry_price_mwk),
       image_url = COALESCE(:imageUrl, image_url),
       game_name = COALESCE(:gameName, game_name),
       match_duration_minutes = COALESCE(:matchDurationMinutes, match_duration_minutes),
       grand_prize_mwk = COALESCE(:grandPrizeMwk, grand_prize_mwk),
       max_slots = COALESCE(:maxSlots, max_slots),
       status = COALESCE(:status, status)
     WHERE id = :eventId`,
    {
      eventId,
      name: input.name?.trim() ?? null,
      description: input.description?.trim() ?? null,
      eventDate: input.eventDate ?? null,
      eventTime: input.eventTime?.trim() ?? null,
      entryPriceMwk: input.entryPriceMwk != null ? Math.max(0, Math.round(input.entryPriceMwk)) : null,
      imageUrl: input.imageUrl !== undefined ? input.imageUrl?.trim() || null : null,
      gameName: input.gameName?.trim() ?? null,
      matchDurationMinutes:
        input.matchDurationMinutes != null
          ? Math.max(1, Math.round(input.matchDurationMinutes))
          : null,
      grandPrizeMwk:
        input.grandPrizeMwk != null ? Math.max(0, Math.round(input.grandPrizeMwk)) : null,
      maxSlots: input.maxSlots != null ? Math.max(1, Math.round(input.maxSlots)) : null,
      status: input.status ?? null,
    } satisfies QueryParams,
  );
  return getAdminEsportsEvent(eventId);
}

export async function updateEsportsMatchAccess(
  eventId: string,
  input: { matchLink?: string | null; matchPassword?: string | null },
) {
  const existing = await getAdminEsportsEvent(eventId);
  if (!existing) throw new Error("E-Sports event not found");
  if (existing.status === "archived") throw new Error("Archived events cannot be updated");

  await pool.query(
    `UPDATE esports_events SET
       match_link = COALESCE(:matchLink, match_link),
       match_password = COALESCE(:matchPassword, match_password)
     WHERE id = :eventId`,
    {
      eventId,
      matchLink: input.matchLink !== undefined ? input.matchLink?.trim() || null : null,
      matchPassword:
        input.matchPassword !== undefined ? input.matchPassword?.trim() || null : null,
    } satisfies QueryParams,
  );
  return getAdminEsportsEvent(eventId);
}

export async function settleEsportsWinner(
  eventId: string,
  input: { registrationId: string; proofImageUrl: string },
) {
  const event = await getAdminEsportsEvent(eventId);
  if (!event) throw new Error("E-Sports event not found");
  if (event.status === "completed" || event.status === "archived") {
    throw new Error("This event has already been settled");
  }

  const winner = event.participants.find((p) => p.registrationId === input.registrationId);
  if (!winner) throw new Error("Winner must be a registered participant");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE esports_events SET
         status = 'completed',
         winner_user_id = :userId,
         winner_registration_id = :registrationId,
         winner_game_username = :gameUsername,
         winner_proof_image_url = :proofImageUrl,
         settled_at = NOW()
       WHERE id = :eventId`,
      {
        eventId,
        userId: winner.userId,
        registrationId: winner.registrationId,
        gameUsername: winner.gameUsername,
        proofImageUrl: input.proofImageUrl.trim(),
      } satisfies QueryParams,
    );

    await conn.query(
      `INSERT INTO esports_wallets (user_id, balance_mwk)
       VALUES (:userId, :prize)
       ON DUPLICATE KEY UPDATE balance_mwk = balance_mwk + :prize`,
      { userId: winner.userId, prize: event.grandPrizeMwk },
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const updated = await getAdminEsportsEvent(eventId);
  if (updated) {
    const proofUrl = resolveEsportsImageUrl(input.proofImageUrl) ?? input.proofImageUrl;
    await emailService.sendEsportsResultAuditEmails({
      event: updated,
      participants: updated.participants,
      proofImageUrl: proofUrl,
    });
  }
  return updated;
}

export async function archiveExpiredEsportsEvents() {
  const [result] = await pool.query<import("mysql2").ResultSetHeader>(
    `UPDATE esports_events SET status = 'archived'
     WHERE status = 'completed'
       AND settled_at IS NOT NULL
       AND settled_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
  );
  return result.affectedRows;
}

async function ensureWallet(userId: string) {
  await pool.query(
    `INSERT IGNORE INTO esports_wallets (user_id, balance_mwk) VALUES (:userId, 0)`,
    { userId },
  );
}

export async function getEsportsDashboard(userId: string) {
  await ensureWallet(userId);

  const [walletRows] = await pool.query<RowDataPacket[]>(
    `SELECT balance_mwk FROM esports_wallets WHERE user_id = :userId`,
    { userId },
  );
  const balance = Number(walletRows[0]?.balance_mwk ?? 0);

  const [regRows] = await pool.query<RowDataPacket[]>(
    `SELECT r.id AS registrationId, r.game_username AS gameUsername, r.amount_paid_mwk AS amountPaidMwk,
            r.payment_status AS paymentStatus, r.registered_at AS registeredAt,
            e.id AS eventId, e.name, e.description, e.event_date AS eventDate, e.event_time AS eventTime,
            e.entry_price_mwk AS entryPriceMwk, e.image_url AS imageUrl, e.game_name AS gameName,
            e.match_duration_minutes AS matchDurationMinutes, e.grand_prize_mwk AS grandPrizeMwk,
            e.status, e.match_link AS matchLink, e.match_password AS matchPassword,
            e.winner_user_id AS winnerUserId, e.winner_game_username AS winnerGameUsername,
            e.winner_proof_image_url AS winnerProofImageUrl, e.settled_at AS settledAt
     FROM esports_registrations r
     JOIN esports_events e ON e.id = r.event_id
     WHERE r.user_id = :userId AND r.payment_status = 'completed'
     ORDER BY e.event_date DESC, e.event_time DESC`,
    { userId },
  );

  const [payoutRows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount_mwk ELSE 0 END), 0) AS reserved,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_mwk ELSE 0 END), 0) AS paidOut
     FROM esports_payouts WHERE user_id = :userId`,
    { userId },
  );
  const reserved = Number(payoutRows[0]?.reserved ?? 0);
  const paidOut = Number(payoutRows[0]?.paidOut ?? 0);

  return {
    balance,
    withdrawable: Math.max(0, balance - reserved),
    reservedInPayouts: reserved,
    paidOut,
    registrations: regRows.map((r) => {
      const status = String(r.status);
      const settledAt = r.settledAt ? String(r.settledAt) : null;
      const isWinner = r.winnerUserId && String(r.winnerUserId) === userId;
      return {
        registrationId: String(r.registrationId),
        gameUsername: String(r.gameUsername),
        amountPaidMwk: Number(r.amountPaidMwk ?? 0),
        registeredAt: r.registeredAt ? String(r.registeredAt) : null,
        event: {
          id: String(r.eventId),
          name: String(r.name),
          description: String(r.description),
          eventDate: String(r.eventDate).slice(0, 10),
          eventTime: String(r.eventTime),
          entryPriceMwk: Number(r.entryPriceMwk ?? 0),
          imageUrl: r.imageUrl ? String(r.imageUrl) : null,
          gameName: String(r.gameName),
          matchDurationMinutes: Number(r.matchDurationMinutes ?? 0),
          grandPrizeMwk: Number(r.grandPrizeMwk ?? 0),
          status,
          matchLink: r.matchLink ? String(r.matchLink) : null,
          matchPassword: r.matchPassword ? String(r.matchPassword) : null,
          winnerGameUsername: r.winnerGameUsername ? String(r.winnerGameUsername) : null,
          winnerProofImageUrl: r.winnerProofImageUrl ? String(r.winnerProofImageUrl) : null,
          settledAt,
          isCompleted: status === "completed" || status === "archived",
          isWinner,
        },
      };
    }),
  };
}

export async function registerForEsportsEvent(
  userId: string,
  eventId: string,
  input: {
    gameUsername: string;
    paymentMethod: MomoOperator | "card";
    phone?: string;
  },
) {
  if (!features.payments) throw new Error("Payments are temporarily unavailable");

  const gameUsername = input.gameUsername.trim();
  if (gameUsername.length < 2) throw new Error("Enter your in-game username");

  const [eventRows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*,
       (SELECT COUNT(*) FROM esports_registrations r
        WHERE r.event_id = e.id AND r.payment_status = 'completed') AS participant_count
     FROM esports_events e
     WHERE e.id = :eventId AND ${publicEventFilterSql("e")}`,
    { eventId },
  );
  const eventRow = eventRows[0];
  if (!eventRow) throw new Error("This tournament is not open for registration");

  const participantCount = Number(eventRow.participant_count ?? 0);
  const maxSlots = Math.max(1, Number(eventRow.max_slots ?? 32));
  const eventStatus = String(eventRow.status);
  if (eventStatus === "completed" || eventStatus === "archived") {
    throw new Error("This tournament is no longer open for registration");
  }
  if (participantCount >= maxSlots) {
    throw new Error("This tournament is sold out");
  }

  const [existing] = await pool.query<RowDataPacket[]>(
    `SELECT id, payment_status FROM esports_registrations
     WHERE event_id = :eventId AND user_id = :userId`,
    { eventId, userId },
  );
  if (existing[0]?.payment_status === "completed") {
    throw new Error("You are already registered for this tournament");
  }
  if (existing[0]?.payment_status === "pending") {
    throw new Error("You already have a pending payment for this tournament");
  }

  const profile = await getProfile(userId);
  if (!profile) throw new Error("Account not found");

  const accountName = String(profile.full_name ?? "").trim();
  const accountEmail = String(profile.email ?? "").trim();
  if (!accountName) {
    throw new Error(
      "Your account is missing a name. Update your profile in Dashboard → Account.",
    );
  }
  if (!accountEmail) {
    throw new Error("Your account is missing an email.");
  }

  const entryPrice = Number(eventRow.entry_price_mwk ?? 0);
  const registrationId = uuid();

  if (entryPrice <= 0) {
    await pool.query(
      `INSERT INTO esports_registrations (
        id, event_id, user_id, game_username, amount_paid_mwk, payment_status, payment_method, registered_at
      ) VALUES (
        :id, :eventId, :userId, :gameUsername, 0, 'completed', 'free', NOW()
      )`,
      { id: registrationId, eventId, userId, gameUsername } satisfies QueryParams,
    );
    return {
      registrationId,
      paymentStatus: "completed" as const,
      message: "You are registered for this tournament.",
    };
  }

  const paymentMethod = input.paymentMethod === "card" ? "airtel" : input.paymentMethod;
  const paymentPhone = input.phone?.trim() ?? "";
  if (input.paymentMethod !== "card" && !paymentPhone) {
    throw new Error("Mobile money phone number is required");
  }

  const chargePrefix = `TMES${registrationId.replace(/-/g, "").slice(0, 28)}`;
  let paychanguResult;
  try {
    paychanguResult = await initiateMobileMoneyCharge({
      chargeId: chargePrefix,
      amount: entryPrice,
      mobile: paymentPhone,
      operator: paymentMethod,
      email: accountEmail,
      fullName: accountName,
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Payment could not be started");
  }

  await pool.query(
    `INSERT INTO esports_registrations (
      id, event_id, user_id, game_username, amount_paid_mwk, payment_status,
      paychangu_charge_id, payment_method, payment_phone
    ) VALUES (
      :id, :eventId, :userId, :gameUsername, :amount, 'pending',
      :chargeId, :paymentMethod, :paymentPhone
    )`,
    {
      id: registrationId,
      eventId,
      userId,
      gameUsername,
      amount: entryPrice,
      chargeId: paychanguResult.chargeId,
      paymentMethod,
      paymentPhone: paymentPhone || null,
    } satisfies QueryParams,
  );

  return {
    registrationId,
    paymentStatus: "pending" as const,
    chargeId: paychanguResult.chargeId,
    providerStatus: paychanguResult.providerStatus,
    message: "Approve the mobile money prompt on your phone to complete registration.",
  };
}

export async function getEsportsRegistrationStatus(userId: string, registrationId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.*, e.name AS eventName FROM esports_registrations r
     JOIN esports_events e ON e.id = r.event_id
     WHERE r.id = :registrationId AND r.user_id = :userId`,
    { registrationId, userId },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    registrationId: String(row.id),
    eventId: String(row.event_id),
    eventName: String(row.eventName),
    paymentStatus: String(row.payment_status),
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
  };
}

export async function processPendingEsportsRegistration(registrationId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM esports_registrations WHERE id = :registrationId AND payment_status = 'pending'`,
    { registrationId },
  );
  const row = rows[0];
  if (!row?.paychangu_charge_id) return null;

  const verify = await verifyMobileMoneyCharge(String(row.paychangu_charge_id));
  if (verify.pending) return { status: "pending" as const };

  if (verify.failed || TERMINAL_PAYMENT_STATUSES.has(verify.providerStatus.toLowerCase())) {
    await pool.query(
      `UPDATE esports_registrations SET payment_status = 'failed', failure_reason = :reason WHERE id = :id`,
      { id: registrationId, reason: verify.message || "Payment failed" },
    );
    return { status: "failed" as const, message: verify.message };
  }

  if (verify.success) {
    await pool.query(
      `UPDATE esports_registrations SET payment_status = 'completed', registered_at = NOW(), failure_reason = NULL
       WHERE id = :id`,
      { id: registrationId },
    );
    return { status: "completed" as const };
  }

  return { status: "pending" as const };
}

export async function listPendingEsportsRegistrations() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM esports_registrations
     WHERE payment_status = 'pending'
       AND paychangu_charge_id IS NOT NULL
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
     ORDER BY created_at ASC
     LIMIT 50`,
  );
  return rows.map((r) => String(r.id));
}

export async function failStaleEsportsRegistrations() {
  const timeoutMs = env.paychangu.pendingTimeoutMs;
  const [result] = await pool.query<import("mysql2").ResultSetHeader>(
    `UPDATE esports_registrations SET payment_status = 'failed',
       failure_reason = 'Payment timed out'
     WHERE payment_status = 'pending'
       AND created_at < DATE_SUB(NOW(), INTERVAL :timeoutSec SECOND)`,
    { timeoutSec: Math.ceil(timeoutMs / 1000) },
  );
  return result.affectedRows;
}

export function resolveEsportsImageUrl(pathOrUrl: string | null | undefined) {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  return buildPublicImageUrl(pathOrUrl);
}
