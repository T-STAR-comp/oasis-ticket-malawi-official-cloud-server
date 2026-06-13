import { v4 as uuid } from "uuid";
import { pool } from "../db/pool.js";
import { normalizeMalawiPhone, maskPhone } from "../utils/phone.js";
function mapRow(r, includePhone = false) {
    return {
        id: r.id,
        type: r.type,
        label: r.label,
        detailsMasked: r.details_masked,
        phoneNumber: includePhone ? (r.phone_number ?? undefined) : undefined,
        isDefault: Boolean(r.is_default),
    };
}
export async function listPaymentMethods(userId, includePhone = false) {
    const [rows] = await pool.query(`SELECT * FROM payment_methods WHERE user_id = :userId ORDER BY is_default DESC, created_at ASC`, { userId });
    return rows.map((r) => mapRow(r, includePhone));
}
export async function getPaymentMethodForUser(userId, methodId) {
    const [rows] = await pool.query(`SELECT * FROM payment_methods WHERE id = :id AND user_id = :userId LIMIT 1`, { id: methodId, userId });
    const row = rows[0];
    return row ? mapRow(row, true) : null;
}
export async function addPaymentMethod(userId, input) {
    const phone = normalizeMalawiPhone(input.phone);
    if (!phone)
        throw new Error("Enter a valid Malawi mobile number");
    const id = uuid();
    const label = input.label?.trim() || (input.type === "airtel" ? "Airtel Money" : "TNM Mpamba");
    const masked = maskPhone(phone);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (input.isDefault) {
            await conn.query(`UPDATE payment_methods SET is_default = 0 WHERE user_id = :userId`, {
                userId,
            });
        }
        const [existing] = await conn.query(`SELECT id FROM payment_methods WHERE user_id = :userId`, { userId });
        const isDefault = input.isDefault ?? existing.length === 0;
        await conn.query(`INSERT INTO payment_methods (id, user_id, type, label, details_masked, phone_number, is_default)
       VALUES (:id, :userId, :type, :label, :masked, :phone, :isDefault)`, { id, userId, type: input.type, label, masked, phone, isDefault: isDefault ? 1 : 0 });
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
    return getPaymentMethodForUser(userId, id);
}
export async function removePaymentMethod(userId, methodId) {
    const [result] = await pool.query(`DELETE FROM payment_methods WHERE id = :id AND user_id = :userId`, { id: methodId, userId });
    if (result.affectedRows === 0) {
        throw new Error("Payment method not found");
    }
}
export async function setDefaultPaymentMethod(userId, methodId) {
    const method = await getPaymentMethodForUser(userId, methodId);
    if (!method)
        throw new Error("Payment method not found");
    await pool.query(`UPDATE payment_methods SET is_default = 0 WHERE user_id = :userId`, { userId });
    await pool.query(`UPDATE payment_methods SET is_default = 1 WHERE id = :id AND user_id = :userId`, { id: methodId, userId });
    return getPaymentMethodForUser(userId, methodId);
}
/** Save mobile money number after checkout when the user opted in. Never throws. */
export async function maybeSavePaymentMethodFromCheckout(userId, input) {
    if (!input.savePaymentMethod || input.paymentMethodId)
        return;
    if (input.paymentMethod !== "airtel" && input.paymentMethod !== "tnm")
        return;
    const phone = normalizeMalawiPhone(input.paymentPhone ?? "");
    if (!phone)
        return;
    try {
        const [rows] = await pool.query(`SELECT id FROM payment_methods
       WHERE user_id = :userId AND type = :type AND phone_number = :phone
       LIMIT 1`, { userId, type: input.paymentMethod, phone });
        if (rows[0])
            return mapRow(rows[0], true);
        return await addPaymentMethod(userId, {
            type: input.paymentMethod,
            phone,
        });
    }
    catch (err) {
        console.error("[payment-methods] save from checkout failed:", err);
        return null;
    }
}
