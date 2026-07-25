import { features } from "../config/features.js";
import { fail } from "../utils/http.js";
const MESSAGES = {
    payments: "Checkout and payments are temporarily unavailable.",
    ticketGeneration: "Ticket issuance is temporarily unavailable.",
    signup: "New account registration is temporarily unavailable.",
    signin: "Sign in is temporarily unavailable.",
    email: "Email delivery is temporarily unavailable.",
    becomeOrganizer: "Partner applications are temporarily unavailable.",
    guestCheckout: "Guest checkout is temporarily unavailable.",
};
export function requireFeature(feature) {
    return (_req, res, next) => {
        if (!features[feature]) {
            return fail(res, MESSAGES[feature], 503);
        }
        next();
    };
}
