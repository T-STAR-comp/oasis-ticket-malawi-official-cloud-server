import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { PAYCHANGU_BANK_OPTIONS } from "../lib/paychangu-banks.js";
import { pool, type QueryParams } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { getOrganizerSettlementBalances } from "./settlement.service.js";

const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_TTL_MS = 15 * 60 * 1000;

function authHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.paychangu.apiKey}`,
  };
}

function makePayoutChargeId(payoutId: string): string {
  return `TMWD${payoutId.replace(/-/g, "").slice(0, 28)}`;
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export type PayoutDestination = {
  bankUuid: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  branch?: string;
};

export async function listAvailableBanks() {
  if (env.paychangu.apiKey && !env.paychangu.mock) {
    try {
      const res = await fetch(`${env.paychangu.baseUrl}/banks`, {
        method: "GET",
        headers: authHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const raw = (body.data ?? body.banks ?? body) as unknown;
      if (Array.isArray(raw) && raw.length > 0) {
        const banks = raw
          .map((item) => {
            const row = item as Record<string, unknown>;
            const name = String(row.name ?? row.bank_name ?? "").trim();
            const bankUuid = String(row.uuid ?? row.id ?? row.bank_uuid ?? "").trim();
            if (!name || !bankUuid) return null;
            return { name, uuid: bankUuid };
          })
          .filter(Boolean) as Array<{ name: string; uuid: string }>;
        if (banks.length > 0) return banks;
      }
    } catch (err) {
      console.warn("[payout] PayChangu banks fetch failed, using static list:", err);
    }
  }
  return PAYCHANGU_BANK_OPTIONS;
}

function assertBankAllowed(bankUuid: string, banks: Array<{ uuid: string }>) {
  if (!banks.some((b) => b.uuid === bankUuid)) {
    throw new Error("Selected payout option is not supported");
  }
}

async function assertOrganizerCanPayout(organizerId: string) {
  const [profileRows] = await pool.query<RowDataPacket[]>(
    `SELECT status, company_name, contact_name, email FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  const profile = profileRows[0];
  if (!profile || profile.status !== "approved") {
    throw new Error("Your organizer account must be approved before requesting payouts");
  }
  return profile;
}

async function assertWithdrawable(organizerId: string, amount: number) {
  const balances = await getOrganizerSettlementBalances(organizerId);
  if (balances.outstandingRefundDebt > 0) {
    throw new Error(
      `Withdrawals are blocked while you have MK ${balances.outstandingRefundDebt.toLocaleString()} in outstanding customer refund debt. New settled ticket sales will pay customers back first until this balance is cleared.`,
    );
  }
  if (amount > balances.withdrawable) {
    const virtualNote =
      balances.virtualPayoutHold > 0
        ? ` MK ${balances.virtualPayoutHold.toLocaleString()} is held from virtual events pending admin verification.`
        : "";
    throw new Error(
      `Only ${balances.withdrawable.toLocaleString()} MWK is withdrawable right now. PayChangu settles ticket sales on T+1 — today's sales become available tomorrow.${virtualNote}`,
    );
  }
  return balances;
}

export async function getOrganizerPayoutDestination(
  organizerId: string,
): Promise<PayoutDestination | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT payout_bank_uuid, payout_bank_name, payout_account_name, payout_account_number
     FROM organizer_profiles WHERE user_id = :organizerId`,
    { organizerId },
  );
  const row = rows[0];
  if (!row?.payout_bank_uuid || !row?.payout_account_name || !row?.payout_account_number) {
    return null;
  }
  return {
    bankUuid: row.payout_bank_uuid as string,
    bankName: (row.payout_bank_name as string) ?? "Payout account",
    accountName: row.payout_account_name as string,
    accountNumber: row.payout_account_number as string,
  };
}

export async function listOrganizerPayouts(organizerId: string) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, amount_mwk, status, paychangu_charge_id, bank_account_name,
            bank_account_number, provider_status, failure_reason,
            requested_at, completed_at
     FROM organizer_payouts
     WHERE organizer_id = :organizerId
     ORDER BY requested_at DESC
     LIMIT 50`,
    { organizerId },
  );
  return rows.map((r) => ({
    id: r.id as string,
    amount: Number(r.amount_mwk),
    status: r.status as string,
    chargeId: r.paychangu_charge_id as string,
    accountName: r.bank_account_name as string,
    accountNumber: r.bank_account_number as string,
    providerStatus: (r.provider_status as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? undefined,
    requestedAt: String(r.requested_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  }));
}

export async function initiatePayoutVerification(
  organizerId: string,
  input: {
    amount: number;
    bankUuid: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    verificationEmail: string;
    branch?: string;
  },
) {
  const { amount, bankUuid, bankName, accountName, accountNumber, verificationEmail, branch } =
    input;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payout amount must be greater than zero");
  }
  if (!accountName.trim() || !accountNumber.trim()) {
    throw new Error("Account name and account number are required");
  }
  if (!verificationEmail.trim() || !verificationEmail.includes("@")) {
    throw new Error("A valid verification email is required");
  }

  const profile = await assertOrganizerCanPayout(organizerId);
  await assertWithdrawable(organizerId, amount);

  const banks = await listAvailableBanks();
  assertBankAllowed(bankUuid, banks);

  const verificationId = uuid();
  const code = generateCode();
  const verifyTtlMinutes = Math.round(VERIFY_TTL_MS / 60_000);

  await pool.query(
    `UPDATE payout_verifications
     SET status = 'expired'
     WHERE organizer_id = :organizerId AND status = 'pending'`,
    { organizerId },
  );

  await pool.query(
    `INSERT INTO payout_verifications (
      id, organizer_id, amount_mwk, bank_uuid, bank_name, account_name, account_number,
      branch, verification_email, verification_code, expires_at
    ) VALUES (
      :id, :organizerId, :amount, :bankUuid, :bankName, :accountName, :accountNumber,
      :branch, :verificationEmail, :code,
      DATE_ADD(NOW(), INTERVAL :verifyTtlMinutes MINUTE)
    )`,
    {
      id: verificationId,
      organizerId,
      amount,
      bankUuid,
      bankName,
      accountName: accountName.trim(),
      accountNumber: accountNumber.trim(),
      branch: branch?.trim() || null,
      verificationEmail: verificationEmail.trim().toLowerCase(),
      code,
      verifyTtlMinutes,
    } satisfies QueryParams,
  );

  await emailService.sendPayoutVerificationCode(
    verificationEmail.trim().toLowerCase(),
    accountName.trim(),
    amount,
    bankName,
    code,
  );

  const [expiryRows] = await pool.query<RowDataPacket[]>(
    `SELECT expires_at FROM payout_verifications WHERE id = :verificationId`,
    { verificationId },
  );
  const expiresAt = expiryRows[0]?.expires_at
    ? new Date(expiryRows[0].expires_at as string | Date).toISOString()
    : new Date(Date.now() + VERIFY_TTL_MS).toISOString();

  return {
    verificationId,
    maskedEmail: maskEmail(verificationEmail.trim().toLowerCase()),
    expiresAt,
    message: `A 6-digit verification code was sent to ${maskEmail(verificationEmail.trim().toLowerCase())}. Enter it to complete your payout.`,
    contactName: profile.contact_name as string,
  };
}

export async function confirmPayoutVerification(
  organizerId: string,
  verificationId: string,
  code: string,
) {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error("Enter the 6-digit verification code from your email");
  }

  await assertOrganizerCanPayout(organizerId);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT *,
            (expires_at > NOW()) AS not_expired
     FROM payout_verifications
     WHERE id = :verificationId AND organizer_id = :organizerId`,
    { verificationId, organizerId },
  );
  const row = rows[0];
  if (!row) throw new Error("Payout verification not found");
  if (row.status !== "pending") {
    throw new Error("This payout verification is no longer active");
  }
  if (!Number(row.not_expired)) {
    await pool.query(`UPDATE payout_verifications SET status = 'expired' WHERE id = :verificationId`, {
      verificationId,
    });
    throw new Error("Verification code expired. Please start a new payout request.");
  }

  const attempts = Number(row.attempt_count) + 1;
  await pool.query(
    `UPDATE payout_verifications SET attempt_count = :attempts WHERE id = :verificationId`,
    { attempts, verificationId },
  );

  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await pool.query(
      `UPDATE payout_verifications SET status = 'failed', failure_reason = :reason WHERE id = :verificationId`,
      { verificationId, reason: "Too many incorrect verification attempts" },
    );
    throw new Error("Too many incorrect attempts. Please start a new payout request.");
  }

  if (row.verification_code !== normalizedCode) {
    throw new Error(`Incorrect code. ${MAX_VERIFY_ATTEMPTS - attempts} attempts remaining.`);
  }

  const amount = Number(row.amount_mwk);
  try {
    await assertWithdrawable(organizerId, amount);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Not eligible for this payout amount";
    await pool.query(
      `UPDATE payout_verifications SET status = 'failed', failure_reason = :reason WHERE id = :verificationId`,
      { verificationId, reason },
    );
    throw err;
  }

  const destination: PayoutDestination = {
    bankUuid: row.bank_uuid as string,
    bankName: row.bank_name as string,
    accountName: row.account_name as string,
    accountNumber: row.account_number as string,
    branch: (row.branch as string | null) ?? undefined,
  };

  const result = await executePayout(organizerId, amount, destination);

  await pool.query(
    `UPDATE payout_verifications
     SET status = 'completed', payout_id = :payoutId WHERE id = :verificationId`,
    { verificationId, payoutId: result.payoutId },
  );

  await pool.query(
    `UPDATE organizer_profiles SET
       payout_bank_uuid = :bankUuid,
       payout_bank_name = :bankName,
       payout_account_name = :accountName,
       payout_account_number = :accountNumber
     WHERE user_id = :organizerId`,
    {
      organizerId,
      bankUuid: destination.bankUuid,
      bankName: destination.bankName,
      accountName: destination.accountName,
      accountNumber: destination.accountNumber,
    } satisfies QueryParams,
  );

  return result;
}

async function executePayout(
  organizerId: string,
  amount: number,
  destination: PayoutDestination,
) {
  const payoutId = uuid();
  const chargeId = makePayoutChargeId(payoutId);

  if (env.paychangu.mock) {
    await pool.query(
      `INSERT INTO organizer_payouts (
        id, organizer_id, amount_mwk, status, paychangu_charge_id, payout_method,
        bank_uuid, bank_account_name, bank_account_number, provider_status, completed_at
      ) VALUES (
        :id, :organizerId, :amount, 'completed', :chargeId, 'bank_transfer',
        :bankUuid, :accountName, :accountNumber, 'success', NOW()
      )`,
      {
        id: payoutId,
        organizerId,
        amount,
        chargeId,
        bankUuid: destination.bankUuid,
        accountName: destination.accountName,
        accountNumber: destination.accountNumber,
      } satisfies QueryParams,
    );
    return {
      payoutId,
      chargeId,
      amount,
      status: "completed" as const,
      message: "Payout completed successfully (mock mode).",
    };
  }

  if (!env.paychangu.apiKey) {
    throw new Error("PayChangu API key is not configured");
  }

  const res = await fetch(`${env.paychangu.baseUrl}/direct-charge/payouts/initialize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      payout_method: "bank_transfer",
      bank_uuid: destination.bankUuid,
      amount,
      charge_id: chargeId,
      bank_account_name: destination.accountName,
      bank_account_number: destination.accountNumber,
    }),
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { message: text };
  }

  const topStatus = String(body.status ?? "").toLowerCase();
  if (!res.ok || topStatus === "failed") {
    const message =
      typeof body.message === "string" ? body.message : "PayChangu could not start the payout";
    throw new Error(message);
  }

  const providerStatus = String(
    (body.data as Record<string, unknown> | undefined)?.status ?? topStatus ?? "processing",
  );

  await pool.query(
    `INSERT INTO organizer_payouts (
      id, organizer_id, amount_mwk, status, paychangu_charge_id, payout_method,
      bank_uuid, bank_account_name, bank_account_number, provider_status
    ) VALUES (
      :id, :organizerId, :amount, 'processing', :chargeId, 'bank_transfer',
      :bankUuid, :accountName, :accountNumber, :providerStatus
    )`,
    {
      id: payoutId,
      organizerId,
      amount,
      chargeId,
      bankUuid: destination.bankUuid,
      accountName: destination.accountName,
      accountNumber: destination.accountNumber,
      providerStatus,
    } satisfies QueryParams,
  );

  return {
    payoutId,
    chargeId,
    amount,
    status: "processing" as const,
    message:
      "Payout verified and submitted to PayChangu. Funds should arrive shortly — check your account.",
  };
}

/** @deprecated Use initiatePayoutVerification + confirmPayoutVerification */
export async function requestOrganizerPayout(organizerId: string, amount: number) {
  const destination = await getOrganizerPayoutDestination(organizerId);
  if (!destination) {
    throw new Error("Use the payout wizard to select a bank and verify your account.");
  }
  await assertOrganizerCanPayout(organizerId);
  await assertWithdrawable(organizerId, amount);
  return executePayout(organizerId, amount, destination);
}

export async function listAllPayouts(limit = 100) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.id, p.amount_mwk, p.status, p.paychangu_charge_id,
            p.bank_account_name, p.provider_status, p.failure_reason,
            p.requested_at, p.completed_at,
            op.company_name AS organizerName, op.user_id AS organizerId
     FROM organizer_payouts p
     JOIN organizer_profiles op ON op.user_id = p.organizer_id
     ORDER BY p.requested_at DESC
     LIMIT ${Number(limit)}`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    organizerId: r.organizerId as string,
    organizerName: r.organizerName as string,
    amount: Number(r.amount_mwk),
    status: r.status as string,
    chargeId: r.paychangu_charge_id as string,
    accountName: r.bank_account_name as string,
    providerStatus: (r.provider_status as string | null) ?? null,
    failureReason: (r.failure_reason as string | null) ?? undefined,
    requestedAt: String(r.requested_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  }));
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return email;
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain}`;
}
