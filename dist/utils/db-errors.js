export function isDuplicateEntryError(err) {
    const e = err;
    return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062;
}
export function isReferencedRowError(err) {
    const e = err;
    return e?.code === "ER_ROW_IS_REFERENCED_2" || e?.errno === 1451;
}
export function friendlyDuplicateMessage(err) {
    const sqlMessage = err?.sqlMessage?.toLowerCase() ?? "";
    if (sqlMessage.includes("email")) {
        return "An account with this email already exists. Sign in or use a different email.";
    }
    if (sqlMessage.includes("username")) {
        return "This username is already taken. Choose another.";
    }
    if (sqlMessage.includes("reference")) {
        return "This booking reference already exists. Please try again.";
    }
    if (sqlMessage.includes("paychangu_charge_id") || sqlMessage.includes("charge_id")) {
        return "This payment is already being processed. Wait a moment or resume your pending checkout.";
    }
    if (sqlMessage.includes("qr_token")) {
        return "This ticket could not be issued because of a duplicate QR code. Please contact support.";
    }
    if (sqlMessage.includes("listing_id") && sqlMessage.includes("seat")) {
        return "A seat with this layout already exists. Refresh and try again.";
    }
    return "This information is already in use. Please check your details and try again.";
}
export function friendlyReferencedMessage(err) {
    const sqlMessage = err?.sqlMessage?.toLowerCase() ?? "";
    if (sqlMessage.includes("fk_orders_listing") || sqlMessage.includes("orders")) {
        return "This listing has ticket sales and cannot be deleted. Change its status to Cancelled to stop new sales while keeping purchase records.";
    }
    if (sqlMessage.includes("user_tickets")) {
        return "This listing has issued tickets and cannot be deleted.";
    }
    return "This item is linked to existing records and cannot be deleted.";
}
