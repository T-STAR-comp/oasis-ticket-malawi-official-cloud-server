import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { LEGAL_VERSION } from "../config/legal.js";
import { pool } from "../db/pool.js";
let firebaseReady = false;
function ensureFirebaseAdmin() {
    if (firebaseReady)
        return;
    if (!env.firebase.enabled) {
        throw new Error("Firebase authentication is not enabled on this server");
    }
    const account = env.firebase.serviceAccount;
    if (getApps().length === 0) {
        if (account) {
            initializeApp({
                credential: cert(account),
                projectId: env.firebase.projectId,
            });
        }
        else {
            initializeApp({ projectId: env.firebase.projectId });
        }
    }
    firebaseReady = true;
}
function mapUserRow(row) {
    if (row.status === "suspended" && row.role !== "organizer") {
        throw new Error("Account suspended");
    }
    if (row.status === "inactive")
        throw new Error("Account inactive");
    return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
    };
}
async function upsertFirebaseUser(input) {
    const email = input.email.toLowerCase();
    const [byUid] = await pool.query(`SELECT id, email, full_name, role, status FROM users WHERE firebase_uid = :firebaseUid`, { firebaseUid: input.firebaseUid });
    if (byUid[0])
        return mapUserRow(byUid[0]);
    const [byEmail] = await pool.query(`SELECT id, email, full_name, role, status, firebase_uid FROM users WHERE email = :email`, { email });
    const existing = byEmail[0];
    if (existing) {
        if (existing.firebase_uid && existing.firebase_uid !== input.firebaseUid) {
            throw new Error("This email is linked to a different sign-in method");
        }
        // Link Google to an existing email/password account (same email).
        await pool.query(`UPDATE users SET
         firebase_uid = :firebaseUid,
         email_verified = GREATEST(email_verified, :verified),
         email_verified_at = CASE WHEN :verified = 1 AND email_verified_at IS NULL THEN NOW() ELSE email_verified_at END,
         full_name = COALESCE(NULLIF(:fullName, ''), full_name)
       WHERE id = :id`, {
            firebaseUid: input.firebaseUid,
            verified: input.emailVerified ? 1 : 0,
            fullName: input.fullName,
            id: existing.id,
        });
        const [rows] = await pool.query(`SELECT id, email, full_name, role, status FROM users WHERE id = :id`, { id: existing.id });
        return mapUserRow(rows[0]);
    }
    if (!input.acceptedTerms) {
        throw new Error("You must accept the Terms of Service and Privacy Policy");
    }
    const id = uuid();
    const placeholderHash = await bcrypt.hash(uuid(), 10);
    await pool.query(`INSERT INTO users (
       id, email, firebase_uid, password_hash, full_name, phone, role, status,
       email_verified, email_verified_at, terms_accepted_at, terms_version
     ) VALUES (
       :id, :email, :firebaseUid, :passwordHash, :fullName, :phone, 'customer', 'active',
       :verified, CASE WHEN :verified = 1 THEN NOW() ELSE NULL END, NOW(), :termsVersion
     )`, {
        id,
        email,
        firebaseUid: input.firebaseUid,
        passwordHash: placeholderHash,
        fullName: input.fullName || email.split("@")[0],
        phone: input.phone ?? null,
        verified: input.emailVerified ? 1 : 0,
        termsVersion: LEGAL_VERSION,
    });
    const [rows] = await pool.query(`SELECT id, email, full_name, role, status FROM users WHERE id = :id`, { id });
    return mapUserRow(rows[0]);
}
export async function authenticateFirebaseIdToken(idToken, input) {
    ensureFirebaseAdmin();
    let decoded;
    try {
        decoded = await getAuth().verifyIdToken(idToken);
    }
    catch {
        throw new Error("Invalid or expired Firebase session. Sign in again.");
    }
    const firebaseUid = decoded.uid;
    const email = String(decoded.email ?? "").toLowerCase();
    if (!email) {
        throw new Error("Firebase account must include a verified email address");
    }
    const fullName = input?.fullName?.trim() ||
        String(decoded.name ?? "").trim() ||
        email.split("@")[0];
    return upsertFirebaseUser({
        firebaseUid,
        email,
        fullName,
        phone: input?.phone,
        acceptedTerms: input?.acceptedTerms ?? true,
        emailVerified: decoded.email_verified === true,
    });
}
