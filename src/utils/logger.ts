type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogMeta = Record<string, unknown>;

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  scope: "\x1b[35m",
  time: "\x1b[90m",
} as const;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMeta(meta?: LogMeta): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (value instanceof Error) return `${key}=${JSON.stringify(value.message)}`;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${key}=${value}`;
      }
      try {
        return `${key}=${JSON.stringify(value)}`;
      } catch {
        return `${key}=[unserializable]`;
      }
    });
  return parts.length > 0 ? ` │ ${parts.join(" │ ")}` : "";
}

function levelColor(level: LogLevel): string {
  switch (level) {
    case "DEBUG":
      return COLORS.debug;
    case "INFO":
      return COLORS.info;
    case "WARN":
      return COLORS.warn;
    case "ERROR":
      return COLORS.error;
    default:
      return COLORS.reset;
  }
}

function write(level: LogLevel, scope: string, message: string, meta?: LogMeta, err?: unknown) {
  const line =
    `${COLORS.time}${formatTimestamp()}${COLORS.reset} ` +
    `${levelColor(level)}${level.padEnd(5)}${COLORS.reset} ` +
    `${COLORS.scope}[${scope}]${COLORS.reset} ` +
    `${message}${formatMeta(meta)}`;

  if (level === "ERROR") {
    console.error(line);
    if (err !== undefined) {
      if (err instanceof Error) {
        console.error(`${COLORS.error}  └─ ${err.stack ?? err.message}${COLORS.reset}`);
      } else {
        console.error(`${COLORS.error}  └─`, err, COLORS.reset);
      }
    }
    return;
  }

  if (level === "WARN") {
    console.warn(line);
    return;
  }

  console.log(line);
}

/** Structured application logger — timestamp, level, scope, message, optional metadata. */
export const log = {
  debug(scope: string, message: string, meta?: LogMeta) {
    write("DEBUG", scope, message, meta);
  },
  info(scope: string, message: string, meta?: LogMeta) {
    write("INFO", scope, message, meta);
  },
  warn(scope: string, message: string, meta?: LogMeta) {
    write("WARN", scope, message, meta);
  },
  error(scope: string, message: string, err?: unknown, meta?: LogMeta) {
    write("ERROR", scope, message, meta, err);
  },
};
