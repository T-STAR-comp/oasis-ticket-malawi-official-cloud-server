import type { RowDataPacket } from "mysql2";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool, type QueryParams } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { getSellerResellFinance } from "./resell.service.js";
import type { PayoutDestination } from "./payout.service.js";
import { listAvailableBanks } from "./payout.service.js";

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
  return `TMRS${payoutId.replace(/-/g, "").slice(0, 28)}`;
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return email;
  return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
}

function platformFee(amount: number): number {
  return Math.ceil((amount * env.referrals.payoutFeePercent) / 100);
}

async function assertResellerWithdrawable(userId: string, amount: number) {
  const balances = await getSellerResellFinance(userId);
  if (amount > balances.withdrawable) {
    throw new Error(
      `Only ${balances.withdrawable.toLocaleString()} MWK is withdrawable right now. Resale earnings settle on T+1.`,
    );
  }
  const fee = platformFee(amount);
  if (amount <= fee) {
    throw new Error(`Amount must exceed the ${env.referrals.payoutFeePercent}% platform fee`);
  }
  return { balances, platformFeeMwk: fee, netToBank: amount - fee };
}

export async function getResellerPayoutDestination(userId: string): Promise<PayoutDestination | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT bank_uuid, bank_name, account_name, account_number
     FROM reseller_payout_destinations WHERE user_id = :userId`,
    { userId },
  );
  const row = rows[0];
  if (!row?.bank_uuid) return null;
  return {
    bankUuid: String(row.bank_uuid),
    bankName: String(row.bank_name),
    accountName: String(row.account_name),
    accountNumber: String(row.account_number),
  };
}

export async function initiateResellerPayoutVerification(
  userId: string,
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

  const { platformFeeMwk, netToBank } = await assertResellerWithdrawable(userId, amount);

  const banks = await listAvailableBanks();
  if (!banks.some((b) => b.uuid === bankUuid)) {
    throw new Error("Selected payout option is not supported");
  }

  const [userRows] = await pool.query<RowDataPacket[]>(
    `SELECT full_name, email FROM users WHERE id = :userId`,
    { userId },
  );
  const user = userRows[0];
  if (!user) throw new Error("User not found");

  const verificationId = uuid();
  const code = generateCode();
  const verifyTtlMinutes = Math.round(VERIFY_TTL_MS / 60_000);

  await pool.query(
    `UPDATE reseller_payout_verifications SET status = 'expired'
     WHERE user_id = :userId AND status = 'pending'`,
    { userId },
  );

  await pool.query(
    `INSERT INTO reseller_payout_verifications (
      id, user_id, amount_mwk, fee_mwk, bank_uuid, bank_name,
      account_name, account_number, branch, verification_email, verification_code, expires_at
    ) VALUES (
      :id, :userId, :amount, :platformFee, :bankUuid, :bankName,
      :accountName, :accountNumber, :branch, :verificationEmail, :code,
      DATE_ADD(NOW(), INTERVAL :verifyTtlMinutes MINUTE)
    )`,
    {
      id: verificationId,
      userId,
      amount,
      platformFee: platformFeeMwk,
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
    netToBank,
    bankName,
    code,
  );

  return {
    verificationId,
    maskedEmail: maskEmail(verificationEmail.trim().toLowerCase()),
    amount,
    platformFee: platformFeeMwk,
    netToBank,
    feePercent: env.referrals.payoutFeePercent,
    message: `A 6-digit code was sent. ${env.referrals.payoutFeePercent}% platform fee (MK ${platformFeeMwk.toLocaleString()}) applies; MK ${netToBank.toLocaleString()} will be sent to your bank.`,
    contactName: user.full_name as string,
  };
}

export async function confirmResellerPayoutVerification(
  userId: string,
  verificationId: string,
  code: string,
) {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error("Enter the 6-digit verification code from your email");
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT *, (expires_at > NOW()) AS not_expired
     FROM reseller_payout_verifications
     WHERE id = :verificationId AND user_id = :userId`,
    { verificationId, userId },
  );
  const row = rows[0];
  if (!row) throw new Error("Payout verification not found");
  if (row.status !== "pending") throw new Error("This payout verification is no longer active");
  if (!Number(row.not_expired)) {
    await pool.query(`UPDATE reseller_payout_verifications SET status = 'expired' WHERE id = :verificationId`, {
      verificationId,
    });
    throw new Error("Verification code expired. Please start a new payout request.");
  }

  const attempts = Number(row.attempt_count) + 1;
  await pool.query(
    `UPDATE reseller_payout_verifications SET attempt_count = :attempts WHERE id = :verificationId`,
    { attempts, verificationId },
  );

  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await pool.query(
      `UPDATE reseller_payout_verifications SET status = 'failed', failure_reason = :reason WHERE id = :verificationId`,
      { verificationId, reason: "Too many incorrect verification attempts" },
    );
    throw new Error("Too many incorrect attempts. Please start a new payout request.");
  }

  if (row.verification_code !== normalizedCode) {
    throw new Error(`Incorrect code. ${MAX_VERIFY_ATTEMPTS - attempts} attempts remaining.`);
  }

  const amount = Number(row.amount_mwk);
  const platformFeeMwk = Number(row.fee_mwk);
  const netToBank = amount - platformFeeMwk;

  await assertResellerWithdrawable(userId, amount);

  const destination: PayoutDestination = {
    bankUuid: row.bank_uuid as string,
    bankName: row.bank_name as string,
    accountName: row.account_name as string,
    accountNumber: row.account_number as string,
    branch: (row.branch as string | null) ?? undefined,
  };

  const result = await executeResellerPayout(userId, amount, platformFeeMwk, netToBank, destination);

  await pool.query(
    `UPDATE reseller_payout_verifications SET status = 'completed', payout_id = :payoutId WHERE id = :verificationId`,
    { verificationId, payoutId: result.payoutId },
  );

  await pool.query(
    `INSERT INTO reseller_payout_destinations (user_id, bank_uuid, bank_name, account_name, account_number)
     VALUES (:userId, :bankUuid, :bankName, :accountName, :accountNumber)
     ON DUPLICATE KEY UPDATE
       bank_uuid = VALUES(bank_uuid),
       bank_name = VALUES(bank_name),
       account_name = VALUES(account_name),
       account_number = VALUES(account_number)`,
    {
      userId,
      bankUuid: destination.bankUuid,
      bankName: destination.bankName,
      accountName: destination.accountName,
      accountNumber: destination.accountNumber,
    },
  );

  return result;
}

async function executeResellerPayout(
  userId: string,
  grossAmount: number,
  platformFeeMwk: number,
  netToBank: number,
  destination: PayoutDestination,
) {
  const payoutId = uuid();
  const chargeId = makePayoutChargeId(payoutId);

  if (env.paychangu.mock) {
    await pool.query(
      `INSERT INTO reseller_payouts (
        id, user_id, amount_mwk, fee_mwk, net_amount_mwk, status, paychangu_charge_id,
        bank_uuid, bank_account_name, bank_account_number, provider_status, completed_at
      ) VALUES (
        :id, :userId, :gross, :platformFee, :net, 'completed', :chargeId,
        :bankUuid, :accountName, :accountNumber, 'success', NOW()
      )`,
      {
        id: payoutId,
        userId,
        gross: grossAmount,
        platformFee: platformFeeMwk,
        net: netToBank,
        chargeId,
        bankUuid: destination.bankUuid,
        accountName: destination.accountName,
        accountNumber: destination.accountNumber,
      },
    );
    return {
      payoutId,
      chargeId,
      amount: grossAmount,
      platformFee: platformFeeMwk,
      netToBank,
      status: "completed" as const,
      message: `Payout completed (mock). MK ${netToBank.toLocaleString()} sent after ${env.referrals.payoutFeePercent}% platform fee.`,
    };
  }

  if (!env.paychangu.apiKey) throw new Error("PayChangu API key is not configured");

  const res = await fetch(`${env.paychangu.baseUrl}/direct-charge/payouts/initialize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      payout_method: "bank_transfer",
      bank_uuid: destination.bankUuid,
      amount: netToBank,
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
    throw new Error(
      typeof body.message === "string" ? body.message : "PayChangu could not start the payout",
    );
  }

  const providerStatus = String(
    (body.data as Record<string, unknown> | undefined)?.status ?? topStatus ?? "processing",
  );

  await pool.query(
    `INSERT INTO reseller_payouts (
      id, user_id, amount_mwk, fee_mwk, net_amount_mwk, status, paychangu_charge_id,
      bank_uuid, bank_account_name, bank_account_number, provider_status
    ) VALUES (
      :id, :userId, :gross, :platformFee, :net, 'processing', :chargeId,
      :bankUuid, :accountName, :accountNumber, :providerStatus
    )`,
    {
      id: payoutId,
      userId,
      gross: grossAmount,
      platformFee: platformFeeMwk,
      net: netToBank,
      chargeId,
      bankUuid: destination.bankUuid,
      accountName: destination.accountName,
      accountNumber: destination.accountNumber,
      providerStatus,
    },
  );

  return {
    payoutId,
    chargeId,
    amount: grossAmount,
    platformFee: platformFeeMwk,
    netToBank,
    status: "processing" as const,
    message: `Payout submitted. MK ${netToBank.toLocaleString()} after ${env.referrals.payoutFeePercent}% platform fee.`,
  };
}

export { listAvailableBanks };
