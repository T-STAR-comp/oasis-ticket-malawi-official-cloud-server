import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import * as emailService from "./email.service.js";
import { LEGAL_VERSION } from "../config/legal.js";
function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
function normalizeOtpCode(raw) {
    return raw.replace(/\D/g, "").slice(0, 6);
}
async function createVerificationCode(userId, purpose = "signup") {
    const code = generateCode();
    const id = uuid();
    await pool.query(`UPDATE email_verification_codes SET used_at = NOW()
     WHERE user_id = :userId AND purpose = :purpose AND used_at IS NULL`, { userId, purpose });
    await pool.query(`INSERT INTO email_verification_codes (id, user_id, code, purpose, expires_at)
     VALUES (:id, :userId, :code, :purpose, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`, { id, userId, code, purpose });
    return code;
}
export async function signUp(input) {
    if (!input.acceptedTerms) {
        throw new Error("You must accept the Terms of Service and Privacy Policy");
    }
    const id = uuid();
    const passwordHash = await bcrypt.hash(input.password, 10);
    const role = input.role ?? "customer";
    await pool.query(`INSERT INTO users (
      id, email, password_hash, full_name, phone, role, status, email_verified,
      terms_accepted_at, terms_version
    ) VALUES (
      :id, :email, :passwordHash, :fullName, :phone, :role, 'active', 0,
      NOW(), :termsVersion
    )`, {
        id,
        email: input.email.toLowerCase(),
        passwordHash,
        fullName: input.fullName,
        phone: input.phone ?? null,
        role,
        termsVersion: LEGAL_VERSION,
    });
    const code = await createVerificationCode(id);
    await emailService.sendVerificationCode(input.email, input.fullName, code);
    return {
        id,
        email: input.email,
        fullName: input.fullName,
        role,
        requiresVerification: true,
    };
}
export async function verifyEmail(email, rawCode) {
    const code = normalizeOtpCode(rawCode);
    const [users] = await pool.query(`SELECT id, email, full_name, role, email_verified FROM users WHERE email = :email`, { email: email.toLowerCase() });
    const user = users[0];
    if (!user)
        throw new Error("User not found");
    if (user.email_verified)
        return { alreadyVerified: true };
    const [codes] = await pool.query(`SELECT id FROM email_verification_codes
     WHERE user_id = :userId AND TRIM(code) = :code AND used_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`, { userId: user.id, code });
    if (!codes[0])
        throw new Error("Invalid or expired verification code");
    await pool.query(`UPDATE email_verification_codes SET used_at = NOW() WHERE id = :id`, { id: codes[0].id });
    await pool.query(`UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = :id`, { id: user.id });
    await emailService.sendWelcomeEmail(user.email, user.full_name);
    const authUser = {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
    };
    return { user: authUser };
}
export async function resendVerification(email) {
    const [users] = await pool.query(`SELECT id, full_name, email_verified FROM users WHERE email = :email`, { email: email.toLowerCase() });
    const user = users[0];
    if (!user)
        throw new Error("User not found");
    if (user.email_verified)
        throw new Error("Email already verified");
    const code = await createVerificationCode(user.id);
    await emailService.sendVerificationCode(email, user.full_name, code);
    return { sent: true };
}
async function validateSignInCredentials(email, password) {
    const [rows] = await pool.query(`SELECT id, email, password_hash, full_name, role, status, email_verified, firebase_uid FROM users WHERE email = :email`, { email: email.toLowerCase() });
    const row = rows[0];
    if (!row)
        return null;
    if (!row.password_hash) {
        throw new Error("This account uses Firebase sign-in. Switch to Firebase auth and sign in again.");
    }
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid)
        return null;
    if (row.status === "suspended" && row.role !== "organizer") {
        throw new Error("Account suspended");
    }
    if (row.status === "inactive")
        throw new Error("Account inactive");
    if (!row.email_verified && row.role !== "admin")
        throw new Error("Email not verified");
    return row;
}
export async function initiateSignIn(email, password) {
    const row = await validateSignInCredentials(email, password);
    if (!row)
        return null;
    const code = await createVerificationCode(row.id, "login");
    await emailService.sendLoginCode(row.email, row.full_name, code);
    const masked = String(row.email).replace(/(^.).*(@.*$)/, "$1***$2");
    return {
        requiresCode: true,
        maskedEmail: masked,
        message: `We sent a 6-digit security code to ${masked}.`,
    };
}
export async function confirmSignIn(email, rawCode) {
    const code = normalizeOtpCode(rawCode);
    if (code.length !== 6)
        throw new Error("Invalid or expired security code");
    const [users] = await pool.query(`SELECT id, email, full_name, role, status, email_verified FROM users WHERE email = :email`, { email: email.toLowerCase() });
    const user = users[0];
    if (!user)
        return null;
    // purpose = 'login' after migration; empty purpose if enum was not migrated yet.
    const [codes] = await pool.query(`SELECT id FROM email_verification_codes
     WHERE user_id = :userId
       AND TRIM(code) = :code
       AND used_at IS NULL
       AND expires_at > NOW()
       AND (
         purpose = 'login'
         OR purpose = ''
         OR purpose NOT IN ('signup', 'password_reset', 'password_change')
       )
     ORDER BY created_at DESC LIMIT 1`, { userId: user.id, code });
    if (!codes[0])
        throw new Error("Invalid or expired security code");
    await pool.query(`UPDATE email_verification_codes SET used_at = NOW() WHERE id = :id`, {
        id: codes[0].id,
    });
    if (user.status === "suspended" && user.role !== "organizer") {
        throw new Error("Account suspended");
    }
    if (user.status === "inactive")
        throw new Error("Account inactive");
    return {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
    };
}
/** @deprecated Use initiateSignIn + confirmSignIn */
export async function signIn(email, password) {
    const row = await validateSignInCredentials(email, password);
    if (!row)
        return null;
    return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
    };
}
export async function getProfile(userId) {
    const [rows] = await pool.query(`SELECT id, email, full_name, phone, national_id, role, status, email_verified FROM users WHERE id = :userId`, { userId });
    return rows[0] ?? null;
}
export async function initiatePasswordChange(userId, currentPassword, newPassword) {
    const [rows] = await pool.query(`SELECT password_hash, email, full_name FROM users WHERE id = :userId`, { userId });
    const row = rows[0];
    if (!row)
        throw new Error("User not found");
    const valid = await bcrypt.compare(currentPassword, row.password_hash);
    if (!valid)
        throw new Error("Current password is incorrect");
    const code = generateCode();
    const newHash = await bcrypt.hash(newPassword, 10);
    const id = uuid();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(`UPDATE password_change_requests SET used_at = NOW()
     WHERE user_id = :userId AND used_at IS NULL`, { userId });
    await pool.query(`INSERT INTO password_change_requests (id, user_id, new_password_hash, code, expires_at)
     VALUES (:id, :userId, :newHash, :code, :expiresAt)`, { id, userId, newHash, code, expiresAt });
    await emailService.sendPasswordChangeCode(row.email, row.full_name, code);
    const masked = String(row.email).replace(/(^.).*(@.*$)/, "$1***$2");
    return {
        requestId: id,
        maskedEmail: masked,
        expiresAt: expiresAt.toISOString(),
        message: `We sent a 6-digit code to ${masked}. Enter it to confirm your new password.`,
    };
}
export async function confirmPasswordChange(userId, requestId, code) {
    const [rows] = await pool.query(`SELECT pcr.*, u.email, u.full_name
     FROM password_change_requests pcr
     JOIN users u ON u.id = pcr.user_id
     WHERE pcr.id = :requestId AND pcr.user_id = :userId
       AND pcr.used_at IS NULL AND pcr.expires_at > NOW()
     LIMIT 1`, { requestId, userId });
    const row = rows[0];
    if (!row || row.code !== code) {
        throw new Error("Invalid or expired verification code");
    }
    await pool.query(`UPDATE users SET password_hash = :hash WHERE id = :userId`, {
        hash: row.new_password_hash,
        userId,
    });
    await pool.query(`UPDATE password_change_requests SET used_at = NOW() WHERE id = :requestId`, {
        requestId,
    });
    await emailService.sendPasswordChangedEmail(row.email, row.full_name);
    return { changed: true };
}
export async function updateProfile(userId, data) {
    await pool.query(`UPDATE users SET
      full_name = COALESCE(:fullName, full_name),
      phone = COALESCE(:phone, phone),
      national_id = COALESCE(:nationalId, national_id)
     WHERE id = :userId`, {
        userId,
        fullName: data.fullName ?? null,
        phone: data.phone ?? null,
        nationalId: data.nationalId ?? null,
    });
    return getProfile(userId);
}
