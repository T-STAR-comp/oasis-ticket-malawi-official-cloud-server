import { env } from "../config/env.js";
import {
  resolveServiceFeePercent,
  getServiceFeeBearer,
  type ServiceFeeBearer,
  type ServiceFeeSource,
} from "../services/platform-settings.service.js";

/** Platform checkout fee as a percentage of ticket subtotal (MWK), rounded up. */
export function computePlatformServiceFeeWithPercent(
  ticketSubtotalMwk: number,
  percent: number,
): number {
  if (ticketSubtotalMwk <= 0 || percent <= 0) return 0;
  return Math.ceil((ticketSubtotalMwk * percent) / 100);
}

/** @deprecated Use resolveCheckoutServiceFee for listing checkout. */
export function computePlatformServiceFee(ticketSubtotalMwk: number): number {
  return computePlatformServiceFeeWithPercent(ticketSubtotalMwk, env.platformServiceFeePercent);
}

export function platformServiceFeePercent(): number {
  return env.platformServiceFeePercent;
}

export async function resolveCheckoutServiceFee(
  organizerUserId: string | null | undefined,
  catalogSubtotalMwk: number,
): Promise<{
  fee: number;
  percent: number;
  source: ServiceFeeSource;
  bearer: ServiceFeeBearer;
}> {
  const [{ percent, source }, bearer] = await Promise.all([
    resolveServiceFeePercent(organizerUserId, catalogSubtotalMwk),
    getServiceFeeBearer(),
  ]);
  const fee = computePlatformServiceFeeWithPercent(catalogSubtotalMwk, percent);
  return { fee, percent, source, bearer };
}

export type AppliedCheckoutPricing = {
  subtotal: number;
  serviceFee: number;
  total: number;
  catalogSubtotal: number;
  catalogServiceFee: number;
  catalogTotal: number;
  serviceFeePercent: number;
  serviceFeeSource: ServiceFeeSource;
  serviceFeeBearer: ServiceFeeBearer;
};

export function applyServiceFeeBearer(input: {
  organizerSubtotal: number;
  buyerSubtotal: number;
  serviceFee: number;
  bearer: ServiceFeeBearer;
  mockTotal?: number | null;
}): Pick<AppliedCheckoutPricing, "subtotal" | "serviceFee" | "total"> {
  if (input.bearer === "organizer") {
    return {
      subtotal: Math.max(0, input.organizerSubtotal - input.serviceFee),
      serviceFee: input.serviceFee,
      total:
        input.mockTotal != null && Number.isFinite(input.mockTotal)
          ? input.mockTotal
          : input.buyerSubtotal,
    };
  }
  const total =
    input.mockTotal != null && Number.isFinite(input.mockTotal)
      ? input.mockTotal
      : input.buyerSubtotal + input.serviceFee;
  return {
    subtotal: input.organizerSubtotal,
    serviceFee: input.serviceFee,
    total,
  };
}
