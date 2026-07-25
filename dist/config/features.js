import { log } from "../utils/logger.js";
function flag(name, defaultValue = true) {
    const raw = process.env[name];
    if (raw === undefined || raw === "")
        return defaultValue;
    return raw === "true" || raw === "1";
}
export const features = {
    payments: flag("FEATURE_PAYMENTS_ENABLED"),
    ticketGeneration: flag("FEATURE_TICKET_GENERATION_ENABLED"),
    signup: flag("FEATURE_SIGNUP_ENABLED"),
    signin: flag("FEATURE_SIGNIN_ENABLED"),
    email: flag("FEATURE_EMAIL_ENABLED"),
    becomeOrganizer: flag("FEATURE_BECOME_ORGANIZER_ENABLED"),
    guestCheckout: flag("FEATURE_GUEST_CHECKOUT_ENABLED"),
};
export function featureFlagsForPublic() {
    return { ...features };
}
/** Logged at startup for ops visibility (no secrets). */
export function logFeatureFlags() {
    log.info("features", "Platform feature flags loaded", { ...features });
}
