import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? "http://localhost:8080";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const env = {
  port: Number(process.env.PORT ?? 8000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  mysql: {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required("MYSQL_USER"),
    password: process.env.MYSQL_PASSWORD ?? "",
    database: required("MYSQL_DATABASE"),
  },
  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  },
  corsOrigins: corsOrigins(),
  mail: {
    host: "mail.spacemail.com",
    port: 587,
    secure: false,
    user: "no-reply@ticketmalawi.com",
    pass: "Ticket2026Mail!",
    fromAddress: "no-reply@ticketmalawi.com",
    fromName: "Ticket Malawi",
    /**
     *   mail: {
    host: process.env.MAIL_HOST ?? "mail.spacemail.com",
    port: Number(process.env.MAIL_PORT ?? 465),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.MAIL_USERNAME ?? "no-reply@ticketmalawi.com",
    pass: process.env.MAIL_PASSWORD ?? "Pdl5c%fm",
    fromAddress: process.env.MAIL_FROM_ADDRESS ?? "no-reply@ticketmalawi.com",
    fromName: process.env.MAIL_FROM_NAME ?? "Ticket Malawi",
  }
     */
  },
  admin: {
    username: process.env.ADMIN_USERNAME ?? "admin",
    email: process.env.ADMIN_EMAIL ?? "admin@ticketmalawi.local",
    password: process.env.ADMIN_PASSWORD ?? "password",
    fullName: process.env.ADMIN_FULL_NAME ?? "System Administrator",
  },
  paychangu: {
    apiKey: process.env.PAYCHANGU_SECRET_KEY ?? process.env.PAYCHANGU_API_KEY ?? "",
    baseUrl: process.env.PAYCHANGU_BASE_URL ?? "https://api.paychangu.com",
    /** Mock only when explicitly enabled. Live key + MOCK=false hits real PayChangu. */
    mock: process.env.PAYCHANGU_MOCK === "true",
    mockPaymentAmountMwk: Number(process.env.PAYCHANGU_MOCK_AMOUNT_MWK ?? 50),
    mockSuccessDelayMs: Number(process.env.PAYCHANGU_MOCK_SUCCESS_DELAY_MS ?? 5000),
    pollIntervalMs: Number(process.env.PAYMENT_POLL_INTERVAL_MS ?? 8000),
    pendingTimeoutMs: Number(process.env.PAYMENT_PENDING_TIMEOUT_MS ?? 300_000),
    pendingTimeoutSec: Math.max(
      60,
      Math.floor(Number(process.env.PAYMENT_PENDING_TIMEOUT_MS ?? 300_000) / 1000),
    ),
    /** Do not mark failed while user is entering PIN on their phone */
    verifyGraceMs: Number(process.env.PAYMENT_VERIFY_GRACE_MS ?? 90_000),
    airtelOperatorRef:
      process.env.PAYCHANGU_AIRTEL_OPERATOR_REF ?? "20be6c20-adeb-4b5b-a7ba-0769820df4fb",
    tnmOperatorRef:
      process.env.PAYCHANGU_TNM_OPERATOR_REF ?? "27494cb5-ba9e-437f-a114-4e7a7686bcca",
  },
  /** Serve the React build from public/ (same origin as /api). */
  serveFrontend: process.env.SERVE_FRONTEND === "true" || process.env.NODE_ENV === "production",
  platformServiceFeePercent: Number(process.env.PLATFORM_SERVICE_FEE_PERCENT ?? 5),
  referrals: {
    payoutFeePercent: Number(process.env.REFERRAL_PAYOUT_FEE_PERCENT ?? 2),
  },
  auth: {
    /** legacy | firebase | both */
    provider: (process.env.AUTH_PROVIDER ?? "both") as "legacy" | "firebase" | "both",
  },
  firebase: {
    enabled:
      process.env.FIREBASE_AUTH_ENABLED === "true" ||
      process.env.AUTH_PROVIDER === "firebase" ||
      process.env.AUTH_PROVIDER === "both" ||
      !process.env.AUTH_PROVIDER,
    projectId: process.env.FIREBASE_PROJECT_ID ?? "ticket-malawi",
    serviceAccount: (() => {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        return null;
      }
    })(),
  },
  images: {
    /** Absolute or server-relative path to image-bucket-folder (sibling of app on cPanel). */
    bucketDir:
      process.env.IMAGE_BUCKET_DIR ??
      path.resolve(path.join(__dirname, "..", "..", "..", "image-bucket-folder")),
    /** Public origin for image URLs (API host in dev; CDN/domain in production). */
    publicOrigin: (process.env.IMAGE_PUBLIC_ORIGIN ?? "").replace(/\/$/, ""),
    /** Serve bucket files from this API (dev). On cPanel, use Apache/nginx alias instead. */
    serveFromApi: process.env.IMAGE_SERVE_FROM_API !== "false",
  },
};
