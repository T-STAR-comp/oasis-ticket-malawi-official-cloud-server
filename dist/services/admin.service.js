import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { resolveBankUuid } from "../lib/paychangu-banks.js";
import * as emailService from "./email.service.js";
function payoutDetailsFromApplication(app) {
    const bankName = app.bank_name ??
        app.settlement_preference ??
        null;
    const bankUuid = resolveBankUuid(bankName);
    if (!bankUuid || !app.account_name || !app.account_number)
        return null;
    return {
        bankUuid,
        bankName: bankName ?? "Payout account",
        accountName: String(app.account_name),
        accountNumber: String(app.account_number),
    };
}
async function applyPayoutDetailsToOrganizer(userId, app) {
    const payout = payoutDetailsFromApplication(app);
    if (!payout)
        return;
    await pool.query(`UPDATE organizer_profiles SET
       payout_bank_uuid = :bankUuid,
       payout_bank_name = :bankName,
       payout_account_name = :accountName,
       payout_account_number = :accountNumber
     WHERE user_id = :userId`, { userId, ...payout });
}
function mapUser(row) {
    return {
        id: row.id,
        email: row.email,
        username: row.username ?? null,
        fullName: row.full_name,
        phone: row.phone ?? null,
        role: row.role,
        status: row.status ?? "active",
        emailVerified: Boolean(row.email_verified),
        createdAt: row.created_at,
    };
}
export async function adminSignIn(username, password) {
    const [rows] = await pool.query(`SELECT * FROM users WHERE username = :username AND role = 'admin' LIMIT 1`, { username });
    const row = rows[0];
    if (!row)
        return null;
    if (row.status !== "active")
        return null;
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid)
        return null;
    return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: "admin",
    };
}
export async function changeAdminPassword(adminId, currentPassword, newPassword) {
    const [rows] = await pool.query(`SELECT password_hash, email, full_name FROM users WHERE id = :id AND role = 'admin'`, { id: adminId });
    const row = rows[0];
    if (!row)
        throw new Error("Admin not found");
    const valid = await bcrypt.compare(currentPassword, row.password_hash);
    if (!valid)
        throw new Error("Current password is incorrect");
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = :hash WHERE id = :id`, { hash, id: adminId });
    await emailService.sendPasswordChangedEmail(row.email, row.full_name);
    return { changed: true };
}
export async function listUsers() {
    const [rows] = await pool.query(`SELECT id, email, username, full_name, phone, role, status, email_verified, created_at
     FROM users WHERE role != 'admin' ORDER BY created_at DESC`);
    return rows.map(mapUser);
}
export async function updateUserStatus(userId, status) {
    const [rows] = await pool.query(`SELECT email, full_name, role FROM users WHERE id = :id AND role != 'admin'`, { id: userId });
    const user = rows[0];
    if (!user)
        throw new Error("User not found");
    await pool.query(`UPDATE users SET status = :status WHERE id = :id`, { status, id: userId });
    await emailService.sendAccountStatusEmail(user.email, user.full_name, status);
    return { id: userId, status };
}
export async function listOrganizers() {
    const [rows] = await pool.query(`SELECT u.id AS user_id, u.email, u.full_name, u.status AS user_status, u.created_at,
            op.id AS profile_id, op.company_name, op.contact_name, op.phone, op.partner_type,
            op.city, op.bio, op.status AS organizer_status, op.created_at AS profile_created_at
     FROM organizer_profiles op
     JOIN users u ON u.id = op.user_id
     ORDER BY op.updated_at DESC`);
    return rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        fullName: r.full_name,
        userStatus: r.user_status,
        profileId: r.profile_id,
        companyName: r.company_name,
        contactName: r.contact_name,
        phone: r.phone,
        partnerType: r.partner_type,
        city: r.city,
        bio: r.bio,
        organizerStatus: r.organizer_status,
        createdAt: r.profile_created_at,
    }));
}
export async function updateOrganizerStatus(userId, status) {
    const [rows] = await pool.query(`SELECT op.company_name, op.email, u.full_name
     FROM organizer_profiles op JOIN users u ON u.id = op.user_id
     WHERE op.user_id = :userId`, { userId });
    const row = rows[0];
    if (!row)
        throw new Error("Organizer not found");
    await pool.query(`UPDATE organizer_profiles SET status = :status WHERE user_id = :userId`, {
        status,
        userId,
    });
    if (status === "suspended" || status === "inactive") {
        await pool.query(`UPDATE users SET status = 'suspended' WHERE id = :userId`, { userId });
        if (status === "suspended") {
            await emailService.sendOrganizerSuspendedBuyerNotice(userId, row.company_name);
        }
    }
    else if (status === "approved") {
        await pool.query(`UPDATE users SET status = 'active', role = 'organizer' WHERE id = :userId`, {
            userId,
        });
    }
    await emailService.sendOrganizerStatusEmail(row.email, row.company_name, status);
    return { userId, status };
}
export async function listPartnerApplications(status) {
    let sql = `SELECT * FROM partner_applications`;
    const params = {};
    if (status) {
        sql += ` WHERE status = :status`;
        params.status = status;
    }
    sql += ` ORDER BY created_at DESC`;
    const [rows] = await pool.query(sql, params);
    return rows;
}
export async function getPartnerApplication(id) {
    const [rows] = await pool.query(`SELECT * FROM partner_applications WHERE id = :id`, { id });
    return rows[0] ?? null;
}
export async function reviewPartnerApplication(id, adminId, decision, adminNotes) {
    const app = await getPartnerApplication(id);
    if (!app)
        throw new Error("Application not found");
    if (!["submitted", "reviewing"].includes(app.status)) {
        throw new Error("Application already reviewed");
    }
    await pool.query(`UPDATE partner_applications
     SET status = :status, reviewed_by = :adminId, reviewed_at = NOW(), admin_notes = :notes
     WHERE id = :id`, { status: decision, adminId, notes: adminNotes ?? null, id });
    if (decision === "approved") {
        let userId;
        const [existing] = await pool.query(`SELECT id FROM users WHERE email = :email`, { email: app.contact_email.toLowerCase() });
        if (existing[0]) {
            userId = existing[0].id;
            await pool.query(`UPDATE users SET role = 'organizer', status = 'active', email_verified = 1, email_verified_at = COALESCE(email_verified_at, NOW())
         WHERE id = :userId`, { userId });
            const [profile] = await pool.query(`SELECT id FROM organizer_profiles WHERE user_id = :userId`, { userId });
            if (!profile[0]) {
                await pool.query(`INSERT INTO organizer_profiles (id, user_id, company_name, contact_name, email, phone, partner_type, city, bio, status)
           VALUES (:id, :userId, :companyName, :contactName, :email, :phone, :partnerType, :city, :bio, 'approved')`, {
                    id: uuid(),
                    userId,
                    companyName: app.company_name,
                    contactName: app.contact_name,
                    email: app.contact_email,
                    phone: app.contact_phone,
                    partnerType: app.partner_type,
                    city: app.city,
                    bio: app.company_description,
                });
                await applyPayoutDetailsToOrganizer(userId, app);
            }
            else {
                await pool.query(`UPDATE organizer_profiles SET status = 'approved', company_name = :companyName WHERE user_id = :userId`, { userId, companyName: app.company_name });
            }
            await applyPayoutDetailsToOrganizer(userId, app);
        }
        else {
            userId = uuid();
            const tempPassword = Math.random().toString(36).slice(-10) + "A1!";
            const passwordHash = await bcrypt.hash(tempPassword, 10);
            await pool.query(`INSERT INTO users (id, email, password_hash, full_name, phone, role, status, email_verified, email_verified_at)
         VALUES (:id, :email, :passwordHash, :fullName, :phone, 'organizer', 'active', 1, NOW())`, {
                id: userId,
                email: app.contact_email.toLowerCase(),
                passwordHash,
                fullName: app.contact_name,
                phone: app.contact_phone,
            });
            const profileId = uuid();
            await pool.query(`INSERT INTO organizer_profiles (id, user_id, company_name, contact_name, email, phone, partner_type, city, bio, status)
         VALUES (:id, :userId, :companyName, :contactName, :email, :phone, :partnerType, :city, :bio, 'approved')`, {
                id: profileId,
                userId,
                companyName: app.company_name,
                contactName: app.contact_name,
                email: app.contact_email,
                phone: app.contact_phone,
                partnerType: app.partner_type,
                city: app.city,
                bio: app.company_description,
            });
            await applyPayoutDetailsToOrganizer(userId, app);
            await emailService.sendEmail(app.contact_email, "Your Ticket Malawi organizer account", `<p>Your partner application was approved.</p>
         <p>Sign in at the main app with email <strong>${app.contact_email}</strong> and temporary password: <strong>${tempPassword}</strong></p>
         <p>Please change your password after signing in.</p>`);
        }
    }
    await emailService.sendPartnerDecisionEmail(app.contact_email, app.company_name, decision === "approved", adminNotes);
    return { id, status: decision };
}
export async function getDashboardStats() {
    const [users] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE role = 'customer'`);
    const [organizers] = await pool.query(`SELECT COUNT(*) AS total FROM organizer_profiles`);
    const [pendingApps] = await pool.query(`SELECT COUNT(*) AS total FROM partner_applications WHERE status IN ('submitted','reviewing')`);
    const [suspended] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE status = 'suspended'`);
    return {
        customers: Number(users[0]?.total ?? 0),
        organizers: Number(organizers[0]?.total ?? 0),
        pendingApplications: Number(pendingApps[0]?.total ?? 0),
        suspendedUsers: Number(suspended[0]?.total ?? 0),
    };
}
