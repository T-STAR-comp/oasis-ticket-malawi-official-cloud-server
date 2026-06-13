import { ZodError, z } from "zod";

/** Treat null/empty strings as undefined so optional fields don't fail UUID checks. */
export function emptyToUndefined(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  return value;
}

export function optionalString(max = 128) {
  return z.preprocess(emptyToUndefined, z.string().trim().min(1).max(max).optional());
}

export function optionalUuid() {
  return z.preprocess(emptyToUndefined, z.string().uuid().optional());
}

export function optionalTierId() {
  return z.preprocess(emptyToUndefined, z.string().trim().min(1).max(64).optional());
}

export function formatZodError(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Validation failed";
  const path = issue.path.length > 0 ? issue.path.join(".") : "request";
  const label = path
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `${label || "A required field"} is missing.`;
  }
  return `${label}: ${issue.message}`;
}
