import { env } from "../config/env.js";
/** Platform checkout fee as a percentage of ticket subtotal (MWK), rounded up. */
export function computePlatformServiceFee(ticketSubtotalMwk) {
    if (ticketSubtotalMwk <= 0)
        return 0;
    const pct = env.platformServiceFeePercent;
    if (pct <= 0)
        return 0;
    return Math.ceil((ticketSubtotalMwk * pct) / 100);
}
export function platformServiceFeePercent() {
    return env.platformServiceFeePercent;
}
