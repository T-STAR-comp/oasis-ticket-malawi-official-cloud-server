import { env } from "../config/env.js";

export type MomoOperator = "airtel" | "tnm";

export type PayChanguInitResult = {
  chargeId: string;
  transId: string | null;
  refId: string | null;
  providerStatus: string;
  raw: Record<string, unknown>;
};

export type PayChanguVerifyResult = {
  success: boolean;
  pending: boolean;
  failed: boolean;
  providerStatus: string;
  message: string;
  raw: Record<string, unknown>;
};

export class PayChanguError extends Error {
  status: number;
  raw: Record<string, unknown>;

  constructor(message: string, status: number, raw: Record<string, unknown>) {
    super(message);
    this.name = "PayChanguError";
    this.status = status;
    this.raw = raw;
  }
}

/** Payment ended unsuccessfully — fail immediately, even during PIN grace window. */
export const TERMINAL_PAYMENT_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "declined",
  "expired",
  "rejected",
  "timeout",
  "timed_out",
]);

const PENDING_STATUSES = new Set([
  "pending",
  "processing",
  "initiated",
  "open",
  "awaiting",
  "waiting",
  "in_progress",
  "in progress",
]);

function authHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.paychangu.apiKey}`,
  };
}

function operatorRef(method: MomoOperator): string {
  return method === "airtel" ? env.paychangu.airtelOperatorRef : env.paychangu.tnmOperatorRef;
}

/** PayChangu expects Malawi local format e.g. 0999123456 */
function normalizeMobile(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("265")) return `0${digits.slice(3)}`;
  if (digits.startsWith("0")) return digits;
  return `0${digits}`;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "Customer" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function formatPayChanguError(body: Record<string, unknown>, fallback: string): string {
  const message = body.message;

  if (typeof message === "string" && message.trim()) {
    return message;
  }

  if (message && typeof message === "object" && !Array.isArray(message)) {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(message as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        parts.push(`${field}: ${value.map(String).join(", ")}`);
      } else if (typeof value === "string") {
        parts.push(`${field}: ${value}`);
      }
    }
    if (parts.length > 0) return parts.join("; ");
  }

  if (typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }

  return fallback;
}

async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

function extractStatuses(body: Record<string, unknown>) {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const transaction = (data.transaction ?? {}) as Record<string, unknown>;
  const paymentStatus = String(transaction.status ?? data.status ?? "").toLowerCase();
  const topStatus = String(body.status ?? "").toLowerCase();
  return { data, transaction, paymentStatus, topStatus };
}

function hasCompletionEvidence(
  data: Record<string, unknown>,
  transaction: Record<string, unknown>,
): boolean {
  const completedAt = transaction.completed_at ?? data.completed_at;
  if (completedAt) return true;
  const auth = (transaction.authorization ?? data.authorization) as
    | Record<string, unknown>
    | undefined;
  return !!auth?.completed_at;
}

function isTerminalFailure(paymentStatus: string, topStatus: string): boolean {
  return (
    TERMINAL_PAYMENT_STATUSES.has(paymentStatus) || TERMINAL_PAYMENT_STATUSES.has(topStatus)
  );
}

/**
 * Only treat as paid when PayChangu reports the charge itself succeeded,
 * not when an API wrapper returns status "success" for a metadata lookup.
 */
function interpretVerifyBody(
  body: Record<string, unknown>,
  httpOk: boolean,
): PayChanguVerifyResult {
  const { data, transaction, paymentStatus, topStatus } = extractStatuses(body);

  if (isTerminalFailure(paymentStatus, topStatus)) {
    return {
      success: false,
      pending: false,
      failed: true,
      providerStatus: paymentStatus || topStatus,
      message: formatPayChanguError(body, "Payment was cancelled or declined"),
      raw: body,
    };
  }

  const paymentCompleted =
    (paymentStatus === "success" || paymentStatus === "successful") &&
    hasCompletionEvidence(data, transaction);

  const verifyEndpointCompleted =
    topStatus === "successful" &&
    (paymentStatus === "success" ||
      paymentStatus === "successful" ||
      hasCompletionEvidence(data, transaction));

  if (paymentCompleted || verifyEndpointCompleted) {
    return {
      success: true,
      pending: false,
      failed: false,
      providerStatus: paymentStatus || topStatus || "success",
      message: formatPayChanguError(body, "Payment confirmed"),
      raw: body,
    };
  }

  const explicitlyPending =
    PENDING_STATUSES.has(paymentStatus) ||
    PENDING_STATUSES.has(topStatus) ||
    !paymentStatus;

  if (!httpOk || explicitlyPending) {
    return {
      success: false,
      pending: true,
      failed: false,
      providerStatus: paymentStatus || topStatus || "pending",
      message: formatPayChanguError(body, "Awaiting mobile money confirmation"),
      raw: body,
    };
  }

  return {
    success: false,
    pending: false,
    failed: true,
    providerStatus: paymentStatus || topStatus || "unknown",
    message: formatPayChanguError(body, "Payment was not completed"),
    raw: body,
  };
}

export async function initiateMobileMoneyCharge(input: {
  chargeId: string;
  amount: number;
  mobile: string;
  operator: MomoOperator;
  email: string;
  fullName: string;
}): Promise<PayChanguInitResult> {
  if (env.paychangu.mock) {
    return {
      chargeId: input.chargeId,
      transId: `mock-${input.chargeId}`,
      refId: `MOCK-${Date.now()}`,
      providerStatus: "pending",
      raw: { mock: true },
    };
  }

  const { first, last } = splitName(input.fullName);
  const payload = {
    mobile: normalizeMobile(input.mobile),
    mobile_money_operator_ref_id: operatorRef(input.operator),
    amount: String(input.amount),
    charge_id: input.chargeId,
    email: input.email,
    first_name: first,
    last_name: last,
  };

  console.log("[paychangu] init charge", input.chargeId, payload.mobile, payload.amount);

  const res = await fetch(`${env.paychangu.baseUrl}/mobile-money/payments/initialize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  const body = await parseJsonResponse(res);
  const topStatus = String(body.status ?? "").toLowerCase();

  if (!res.ok || topStatus === "failed") {
    const message = formatPayChanguError(body, "PayChangu payment initiation failed");
    console.error("[paychangu] init failed:", res.status, JSON.stringify(body));
    throw new PayChanguError(message, res.status, body);
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  const chargeId = data.charge_id ? String(data.charge_id) : "";
  if (!chargeId) {
    console.error("[paychangu] init missing charge_id:", JSON.stringify(body));
    throw new PayChanguError(
      "PayChangu accepted the request but did not return a charge ID",
      res.status,
      body,
    );
  }

  return {
    chargeId,
    transId: data.trans_id ? String(data.trans_id) : null,
    refId: data.ref_id ? String(data.ref_id) : null,
    providerStatus: String(data.status ?? topStatus ?? "pending"),
    raw: body,
  };
}

export async function verifyMobileMoneyCharge(
  chargeId: string,
  initiatedAt?: Date,
): Promise<PayChanguVerifyResult> {
  if (env.paychangu.mock) {
    const started = initiatedAt?.getTime() ?? Date.now();
    const elapsed = Date.now() - started;
    if (elapsed < env.paychangu.mockSuccessDelayMs) {
      return {
        success: false,
        pending: true,
        failed: false,
        providerStatus: "pending",
        message: "Awaiting mobile money authorization",
        raw: { mock: true, elapsed },
      };
    }
    return {
      success: true,
      pending: false,
      failed: false,
      providerStatus: "success",
      message: "Mock payment completed",
      raw: { mock: true, elapsed },
    };
  }

  const res = await fetch(
    `${env.paychangu.baseUrl}/mobile-money/payments/${encodeURIComponent(chargeId)}/verify`,
    { method: "GET", headers: authHeaders() },
  );

  const body = await parseJsonResponse(res);
  const result = interpretVerifyBody(body, res.ok);

  if (result.success) {
    console.log("[paychangu] verify success", chargeId, result.providerStatus);
  } else if (result.failed) {
    console.warn("[paychangu] verify failed", chargeId, JSON.stringify(body));
  }

  return result;
}

/** Refund a card charge back to the customer's card (same payment method). */
export async function refundCardCharge(chargeId: string): Promise<Record<string, unknown>> {
  if (env.paychangu.mock) {
    console.log("[paychangu] mock card refund", chargeId);
    return { mock: true, chargeId };
  }

  const res = await fetch(
    `${env.paychangu.baseUrl}/charge-card/refund/${encodeURIComponent(chargeId)}`,
    { method: "POST", headers: authHeaders() },
  );
  const body = await parseJsonResponse(res);
  const topStatus = String(body.status ?? "").toLowerCase();
  if (!res.ok || topStatus === "failed") {
    throw new PayChanguError(
      formatPayChanguError(body, "Card refund failed"),
      res.status,
      body,
    );
  }
  return body;
}

/** Send a mobile-money refund to the number used at checkout (Airtel / TNM). */
export async function initiateMobileMoneyRefund(input: {
  refundChargeId: string;
  amount: number;
  mobile: string;
  operator: MomoOperator;
}): Promise<PayChanguInitResult> {
  if (env.paychangu.mock) {
    console.log("[paychangu] mock momo refund", input.refundChargeId, input.amount, input.mobile);
    return {
      chargeId: input.refundChargeId,
      transId: `mock-ref-${input.refundChargeId}`,
      refId: `MOCK-REF-${Date.now()}`,
      providerStatus: "success",
      raw: { mock: true },
    };
  }

  const payload = {
    mobile: normalizeMobile(input.mobile),
    mobile_money_operator_ref_id: operatorRef(input.operator),
    amount: String(input.amount),
    charge_id: input.refundChargeId,
  };

  console.log("[paychangu] momo refund", input.refundChargeId, payload.mobile, payload.amount);

  const res = await fetch(`${env.paychangu.baseUrl}/mobile-money/payouts/initialize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  const body = await parseJsonResponse(res);
  const topStatus = String(body.status ?? "").toLowerCase();
  if (!res.ok || topStatus === "failed") {
    throw new PayChanguError(
      formatPayChanguError(body, "Mobile money refund failed"),
      res.status,
      body,
    );
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  const chargeId = data.charge_id ? String(data.charge_id) : input.refundChargeId;
  return {
    chargeId,
    transId: data.trans_id ? String(data.trans_id) : null,
    refId: data.ref_id ? String(data.ref_id) : null,
    providerStatus: String(data.status ?? topStatus ?? "pending"),
    raw: body,
  };
}
