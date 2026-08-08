import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { getEsportsDashboard } from "./esports.service.js";
import { listAvailableBanks } from "./payout.service.js";
import { withPayoutLock } from "./payout-lock.service.js";
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_TTL_MS = 15 * 60 * 1000;
function authHeaders() {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.paychangu.apiKey}`,
    };
}
function makePayoutChargeId(payoutId) {
    return `TMEP${payoutId.replace(/-/g, "").slice(0, 28)}`;
}
function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
function maskEmail(email) {
    const [user, domain] = email.split("@");
    if (!user || !domain)
        return email;
    return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
}
function platformFee(amount) {
    return Math.ceil((amount * env.referrals.payoutFeePercent) / 100);
}
async function assertEsportsWithdrawable(userId, amount) {
    const dashboard = await getEsportsDashboard(userId);
    if (amount > dashboard.withdrawable) {
        throw new Error(`Only ${dashboard.withdrawable.toLocaleString()} MWK is withdrawable from your E-Sports balance.`);
    }
    const fee = platformFee(amount);
    if (amount <= fee) {
        throw new Error(`Amount must exceed the ${env.referrals.payoutFeePercent}% platform fee`);
    }
    return { dashboard, platformFeeMwk: fee, netToBank: amount - fee };
}
export async function initiateEsportsPayoutVerification(userId, input) {
    const { amount, bankUuid, bankName, accountName, accountNumber, verificationEmail, branch } = input;
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Payout amount must be greater than zero");
    }
    const { platformFeeMwk, netToBank } = await assertEsportsWithdrawable(userId, amount);
    const banks = await listAvailableBanks();
    if (!banks.some((b) => b.uuid === bankUuid)) {
        throw new Error("Selected payout option is not supported");
    }
    const [userRows] = await pool.query(`SELECT full_name, email FROM users WHERE id = :userId`, { userId });
    const user = userRows[0];
    if (!user)
        throw new Error("User not found");
    const verificationId = uuid();
    const code = generateCode();
    const verifyTtlMinutes = Math.round(VERIFY_TTL_MS / 60_000);
    await pool.query(`UPDATE esports_payout_verifications SET status = 'expired'
     WHERE user_id = :userId AND status = 'pending'`, { userId });
    await pool.query(`INSERT INTO esports_payout_verifications (
      id, user_id, amount_mwk, fee_mwk, bank_uuid, bank_name,
      account_name, account_number, branch, verification_email, verification_code, expires_at
    ) VALUES (
      :id, :userId, :amount, :platformFee, :bankUuid, :bankName,
      :accountName, :accountNumber, :branch, :verificationEmail, :code,
      DATE_ADD(NOW(), INTERVAL :verifyTtlMinutes MINUTE)
    )`, {
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
    });
    await emailService.sendPayoutVerificationCode(verificationEmail.trim().toLowerCase(), accountName.trim(), netToBank, bankName, code);
    return {
        verificationId,
        maskedEmail: maskEmail(verificationEmail.trim().toLowerCase()),
        amount,
        platformFee: platformFeeMwk,
        netToBank,
        feePercent: env.referrals.payoutFeePercent,
        message: `A 6-digit code was sent. ${env.referrals.payoutFeePercent}% platform fee applies.`,
        contactName: user.full_name,
    };
}
export async function confirmEsportsPayoutVerification(userId, verificationId, code) {
    const normalizedCode = code.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
        throw new Error("Enter the 6-digit verification code from your email");
    }
    const [rows] = await pool.query(`SELECT *, (expires_at > NOW()) AS not_expired
     FROM esports_payout_verifications
     WHERE id = :verificationId AND user_id = :userId`, { verificationId, userId });
    const row = rows[0];
    if (!row)
        throw new Error("Payout verification not found");
    if (row.status !== "pending")
        throw new Error("This payout verification is no longer active");
    if (!Number(row.not_expired)) {
        await pool.query(`UPDATE esports_payout_verifications SET status = 'expired' WHERE id = :verificationId`, {
            verificationId,
        });
        throw new Error("Verification code expired. Please start a new payout request.");
    }
    const attempts = Number(row.attempt_count) + 1;
    await pool.query(`UPDATE esports_payout_verifications SET attempt_count = :attempts WHERE id = :verificationId`, { attempts, verificationId });
    if (attempts > MAX_VERIFY_ATTEMPTS) {
        await pool.query(`UPDATE esports_payout_verifications SET status = 'failed', failure_reason = :reason WHERE id = :verificationId`, { verificationId, reason: "Too many incorrect verification attempts" });
        throw new Error("Too many incorrect attempts. Please start a new payout request.");
    }
    if (row.verification_code !== normalizedCode) {
        throw new Error(`Incorrect code. ${MAX_VERIFY_ATTEMPTS - attempts} attempts remaining.`);
    }
    const amount = Number(row.amount_mwk);
    const platformFeeMwk = Number(row.fee_mwk);
    const netToBank = amount - platformFeeMwk;
    const destination = {
        bankUuid: row.bank_uuid,
        bankName: row.bank_name,
        accountName: row.account_name,
        accountNumber: row.account_number,
        branch: row.branch ?? undefined,
    };
    const result = await withPayoutLock(`payout:esports:${userId}`, async () => {
        await assertEsportsWithdrawable(userId, amount);
        return executeEsportsPayout(userId, amount, platformFeeMwk, netToBank, destination);
    });
    await pool.query(`UPDATE esports_payout_verifications SET status = 'completed', payout_id = :payoutId WHERE id = :verificationId`, { verificationId, payoutId: result.payoutId });
    await pool.query(`INSERT INTO esports_payout_destinations (user_id, bank_uuid, bank_name, account_name, account_number, branch)
     VALUES (:userId, :bankUuid, :bankName, :accountName, :accountNumber, :branch)
     ON DUPLICATE KEY UPDATE
       bank_uuid = VALUES(bank_uuid),
       bank_name = VALUES(bank_name),
       account_name = VALUES(account_name),
       account_number = VALUES(account_number),
       branch = VALUES(branch)`, {
        userId,
        bankUuid: destination.bankUuid,
        bankName: destination.bankName,
        accountName: destination.accountName,
        accountNumber: destination.accountNumber,
        branch: destination.branch ?? null,
    });
    return result;
}
async function executeEsportsPayout(userId, grossAmount, platformFeeMwk, netToBank, destination) {
    const payoutId = uuid();
    const chargeId = makePayoutChargeId(payoutId);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [walletRows] = await conn.query(`SELECT balance_mwk FROM esports_wallets WHERE user_id = :userId FOR UPDATE`, { userId });
        const balance = Number(walletRows[0]?.balance_mwk ?? 0);
        if (balance < grossAmount) {
            throw new Error("Insufficient E-Sports balance");
        }
        await conn.query(`UPDATE esports_wallets SET balance_mwk = balance_mwk - :amount WHERE user_id = :userId`, { userId, amount: grossAmount });
        if (env.paychangu.mock) {
            await conn.query(`INSERT INTO esports_payouts (
          id, user_id, amount_mwk, fee_mwk, status, paychangu_charge_id,
          bank_uuid, bank_account_name, bank_account_number, provider_status, completed_at
        ) VALUES (
          :id, :userId, :gross, :platformFee, 'completed', :chargeId,
          :bankUuid, :accountName, :accountNumber, 'success', NOW()
        )`, {
                id: payoutId,
                userId,
                gross: grossAmount,
                platformFee: platformFeeMwk,
                chargeId,
                bankUuid: destination.bankUuid,
                accountName: destination.accountName,
                accountNumber: destination.accountNumber,
            });
            await conn.commit();
            return {
                payoutId,
                chargeId,
                amount: grossAmount,
                platformFee: platformFeeMwk,
                netToBank,
                status: "completed",
                message: `Payout completed (mock). MK ${netToBank.toLocaleString()} sent after platform fee.`,
            };
        }
        if (!env.paychangu.apiKey)
            throw new Error("PayChangu API key is not configured");
        await conn.query(`INSERT INTO esports_payouts (
        id, user_id, amount_mwk, fee_mwk, status, paychangu_charge_id,
        bank_uuid, bank_account_name, bank_account_number, provider_status
      ) VALUES (
        :id, :userId, :gross, :platformFee, 'processing', :chargeId,
        :bankUuid, :accountName, :accountNumber, 'initiated'
      )`, {
            id: payoutId,
            userId,
            gross: grossAmount,
            platformFee: platformFeeMwk,
            chargeId,
            bankUuid: destination.bankUuid,
            accountName: destination.accountName,
            accountNumber: destination.accountNumber,
        });
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
    let res;
    let text;
    try {
        res = await fetch(`${env.paychangu.baseUrl}/direct-charge/payouts/initialize`, {
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
        text = await res.text();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "PayChangu could not start the payout";
        await pool.query(`UPDATE esports_payouts SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
       WHERE id = :id`, { id: payoutId, reason: message });
        await pool.query(`UPDATE esports_wallets SET balance_mwk = balance_mwk + :amount WHERE user_id = :userId`, { userId, amount: grossAmount });
        throw new Error(message);
    }
    let body = {};
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = { message: text };
    }
    const topStatus = String(body.status ?? "").toLowerCase();
    if (!res.ok || topStatus === "failed") {
        const message = typeof body.message === "string" ? body.message : "PayChangu could not start the payout";
        await pool.query(`UPDATE esports_payouts SET status = 'failed', failure_reason = :reason, provider_status = 'failed'
       WHERE id = :id`, { id: payoutId, reason: message });
        await pool.query(`UPDATE esports_wallets SET balance_mwk = balance_mwk + :amount WHERE user_id = :userId`, { userId, amount: grossAmount });
        throw new Error(message);
    }
    const providerStatus = String(body.data?.status ?? topStatus ?? "processing");
    await pool.query(`UPDATE esports_payouts SET provider_status = :providerStatus WHERE id = :id`, {
        id: payoutId,
        providerStatus,
    });
    return {
        payoutId,
        chargeId,
        amount: grossAmount,
        platformFee: platformFeeMwk,
        netToBank,
        status: "processing",
        message: `Payout submitted. MK ${netToBank.toLocaleString()} after platform fee.`,
    };
}
export { listAvailableBanks };
