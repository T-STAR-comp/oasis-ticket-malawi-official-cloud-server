import { env } from "../config/env.js";
import { resolveServiceFeePercent, getServiceFeeBearer, } from "../services/platform-settings.service.js";
/** Platform checkout fee as a percentage of ticket subtotal (MWK), rounded up. */
export function computePlatformServiceFeeWithPercent(ticketSubtotalMwk, percent) {
    if (ticketSubtotalMwk <= 0 || percent <= 0)
        return 0;
    return Math.ceil((ticketSubtotalMwk * percent) / 100);
}
/** @deprecated Use resolveCheckoutServiceFee for listing checkout. */
export function computePlatformServiceFee(ticketSubtotalMwk) {
    return computePlatformServiceFeeWithPercent(ticketSubtotalMwk, env.platformServiceFeePercent);
}
export function platformServiceFeePercent() {
    return env.platformServiceFeePercent;
}
export async function resolveCheckoutServiceFee(organizerUserId, catalogSubtotalMwk) {
    const [{ percent, source }, bearer] = await Promise.all([
        resolveServiceFeePercent(organizerUserId, catalogSubtotalMwk),
        getServiceFeeBearer(),
    ]);
    const fee = computePlatformServiceFeeWithPercent(catalogSubtotalMwk, percent);
    return { fee, percent, source, bearer };
}
export function applyServiceFeeBearer(input) {
    if (input.bearer === "organizer") {
        return {
            subtotal: Math.max(0, input.organizerSubtotal - input.serviceFee),
            serviceFee: input.serviceFee,
            total: input.mockTotal != null && Number.isFinite(input.mockTotal)
                ? input.mockTotal
                : input.buyerSubtotal,
        };
    }
    const total = input.mockTotal != null && Number.isFinite(input.mockTotal)
        ? input.mockTotal
        : input.buyerSubtotal + input.serviceFee;
    return {
        subtotal: input.organizerSubtotal,
        serviceFee: input.serviceFee,
        total,
    };
}
