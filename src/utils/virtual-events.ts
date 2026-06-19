export type EventFormat = "physical" | "virtual";

const ACCESS_LEAD_MINUTES = 2;
export const VIRTUAL_TRANSFER_LOCK_MINUTES = 30;
/** Virtual listings stay browsable until this long after the scheduled start. */
export const VIRTUAL_PUBLIC_GRACE_MS = 24 * 60 * 60 * 1000;

/** Parse common time labels into hours/minutes (24h). */
export function parseTimeLabel(timeLabel: string): { hours: number; minutes: number } | null {
  const raw = String(timeLabel ?? "").trim().toLowerCase();
  if (!raw) return null;

  const match24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) return { hours, minutes };
  }

  const match12 = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (match12) {
    let hours = Number(match12[1]) % 12;
    const minutes = match12[2] ? Number(match12[2]) : 0;
    if (match12[3].toLowerCase() === "pm") hours += 12;
    if (minutes >= 0 && minutes < 60) return { hours, minutes };
  }

  const loose = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (loose) {
    let hours = Number(loose[1]);
    const minutes = loose[2] ? Number(loose[2]) : 0;
    const meridiem = loose[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) return { hours, minutes };
  }

  return null;
}

export function parseEventStartsAt(
  eventStartsOn: string | Date | null | undefined,
  timeLabel: string,
): Date | null {
  if (!eventStartsOn) return null;
  const datePart =
    eventStartsOn instanceof Date
      ? eventStartsOn.toISOString().slice(0, 10)
      : String(eventStartsOn).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;

  const parsed = parseTimeLabel(timeLabel);
  const hours = parsed?.hours ?? 0;
  const minutes = parsed?.minutes ?? 0;

  const d = new Date(`${datePart}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function assertVirtualMeetingUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Meeting link is required for virtual events (e.g. Google Meet or Zoom URL).");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Meeting link must be a valid URL starting with https://");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Meeting link must use http:// or https://");
  }
  return trimmed;
}

export type VirtualTransferLockState = {
  locked: boolean;
  message: string;
  minutesUntilStart: number | null;
};

export function getVirtualTransferLockState(input: {
  eventFormat?: EventFormat | string | null;
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  now?: Date;
}): VirtualTransferLockState {
  if (input.eventFormat !== "virtual") {
    return { locked: false, message: "", minutesUntilStart: null };
  }

  const startsAt = parseEventStartsAt(input.eventStartsOn, input.timeLabel ?? "");
  if (!startsAt) {
    return { locked: false, message: "", minutesUntilStart: null };
  }

  const now = input.now ?? new Date();
  const msUntilStart = startsAt.getTime() - now.getTime();
  const minutesUntilStart = Math.max(0, Math.ceil(msUntilStart / 60_000));

  if (msUntilStart <= VIRTUAL_TRANSFER_LOCK_MINUTES * 60 * 1000) {
    return {
      locked: true,
      minutesUntilStart,
      message:
        msUntilStart > 0
          ? `Share and resale are disabled within ${VIRTUAL_TRANSFER_LOCK_MINUTES} minutes of the virtual event start.`
          : "Share and resale are disabled once a virtual event has started.",
    };
  }

  return { locked: false, message: "", minutesUntilStart };
}

export function assertVirtualTicketTransferAllowed(input: {
  eventFormat?: EventFormat | string | null;
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  now?: Date;
}): void {
  const lock = getVirtualTransferLockState(input);
  if (lock.locked) {
    throw new Error(lock.message);
  }
}

export function isVirtualEventPurchasable(input: {
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  now?: Date;
}): boolean {
  const startsAt = parseEventStartsAt(input.eventStartsOn, input.timeLabel ?? "");
  if (!startsAt) return false;
  const now = input.now ?? new Date();
  return now < startsAt;
}

export function isVirtualEventPubliclyVisible(input: {
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  now?: Date;
}): boolean {
  const startsAt = parseEventStartsAt(input.eventStartsOn, input.timeLabel ?? "");
  if (!startsAt) return true;
  const now = input.now ?? new Date();
  const publicUntil = new Date(startsAt.getTime() + VIRTUAL_PUBLIC_GRACE_MS);
  return now < publicUntil;
}

export function assertVirtualEventPurchasable(input: {
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  now?: Date;
}): void {
  if (!isVirtualEventPurchasable(input)) {
    throw new Error(
      "This virtual event has already started and is no longer available for purchase.",
    );
  }
}

export type VirtualAccessState = {
  isVirtual: boolean;
  startsAt: string | null;
  accessOpensAt: string | null;
  accessClosesAt: string | null;
  canAccessLink: boolean;
  message: string;
};

export function getVirtualAccessState(input: {
  eventFormat?: EventFormat | string | null;
  eventStartsOn?: string | Date | null;
  timeLabel?: string;
  virtualDurationMinutes?: number | null;
  ticketStatus?: string;
  now?: Date;
}): VirtualAccessState {
  const isVirtual = input.eventFormat === "virtual";
  if (!isVirtual) {
    return {
      isVirtual: false,
      startsAt: null,
      accessOpensAt: null,
      accessClosesAt: null,
      canAccessLink: false,
      message: "",
    };
  }

  const now = input.now ?? new Date();
  const startsAt = parseEventStartsAt(input.eventStartsOn, input.timeLabel ?? "");
  const duration = Math.max(15, Number(input.virtualDurationMinutes ?? 120) || 120);

  if (!startsAt) {
    return {
      isVirtual: true,
      startsAt: null,
      accessOpensAt: null,
      accessClosesAt: null,
      canAccessLink: false,
      message: "Event schedule is not set yet.",
    };
  }

  const accessOpensAt = new Date(startsAt.getTime() - ACCESS_LEAD_MINUTES * 60 * 1000);
  const accessClosesAt = new Date(startsAt.getTime() + duration * 60 * 1000);

  if (input.ticketStatus === "used") {
    return {
      isVirtual: true,
      startsAt: startsAt.toISOString(),
      accessOpensAt: accessOpensAt.toISOString(),
      accessClosesAt: accessClosesAt.toISOString(),
      canAccessLink: false,
      message: "This virtual event has ended. Your ticket is marked as used.",
    };
  }

  if (input.ticketStatus === "expired") {
    return {
      isVirtual: true,
      startsAt: startsAt.toISOString(),
      accessOpensAt: accessOpensAt.toISOString(),
      accessClosesAt: accessClosesAt.toISOString(),
      canAccessLink: false,
      message: "This ticket has expired.",
    };
  }

  if (now < accessOpensAt) {
    return {
      isVirtual: true,
      startsAt: startsAt.toISOString(),
      accessOpensAt: accessOpensAt.toISOString(),
      accessClosesAt: accessClosesAt.toISOString(),
      canAccessLink: false,
      message: `Join link opens ${ACCESS_LEAD_MINUTES} minutes before the event starts.`,
    };
  }

  if (now > accessClosesAt) {
    return {
      isVirtual: true,
      startsAt: startsAt.toISOString(),
      accessOpensAt: accessOpensAt.toISOString(),
      accessClosesAt: accessClosesAt.toISOString(),
      canAccessLink: false,
      message: "This virtual event has ended.",
    };
  }

  return {
    isVirtual: true,
    startsAt: startsAt.toISOString(),
    accessOpensAt: accessOpensAt.toISOString(),
    accessClosesAt: accessClosesAt.toISOString(),
    canAccessLink: true,
    message: "Your join link is ready.",
  };
}
